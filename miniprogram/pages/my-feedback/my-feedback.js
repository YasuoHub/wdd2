const DateUtil = require('../../utils/dateUtil')

Page({
  data: {
    list: [],
    skip: 0,
    hasMore: true,
    loading: false
  },

  onShow() {
    this.loadList(true)
  },

  async loadList(reset) {
    if (this.data.loading) return
    if (!reset && !this.data.hasMore) return
    const skip = reset ? 0 : this.data.skip
    this.setData({ loading: true })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-feedback',
        data: { action: 'getMyFeedbackList', skip, limit: 20 }
      })
      if (result.code !== 0) throw new Error(result.message || '加载失败')
      const list = (result.data.list || []).map(item => ({
        ...item,
        createTimeText: DateUtil.formatDateTime(item.createTime)
      }))
      this.setData({
        list: reset ? list : this.data.list.concat(list),
        skip: skip + list.length,
        hasMore: !!result.data.hasMore
      })
    } catch (err) {
      console.error('加载我的反馈失败:', err)
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  loadMore() {
    this.loadList(false)
  },

  goDetail(e) {
    wx.navigateTo({
      url: `/pages/feedback-detail/feedback-detail?feedbackId=${e.currentTarget.dataset.id}`
    })
  }
})
