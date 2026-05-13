const DateUtil = require('../../utils/dateUtil')

Page({
  data: {
    detail: null,
    loading: true
  },

  onLoad(options) {
    const { appealId } = options
    if (!appealId) {
      wx.showToast({ title: '参数错误', icon: 'none' })
      return
    }
    this.loadDetail(appealId)
  },

  async loadDetail(appealId) {
    try {
      wx.showLoading({ title: '加载中...' })
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-appeal',
        data: { action: 'getAppealDetailById', appealId }
      })
      wx.hideLoading()

      if (result.code !== 0) {
        wx.showToast({ title: result.message || '加载失败', icon: 'none' })
        return
      }

      const d = result.data
      this.setData({
        detail: {
          ...d,
          createTimeText: DateUtil.formatDateTime(d.createTime),
          cancelTimeText: d.cancelTime ? DateUtil.formatDateTime(d.cancelTime) : '',
          updateTimeText: DateUtil.formatDateTime(d.updateTime)
        },
        loading: false
      })
    } catch (err) {
      wx.hideLoading()
      console.error('加载申诉详情失败:', err)
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  previewImage(e) {
    const { url } = e.currentTarget.dataset
    const { detail } = this.data
    const urls = detail.images || []
    wx.previewImage({ current: url, urls })
  },

  goToTask() {
    const needId = this.data.detail && this.data.detail.needId
    if (!needId) return
    wx.navigateTo({
      url: '/pages/task-detail/task-detail?id=' + needId
    })
  }
})
