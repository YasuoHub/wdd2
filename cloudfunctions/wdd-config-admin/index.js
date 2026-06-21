// 超级管理员平台配置管理
// 只允许读写 wdd-config/platform 中经过白名单声明的配置项。

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const DEFAULT_CONFIG = {
  platform_fee_rate: 0.15,
  withdraw_fee_rate: 0.01,
  withdraw_min_amount: 0.01,
  withdraw_min_per_request: 1,
  withdraw_max_per_request: 5000,
  withdraw_approval_threshold: 100,
  withdraw_daily_limit: 100,
  withdraw_daily_times: 1,
  min_reward_amount: 1,
  max_reward_amount: 500,
  register_gift_balance: 3,
  points: {
    register: 100,
    invite: 50,
    signIn: {
      daily: [5, 10, 15, 20, 25, 30, 30]
    }
  },
  customer_service_openids: [],
  max_transfer_retry: 5,
  transfer_backoff_minutes: [5, 10, 20, 40, 80],
  transfer_query_timeout_minutes: 1
}

const EDITABLE_KEYS = [
  'platform_fee_rate',
  'withdraw_fee_rate',
  'withdraw_min_amount',
  'withdraw_min_per_request',
  'withdraw_max_per_request',
  'withdraw_approval_threshold',
  'withdraw_daily_limit',
  'withdraw_daily_times',
  'min_reward_amount',
  'max_reward_amount',
  'register_gift_balance',
  'points',
  'customer_service_openids',
  'max_transfer_retry',
  'transfer_backoff_minutes',
  'transfer_query_timeout_minutes'
]

function mergeConfig(config) {
  const points = config && config.points ? config.points : {}
  const signIn = points.signIn || {}
  return {
    ...DEFAULT_CONFIG,
    ...(config || {}),
    points: {
      register: points.register ?? DEFAULT_CONFIG.points.register,
      invite: points.invite ?? DEFAULT_CONFIG.points.invite,
      signIn: {
        daily: Array.isArray(signIn.daily) ? signIn.daily : DEFAULT_CONFIG.points.signIn.daily
      }
    },
    customer_service_openids: Array.isArray(config && config.customer_service_openids)
      ? config.customer_service_openids
      : DEFAULT_CONFIG.customer_service_openids,
    transfer_backoff_minutes: Array.isArray(config && config.transfer_backoff_minutes)
      ? config.transfer_backoff_minutes
      : DEFAULT_CONFIG.transfer_backoff_minutes
  }
}

function pickEditableConfig(config) {
  const merged = mergeConfig(config)
  return EDITABLE_KEYS.reduce((result, key) => {
    result[key] = merged[key]
    return result
  }, {})
}

async function loadRawConfig() {
  const res = await db.collection('wdd-config').doc('platform').get().catch(() => null)
  return res && res.data ? res.data : null
}

async function ensureSuperAdmin(openid) {
  const config = await loadRawConfig()
  const superAdminOpenids = config && Array.isArray(config.super_admin_openids)
    ? config.super_admin_openids
    : []

  if (!openid || !superAdminOpenids.includes(openid)) {
    const err = new Error('您没有超级管理员权限')
    err.code = 'NO_PERMISSION'
    throw err
  }

  return config
}

function toFiniteNumber(value, key) {
  const num = Number(value)
  if (!Number.isFinite(num)) {
    throw new Error(`${key} 必须是有效数字`)
  }
  return Math.round(num * 10000) / 10000
}

function toInteger(value, key) {
  const num = Number(value)
  if (!Number.isInteger(num)) {
    throw new Error(`${key} 必须是整数`)
  }
  return num
}

function normalizeStringArray(value, key) {
  if (!Array.isArray(value)) {
    throw new Error(`${key} 必须是数组`)
  }
  return Array.from(new Set(value.map(item => String(item || '').trim()).filter(Boolean)))
}

function normalizeNumberArray(value, key) {
  if (!Array.isArray(value)) {
    throw new Error(`${key} 必须是数组`)
  }
  const result = value.map((item, index) => {
    const num = Number(item)
    if (!Number.isInteger(num) || num <= 0) {
      throw new Error(`${key} 第 ${index + 1} 项必须是正整数`)
    }
    return num
  })
  if (result.length === 0) {
    throw new Error(`${key} 不能为空`)
  }
  return result
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('配置数据格式不正确')
  }

  const unknownKeys = Object.keys(payload).filter(key => !EDITABLE_KEYS.includes(key))
  if (unknownKeys.length > 0) {
    throw new Error(`存在不允许修改的配置项：${unknownKeys.join(', ')}`)
  }

  const next = {}

  next.platform_fee_rate = toFiniteNumber(payload.platform_fee_rate, '平台服务费率')
  next.withdraw_fee_rate = toFiniteNumber(payload.withdraw_fee_rate, '提现手续费率')
  next.withdraw_min_amount = toFiniteNumber(payload.withdraw_min_amount, '最低提现门槛')
  next.withdraw_min_per_request = toFiniteNumber(payload.withdraw_min_per_request, '单次提现最低金额')
  next.withdraw_max_per_request = toFiniteNumber(payload.withdraw_max_per_request, '单次提现最高金额')
  next.withdraw_approval_threshold = toFiniteNumber(payload.withdraw_approval_threshold, '提现审批阈值')
  next.withdraw_daily_limit = toFiniteNumber(payload.withdraw_daily_limit, '单日提现金额上限')
  next.withdraw_daily_times = toInteger(payload.withdraw_daily_times, '单日提现次数上限')
  next.min_reward_amount = toFiniteNumber(payload.min_reward_amount, '最小悬赏金额')
  next.max_reward_amount = toFiniteNumber(payload.max_reward_amount, '最大悬赏金额')
  next.register_gift_balance = toFiniteNumber(payload.register_gift_balance, '新用户注册赠送余额')
  next.max_transfer_retry = toInteger(payload.max_transfer_retry, '最大转账重试次数')
  next.transfer_query_timeout_minutes = toInteger(payload.transfer_query_timeout_minutes, '转账查询超时分钟')

  const nonNegativeKeys = [
    'withdraw_min_amount',
    'withdraw_min_per_request',
    'withdraw_max_per_request',
    'withdraw_approval_threshold',
    'withdraw_daily_limit',
    'min_reward_amount',
    'max_reward_amount',
    'register_gift_balance'
  ]

  if (next.platform_fee_rate < 0 || next.platform_fee_rate > 1) {
    throw new Error('平台服务费率必须在 0 到 1 之间')
  }
  if (next.withdraw_fee_rate < 0 || next.withdraw_fee_rate > 1) {
    throw new Error('提现手续费率必须在 0 到 1 之间')
  }
  nonNegativeKeys.forEach(key => {
    if (next[key] < 0) throw new Error(`${key} 不能小于 0`)
  })
  if (next.min_reward_amount > next.max_reward_amount) {
    throw new Error('最小悬赏金额不能大于最大悬赏金额')
  }
  if (next.withdraw_min_per_request > next.withdraw_max_per_request) {
    throw new Error('单次提现最低金额不能大于单次提现最高金额')
  }
  if (next.withdraw_daily_times <= 0) {
    throw new Error('单日提现次数上限必须大于 0')
  }
  if (next.max_transfer_retry < 0) {
    throw new Error('最大转账重试次数不能小于 0')
  }
  if (next.transfer_query_timeout_minutes <= 0) {
    throw new Error('转账查询超时分钟必须大于 0')
  }

  const points = payload.points || {}
  const signIn = points.signIn || {}
  next.points = {
    register: toInteger(points.register, '注册奖励积分'),
    invite: toInteger(points.invite, '邀请奖励积分'),
    signIn: {
      daily: normalizeNumberArray(signIn.daily, '连续签到积分')
    }
  }
  if (next.points.register < 0 || next.points.invite < 0) {
    throw new Error('积分奖励不能小于 0')
  }

  next.customer_service_openids = normalizeStringArray(payload.customer_service_openids || [], '客服 OpenID 白名单')
  next.transfer_backoff_minutes = normalizeNumberArray(payload.transfer_backoff_minutes, '转账重试间隔')

  return next
}

exports.main = async (event, context) => {
  const { action, config } = event || {}
  const { OPENID } = cloud.getWXContext()

  try {
    const rawConfig = await ensureSuperAdmin(OPENID)

    if (action === 'getConfigForAdmin') {
      return {
        code: 0,
        message: 'success',
        data: pickEditableConfig(rawConfig)
      }
    }

    if (action === 'updateConfig') {
      const nextConfig = validatePayload(config)
      const { _id, ...persistedConfig } = rawConfig || {}
      await db.collection('wdd-config').doc('platform').set({
        data: {
          ...persistedConfig,
          ...nextConfig,
          update_time: db.serverDate(),
          updated_by: OPENID
        }
      })

      return {
        code: 0,
        message: '保存成功',
        data: pickEditableConfig(nextConfig)
      }
    }

    return { code: -1, message: '未知操作' }
  } catch (err) {
    console.error('管理平台配置失败:', err)
    return {
      code: err.code === 'NO_PERMISSION' ? 403 : -1,
      message: err.message || '操作失败'
    }
  }
}
