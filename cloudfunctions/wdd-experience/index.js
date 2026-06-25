const cloud = require('wx-server-sdk')
const axios = require('axios')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const CONFIRM_WINDOW_MS = 48 * 60 * 60 * 1000
const MAX_PAGE_SIZE = 30
const MAX_DRAFT_MESSAGES = 80
const DEFAULT_DEEPSEEK_TIMEOUT_MS = 10000
const MAX_DEEPSEEK_TIMEOUT_MS = 30000
const MAX_AI_GENERATION_ATTEMPTS = 2
const MIN_MEANINGFUL_TEXT_LENGTH = 12
const EDITABLE_STATUSES = ['draft', 'pending_confirmation']
const NEED_TYPE_NAMES = {
  weather: '实时天气',
  traffic: '道路拥堵',
  shop: '店铺营业',
  parking: '停车场空位',
  queue: '排队情况',
  other: '其他'
}

function text(value, max = 500) {
  return String(value || '').trim().slice(0, max)
}

function normalizeImages(value) {
  if (!Array.isArray(value)) return []
  return value.map(item => text(item, 500)).filter(item => item.startsWith('cloud://')).slice(0, 9)
}

function normalizeContent(value = {}) {
  return {
    title: text(value.title, 50),
    public_location: text(value.publicLocation || value.public_location, 80),
    question: text(value.question, 300),
    result: text(value.result, 1000),
    freshness: text(value.freshness, 50),
    tips: text(value.tips, 500),
    images: normalizeImages(value.images)
  }
}

function validateContent(content) {
  if (content.title.length < 2) return '标题至少填写2个字'
  if (!content.public_location) return '请填写公开地点'
  if (content.question.length < 2) return '请填写公开描述'
  if (content.result.length < 2) return '请填写任务结果'
  if (!content.freshness) return '请选择信息有效期'
  return ''
}

function toDate(value) {
  if (!value) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value.toDate === 'function') return value.toDate()
  if (typeof value.getTime === 'function') {
    const date = new Date(value.getTime())
    return Number.isNaN(date.getTime()) ? null : date
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function endOfBeijingDay(date, dayOffset = 0) {
  const base = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const utc = Date.UTC(
    base.getUTCFullYear(),
    base.getUTCMonth(),
    base.getUTCDate() + dayOffset,
    23,
    59,
    0,
    0
  )
  return new Date(utc - 8 * 60 * 60 * 1000)
}

function getFreshnessExpiresAt(freshness, reference = new Date()) {
  const source = text(freshness, 50)
  if (!source) return null
  if (source.includes('1小时')) return new Date(reference.getTime() + 60 * 60 * 1000)
  if (source.includes('今天')) return endOfBeijingDay(reference, 0)
  if (source.includes('明天')) return endOfBeijingDay(reference, 1)
  const dayMatch = source.match(/(\d+)\s*天/)
  if (dayMatch) return new Date(reference.getTime() + Number(dayMatch[1]) * 24 * 60 * 60 * 1000)
  return null
}

function getExperienceExpiresAt(item = {}) {
  const explicit = toDate(item.expires_at || item.expiresAt)
  if (explicit) return explicit
  const reference = toDate(item.published_time || item.confirmed_time || item.submit_time || item.update_time || item.create_time)
  return reference ? getFreshnessExpiresAt(item.freshness, reference) : null
}

function formatBeijingDateTime(value) {
  const date = toDate(value)
  if (!date) return ''
  const bj = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  return `${bj.getUTCFullYear()}年${bj.getUTCMonth() + 1}月${bj.getUTCDate()}日 ${String(bj.getUTCHours()).padStart(2, '0')}:${String(bj.getUTCMinutes()).padStart(2, '0')}`
}

function isCollectionNotFound(err) {
  const message = String((err && (err.errMsg || err.message)) || '')
  return /DATABASE_COLLECTION_NOT_EXIST|collection not exist|collection.*not exists|database collection not exists|Table not exist|表不存在|集合不存在/i.test(message)
}

async function getCurrentUser(openid) {
  if (!openid) return null
  const res = await db.collection('wdd-users').where({ openid }).limit(1).get()
  const user = res.data[0] || null
  return user && user.is_deleted !== true ? user : null
}

async function loadConfig() {
  const res = await db.collection('wdd-config').doc('platform').get().catch(() => null)
  return res && res.data ? res.data : {}
}

async function isCustomerService(openid, loadedConfig) {
  const config = loadedConfig || await loadConfig()
  const customerService = Array.isArray(config.customer_service_openids) ? config.customer_service_openids : []
  const superAdmins = Array.isArray(config.super_admin_openids) ? config.super_admin_openids : []
  return customerService.includes(openid) || superAdmins.includes(openid)
}

async function getTaskContext(needId) {
  const [needRes, takerRes] = await Promise.all([
    db.collection('wdd-needs').doc(needId).get().catch(() => null),
    db.collection('wdd-need-takers').where({ need_id: needId }).orderBy('create_time', 'desc').limit(1).get()
  ])
  return {
    need: needRes && needRes.data ? needRes.data : null,
    taker: takerRes.data[0] || null
  }
}

function getTaskTypeName(type) {
  return NEED_TYPE_NAMES[type] || NEED_TYPE_NAMES.other
}

function getNeedLocationPoint(need = {}) {
  const rawLocation = need.location && typeof need.location.toJSON === 'function'
    ? need.location.toJSON()
    : need.location
  const coordinates = rawLocation && Array.isArray(rawLocation.coordinates) ? rawLocation.coordinates : []
  const longitude = Number(coordinates[0])
  const latitude = Number(coordinates[1])
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return {}
  return { longitude, latitude }
}

function getTaskMeta(need = {}) {
  const type = text(need.type, 30) || 'other'
  const locationPoint = getNeedLocationPoint(need)
  return {
    type,
    typeName: getTaskTypeName(type),
    description: text(need.description, 300),
    locationName: text(need.location_name, 120),
    ...locationPoint
  }
}

function buildTaskTitle(need = {}) {
  const typeName = getTaskTypeName(need.type)
  const description = text(need.description, 28)
  return description ? `${typeName}：${description}`.slice(0, 50) : `${typeName}经验分享`
}

async function getExperienceByNeedId(needId) {
  const res = await db.collection('wdd-experiences').where({ need_id: needId }).limit(1).get()
  return res.data[0] || null
}

async function loadTaskMessages(needId) {
  const list = []
  for (let skip = 0; skip < MAX_DRAFT_MESSAGES; skip += 100) {
    const res = await db.collection('wdd-messages')
      .where({ need_id: needId })
      .orderBy('create_time', 'asc')
      .skip(skip)
      .limit(Math.min(100, MAX_DRAFT_MESSAGES - skip))
      .get()
    list.push(...res.data)
    if (res.data.length < 100) break
  }
  return list
}

function buildConversation(messages, requesterId) {
  return messages.map(item => {
    const role = item.sender_id === requesterId ? '求助者' : '帮助者'
    if (item.type === 'text') return `${role}：${text(item.content, 1000)}`
    if (item.type === 'image') return `${role}：[图片消息]`
    if (item.type === 'voice') return `${role}：[语音消息，${Number(item.voice_duration) || 0}秒]`
    return item.type === 'system' ? `系统：${text(item.content, 300)}` : ''
  }).filter(Boolean).join('\n')
}

function getFallbackDraft(need) {
  return {
    title: buildTaskTitle(need),
    public_location: text(need.location_name, 80) || '任务地点附近',
    question: text(need.description, 300),
    result: '',
    freshness: '',
    tips: '',
    images: []
  }
}

function compactText(value, max = 1000) {
  return text(value, max).replace(/\s+/g, '')
}

function isLowInformationText(value) {
  const source = compactText(value, 200)
  if (!source) return true
  if (source.length < MIN_MEANINGFUL_TEXT_LENGTH) return true
  if (/^(测试|test|ceshi|随便|无|没有|不知道|看看|试试|111+|123+|啊+|哈+|嗯+|。。。+|---+)$/i.test(source)) return true
  if (/^(.)\1{4,}$/.test(source)) return true
  if (/^(测试|test|ceshi)[\d一二三四五六七八九十号个下啊哈嗯。.，,！!？?\s-]*$/i.test(source)) return true
  return false
}

function hasMeaningfulTaskMaterial(need = {}, messages = []) {
  if (!isLowInformationText(need.description)) return true
  const meaningfulMessages = messages.filter(item => (
    item.type === 'text' &&
    !isLowInformationText(item.content)
  ))
  return meaningfulMessages.length > 0
}

function getAiGenerationStatus(generated = {}) {
  if (!generated.warning) return 'generated'
  return /API Key|信息较少|信息不足|测试数据/i.test(generated.warning) ? 'skipped' : 'fallback'
}

function getAiGenerationAttemptCount(experience = {}) {
  const value = Number(experience.ai_generation_attempt_count ?? experience.ai_generation_retry_count)
  return Number.isFinite(value) && value > 0 ? value : 0
}

function shouldRegenerateDraft(experience = {}) {
  if (!experience || experience.status !== 'draft') return false
  if (text(experience.result, 20)) return false
  if (!experience.ai_generation_status) return true
  if (experience.ai_generation_status !== 'fallback') return false
  return getAiGenerationAttemptCount(experience) < MAX_AI_GENERATION_ATTEMPTS
}

function parseModelJson(content) {
  const raw = String(content || '').trim()
  const source = raw.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim()
  try {
    return normalizeContent(JSON.parse(source))
  } catch (err) {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end <= start) throw err
    const parsed = JSON.parse(raw.slice(start, end + 1))
    return normalizeContent(parsed)
  }
}

function getDeepSeekTimeoutMs() {
  const value = Number(process.env.DEEPSEEK_TIMEOUT_MS)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_DEEPSEEK_TIMEOUT_MS
  return Math.min(MAX_DEEPSEEK_TIMEOUT_MS, Math.max(1000, Math.floor(value)))
}

async function generateDraftWithDeepSeek(need, messages) {
  if (!hasMeaningfulTaskMaterial(need, messages)) {
    console.warn('DeepSeek 草稿生成跳过：任务信息不足或疑似测试数据')
    return {
      draft: getFallbackDraft(need),
      warning: '任务信息较少，已生成基础草稿，请手动补充任务结果'
    }
  }

  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    console.warn('DeepSeek 草稿生成跳过：未读取到 DEEPSEEK_API_KEY')
    return { draft: getFallbackDraft(need), warning: '尚未配置 DeepSeek API Key，请先手动填写经验内容' }
  }

  const model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'
  const timeout = getDeepSeekTimeoutMs()
  console.log('DeepSeek 草稿生成准备请求:', {
    model,
    timeout,
    messageCount: messages.length,
    hasApiKey: true
  })
  const prompt = [
    '你是“问当地”平台的经验整理助手。',
    '请根据任务信息和聊天记录生成适合公开展示的匿名经验，只能使用原始材料中的事实，不得推测或补充。',
    '不要输出姓名、昵称、账号、联系方式、精确门牌、精确经纬度或能够识别个人身份的信息。',
    '地点保留到商圈、道路、公共场所或“附近”的粒度。',
    '语音和图片若没有文字内容，不要猜测其中信息。',
    '如果任务描述和聊天记录明显是测试、无意义、占位内容，或不足以总结真实经验，不要编造结果；result 和 tips 返回空字符串即可。',
    '只返回 JSON，不要添加解释。字段：title、publicLocation、question、result、tips。title 必须基于任务类型和任务描述总结，question 直接整理为适合公开展示的任务描述。',
    '',
    `任务描述：${text(need.description, 1000)}`,
    `任务类型：${getTaskTypeName(need.type)}`,
    `任务地点：${text(need.location_name, 200)}`,
    `任务完成时间：${need.complete_time ? new Date(need.complete_time).toISOString() : ''}`,
    '',
    '聊天记录：',
    buildConversation(messages, need.user_id)
  ].join('\n')

  const response = await axios.post(
    `${process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'}/chat/completions`,
    {
      model,
      messages: [
        { role: 'system', content: '你负责把私密任务沟通整理为准确、克制、匿名的公开经验。' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 900
    },
    {
      timeout,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    }
  )

  const content = response.data &&
    response.data.choices &&
    response.data.choices[0] &&
    response.data.choices[0].message &&
    response.data.choices[0].message.content
  return { draft: parseModelJson(content), warning: '' }
}

function toPublicExperience(item, currentUserId, liked) {
  const publishedTime = toDate(item.published_time)
  const expiresAt = getExperienceExpiresAt(item)
  return {
    _id: item._id,
    needId: item.need_id,
    title: item.title || '',
    publicLocation: item.public_location || '',
    question: item.question || '',
    result: item.result || '',
    applicableTime: item.applicable_time || '',
    freshness: item.freshness || '',
    tips: item.tips || '',
    images: item.images || [],
    usefulCount: Number(item.useful_count) || 0,
    status: item.status,
    publishedTime: publishedTime || null,
    publishedTimeText: formatBeijingDateTime(publishedTime),
    expiresAt: expiresAt || null,
    expiresAtText: formatBeijingDateTime(expiresAt),
    isLiked: !!liked,
    canReport: !!currentUserId && ![item.requester_id, item.helper_id].includes(currentUserId),
    isParticipant: !!currentUserId && [item.requester_id, item.helper_id].includes(currentUserId)
  }
}

async function addNotification(userId, type, title, content, experience) {
  if (!userId) return
  await db.collection('wdd-notifications').add({
    data: {
      user_id: userId,
      type,
      title,
      content,
      experience_id: experience._id,
      need_id: experience.need_id,
      is_read: false,
      create_time: new Date()
    }
  })
}

async function createDraft(event, openid) {
  const needId = text(event.needId, 100)
  if (!needId) return { code: -1, message: '任务ID不能为空' }

  const [user, context, existing] = await Promise.all([
    getCurrentUser(openid),
    getTaskContext(needId),
    getExperienceByNeedId(needId)
  ])
  if (!user) return { code: 401, message: '请先登录' }
  if (!context.need) return { code: 404, message: '任务不存在' }
  if (context.need.user_id !== user._id) return { code: 403, message: '只有求助者可以申请分享' }
  if (context.need.status !== 'completed') return { code: 409, message: '任务完成后才能分享经验' }
  if (!context.taker) return { code: 409, message: '未找到帮助者信息' }
  if (existing) {
    if (shouldRegenerateDraft(existing)) {
      const messages = await loadTaskMessages(needId)
      let generated
      try {
        generated = await generateDraftWithDeepSeek(context.need, messages)
        generated.draft = { ...getFallbackDraft(context.need), ...generated.draft }
      } catch (err) {
        console.error('DeepSeek 重新生成经验草稿失败:', err.response && err.response.data ? err.response.data : err)
        const isTimeout = err.code === 'ECONNABORTED' || /timeout|timed out|超时/i.test(err.message || '')
        generated = {
          draft: getFallbackDraft(context.need),
          warning: isTimeout ? 'AI整理超时，请先手动填写经验内容' : 'AI整理失败，请手动填写经验内容'
        }
      }
      const now = new Date()
      const aiGenerationStatus = getAiGenerationStatus(generated)
      const update = {
        ...generated.draft,
        ai_generation_status: aiGenerationStatus,
        ai_generation_warning: generated.warning || '',
        ai_generation_attempt_count: getAiGenerationAttemptCount(existing) + 1,
        ai_generation_time: now,
        update_time: now
      }
      await db.collection('wdd-experiences').doc(existing._id).update({ data: update })
      return {
        code: 0,
        data: {
          experience: { ...existing, ...update },
          task: getTaskMeta(context.need),
          availableImages: Array.isArray(context.need.images) ? context.need.images : [],
          created: false,
          regenerated: true,
          warning: generated.warning
        }
      }
    }
    return {
      code: 0,
      data: {
        experience: existing,
        task: getTaskMeta(context.need),
        availableImages: Array.isArray(context.need.images) ? context.need.images : [],
        created: false
      }
    }
  }

  const messages = await loadTaskMessages(needId)
  let generated
  try {
    generated = await generateDraftWithDeepSeek(context.need, messages)
    generated.draft = { ...getFallbackDraft(context.need), ...generated.draft }
  } catch (err) {
    console.error('DeepSeek 生成经验草稿失败:', err.response && err.response.data ? err.response.data : err)
    const isTimeout = err.code === 'ECONNABORTED' || /timeout|timed out|超时/i.test(err.message || '')
    generated = {
      draft: getFallbackDraft(context.need),
      warning: isTimeout ? 'AI整理超时，请先手动填写经验内容' : 'AI整理失败，请手动填写经验内容'
    }
  }

  const now = new Date()
  const aiGenerationStatus = getAiGenerationStatus(generated)
  const addRes = await db.collection('wdd-experiences').add({
    data: {
      need_id: needId,
      requester_id: user._id,
      helper_id: context.taker.taker_id,
      helper_share_authorized: !!context.taker.experience_share_authorized,
      authorization_version: context.taker.experience_authorization_version || '',
      status: 'draft',
      submitted_once: false,
      version: 0,
      useful_count: 0,
      report_count: 0,
      ai_generation_status: aiGenerationStatus,
      ai_generation_warning: generated.warning || '',
      ai_generation_attempt_count: aiGenerationStatus === 'skipped' ? 0 : 1,
      ai_generation_time: now,
      ...generated.draft,
      create_time: now,
      update_time: now
    }
  })
  const experience = {
    _id: addRes._id,
    ...generated.draft,
    status: 'draft',
    version: 0,
    ai_generation_status: aiGenerationStatus,
    ai_generation_warning: generated.warning || '',
    ai_generation_attempt_count: aiGenerationStatus === 'skipped' ? 0 : 1,
    ai_generation_time: now
  }
  return {
    code: 0,
    data: {
      experience,
      task: getTaskMeta(context.need),
      availableImages: Array.isArray(context.need.images) ? context.need.images : [],
      created: true,
      warning: generated.warning
    }
  }
}

async function getEditor(event, openid) {
  const needId = text(event.needId, 100)
  const [user, context, experience] = await Promise.all([
    getCurrentUser(openid),
    getTaskContext(needId),
    getExperienceByNeedId(needId)
  ])
  if (!user) return { code: 401, message: '请先登录' }
  if (!context.need || context.need.user_id !== user._id) return { code: 403, message: '无权编辑' }
  if (!experience) return { code: 0, data: { experience: null, task: getTaskMeta(context.need), availableImages: context.need.images || [] } }
  return {
    code: 0,
    data: {
      experience,
      task: getTaskMeta(context.need),
      availableImages: Array.isArray(context.need.images) ? context.need.images : [],
      editable: EDITABLE_STATUSES.includes(experience.status),
      canCancel: experience.status === 'pending_confirmation'
    }
  }
}

async function saveDraft(event, openid) {
  const experienceId = text(event.experienceId, 100)
  const user = await getCurrentUser(openid)
  if (!user) return { code: 401, message: '请先登录' }
  const content = normalizeContent(event.content)
  const validation = validateContent(content)
  if (validation) return { code: -1, message: validation }

  const transaction = await db.startTransaction()
  try {
    const res = await transaction.collection('wdd-experiences').doc(experienceId).get()
    const experience = res.data
    if (!experience || experience.requester_id !== user._id) {
      await transaction.rollback()
      return { code: 403, message: '无权编辑该经验' }
    }
    if (!EDITABLE_STATUSES.includes(experience.status)) {
      await transaction.rollback()
      return { code: 409, message: '帮助者已处理，内容不能再修改' }
    }

    const isFirstSubmit = experience.status === 'draft'
    const now = new Date()
    const nextVersion = (Number(experience.version) || 0) + 1
    const update = {
      ...content,
      applicable_time: '',
      expires_at: getFreshnessExpiresAt(content.freshness, now),
      status: 'pending_confirmation',
      submitted_once: true,
      version: nextVersion,
      update_time: now
    }
    if (isFirstSubmit) {
      update.submit_time = now
      update.confirm_deadline = new Date(now.getTime() + CONFIRM_WINDOW_MS)
    }
    await transaction.collection('wdd-experiences').doc(experienceId).update({ data: update })
    await transaction.commit()

    if (isFirstSubmit) {
      const latest = { ...experience, ...update, _id: experienceId }
      const deadlineText = formatBeijingTime(update.confirm_deadline)
      await addNotification(
        experience.helper_id,
        'experience_confirmation',
        '经验分享待确认',
        `经验分享“${content.title}”等待你确认，请在${deadlineText}前处理。`,
        latest
      ).catch(err => console.error('发送经验确认通知失败:', err))
    }
    return { code: 0, message: isFirstSubmit ? '已提交帮助者确认' : '修改已保存', data: { version: nextVersion } }
  } catch (err) {
    await transaction.rollback().catch(() => {})
    throw err
  }
}

async function cancelShare(event, openid) {
  const experienceId = text(event.experienceId, 100)
  const user = await getCurrentUser(openid)
  if (!user) return { code: 401, message: '请先登录' }

  const transaction = await db.startTransaction()
  try {
    const res = await transaction.collection('wdd-experiences').doc(experienceId).get()
    const experience = res.data
    if (!experience || experience.requester_id !== user._id) {
      await transaction.rollback()
      return { code: 403, message: '无权取消该分享' }
    }
    if (experience.status !== 'pending_confirmation') {
      await transaction.rollback()
      return { code: 409, message: experience.status === 'published' ? '经验已发布，无法取消' : '当前分享已结束' }
    }
    const now = new Date()
    await transaction.collection('wdd-experiences').doc(experienceId).update({
      data: { status: 'withdrawn', withdraw_time: now, update_time: now }
    })
    await transaction.commit()
    await addNotification(
      experience.helper_id,
      'experience_withdrawn',
      '经验分享已取消',
      `经验分享“${experience.title}”已由求助者取消，无需继续确认。`,
      experience
    ).catch(err => console.error('发送撤回通知失败:', err))
    return { code: 0, message: '已取消分享' }
  } catch (err) {
    await transaction.rollback().catch(() => {})
    throw err
  }
}

async function getConfirmation(event, openid) {
  const experienceId = text(event.experienceId, 100)
  const user = await getCurrentUser(openid)
  if (!user) return { code: 401, message: '请先登录' }
  const res = await db.collection('wdd-experiences').doc(experienceId).get().catch(() => null)
  const experience = res && res.data
  if (!experience || experience.helper_id !== user._id) return { code: 403, message: '无权查看该分享' }
  return { code: 0, data: { experience, canHandle: experience.status === 'pending_confirmation' } }
}

async function handleConfirmation(event, openid, accepted) {
  const experienceId = text(event.experienceId, 100)
  const user = await getCurrentUser(openid)
  if (!user) return { code: 401, message: '请先登录' }

  const transaction = await db.startTransaction()
  try {
    const res = await transaction.collection('wdd-experiences').doc(experienceId).get()
    const experience = res.data
    if (!experience || experience.helper_id !== user._id) {
      await transaction.rollback()
      return { code: 403, message: '无权处理该分享' }
    }
    if (experience.status !== 'pending_confirmation') {
      await transaction.rollback()
      return { code: 409, message: experience.status === 'published' ? '经验已经发布' : '该分享已结束' }
    }
    const now = new Date()
    const update = accepted
      ? {
        status: 'published',
        confirmed_time: now,
        published_time: now,
        expires_at: experience.expires_at || getFreshnessExpiresAt(experience.freshness, experience.submit_time ? toDate(experience.submit_time) || now : now),
        update_time: now
      }
      : { status: 'rejected', rejected_time: now, update_time: now }
    await transaction.collection('wdd-experiences').doc(experienceId).update({ data: update })
    await transaction.commit()

    await addNotification(
      experience.requester_id,
      accepted ? 'experience_published' : 'experience_rejected',
      accepted ? '经验分享已发布' : '经验分享未发布',
      accepted
        ? `经验分享“${experience.title}”已获得帮助者确认并公开。`
        : `帮助者选择暂不分享“${experience.title}”，本次申请已关闭。`,
      experience
    ).catch(err => console.error('发送确认结果通知失败:', err))
    return { code: 0, message: accepted ? '经验已发布' : '已选择暂不分享' }
  } catch (err) {
    await transaction.rollback().catch(() => {})
    throw err
  }
}

async function processExpired() {
  const now = new Date()
  const res = await db.collection('wdd-experiences').where({
    status: 'pending_confirmation',
    confirm_deadline: _.lte(now)
  }).limit(100).get()
  const result = { published: 0, expired: 0, errors: [] }
  for (const item of res.data) {
    const transaction = await db.startTransaction()
    try {
      const latestRes = await transaction.collection('wdd-experiences').doc(item._id).get()
      const latest = latestRes.data
      if (!latest || latest.status !== 'pending_confirmation' || new Date(latest.confirm_deadline) > now) {
        await transaction.rollback()
        continue
      }
      const nextStatus = latest.helper_share_authorized ? 'published' : 'expired'
      const update = {
        status: nextStatus,
        update_time: now,
        ...(nextStatus === 'published' ? { published_time: now, publish_type: 'timeout' } : { expired_time: now })
      }
      await transaction.collection('wdd-experiences').doc(item._id).update({ data: update })
      await transaction.commit()
      const content = nextStatus === 'published'
        ? `经验分享“${latest.title}”超过确认期限，已自动发布。`
        : `经验分享“${latest.title}”超过确认期限，申请已失效。`
      await Promise.all([
        addNotification(latest.requester_id, `experience_${nextStatus}`, '经验分享处理结果', content, latest),
        addNotification(latest.helper_id, `experience_${nextStatus}`, '经验分享处理结果', content, latest)
      ])
      result[nextStatus === 'published' ? 'published' : 'expired']++
    } catch (err) {
      await transaction.rollback().catch(() => {})
      result.errors.push({ experienceId: item._id, message: err.message })
    }
  }
  return { code: result.errors.length ? 1 : 0, data: result }
}

async function getPublicList(event, openid) {
  const user = await getCurrentUser(openid).catch(err => {
    console.warn('查经验列表读取当前用户失败，按游客处理:', err.message || err)
    return null
  })
  const keyword = text(event.keyword, 50)
  const page = Math.max(1, Number(event.page) || 1)
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(event.pageSize) || 10))
  const where = keyword
    ? _.and([
      { status: 'published' },
      _.or([
        { title: db.RegExp({ regexp: keyword, options: 'i' }) },
        { public_location: db.RegExp({ regexp: keyword, options: 'i' }) }
      ])
    ])
    : { status: 'published' }
  let listRes
  try {
    listRes = await db.collection('wdd-experiences').where(where)
      .orderBy('published_time', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize + 1)
      .get()
  } catch (err) {
    console.warn('查经验列表按发布时间排序失败，降级为无排序查询:', err.message || err)
    try {
      listRes = await db.collection('wdd-experiences').where(where)
        .skip((page - 1) * pageSize)
        .limit(pageSize + 1)
        .get()
    } catch (fallbackErr) {
      const message = fallbackErr.message || fallbackErr.errMsg || ''
      if (/collection|not exist|does not exist|不存在/i.test(message)) {
        return { code: 0, data: { list: [], hasMore: false, total: 0 } }
      }
      throw fallbackErr
    }
  }
  const pageItems = listRes.data.slice(0, pageSize)
  const likedIds = new Set()
  if (user && pageItems.length) {
    const ids = pageItems.map(item => item._id)
    const likeRes = await db.collection('wdd-experience-likes').where({
      experience_id: _.in(ids),
      user_id: user._id
    }).get().catch(err => {
      console.warn('查经验列表读取点赞状态失败，已忽略:', err.message || err)
      return { data: [] }
    })
    likeRes.data.forEach(item => likedIds.add(item.experience_id))
  }
  return {
    code: 0,
    data: {
      list: pageItems.map(item => toPublicExperience(item, user && user._id, likedIds.has(item._id))),
      hasMore: listRes.data.length > pageSize,
      total: page === 1 ? pageItems.length : undefined
    }
  }
}

async function getPublicDetail(event, openid) {
  const experienceId = text(event.experienceId, 100)
  const [user, res] = await Promise.all([
    getCurrentUser(openid),
    db.collection('wdd-experiences').doc(experienceId).get().catch(() => null)
  ])
  const item = res && res.data
  if (!item || item.status !== 'published') return { code: 404, message: '经验不存在或已下架' }
  let liked = false
  if (user) {
    const likeRes = await db.collection('wdd-experience-likes').doc(`${experienceId}_${user._id}`).get().catch(() => null)
    liked = !!(likeRes && likeRes.data)
  }
  return { code: 0, data: { experience: toPublicExperience(item, user && user._id, liked) } }
}

async function toggleLike(event, openid) {
  const experienceId = text(event.experienceId, 100)
  const user = await getCurrentUser(openid)
  if (!user) return { code: 401, message: '请先登录' }
  const likeId = `${experienceId}_${user._id}`
  const transaction = await db.startTransaction()
  try {
    const expRes = await transaction.collection('wdd-experiences').doc(experienceId).get()
    const experience = expRes.data
    if (!experience || experience.status !== 'published') {
      await transaction.rollback()
      return { code: 409, message: '该经验当前不可点赞' }
    }
    if ([experience.requester_id, experience.helper_id].includes(user._id)) {
      await transaction.rollback()
      return { code: 403, message: '不能点赞自己参与的经验' }
    }
    const likeRes = await transaction.collection('wdd-experience-likes').doc(likeId).get().catch(() => null)
    const liked = !!(likeRes && likeRes.data)
    if (liked) {
      await transaction.collection('wdd-experience-likes').doc(likeId).remove()
      await transaction.collection('wdd-experiences').doc(experienceId).update({
        data: { useful_count: Math.max(0, Number(experience.useful_count) - 1), update_time: new Date() }
      })
    } else {
      await transaction.collection('wdd-experience-likes').add({
        data: {
          _id: likeId,
          experience_id: experienceId,
          user_id: user._id,
          create_time: new Date()
        }
      })
      await transaction.collection('wdd-experiences').doc(experienceId).update({
        data: { useful_count: Number(experience.useful_count) + 1, update_time: new Date() }
      })
    }
    await transaction.commit()
    return {
      code: 0,
      data: {
        liked: !liked,
        usefulCount: Math.max(0, Number(experience.useful_count) + (liked ? -1 : 1))
      }
    }
  } catch (err) {
    await transaction.rollback().catch(() => {})
    throw err
  }
}

async function submitReport(event, openid) {
  const experienceId = text(event.experienceId, 100)
  const description = text(event.description, 300)
  const user = await getCurrentUser(openid)
  if (!user) return { code: 401, message: '请先登录' }
  const reportId = `${experienceId}_${user._id}`
  const existing = await db.collection('wdd-experience-reports').doc(reportId).get().catch(() => null)
  if (existing && existing.data) {
    if (existing.data.status === 'pending') {
      await db.collection('wdd-experience-reports').doc(reportId).update({
        data: {
          description,
          update_time: new Date()
        }
      })
      return { code: 0, message: '举报说明已更新，处理结果将通过消息通知' }
    }
    return { code: 409, message: '这条举报已处理，如仍有问题请联系客服' }
  }

  const transaction = await db.startTransaction()
  try {
    const expRes = await transaction.collection('wdd-experiences').doc(experienceId).get()
    const experience = expRes.data
    if (!experience || experience.status !== 'published') {
      await transaction.rollback()
      return { code: 409, message: '该经验当前不可举报' }
    }
    if ([experience.requester_id, experience.helper_id].includes(user._id)) {
      await transaction.rollback()
      return { code: 403, message: '不能举报自己参与的经验' }
    }
    const now = new Date()
    await transaction.collection('wdd-experience-reports').add({
      data: {
        _id: reportId,
        experience_id: experienceId,
        reporter_id: user._id,
        description,
        status: 'pending',
        create_time: now,
        update_time: now
      }
    })
    const ticketRes = await transaction.collection('wdd-experience-report-tickets').doc(experienceId).get().catch(() => null)
    if (ticketRes && ticketRes.data) {
      await transaction.collection('wdd-experience-report-tickets').doc(experienceId).update({
        data: {
          status: 'pending',
          pending_count: Number(ticketRes.data.pending_count) + 1,
          total_count: Number(ticketRes.data.total_count) + 1,
          latest_report_time: now,
          update_time: now
        }
      })
    } else {
      await transaction.collection('wdd-experience-report-tickets').add({
        data: {
          _id: experienceId,
          experience_id: experienceId,
          title_snapshot: experience.title,
          status: 'pending',
          pending_count: 1,
          total_count: 1,
          latest_report_time: now,
          create_time: now,
          update_time: now
        }
      })
    }
    await transaction.collection('wdd-experiences').doc(experienceId).update({
      data: { report_count: _.inc(1), update_time: now }
    })
    await transaction.commit()
    return { code: 0, message: '举报已提交，处理结果将通过消息通知' }
  } catch (err) {
    await transaction.rollback().catch(() => {})
    throw err
  }
}

async function getAdminExperiences(event, openid) {
  if (!await isCustomerService(openid)) return { code: 403, message: '无权访问' }
  const status = event.status === 'down' ? 'down' : 'published'
  const page = Math.max(1, Number(event.page) || 1)
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(event.pageSize) || 20))
  const res = await db.collection('wdd-experiences').where({ status })
    .orderBy('update_time', 'desc').skip((page - 1) * pageSize).limit(pageSize + 1).get()
  return {
    code: 0,
    data: {
      list: res.data.slice(0, pageSize).map(item => toPublicExperience(item, null, false)),
      hasMore: res.data.length > pageSize
    }
  }
}

async function setExperienceStatus(event, openid) {
  const config = await loadConfig()
  if (!await isCustomerService(openid, config)) return { code: 403, message: '无权操作' }
  const handler = await getCurrentUser(openid)
  const experienceId = text(event.experienceId, 100)
  const targetStatus = event.targetStatus === 'published' ? 'published' : 'down'
  const transaction = await db.startTransaction()
  try {
    const res = await transaction.collection('wdd-experiences').doc(experienceId).get()
    const experience = res.data
    if (!experience) {
      await transaction.rollback()
      return { code: 404, message: '经验不存在' }
    }
    if (!['published', 'down'].includes(experience.status)) {
      await transaction.rollback()
      return { code: 409, message: '当前状态不允许上下架' }
    }
    const now = new Date()
    await transaction.collection('wdd-experiences').doc(experienceId).update({
      data: {
        status: targetStatus,
        handler_id: handler && handler._id,
        ...(targetStatus === 'down' ? { down_time: now } : { restore_time: now }),
        update_time: now
      }
    })
    await transaction.commit()
    const content = targetStatus === 'down'
      ? `你参与发布的经验“${experience.title}”已由平台下架。`
      : `你参与发布的经验“${experience.title}”已恢复展示。`
    await Promise.all([
      addNotification(experience.requester_id, `experience_${targetStatus}`, '经验分享状态更新', content, experience),
      addNotification(experience.helper_id, `experience_${targetStatus}`, '经验分享状态更新', content, experience)
    ])
    return { code: 0, message: targetStatus === 'down' ? '已下架' : '已上架' }
  } catch (err) {
    await transaction.rollback().catch(() => {})
    throw err
  }
}

async function getReportTickets(event, openid) {
  if (!await isCustomerService(openid)) return { code: 403, message: '无权访问' }
  const status = event.status === 'resolved' ? 'resolved' : 'pending'
  const page = Math.max(1, Number(event.page) || 1)
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(event.pageSize) || 20))
  let res
  try {
    res = await db.collection('wdd-experience-report-tickets').where({ status })
      .orderBy(status === 'pending' ? 'latest_report_time' : 'resolve_time', 'desc')
      .skip((page - 1) * pageSize).limit(pageSize + 1).get()
  } catch (err) {
    if (isCollectionNotFound(err)) {
      console.warn('经验举报工单集合不存在，返回空列表:', err.message || err.errMsg || err)
      return {
        code: 0,
        data: {
          list: [],
          hasMore: false,
          missingCollection: 'wdd-experience-report-tickets'
        }
      }
    }
    throw err
  }
  return { code: 0, data: { list: res.data.slice(0, pageSize), hasMore: res.data.length > pageSize } }
}

async function getReportTicketDetail(event, openid) {
  if (!await isCustomerService(openid)) return { code: 403, message: '无权访问' }
  const experienceId = text(event.experienceId, 100)
  const [ticketRes, expRes, reportRes] = await Promise.all([
    db.collection('wdd-experience-report-tickets').doc(experienceId).get().catch(err => {
      if (isCollectionNotFound(err)) return null
      throw err
    }),
    db.collection('wdd-experiences').doc(experienceId).get().catch(() => null),
    db.collection('wdd-experience-reports').where({ experience_id: experienceId }).orderBy('create_time', 'desc').get().catch(err => {
      if (isCollectionNotFound(err)) return { data: [] }
      throw err
    })
  ])
  if (!ticketRes || !ticketRes.data) return { code: 404, message: '举报工单不存在' }
  return {
    code: 0,
    data: {
      ticket: ticketRes.data,
      experience: expRes && expRes.data ? toPublicExperience(expRes.data, null, false) : null,
      reports: reportRes.data.map(item => ({
        _id: item._id,
        description: item.description || '',
        status: item.status,
        createTime: item.create_time
      }))
    }
  }
}

async function resolveReportTicket(event, openid) {
  if (!await isCustomerService(openid)) return { code: 403, message: '无权操作' }
  const handler = await getCurrentUser(openid)
  const experienceId = text(event.experienceId, 100)
  const result = event.result === 'down' ? 'down' : 'no_action'
  const transaction = await db.startTransaction()
  try {
    const [ticketRes, expRes] = await Promise.all([
      transaction.collection('wdd-experience-report-tickets').doc(experienceId).get(),
      transaction.collection('wdd-experiences').doc(experienceId).get()
    ])
    const ticket = ticketRes.data
    const experience = expRes.data
    if (!ticket || ticket.status !== 'pending') {
      await transaction.rollback()
      return { code: 409, message: '该工单已处理' }
    }
    const now = new Date()
    await transaction.collection('wdd-experience-report-tickets').doc(experienceId).update({
      data: {
        status: 'resolved',
        result,
        pending_count: 0,
        handler_id: handler && handler._id,
        resolve_time: now,
        update_time: now
      }
    })
    await transaction.collection('wdd-experience-reports').where({
      experience_id: experienceId,
      status: 'pending'
    }).update({
      data: { status: 'resolved', result, resolve_time: now, update_time: now }
    })
    if (result === 'down' && experience.status === 'published') {
      await transaction.collection('wdd-experiences').doc(experienceId).update({
        data: { status: 'down', down_time: now, handler_id: handler && handler._id, update_time: now }
      })
    }
    await transaction.commit()

    const reporterRes = await db.collection('wdd-experience-reports').where({
      experience_id: experienceId,
      result
    }).get()
    const reporterIds = [...new Set(reporterRes.data.map(item => item.reporter_id))]
    await Promise.all(reporterIds.map(reporterId => addNotification(
      reporterId,
      'experience_report_result',
      '经验举报处理结果',
      `你举报的经验“${experience.title}”已处理，结果为${result === 'down' ? '已下架' : '不予处理'}。`,
      experience
    )))
    if (result === 'down') {
      const content = `你参与发布的经验“${experience.title}”已由平台下架。`
      await Promise.all([
        addNotification(experience.requester_id, 'experience_down', '经验分享已下架', content, experience),
        addNotification(experience.helper_id, 'experience_down', '经验分享已下架', content, experience)
      ])
    }
    return { code: 0, message: result === 'down' ? '经验已下架' : '已不予处理' }
  } catch (err) {
    await transaction.rollback().catch(() => {})
    throw err
  }
}

function formatBeijingTime(value) {
  const date = new Date(value)
  const bj = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  return `${bj.getUTCMonth() + 1}月${bj.getUTCDate()}日${String(bj.getUTCHours()).padStart(2, '0')}:${String(bj.getUTCMinutes()).padStart(2, '0')}`
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || (event.TriggerName ? 'processExpired' : '')
  try {
    switch (action) {
      case 'createDraft': return await createDraft(event, OPENID)
      case 'getEditor': return await getEditor(event, OPENID)
      case 'saveDraft': return await saveDraft(event, OPENID)
      case 'cancelShare': return await cancelShare(event, OPENID)
      case 'getConfirmation': return await getConfirmation(event, OPENID)
      case 'confirmShare': return await handleConfirmation(event, OPENID, true)
      case 'rejectShare': return await handleConfirmation(event, OPENID, false)
      case 'processExpired': return await processExpired()
      case 'getPublicList': return await getPublicList(event, OPENID)
      case 'getPublicDetail': return await getPublicDetail(event, OPENID)
      case 'toggleLike': return await toggleLike(event, OPENID)
      case 'submitReport': return await submitReport(event, OPENID)
      case 'getAdminExperiences': return await getAdminExperiences(event, OPENID)
      case 'setExperienceStatus': return await setExperienceStatus(event, OPENID)
      case 'getReportTickets': return await getReportTickets(event, OPENID)
      case 'getReportTicketDetail': return await getReportTicketDetail(event, OPENID)
      case 'resolveReportTicket': return await resolveReportTicket(event, OPENID)
      default: return { code: -1, message: '未知操作' }
    }
  } catch (err) {
    console.error('经验分享操作失败:', err)
    return { code: -1, message: err.message || '操作失败' }
  }
}
