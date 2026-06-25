const DateUtil = require('../../utils/dateUtil')

Page({
  data: {
    experienceId: '',
    experience: null,
    canHandle: false,
    statusNote: '',
    deadlineText: '',
    autoRuleText: '',
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
        statusNote: this.buildStatusNote(result.data.experience, !!result.data.canHandle),
        deadlineText: this.buildDeadlineText(result.data.experience),
        autoRuleText: this.buildAutoRuleText(result.data.experience, !!result.data.canHandle),
        loading: false
      })
    } catch (err) {
      this.setData({ loading: false })
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    }
  },

  buildStatusNote(experience, canHandle) {
    if (canHandle) {
      return '请确认下方内容是否适合匿名公开。确认后将立即发布，求助者不能再修改。'
    }
    const status = experience && experience.status
    if (status === 'published') return '该经验已确认并公开，无需再次操作。'
    if (status === 'rejected') return '你已选择暂不分享，该经验不会公开展示。'
    if (status === 'expired') return '确认期限已过，该分享申请已失效。'
    if (status === 'withdrawn') return '求助者已取消本次分享申请。'
    if (status === 'down') return '该经验已下架，当前无需处理。'
    return '该分享已经处理，无需再次操作。'
  },

  buildDeadlineText(experience) {
    if (!experience || experience.status !== 'pending_confirmation') return ''
    const deadlineText = DateUtil.formatDateTime(experience.confirm_deadline)
    return deadlineText ? `请在 ${deadlineText} 前处理` : ''
  },

  buildAutoRuleText(experience, canHandle) {
    if (!experience || experience.status !== 'pending_confirmation') return ''
    if (experience.helper_share_authorized) {
      return canHandle
        ? '你接单时已同意逾期自动按预览内容发布；如不想公开，请在截止前选择暂不分享。'
        : '你接单时已同意逾期自动发布，当前等待系统处理。'
    }
    return canHandle
      ? '你接单时未授权逾期自动发布；若截止前不处理，本次分享申请会失效。'
      : '你接单时未授权逾期自动发布，截止后本次分享申请会失效。'
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
