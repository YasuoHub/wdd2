// 平台业务规则常量配置（云函数端）
// 与小程序端 miniprogram/utils/platformRules.js 保持同步

const PLATFORM_RULES = {
  // 平台抽成比例
  PLATFORM_FEE_RATE: 0.15,

  // 提现手续费率
  WITHDRAW_FEE_RATE: 0.01,

  // 最低提现门槛（元）
  WITHDRAW_MIN_AMOUNT: 2,

  // 单次提现最低金额（元）
  WITHDRAW_MIN_PER_REQUEST: 1,

  // 单次提现最高金额（元）
  WITHDRAW_MAX_PER_REQUEST: 5000,

  // 单日累计提现限额（元）—— 商户平台同步配置
  WITHDRAW_DAILY_LIMIT: 5000,

  // 商家转账失败最大重试次数
  MAX_TRANSFER_RETRY: 5,

  // 商家转账失败重试的指数退避分钟数（参考 wdd-payment 退款重试）
  TRANSFER_BACKOFF_MINUTES: [5, 10, 20, 40, 80],

  // 处理中状态多久未收到回调时触发主动查询（分钟）
  // 注意：wdd-auto-cancel/index.js 中也使用了相同的值，修改时请同步
  TRANSFER_QUERY_TIMEOUT_MINUTES: 1,

  // 最小悬赏金额（元）
  MIN_REWARD_AMOUNT: 1,

  // 最大悬赏金额（元）
  MAX_REWARD_AMOUNT: 500,

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
  PAYMENT_EXPIRE_MINUTES: 30,

  // 退款处理说明
  REFUND_POLICY: '任务取消后，悬赏金额将原路退回至您的支付账户',

  // 平台服务费说明
  FEE_POLICY: '平台对每单任务收取15%服务费，用于平台运营和技术维护'
}

// 金额计算工具函数
const MoneyUtils = {
  // 计算平台服务费
  calcPlatformFee(amount) {
    return Math.round(amount * PLATFORM_RULES.PLATFORM_FEE_RATE * 100) / 100
  },

  // 计算帮助者实际到账金额
  calcTakerIncome(amount) {
    const fee = this.calcPlatformFee(amount)
    return Math.round((amount - fee) * 100) / 100
  },

  // 计算提现手续费
  calcWithdrawFee(amount) {
    return Math.round(amount * PLATFORM_RULES.WITHDRAW_FEE_RATE * 100) / 100
  },

  // 计算提现实际到账金额
  calcWithdrawActual(amount) {
    const fee = this.calcWithdrawFee(amount)
    return Math.round((amount - fee) * 100) / 100
  },

  // 格式化金额显示
  formatAmount(amount) {
    return (Math.round(amount * 100) / 100).toFixed(2)
  },

  // 检查是否满足提现条件
  checkCanWithdraw(balance) {
    if (balance < PLATFORM_RULES.WITHDRAW_MIN_AMOUNT) {
      return {
        canWithdraw: false,
        reason: `余额满${PLATFORM_RULES.WITHDRAW_MIN_AMOUNT}元才可提现`
      }
    }
    return { canWithdraw: true, reason: '' }
  },

  // 检查提现金额是否合法
  checkWithdrawAmount(amount, balance) {
    if (amount <= 0) {
      return { valid: false, reason: '提现金额必须大于0' }
    }
    if (amount < PLATFORM_RULES.WITHDRAW_MIN_PER_REQUEST) {
      return { valid: false, reason: `单次提现最低${PLATFORM_RULES.WITHDRAW_MIN_PER_REQUEST}元` }
    }
    if (amount > PLATFORM_RULES.WITHDRAW_MAX_PER_REQUEST) {
      return { valid: false, reason: `单次提现最高${PLATFORM_RULES.WITHDRAW_MAX_PER_REQUEST}元` }
    }
    if (amount > balance) {
      return { valid: false, reason: '提现金额不能超过余额' }
    }
    return { valid: true, reason: '' }
  }
}

module.exports = {
  PLATFORM_RULES,
  MoneyUtils
}
