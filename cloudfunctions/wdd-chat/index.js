// 云函数入口文件
const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command
const MEDIA_CHECK_CALLBACK_COLLECTION = 'wdd-media-check-callbacks'

// 消息类型
const MSG_TYPE = {
  TEXT: 'text',
  IMAGE: 'image',
  VOICE: 'voice'
}
const MESSAGE_RULES = {
  [MSG_TYPE.TEXT]: { maxLength: 500 },
  [MSG_TYPE.IMAGE]: { maxUrlLength: 500, mediaType: 2 },
  [MSG_TYPE.VOICE]: { maxUrlLength: 500, minDuration: 1, maxDuration: 60, mediaType: 1 }
}
const DEFAULT_MESSAGE_LIMIT = 20
const MAX_MESSAGE_LIMIT = 50
const DEFAULT_PLATFORM_FEE_RATE = 0.15

async function getPlatformFeeRate() {
  try {
    const configRes = await db.collection('wdd-config').doc('platform').get().catch(() => null)
    const config = configRes && configRes.data ? configRes.data : {}
    return typeof config.platform_fee_rate === 'number'
      ? config.platform_fee_rate
      : DEFAULT_PLATFORM_FEE_RATE
  } catch (err) {
    console.error('获取平台服务费率失败:', err)
    return DEFAULT_PLATFORM_FEE_RATE
  }
}

function calcTakerIncome(amount, feeRate = DEFAULT_PLATFORM_FEE_RATE) {
  const rewardAmount = Number(amount) || 0
  const platformFee = Math.round(rewardAmount * feeRate * 100) / 100
  return Math.round((rewardAmount - platformFee) * 100) / 100
}

function normalizeMessageLimit(limit) {
  const num = Number(limit)
  if (!Number.isInteger(num) || num <= 0) return DEFAULT_MESSAGE_LIMIT
  return Math.min(num, MAX_MESSAGE_LIMIT)
}

function normalizeMessageType(type) {
  const normalized = String(type || '').trim()
  return MESSAGE_RULES[normalized] ? normalized : ''
}

function getOpenApiErrorCode(err) {
  return err && (err.errCode || err.errcode || err.code || err.errorCode || '')
}

function getOpenApiErrorMessage(err) {
  return err && (err.errMsg || err.errmsg || err.message || JSON.stringify(err))
}

function isCollectionNotFoundError(err) {
  const text = [
    err && err.errCode,
    err && err.errcode,
    err && err.code,
    err && err.errMsg,
    err && err.message
  ].filter(Boolean).join(' ')
  return text.includes('-502005') ||
    text.includes('collection not exists') ||
    text.includes('Db or Table not exist') ||
    text.includes('DATABASE_COLLECTION_NOT_EXIST') ||
    text.includes('ResourceNotFound')
}

function maskMediaUrl(url) {
  const text = String(url || '')
  if (text.length <= 80) return text
  return `${text.slice(0, 44)}...${text.slice(-24)}`
}

async function getMediaCheckUrlCandidates(fileId) {
  const safeFileId = String(fileId || '').trim()
  if (!safeFileId.startsWith('cloud://')) return [{ url: safeFileId, kind: 'download-url' }]

  try {
    const tempRes = await cloud.getTempFileURL({ fileList: [safeFileId] })
    const fileInfo = tempRes.fileList && tempRes.fileList[0]
    const tempUrl = fileInfo && fileInfo.tempFileURL ? fileInfo.tempFileURL : ''
    const tempUrlStatus = fileInfo ? String(fileInfo.status || fileInfo.errMsg || '') : 'no-file-info'

    if (!tempUrl) {
      throw new Error(`获取媒体临时地址失败: ${tempUrlStatus || '无返回结果'}`)
    }

    console.log('媒体审核地址:', {
      cloudFileId: maskMediaUrl(safeFileId),
      tempUrlStatus,
      tempUrl: maskMediaUrl(tempUrl)
    })

    return [{ url: tempUrl, kind: 'download-url' }]
  } catch (err) {
    throw new Error(`获取媒体临时地址失败: ${err.errMsg || err.message || String(err)}`)
  }
}

async function submitMediaCheck({ messageType, mediaUrl, openid }) {
  const mediaType = MESSAGE_RULES[messageType].mediaType
  const candidates = await getMediaCheckUrlCandidates(mediaUrl)
  let lastError = null

  for (const candidate of candidates) {
    const candidateUrl = candidate.url
    try {
      console.log('提交媒体安全检测:', {
        messageType,
        mediaType,
        urlKind: candidate.kind,
        mediaUrl: maskMediaUrl(candidateUrl)
      })

      const checkRes = await cloud.openapi.security.mediaCheckAsync({
        media_type: mediaType,
        media_url: candidateUrl,
        version: 2,
        openid,
        scene: 2
      })
      console.log('mediaCheckAsync 原始返回:', checkRes)

      const errCode = getOpenApiErrorCode(checkRes)
      if (errCode && Number(errCode) !== 0) {
        throw new Error(`mediaCheckAsync 返回错误 ${errCode}: ${getOpenApiErrorMessage(checkRes)}`)
      }

      const traceId = checkRes.trace_id || checkRes.traceId || ''
      if (!checkRes.trace_id && checkRes.traceId) {
        console.warn('mediaCheckAsync 返回 traceId 字段，未返回 trace_id:', {
          traceId: checkRes.traceId
        })
      }
      if (!traceId) {
        throw new Error(`mediaCheckAsync 未返回审核任务编号: ${JSON.stringify(checkRes)}`)
      }
      console.log('媒体安全检测提交成功:', {
        messageType,
        mediaType,
        urlKind: candidate.kind,
        traceId
      })
      return {
        traceId,
        mediaUrlKind: candidate.kind,
        submittedMediaUrl: maskMediaUrl(candidateUrl)
      }
    } catch (err) {
      lastError = err
      console.error('媒体安全检测提交失败:', {
        messageType,
        mediaType,
        urlKind: candidate.kind,
        mediaUrl: maskMediaUrl(candidateUrl),
        errCode: getOpenApiErrorCode(err),
        errMsg: getOpenApiErrorMessage(err)
      })
    }
  }

  throw lastError || new Error('媒体安全检测提交失败')
}

async function applyStoredMediaCheckCallback(traceId, messageId) {
  if (!traceId || !messageId) return null

  let callbackRes
  try {
    callbackRes = await db.collection(MEDIA_CHECK_CALLBACK_COLLECTION).where({
      trace_id: traceId,
      processed: false
    }).limit(1).get()
  } catch (err) {
    if (!isCollectionNotFoundError(err)) throw err
    console.warn('媒体审核回调暂存集合不存在，跳过回调补偿:', traceId)
    return null
  }
  if (callbackRes.data.length === 0) return null

  const callbackDoc = callbackRes.data[0]
  const messageRes = await db.collection('wdd-messages').doc(messageId).get().catch(() => null)
  if (!messageRes || !messageRes.data || messageRes.data.status !== 'pending') return null

  const message = messageRes.data
  const suggest = callbackDoc.suggest
  if (!['pass', 'review', 'risky', 'error'].includes(suggest)) {
    throw new Error(`暂存媒体审核回调 suggest 非法：${suggest || ''}`)
  }
  const now = new Date()
  const nextStatus = suggest === 'pass' ? 'normal' : 'violated'
  const updateData = nextStatus === 'normal'
    ? {
        status: 'normal',
        is_read: false,
        approved_at: now,
        create_time: now
      }
    : {
        status: 'violated',
        is_read: true,
        violated_at: now,
        audit_error: callbackDoc.audit_error || null,
        create_time: now
      }

  await db.collection('wdd-messages').doc(messageId).update({ data: updateData })

  if (nextStatus === 'normal') {
    const takerRes = await db.collection('wdd-need-takers').where({
      need_id: message.need_id
    }).orderBy('create_time', 'desc').limit(1).get()
    if (takerRes.data.length > 0) {
      await db.collection('wdd-need-takers').doc(takerRes.data[0]._id).update({
        data: { last_message_time: now }
      })
    }
  } else {
    await db.collection('wdd-notifications').add({
      data: {
        user_id: message.sender_id,
        type: 'system',
        title: '内容未通过审核',
        content: callbackDoc.audit_error
          ? `您发送的媒体消息审核失败：${callbackDoc.audit_error.errmsg || callbackDoc.audit_error.errcode}，可在聊天中点击红色感叹号重新提交。`
          : '您发送的媒体消息未通过安全审核，可在聊天中点击红色感叹号重新提交。',
        is_read: false,
        create_time: now
      }
    })
  }

  await db.collection(MEDIA_CHECK_CALLBACK_COLLECTION).doc(callbackDoc._id).update({
    data: {
      processed: true,
      message_id: messageId,
      processed_at: now
    }
  })

  return {
    status: nextStatus,
    createTime: now
  }
}

// 计算图片显示尺寸
function calculateDisplaySize(width, height) {
  const maxWidth = 400  // rpx
  const maxHeight = 500 // rpx

  // 如果没有尺寸信息，返回默认值
  if (!width || !height || width <= 0 || height <= 0) {
    return { width: maxWidth, height: maxHeight }
  }

  // 计算缩放比例
  const scale = Math.min(maxWidth / width, maxHeight / height, 1)

  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale)
  }
}

function normalizeTrustedWatermarkInfo(info) {
  if (!info || typeof info !== 'object') {
    return null
  }

  const latitude = Number(info.latitude)
  const longitude = Number(info.longitude)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null
  }

  return {
    capturedAt: String(info.capturedAt || ''),
    locationName: String(info.locationName || '').slice(0, 80),
    latitude,
    longitude,
    needShortId: String(info.needShortId || '').slice(0, 20),
    nonce: String(info.nonce || '').slice(0, 32),
    hiddenCode: String(info.hiddenCode || '').slice(0, 300)
  }
}

function createTrustedPhotoProof({ needId, senderId, imageUrl, watermarkInfo }) {
  const raw = [
    needId,
    senderId,
    imageUrl,
    watermarkInfo.capturedAt,
    watermarkInfo.latitude,
    watermarkInfo.longitude,
    watermarkInfo.nonce
  ].join('|')

  return crypto.createHash('sha256').update(raw).digest('hex')
}

// 从 wdd-config 获取客服白名单
async function getCustomerServiceOpenids() {
  try {
    const configRes = await db.collection('wdd-config').doc('platform').get()
    return configRes.data.customer_service_openids || []
  } catch (e) {
    return []
  }
}

// 判断是否为客服
async function isCustomerService(OPENID) {
  const csOpenids = await getCustomerServiceOpenids()
  return csOpenids.includes(OPENID)
}


// 主入口
exports.main = async (event, context) => {
  const { action } = event
  const wxContext = cloud.getWXContext()
  const OPENID = wxContext.OPENID

  try {
    switch (action) {
      case 'getTaskInfo':
        return await getTaskInfo(event, OPENID)
      case 'getMessages':
        return await getMessages(event, OPENID)
      case 'sendMessage':
        return await sendMessage(event, OPENID)
      case 'retryMediaMessage':
        return await retryMediaMessage(event, OPENID)
      case 'getMediaStatuses':
        return await getMediaStatuses(event, OPENID)
      default:
        return { code: -1, message: '未知操作' }
    }
  } catch (err) {
    console.error('操作失败:', err)
    return { code: -1, message: err.message }
  }
}

// 获取任务信息
async function getTaskInfo(event, OPENID) {
  const { needId } = event

  // 第一批并行：当前用户 + 任务详情 + 接单记录 + 客服身份判断
  // 这四项互不依赖，可同时发起
  const [userRes, needRes, takerRes, isCs, platformFeeRate] = await Promise.all([
    db.collection('wdd-users').where({ openid: OPENID }).get(),
    db.collection('wdd-needs').doc(needId).get().catch(() => null),
    db.collection('wdd-need-takers').where({ need_id: needId }).get(),
    isCustomerService(OPENID),
    getPlatformFeeRate()
  ])

  if (userRes.data.length === 0 || userRes.data[0].is_deleted === true) {
    return { code: -1, message: '用户不存在' }
  }
  const currentUserId = userRes.data[0]._id

  if (!needRes || !needRes.data) {
    return { code: -1, message: '任务不存在' }
  }
  const need = needRes.data
  const taker = takerRes.data[0]
  const takerId = taker?.taker_id || need.taker_id
  const rewardAmount = Number(need.reward_amount || need.rewardAmount || 0)
  const takerIncome = calcTakerIncome(rewardAmount, platformFeeRate)

  const isSeeker = need.user_id === currentUserId
  const isTaker = takerId === currentUserId

  if (!isSeeker && !isTaker && !isCs) {
    return { code: -1, message: '无权查看此任务' }
  }

  // 客服模式：纯客服（非任务参与者）返回双方信息，不含操作权限
  if (isCs && !isSeeker && !isTaker) {
    const takerUserId = takerId || null
    const userIds = [need.user_id, takerUserId].filter(Boolean)

    // 查询双方用户信息
    const participantsRes = await Promise.all(
      userIds.map(uid => db.collection('wdd-users').doc(uid).get().catch(() => null))
    )

    const participants = {}
    participantsRes.forEach((res, i) => {
      if (res && res.data) {
        participants[userIds[i]] = {
          nickname: res.data.nickname || '',
          avatar: res.data.avatar || ''
        }
      }
    })

    return {
      code: 0,
      data: {
        ...need,
        rewardAmount,
        takerIncome,
        displayRewardAmount: rewardAmount,
        role: 'customer_service',
        otherUser: null,
        participants,
        myReportStatus: { hasReport: false },
        myAppealStatus: { hasAppeal: false }
      }
    }
  }

  // 第二批并行：对方用户 + 举报状态 + 申诉状态
  const otherUserId = isSeeker ? takerId : need.user_id

  const [otherUserRes, reportRes, appealRes] = await Promise.all([
    otherUserId
      ? db.collection('wdd-users').doc(otherUserId).get().catch(() => null)
      : Promise.resolve(null),
    db.collection('wdd-reports').where({
      need_id: needId,
      reporter_id: currentUserId
    }).orderBy('create_time', 'desc').limit(1).get().catch(() => ({ data: [] })),
    db.collection('wdd-appeals').where({
      need_id: needId,
      initiator_id: currentUserId
    }).orderBy('create_time', 'desc').limit(1).get().catch(() => ({ data: [] }))
  ])

  const otherUser = otherUserRes && otherUserRes.data ? otherUserRes.data : null
  const myReport = reportRes.data.length > 0 ? reportRes.data[0] : null
  const myAppeal = appealRes.data.length > 0 ? appealRes.data[0] : null

  const currentUser = userRes.data[0]

  // 根据角色计算双方头像和昵称
  let seekerNickname, seekerAvatar, takerNickname, takerAvatar
  if (isSeeker) {
    seekerNickname = currentUser.nickname
    seekerAvatar = currentUser.avatar
    takerNickname = otherUser?.nickname
    takerAvatar = otherUser?.avatar
  } else {
    seekerNickname = otherUser?.nickname
    seekerAvatar = otherUser?.avatar
    takerNickname = currentUser.nickname
    takerAvatar = currentUser.avatar
  }

  return {
    code: 0,
    data: {
      ...need,
      rewardAmount,
      takerIncome,
      displayRewardAmount: isSeeker ? rewardAmount : takerIncome,
      role: isSeeker ? 'seeker' : 'taker',
      otherUser: otherUser ? {
        _id: otherUser._id,
        nickname: otherUser.nickname,
        avatar: otherUser.avatar,
      } : null,
      seekerNickname,
      seekerAvatar,
      takerNickname,
      takerAvatar,
      // 当前用户的举报/申诉状态（个人级别）
      myReportStatus: myReport ? {
        hasReport: true,
        reportId: myReport._id,
        reportType: myReport.report_type,
        createTime: myReport.create_time
      } : { hasReport: false },
      myAppealStatus: myAppeal ? {
        hasAppeal: true,
        appealId: myAppeal._id,
        appealType: myAppeal.initiator_type,
        createTime: myAppeal.create_time
      } : { hasAppeal: false }
    }
  }
}

// 获取历史消息
async function getMessages(event, OPENID) {
  const { needId, limit = 20, beforeTime, afterTime } = event
  const safeLimit = normalizeMessageLimit(limit)

  // 先鉴权，再按当前用户身份拼装可见消息条件。
  const [userRes, needRes, takerRes, isCs] = await Promise.all([
    db.collection('wdd-users').where({ openid: OPENID }).get(),
    db.collection('wdd-needs').doc(needId).get().catch(() => null),
    db.collection('wdd-need-takers').where({ need_id: needId }).orderBy('create_time', 'desc').limit(1).get(),
    isCustomerService(OPENID)
  ])

  if (userRes.data.length === 0) {
    return { code: -1, message: '用户不存在' }
  }
  const currentUserId = userRes.data[0]._id

  if (!needRes || !needRes.data) {
    return { code: -1, message: '任务不存在' }
  }
  const need = needRes.data
  const taker = takerRes.data[0]

  const isSeeker = need.user_id === currentUserId
  const isTaker = taker && taker.taker_id === currentUserId

  if (!isSeeker && !isTaker && !isCs) {
    return { code: -1, message: '无权查看消息' }
  }

  const buildTimeCondition = () => {
    if (afterTime && beforeTime) {
      return _.and(_.gt(new Date(afterTime)), _.lt(new Date(beforeTime)))
    }
    if (afterTime) return _.gt(new Date(afterTime))
    if (beforeTime) return _.lt(new Date(beforeTime))
    return null
  }

  const createTimeCondition = buildTimeCondition()
  const withTime = condition => {
    const next = { ...condition }
    if (createTimeCondition) next.create_time = createTimeCondition
    return next
  }

  // 按“当前用户可见范围”查询，避免不可见的待审核媒体占用分页 limit。
  let queryTasks
  if (isCs) {
    queryTasks = [
      db.collection('wdd-messages')
        .where(withTime({ need_id: String(needId) }))
        .orderBy('create_time', 'desc')
        .limit(safeLimit)
        .get()
    ]
  } else {
    queryTasks = [
      db.collection('wdd-messages')
        .where(withTime({ need_id: String(needId), status: 'normal' }))
        .orderBy('create_time', 'desc')
        .limit(safeLimit)
        .get(),
      db.collection('wdd-messages')
        .where(withTime({ need_id: String(needId), type: 'system' }))
        .orderBy('create_time', 'desc')
        .limit(safeLimit)
        .get()
    ]
    queryTasks.push(
      db.collection('wdd-messages')
        .where(withTime({
          need_id: String(needId),
          sender_id: currentUserId,
          type: _.in([MSG_TYPE.IMAGE, MSG_TYPE.VOICE]),
          status: _.in(['pending', 'violated'])
        }))
        .orderBy('create_time', 'desc')
        .limit(safeLimit)
        .get()
    )
  }

  const msgResults = await Promise.all(queryTasks)
  const messageMap = new Map()
  msgResults.forEach(res => {
    ;(res.data || []).forEach(message => {
      messageMap.set(message._id, message)
    })
  })

  // 反转顺序（按时间正序排列）
  const messages = Array.from(messageMap.values())
    .sort((a, b) => new Date(b.create_time) - new Date(a.create_time))
    .slice(0, safeLimit)
    .reverse()

  // 标记已读 fire-and-forget：不 await，主流程立即返回。
  // 标记失败不影响用户阅读消息。
  if (!isCs) {
    markMessagesAsRead(needId, currentUserId).catch(err => {
      console.error('异步标记已读失败:', err)
    })
  }

  return {
    code: 0,
    data: {
      list: messages,
      total: messages.length
    }
  }
}

// 发送消息
async function sendMessage(event, OPENID) {
  const {
    needId,
    type,
    content,
    imageUrl,
    imageWidth: clientWidth,
    imageHeight: clientHeight,
    imageSource = 'album',
    isTrustedPhoto = false,
    watermarkInfo,
    voiceUrl,
    voiceDuration,
    clientMsgId
  } = event

  const safeType = normalizeMessageType(type)
  const textContent = String(content || '').trim()
  const safeImageUrl = String(imageUrl || '').trim()
  const safeVoiceUrl = String(voiceUrl || '').trim()
  const safeVoiceDuration = Math.ceil(Number(voiceDuration) || 0)

  // 验证参数
  if (!needId || !safeType) {
    return { code: -1, message: '参数错误' }
  }

  if (safeType === MSG_TYPE.TEXT && !textContent) {
    return { code: -1, message: '消息内容不能为空' }
  }

  if (safeType === MSG_TYPE.TEXT && textContent.length > MESSAGE_RULES[MSG_TYPE.TEXT].maxLength) {
    return { code: -1, message: `消息最多${MESSAGE_RULES[MSG_TYPE.TEXT].maxLength}个字` }
  }

  if (safeType === MSG_TYPE.IMAGE && !safeImageUrl) {
    return { code: -1, message: '图片不能为空' }
  }

  if (safeType === MSG_TYPE.IMAGE && (!safeImageUrl.startsWith('cloud://') || safeImageUrl.length > MESSAGE_RULES[MSG_TYPE.IMAGE].maxUrlLength)) {
    return { code: -1, message: '图片来源不合法' }
  }

  if (safeType === MSG_TYPE.VOICE && (!safeVoiceUrl.startsWith('cloud://') || safeVoiceUrl.length > MESSAGE_RULES[MSG_TYPE.VOICE].maxUrlLength)) {
    return { code: -1, message: '语音来源不合法' }
  }

  if (safeType === MSG_TYPE.VOICE && (safeVoiceDuration < MESSAGE_RULES[MSG_TYPE.VOICE].minDuration || safeVoiceDuration > MESSAGE_RULES[MSG_TYPE.VOICE].maxDuration)) {
    return { code: -1, message: '语音时长必须为1到60秒' }
  }

  // 获取当前用户
  const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
  if (userRes.data.length === 0) {
    return { code: -1, message: '用户不存在' }
  }
  const currentUserId = userRes.data[0]._id

  // 验证任务状态和权限
  const needRes = await db.collection('wdd-needs').doc(needId).get().catch(() => null)
  if (!needRes || !needRes.data) {
    return { code: -1, message: '任务不存在' }
  }

  const need = needRes.data

  // 检查任务状态
  if (need.status === 'breaking') {
    return { code: -1, message: '任务已进入客服审核，无法发送消息' }
  }
  if (need.status !== 'ongoing') {
    return { code: -1, message: '任务已结束，无法发送消息' }
  }

  // 获取接单记录
  const takerRes = await db.collection('wdd-need-takers').where({ need_id: needId }).orderBy('create_time', 'desc').limit(1).get()
  const taker = takerRes.data[0]

  const isSeeker = need.user_id === currentUserId
  const isTaker = taker && taker.taker_id === currentUserId

  if (!isSeeker && !isTaker) {
    return { code: -1, message: '无权发送消息' }
  }

  // 确定接收者
  const receiverId = isSeeker ? taker.taker_id : need.user_id

  // 文字消息内容安全检测（v2）
  if (safeType === MSG_TYPE.TEXT) {
    try {
      const checkRes = await cloud.openapi.security.msgSecCheck({
        content: textContent,
        version: 2,
        scene: 2,
        openid: OPENID,
        title: '问当地聊天'
      })
      if (checkRes.errCode !== 0) {
        return { code: -1, message: '消息包含敏感内容，无法发送' }
      }
    } catch (err) {
      console.error('内容安全检测失败:', err)
      return { code: -1, message: '内容审核失败，请稍后重试' }
    }
  }

  // 图片消息：获取并计算显示尺寸
  let imageDisplayWidth = 0
  let imageDisplayHeight = 0
  let checkTraceId = ''
  let checkMediaUrlKind = ''
  let checkSubmittedMediaUrl = ''

  if (safeType === MSG_TYPE.IMAGE && safeImageUrl) {
    // 优先使用前端传来的图片尺寸
    const originalWidth = clientWidth || 0
    const originalHeight = clientHeight || 0

    // 计算显示尺寸
    const displaySize = calculateDisplaySize(originalWidth, originalHeight)
    imageDisplayWidth = displaySize.width
    imageDisplayHeight = displaySize.height

  }

  // 图片和语音都必须先成功提交异步审核，审核通过后才向接收者送达。
  if (safeType === MSG_TYPE.IMAGE || safeType === MSG_TYPE.VOICE) {
    const mediaUrl = safeType === MSG_TYPE.IMAGE ? safeImageUrl : safeVoiceUrl
    try {
      const checkSubmitResult = await submitMediaCheck({
        messageType: safeType,
        mediaUrl,
        openid: OPENID
      })
      checkTraceId = checkSubmitResult.traceId
      checkMediaUrlKind = checkSubmitResult.mediaUrlKind
      checkSubmittedMediaUrl = checkSubmitResult.submittedMediaUrl
    } catch (err) {
      const errCode = getOpenApiErrorCode(err)
      const errMsg = getOpenApiErrorMessage(err)
      console.error(`${safeType === MSG_TYPE.IMAGE ? '图片' : '语音'}安全检测最终提交失败:`, { errCode, errMsg })
      return {
        code: -1,
        message: errCode
          ? `内容审核提交失败（${errCode}），请查看云函数日志`
          : '内容审核提交失败，请查看云函数日志'
      }
    }
  }

  const normalizedImageSource = imageSource === 'camera' ? 'camera' : 'album'
  const trustedWatermarkInfo = safeType === MSG_TYPE.IMAGE && normalizedImageSource === 'camera' && isTrustedPhoto
    ? normalizeTrustedWatermarkInfo(watermarkInfo)
    : null
  const trustedPhotoProof = trustedWatermarkInfo
    ? createTrustedPhotoProof({
      needId: String(needId),
      senderId: currentUserId,
      imageUrl: safeImageUrl,
      watermarkInfo: trustedWatermarkInfo
    })
    : ''

  // 创建消息记录
  // 确保 need_id 是字符串类型，与前端监听查询保持一致
  const message = {
    need_id: String(needId),
    client_msg_id: clientMsgId || '',
    sender_id: currentUserId,
    receiver_id: receiverId,
    type: safeType,
    content: safeType === MSG_TYPE.TEXT ? textContent : '',
    image_url: safeType === MSG_TYPE.IMAGE ? safeImageUrl : '',
    voice_url: safeType === MSG_TYPE.VOICE ? safeVoiceUrl : '',
    voice_duration: safeType === MSG_TYPE.VOICE ? safeVoiceDuration : 0,
    // 图片显示尺寸（后端预计算）
    image_width: imageDisplayWidth,
    image_height: imageDisplayHeight,
    image_source: safeType === MSG_TYPE.IMAGE ? normalizedImageSource : '',
    is_trusted_photo: !!trustedWatermarkInfo,
    watermark_info: trustedWatermarkInfo,
    trusted_photo_proof: trustedPhotoProof,
    // 媒体内容安全审核 trace_id，用于回调关联
    check_trace_id: checkTraceId,
    check_media_url_kind: checkMediaUrlKind,
    check_submitted_media_url: checkSubmittedMediaUrl,
    status: safeType === MSG_TYPE.TEXT ? 'normal' : 'pending',
    // 待审核媒体尚未送达接收者；通过回调再改为未读。
    is_read: safeType === MSG_TYPE.TEXT ? false : true,
    create_time: new Date()
  }

  const msgRes = await db.collection('wdd-messages').add({
    data: message
  })

  const storedCheckResult = safeType === MSG_TYPE.TEXT
    ? null
    : await applyStoredMediaCheckCallback(checkTraceId, msgRes._id)

  // 文字立即送达；图片和语音审核通过后再由回调更新时间。
  if (safeType === MSG_TYPE.TEXT) {
    await db.collection('wdd-need-takers').doc(taker._id).update({
      data: {
        last_message_time: new Date()
      }
    })
  }

  // 注意：不再发送系统通知，避免通知过多
  // 用户通过消息页面的实时监听获取新消息

  return {
    code: 0,
    data: {
      messageId: msgRes._id,
      createTime: storedCheckResult?.createTime || message.create_time,
      status: storedCheckResult?.status || message.status
    }
  }
}

// 审核失败的媒体由原发送者重新提交，复用原消息和云文件。
async function retryMediaMessage(event, OPENID) {
  const messageId = String(event.messageId || '')
  if (!messageId) return { code: -1, message: '消息ID不能为空' }

  const [userRes, messageRes] = await Promise.all([
    db.collection('wdd-users').where({ openid: OPENID }).get(),
    db.collection('wdd-messages').doc(messageId).get().catch(() => null)
  ])
  if (userRes.data.length === 0) return { code: -1, message: '用户不存在' }
  if (!messageRes || !messageRes.data) return { code: -1, message: '消息不存在' }

  const message = messageRes.data
  const userId = userRes.data[0]._id
  if (message.sender_id !== userId) return { code: -1, message: '无权重发此消息' }
  if (![MSG_TYPE.IMAGE, MSG_TYPE.VOICE].includes(message.type) || message.status !== 'violated') {
    return { code: -1, message: '当前消息不可重发' }
  }

  const mediaUrl = message.type === MSG_TYPE.IMAGE ? message.image_url : message.voice_url
  try {
    const checkSubmitResult = await submitMediaCheck({
      messageType: message.type,
      mediaUrl,
      openid: OPENID
    })
    const traceId = checkSubmitResult.traceId

    await db.collection('wdd-messages').doc(messageId).update({
      data: {
        status: 'pending',
        is_read: true,
        check_trace_id: traceId,
        check_media_url_kind: checkSubmitResult.mediaUrlKind,
        check_submitted_media_url: checkSubmitResult.submittedMediaUrl,
        retry_time: new Date(),
        violated_at: _.remove()
      }
    })
    const storedCheckResult = await applyStoredMediaCheckCallback(traceId, messageId)
    return { code: 0, data: { status: storedCheckResult?.status || 'pending' } }
  } catch (err) {
    const errCode = getOpenApiErrorCode(err)
    const errMsg = getOpenApiErrorMessage(err)
    console.error('重新提交媒体审核失败:', { errCode, errMsg })
    return {
      code: -1,
      message: errCode
        ? `重新提交审核失败（${errCode}），请查看云函数日志`
        : '重新提交审核失败，请查看云函数日志'
    }
  }
}

// 仅查询当前用户自己待审核/失败媒体的最新状态，供前端轻量轮询审核结果。
async function getMediaStatuses(event, OPENID) {
  const messageIds = Array.isArray(event.messageIds)
    ? [...new Set(event.messageIds.map(id => String(id || '')).filter(Boolean))].slice(0, 20)
    : []
  if (messageIds.length === 0) return { code: 0, data: { list: [] } }

  const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
  if (userRes.data.length === 0) return { code: -1, message: '用户不存在' }
  const userId = userRes.data[0]._id
  const result = await db.collection('wdd-messages').where({
    _id: _.in(messageIds)
  }).get()

  return {
    code: 0,
    data: {
      list: result.data
        .filter(item => item.sender_id === userId && [MSG_TYPE.IMAGE, MSG_TYPE.VOICE].includes(item.type))
        .map(item => ({
          messageId: item._id,
          status: item.status,
          createTime: item.create_time
        }))
    }
  }
}

// 标记消息为已读
// 单次批量 update，无需逐条循环。
async function markMessagesAsRead(needId, userId) {
  try {
    await db.collection('wdd-messages').where({
      need_id: needId,
      receiver_id: userId,
      is_read: false,
      status: 'normal'
    }).update({
      data: { is_read: true }
    })
  } catch (err) {
    console.error('标记已读失败:', err)
  }
}

// 发送消息通知
async function sendNotification(receiverId, senderId, need, msgType, content, imageUrl) {
  try {
    // 获取发送者信息
    const senderRes = await db.collection('wdd-users').doc(senderId).get()
    const sender = senderRes.data

    // 构建通知内容
    let messageContent = ''
    if (msgType === MSG_TYPE.TEXT) {
      messageContent = content.length > 20 ? content.substring(0, 20) + '...' : content
    } else {
      messageContent = '[图片]'
    }

    // 创建系统通知记录
    await db.collection('wdd-notifications').add({
      data: {
        user_id: receiverId,
        type: 'chat_message',
        title: `${sender?.nickname || '有人'}发来新消息`,
        content: messageContent,
        need_id: need._id,
        is_read: false,
        create_time: new Date()
      }
    })

    // 这里可以集成微信订阅消息通知
    // 需要用户授权后才能发送

  } catch (err) {
    console.error('发送通知失败:', err)
  }
}
