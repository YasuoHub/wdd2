Page({
  data: {
    status: 'pending',
    list: [],
    page: 1,
    hasMore: true,
    loading: false,
    errorMessage: '',
    missingCollection: ''
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
    this.setData({
      loading: true,
      errorMessage: reset ? '' : this.data.errorMessage,
      missingCollection: reset ? '' : this.data.missingCollection
    })
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
        hasMore: !!result.data.hasMore,
        errorMessage: '',
        missingCollection: result.data.missingCollection || ''
      })
    } catch (err) {
      this.setData({
        list: reset ? [] : this.data.list,
        hasMore: false,
        errorMessage: this.getLoadErrorMessage(err)
      })
    } finally {
      this.setData({ loading: false })
    }
  },

  getLoadErrorMessage(err) {
    const message = String((err && (err.errMsg || err.message)) || '')
    if (/DATABASE_COLLECTION_NOT_EXIST|collection not exist|collection.*not exists|Table not exist|集合不存在/i.test(message)) {
      return '经验举报工单集合还没有创建，请先初始化数据库。'
    }
    return '举报工单加载失败，请稍后重试'
  },

  goDetail(e) {
    wx.navigateTo({
      url: `/pages/experience-report-detail/experience-report-detail?experienceId=${e.currentTarget.dataset.id}`
    })
  }
})
