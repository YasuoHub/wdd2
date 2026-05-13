const app = getApp()
const { REPORT_TYPES, REPORT_TYPE_LABELS } = require('../../config/types')

Page({
  data: {
    needId: '',
    mode: 'initiate',
    reportTypes: REPORT_TYPE_LABELS,
    selectedTypeValue: '',
    selectedTypeLabel: '',
    reason: '',
    images: [],
    wordCount: 0,
    isSubmitting: false,
    showConfirmModal: false,
    // 提交成功状态
    isSubmitted: false,
    reportId: '',
    ticketId: '',
    canCancel: true,
    countdownText: '05:00',
    countdownSeconds: 300,
    // 补充材料模式
    opponentInfo: null,
    mySupplement: null,
    taskSummary: null,
    supplementDeadline: null,
    supplementCountdown: '',
    canSupplement: false
  },

  onLoad(options) {
    const { needId, mode = 'initiate' } = options
    this.setData({ needId, mode })
    if (mode === 'supplement') {
      this.loadReportDetail()
    }
  },

  async loadReportDetail() {
    const { needId } = this.data
    wx.showLoading({ title: '加载中...' })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-report',
        data: { action: 'getReportDetail', needId }
      })
      wx.hideLoading()
      if (result.code === 0 && result.data.hasReport) {
        const data = result.data
        this.setData({
          opponentInfo: data.initiator,
          mySupplement: data.mySupplement || null,
          taskSummary: data.taskInfo,
          supplementDeadline: data.supplementDeadline,
          canSupplement: data.canSupplement,
          isLoading: false
        })
        if (data.canSupplement) {
          this.startSupplementCountdown()
        } else if (data.isSupplementTimeout) {
          this.setData({ supplementCountdown: '已超时' })
        } else if (data.mySupplement) {
          this.setData({ supplementCountdown: '已提交' })
        } else {
          this.setData({ supplementCountdown: '—' })
        }
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

  // 选择举报类型
  onTypeChange(e) {
    const index = e.detail.value
    const selected = REPORT_TYPES[index]
    this.setData({
      selectedTypeValue: selected.value,
      selectedTypeLabel: selected.label
    })
  },

  // 输入举报理由
  onReasonInput(e) {
    const reason = e.detail.value
    this.setData({
      reason,
      wordCount: reason.length
    })
  },

  // 选择图片
  chooseImage() {
    const { images } = this.data
    if (images.length >= 3) {
      wx.showToast({ title: '最多上传3张图片', icon: 'none' })
      return
    }

    wx.chooseMedia({
      count: 3 - images.length,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const filePaths = res.tempFiles.map(f => f.tempFilePath)
        this.uploadImages(filePaths)
      },
      fail: (err) => {
        console.error('选择图片失败:', err)
        if (err.errMsg && err.errMsg.includes('cancel')) {
          return
        }
        wx.showToast({ title: '选择图片失败，请重试', icon: 'none' })
      }
    })
  },

  // 上传图片到云存储
  async uploadImages(filePaths) {
    wx.showLoading({ title: '上传中...' })

    const uploadedUrls = []
    for (const filePath of filePaths) {
      try {
        const cloudPath = `report-images/${Date.now()}-${Math.random().toString(36).substr(2, 6)}.jpg`
        const uploadResult = await wx.cloud.uploadFile({
          cloudPath,
          filePath
        })
        uploadedUrls.push(uploadResult.fileID)
      } catch (err) {
        console.error('上传图片失败:', err)
      }
    }

    wx.hideLoading()

    const { images } = this.data
    this.setData({
      images: [...images, ...uploadedUrls].slice(0, 3)
    })
  },

  // 删除图片
  removeImage(e) {
    const { index } = e.currentTarget.dataset
    const { images } = this.data
    images.splice(index, 1)
    this.setData({ images })
  },

  // 显示确认弹窗
  showConfirm() {
    const { selectedTypeValue, reason, images, mode } = this.data

    if (mode !== 'supplement' && !selectedTypeValue) {
      wx.showToast({ title: '请选择举报类型', icon: 'none' })
      return
    }
    if (reason.length < 5) {
      wx.showToast({ title: '举报理由至少5个字', icon: 'none' })
      return
    }
    if (images.length === 0) {
      wx.showToast({ title: '请上传至少1张证据图片', icon: 'none' })
      return
    }

    if (mode === 'initiate') {
      this.setData({ showConfirmModal: true })
    } else {
      this.submitReport()
    }
  },

  // 隐藏确认弹窗
  hideConfirm() {
    this.setData({ showConfirmModal: false })
  },

  // 提交举报
  async submitReport() {
    this.hideConfirm()

    const { needId, selectedTypeValue, selectedTypeLabel, reason, images, mode } = this.data

    this.setData({ isSubmitting: true })
    wx.showLoading({ title: '提交中...' })

    try {
      const action = mode === 'initiate' ? 'submitReport' : 'submitSupplement'
      const params = { action, needId, reason, images }
      if (mode === 'initiate') {
        params.reportType = selectedTypeValue
        params.reportTypeLabel = selectedTypeLabel
      }
      if (mode === 'supplement') {
        const detailRes = await wx.cloud.callFunction({
          name: 'wdd-report', data: { action: 'getReportDetail', needId }
        })
        if (detailRes.result.code === 0 && detailRes.result.data.hasReport) {
          params.reportId = detailRes.result.data.reportId
        }
      }
      const { result } = await wx.cloud.callFunction({ name: 'wdd-report', data: params })

      wx.hideLoading()
      this.setData({ isSubmitting: false })

      if (result.code === 0) {
        wx.showToast({ title: '提交成功', icon: 'success' })
        if (mode === 'initiate') {
          this.setData({
            isSubmitted: true,
            reportId: result.data.reportId,
            ticketId: result.data.ticketId,
            canCancel: true,
            countdownSeconds: 300
          })
          this.startCountdown()
          // 通知上一页刷新
          const pages = getCurrentPages()
          const prevPage = pages[pages.length - 2]
          if (prevPage && prevPage.loadTaskInfo) {
            prevPage.loadTaskInfo()
          }
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

  // 启动倒计时
  startCountdown() {
    this.countdownTimer = setInterval(() => {
      const { countdownSeconds } = this.data
      if (countdownSeconds <= 1) {
        clearInterval(this.countdownTimer)
        this.setData({
          canCancel: false,
          countdownText: '00:00'
        })
        return
      }

      const newSeconds = countdownSeconds - 1
      const minutes = Math.floor(newSeconds / 60).toString().padStart(2, '0')
      const seconds = (newSeconds % 60).toString().padStart(2, '0')

      this.setData({
        countdownSeconds: newSeconds,
        countdownText: `${minutes}:${seconds}`
      })
    }, 1000)
  },

  // 撤销举报
  async cancelReport() {
    const { reportId } = this.data

    wx.showModal({
      title: '确认撤销',
      content: '撤销后任务将恢复正常，但不可再次发起举报，确认撤销？',
      confirmColor: '#e74c3c',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '撤销中...' })

          try {
            const { result } = await wx.cloud.callFunction({
              name: 'wdd-report',
              data: {
                action: 'cancelReport',
                reportId
              }
            })

            wx.hideLoading()

            if (result.code === 0) {
              wx.showToast({ title: '撤销成功', icon: 'success' })

              // 清除倒计时
              if (this.countdownTimer) {
                clearInterval(this.countdownTimer)
              }

              // 返回上一页
              setTimeout(() => {
                wx.navigateBack()
              }, 1500)
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

  // 预览图片
  previewImage(e) {
    const { url, urls } = e.currentTarget.dataset
    const urlsList = urls || [url]
    wx.previewImage({ current: url, urls: urlsList })
  },

  // 返回上一页
  goBack() {
    wx.navigateBack()
  },

  // 跳转任务详情
  goToTaskDetail() {
    const { needId } = this.data
    wx.navigateTo({ url: `/pages/task-detail/task-detail?id=${needId}` })
  },

  onUnload() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer)
    }
    if (this.supplementTimer) {
      clearInterval(this.supplementTimer)
    }
  }
})
