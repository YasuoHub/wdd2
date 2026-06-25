const app = getApp()

const DRAFT_KEY = 'wdd_feedback_draft'

Page({
  data: {
    title: '',
    content: '',
    images: [],
    dailyLimit: 3,
    remaining: 3,
    metaLoading: true,
    uploading: false,
    submitting: false
  },

  onLoad() {
    if (!app.globalData.userInfo) {
      wx.showModal({
        title: '请先登录',
        content: '登录后才能提交意见反馈',
        showCancel: false,
        success: () => wx.navigateBack()
      })
      return
    }
    this.restoreDraft()
    this.loadSubmitMeta()
  },

  restoreDraft() {
    const draft = wx.getStorageSync(DRAFT_KEY)
    if (!draft || typeof draft !== 'object') return
    this.setData({
      title: String(draft.title || '').slice(0, 40),
      content: String(draft.content || '').slice(0, 500),
      images: Array.isArray(draft.images) ? draft.images.slice(0, 3) : []
    })
  },

  saveDraft() {
    wx.setStorageSync(DRAFT_KEY, {
      title: this.data.title,
      content: this.data.content,
      images: this.data.images,
      updateTime: Date.now()
    })
  },

  async loadSubmitMeta() {
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-feedback',
        data: { action: 'getSubmitMeta' }
      })
      if (result.code === 0) {
        this.setData({
          dailyLimit: result.data.dailyLimit,
          remaining: result.data.remaining
        })
      } else {
        wx.showToast({ title: result.message || '额度查询失败', icon: 'none' })
      }
    } catch (err) {
      console.error('查询反馈额度失败:', err)
      wx.showToast({ title: '额度查询失败，请稍后重试', icon: 'none' })
    } finally {
      this.setData({ metaLoading: false })
    }
  },

  onTitleInput(e) {
    this.setData({ title: e.detail.value }, () => this.saveDraft())
  },

  onContentInput(e) {
    this.setData({ content: e.detail.value }, () => this.saveDraft())
  },

  chooseImage() {
    if (this.data.uploading || this.data.images.length >= 3) return
    wx.chooseMedia({
      count: 3 - this.data.images.length,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: res => {
        const files = res.tempFiles || []
        const oversized = files.filter(item => Number(item.size) > 10 * 1024 * 1024)
        const paths = files
          .filter(item => Number(item.size) <= 10 * 1024 * 1024)
          .map(item => item.tempFilePath)
          .filter(Boolean)
        if (oversized.length > 0) {
          wx.showToast({ title: '单张图片不能超过10MB', icon: 'none' })
        }
        this.uploadImages(paths)
      },
      fail: err => {
        if (!String(err.errMsg || '').includes('cancel')) {
          wx.showToast({ title: '选择图片失败，请重试', icon: 'none' })
        }
      }
    })
  },

  async uploadImages(paths) {
    if (!paths.length) return
    this.setData({ uploading: true })
    wx.showLoading({ title: '上传中...' })

    const uploaded = []
    let failed = 0
    for (const filePath of paths) {
      try {
        const suffixMatch = String(filePath).match(/\.([a-zA-Z0-9]+)(?:\?|$)/)
        const suffix = suffixMatch ? suffixMatch[1].toLowerCase() : 'jpg'
        const cloudPath = `feedback-images/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${suffix}`
        const result = await wx.cloud.uploadFile({ cloudPath, filePath })
        uploaded.push(result.fileID)
      } catch (err) {
        failed++
        console.error('反馈图片上传失败:', err)
      }
    }

    wx.hideLoading()
    this.setData({
      uploading: false,
      images: this.data.images.concat(uploaded).slice(0, 3)
    }, () => this.saveDraft())

    if (failed > 0) {
      wx.showToast({
        title: uploaded.length > 0 ? `${failed}张图片上传失败，可重试` : '图片上传失败，请重试',
        icon: 'none'
      })
    }
  },

  removeImage(e) {
    const index = Number(e.currentTarget.dataset.index)
    const fileID = this.data.images[index]
    const images = this.data.images.filter((_, itemIndex) => itemIndex !== index)
    this.setData({ images }, () => this.saveDraft())
    if (fileID && String(fileID).startsWith('cloud://')) {
      wx.cloud.deleteFile({ fileList: [fileID] }).catch(err => {
        console.warn('清理已移除反馈图片失败:', err)
      })
    }
  },

  previewImage(e) {
    wx.previewImage({ current: e.currentTarget.dataset.url, urls: this.data.images })
  },

  confirmSubmit() {
    const title = this.data.title.trim()
    const content = this.data.content.trim()
    if (title.length < 2) {
      wx.showToast({ title: '标题至少输入2个字', icon: 'none' })
      return
    }
    if (content.length < 5) {
      wx.showToast({ title: '反馈内容至少输入5个字', icon: 'none' })
      return
    }
    if (this.data.remaining <= 0) {
      wx.showToast({ title: '今日提交次数已用完', icon: 'none' })
      return
    }

    wx.showModal({
      title: '确认提交反馈',
      content: '提交后内容不可修改或删除，是否提交？',
      confirmText: '确认提交',
      success: res => {
        if (res.confirm) this.submitFeedback(title, content)
      }
    })
  },

  getDeviceInfo() {
    const info = app.globalData.systemInfo || {}
    let version = ''
    try {
      const account = wx.getAccountInfoSync()
      version = account && account.miniProgram ? account.miniProgram.version || '' : ''
    } catch (err) {
      console.warn('读取小程序版本失败:', err)
    }
    return {
      platform: info.platform || '',
      system: info.system || '',
      model: info.model || '',
      brand: info.brand || '',
      SDKVersion: info.SDKVersion || '',
      version
    }
  },

  async submitFeedback(title, content) {
    if (this.data.submitting) return
    this.setData({ submitting: true })
    wx.showLoading({ title: '提交中...' })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-feedback',
        data: {
          action: 'submitFeedback',
          title,
          content,
          images: this.data.images,
          deviceInfo: this.getDeviceInfo()
        }
      })
      wx.hideLoading()
      if (result.code !== 0) {
        if (result.code === 429) this.loadSubmitMeta()
        throw new Error(result.message || '提交失败')
      }

      wx.removeStorageSync(DRAFT_KEY)
      this.setData({
        title: '',
        content: '',
        images: [],
        remaining: result.data.remaining
      })
      if (typeof app.updateTabBarBadge === 'function') {
        app.updateTabBarBadge()
      }
      wx.showModal({
        title: '反馈已提交',
        content: '我们已收到你的意见反馈，感谢你帮助我们改进问当地。',
        showCancel: false,
        confirmText: '查看反馈',
        success: () => {
          wx.redirectTo({
            url: `/pages/feedback-detail/feedback-detail?feedbackId=${result.data.feedbackId}`
          })
        }
      })
    } catch (err) {
      wx.hideLoading()
      console.error('提交意见反馈失败:', err)
      wx.showToast({ title: err.message || '提交失败，请重试', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  goToMyFeedback() {
    wx.navigateTo({ url: '/pages/my-feedback/my-feedback' })
  }
})
