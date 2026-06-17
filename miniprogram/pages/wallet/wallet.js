// 钱包/余额页面
const app = getApp()
const { PLATFORM_RULES, MoneyUtils } = require('../../utils/platformRules')

Page({
  data: {
    // 余额信息
    balance: 0,
    frozenBalance: 0,
    availableBalance: 0,
    totalEarned: 0,
    totalWithdrawn: 0,
    totalPaid: 0,

    // 平台规则
    withdrawMinAmount: PLATFORM_RULES.WITHDRAW_MIN_AMOUNT,
    withdrawFeeRate: Math.round(PLATFORM_RULES.WITHDRAW_FEE_RATE * 100),
    withdrawMinPerRequest: PLATFORM_RULES.WITHDRAW_MIN_PER_REQUEST,
    withdrawMaxPerRequest: PLATFORM_RULES.WITHDRAW_MAX_PER_REQUEST,
    withdrawApprovalThreshold: PLATFORM_RULES.WITHDRAW_APPROVAL_THRESHOLD,
    withdrawDailyLimit: PLATFORM_RULES.WITHDRAW_DAILY_LIMIT,
    withdrawDailyTimes: PLATFORM_RULES.WITHDRAW_DAILY_TIMES,

    // 提现条件
    canWithdraw: false,
    withdrawTip: '',

    // 账单列表
    records: [],
    loading: false,
    hasMore: true,
    page: 0,
    pageSize: 20,

    // 申请记录
    applications: [],
    appLoading: false,
    appHasMore: true,
    appPage: 0,
    appPageSize: 20,

    // 申请提现弹窗
    showApplyModal: false,
    applyAmount: '',
    applyFee: '0.00',
    applyActual: '0.00',
    canSubmitApply: false,
    applyErrorTip: '',
    isSubmitting: false,
    needApproval: false,

    // 提现规则弹窗
    showRulesModal: false,

    // 用户信息
    userInfo: {}
  },

  onLoad() {
    this.loadUserInfo()
    this.loadBalance()
    this.loadRecords()
    this.loadApplications(true)
  },

  onShow() {
    this.applyPlatformConfig()
    this.loadBalance()
    this.loadRecords(true)
    this.loadApplications(true)
  },

  // 应用平台配置到页面数据（从数据库动态加载的费率/阈值）
  applyPlatformConfig() {
    const config = app.globalData.platformConfig
    if (config) {
      this.setData({
        withdrawMinAmount: PLATFORM_RULES.WITHDRAW_MIN_AMOUNT,
        withdrawFeeRate: Math.round(PLATFORM_RULES.WITHDRAW_FEE_RATE * 100),
        withdrawApprovalThreshold: PLATFORM_RULES.WITHDRAW_APPROVAL_THRESHOLD,
        withdrawDailyLimit: PLATFORM_RULES.WITHDRAW_DAILY_LIMIT,
        withdrawDailyTimes: PLATFORM_RULES.WITHDRAW_DAILY_TIMES
      })
    }
  },

  // 加载用户信息
  loadUserInfo() {
    const userInfo = app.getUserInfo()
    if (userInfo) {
      this.setData({ userInfo })
    }
  },

  // 加载余额信息
  async loadBalance() {
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-notify',
        data: { action: 'getUserInfo' }
      })

      if (result.code === 0 && result.data.userInfo) {
        const userInfo = result.data.userInfo
        const balance = userInfo.balance || 0
        const frozenBalance = userInfo.frozen_balance || 0
        const availableBalance = balance - frozenBalance

        // 检查提现条件（基于可用余额）
        const withdrawCheck = MoneyUtils.checkCanWithdraw(availableBalance)

        this.setData({
          balance: balance,
          frozenBalance: frozenBalance,
          availableBalance: availableBalance,
          totalEarned: userInfo.total_earned || 0,
          totalWithdrawn: userInfo.total_withdrawn || 0,
          totalPaid: userInfo.total_paid || 0,
          canWithdraw: withdrawCheck.canWithdraw,
          withdrawTip: withdrawCheck.reason,
          userInfo: userInfo
        })

        // 更新全局数据
        app.updateUserInfo(userInfo)
      }
    } catch (err) {
      console.error('加载余额失败:', err)
    }
  },

  // 加载申请记录
  async loadApplications(reset = false) {
    if (this.data.appLoading) return

    const page = reset ? 0 : this.data.appPage

    this.setData({ appLoading: true })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-withdraw-approval',
        data: {
          action: 'getMyApplications',
          page: page,
          pageSize: this.data.appPageSize
        }
      })
      if (result.code === 0) {
        const now = new Date()
        const newApplications = (result.data.records || []).map(item => {
          const expireTime = item.expireTime ? new Date(item.expireTime.replace(/-/g, '/')) : null
          const isExpired = item.status === 'approved' && item.withdrawStatus === 'not_withdrawn' && expireTime && expireTime < now
          let expireCountdown = ''
          if (item.status === 'approved' && item.withdrawStatus === 'not_withdrawn' && expireTime && !isExpired) {
            const diffMs = expireTime - now
            if (diffMs > 0) {
              const days = Math.floor(diffMs / (1000 * 60 * 60 * 24))
              const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))
              expireCountdown = days > 0 ? `${days}天${hours}小时` : `${hours}小时`
            }
          }
          return {
            ...item,
            expireTimeStr: item.expireTime || '',
            isExpired,
            expireCountdown
          }
        })
        this.setData({
          applications: reset ? newApplications : [...this.data.applications, ...newApplications],
          appPage: page + 1,
          appHasMore: newApplications.length >= this.data.appPageSize,
          appLoading: false
        })
      } else {
        this.setData({ appLoading: false })
      }
    } catch (err) {
      console.error('加载申请记录失败:', err)
      this.setData({ appLoading: false })
    }
  },

  // 加载账单记录
  async loadRecords(reset = false) {
    if (this.data.loading) return

    const page = reset ? 0 : this.data.page

    this.setData({ loading: true })

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-get-point-records',
        data: {
          action: 'getBalanceRecords',
          page: page,
          pageSize: this.data.pageSize
        }
      })

      if (result.code === 0) {
        const newRecords = (result.data.records || []).map(item => this.normalizeBalanceRecord(item))

        this.setData({
          records: reset ? newRecords : [...this.data.records, ...newRecords],
          page: page + 1,
          hasMore: newRecords.length >= this.data.pageSize,
          loading: false
        })
      } else {
        this.setData({ loading: false })
      }
    } catch (err) {
      console.error('加载账单失败:', err)
      this.setData({ loading: false })
    }
  },

  // 下拉刷新
  async onPullDownRefresh() {
    await this.loadBalance()
    await this.loadRecords(true)
    await this.loadApplications(true)
    wx.stopPullDownRefresh()
  },

  // 加载更多申请记录
  loadMoreApplications() {
    if (this.data.appHasMore && !this.data.appLoading) {
      this.loadApplications()
    }
  },

  // 加载更多收支记录
  loadMoreRecords() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadRecords()
    }
  },

  // 显示申请提现弹窗
  showApplyModal() {
    if (!this.data.canWithdraw) {
      wx.showToast({
        title: this.data.withdrawTip,
        icon: 'none',
        duration: 2000
      })
      return
    }
    this.setData({
      showApplyModal: true,
      applyAmount: '',
      applyFee: '0.00',
      applyActual: '0.00',
      canSubmitApply: false,
      applyErrorTip: '',
      isSubmitting: false,
      needApproval: false
    })
  },

  hideApplyModal() {
    this.setData({ showApplyModal: false })
  },

  // 输入申请金额
  onApplyAmountInput(e) {
    let value = e.detail.value
    value = value.replace(/[^0-9.]/g, '')
    const parts = value.split('.')
    if (parts.length > 2) {
      value = parts[0] + '.' + parts.slice(1).join('')
    }
    if (parts[1] && parts[1].length > 2) {
      value = parts[0] + '.' + parts[1].slice(0, 2)
    }

    const numValue = parseFloat(value) || 0
    const maxPerRequest = PLATFORM_RULES.WITHDRAW_MAX_PER_REQUEST
    const maxAvailable = Math.min(this.data.availableBalance, maxPerRequest)
    if (numValue > maxAvailable) {
      value = String(maxAvailable)
    }

    this.setData({ applyAmount: value })
    this.calcApplyFee()
    this.checkCanSubmitApply()
  },

  // 全部提现
  withdrawAll() {
    const maxAmount = Math.min(this.data.availableBalance, PLATFORM_RULES.WITHDRAW_MAX_PER_REQUEST)
    const amount = MoneyUtils.formatAmount(maxAmount)
    this.setData({ applyAmount: amount })
    this.calcApplyFee()
    this.checkCanSubmitApply()
  },

  calcApplyFee() {
    const amount = parseFloat(this.data.applyAmount) || 0
    const fee = MoneyUtils.calcWithdrawFee(amount)
    const actual = MoneyUtils.calcWithdrawActual(amount)
    this.setData({
      applyFee: MoneyUtils.formatAmount(fee),
      applyActual: MoneyUtils.formatAmount(actual)
    })
  },

  checkCanSubmitApply() {
    const amount = parseFloat(this.data.applyAmount) || 0
    const check = MoneyUtils.checkWithdrawAmount(amount, this.data.availableBalance)
    const threshold = this.data.withdrawApprovalThreshold
    const needApproval = amount > threshold
    this.setData({
      canSubmitApply: check.valid,
      applyErrorTip: check.valid ? '' : check.reason,
      needApproval: needApproval
    })
  },

  // 提交提现申请
  async submitApply() {
    if (!this.data.canSubmitApply || this.data.isSubmitting) return

    const amount = parseFloat(this.data.applyAmount)
    const threshold = this.data.withdrawApprovalThreshold

    // 低于或等于阈值 → 直接跳转提现页即时到账
    if (amount <= threshold) {
      this.setData({ showApplyModal: false })
      wx.navigateTo({
        url: `/pages/withdraw/withdraw?amount=${amount}`
      })
      return
    }

    // 高于阈值 → 走审批流程
    wx.showModal({
      title: '确认申请',
      content: `提现金额 ${amount} 元（手续费 ${this.data.applyFee} 元，到账 ${this.data.applyActual} 元），单笔超过 ${threshold} 元需管理员审批，确认提交？`,
      confirmText: '确认申请',
      confirmColor: '#1677D2',
      success: async (res) => {
        if (res.confirm) {
          await this.doApply(amount)
        }
      }
    })
  },

  async doApply(amount) {
    this.setData({ isSubmitting: true })

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-withdraw-approval',
        data: {
          action: 'apply',
          amount: amount
        }
      })

      if (result.code === 0) {
        this.setData({ showApplyModal: false })
        wx.showToast({ title: '申请已提交', icon: 'success' })
        this.loadApplications(true)
      } else {
        wx.showToast({ title: result.message, icon: 'none', duration: 3000 })
      }
    } catch (err) {
      wx.showToast({ title: '提交失败', icon: 'none' })
    }

    this.setData({ isSubmitting: false })
  },

  // 跳转到提现页面（审批通过后发起真实提现）
  goToWithdraw(e) {
    const { id } = e.currentTarget.dataset
    if (!id) return
    wx.navigateTo({
      url: `/pages/withdraw/withdraw?applicationId=${id}`
    })
  },

  // 显示提现规则
  showWithdrawRules() {
    this.setData({ showRulesModal: true })
  },

  hideRulesModal() {
    this.setData({ showRulesModal: false })
  },

  normalizeBalanceRecord(item) {
    const title = item.title || ''
    const amount = Number(item.amount || 0)
    const isIncome = amount >= 0
    const fallback = isIncome
      ? { icon: 'circle-dollar-sign', color: 'var(--fresh-mint)', bg: 'var(--fresh-mint-14)' }
      : { icon: 'credit-card', color: 'var(--vitality-orange)', bg: 'var(--vitality-orange-14)' }

    const iconMap = [
      { match: '收入', icon: 'hand-coins', color: 'var(--fresh-mint)', bg: 'var(--fresh-mint-14)' },
      { match: '支付', icon: 'credit-card', color: 'var(--vitality-orange)', bg: 'var(--vitality-orange-14)' },
      { match: '退款', icon: 'refresh-cw', color: 'var(--fresh-mint)', bg: 'var(--fresh-mint-14)' },
      { match: '提现手续费', icon: 'receipt-text', color: 'var(--vitality-orange)', bg: 'var(--vitality-orange-14)' },
      { match: '提现', icon: 'landmark', color: 'var(--brand-primary)', bg: 'var(--brand-primary-12)' }
    ]

    const matched = iconMap.find(meta => title.includes(meta.match)) || fallback

    return {
      ...item,
      amountPrefix: amount > 0 ? '+' : amount < 0 ? '-' : '',
      displayAmountAbs: MoneyUtils.formatAmount(Math.abs(amount)),
      icon: item.icon && /^[a-z0-9-]+$/.test(item.icon) ? item.icon : matched.icon,
      iconColor: item.iconColor || matched.color,
      iconBg: item.iconBg || matched.bg
    }
  }
})
