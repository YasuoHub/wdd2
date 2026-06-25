const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const DEFAULT_DAILY_LIMIT = 3
const MAX_PAGE_SIZE = 30

function trimText(value) {
  return String(value || '').trim()
}

function normalizeImages(value) {
  if (!Array.isArray(value)) return []
  return value.map(item => trimText(item)).filter(Boolean)
}

function normalizeDeviceInfo(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return {
    platform: trimText(value.platform).slice(0, 30),
    system: trimText(value.system).slice(0, 80),
    model: trimText(value.model).slice(0, 80),
    brand: trimText(value.brand).slice(0, 50),
    version: trimText(value.version).slice(0, 30),
    SDKVersion: trimText(value.SDKVersion).slice(0, 30)
  }
}

function getBeijingDateKey(date = new Date()) {
  const bj = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const year = bj.getUTCFullYear()
  const month = String(bj.getUTCMonth() + 1).padStart(2, '0')
  const day = String(bj.getUTCDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

async function loadConfig() {
  const res = await db.collection('wdd-config').doc('platform').get().catch(() => null)
  return res && res.data ? res.data : {}
}

function getDailyLimit(config) {
  const value = Number(config.feedback_daily_limit)
  return Number.isInteger(value) && value > 0 ? Math.min(value, 20) : DEFAULT_DAILY_LIMIT
}

async function getCurrentUser(openid) {
  const res = await db.collection('wdd-users').where({ openid }).limit(1).get()
  const user = res.data[0] || null
  return user && user.is_deleted !== true ? user : null
}

async function isCustomerService(openid, loadedConfig) {
  const config = loadedConfig || await loadConfig()
  const openids = Array.isArray(config.customer_service_openids) ? config.customer_service_openids : []
  return openids.includes(openid)
}

function toSafeSubmitter(user) {
  if (!user) return { nickname: '已注销用户', avatar: '' }
  return {
    nickname: user.nickname || '用户',
    avatar: user.avatar || ''
  }
}

function toSafeFeedback(feedback, options = {}) {
  const result = {
    _id: feedback._id,
    title: feedback.title || '',
    content: feedback.content || '',
    images: Array.isArray(feedback.images) ? feedback.images : [],
    status: feedback.status === 'resolved' ? 'resolved' : 'pending',
    createTime: feedback.create_time || null,
    resolveTime: feedback.resolve_time || null,
    deviceInfo: feedback.device_info || {}
  }
  if (options.submitter) result.submitter = options.submitter
  if (options.handler) result.handler = options.handler
  return result
}

exports.main = async (event) => {
  const { action } = event || {}
  const { OPENID } = cloud.getWXContext()

  if (!OPENID) return { code: -1, message: '获取用户身份失败' }

  try {
    switch (action) {
      case 'getSubmitMeta':
        return await getSubmitMeta(OPENID)
      case 'submitFeedback':
        return await submitFeedback(event, OPENID)
      case 'getMyFeedbackList':
        return await getMyFeedbackList(event, OPENID)
      case 'getFeedbackDetail':
        return await getFeedbackDetail(event, OPENID)
      case 'getAdminFeedbackList':
        return await getAdminFeedbackList(event, OPENID)
      case 'resolveFeedback':
        return await resolveFeedback(event, OPENID)
      default:
        return { code: -1, message: '未知操作' }
    }
  } catch (err) {
    console.error('意见反馈操作失败:', err)
    return { code: -1, message: err.message || '操作失败' }
  }
}

async function getSubmitMeta(openid) {
  const [user, config] = await Promise.all([getCurrentUser(openid), loadConfig()])
  if (!user) return { code: 401, message: '请先登录' }

  const dailyLimit = getDailyLimit(config)
  const quotaId = `${user._id}_${getBeijingDateKey()}`
  const quotaRes = await db.collection('wdd-feedback-daily-quotas').doc(quotaId).get().catch(() => null)
  const used = quotaRes && quotaRes.data ? Number(quotaRes.data.count) || 0 : 0

  return {
    code: 0,
    data: {
      dailyLimit,
      used,
      remaining: Math.max(0, dailyLimit - used)
    }
  }
}

async function submitFeedback(event, openid) {
  const title = trimText(event.title)
  const content = trimText(event.content)
  const images = normalizeImages(event.images)
  const deviceInfo = normalizeDeviceInfo(event.deviceInfo)

  if (title.length < 2 || title.length > 40) {
    return { code: -1, message: '标题需在2～40字之间' }
  }
  if (content.length < 5 || content.length > 500) {
    return { code: -1, message: '内容需在5～500字之间' }
  }
  if (images.length > 3) {
    return { code: -1, message: '最多上传3张图片' }
  }
  if (images.some(item => !item.startsWith('cloud://') || item.length > 500)) {
    return { code: -1, message: '图片地址格式不正确' }
  }

  const [user, config] = await Promise.all([getCurrentUser(openid), loadConfig()])
  if (!user) return { code: 401, message: '请先登录' }

  const dailyLimit = getDailyLimit(config)
  const dateKey = getBeijingDateKey()
  const quotaId = `${user._id}_${dateKey}`
  await db.collection('wdd-feedback-daily-quotas').add({
    data: {
      _id: quotaId,
      user_id: user._id,
      date_key: dateKey,
      count: 0,
      create_time: new Date(),
      update_time: new Date()
    }
  }).catch(err => {
    const message = String(err && (err.errMsg || err.message) || '')
    if (!message.includes('duplicate') && !message.includes('already exists') && !message.includes('-502001')) {
      throw err
    }
  })
  const transaction = await db.startTransaction()

  try {
    const quotaRes = await transaction.collection('wdd-feedback-daily-quotas').doc(quotaId).get()
    const used = Number(quotaRes.data.count) || 0
    if (used >= dailyLimit) {
      await transaction.rollback()
      return { code: 429, message: `今日最多提交${dailyLimit}条反馈，请明天再试` }
    }

    const now = new Date()
    const feedbackRes = await transaction.collection('wdd-feedbacks').add({
      data: {
        user_id: user._id,
        title,
        content,
        images,
        device_info: deviceInfo,
        status: 'pending',
        handler_id: null,
        resolve_time: null,
        create_time: now,
        update_time: now
      }
    })

    await transaction.collection('wdd-feedback-daily-quotas').doc(quotaId).update({
      data: {
        count: used + 1,
        update_time: now
      }
    })

    await transaction.collection('wdd-notifications').add({
      data: {
        user_id: user._id,
        type: 'feedback_received',
        title: '意见反馈',
        content: `我们已收到您的反馈“${title}”，感谢您帮助我们改进问当地。`,
        feedback_id: feedbackRes._id,
        is_read: false,
        create_time: now
      }
    })

    await transaction.commit()
    return {
      code: 0,
      message: '提交成功',
      data: {
        feedbackId: feedbackRes._id,
        dailyLimit,
        remaining: Math.max(0, dailyLimit - used - 1)
      }
    }
  } catch (err) {
    await transaction.rollback().catch(() => {})
    throw err
  }
}

async function getMyFeedbackList(event, openid) {
  const user = await getCurrentUser(openid)
  if (!user) return { code: 401, message: '请先登录' }

  const skip = Math.max(0, Number(event.skip) || 0)
  const limit = Math.min(Math.max(Number(event.limit) || 20, 1), MAX_PAGE_SIZE)
  const res = await db.collection('wdd-feedbacks')
    .where({ user_id: user._id })
    .orderBy('create_time', 'desc')
    .skip(skip)
    .limit(limit + 1)
    .get()
  const hasMore = res.data.length > limit
  const list = (hasMore ? res.data.slice(0, limit) : res.data).map(item => toSafeFeedback(item))

  return { code: 0, data: { list, hasMore } }
}

async function getFeedbackDetail(event, openid) {
  const feedbackId = trimText(event.feedbackId)
  if (!feedbackId) return { code: -1, message: '反馈ID不能为空' }

  const [user, config, feedbackRes] = await Promise.all([
    getCurrentUser(openid),
    loadConfig(),
    db.collection('wdd-feedbacks').doc(feedbackId).get().catch(() => null)
  ])
  if (!user) return { code: 401, message: '请先登录' }
  if (!feedbackRes || !feedbackRes.data) return { code: 404, message: '反馈不存在' }

  const feedback = feedbackRes.data
  const isCs = await isCustomerService(openid, config)
  if (feedback.user_id !== user._id && !isCs) {
    return { code: 403, message: '无权查看该反馈' }
  }

  let submitter = null
  let handler = null
  if (isCs) {
    const submitterRes = await db.collection('wdd-users').doc(feedback.user_id).get().catch(() => null)
    submitter = toSafeSubmitter(submitterRes && submitterRes.data)
  }
  if (isCs && feedback.handler_id) {
    const handlerRes = await db.collection('wdd-users').doc(feedback.handler_id).get().catch(() => null)
    handler = toSafeSubmitter(handlerRes && handlerRes.data)
  }

  return {
    code: 0,
    data: {
      feedback: toSafeFeedback(feedback, { submitter, handler }),
      canResolve: isCs && feedback.status === 'pending'
    }
  }
}

async function getAdminFeedbackList(event, openid) {
  const config = await loadConfig()
  if (!await isCustomerService(openid, config)) return { code: 403, message: '无权访问' }

  const status = event.status === 'resolved' ? 'resolved' : 'pending'
  const skip = Math.max(0, Number(event.skip) || 0)
  const limit = Math.min(Math.max(Number(event.limit) || 20, 1), MAX_PAGE_SIZE)
  const res = await db.collection('wdd-feedbacks')
    .where({ status })
    .orderBy(status === 'pending' ? 'create_time' : 'resolve_time', 'desc')
    .skip(skip)
    .limit(limit + 1)
    .get()
  const hasMore = res.data.length > limit
  const rawList = hasMore ? res.data.slice(0, limit) : res.data

  const list = await Promise.all(rawList.map(async item => {
    const userRes = await db.collection('wdd-users').doc(item.user_id).get().catch(() => null)
    return {
      ...toSafeFeedback(item),
      submitter: toSafeSubmitter(userRes && userRes.data),
      imageCount: Array.isArray(item.images) ? item.images.length : 0
    }
  }))

  return { code: 0, data: { list, hasMore } }
}

async function resolveFeedback(event, openid) {
  const feedbackId = trimText(event.feedbackId)
  if (!feedbackId) return { code: -1, message: '反馈ID不能为空' }

  const [config, handler] = await Promise.all([loadConfig(), getCurrentUser(openid)])
  if (!await isCustomerService(openid, config)) return { code: 403, message: '无权操作' }
  if (!handler) return { code: 401, message: '客服账号不存在' }

  const transaction = await db.startTransaction()
  try {
    const feedbackRes = await transaction.collection('wdd-feedbacks').doc(feedbackId).get()
    const feedback = feedbackRes && feedbackRes.data
    if (!feedback) {
      await transaction.rollback()
      return { code: 404, message: '反馈不存在' }
    }
    if (feedback.status !== 'pending') {
      await transaction.rollback()
      return { code: 409, message: '该反馈已由其他客服处理' }
    }

    const now = new Date()
    await transaction.collection('wdd-feedbacks').doc(feedbackId).update({
      data: {
        status: 'resolved',
        handler_id: handler._id,
        resolve_time: now,
        update_time: now
      }
    })
    await transaction.commit()
    return { code: 0, message: '已标记为已处理' }
  } catch (err) {
    await transaction.rollback().catch(() => {})
    const latestRes = await db.collection('wdd-feedbacks').doc(feedbackId).get().catch(() => null)
    if (latestRes && latestRes.data && latestRes.data.status === 'resolved') {
      return { code: 409, message: '该反馈已由其他客服处理' }
    }
    throw err
  }
}
