// 获取平台配置云函数
// 读取 wdd-config 集合中的平台全局配置
// 如果数据库中不存在，返回硬编码默认值

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

// 默认配置（与代码中的硬编码保持一致）
const DEFAULT_CONFIG = {
  platform_fee_rate: 0.15,
  withdraw_fee_rate: 0.01,
  withdraw_min_amount: 2,
  withdraw_min_per_request: 1,
  withdraw_max_per_request: 5000,
  withdraw_approval_threshold: 100,
  min_reward_amount: 1,
  max_reward_amount: 500,
  withdraw_daily_limit: 5000,
  withdraw_daily_times: 3
}

const PUBLIC_CONFIG_KEYS = [
  'platform_fee_rate',
  'withdraw_fee_rate',
  'withdraw_min_amount',
  'withdraw_min_per_request',
  'withdraw_max_per_request',
  'withdraw_approval_threshold',
  'min_reward_amount',
  'max_reward_amount',
  'withdraw_daily_limit',
  'withdraw_daily_times'
]

function pickPublicConfig(config) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...(config || {})
  }
  return PUBLIC_CONFIG_KEYS.reduce((result, key) => {
    result[key] = merged[key]
    return result
  }, {})
}

exports.main = async (event, context) => {
  const { action } = event
  const wxContext = cloud.getWXContext()
  const OPENID = wxContext.OPENID

  try {
    // isCustomerService  action
    if (action === 'isCustomerService') {
      const configRes = await db.collection('wdd-config').doc('platform').get().catch(() => null)
      const csOpenids = configRes && configRes.data ? (configRes.data.customer_service_openids || []) : []
      return {
        code: 0,
        data: { isCustomerService: OPENID ? csOpenids.includes(OPENID) : false },
        message: 'success'
      }
    }

    // isSuperAdmin action
    if (action === 'isSuperAdmin') {
      const configRes = await db.collection('wdd-config').doc('platform').get().catch(() => null)
      const saOpenids = configRes && configRes.data ? (configRes.data.super_admin_openids || []) : []
      return {
        code: 0,
        data: { isSuperAdmin: OPENID ? saOpenids.includes(OPENID) : false },
        message: 'success'
      }
    }

    // 默认：返回平台配置
    let config = null

    try {
      const res = await db.collection('wdd-config').doc('platform').get()
      config = res.data
    } catch (dbErr) {
      console.warn('wdd-config/platform 不存在，使用默认配置:', dbErr.message)
      config = null
    }

    const result = pickPublicConfig(config)

    return {
      code: 0,
      data: result,
      message: 'success'
    }
  } catch (err) {
    console.error('获取平台配置失败:', err)
    return {
      code: -1,
      message: err.message,
      data: DEFAULT_CONFIG
    }
  }
}
