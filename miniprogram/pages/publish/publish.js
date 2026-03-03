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

    // 常用地点（成都）- 包含名称和经纬度
    quickLocations: [
      { name: '春熙路', longitude: 104.0784, latitude: 30.6574 },
      { name: '太古里', longitude: 104.0779, latitude: 30.6566 },
      { name: '天府广场', longitude: 104.0668, latitude: 30.5728 },
      { name: '宽窄巷子', longitude: 104.0556, latitude: 30.6633 },
      { name: '锦里', longitude: 104.0486, latitude: 30.6424 },
      { name: '成都东站', longitude: 104.1396, latitude: 30.6304 }
    ],

    // 求助类型
    needTypes: NEED_TYPES,
    selectedType: '',

    // 描述
    description: '',

    // 有效期
    timeOptions: TIME_OPTIONS,
    selectedTime: 60,  // 默认1小时（与推荐一致）

    // 悬赏积分
    rewardPoints: 20,
    quickPoints: [10, 20, 30, 50, 100],
    availablePoints: 0,
    estimateValue: '2.0',

    // 发布状态
    isPublishing: false,
    canPublish: false,

    // 图片上传
    images: [], // 已选择的图片列表
    maxImageCount: 3,
    maxImageSize: 10 * 1024 * 1024 // 10MB
  },

  onLoad(options) {
    this.initUserInfo()

    // 获取当前位置仅用于地图初始化中心点
    this.initMapCenter()

    // 如果传入了类型参数，自动选择对应类型
    if (options.type) {
      this.autoSelectType(options.type)
    }
  },

  // 初始化地图中心点（仅用于地图展示，不填充表单）
  async initMapCenter() {
    try {
      const res = await wx.getLocation({ type: 'gcj02' })
      this.setData({
        longitude: res.longitude,
        latitude: res.latitude
      })
    } catch (err) {
      console.log('获取当前位置失败，使用默认位置')
      // 使用默认的成都位置
    }
  },

  // 自动选择类型（从首页快捷入口进入）
  autoSelectType(type) {
    const typeItem = NEED_TYPES.find(item => item.id === type)
    if (typeItem) {
      this.setData({
        selectedType: type
      })
      // 设置CSS变量用于类型颜色
      const query = wx.createSelectorQuery()
      query.select('.type-item.active').fields({ dataset: true }, () => {
        // 类型已选中
      }).exec()
    }
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

  // 选择地点
  goToLocationPicker() {
    console.log('打开地图选择，当前位置:', this.data.latitude, this.data.longitude)
    wx.chooseLocation({
      latitude: this.data.latitude,
      longitude: this.data.longitude,
      success: (res) => {
        this.setData({
          longitude: res.longitude,
          latitude: res.latitude,
          locationName: res.name || res.address || '选定位置',
          addressDetail: res.address,
          selectedLocation: '' // 清除常用地点的选中态
        })
        this.checkCanPublish()
      },
      fail: (err) => {
        // 用户取消选择或其他错误
        if (err.errMsg && err.errMsg.includes('cancel')) {
          console.log('用户取消选择地点')
        } else {
          console.error('选择地点失败:', err)
          wx.showToast({
            title: '选择地点失败',
            icon: 'none'
          })
        }
      }
    })
  },

  // 获取当前位置
  async getCurrentLocation() {
    try {
      const res = await wx.getLocation({ type: 'gcj02' })
      this.setData({
        longitude: res.longitude,
        latitude: res.latitude
      })
      // 逆向地理编码获取地址名称
      await this.reverseGeocode(res.longitude, res.latitude)
    } catch (err) {
      wx.showToast({
        title: '定位失败，请手动输入',
        icon: 'none'
      })
    }
  },

  // 逆向地理编码 - 调用腾讯地图API获取真实地址
  reverseGeocode(longitude, latitude) {
    const QQ_MAP_KEY = 'LTXBZ-6QBEW-T7CRL-YCDUQ-WHXFK-GSFRJ'

    wx.request({
      url: `https://apis.map.qq.com/ws/geocoder/v1/?location=${latitude},${longitude}&key=${QQ_MAP_KEY}&get_poi=0`,
      success: (res) => {
        if (res.data.status === 0 && res.data.result) {
          const result = res.data.result
          // 优先使用推荐地址
          const addressName = result.formatted_addresses?.recommend
            || result.formatted_addresses?.standard_address
            || result.address
            || '未知位置'

          this.setData({
            locationName: addressName
          })
          this.checkCanPublish()
        } else {
          console.error('逆地理编码失败:', res.data)
          this.setData({
            locationName: '未知位置'
          })
        }
      },
      fail: (err) => {
        console.error('请求腾讯地图API失败:', err)
        this.setData({
          locationName: '未知位置'
        })
      }
    })
  },

  // 地图点击
  async onMapTap(e) {
    const { longitude, latitude } = e.detail
    this.setData({
      longitude,
      latitude,
      selectedLocation: '' // 清除常用地点选中态
    })
    await this.reverseGeocode(longitude, latitude)
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
      locationName: location.name,
      selectedLocation: location.name,
      longitude: location.longitude,
      latitude: location.latitude
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

  // 选择图片
  chooseImage() {
    const { images, maxImageCount } = this.data
    const remainCount = maxImageCount - images.length

    if (remainCount <= 0) {
      wx.showToast({ title: '最多上传3张图片', icon: 'none' })
      return
    }

    wx.chooseMedia({
      count: remainCount,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: (res) => {
        const newImages = res.tempFiles.map(file => ({
          path: file.tempFilePath,
          size: file.size
        }))

        // 检查每张图片大小
        const oversizedImages = newImages.filter(img => img.size > this.data.maxImageSize)
        if (oversizedImages.length > 0) {
          wx.showToast({ title: '单张图片不能超过10MB', icon: 'none' })
          return
        }

        this.setData({
          images: [...images, ...newImages]
        })
      }
    })
  },

  // 预览图片
  previewImage(e) {
    const { index } = e.currentTarget.dataset
    const urls = this.data.images.map(img => img.path)
    wx.previewImage({
      current: urls[index],
      urls
    })
  },

  // 删除图片
  deleteImage(e) {
    const { index } = e.currentTarget.dataset
    const images = [...this.data.images]
    images.splice(index, 1)
    this.setData({ images })
  },

  // 上传图片到云存储
  async uploadImages() {
    const { images } = this.data
    if (images.length === 0) return []

    const uploadTasks = images.map((img, index) => {
      const cloudPath = `need-images/${Date.now()}-${index}-${Math.random().toString(36).substr(2, 6)}.jpg`
      return wx.cloud.uploadFile({
        cloudPath,
        filePath: img.path
      })
    })

    const results = await Promise.all(uploadTasks)
    return results.map(res => res.fileID)
  },

  // 发布求助
  async handlePublish() {
    if (this.data.isPublishing) return

    // 前置校验，给出明确提示
    const { locationName, selectedType, rewardPoints, availablePoints } = this.data

    if (!locationName) {
      wx.showToast({
        title: '请先选择地点',
        icon: 'none',
        duration: 2000
      })
      return
    }

    if (!selectedType) {
      wx.showToast({
        title: '请先选择求助类型',
        icon: 'none',
        duration: 2000
      })
      return
    }

    if (rewardPoints > availablePoints) {
      wx.showToast({
        title: '积分不足',
        icon: 'none',
        duration: 2000
      })
      return
    }

    if (!this.data.canPublish) return

    const {
      longitude,
      latitude,
      description,
      selectedTime,
    } = this.data

    // 找到类型信息
    const typeInfo = NEED_TYPES.find(t => t.id === selectedType)

    this.setData({ isPublishing: true })

    try {
      wx.showLoading({ title: '发布中...' })

      // 先上传图片
      let imageUrls = []
      if (this.data.images.length > 0) {
        imageUrls = await this.uploadImages()
      }

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
          points: rewardPoints,
          images: imageUrls
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

        // 设置刷新标记，返回时刷新"我的求助"页面
        wx.setStorageSync('refreshMyNeeds', true)

        // 跳转到任务详情页（使用redirectTo关闭发布页）
        setTimeout(() => {
          wx.redirectTo({
            url: `/pages/task-detail/task-detail?id=${result.data.needId}`
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
