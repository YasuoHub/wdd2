Page({
  data: {
    status: 'published',
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
        data: { action: 'getAdminExperiences', status: this.data.status, page, pageSize: 20 }
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
    wx.navigateTo({ url: `/pages/experience-detail/experience-detail?experienceId=${e.currentTarget.dataset.id}` })
  },

  changeStatus(e) {
    const experienceId = e.currentTarget.dataset.id
    const targetStatus = e.currentTarget.dataset.status
    wx.showModal({
      title: targetStatus === 'down' ? '确认下架' : '确认上架',
      content: targetStatus === 'down' ? '下架后用户将无法查看该经验。' : '确认恢复公开展示该经验？',
      success: res => {
        if (res.confirm) this.doChangeStatus(experienceId, targetStatus)
      }
    })
  },

  async doChangeStatus(experienceId, targetStatus) {
    const { result } = await wx.cloud.callFunction({
      name: 'wdd-experience',
      data: { action: 'setExperienceStatus', experienceId, targetStatus }
    })
    if (result.code !== 0) {
      wx.showToast({ title: result.message || '操作失败', icon: 'none' })
      return
    }
    wx.showToast({ title: result.message, icon: 'success' })
    this.loadList(true)
  }
})
