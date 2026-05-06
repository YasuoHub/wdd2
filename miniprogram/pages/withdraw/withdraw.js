// 提现页面
const app = getApp()
const { PLATFORM_RULES, MoneyUtils } = require('../../utils/platformRules')

Page({
  data: {
    // 用户余额
    balance: 0,

    // 提现金额
    withdrawAmount: '',

    // 计算值
    withdrawFee: '0.00',
    actualAmount: '0.00',

    // 平台规则
    withdrawMinAmount: PLATFORM_RULES.WITHDRAW_MIN_AMOUNT,
    withdrawFeeRate: Math.round(PLATFORM_RULES.WITHDRAW_FEE_RATE * 100),
    withdrawMinPerRequest: PLATFORM_RULES.WITHDRAW_MIN_PER_REQUEST,
    withdrawMaxPerRequest: PLATFORM_RULES.WITHDRAW_MAX_PER_REQUEST,

    // 状态
    canSubmit: false,
    isSubmitting: false,

    // 错误提示
    errorTip: ''
  },

  onLoad() {
    this.loadBalance()
  },

  onShow() {
    this.loadBalance()
  },

  // 加载余额
  async loadBalance() {
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-notify',
        data: { action: 'getUserInfo' }
      })

      if (result.code === 0 && result.data.userInfo) {
        const balance = result.data.userInfo.balance || 0
        this.setData({ balance })
      }
    } catch (err) {
      console.error('加载余额失败:', err)
    }
  },

  // 输入提现金额
  onAmountInput(e) {
    let value = e.detail.value

    // 只允许数字和小数点
    value = value.replace(/[^0-9.]/g, '')

    // 确保只有一个小数点
    const parts = value.split('.')
    if (parts.length > 2) {
      value = parts[0] + '.' + parts.slice(1).join('')
    }

    // 限制小数位数为2位
    if (parts[1] && parts[1].length > 2) {
      value = parts[0] + '.' + parts[1].slice(0, 2)
    }

    // 限制最大金额
    const numValue = parseFloat(value) || 0
    if (numValue > this.data.balance) {
      value = String(this.data.balance)
    }
    if (numValue > PLATFORM_RULES.WITHDRAW_MAX_PER_REQUEST) {
      value = String(PLATFORM_RULES.WITHDRAW_MAX_PER_REQUEST)
    }

    this.setData({ withdrawAmount: value })
    this.calculateFee()
    this.checkCanSubmit()
  },

  // 全部提现
  withdrawAll() {
    const maxAmount = Math.min(
      this.data.balance,
      PLATFORM_RULES.WITHDRAW_MAX_PER_REQUEST
    )
    const amount = MoneyUtils.formatAmount(maxAmount)
    this.setData({ withdrawAmount: amount })
    this.calculateFee()
    this.checkCanSubmit()
  },

  // 计算手续费和到账金额
  calculateFee() {
    const amount = parseFloat(this.data.withdrawAmount) || 0
    const fee = MoneyUtils.calcWithdrawFee(amount)
    const actual = MoneyUtils.calcWithdrawActual(amount)

    this.setData({
      withdrawFee: MoneyUtils.formatAmount(fee),
      actualAmount: MoneyUtils.formatAmount(actual)
    })
  },

  // 检查是否可以提交
  checkCanSubmit() {
    const amount = parseFloat(this.data.withdrawAmount) || 0
    const check = MoneyUtils.checkWithdrawAmount(amount, this.data.balance)

    this.setData({
      canSubmit: check.valid,
      errorTip: check.valid ? '' : check.reason
    })
  },

  // 提交提现申请
  async handleSubmit() {
    if (!this.data.canSubmit || this.data.isSubmitting) return

    const amount = parseFloat(this.data.withdrawAmount)

    // 二次确认
    wx.showModal({
      title: '确认提现',
      content: `提现金额：¥${amount}\n手续费：¥${this.data.withdrawFee}\n实际到账：¥${this.data.actualAmount}`,
      confirmText: '确认提现',
      confirmColor: '#5DB8E6',
      success: async (res) => {
        if (res.confirm) {
          await this.doWithdraw(amount)
        }
      }
    })
  },

  // 执行提现
  async doWithdraw(amount) {
    this.setData({ isSubmitting: true })
    wx.showLoading({ title: '提交中...' })

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-withdraw',
        data: {
          action: 'apply',
          amount: amount
        }
      })

      wx.hideLoading()
      this.setData({ isSubmitting: false })

      if (result.code === 0) {
        wx.showModal({
          title: '提现申请已提交',
          content: '您的提现申请已提交，我们将在1-3个工作日内处理，请留意到账通知。',
          showCancel: false,
          success: () => {
            wx.navigateBack()
          }
        })
      } else {
        wx.showToast({
          title: result.message || '提现失败',
          icon: 'none',
          duration: 3000
        })
      }
    } catch (err) {
      wx.hideLoading()
      this.setData({ isSubmitting: false })
      wx.showToast({
        title: err.message || '提现失败',
        icon: 'none',
        duration: 3000
      })
    }
  }
})
