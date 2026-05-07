// 平台业务规则常量配置
// 所有涉及金额、费率、门槛的常量统一在此管理
//
// 核心费率（如 platform_fee_rate）支持从数据库动态加载，
// 默认值为代码中的硬编码。如需修改全局费率，
// 请在云数据库 wdd-config 集合中调整，无需改动此文件。

// 内部可变配置（可被数据库配置覆盖）
let _PLATFORM_FEE_RATE = 0.15
let _WITHDRAW_MIN_AMOUNT = 2
let _WITHDRAW_MIN_PER_REQUEST = 1
let _WITHDRAW_MAX_PER_REQUEST = 5000
let _MIN_REWARD_AMOUNT = 0.1
let _MAX_REWARD_AMOUNT = 500

// 动态设置平台配置（由 app.js 启动时从数据库加载后调用）
function setPlatformConfig(config) {
  if (!config) return
  if (typeof config.platform_fee_rate === 'number') {
    _PLATFORM_FEE_RATE = config.platform_fee_rate
  }
  if (typeof config.withdraw_min_amount === 'number') {
    _WITHDRAW_MIN_AMOUNT = config.withdraw_min_amount
  }
  if (typeof config.withdraw_min_per_request === 'number') {
    _WITHDRAW_MIN_PER_REQUEST = config.withdraw_min_per_request
  }
  if (typeof config.withdraw_max_per_request === 'number') {
    _WITHDRAW_MAX_PER_REQUEST = config.withdraw_max_per_request
  }
  if (typeof config.min_reward_amount === 'number') {
    _MIN_REWARD_AMOUNT = config.min_reward_amount
  }
  if (typeof config.max_reward_amount === 'number') {
    _MAX_REWARD_AMOUNT = config.max_reward_amount
  }
}

const PLATFORM_RULES = {
  // 平台抽成比例（从悬赏金额中扣除）
  // 默认值 15%，可被数据库配置覆盖
  get PLATFORM_FEE_RATE() {
    return _PLATFORM_FEE_RATE
  },

  // 提现手续费率
  // 例如：提现100元，手续费1元，实际到账99元
  WITHDRAW_FEE_RATE: 0.01,

  // 最低提现门槛（元）
  // 余额满此金额才可申请提现
  get WITHDRAW_MIN_AMOUNT() {
    return _WITHDRAW_MIN_AMOUNT
  },

  // 单次提现最低金额（元）
  get WITHDRAW_MIN_PER_REQUEST() {
    return _WITHDRAW_MIN_PER_REQUEST
  },

  // 单次提现最高金额（元）
  get WITHDRAW_MAX_PER_REQUEST() {
    return _WITHDRAW_MAX_PER_REQUEST
  },

  // 最小悬赏金额（元）
  // 发布任务时，悬赏金额不能低于此值
  get MIN_REWARD_AMOUNT() {
    return _MIN_REWARD_AMOUNT
  },

  // 最大悬赏金额（元）
  get MAX_REWARD_AMOUNT() {
    return _MAX_REWARD_AMOUNT
  },

  // 任务默认有效期（分钟）
  DEFAULT_EXPIRE_MINUTES: 60,

  // 任务有效期选项（分钟）
  EXPIRE_OPTIONS: [
    { value: 30, label: '30分钟', recommended: false },
    { value: 60, label: '1小时', recommended: true },
    { value: 120, label: '2小时', recommended: false },
    { value: 240, label: '4小时', recommended: false },
    { value: 720, label: '12小时', recommended: false },
    { value: 1440, label: '24小时', recommended: false }
  ],

  // 支付订单超时时间（分钟）
  // 创建支付订单后，需在此时间内完成支付
  PAYMENT_EXPIRE_MINUTES: 30,

  // 退款处理说明
  REFUND_POLICY: '任务取消后，悬赏金额将原路退回至您的支付账户',

  // 平台服务费说明（随费率动态变化）
  get FEE_POLICY() {
    return `平台对每单任务收取${Math.round(_PLATFORM_FEE_RATE * 100)}%服务费，用于平台运营和技术维护`
  }
}

// 金额计算工具函数
const MoneyUtils = {
  // 计算平台服务费
  // amount: 悬赏金额（元）
  // return: 平台服务费（元，保留2位小数）
  calcPlatformFee(amount) {
    return Math.round(amount * _PLATFORM_FEE_RATE * 100) / 100
  },

  // 计算帮助者实际到账金额
  // amount: 悬赏金额（元）
  // return: 帮助者到账金额（元，保留2位小数）
  calcTakerIncome(amount) {
    const fee = this.calcPlatformFee(amount)
    return Math.round((amount - fee) * 100) / 100
  },

  // 计算提现手续费
  // amount: 提现金额（元）
  // return: 手续费（元，保留2位小数）
  calcWithdrawFee(amount) {
    return Math.round(amount * PLATFORM_RULES.WITHDRAW_FEE_RATE * 100) / 100
  },

  // 计算提现实际到账金额
  // amount: 提现金额（元）
  // return: 实际到账金额（元，保留2位小数）
  calcWithdrawActual(amount) {
    const fee = this.calcWithdrawFee(amount)
    return Math.round((amount - fee) * 100) / 100
  },

  // 格式化金额显示（保留2位小数）
  formatAmount(amount) {
    return (Math.round(amount * 100) / 100).toFixed(2)
  },

  // 检查是否满足提现条件
  // balance: 当前余额（元）
  // return: { canWithdraw: boolean, reason: string }
  checkCanWithdraw(balance) {
    if (balance < _WITHDRAW_MIN_AMOUNT) {
      return {
        canWithdraw: false,
        reason: `余额满${_WITHDRAW_MIN_AMOUNT}元才可提现`
      }
    }
    return { canWithdraw: true, reason: '' }
  },

  // 检查提现金额是否合法
  // amount: 提现金额（元）
  // balance: 当前余额（元）
  // return: { valid: boolean, reason: string }
  checkWithdrawAmount(amount, balance) {
    if (amount <= 0) {
      return { valid: false, reason: '提现金额必须大于0' }
    }
    if (amount < _WITHDRAW_MIN_PER_REQUEST) {
      return { valid: false, reason: `单次提现最低${_WITHDRAW_MIN_PER_REQUEST}元` }
    }
    if (amount > _WITHDRAW_MAX_PER_REQUEST) {
      return { valid: false, reason: `单次提现最高${_WITHDRAW_MAX_PER_REQUEST}元` }
    }
    if (amount > balance) {
      return { valid: false, reason: '提现金额不能超过余额' }
    }
    return { valid: true, reason: '' }
  }
}

module.exports = {
  PLATFORM_RULES,
  MoneyUtils,
  setPlatformConfig
}
