const app = getApp()

// 申诉类型映射（value → label），提交时传 value，展示用 label
const APPEAL_TYPES = [
  { value: 'unjust_rejection', label: '任务已完成被无故驳回' },
  { value: 'lost_contact', label: '对方失联拒不验收结算' },
  { value: 'amount_dispute', label: '悬赏金额结算有异议' },
  { value: 'malicious_report', label: '被对方恶意举报诬陷' },
  { value: 'false_helper_info', label: '帮助者提供虚假信息导致任务无效' },
  { value: 'helper_location_mismatch', label: '帮助者定位不符无法完成帮助' },
  { value: 'malicious_rejection', label: '求助者恶意驳回已完成的信息帮助' },
  { value: 'unfair_judgment', label: '任务判定结果不合理' },
  { value: 'other_dispute', label: '其他任务纠纷申诉' }
]

// 仅 label 数组，用于 picker 的 range
const APPEAL_TYPE_LABELS = APPEAL_TYPES.map(t => t.label)

Page({
  data: {
    needId: '',
    mode: 'initiate',
    appealTypes: APPEAL_TYPE_LABELS,
    selectedTypeValue: '',
    selectedTypeLabel: '',
    reason: '',
    images: [],
    wordCount: 0,
    isSubmitting: false,
    showConfirmModal: false,
    isSubmitted: false,
    appealId: '',
    canCancel: true,
    opponentInfo: null,
    taskSummary: null,
    supplementDeadline: null,
    supplementCountdown: '',
    canSupplement: false
  },

  onLoad(options) {
    const { needId, mode = 'initiate' } = options
    this.setData({ needId, mode })
    if (mode === 'supplement') {
      this.loadAppealDetail()
    }
  },

  async loadAppealDetail() {
    const { needId } = this.data
    wx.showLoading({ title: '加载中...' })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-appeal',
        data: { action: 'getAppealDetail', needId }
      })
      wx.hideLoading()
      if (result.code === 0 && result.data.hasAppeal) {
        const data = result.data
        this.setData({
          opponentInfo: data.initiator,
          taskSummary: data.taskInfo,
          supplementDeadline: data.supplementDeadline,
          canSupplement: data.canSupplement,
          isLoading: false
        })
        if (data.canSupplement) this.startSupplementCountdown()
      }
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  startSupplementCountdown() {
    const update = () => {
      const { supplementDeadline } = this.data
      if (!supplementDeadline) return
      const now = new Date()
      const deadline = new Date(supplementDeadline)
      const diff = deadline.getTime() - now.getTime()
      if (diff <= 0) {
        this.setData({ canSupplement: false, supplementCountdown: '已超时' })
        if (this.supplementTimer) clearInterval(this.supplementTimer)
        return
      }
      const hours = Math.floor(diff / (1000 * 60 * 60))
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
      const seconds = Math.floor((diff % (1000 * 60)) / 1000)
      this.setData({
        supplementCountdown: `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
      })
    }
    update()
    this.supplementTimer = setInterval(update, 1000)
  },

  onTypeChange(e) {
    const index = e.detail.value
    const selected = APPEAL_TYPES[index]
    this.setData({ selectedTypeValue: selected.value, selectedTypeLabel: selected.label })
  },

  onReasonInput(e) {
    const reason = e.detail.value
    this.setData({ reason, wordCount: reason.length })
  },

  chooseImage() {
    const { images } = this.data
    if (images.length >= 3) {
      wx.showToast({ title: '最多上传3张图片', icon: 'none' })
      return
    }
    wx.chooseImage({
      count: 3 - images.length,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => { this.uploadImages(res.tempFilePaths) }
    })
  },

  async uploadImages(filePaths) {
    wx.showLoading({ title: '上传中...' })
    const uploadedUrls = []
    for (const filePath of filePaths) {
      try {
        const cloudPath = `appeal-images/${Date.now()}-${Math.random().toString(36).substr(2, 6)}.jpg`
        const uploadResult = await wx.cloud.uploadFile({ cloudPath, filePath })
        uploadedUrls.push(uploadResult.fileID)
      } catch (err) { console.error('上传图片失败:', err) }
    }
    wx.hideLoading()
    const { images } = this.data
    this.setData({ images: [...images, ...uploadedUrls].slice(0, 3) })
  },

  removeImage(e) {
    const { index } = e.currentTarget.dataset
    const { images } = this.data
    images.splice(index, 1)
    this.setData({ images })
  },

  showConfirm() {
    const { selectedTypeValue, reason, images, mode } = this.data
    if (mode !== 'supplement' && !selectedTypeValue) { wx.showToast({ title: '请选择申诉类型', icon: 'none' }); return }
    if (reason.length < 5) { wx.showToast({ title: '申诉理由至少5个字', icon: 'none' }); return }
    if (images.length === 0) { wx.showToast({ title: '请上传至少1张证据图片', icon: 'none' }); return }
    if (mode === 'initiate') {
      this.setData({ showConfirmModal: true })
    } else {
      this.submitAppeal()
    }
  },

  hideConfirm() { this.setData({ showConfirmModal: false }) },

  async submitAppeal() {
    this.hideConfirm()
    const { needId, selectedTypeValue, reason, images, mode } = this.data
    this.setData({ isSubmitting: true })
    wx.showLoading({ title: '提交中...' })
    try {
      const action = mode === 'initiate' ? 'submitAppeal' : 'submitSupplement'
      const params = { action, needId, reason, images }
      if (mode === 'initiate') {
        params.appealType = selectedTypeValue
        params.appealTypeLabel = selectedTypeLabel
      }
      if (mode === 'supplement') {
        const detailRes = await wx.cloud.callFunction({
          name: 'wdd-appeal', data: { action: 'getAppealDetail', needId }
        })
        if (detailRes.result.code === 0 && detailRes.result.data.hasAppeal) {
          params.appealId = detailRes.result.data.appealId
        }
      }
      const { result } = await wx.cloud.callFunction({ name: 'wdd-appeal', data: params })
      wx.hideLoading()
      this.setData({ isSubmitting: false })
      if (result.code === 0) {
        wx.showToast({ title: '提交成功', icon: 'success' })
        if (mode === 'initiate') {
          this.setData({ isSubmitted: true, appealId: result.data.appealId, canCancel: true })
        } else {
          setTimeout(() => { wx.navigateBack() }, 1500)
        }
      } else {
        wx.showToast({ title: result.message || '提交失败', icon: 'none' })
      }
    } catch (err) {
      wx.hideLoading()
      this.setData({ isSubmitting: false })
      wx.showToast({ title: err.message || '提交失败', icon: 'none' })
    }
  },

  async cancelAppeal() {
    const { appealId } = this.data
    wx.showModal({
      title: '确认撤销',
      content: '撤销后任务将恢复正常，但不可再次发起申诉，确认撤销？',
      confirmColor: '#e74c3c',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '撤销中...' })
          try {
            const { result } = await wx.cloud.callFunction({
              name: 'wdd-appeal', data: { action: 'cancelAppeal', appealId }
            })
            wx.hideLoading()
            if (result.code === 0) {
              wx.showToast({ title: '撤销成功', icon: 'success' })
              setTimeout(() => { wx.navigateBack() }, 1500)
            } else {
              wx.showToast({ title: result.message || '撤销失败', icon: 'none' })
            }
          } catch (err) {
            wx.hideLoading()
            wx.showToast({ title: err.message || '撤销失败', icon: 'none' })
          }
        }
      }
    })
  },

  previewOpponentImage(e) {
    const { url } = e.currentTarget.dataset
    const { opponentInfo } = this.data
    const urls = opponentInfo && opponentInfo.images ? opponentInfo.images : [url]
    wx.previewImage({ current: url, urls })
  },

  goBack() { wx.navigateBack() },

  goToTaskDetail() {
    const { needId } = this.data
    wx.navigateTo({ url: `/pages/task-detail/task-detail?id=${needId}` })
  },

  onUnload() {
    if (this.supplementTimer) clearInterval(this.supplementTimer)
  }
})
