const app = getApp()

// 举报类型映射（value → label），提交时传 value，展示用 label）
const REPORT_TYPES = [
  { value: 'offline_transaction', label: '诱导线下私下交易' },
  { value: 'verbal_abuse', label: '言语辱骂、骚扰人身攻击' },
  { value: 'fraud', label: '虚假承诺、恶意骗单' },
  { value: 'delay', label: '敷衍沟通、故意拖延进度' },
  { value: 'sensitive_content', label: '发布违规敏感内容' },
  { value: 'malicious_difficulty', label: '恶意刁难、无故拖延不配合' },
  { value: 'other_violation', label: '其他违规行为' },
  { value: 'false_info', label: '提供虚假实时信息（谎报天气/拥堵/营业状态）' },
  { value: 'location_mismatch', label: '接单后定位不符、不在求助地点' },
  { value: 'no_response', label: '恶意接单后不回复、不提供帮助' }
]

// 仅 label 数组，用于 picker 的 range
const REPORT_TYPE_LABELS = REPORT_TYPES.map(t => t.label)

Page({
  data: {
    needId: '',
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
    countdownSeconds: 300
  },

  onLoad(options) {
    const { needId } = options
    this.setData({ needId })
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

    wx.chooseImage({
      count: 3 - images.length,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        this.uploadImages(res.tempFilePaths)
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
    const { selectedTypeValue, reason, images } = this.data

    if (!selectedTypeValue) {
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

    this.setData({ showConfirmModal: true })
  },

  // 隐藏确认弹窗
  hideConfirm() {
    this.setData({ showConfirmModal: false })
  },

  // 提交举报
  async submitReport() {
    this.hideConfirm()

    const { needId, selectedTypeValue, reason, images } = this.data

    this.setData({ isSubmitting: true })
    wx.showLoading({ title: '提交中...' })

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-report',
        data: {
          action: 'submitReport',
          needId,
          reportType: selectedTypeValue,
          reason,
          images
        }
      })

      wx.hideLoading()
      this.setData({ isSubmitting: false })

      if (result.code === 0) {
        wx.showToast({ title: '举报提交成功', icon: 'success' })

        // 切换到成功状态，启动倒计时
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

  // 返回上一页
  goBack() {
    wx.navigateBack()
  },

  onUnload() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer)
    }
  }
})
