// 钱包/余额页面
const app = getApp()
const { PLATFORM_RULES, MoneyUtils } = require('../../utils/platformRules')

Page({
  data: {
    // 余额信息
    balance: 0,
    totalEarned: 0,
    totalWithdrawn: 0,
    totalPaid: 0,

    // 平台规则
    withdrawMinAmount: PLATFORM_RULES.WITHDRAW_MIN_AMOUNT,
    withdrawFeeRate: Math.round(PLATFORM_RULES.WITHDRAW_FEE_RATE * 100),

    // 提现条件
    canWithdraw: false,
    withdrawTip: '',

    // 账单列表
    records: [],
    loading: false,
    hasMore: true,
    page: 0,
    pageSize: 20,

    // 用户信息
    userInfo: {}
  },

  onLoad() {
    this.loadUserInfo()
    this.loadBalance()
    this.loadRecords()
  },

  onShow() {
    this.loadBalance()
    this.loadRecords(true)
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

        // 检查提现条件
        const withdrawCheck = MoneyUtils.checkCanWithdraw(balance)

        this.setData({
          balance: balance,
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
        const newRecords = result.data.records || []

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
    wx.stopPullDownRefresh()
  },

  // 加载更多
  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadRecords()
    }
  },

  // 跳转到提现页面
  goToWithdraw() {
    if (!this.data.canWithdraw) {
      wx.showToast({
        title: this.data.withdrawTip,
        icon: 'none',
        duration: 2000
      })
      return
    }
    wx.navigateTo({
      url: '/pages/withdraw/withdraw'
    })
  },

  // 格式化金额
  formatMoney(amount) {
    return MoneyUtils.formatAmount(amount)
  }
})
