// 发布成功页面
const { MoneyUtils } = require('../../utils/platformRules')

Page({
  data: {
    needId: '',
    amount: 0,
    typeName: '',
    takerIncome: '0.00',
    showAnimation: false
  },

  onLoad(options) {
    const { needId, amount, typeName } = options
    const parsedAmount = parseFloat(amount) || 0
    this.setData({
      needId: needId || '',
      amount: parsedAmount,
      typeName: decodeURIComponent(typeName || '求助'),
      takerIncome: MoneyUtils.calcTakerIncome(parsedAmount)
    })

    // 触发入场动画
    setTimeout(() => {
      this.setData({ showAnimation: true })
    }, 100)

    // 设置刷新标记
    app.globalData.refreshMyNeeds = true
    wx.setStorageSync('forceRefreshIndex', true)
    wx.setStorageSync('forceRefreshTaskHall', true)
  },

  // 查看任务详情
  goToTaskDetail() {
    const { needId } = this.data
    if (!needId) {
      wx.showToast({ title: '任务ID无效', icon: 'none' })
      return
    }
    wx.redirectTo({
      url: `/pages/task-detail/task-detail?id=${needId}`
    })
  },

  // 返回首页
  goToHome() {
    wx.switchTab({
      url: '/pages/index/index'
    })
  },

  // 再次发布
  publishAgain() {
    wx.redirectTo({
      url: '/pages/publish/publish'
    })
  }
})
