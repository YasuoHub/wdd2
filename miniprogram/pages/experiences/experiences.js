function getExperienceErrorMessage(err) {
  const rawMessage = String((err && (err.errMsg || err.message)) || '')
  if (rawMessage.includes('FUNCTION_NOT_FOUND') || rawMessage.includes('-501000') || rawMessage.includes('could not be found')) {
    return '查经验服务还没有部署，请先在云开发中部署 wdd-experience 云函数。'
  }
  return '查经验加载失败，请稍后重试'
}

Page({
  data: {
    keyword: '',
    list: [],
    page: 1,
    hasMore: true,
    loading: false,
    errorMessage: ''
  },

  onLoad() {
    this.loadList(true)
  },

  onPullDownRefresh() {
    this.loadList(true).finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    this.loadList(false)
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value })
  },

  search() {
    this.loadList(true)
  },

  retryLoad() {
    this.loadList(true)
  },

  async loadList(reset) {
    if (this.data.loading || (!reset && !this.data.hasMore)) return
    const page = reset ? 1 : this.data.page
    this.setData({
      loading: true,
      errorMessage: reset ? '' : this.data.errorMessage
    })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-experience',
        data: {
          action: 'getPublicList',
          keyword: this.data.keyword,
          page,
          pageSize: 10
        }
      })
      if (result.code !== 0) throw new Error(result.message)
      const list = result.data.list || []
      this.setData({
        list: reset ? list : this.data.list.concat(list),
        page: page + 1,
        hasMore: !!result.data.hasMore,
        errorMessage: ''
      })
    } catch (err) {
      console.error('加载查经验失败:', err)
      this.setData({
        list: reset ? [] : this.data.list,
        hasMore: false,
        errorMessage: getExperienceErrorMessage(err)
      })
    } finally {
      this.setData({ loading: false })
    }
  },

  goDetail(e) {
    wx.navigateTo({
      url: `/pages/experience-detail/experience-detail?experienceId=${e.currentTarget.dataset.id}`
    })
  }
})
