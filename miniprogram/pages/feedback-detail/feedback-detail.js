const DateUtil = require('../../utils/dateUtil')

Page({
  data: {
    feedbackId: '',
    fromAdmin: false,
    feedback: null,
    createTimeText: '',
    resolveTimeText: '',
    canResolve: false,
    loading: true,
    resolving: false
  },

  onLoad(options) {
    this.setData({
      feedbackId: options.feedbackId || '',
      fromAdmin: options.from === 'admin'
    })
    this.loadDetail()
  },

  async loadDetail() {
    this.setData({ loading: true })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-feedback',
        data: {
          action: 'getFeedbackDetail',
          feedbackId: this.data.feedbackId
        }
      })
      if (result.code !== 0) throw new Error(result.message || '加载失败')
      const feedback = result.data.feedback
      this.setData({
        feedback,
        createTimeText: DateUtil.formatDateTime(feedback.createTime),
        resolveTimeText: DateUtil.formatDateTime(feedback.resolveTime),
        canResolve: this.data.fromAdmin && !!result.data.canResolve,
        loading: false
      })
    } catch (err) {
      console.error('加载反馈详情失败:', err)
      this.setData({ loading: false })
      wx.showModal({
        title: '加载失败',
        content: err.message || '反馈不存在或无权查看',
        showCancel: false,
        success: () => wx.navigateBack()
      })
    }
  },

  previewImage(e) {
    wx.previewImage({
      current: e.currentTarget.dataset.url,
      urls: this.data.feedback.images
    })
  },

  confirmResolve() {
    wx.showModal({
      title: '确认已知晓',
      content: '确认后该条意见反馈将进入“已处理”列表，且不可恢复为待处理。',
      confirmText: '确认处理',
      success: res => {
        if (res.confirm) this.resolveFeedback()
      }
    })
  },

  async resolveFeedback() {
    if (this.data.resolving) return
    this.setData({ resolving: true })
    wx.showLoading({ title: '处理中...' })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-feedback',
        data: {
          action: 'resolveFeedback',
          feedbackId: this.data.feedbackId
        }
      })
      wx.hideLoading()
      if (result.code === 409) {
        wx.showToast({ title: result.message, icon: 'none' })
        this.loadDetail()
        return
      }
      if (result.code !== 0) throw new Error(result.message || '处理失败')
      const app = getApp()
      app.globalData.feedbacksNeedRefresh = true
      wx.showToast({ title: '已处理', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 800)
    } catch (err) {
      wx.hideLoading()
      console.error('处理意见反馈失败:', err)
      wx.showToast({ title: err.message || '处理失败', icon: 'none' })
    } finally {
      this.setData({ resolving: false })
    }
  }
})
