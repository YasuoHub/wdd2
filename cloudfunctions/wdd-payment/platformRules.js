// 平台业务规则配置（支持从 wdd-config 动态加载，带 5 分钟本地缓存）

const cloud = require('wx-server-sdk')

const DEFAULT_RULES = {
  PLATFORM_FEE_RATE: 0.15,
  WITHDRAW_FEE_RATE: 0.01,
  WITHDRAW_MIN_AMOUNT: 2,
  WITHDRAW_MIN_PER_REQUEST: 1,
  WITHDRAW_MAX_PER_REQUEST: 5000,
  WITHDRAW_DAILY_LIMIT: 5000,
  MAX_TRANSFER_RETRY: 5,
  TRANSFER_BACKOFF_MINUTES: [5, 10, 20, 40, 80],
  TRANSFER_QUERY_TIMEOUT_MINUTES: 1,
  MIN_REWARD_AMOUNT: 0.1,
  MAX_REWARD_AMOUNT: 500,
  DEFAULT_EXPIRE_MINUTES: 30,
  PAYMENT_EXPIRE_MINUTES: 30,
  REFUND_POLICY: '任务取消后，悬赏金额将原路退回至您的支付账户',
  FEE_POLICY: '平台对每单任务收取15%服务费，用于平台运营和技术维护'
}

let _cachedRules = null
let _cacheExpireAt = 0

async function loadFromDb() {
  const now = Date.now()
  if (_cachedRules && _cacheExpireAt > now) {
    return _cachedRules
  }

  try {
    const db = cloud.database()
    const res = await db.collection('wdd-config').doc('platform').get()
    const cfg = res.data || {}
    _cachedRules = {
      PLATFORM_FEE_RATE: cfg.platform_fee_rate ?? DEFAULT_RULES.PLATFORM_FEE_RATE,
      WITHDRAW_FEE_RATE: cfg.withdraw_fee_rate ?? DEFAULT_RULES.WITHDRAW_FEE_RATE,
      WITHDRAW_MIN_AMOUNT: cfg.withdraw_min_amount ?? DEFAULT_RULES.WITHDRAW_MIN_AMOUNT,
      WITHDRAW_MIN_PER_REQUEST: cfg.withdraw_min_per_request ?? DEFAULT_RULES.WITHDRAW_MIN_PER_REQUEST,
      WITHDRAW_MAX_PER_REQUEST: cfg.withdraw_max_per_request ?? DEFAULT_RULES.WITHDRAW_MAX_PER_REQUEST,
      WITHDRAW_DAILY_LIMIT: cfg.withdraw_daily_limit ?? DEFAULT_RULES.WITHDRAW_DAILY_LIMIT,
      MIN_REWARD_AMOUNT: cfg.min_reward_amount ?? DEFAULT_RULES.MIN_REWARD_AMOUNT,
      MAX_REWARD_AMOUNT: cfg.max_reward_amount ?? DEFAULT_RULES.MAX_REWARD_AMOUNT,
      DEFAULT_EXPIRE_MINUTES: DEFAULT_RULES.DEFAULT_EXPIRE_MINUTES,
      PAYMENT_EXPIRE_MINUTES: DEFAULT_RULES.PAYMENT_EXPIRE_MINUTES,
      MAX_TRANSFER_RETRY: cfg.max_transfer_retry ?? DEFAULT_RULES.MAX_TRANSFER_RETRY,
      TRANSFER_BACKOFF_MINUTES: cfg.transfer_backoff_minutes ?? DEFAULT_RULES.TRANSFER_BACKOFF_MINUTES,
      TRANSFER_QUERY_TIMEOUT_MINUTES: cfg.transfer_query_timeout_minutes ?? DEFAULT_RULES.TRANSFER_QUERY_TIMEOUT_MINUTES,
      REFUND_POLICY: DEFAULT_RULES.REFUND_POLICY,
      FEE_POLICY: `平台对每单任务收取${Math.round((cfg.platform_fee_rate ?? DEFAULT_RULES.PLATFORM_FEE_RATE) * 100)}%服务费，用于平台运营和技术维护`
    }
    _cacheExpireAt = now + 5 * 60 * 1000
    return _cachedRules
  } catch (e) {
    return DEFAULT_RULES
  }
}

function clearCache() {
  _cachedRules = null
  _cacheExpireAt = 0
}

function createMoneyUtils(rules) {
  return {
    calcPlatformFee(amount) {
      return Math.round(amount * rules.PLATFORM_FEE_RATE * 100) / 100
    },
    calcTakerIncome(amount) {
      const fee = this.calcPlatformFee(amount)
      return Math.round((amount - fee) * 100) / 100
    },
    calcWithdrawFee(amount) {
      return Math.round(amount * rules.WITHDRAW_FEE_RATE * 100) / 100
    },
    calcWithdrawActual(amount) {
      const fee = this.calcWithdrawFee(amount)
      return Math.round((amount - fee) * 100) / 100
    },
    formatAmount(amount) {
      return (Math.round(amount * 100) / 100).toFixed(2)
    },
    checkCanWithdraw(balance) {
      if (balance < rules.WITHDRAW_MIN_AMOUNT) {
        return { canWithdraw: false, reason: `余额满${rules.WITHDRAW_MIN_AMOUNT}元才可提现` }
      }
      return { canWithdraw: true, reason: '' }
    },
    checkWithdrawAmount(amount, balance) {
      if (amount <= 0) return { valid: false, reason: '提现金额必须大于0' }
      if (amount < rules.WITHDRAW_MIN_PER_REQUEST) return { valid: false, reason: `单次提现最低${rules.WITHDRAW_MIN_PER_REQUEST}元` }
      if (amount > rules.WITHDRAW_MAX_PER_REQUEST) return { valid: false, reason: `单次提现最高${rules.WITHDRAW_MAX_PER_REQUEST}元` }
      if (amount > balance) return { valid: false, reason: '提现金额不能超过余额' }
      return { valid: true, reason: '' }
    }
  }
}

module.exports = {
  DEFAULT_RULES,
  loadFromDb,
  clearCache,
  createMoneyUtils
}
