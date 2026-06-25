const app = getApp()

Page({
  data: {
    experienceId: '',
    experience: null,
    loading: true,
    showReport: false,
    reportDescription: '',
    reporting: false
  },

  onLoad(options) {
    this.setData({ experienceId: options.experienceId || '' })
    this.loadDetail()
  },

  onShow() {
    if (this.data.experienceId && this.data.experience) this.loadDetail()
  },

  async loadDetail() {
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-experience',
        data: { action: 'getPublicDetail', experienceId: this.data.experienceId }
      })
      if (result.code !== 0) throw new Error(result.message)
      this.setData({ experience: result.data.experience, loading: false })
      wx.setNavigationBarTitle({ title: result.data.experience.title || '经验详情' })
    } catch (err) {
      this.setData({ loading: false })
      wx.showModal({
        title: '无法查看',
        content: err.message || '经验不存在或已下架',
        showCancel: false,
        success: () => wx.navigateBack()
      })
    }
  },

  previewImage(e) {
    const images = this.data.experience.images || []
    wx.previewImage({ current: e.currentTarget.dataset.url, urls: images })
  },

  async toggleLike() {
    if (!app.globalData.isLoggedIn) {
      wx.showToast({ title: '请先登录', icon: 'none' })
      return
    }
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-experience',
        data: { action: 'toggleLike', experienceId: this.data.experienceId }
      })
      if (result.code !== 0) throw new Error(result.message)
      this.setData({
        'experience.isLiked': result.data.liked,
        'experience.usefulCount': result.data.usefulCount
      })
    } catch (err) {
      wx.showToast({ title: err.message || '操作失败', icon: 'none' })
    }
  },

  openReport() {
    if (!app.globalData.isLoggedIn) {
      wx.showToast({ title: '请先登录', icon: 'none' })
      return
    }
    this.setData({ showReport: true, reportDescription: '' })
  },

  closeReport() {
    if (this.data.reporting) return
    this.setData({ showReport: false })
  },

  onReportInput(e) {
    this.setData({ reportDescription: e.detail.value })
  },

  async submitReport() {
    if (this.data.reporting) return
    this.setData({ reporting: true })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-experience',
        data: {
          action: 'submitReport',
          experienceId: this.data.experienceId,
          description: this.data.reportDescription
        }
      })
      if (result.code !== 0) throw new Error(result.message)
      this.setData({ showReport: false })
      wx.showToast({ title: result.message || '举报已提交', icon: 'success' })
    } catch (err) {
      wx.showToast({ title: err.message || '提交失败', icon: 'none' })
    } finally {
      this.setData({ reporting: false })
    }
  }
})
