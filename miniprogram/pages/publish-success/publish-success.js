// 发布成功页面
const app = getApp()
const { getByType } = require('../../utils/needTypes')

Page({
  data: {
    needId: '',
    amount: 0,
    typeName: '',
    taskLocation: '任务地点',
    showAnimation: false
  },

  onLoad(options) {
    const { needId, amount, type, locationName } = options
    const parsedAmount = parseFloat(amount) || 0
    const typeInfo = getByType(type)

    this.setData({
      needId: needId || '',
      amount: parsedAmount,
      typeName: typeInfo.name,
      taskLocation: decodeURIComponent(locationName || '任务地点')
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
