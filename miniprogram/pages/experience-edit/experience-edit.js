const { requirePrivacyAuthorize } = require('../../utils/privacy')
const { getByType } = require('../../utils/needTypes')

const FRESHNESS_OPTIONS = [
  '1小时内有效',
  '今天内有效',
  '明天前有效',
  '3天内有效',
  '7天内有效',
  '30天内有效'
]

const EXPERIENCE_CALL_TIMEOUT = 60000
const MAX_AI_GENERATION_ATTEMPTS = 2

function trimText(value) {
  return String(value || '').trim()
}

function buildTitleFromTask(task = {}) {
  const typeName = task.typeName || '查经验'
  const description = trimText(task.description).slice(0, 28)
  return description ? `${typeName}：${description}`.slice(0, 50) : `${typeName}经验分享`
}

function getFreshnessIndex(value) {
  const index = FRESHNESS_OPTIONS.indexOf(value)
  return index >= 0 ? index : -1
}

function getExperienceErrorMessage(err) {
  const raw = String((err && (err.errMsg || err.message)) || err || '')
  if (/timeout|timed out|超时/i.test(raw)) {
    return '经验草稿生成超时，请稍后重试；也可以先手动填写经验内容'
  }
  if (/FunctionName|function.*not.*found|云函数.*不存在|not exist/i.test(raw)) {
    return '查经验服务还没有部署，请先部署 wdd-experience 云函数'
  }
  return raw || '整理失败，请稍后重试'
}

function shouldRetryDraftGeneration(experience = {}) {
  if (!experience || experience.status !== 'draft') return false
  if (trimText(experience.result)) return false
  if (!experience.ai_generation_status) return true
  if (experience.ai_generation_status !== 'fallback') return false
  const attempts = Number(experience.ai_generation_attempt_count || experience.ai_generation_retry_count) || 0
  return attempts < MAX_AI_GENERATION_ATTEMPTS
}

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
    task: {
      type: '',
      typeName: '任务类型',
      typeIcon: 'tag',
      description: '',
      locationName: '',
      longitude: null,
      latitude: null
    },
    freshnessOptions: FRESHNESS_OPTIONS,
    freshnessIndex: -1,
    form: {
      title: '',
      publicLocation: '',
      question: '',
      result: '',
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
        data: { action: 'getEditor', needId: this.data.needId },
        timeout: EXPERIENCE_CALL_TIMEOUT
      })
      if (result.code !== 0) throw new Error(result.message)
      if (result.data.experience) {
        this.applyExperience(result.data)
        if (shouldRetryDraftGeneration(result.data.experience)) {
          const regenerated = await wx.cloud.callFunction({
            name: 'wdd-experience',
            data: { action: 'createDraft', needId: this.data.needId },
            timeout: EXPERIENCE_CALL_TIMEOUT
          })
          if (regenerated.result.code !== 0) throw new Error(regenerated.result.message)
          this.applyExperience(regenerated.result.data)
          if (regenerated.result.data.warning) {
            wx.showToast({ title: regenerated.result.data.warning, icon: 'none', duration: 3000 })
          }
        }
      } else {
        const created = await wx.cloud.callFunction({
          name: 'wdd-experience',
          data: { action: 'createDraft', needId: this.data.needId },
          timeout: EXPERIENCE_CALL_TIMEOUT
        })
        if (created.result.code !== 0) throw new Error(created.result.message)
        this.applyExperience(created.result.data)
        if (created.result.data.warning) {
          wx.showToast({ title: created.result.data.warning, icon: 'none', duration: 3000 })
        }
      }
    } catch (err) {
      wx.showToast({ title: getExperienceErrorMessage(err), icon: 'none', duration: 3000 })
    } finally {
      wx.hideLoading()
      this.setData({ loading: false })
    }
  },

  async loadExisting() {
    const { result } = await wx.cloud.callFunction({
      name: 'wdd-experience',
      data: { action: 'getEditor', needId: this.data.needId },
      timeout: EXPERIENCE_CALL_TIMEOUT
    })
    if (result.code === 0 && result.data.experience) this.applyExperience(result.data)
  },

  applyExperience(data) {
    const item = data.experience || {}
    const task = data.task || this.data.task || {}
    const selectedImages = item.images || []
    const availableImages = (data.availableImages || []).map(url => ({
      url,
      selected: selectedImages.includes(url)
    }))
    const publicLocation = item.public_location || item.publicLocation || task.locationName || ''
    const freshness = item.freshness || ''
    const typeInfo = getByType(task.type || 'other')
    this.setData({
      task: {
        type: task.type || '',
        typeName: task.typeName || '任务类型',
        typeIcon: typeInfo.icon || 'tag',
        description: task.description || '',
        locationName: task.locationName || '',
        longitude: Number(task.longitude) || null,
        latitude: Number(task.latitude) || null
      },
      experienceId: item._id || this.data.experienceId,
      status: item.status || 'draft',
      submittedOnce: !!item.submitted_once,
      editable: data.editable !== false && ['draft', 'pending_confirmation'].includes(item.status || 'draft'),
      availableImages,
      selectedImages,
      freshnessIndex: getFreshnessIndex(freshness),
      form: {
        title: item.title || buildTitleFromTask(task),
        publicLocation,
        question: item.question || task.description || '',
        result: item.result || '',
        freshness,
        tips: item.tips || ''
      }
    })
  },

  onFieldInput(e) {
    this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value })
  },

  onFreshnessChange(e) {
    const index = Number(e.detail.value)
    const freshness = this.data.freshnessOptions[index] || ''
    this.setData({
      freshnessIndex: index,
      'form.freshness': freshness
    })
  },

  async choosePublicLocation() {
    if (!this.data.editable) return
    try {
      await requirePrivacyAuthorize()
    } catch (err) {
      const msg = err.errno === 112 ? '定位服务暂不可用' : '需要同意隐私协议'
      wx.showToast({ title: msg, icon: 'none' })
      return
    }

    const task = this.data.task || {}
    const options = {
      success: res => {
        this.setData({
          'form.publicLocation': res.name || res.address || '选定位置'
        })
      },
      fail: err => {
        if (err.errMsg && err.errMsg.includes('cancel')) return
        wx.showToast({ title: '选择地点失败', icon: 'none' })
      }
    }
    if (task.latitude && task.longitude) {
      options.latitude = task.latitude
      options.longitude = task.longitude
    }
    wx.chooseLocation(options)
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

  validateForm() {
    const form = this.data.form
    if (trimText(form.title).length < 2) return '标题至少填写2个字'
    if (!trimText(form.publicLocation)) return '请填写公开地点'
    if (trimText(form.question).length < 2) return '请填写公开描述'
    if (trimText(form.result).length < 2) return '请填写任务结果'
    if (!trimText(form.freshness)) return '请选择信息有效期'
    return ''
  },

  submit() {
    const message = this.validateForm()
    if (message) {
      wx.showToast({ title: message, icon: 'none' })
      return
    }
    this.preview()
  },

  async confirmSubmit() {
    if (!this.data.editable || this.data.saving) return
    const wasSubmitted = this.data.submittedOnce
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
      if (!wasSubmitted && !(result.data && result.data.hasRated)) {
        setTimeout(() => {
          wx.redirectTo({ url: `/pages/rating/rating?needId=${this.data.needId}&type=seeker` })
        }, 900)
      }
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
