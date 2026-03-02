// 发布求助页面
const app = getApp()

// 求助类型配置
const NEED_TYPES = [
  { id: 'weather', name: '实时天气', icon: '🌤️', color: '#74B9FF', bgColor: 'rgba(116, 185, 255, 0.15)' },
  { id: 'traffic', name: '道路拥堵', icon: '🚗', color: '#FDCB6E', bgColor: 'rgba(253, 203, 110, 0.15)' },
  { id: 'shop', name: '店铺营业', icon: '🏪', color: '#A29BFE', bgColor: 'rgba(162, 155, 254, 0.15)' },
  { id: 'parking', name: '停车场空位', icon: '🅿️', color: '#81ECEC', bgColor: 'rgba(129, 236, 236, 0.15)' },
  { id: 'queue', name: '排队情况', icon: '👥', color: '#FD79A8', bgColor: 'rgba(253, 121, 168, 0.15)' },
  { id: 'other', name: '其他', icon: '💬', color: '#A8E6CF', bgColor: 'rgba(168, 230, 207, 0.15)' }
]

// 有效期选项
const TIME_OPTIONS = [
  { value: 30, label: '30分钟', recommended: false },
  { value: 60, label: '1小时', recommended: true },
  { value: 120, label: '2小时', recommended: false },
  { value: 240, label: '4小时', recommended: false },
  { value: 720, label: '12小时', recommended: false },
  { value: 1440, label: '24小时', recommended: false }
]

Page({
  data: {
    // 地图位置
    longitude: 104.0668,  // 成都默认经度
    latitude: 30.5728,    // 成都默认纬度
    locationName: '',
    selectedLocation: '',

    // 常用地点（成都）
    quickLocations: ['春熙路', '太古里', '天府广场', '宽窄巷子', '锦里', '成都东站'],

    // 求助类型
    needTypes: NEED_TYPES,
    selectedType: '',

    // 描述
    description: '',

    // 有效期
    timeOptions: TIME_OPTIONS,
    selectedTime: 1440,  // 默认24小时

    // 悬赏积分
    rewardPoints: 20,
    quickPoints: [10, 20, 30, 50, 100],
    availablePoints: 0,
    estimateValue: '2.0',

    // 发布状态
    isPublishing: false,
    canPublish: false
  },

  onLoad() {
    this.initUserInfo()
    this.getCurrentLocation()
  },

  // 初始化用户信息
  initUserInfo() {
    const userInfo = app.getUserInfo()
    if (userInfo) {
      this.setData({
        availablePoints: userInfo.available_points || 0
      })
      this.checkCanPublish()
    }
  },

  // 返回上一页
  goBack() {
    wx.navigateBack()
  },

  // 获取当前位置
  getCurrentLocation() {
    wx.getLocation({
      type: 'gcj02',
      success: (res) => {
        this.setData({
          longitude: res.longitude,
          latitude: res.latitude
        })
        // 逆向地理编码获取地址名称
        this.reverseGeocode(res.longitude, res.latitude)
      },
      fail: () => {
        wx.showToast({
          title: '定位失败，请手动输入',
          icon: 'none'
        })
      }
    })
  },

  // 逆向地理编码（简化版，实际应调用腾讯地图API）
  reverseGeocode(longitude, latitude) {
    // 这里简化处理，实际项目中应调用腾讯地图SDK
    this.setData({
      locationName: '当前位置附近'
    })
  },

  // 地图点击
  onMapTap(e) {
    const { longitude, latitude } = e.detail
    this.setData({
      longitude,
      latitude
    })
    this.reverseGeocode(longitude, latitude)
  },

  // 地址输入
  onLocationInput(e) {
    this.setData({
      locationName: e.detail.value
    })
    this.checkCanPublish()
  },

  // 选择常用地点
  selectQuickLocation(e) {
    const location = e.currentTarget.dataset.location
    this.setData({
      locationName: location,
      selectedLocation: location
    })
    this.checkCanPublish()
  },

  // 选择类型
  selectType(e) {
    const type = e.currentTarget.dataset.type
    this.setData({
      selectedType: type
    })
    this.checkCanPublish()
  },

  // 描述输入
  onDescriptionInput(e) {
    this.setData({
      description: e.detail.value
    })
  },

  // 选择有效期
  selectTime(e) {
    const time = e.currentTarget.dataset.time
    this.setData({
      selectedTime: time
    })
  },

  // 积分滑块变化
  onPointsChange(e) {
    const rewardPoints = e.detail.value
    this.setData({
      rewardPoints,
      estimateValue: (rewardPoints / 10).toFixed(1)
    })
    this.checkCanPublish()
  },

  // 选择快捷积分
  selectQuickPoints(e) {
    const points = e.currentTarget.dataset.points
    this.setData({
      rewardPoints: points,
      estimateValue: (points / 10).toFixed(1)
    })
    this.checkCanPublish()
  },

  // 检查是否可以发布
  checkCanPublish() {
    const { locationName, selectedType, rewardPoints, availablePoints } = this.data
    const canPublish = locationName && selectedType && rewardPoints <= availablePoints
    this.setData({ canPublish })
  },

  // 发布求助
  async handlePublish() {
    if (!this.data.canPublish || this.data.isPublishing) return

    const {
      longitude,
      latitude,
      locationName,
      selectedType,
      description,
      selectedTime,
      rewardPoints
    } = this.data

    // 找到类型信息
    const typeInfo = NEED_TYPES.find(t => t.id === selectedType)

    this.setData({ isPublishing: true })

    try {
      wx.showLoading({ title: '发布中...' })

      const { result } = await wx.cloud.callFunction({
        name: 'wdd-publish',
        data: {
          location: {
            longitude,
            latitude,
            name: locationName
          },
          type: selectedType,
          typeName: typeInfo.name,
          description: description,
          expireMinutes: selectedTime,
          points: rewardPoints
        }
      })

      wx.hideLoading()

      if (result.code === 0) {
        // 更新本地积分
        const userInfo = app.getUserInfo()
        userInfo.available_points -= rewardPoints
        userInfo.frozen_points += rewardPoints
        app.updateUserInfo(userInfo)

        wx.showToast({
          title: '发布成功',
          icon: 'success',
          duration: 2000
        })

        // 跳转到聊天页
        setTimeout(() => {
          wx.navigateTo({
            url: `/pages/chat/chat?needId=${result.data.needId}`
          })
        }, 1500)
      } else {
        throw new Error(result.message)
      }
    } catch (err) {
      wx.hideLoading()
      this.setData({ isPublishing: false })
      wx.showToast({
        title: err.message || '发布失败',
        icon: 'none'
      })
    }
  }
})
