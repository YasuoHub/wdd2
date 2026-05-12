// 聊天记录本地缓存
// 进入聊天页时优先读取本地缓存渲染，再静默拉远端 diff 写回。
//
// 策略：
//   - 单任务最多保留最近 200 条消息（超出按 FIFO 截断头部）
//   - 已完成任务整体最多保留 100 个（FIFO 按完成时间清理）
//   - 进行中任务不计入容量上限
//   - 任务取消 / 过期 → invalidate
//   - 版本不匹配 → 全清重建
//   - watch / 轮询高频触发 → 用 scheduleWrite 防抖,避免主线程频繁阻塞

const CACHE_VERSION = 'v1'
const VERSION_KEY = 'chat_cache_version'
const INDEX_KEY = 'chat_cache_index'
const ITEM_KEY_PREFIX = 'chat_cache_'

const MAX_MESSAGES_PER_TASK = 200
const MAX_COMPLETED_TASKS = 100
const WRITE_DEBOUNCE_MS = 300

// 版本校验：不匹配则全清后写入新版本号（模块单例 → 整个小程序生命周期只跑一次）
let _versionChecked = false
function ensureVersion() {
  if (_versionChecked) return
  _versionChecked = true
  try {
    const cur = wx.getStorageSync(VERSION_KEY)
    if (cur !== CACHE_VERSION) {
      _clearAllInternal()
      wx.setStorageSync(VERSION_KEY, CACHE_VERSION)
    }
  } catch (e) {
    // 静默
  }
}

function itemKey(needId) {
  return ITEM_KEY_PREFIX + needId
}

function getIndex() {
  try {
    return wx.getStorageSync(INDEX_KEY) || []
  } catch (e) {
    return []
  }
}

function setIndex(idx) {
  try {
    wx.setStorageSync(INDEX_KEY, idx)
  } catch (e) {
    // 静默
  }
}

// 过滤掉发送中 / 临时消息,避免缓存里残留 sendStatus='sending' 污染下次渲染
function cleanSendingMessages(messages) {
  return messages.filter(m =>
    m && m._id &&
    !String(m._id).startsWith('temp_') &&
    m.sendStatus !== 'sending'
  )
}

// 读取缓存：命中返回 { messages, taskMeta, updatedAt }
function readCache(needId) {
  if (!needId) return null
  ensureVersion()
  try {
    const data = wx.getStorageSync(itemKey(needId))
    if (!data || !data.messages) return null
    return data
  } catch (e) {
    return null
  }
}

// 覆盖式写入（同步、立即生效）
function writeCache(needId, messages, taskMeta) {
  if (!needId) return
  ensureVersion()

  const status = taskMeta && taskMeta.task && taskMeta.task.status
  // 取消 / 过期不留缓存
  if (status === 'cancelled' || status === 'expired') {
    invalidate(needId)
    return
  }

  // 过滤临时消息 + 长度截断（仅保留最新 N 条）
  const cleaned = cleanSendingMessages(Array.isArray(messages) ? messages : [])
  const limited = cleaned.length > MAX_MESSAGES_PER_TASK
    ? cleaned.slice(cleaned.length - MAX_MESSAGES_PER_TASK)
    : cleaned

  const isCompleted = status === 'completed'
  const now = Date.now()

  // 更新索引
  const idx = getIndex()
  const existing = idx.find(e => e.needId === needId)
  if (existing) {
    existing.status = isCompleted ? 'completed' : 'ongoing'
    existing.lastUpdate = now
    if (isCompleted && !existing.completedAt) existing.completedAt = now
  } else {
    idx.push({
      needId,
      status: isCompleted ? 'completed' : 'ongoing',
      completedAt: isCompleted ? now : null,
      lastUpdate: now
    })
  }
  setIndex(idx)

  _trySet(itemKey(needId), {
    messages: limited,
    taskMeta: taskMeta || null,
    updatedAt: now
  })

  cleanupIfNeeded()
}

// 防抖写入：同一 needId 在 300ms 内的多次写入合并为最后一次。
// 用于 watch / pollNewMessages 等高频路径,避免主线程频繁同步阻塞。
const _pendingWrites = new Map()
let _flushTimer = null

function scheduleWrite(needId, messages, taskMeta) {
  if (!needId) return
  _pendingWrites.set(needId, { messages, taskMeta })
  if (_flushTimer) return
  _flushTimer = setTimeout(() => {
    const writes = Array.from(_pendingWrites.entries())
    _pendingWrites.clear()
    _flushTimer = null
    for (const [id, payload] of writes) {
      writeCache(id, payload.messages, payload.taskMeta)
    }
  }, WRITE_DEBOUNCE_MS)
}

// 标记任务为已完成：写入完成时间并触发 FIFO 清理
function markCompleted(needId) {
  if (!needId) return
  // 撤销待写入队列里的同 needId,避免后续 timer 触发时用陈旧的 status='ongoing' 覆盖
  _pendingWrites.delete(needId)
  const idx = getIndex()
  const entry = idx.find(e => e.needId === needId)
  if (entry) {
    entry.status = 'completed'
    if (!entry.completedAt) entry.completedAt = Date.now()
    setIndex(idx)
  }
  // 同步更新缓存里的 task.status,下次 readCache 状态就是最新的
  try {
    const item = wx.getStorageSync(itemKey(needId))
    if (item && item.taskMeta && item.taskMeta.task) {
      item.taskMeta.task.status = 'completed'
      _trySet(itemKey(needId), item)
    }
  } catch (e) {}
  cleanupIfNeeded()
}

// 单条失效：取消 / 删除 / 状态异常
function invalidate(needId) {
  if (!needId) return
  // 同时撤销待写入队列里的同 needId,避免 invalidate 后被 scheduleWrite 重新写回
  _pendingWrites.delete(needId)
  try {
    wx.removeStorageSync(itemKey(needId))
  } catch (e) {}
  const idx = getIndex().filter(e => e.needId !== needId)
  setIndex(idx)
}

// FIFO 清理：仅清理 status='completed' 部分,超过 100 个按 completedAt 升序剔除最旧
function cleanupIfNeeded() {
  const idx = getIndex()
  const completed = idx
    .filter(e => e.status === 'completed')
    .sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0))

  if (completed.length <= MAX_COMPLETED_TASKS) return

  const overflow = completed.length - MAX_COMPLETED_TASKS
  const toRemoveIds = new Set(completed.slice(0, overflow).map(e => e.needId))

  toRemoveIds.forEach(id => {
    try { wx.removeStorageSync(itemKey(id)) } catch (e) {}
  })
  setIndex(idx.filter(e => !toRemoveIds.has(e.needId)))
}

function _clearAllInternal() {
  const idx = getIndex()
  idx.forEach(e => {
    try { wx.removeStorageSync(itemKey(e.needId)) } catch (err) {}
  })
  try { wx.removeStorageSync(INDEX_KEY) } catch (e) {}
}

// 写入失败兜底：触发清理后重试一次
function _trySet(key, value) {
  try {
    wx.setStorageSync(key, value)
  } catch (e) {
    cleanupIfNeeded()
    try {
      wx.setStorageSync(key, value)
    } catch (e2) {
      console.warn('chatCache 写入失败:', e2 && e2.errMsg)
    }
  }
}

module.exports = {
  readCache,
  writeCache,
  scheduleWrite,
  markCompleted,
  invalidate
}
