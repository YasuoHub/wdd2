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
  withdraw_min_amount: 0.01,
  withdraw_min_per_request: 1,
  withdraw_max_per_request: 5000,
  withdraw_approval_threshold: 100,
  min_reward_amount: 1,
  max_reward_amount: 500,
  withdraw_daily_limit: 100,
  withdraw_daily_times: 1,
  register_gift_deduction: 3,
  points: {
    register: 100,
    invite: 50,
    signIn: {
      daily: [5, 10, 15, 20, 25, 30, 30]
    }
  }
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
  'withdraw_daily_times',
  'register_gift_deduction',
  'points'
]

function pickPublicConfig(config) {
  const points = config && config.points ? config.points : {}
  const signIn = points.signIn || {}
  const merged = {
    ...DEFAULT_CONFIG,
    ...(config || {}),
    register_gift_deduction: config
      ? (config.register_gift_deduction ?? config.register_gift_balance ?? DEFAULT_CONFIG.register_gift_deduction)
      : DEFAULT_CONFIG.register_gift_deduction,
    points: {
      register: points.register ?? DEFAULT_CONFIG.points.register,
      invite: points.invite ?? DEFAULT_CONFIG.points.invite,
      signIn: {
        daily: Array.isArray(signIn.daily) ? signIn.daily : DEFAULT_CONFIG.points.signIn.daily
      }
    }
  }
  return PUBLIC_CONFIG_KEYS.reduce((result, key) => {
    result[key] = merged[key]
    return result
  }, {})
}

function getRoleFlags(config, openid) {
  const csOpenids = config ? (config.customer_service_openids || []) : []
  const saOpenids = config ? (config.super_admin_openids || []) : []
  return {
    isCustomerService: openid ? csOpenids.includes(openid) : false,
    isSuperAdmin: openid ? saOpenids.includes(openid) : false
  }
}

exports.main = async (event, context) => {
  const { action } = event
  const wxContext = cloud.getWXContext()
  const OPENID = wxContext.OPENID

  try {
    if (action === 'getRoleFlags') {
      const configRes = await db.collection('wdd-config').doc('platform').get().catch(() => null)
      const config = configRes && configRes.data ? configRes.data : null
      return {
        code: 0,
        data: getRoleFlags(config, OPENID),
        message: 'success'
      }
    }

    if (action) {
      return { code: -1, message: '未知操作' }
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
