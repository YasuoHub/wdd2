// 头像本地文件缓存
// 用途：聊天页先展示已保存到本地的头像文件，避免每次进页面远端头像重新加载造成闪动。

const CACHE_VERSION = 'v1'
const VERSION_KEY = 'avatar_cache_version'
const INDEX_KEY = 'avatar_cache_index'
const ITEM_KEY_PREFIX = 'avatar_cache_'
const MAX_AVATAR_CACHE = 80

let _versionChecked = false

function ensureVersion() {
  if (_versionChecked) return
  _versionChecked = true
  try {
    const cur = wx.getStorageSync(VERSION_KEY)
    if (cur !== CACHE_VERSION) {
      clearAll()
      wx.setStorageSync(VERSION_KEY, CACHE_VERSION)
    }
  } catch (e) {
    // 静默降级：头像缓存失败不影响聊天主流程
  }
}

function itemKey(userId) {
  return ITEM_KEY_PREFIX + userId
}

function getIndex() {
  try {
    return wx.getStorageSync(INDEX_KEY) || []
  } catch (e) {
    return []
  }
}

function setIndex(index) {
  try {
    wx.setStorageSync(INDEX_KEY, index)
  } catch (e) {
    // 静默
  }
}

function isCacheableAvatar(avatarUrl) {
  if (!avatarUrl || typeof avatarUrl !== 'string') return false
  return (
    avatarUrl.indexOf('cloud://') === 0 ||
    avatarUrl.indexOf('https://') === 0 ||
    avatarUrl.indexOf('http://') === 0
  )
}

function fileExists(filePath) {
  if (!filePath || typeof filePath !== 'string') return false
  try {
    wx.getFileSystemManager().accessSync(filePath)
    return true
  } catch (e) {
    return false
  }
}

function removeSavedFile(filePath) {
  if (!filePath || filePath.indexOf('http') === 0 || filePath.indexOf('cloud://') === 0) return
  try {
    wx.getFileSystemManager().unlinkSync(filePath)
  } catch (e) {
    // 文件可能已被系统清理，忽略即可
  }
}

function getCachedAvatar(userId, remoteAvatar) {
  if (!userId || !remoteAvatar) return remoteAvatar || ''
  if (!isCacheableAvatar(remoteAvatar)) return remoteAvatar
  ensureVersion()

  try {
    const cached = wx.getStorageSync(itemKey(userId))
    if (
      cached &&
      cached.remoteAvatar === remoteAvatar &&
      cached.savedPath &&
      fileExists(cached.savedPath)
    ) {
      return cached.savedPath
    }
  } catch (e) {
    // 静默
  }

  return remoteAvatar
}

function getImageInfo(src) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src,
      success: resolve,
      fail: reject
    })
  })
}

function getTempFileURL(fileID) {
  return new Promise((resolve, reject) => {
    wx.cloud.getTempFileURL({
      fileList: [fileID],
      success: res => {
        const item = res.fileList && res.fileList[0]
        if (item && item.tempFileURL) {
          resolve(item.tempFileURL)
        } else {
          reject(new Error('头像临时链接为空'))
        }
      },
      fail: reject
    })
  })
}

function downloadFile(url) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      success: res => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error('头像下载失败'))
          return
        }
        resolve(res.tempFilePath)
      },
      fail: reject
    })
  })
}

function saveFile(tempFilePath) {
  return new Promise((resolve, reject) => {
    wx.saveFile({
      tempFilePath,
      success: res => resolve(res.savedFilePath),
      fail: reject
    })
  })
}

async function resolveTempFilePath(remoteAvatar) {
  try {
    const info = await getImageInfo(remoteAvatar)
    if (info && info.path) return info.path
  } catch (e) {
    // cloud:// 在部分基础库里无法直接 getImageInfo，下面转临时链接再下载
  }

  const downloadUrl = remoteAvatar.indexOf('cloud://') === 0
    ? await getTempFileURL(remoteAvatar)
    : remoteAvatar
  return await downloadFile(downloadUrl)
}

async function cacheAvatar(userId, remoteAvatar) {
  if (!userId || !remoteAvatar) return remoteAvatar || ''
  if (!isCacheableAvatar(remoteAvatar)) return remoteAvatar
  ensureVersion()

  const existingPath = getCachedAvatar(userId, remoteAvatar)
  if (existingPath && existingPath !== remoteAvatar) return existingPath

  const oldItem = wx.getStorageSync(itemKey(userId))
  const tempFilePath = await resolveTempFilePath(remoteAvatar)
  const savedPath = await saveFile(tempFilePath)
  const now = Date.now()

  wx.setStorageSync(itemKey(userId), {
    userId,
    remoteAvatar,
    savedPath,
    updatedAt: now
  })

  const index = getIndex().filter(item => item.userId !== userId)
  index.push({ userId, updatedAt: now })
  setIndex(index)

  if (oldItem && oldItem.savedPath && oldItem.savedPath !== savedPath) {
    removeSavedFile(oldItem.savedPath)
  }

  cleanupIfNeeded()
  return savedPath
}

function cleanupIfNeeded() {
  const index = getIndex().sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
  if (index.length <= MAX_AVATAR_CACHE) return

  const overflow = index.length - MAX_AVATAR_CACHE
  const removeItems = index.slice(0, overflow)
  removeItems.forEach(item => {
    try {
      const cached = wx.getStorageSync(itemKey(item.userId))
      if (cached && cached.savedPath) removeSavedFile(cached.savedPath)
      wx.removeStorageSync(itemKey(item.userId))
    } catch (e) {
      // 静默
    }
  })

  setIndex(index.slice(overflow))
}

function clearAll() {
  const index = getIndex()
  index.forEach(item => {
    try {
      const cached = wx.getStorageSync(itemKey(item.userId))
      if (cached && cached.savedPath) removeSavedFile(cached.savedPath)
      wx.removeStorageSync(itemKey(item.userId))
    } catch (e) {
      // 静默
    }
  })
  try { wx.removeStorageSync(INDEX_KEY) } catch (e) {}
}

module.exports = {
  getCachedAvatar,
  cacheAvatar
}
