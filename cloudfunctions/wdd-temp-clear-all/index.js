// 临时运维云函数：清空业务数据库与关联云存储
// 注意：部署并确认执行后会删除数据。使用完建议立即下线或删除该云函数。

const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

const CONFIRM_TEXT = 'CLEAR_WDD_DATA_AND_STORAGE'
const DOC_BATCH_SIZE = 100
const FILE_BATCH_SIZE = 50
const DEFAULT_STORAGE_LIMIT_PER_RUN = 10
const DEFAULT_DOC_DELETE_LIMIT_PER_COLLECTION = 100

const PROTECTED_COLLECTIONS = new Set([
  'wdd-config'
])

const DEFAULT_TARGET_COLLECTIONS = [
  'wdd-users',
  'wdd-needs',
  'wdd-need-takers',
  'wdd-messages',
  'wdd-notifications',
  'wdd-payment-orders',
  'wdd-balance-records',
  'wdd-point-records',
  'wdd-sign-in-records',
  'wdd-invite-records',
  'wdd-ratings',
  'wdd-reports',
  'wdd-appeals',
  'wdd-tickets',
  'wdd-withdraw-records',
  'wdd-settlement-records'
]

function normalizeCollections(collections) {
  const input = Array.isArray(collections) && collections.length > 0
    ? collections
    : DEFAULT_TARGET_COLLECTIONS

  const normalized = []
  const seen = new Set()

  for (const name of input) {
    if (typeof name !== 'string') continue
    const collectionName = name.trim()
    if (!collectionName || seen.has(collectionName)) continue
    seen.add(collectionName)
    normalized.push(collectionName)
  }

  return normalized
}

function assertNoProtectedCollections(collections) {
  const protectedHits = collections.filter(name => PROTECTED_COLLECTIONS.has(name))
  if (protectedHits.length > 0) {
    throw new Error(`禁止清空受保护集合：${protectedHits.join(', ')}`)
  }
}

function collectCloudFileIDs(value, fileIDSet) {
  if (!value) return

  if (typeof value === 'string') {
    if (value.startsWith('cloud://')) {
      fileIDSet.add(value)
    }
    return
  }

  if (Array.isArray(value)) {
    value.forEach(item => collectCloudFileIDs(item, fileIDSet))
    return
  }

  if (typeof value === 'object') {
    Object.keys(value).forEach(key => collectCloudFileIDs(value[key], fileIDSet))
  }
}

async function getCollectionCount(collectionName) {
  try {
    const res = await db.collection(collectionName).count()
    return res.total || 0
  } catch (err) {
    const message = err && err.message ? err.message : ''
    const code = err && (err.code || err.errCode)
    if (
      code === -502005 ||
      /collection not exists|collection not found|collection does not exist|not exist|DATABASE_COLLECTION_NOT_EXIST/i.test(message)
    ) {
      return 0
    }
    throw err
  }
}

async function scanCollectionFiles(collectionName, fileIDSet) {
  const total = await getCollectionCount(collectionName)
  let scanned = 0
  console.log(`[scan] ${collectionName}: total=${total}`)

  while (scanned < total) {
    const res = await db.collection(collectionName)
      .skip(scanned)
      .limit(DOC_BATCH_SIZE)
      .get()

    const docs = res.data || []
    if (docs.length === 0) break

    docs.forEach(doc => collectCloudFileIDs(doc, fileIDSet))
    scanned += docs.length
    console.log(`[scan] ${collectionName}: scanned=${scanned}/${total}, files=${fileIDSet.size}`)
  }

  return { collection: collectionName, total, scanned }
}

function normalizePositiveInteger(value, fallback, maxValue) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  const integer = Math.floor(number)
  return maxValue ? Math.min(integer, maxValue) : integer
}

function normalizeOffset(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return 0
  return Math.floor(number)
}

async function deleteCloudFiles(fileIDs, dryRun, options = {}) {
  const offset = normalizeOffset(options.offset)
  const limit = normalizePositiveInteger(options.limit, fileIDs.length || 0, FILE_BATCH_SIZE)
  const targetFileIDs = fileIDs.slice(offset, offset + limit)
  const result = {
    found: fileIDs.length,
    offset,
    limit,
    attempted: targetFileIDs.length,
    deleted: 0,
    failed: 0,
    batches: [],
    hasMore: offset + targetFileIDs.length < fileIDs.length,
    nextOffset: offset + targetFileIDs.length
  }

  if (dryRun || targetFileIDs.length === 0) {
    return result
  }

  for (let i = 0; i < targetFileIDs.length; i += FILE_BATCH_SIZE) {
    const batch = targetFileIDs.slice(i, i + FILE_BATCH_SIZE)
    const batchResult = {
      requested: batch.length,
      deleted: 0,
      failed: 0,
      errors: []
    }

    try {
      console.log(`[storage] deleting files ${offset + i + 1}-${offset + i + batch.length}/${fileIDs.length}`)
      const res = await cloud.deleteFile({ fileList: batch })
      const fileList = res.fileList || []

      fileList.forEach(item => {
        if (item.status === 0) {
          batchResult.deleted += 1
        } else if (item.status === -503003) {
          // 文件已不存在，也视作清理完成，避免阻塞数据库清空。
          batchResult.deleted += 1
        } else {
          batchResult.failed += 1
          batchResult.errors.push({
            fileID: item.fileID,
            status: item.status,
            errMsg: item.errMsg || item.message || '删除失败'
          })
        }
      })
    } catch (err) {
      batchResult.failed += batch.length
      batchResult.errors.push({
        errMsg: err.message || String(err)
      })
    }

    result.deleted += batchResult.deleted
    result.failed += batchResult.failed
    result.batches.push(batchResult)
  }

  return result
}

async function verifyCloudFiles(fileIDs, options = {}) {
  const offset = normalizeOffset(options.offset)
  const limit = normalizePositiveInteger(options.limit, DEFAULT_STORAGE_LIMIT_PER_RUN, FILE_BATCH_SIZE)
  const targetFileIDs = fileIDs.slice(offset, offset + limit)
  const result = {
    found: fileIDs.length,
    offset,
    limit,
    attempted: targetFileIDs.length,
    existing: 0,
    missingOrDenied: 0,
    failed: 0,
    files: [],
    hasMore: offset + targetFileIDs.length < fileIDs.length,
    nextOffset: offset + targetFileIDs.length
  }

  if (targetFileIDs.length === 0) {
    return result
  }

  try {
    const res = await cloud.getTempFileURL({
      fileList: targetFileIDs
    })
    const fileList = res.fileList || []

    fileList.forEach(item => {
      if (item.status === 0 && item.tempFileURL) {
        result.existing += 1
      } else {
        result.missingOrDenied += 1
      }
      result.files.push({
        fileID: item.fileID,
        status: item.status,
        errMsg: item.errMsg || item.message || ''
      })
    })
  } catch (err) {
    result.failed += targetFileIDs.length
    result.files.push({
      errMsg: err.message || String(err)
    })
  }

  return result
}

async function clearCollection(collectionName, dryRun, docDeleteLimit) {
  const total = await getCollectionCount(collectionName)
  const limit = normalizePositiveInteger(docDeleteLimit, total || 0)
  const result = {
    collection: collectionName,
    total,
    limit,
    deleted: 0,
    hasMore: false
  }

  if (dryRun || total === 0) {
    return result
  }

  console.log(`[db] ${collectionName}: start delete, total=${total}`)

  while (true) {
    if (limit > 0 && result.deleted >= limit) {
      result.hasMore = result.deleted < total
      break
    }

    const batchLimit = limit > 0
      ? Math.min(DOC_BATCH_SIZE, limit - result.deleted)
      : DOC_BATCH_SIZE

    const res = await db.collection(collectionName)
      .field({ _id: true })
      .limit(batchLimit)
      .get()

    const ids = (res.data || []).map(doc => doc._id).filter(Boolean)
    if (ids.length === 0) break

    const removeRes = await db.collection(collectionName)
      .where({ _id: _.in(ids) })
      .remove()

    const removed = removeRes.stats && typeof removeRes.stats.removed === 'number'
      ? removeRes.stats.removed
      : ids.length

    result.deleted += removed
    console.log(`[db] ${collectionName}: deleted=${result.deleted}/${total}`)
  }

  if (!result.hasMore) {
    const remaining = await getCollectionCount(collectionName)
    result.remaining = remaining
    result.hasMore = remaining > 0
  }

  return result
}

exports.main = async (event = {}) => {
  const mode = event.mode || event.action || 'all'
  const dryRun = event.dryRun !== false
  const includeStorage = event.includeStorage !== false
  const ignoreStorageErrors = event.ignoreStorageErrors === true
  const collections = normalizeCollections(event.collections)
  const storageOffset = normalizeOffset(event.storageOffset)
  const storageLimit = normalizePositiveInteger(event.storageLimit, DEFAULT_STORAGE_LIMIT_PER_RUN, FILE_BATCH_SIZE)
  const docDeleteLimit = normalizePositiveInteger(event.docDeleteLimit, DEFAULT_DOC_DELETE_LIMIT_PER_COLLECTION)
  const expectedEnvId = typeof event.expectedEnvId === 'string' ? event.expectedEnvId.trim() : ''
  const wxContext = cloud.getWXContext()

  try {
    assertNoProtectedCollections(collections)
    console.log(`[start] mode=${mode}, dryRun=${dryRun}, includeStorage=${includeStorage}, collections=${collections.join(', ')}`)

    if (expectedEnvId && wxContext.ENV && expectedEnvId !== wxContext.ENV) {
      return {
        code: -1,
        message: `环境不匹配，当前环境为 ${wxContext.ENV}，传入环境为 ${expectedEnvId}`
      }
    }

    if (!dryRun && event.confirm !== CONFIRM_TEXT) {
      return {
        code: -1,
        message: `缺少确认词。真正执行时必须传 confirm: "${CONFIRM_TEXT}"`
      }
    }

    const fileIDSet = new Set()
    const scanResults = []

    if (includeStorage && mode !== 'database') {
      for (const collectionName of collections) {
        scanResults.push(await scanCollectionFiles(collectionName, fileIDSet))
      }
    }

    const extraFileIDs = Array.isArray(event.extraFileIDs) ? event.extraFileIDs : []
    extraFileIDs.forEach(fileID => {
      if (typeof fileID === 'string' && fileID.startsWith('cloud://')) {
        fileIDSet.add(fileID)
      }
    })

    const fileIDs = Array.from(fileIDSet).sort()
    console.log(`[storage] found fileIDs=${fileIDs.length}`)

    if (mode === 'status') {
      const collectionResults = []
      for (const collectionName of collections) {
        collectionResults.push({
          collection: collectionName,
          total: await getCollectionCount(collectionName)
        })
      }

      return {
        code: 0,
        message: '当前清理状态查询完成',
        data: {
          mode,
          dryRun: true,
          includeStorage,
          confirmText: CONFIRM_TEXT,
          protectedCollections: Array.from(PROTECTED_COLLECTIONS),
          targetCollections: collections,
          referencedFileCount: fileIDs.length,
          fileScan: scanResults,
          collections: collectionResults,
          notes: [
            'referencedFileCount 表示数据库文档里还能扫描到多少个 cloud:// 引用，不等于云存储里真实存在的文件数量。',
            '如果还没有执行 mode: "database"，数据库数据仍然会保留，这是预期行为。',
            '如果要确认云存储桶完全为空，需要到微信云开发控制台云存储页面检查孤儿文件。'
          ]
        }
      }
    }
    const storageResult = includeStorage && mode !== 'database'
      ? await deleteCloudFiles(fileIDs, dryRun, {
        offset: mode === 'storage' ? storageOffset : 0,
        limit: mode === 'storage' ? storageLimit : fileIDs.length
      })
      : { found: 0, deleted: 0, failed: 0, batches: [] }

    if (mode === 'storage') {
      return {
        code: 0,
        message: dryRun ? '数据库引用文件预演完成，未删除任何文件' : '数据库引用文件分批删除完成；这不等于整个云存储桶已清空',
        data: {
          mode,
          dryRun,
          includeStorage,
          confirmText: CONFIRM_TEXT,
          protectedCollections: Array.from(PROTECTED_COLLECTIONS),
          targetCollections: collections,
          storage: storageResult,
          fileScan: scanResults,
          nextCall: storageResult.hasMore ? {
            mode: 'storage',
            dryRun,
            includeStorage: true,
            expectedEnvId,
            confirm: CONFIRM_TEXT,
            storageOffset: storageResult.nextOffset,
            storageLimit,
            collections
          } : null
        }
      }
    }

    if (mode === 'verify-storage') {
      const verifyResult = await verifyCloudFiles(fileIDs, {
        offset: storageOffset,
        limit: storageLimit
      })

      return {
        code: 0,
        message: '数据库引用文件分批验证完成；这不等于整个云存储桶验证完成',
        data: {
          mode,
          dryRun: true,
          includeStorage,
          confirmText: CONFIRM_TEXT,
          protectedCollections: Array.from(PROTECTED_COLLECTIONS),
          targetCollections: collections,
          storageVerify: verifyResult,
          fileScan: scanResults,
          nextCall: verifyResult.hasMore ? {
            mode: 'verify-storage',
            dryRun: true,
            includeStorage: true,
            expectedEnvId,
            storageOffset: verifyResult.nextOffset,
            storageLimit,
            collections
          } : null
        }
      }
    }

    if (mode === 'all' && includeStorage && storageResult.hasMore) {
      return {
        code: -1,
        message: '云存储文件数量需要分批清理，已停止清空数据库。请先使用 mode: "storage" 分批清完云文件，再使用 mode: "database" 清数据库。',
        data: {
          mode,
          dryRun,
          includeStorage,
          confirmText: CONFIRM_TEXT,
          protectedCollections: Array.from(PROTECTED_COLLECTIONS),
          targetCollections: collections,
          storage: storageResult,
          fileScan: scanResults,
          collections: [],
          nextCall: {
            mode: 'storage',
            dryRun,
            includeStorage: true,
            expectedEnvId,
            confirm: CONFIRM_TEXT,
            storageOffset: storageResult.nextOffset,
            storageLimit,
            collections
          }
        }
      }
    }

    if (!dryRun && includeStorage && storageResult.failed > 0 && !ignoreStorageErrors) {
      return {
        code: -1,
        message: '云存储存在删除失败项，已停止清空数据库。确认这些文件可忽略后，可传 ignoreStorageErrors: true 继续。',
        data: {
          dryRun,
          includeStorage,
          confirmText: CONFIRM_TEXT,
          protectedCollections: Array.from(PROTECTED_COLLECTIONS),
          targetCollections: collections,
          storage: storageResult,
          fileScan: scanResults,
          collections: []
        }
      }
    }

    const collectionResults = []
    for (const collectionName of collections) {
      collectionResults.push(await clearCollection(
        collectionName,
        dryRun,
        mode === 'database' ? docDeleteLimit : 0
      ))
    }
    console.log('[done] temp clear completed')

    return {
      code: 0,
      message: dryRun ? '预演完成，未删除任何数据' : '清理完成',
      data: {
        dryRun,
        includeStorage,
        confirmText: CONFIRM_TEXT,
        protectedCollections: Array.from(PROTECTED_COLLECTIONS),
        targetCollections: collections,
        storage: storageResult,
        fileScan: scanResults,
        collections: collectionResults,
        notes: [
          'wdd-config 已写死保护，不会清空。',
          '数据库清理只删除文档，不删除集合，因此索引会保留。',
          '云存储清理会删除业务集合文档中扫描到的 cloud:// 文件；若存在数据库里已经没有记录的孤儿文件，可通过 extraFileIDs 手动补充。',
          'wx-server-sdk 当前不能枚举整个云存储桶，因此首次上线前如需确保云存储完全清空，还需要在微信云开发控制台检查并清空剩余文件。'
        ]
      }
    }
  } catch (err) {
    console.error('临时清理失败:', err)
    return {
      code: -1,
      message: '临时清理失败: ' + (err.message || String(err))
    }
  }
}
