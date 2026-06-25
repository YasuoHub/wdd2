Page({
  data: {
    needId: '',
    experienceId: '',
    status: '',
    submittedOnce: false,
    editable: true,
    loading: true,
    saving: false,
    showPreview: false,
    availableImages: [],
    selectedImages: [],
    form: {
      title: '',
      publicLocation: '',
      question: '',
      result: '',
      applicableTime: '',
      freshness: '',
      tips: ''
    }
  },

  onLoad(options) {
    this.setData({ needId: options.needId || '' })
    this.loadEditor()
  },

  onShow() {
    if (this.data.experienceId) this.loadExisting()
  },

  async loadEditor() {
    wx.showLoading({ title: '正在整理...' })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-experience',
        data: { action: 'getEditor', needId: this.data.needId }
      })
      if (result.code !== 0) throw new Error(result.message)
      if (result.data.experience) {
        this.applyExperience(result.data)
      } else {
        const created = await wx.cloud.callFunction({
          name: 'wdd-experience',
          data: { action: 'createDraft', needId: this.data.needId }
        })
        if (created.result.code !== 0) throw new Error(created.result.message)
        this.applyExperience(created.result.data)
        if (created.result.data.warning) {
          wx.showToast({ title: created.result.data.warning, icon: 'none', duration: 3000 })
        }
      }
    } catch (err) {
      wx.showToast({ title: err.message || '整理失败', icon: 'none' })
    } finally {
      wx.hideLoading()
      this.setData({ loading: false })
    }
  },

  async loadExisting() {
    const { result } = await wx.cloud.callFunction({
      name: 'wdd-experience',
      data: { action: 'getEditor', needId: this.data.needId }
    })
    if (result.code === 0 && result.data.experience) this.applyExperience(result.data)
  },

  applyExperience(data) {
    const item = data.experience || {}
    const selectedImages = item.images || []
    const availableImages = (data.availableImages || []).map(url => ({
      url,
      selected: selectedImages.includes(url)
    }))
    this.setData({
      experienceId: item._id || this.data.experienceId,
      status: item.status || 'draft',
      submittedOnce: !!item.submitted_once,
      editable: data.editable !== false && ['draft', 'pending_confirmation'].includes(item.status || 'draft'),
      availableImages,
      selectedImages,
      form: {
        title: item.title || '',
        publicLocation: item.public_location || item.publicLocation || '',
        question: item.question || '',
        result: item.result || '',
        applicableTime: item.applicable_time || item.applicableTime || '',
        freshness: item.freshness || '',
        tips: item.tips || ''
      }
    })
  },

  onFieldInput(e) {
    this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value })
  },

  toggleImage(e) {
    if (!this.data.editable) return
    const url = e.currentTarget.dataset.url
    const selected = this.data.selectedImages.slice()
    const index = selected.indexOf(url)
    if (index >= 0) selected.splice(index, 1)
    else selected.push(url)
    this.setData({
      selectedImages: selected,
      availableImages: this.data.availableImages.map(item => ({
        ...item,
        selected: selected.includes(item.url)
      }))
    })
  },

  preview() {
    this.setData({ showPreview: true })
  },

  closePreview() {
    if (this.data.saving) return
    this.setData({ showPreview: false })
  },

  submit() {
    const form = this.data.form
    if (String(form.title || '').trim().length < 2) {
      wx.showToast({ title: '标题至少填写2个字', icon: 'none' })
      return
    }
    if (!String(form.publicLocation || '').trim()) {
      wx.showToast({ title: '请填写公开地点', icon: 'none' })
      return
    }
    if (String(form.question || '').trim().length < 2 || String(form.result || '').trim().length < 2) {
      wx.showToast({ title: '请完善问题和实际结果', icon: 'none' })
      return
    }
    this.preview()
  },

  async confirmSubmit() {
    if (!this.data.editable || this.data.saving) return
    this.setData({ saving: true })
    wx.showLoading({ title: '提交中...' })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-experience',
        data: {
          action: 'saveDraft',
          experienceId: this.data.experienceId,
          content: { ...this.data.form, images: this.data.selectedImages }
        }
      })
      if (result.code !== 0) throw new Error(result.message)
      this.setData({ submittedOnce: true, status: 'pending_confirmation', showPreview: false })
      wx.showToast({ title: result.message, icon: 'success' })
      getApp().globalData.refreshMyNeeds = true
    } catch (err) {
      wx.showToast({ title: err.message || '提交失败', icon: 'none' })
      await this.loadExisting()
    } finally {
      wx.hideLoading()
      this.setData({ saving: false })
    }
  },

  cancelShare() {
    wx.showModal({
      title: '取消分享',
      content: `取消后，本任务不能再次申请分享。确定取消经验分享“${this.data.form.title}”吗？`,
      confirmText: '取消分享',
      confirmColor: '#d64545',
      success: res => {
        if (res.confirm) this.doCancelShare()
      }
    })
  },

  async doCancelShare() {
    wx.showLoading({ title: '处理中...' })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-experience',
        data: { action: 'cancelShare', experienceId: this.data.experienceId }
      })
      if (result.code !== 0) throw new Error(result.message)
      wx.showToast({ title: '已取消分享', icon: 'success' })
      getApp().globalData.refreshMyNeeds = true
      setTimeout(() => wx.navigateBack(), 900)
    } catch (err) {
      wx.showToast({ title: err.message || '取消失败', icon: 'none' })
      await this.loadExisting()
    } finally {
      wx.hideLoading()
    }
  }
})
