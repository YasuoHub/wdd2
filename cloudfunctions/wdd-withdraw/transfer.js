// 商家转账核心模块（新版接口，2025年升级后）
// 职责：
//   1. 加载商户私钥（启动期一次，缓存到模块作用域）
//   2. 生成 v3 接口的 Authorization 头（RSA-SHA256 签名）
//   3. 发起转账单（POST /v3/fund-app/mch-transfer/transfer-bills）
//   4. 查询转账单状态
//   5. 下载并缓存微信支付平台证书（用于回调验签）
//   6. 验证微信回调签名 + 解密回调密文
//
// 敏感信息从环境变量读取，绝不写在代码里：
//   - WECHATPAY_API_KEY  APIv3 密钥（32 位字符串，用于 AES-256-GCM 解密回调）
// 配置方式：
//   云开发控制台 → 云函数 → wdd-withdraw → 配置 → 环境变量

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const axios = require('axios')

const { WECHATPAY_CONFIG } = require('./wechatpayConfig')

// ========================================
// 凭据加载
// ========================================

let _privateKeyCache = null
function loadPrivateKey() {
  if (_privateKeyCache) return _privateKeyCache
  const keyPath = path.join(__dirname, WECHATPAY_CONFIG.PRIVATE_KEY_PATH)
  try {
    _privateKeyCache = fs.readFileSync(keyPath, 'utf8')
    return _privateKeyCache
  } catch (err) {
    throw new Error(`商户私钥读取失败: ${keyPath}, ${err.message}`)
  }
}

function getApiV3Key() {
  const key = process.env.WECHATPAY_API_KEY
  if (!key) {
    throw new Error('环境变量 WECHATPAY_API_KEY 未配置')
  }
  return key
}

// ========================================
// 签名
// ========================================

function genNonceStr() {
  return crypto.randomBytes(16).toString('hex')
}

// signString 格式：HTTP方法\nURL路径\n时间戳\n随机串\n请求体\n
function signRequest(method, urlPath, timestamp, nonceStr, body) {
  const privateKey = loadPrivateKey()
  const signString = `${method}\n${urlPath}\n${timestamp}\n${nonceStr}\n${body}\n`
  return crypto
    .createSign('RSA-SHA256')
    .update(signString)
    .sign(privateKey, 'base64')
}

function buildAuthHeader(method, urlPath, body) {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const nonceStr = genNonceStr()
  const signature = signRequest(method, urlPath, timestamp, nonceStr, body)

  return [
    `mchid="${WECHATPAY_CONFIG.MCH_ID}"`,
    `nonce_str="${nonceStr}"`,
    `signature="${signature}"`,
    `timestamp="${timestamp}"`,
    `serial_no="${WECHATPAY_CONFIG.SERIAL_NO}"`
  ].join(',')
}

// ========================================
// 商家转账接口（新版 - 单笔单据模式）
// ========================================

// 调用新版商家转账接口（单笔单据）
// 参数：
//   outBillNo: 商户转账单号
//   transferAmount: 转账金额（分）
//   openid: 收款用户openid
//   transferRemark?: 转账备注
// 返回：
//   { packageInfo, billId, state, createTime }
async function callTransferBill({ outBillNo, transferAmount, openid, transferRemark }) {
  const requestBody = {
    appid: WECHATPAY_CONFIG.APP_ID,
    out_bill_no: outBillNo,
    transfer_scene_id: WECHATPAY_CONFIG.TRANSFER_SCENE_ID,
    openid: openid,
    transfer_amount: transferAmount,
    transfer_remark: transferRemark || WECHATPAY_CONFIG.DEFAULT_TRANSFER_REMARK,
    transfer_scene_report_infos: WECHATPAY_CONFIG.TRANSFER_SCENE_REPORT_INFOS
  }

  // notify_url 可选：配置了才传，未配置则依靠轮询查询状态
  if (WECHATPAY_CONFIG.NOTIFY_URL) {
    requestBody.notify_url = WECHATPAY_CONFIG.NOTIFY_URL
  }

  const urlPath = WECHATPAY_CONFIG.TRANSFER_BILL_PATH
  const bodyStr = JSON.stringify(requestBody)
  const authHeader = buildAuthHeader('POST', urlPath, bodyStr)

  try {
    const response = await axios.post(
      `${WECHATPAY_CONFIG.API_HOST}${urlPath}`,
      bodyStr,
      {
        headers: {
          'Authorization': `WECHATPAY2-SHA256-RSA2048 ${authHeader}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 30000
      }
    )

    return {
      packageInfo: response.data.package_info,
      billId: response.data.bill_id,
      state: response.data.state,
      createTime: response.data.create_time
    }
  } catch (err) {
    if (err.response && err.response.data) {
      const errData = err.response.data
      const error = new Error(errData.message || '商家转账请求失败')
      error.errCode = errData.code
      error.errMessage = errData.message
      error.detail = errData.detail
      throw error
    }
    throw err
  }
}

// 通过商户单号查询转账单
// 返回 null：表示单据还未在微信侧建立（刚提交几秒内查询常见）
async function callQueryBillByOutNo(outBillNo) {
  const urlPath = `${WECHATPAY_CONFIG.TRANSFER_QUERY_BY_OUT_NO_PATH}/${outBillNo}`
  const authHeader = buildAuthHeader('GET', urlPath, '')

  try {
    const response = await axios.get(
      `${WECHATPAY_CONFIG.API_HOST}${urlPath}`,
      {
        headers: {
          'Authorization': `WECHATPAY2-SHA256-RSA2048 ${authHeader}`,
          'Accept': 'application/json'
        },
        timeout: 15000
      }
    )

    return {
      billId: response.data.bill_id,
      outBillNo: response.data.out_bill_no,
      state: response.data.state,
      transferAmount: response.data.transfer_amount || 0,
      openid: response.data.openid,
      failReason: response.data.fail_reason || '',
      createTime: response.data.create_time,
      updateTime: response.data.update_time,
      successTime: response.data.success_time || null
    }
  } catch (err) {
    if (err.response && err.response.data) {
      const errData = err.response.data
      // 单据还未建立（刚提交未到微信侧）→ 返回 null 让上层稍后重试
      if (errData.code === 'RESOURCE_NOT_EXISTS' || err.response.status === 404) {
        return null
      }
      const error = new Error(errData.message || '查询转账单失败')
      error.errCode = errData.code
      throw error
    }
    throw err
  }
}

// ========================================
// 平台证书下载与缓存（用于回调验签）
// ========================================

// 模块级缓存：{ [serial]: { publicKey, expiresAt(ms) } }
let _platformCertsCache = {}
let _platformCertsCachedAt = 0
const CERT_CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 缓存 6 小时

// 下载并解密平台证书列表
// 微信侧返回：{ data: [{ serial_no, effective_time, expire_time, encrypt_certificate: { algorithm, ciphertext, associated_data, nonce } }] }
async function fetchPlatformCerts() {
  const urlPath = '/v3/certificates'
  const authHeader = buildAuthHeader('GET', urlPath, '')

  const response = await axios.get(
    `${WECHATPAY_CONFIG.API_HOST}${urlPath}`,
    {
      headers: {
        'Authorization': `WECHATPAY2-SHA256-RSA2048 ${authHeader}`,
        'Accept': 'application/json'
      },
      timeout: 15000
    }
  )

  const certs = {}
  for (const item of response.data.data || []) {
    const certPem = decryptAesGcm(item.encrypt_certificate)
    certs[item.serial_no] = {
      publicKey: certPem,
      expiresAt: new Date(item.expire_time).getTime()
    }
  }

  return certs
}

// 获取平台证书（带缓存 + 失效时主动刷新）
async function loadPlatformCerts(forceRefresh = false) {
  const now = Date.now()
  if (
    !forceRefresh &&
    _platformCertsCachedAt &&
    now - _platformCertsCachedAt < CERT_CACHE_TTL_MS &&
    Object.keys(_platformCertsCache).length > 0
  ) {
    return _platformCertsCache
  }

  _platformCertsCache = await fetchPlatformCerts()
  _platformCertsCachedAt = now
  return _platformCertsCache
}

// ========================================
// 回调验签与解密
// ========================================

// 验证微信回调签名
// 参数：
//   headers: 回调请求的 HTTP 头部对象（key 不区分大小写）
//   rawBody: 回调请求的原始字符串报文（不能 JSON.parse 后再 stringify）
async function verifyCallbackSignature(headers, rawBody) {
  // 头部 key 兼容大小写
  const getHeader = (key) =>
    headers[key] ||
    headers[key.toLowerCase()] ||
    headers[key.charAt(0).toUpperCase() + key.slice(1).toLowerCase()] ||
    ''

  const timestamp = getHeader('Wechatpay-Timestamp')
  const nonce = getHeader('Wechatpay-Nonce')
  const signature = getHeader('Wechatpay-Signature')
  const serial = getHeader('Wechatpay-Serial')

  if (!timestamp || !nonce || !signature || !serial) {
    console.warn('回调缺少必要头部:', { timestamp, nonce, signature: !!signature, serial })
    return false
  }

  if (serial.startsWith('PUB_KEY_ID_')) {
    console.warn('回调使用平台公钥模式，当前实现仅支持证书模式，请在商户平台「平台公钥」配置切换为证书')
    return false
  }

  // 防重放：±5 分钟
  const driftSec = Math.abs(Math.floor(Date.now() / 1000) - parseInt(timestamp, 10))
  if (driftSec > 300) {
    console.warn(`回调时间戳偏移 ${driftSec}s 超出范围，疑似重放`)
    return false
  }

  // 取对应的平台证书
  let certs = await loadPlatformCerts()
  let cert = certs[serial]
  // 命中不到 → 强制刷新一次（可能是新证书）
  if (!cert) {
    certs = await loadPlatformCerts(true)
    cert = certs[serial]
  }
  if (!cert) {
    console.warn(`未找到序列号 ${serial} 对应的平台证书`)
    return false
  }

  const signString = `${timestamp}\n${nonce}\n${rawBody}\n`
  try {
    return crypto
      .createVerify('RSA-SHA256')
      .update(signString)
      .verify(cert.publicKey, signature, 'base64')
  } catch (err) {
    console.error('验签异常:', err)
    return false
  }
}

// AES-256-GCM 解密（用于解密回调密文 + 解密平台证书）
function decryptAesGcm({ ciphertext, associated_data: associatedData, nonce }) {
  if (!ciphertext || !nonce) {
    throw new Error('密文格式错误，缺少 ciphertext 或 nonce')
  }

  const apiV3Key = getApiV3Key()
  const ciphertextBuf = Buffer.from(ciphertext, 'base64')
  const authTag = ciphertextBuf.slice(-16)
  const data = ciphertextBuf.slice(0, -16)

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(apiV3Key, 'utf8'),
    Buffer.from(nonce, 'utf8')
  )
  decipher.setAuthTag(authTag)
  if (associatedData) {
    decipher.setAAD(Buffer.from(associatedData, 'utf8'))
  }

  const decrypted = Buffer.concat([decipher.update(data), decipher.final()])
  return decrypted.toString('utf8')
}

// 解密微信回调资源（v3 回调报文 resource 字段）
// 入参：{ algorithm: 'AEAD_AES_256_GCM', ciphertext, associated_data, nonce }
// 返回：解析后的 JSON 对象
function decryptCallbackResource(resource) {
  const plain = decryptAesGcm(resource)
  return JSON.parse(plain)
}

module.exports = {
  callTransferBill,
  callQueryBillByOutNo,
  verifyCallbackSignature,
  decryptCallbackResource,
  loadPlatformCerts // 供启动预热使用
}
