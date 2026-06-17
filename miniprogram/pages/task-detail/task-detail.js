// 任务详情页
const app = getApp()
const { MoneyUtils, PLATFORM_RULES } = require('../../utils/platformRules')
const { getByType, getByStatus } = require('../../utils/needTypes')

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
    canReport: false,
    canAppeal: false,
    showMoreMenu: false,
    showActionBar: false,
    pagePaddingBottom: 0,
    loading: true,
    feeRate: Math.round(PLATFORM_RULES.PLATFORM_FEE_RATE * 100)
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
        const isParticipant = !!(isSeeker || isTaker)

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
        const rewardAmount = task.rewardAmount || 0
        task._displayAmount = rewardAmount
        task._platformFee = MoneyUtils.calcPlatformFee(rewardAmount)
        task._takerIncome = MoneyUtils.calcTakerIncome(rewardAmount)
        task._distanceText = this.formatDistance(task.distance)
        task._orderNo = task.need_id || task._id
        task._locationSubText = this.getLocationSubText(task)

        const canReport = isParticipant &&
          ['ongoing', 'completed'].includes(task.status) &&
          !task.hasMyReport

        const canAppeal = isParticipant &&
          (task.status === 'completed' || this.canAppealCancelledTask(task)) &&
          !task.hasMyAppeal

        const hasStatusTip = ['breaking', 'completed', 'cancelled'].includes(task.status)
        const showActionBar = canTake || canChat || canComplete || canCancel || hasStatusTip
        const hasTwoActions = (canChat && canComplete)
        const pagePaddingBottom = showActionBar ? (hasTwoActions ? 188 : 164) : 0

        this.setData({
          task,
          isSeeker,
          isTaker,
          canTake,
          canChat,
          canComplete,
          canCancel,
          canReport,
          canAppeal,
          showActionBar,
          pagePaddingBottom,
          showMoreMenu: false,
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
    if (distance === undefined || distance === null) return ''
    const value = Number(distance)
    if (!isFinite(value) || value >= 999000) return ''
    return value < 1000 ? `${Math.round(value)}m` : `${(value / 1000).toFixed(1)}km`
  },

  getLocationSubText(task) {
    const parts = []
    if (task.address) parts.push(task.address)
    if (task._distanceText) parts.push(`距你 ${task._distanceText}`)
    return parts.join(' · ')
  },

  canAppealCancelledTask(task) {
    if (task.status !== 'cancelled' || task.cancelReason !== 'arbitration_cancelled') {
      return false
    }
    const endTime = task.cancelTime || task.cancel_time
    if (!endTime) return false
    const deadline = new Date(new Date(endTime).getTime() + 2 * 60 * 60 * 1000)
    return new Date() <= deadline
  },

  toggleMoreMenu() {
    this.setData({ showMoreMenu: !this.data.showMoreMenu })
  },

  hideMoreMenu() {
    this.setData({ showMoreMenu: false })
  },

  noop() {},

  goToReport() {
    if (!this.data.canReport) return
    this.hideMoreMenu()
    wx.navigateTo({
      url: `/pages/report/report?mode=initiate&needId=${this.data.needId}`
    })
  },

  goToAppeal() {
    if (!this.data.canAppeal) return
    this.hideMoreMenu()
    wx.navigateTo({
      url: `/pages/appeal/appeal?mode=initiate&needId=${this.data.needId}`
    })
  },

  // 接单
  async takeTask() {
    if (!this.data.canTake) return

    const rewardAmount = this.data.task.rewardAmount || 0
    const takerIncome = MoneyUtils.calcTakerIncome(rewardAmount)
    const feeRate = Math.round(PLATFORM_RULES.PLATFORM_FEE_RATE * 100)

    wx.showModal({
      title: '确认去帮助',
      content: `完成此任务可获得 ¥${takerIncome}（已扣除${feeRate}%平台服务费），确定要去帮助吗？`,
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '处理中...' })

          try {
            const { result } = await wx.cloud.callFunction({
              name: 'wdd-take-need',
              data: {
                needId: this.data.needId
              }
            })

            wx.hideLoading()

            if (result.code === 0) {
              wx.showToast({
                title: '已开始帮助',
                icon: 'success'
              })

              // 进入聊天页
              setTimeout(() => {
                wx.navigateTo({
                  url: `/pages/chat/chat?needId=${this.data.needId}`
                })
              }, 1500)
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
        }
      }
    })
  },

  // 进入聊天
  goToChat() {
    if (!this.data.canChat) return

    wx.navigateTo({
      url: `/pages/chat/chat?needId=${this.data.needId}`
    })
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

        // 跳转到评价页
        setTimeout(() => {
          wx.navigateTo({
            url: `/pages/rating/rating?needId=${this.data.needId}`
          })
        }, 1500)
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
