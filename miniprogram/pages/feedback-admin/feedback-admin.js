const DateUtil = require('../../utils/dateUtil')

Page({
  data: {
    activeTab: 'pending',
    pendingList: [],
    resolvedList: [],
    pendingSkip: 0,
    resolvedSkip: 0,
    pendingHasMore: true,
    resolvedHasMore: true,
    currentList: [],
    currentHasMore: true,
    loading: false
  },

  onShow() {
    this.loadList(this.data.activeTab, true)
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.activeTab) return
    this.setData({ activeTab: tab }, () => this.syncCurrent())
    if (this.data[`${tab}List`].length === 0) this.loadList(tab, true)
  },

  syncCurrent() {
    const tab = this.data.activeTab
    this.setData({
      currentList: this.data[`${tab}List`],
      currentHasMore: this.data[`${tab}HasMore`]
    })
  },

  async loadList(status, reset) {
    if (this.data.loading) return
    const skip = reset ? 0 : this.data[`${status}Skip`]
    if (!reset && !this.data[`${status}HasMore`]) return
    this.setData({ loading: true })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-feedback',
        data: { action: 'getAdminFeedbackList', status, skip, limit: 20 }
      })
      if (result.code === 403) {
        wx.showModal({
          title: '无权访问',
          content: '您没有客服权限',
          showCancel: false,
          success: () => wx.navigateBack()
        })
        return
      }
      if (result.code !== 0) throw new Error(result.message || '加载失败')
      const list = (result.data.list || []).map(item => ({
        ...item,
        createTimeText: DateUtil.formatDateTime(item.createTime)
      }))
      this.setData({
        [`${status}List`]: reset ? list : this.data[`${status}List`].concat(list),
        [`${status}Skip`]: skip + list.length,
        [`${status}HasMore`]: !!result.data.hasMore
      }, () => {
        if (status === this.data.activeTab) this.syncCurrent()
      })
    } catch (err) {
      console.error('加载意见反馈处理列表失败:', err)
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  loadMore() {
    this.loadList(this.data.activeTab, false)
  },

  goDetail(e) {
    wx.navigateTo({
      url: `/pages/feedback-detail/feedback-detail?feedbackId=${e.currentTarget.dataset.id}&from=admin`
    })
  }
})
