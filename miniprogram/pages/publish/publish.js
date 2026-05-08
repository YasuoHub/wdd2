// 发布求助页面 - 金额支付版
const app = getApp()
const { PLATFORM_RULES, MoneyUtils } = require('../../utils/platformRules')
const { requirePrivacyAuthorize } = require('../../utils/privacy')

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
const TIME_OPTIONS = PLATFORM_RULES.EXPIRE_OPTIONS

// 快捷金额选项（元）
const QUICK_AMOUNTS = [1, 5, 10, 20, 50]

Page({
  data: {
    // 地图位置
    longitude: 104.0668,
    latitude: 30.5728,
    locationName: '',
    selectedLocation: '',

    // 常用地点（成都）
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
    selectedTime: PLATFORM_RULES.DEFAULT_EXPIRE_MINUTES,

    // 悬赏金额（元）
    rewardAmount: 1,
    quickAmounts: QUICK_AMOUNTS,

    // 平台规则
    platformFeeRate: Math.round(PLATFORM_RULES.PLATFORM_FEE_RATE * 100),
    minRewardAmount: PLATFORM_RULES.MIN_REWARD_AMOUNT,
    maxRewardAmount: PLATFORM_RULES.MAX_REWARD_AMOUNT,
    withdrawMinAmount: PLATFORM_RULES.WITHDRAW_MIN_AMOUNT,
    withdrawFeeRate: Math.round(PLATFORM_RULES.WITHDRAW_FEE_RATE * 100),
    feePolicy: PLATFORM_RULES.FEE_POLICY,
    refundPolicy: PLATFORM_RULES.REFUND_POLICY,

    // 计算值
    platformFee: 0,
    takerIncome: 0,

    // 发布/支付状态
    isPublishing: false,
    canPublish: false,

    // 图片上传
    images: [],
    maxImageCount: 3,
    maxImageSize: 10 * 1024 * 1024,

    // 平台规则弹窗
    showRulesModal: false
  },

  onLoad(options) {
    this.initUserInfo()
    this.initMapCenter()
    if (options.type) {
      this.autoSelectType(options.type)
    }
    this.updateAmountCalculation()
  },

  // 初始化地图中心点
  async initMapCenter() {
    try {
      await requirePrivacyAuthorize()
      const res = await wx.getLocation({ type: 'gcj02' })
      this.setData({
        longitude: res.longitude,
        latitude: res.latitude
      })
    } catch (err) {
      if (err.errno === 112) {
        console.error('【定位失败】小程序后台《隐私保护指引》未配置"位置信息"权限，errno: 112')
      } else {
        console.log('获取当前位置失败，使用默认位置')
      }
    }
  },

  // 自动选择类型
  autoSelectType(type) {
    const typeItem = NEED_TYPES.find(item => item.id === type)
    if (typeItem) {
      this.setData({ selectedType: type })
    }
  },

  // 初始化用户信息
  initUserInfo() {
    const userInfo = app.getUserInfo()
    if (userInfo) {
      this.checkCanPublish()
    }
  },

  // 更新金额计算（平台抽成、帮助者收入）
  updateAmountCalculation() {
    const { rewardAmount } = this.data
    const platformFee = MoneyUtils.calcPlatformFee(rewardAmount)
    const takerIncome = MoneyUtils.calcTakerIncome(rewardAmount)
    this.setData({
      platformFee: MoneyUtils.formatAmount(platformFee),
      takerIncome: MoneyUtils.formatAmount(takerIncome)
    })
  },

  // 选择地点
  async goToLocationPicker() {
    try {
      await requirePrivacyAuthorize()
    } catch (err) {
      const msg = err.errno === 112 ? '定位服务暂不可用' : '需要同意隐私协议'
      wx.showToast({ title: msg, icon: 'none' })
      return
    }
    wx.chooseLocation({
      latitude: this.data.latitude,
      longitude: this.data.longitude,
      success: (res) => {
        this.setData({
          longitude: res.longitude,
          latitude: res.latitude,
          locationName: res.name || res.address || '选定位置',
          addressDetail: res.address,
          selectedLocation: ''
        })
        this.checkCanPublish()
      },
      fail: (err) => {
        if (err.errMsg && !err.errMsg.includes('cancel')) {
          wx.showToast({ title: '选择地点失败', icon: 'none' })
        }
      }
    })
  },

  // 获取当前位置
  async getCurrentLocation() {
    try {
      await requirePrivacyAuthorize()
      const res = await wx.getLocation({ type: 'gcj02' })
      this.setData({
        longitude: res.longitude,
        latitude: res.latitude
      })
      await this.reverseGeocode(res.longitude, res.latitude)
    } catch (err) {
      const msg = err.errno === 112
        ? '定位服务暂不可用'
        : (err._privacyDenied ? '需要同意隐私协议' : '定位失败，请手动输入')
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  // 逆向地理编码（通过云函数代理，避免 Key 泄露）
  async reverseGeocode(longitude, latitude) {
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-geo',
        data: {
          action: 'reverseGeocode',
          longitude,
          latitude
        }
      })
      if (result.code === 0 && result.data) {
        this.setData({ locationName: result.data.address })
        this.checkCanPublish()
      }
    } catch (err) {
      console.error('逆编码失败:', err)
    }
  },

  // 地图点击
  async onMapTap(e) {
    const { longitude, latitude } = e.detail
    this.setData({ longitude, latitude, selectedLocation: '' })
    await this.reverseGeocode(longitude, latitude)
  },

  // 地址输入
  onLocationInput(e) {
    this.setData({ locationName: e.detail.value })
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
    this.setData({ selectedType: e.currentTarget.dataset.type })
    this.checkCanPublish()
  },

  // 描述输入
  onDescriptionInput(e) {
    this.setData({ description: e.detail.value })
  },

  // 选择有效期
  selectTime(e) {
    this.setData({ selectedTime: e.currentTarget.dataset.time })
  },

  // 金额滑块变化
  onAmountChange(e) {
    const rewardAmount = e.detail.value
    this.setData({ rewardAmount })
    this.updateAmountCalculation()
    this.checkCanPublish()
  },

  // 选择快捷金额
  selectQuickAmount(e) {
    const amount = e.currentTarget.dataset.amount
    this.setData({ rewardAmount: amount })
    this.updateAmountCalculation()
    this.checkCanPublish()
  },

  // 手动输入金额
  onAmountInput(e) {
    let value = parseFloat(e.detail.value)
    if (isNaN(value) || value < 0) value = 0
    this.setData({ rewardAmount: value })
    this.updateAmountCalculation()
    this.checkCanPublish()
  },

  // 检查是否可以发布
  checkCanPublish() {
    const { locationName, selectedType, rewardAmount } = this.data
    const canPublish = locationName && selectedType
      && rewardAmount >= PLATFORM_RULES.MIN_REWARD_AMOUNT
      && rewardAmount <= PLATFORM_RULES.MAX_REWARD_AMOUNT
    this.setData({ canPublish })
  },

  // 选择图片
  async chooseImage() {
    try {
      await requirePrivacyAuthorize()
    } catch (err) {
      wx.showToast({ title: '需要同意隐私协议', icon: 'none' })
      return
    }
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
        const oversized = newImages.filter(img => img.size > this.data.maxImageSize)
        if (oversized.length > 0) {
          wx.showToast({ title: '单张图片不能超过10MB', icon: 'none' })
          return
        }
        this.setData({ images: [...images, ...newImages] })
      }
    })
  },

  // 预览图片
  previewImage(e) {
    const urls = this.data.images.map(img => img.path)
    wx.previewImage({
      current: urls[e.currentTarget.dataset.index],
      urls
    })
  },

  // 删除图片
  deleteImage(e) {
    const images = [...this.data.images]
    images.splice(e.currentTarget.dataset.index, 1)
    this.setData({ images })
  },

  // 上传图片到云存储
  async uploadImages() {
    const { images } = this.data
    if (images.length === 0) return []
    const uploadTasks = images.map((img, index) => {
      const cloudPath = `need-images/${Date.now()}-${index}-${Math.random().toString(36).substr(2, 6)}.jpg`
      return wx.cloud.uploadFile({ cloudPath, filePath: img.path })
    })
    const results = await Promise.all(uploadTasks)
    return results.map(res => res.fileID)
  },

  // 显示平台规则
  showPlatformRules() {
    this.setData({ showRulesModal: true })
  },

  // 关闭平台规则
  hidePlatformRules() {
    this.setData({ showRulesModal: false })
  },

  // 发布求助（金额支付版）
  async handlePublish() {
    if (this.data.isPublishing) return

    const { locationName, selectedType, rewardAmount, description, selectedTime } = this.data

    // 前置校验
    if (!locationName) {
      wx.showToast({ title: '请先选择地点', icon: 'none', duration: 2000 })
      return
    }
    if (!selectedType) {
      wx.showToast({ title: '请先选择求助类型', icon: 'none', duration: 2000 })
      return
    }
    if (rewardAmount < PLATFORM_RULES.MIN_REWARD_AMOUNT) {
      wx.showToast({ title: `悬赏金额最少${PLATFORM_RULES.MIN_REWARD_AMOUNT}元`, icon: 'none', duration: 2000 })
      return
    }
    if (rewardAmount > PLATFORM_RULES.MAX_REWARD_AMOUNT) {
      wx.showToast({ title: `悬赏金额最多${PLATFORM_RULES.MAX_REWARD_AMOUNT}元`, icon: 'none', duration: 2000 })
      return
    }
    if (!this.data.canPublish) return

    const typeInfo = NEED_TYPES.find(t => t.id === selectedType)

    this.setData({ isPublishing: true })

    try {
      wx.showLoading({ title: '创建订单中...' })

      // 1. 上传图片
      let imageUrls = []
      if (this.data.images.length > 0) {
        imageUrls = await this.uploadImages()
      }

      // 2. 创建支付订单
      const { result: orderResult } = await wx.cloud.callFunction({
        name: 'wdd-payment',
        data: {
          action: 'createOrder',
          amount: rewardAmount,
          description: `发布求助：${typeInfo.name}`,
          metadata: {
            location: {
              name: locationName,
              coordinates: [this.data.longitude, this.data.latitude]
            },
            type: selectedType,
            typeName: typeInfo.name,
            description: description,
            expireMinutes: selectedTime,
            images: imageUrls
          }
        }
      })

      if (orderResult.code !== 0) {
        throw new Error(orderResult.message || '创建订单失败')
      }

      wx.hideLoading()

      // 3. 唤起微信支付
      const paymentData = orderResult.data.payment
      console.log('[发布] 准备唤起微信支付，订单号:', orderResult.data.orderId)
      const paymentRes = await wx.requestPayment({
        timeStamp: paymentData.timeStamp,
        nonceStr: paymentData.nonceStr,
        package: paymentData.package,
        signType: paymentData.signType,
        paySign: paymentData.paySign
      })
      console.log('[发布] 微信支付完成，结果:', paymentRes)

      // 4. 支付成功，确认订单并创建任务
      wx.showLoading({ title: '发布中...' })

      console.log('[发布] 调用 confirmPayment，订单号:', orderResult.data.orderId)
      const { result: confirmResult } = await wx.cloud.callFunction({
        name: 'wdd-payment',
        data: {
          action: 'confirmPayment',
          orderId: orderResult.data.orderId
        }
      })
      console.log('[发布] confirmPayment 返回:', confirmResult)

      wx.hideLoading()

      if (confirmResult.code === 0) {
        // 设置刷新标记
        wx.setStorageSync('refreshMyNeeds', true)
        wx.setStorageSync('forceRefreshIndex', true)
        wx.setStorageSync('forceRefreshTaskHall', true)

        const targetUrl = `/pages/publish-success/publish-success?needId=${confirmResult.data.needId}&amount=${rewardAmount}&typeName=${encodeURIComponent(typeInfo.name)}`
        console.log('[发布] 准备跳转:', targetUrl)
        // 跳转到发布成功页
        wx.redirectTo({
          url: targetUrl,
          success: () => console.log('[发布] 跳转成功'),
          fail: (err) => {
            console.error('[发布] 跳转失败:', err)
            wx.showToast({ title: '跳转失败: ' + err.errMsg, icon: 'none', duration: 3000 })
          }
        })
      } else {
        throw new Error(confirmResult.message || '发布失败')
      }

    } catch (err) {
      wx.hideLoading()
      this.setData({ isPublishing: false })

      // 处理支付取消
      if (err.errMsg && err.errMsg.includes('cancel')) {
        wx.showToast({ title: '支付已取消', icon: 'none' })
        return
      }

      wx.showToast({
        title: err.message || '发布失败',
        icon: 'none',
        duration: 3000
      })
    }
  }
})
