const DateUtil = require('../../utils/dateUtil')

Page({
  data: {
    experienceId: '',
    ticket: null,
    experience: null,
    reports: [],
    loading: true,
    handling: false
  },

  onLoad(options) {
    this.setData({ experienceId: options.experienceId || '' })
    this.loadDetail()
  },

  async loadDetail() {
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-experience',
        data: { action: 'getReportTicketDetail', experienceId: this.data.experienceId }
      })
      if (result.code !== 0) throw new Error(result.message)
      this.setData({
        ticket: result.data.ticket,
        experience: result.data.experience,
        reports: (result.data.reports || []).map(item => ({
          ...item,
          timeText: DateUtil.formatDateTime(item.createTime)
        })),
        loading: false
      })
    } catch (err) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    }
  },

  resolve(e) {
    const result = e.currentTarget.dataset.result
    wx.showModal({
      title: result === 'down' ? '确认下架' : '确认不予处理',
      content: result === 'down' ? '经验将立即停止公开展示。' : '经验将保持公开展示。',
      success: res => {
        if (res.confirm) this.doResolve(result)
      }
    })
  },

  async doResolve(resultValue) {
    if (this.data.handling) return
    this.setData({ handling: true })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-experience',
        data: {
          action: 'resolveReportTicket',
          experienceId: this.data.experienceId,
          result: resultValue
        }
      })
      if (result.code !== 0) throw new Error(result.message)
      wx.showToast({ title: result.message, icon: 'success' })
      await this.loadDetail()
    } catch (err) {
      wx.showToast({ title: err.message || '处理失败', icon: 'none' })
    } finally {
      this.setData({ handling: false })
    }
  }
})
