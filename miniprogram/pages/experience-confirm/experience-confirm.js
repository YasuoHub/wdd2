Page({
  data: {
    experienceId: '',
    experience: null,
    canHandle: false,
    loading: true,
    handling: false
  },

  onLoad(options) {
    this.setData({ experienceId: options.experienceId || '' })
    this.loadDetail()
  },

  onShow() {
    if (this.data.experience) this.loadDetail()
  },

  async loadDetail() {
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-experience',
        data: { action: 'getConfirmation', experienceId: this.data.experienceId }
      })
      if (result.code !== 0) throw new Error(result.message)
      this.setData({
        experience: result.data.experience,
        canHandle: !!result.data.canHandle,
        loading: false
      })
    } catch (err) {
      this.setData({ loading: false })
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    }
  },

  handle(e) {
    const accepted = e.currentTarget.dataset.accepted === true || e.currentTarget.dataset.accepted === 'true'
    const title = this.data.experience.title
    wx.showModal({
      title: accepted ? '确认分享' : '暂不分享',
      content: accepted
        ? `确认公开经验分享“${title}”吗？`
        : `确认暂不分享“${title}”吗？`,
      confirmText: accepted ? '确认分享' : '暂不分享',
      confirmColor: accepted ? '#1677D2' : '#d64545',
      success: res => {
        if (res.confirm) this.submitDecision(accepted)
      }
    })
  },

  async submitDecision(accepted) {
    if (this.data.handling) return
    this.setData({ handling: true })
    wx.showLoading({ title: '处理中...' })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-experience',
        data: {
          action: accepted ? 'confirmShare' : 'rejectShare',
          experienceId: this.data.experienceId
        }
      })
      if (result.code !== 0) throw new Error(result.message)
      wx.showToast({ title: result.message, icon: 'success' })
      await this.loadDetail()
    } catch (err) {
      wx.showToast({ title: err.message || '处理失败', icon: 'none' })
      await this.loadDetail()
    } finally {
      wx.hideLoading()
      this.setData({ handling: false })
    }
  }
})
