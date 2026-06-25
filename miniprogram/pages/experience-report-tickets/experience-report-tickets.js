Page({
  data: {
    status: 'pending',
    list: [],
    page: 1,
    hasMore: true,
    loading: false
  },

  onShow() {
    this.loadList(true)
  },

  switchStatus(e) {
    this.setData({ status: e.currentTarget.dataset.status }, () => this.loadList(true))
  },

  async loadList(reset) {
    if (this.data.loading || (!reset && !this.data.hasMore)) return
    const page = reset ? 1 : this.data.page
    this.setData({ loading: true })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-experience',
        data: { action: 'getReportTickets', status: this.data.status, page, pageSize: 20 }
      })
      if (result.code !== 0) throw new Error(result.message)
      const list = result.data.list || []
      this.setData({
        list: reset ? list : this.data.list.concat(list),
        page: page + 1,
        hasMore: !!result.data.hasMore
      })
    } catch (err) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  goDetail(e) {
    wx.navigateTo({
      url: `/pages/experience-report-detail/experience-report-detail?experienceId=${e.currentTarget.dataset.id}`
    })
  }
})
