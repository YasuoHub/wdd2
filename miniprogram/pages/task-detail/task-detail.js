// 任务详情页
const app = getApp()
const { MoneyUtils } = require('../../utils/platformRules')
const { getByType, getByStatus } = require('../../utils/needTypes')
const { formatDistanceText } = require('../../utils/distance')

Page({
  data: {
    needId: '',
    task: null,
    userInfo: null,
    isSeeker: false,
    isTaker: false,
    canTake: false,
    canChat: false,
    canComplete: false,
    canCancel: false,
    showActionBar: false,
    loading: true,
    showTakeConfirm: false,
    takeShareAuthorized: false
  },

  onLoad(options) {
    const { id } = options
    if (!id) {
      wx.showToast({ title: '任务ID错误', icon: 'none' })
      wx.navigateBack()
      return
    }

    this.setData({
      needId: id,
      userInfo: app.globalData.userInfo
    })

    this.loadTaskDetail()
  },

  onShow() {
    if (this.data.needId) {
      this.loadTaskDetail()
    }
  },

  // 加载任务详情
  async loadTaskDetail() {
    this.setData({ loading: true })

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-get-needs',
        data: {
          action: 'getNeedDetail',
          needId: this.data.needId
        }
      })

      if (result.code === 0) {
        const task = result.data
        const userInfo = this.data.userInfo

        // 判断身份
        const isSeeker = userInfo && task.user_id === userInfo._id
        const isTaker = userInfo && task.taker_id === userInfo._id

        // 判断可操作权限
        const canTake = userInfo &&
                         task.status === 'pending' &&
                         !isSeeker &&
                         task.user_id !== userInfo._id

        const canChat = (isSeeker || isTaker) &&
                        task.status === 'ongoing'

        const canComplete = isSeeker &&
                            task.status === 'ongoing'

        const canCancel = isSeeker &&
                          task.status === 'pending'

        // 本地兜底：type / status 字段缺失时补默认值
        const normalizedType = task.type || task.taskType || task.task_type || task.needType || task.need_type || 'other'
        const typeInfo = getByType(normalizedType) || getByType('other')
        if (typeInfo) {
          task.type = normalizedType
          task.typeName = typeInfo.name
          task.typeIcon = typeInfo.icon
          task.color = typeInfo.color
          task.bgColor = typeInfo.bgColor
          task.typeColor = typeInfo.color
          task.typeBgColor = typeInfo.bgColor
        }
        const statusInfo = getByStatus(task.status)
        task.statusText = statusInfo.text
        task.statusIcon = statusInfo.icon

        // 计算金额显示值（避免WXML中写死比例）
        const rewardAmount = Number(task.rewardAmount || task.reward_amount || 0)
        const takerIncome = Number(task.takerIncome || MoneyUtils.calcTakerIncome(rewardAmount))
        task.rewardAmount = rewardAmount
        task._takerIncome = takerIncome
        task._displayAmount = isSeeker ? rewardAmount : takerIncome
        task._distanceText = this.formatDistance(task.distance)
        task._orderNo = task.task_no
        task._locationSubText = this.getLocationSubText(task)
        task._takerPlaceholderText = task.status === 'cancelled' ? '--' : '等待帮助者响应'

        const showActionBar = canTake || canChat || canComplete || canCancel

        this.setData({
          task,
          isSeeker,
          isTaker,
          canTake,
          canChat,
          canComplete,
          canCancel,
          showActionBar,
          loading: false
        })
      } else {
        throw new Error(result.message)
      }
    } catch (err) {
      console.error('加载任务详情失败:', err)
      wx.showToast({
        title: '加载失败',
        icon: 'none'
      })
      this.setData({ loading: false })
    }
  },

  formatDistance(distance) {
    return formatDistanceText(distance)
  },

  getLocationSubText(task) {
    const parts = []
    if (task.address) parts.push(task.address)
    if (task._distanceText) parts.push(`距你 ${task._distanceText}`)
    return parts.join(' · ')
  },

  // 接单
  async takeTask() {
    if (!this.data.canTake) return

    const takerIncome = this.data.task._takerIncome || 0

    this.setData({
      showTakeConfirm: true,
      takeShareAuthorized: false
    })
  },

  closeTakeConfirm() {
    this.setData({ showTakeConfirm: false, takeShareAuthorized: false })
  },

  toggleTakeShareAuthorization() {
    this.setData({ takeShareAuthorized: !this.data.takeShareAuthorized })
  },

  async confirmTakeTask() {
    const authorized = this.data.takeShareAuthorized
    this.closeTakeConfirm()
    wx.showLoading({ title: '处理中...' })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-take-need',
        data: {
          needId: this.data.needId,
          experienceShareAuthorized: authorized,
          authorizationVersion: 'experience-share-v1'
        }
      })
      if (result.code !== 0) throw new Error(result.message)
      wx.showToast({ title: '已开始帮助', icon: 'success' })
      setTimeout(() => {
        wx.navigateTo({ url: `/pages/chat/chat?needId=${this.data.needId}` })
      }, 1000)
    } catch (err) {
      wx.showToast({ title: err.message || '操作失败', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  // 进入聊天
  goToChat() {
    if (!this.data.canChat) return

    wx.navigateTo({
      url: `/pages/chat/chat?needId=${this.data.needId}`
    })
  },

  isTaskAlreadyAcceptedError(result) {
    return result && result.errorCode === 'TASK_ALREADY_ACCEPTED'
  },

  openChatAfterCancelRejected(needId) {
    if (!needId) return
    app.globalData.refreshMyNeeds = true
    this.loadTaskDetail()
    wx.showToast({
      title: '已接单，打开聊天',
      icon: 'none',
      duration: 900
    })
    setTimeout(() => {
      wx.navigateTo({
        url: `/pages/chat/chat?needId=${needId}`
      })
    }, 900)
  },

  // 跳转公开资料页
  goToPublicProfile(e) {
    const { userid } = e.currentTarget.dataset
    if (!userid) return
    wx.navigateTo({
      url: `/pages/public-profile/public-profile?userId=${userid}`
    })
  },

  // 确认完成
  completeTask() {
    if (!this.data.canComplete) return

    wx.showModal({
      title: '确认完成',
      content: '确认帮助者已完成任务？悬赏金额将结算给对方',
      success: (res) => {
        if (res.confirm) {
          this.doCompleteTask()
        }
      }
    })
  },

  async doCompleteTask() {
    wx.showLoading({ title: '处理中...' })

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-settlement',
        data: {
          action: 'completeTask',
          needId: this.data.needId
        }
      })

      wx.hideLoading()

      if (result.code === 0) {
        wx.showToast({
          title: '任务已完成',
          icon: 'success'
        })

        // 设置刷新标记
        app.globalData.refreshMyNeeds = true
        app.globalData.refreshMyTasks = true

        setTimeout(() => this.promptExperienceShare(), 700)
      } else {
        throw new Error(result.message)
      }
    } catch (err) {
      wx.hideLoading()
      wx.showToast({
        title: err.message || '操作失败',
        icon: 'none'
      })
    }
  },

  promptExperienceShare() {
    wx.showModal({
      title: '分享经验',
      content: '是否将本次任务整理成公开经验，帮助有相同问题的人？',
      confirmText: '申请分享',
      cancelText: '暂不分享',
      success: res => {
        if (res.confirm) {
          wx.navigateTo({ url: `/pages/experience-edit/experience-edit?needId=${this.data.needId}` })
        } else {
          wx.navigateTo({ url: `/pages/rating/rating?needId=${this.data.needId}&type=seeker` })
        }
      }
    })
  },

  // 取消任务
  cancelTask() {
    if (!this.data.canCancel) return

    wx.showModal({
      title: '确认取消',
      content: '取消后悬赏金额将原路退回，确定要取消吗？',
      confirmColor: '#ff4d4f',
      success: (res) => {
        if (res.confirm) {
          this.doCancelTask()
        }
      }
    })
  },

  async doCancelTask() {
    wx.showLoading({ title: '处理中...' })

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-settlement',
        data: {
          action: 'cancelTask',
          needId: this.data.needId
        }
      })

      wx.hideLoading()

      if (result.code === 0) {
        wx.showToast({
          title: result.message || '已取消',
          icon: 'none',
          duration: 2500
        })
        // 设置刷新标记
        app.globalData.refreshMyNeeds = true
        this.loadTaskDetail()
      } else if (this.isTaskAlreadyAcceptedError(result)) {
        this.openChatAfterCancelRejected(this.data.needId)
      } else {
        throw new Error(result.message)
      }
    } catch (err) {
      wx.hideLoading()
      wx.showToast({
        title: err.message || '取消失败',
        icon: 'none'
      })
    }
  },

  // 预览位置
  previewLocation() {
    const { location, locationName } = this.data.task
    // 使用 GeoJSON 格式: coordinates: [经度, 纬度]
    if (!location || !location.coordinates || !Array.isArray(location.coordinates)) {
      wx.showToast({ title: '位置信息不完整', icon: 'none' })
      return
    }

    const [longitude, latitude] = location.coordinates
    wx.openLocation({
      latitude: latitude,
      longitude: longitude,
      name: locationName || '求助位置',
      address: locationName || ''
    })
  },

  // 预览任务图片
  previewTaskImages(e) {
    const { index } = e.currentTarget.dataset
    const { images } = this.data.task
    wx.previewImage({
      current: images[index],
      urls: images
    })
  }
})
