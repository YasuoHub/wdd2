// 发布求助页面 - 金额支付版
const app = getApp()
const { PLATFORM_RULES, MoneyUtils } = require('../../utils/platformRules')
const { requirePrivacyAuthorize } = require('../../utils/privacy')
const { NEED_TYPES, getByType } = require('../../utils/needTypes')

// 有效期选项
const TIME_OPTIONS = PLATFORM_RULES.EXPIRE_OPTIONS

// 详细描述最少字数
const MIN_DESCRIPTION_LENGTH = 5
const DESCRIPTION_LINE_BREAK_RE = /[\r\n\u2028\u2029]+/g

// 快捷金额选项（元）
const QUICK_AMOUNTS = [1, 5, 10, 20, 50]
const USED_LOCATION_LIMIT = 6
const USED_LOCATION_STORAGE_PREFIX = 'publishUsedLocations'

function normalizeDescriptionText(value) {
  return String(value || '').replace(DESCRIPTION_LINE_BREAK_RE, ' ')
}

function normalizeRewardAmountInput(value) {
  let text = String(value || '').replace(/[^\d.]/g, '')
  const dotIndex = text.indexOf('.')

  if (dotIndex !== -1) {
    const integerPart = text.slice(0, dotIndex)
    const decimalPart = text.slice(dotIndex + 1).replace(/\./g, '').slice(0, 1)
    text = `${integerPart}.${decimalPart}`
  }

  if (text.startsWith('.')) {
    text = `0${text}`
  }

  return text
}

Page({
  data: {
    // 地图位置
    longitude: 104.0668,
    latitude: 30.5728,
    locationName: '',
    selectedLocation: '',

    // 当前用户发布成功后保存在本地的曾用地点
    quickLocations: [],

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

    // 支付方式（可独立选择，按抵扣金 -> 余额 -> 微信的顺序分摊）
    useDeduction: false,
    useBalance: false,
    useWechat: true,
    availableBalance: 0,
    frozenBalance: 0,
    deductionBalance: 0,
    frozenDeductionBalance: 0,
    availableDeductionBalance: 0,
    balanceLoaded: false,

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
    deductionAmount: 0,
    balanceAmount: 0,
    wechatAmount: 0,
    uncoveredAmount: 0,
    paymentCovered: true,

    // 发布/支付状态
    isPublishing: false,
    canPublish: false,

    // 图片上传
    images: [],
    maxImageCount: 3,
    maxImageSize: 10 * 1024 * 1024,

    // 展示状态
    showRulesModal: false,
    showAmountDetailSheet: false
  },

  onLoad(options) {
    this.initUserInfo()
    this.loadUsedLocations()
    this.initMapCenter()
    if (options.type) {
      this.autoSelectType(options.type)
    }
    this.refreshPlatformConfig()
    this.updateAmountCalculation()
  },

  onShow() {
    this.loadUsedLocations()
    this.refreshPlatformConfig()
    this.updateAmountCalculation()
    this.loadBalance()
  },

  // 从 PLATFORM_RULES 刷新平台配置（费率可能已被 app.js 异步加载更新）
  refreshPlatformConfig() {
    this.setData({
      platformFeeRate: Math.round(PLATFORM_RULES.PLATFORM_FEE_RATE * 100),
      feePolicy: PLATFORM_RULES.FEE_POLICY,
      minRewardAmount: PLATFORM_RULES.MIN_REWARD_AMOUNT,
      maxRewardAmount: PLATFORM_RULES.MAX_REWARD_AMOUNT,
      withdrawMinAmount: PLATFORM_RULES.WITHDRAW_MIN_AMOUNT
    })
  },

  // 加载用户余额信息
  async loadBalance() {
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-notify',
        data: { action: 'getUserInfo' }
      })
      if (result.code === 0 && result.data.userInfo) {
        const ui = result.data.userInfo
        const availableBalance = Math.max(0, Math.round(((ui.balance || 0) - (ui.frozen_balance || 0)) * 100) / 100)
        const availableDeductionBalance = Math.max(0, Math.round(((ui.deduction_balance || 0) - (ui.frozen_deduction_balance || 0)) * 100) / 100)
        this.setData({
          availableBalance,
          frozenBalance: ui.frozen_balance || 0,
          deductionBalance: ui.deduction_balance || 0,
          frozenDeductionBalance: ui.frozen_deduction_balance || 0,
          availableDeductionBalance,
          balanceLoaded: true
        }, () => {
          this.updateAmountCalculation()
        })
      }
    } catch (err) {
      console.error('加载余额失败:', err)
    }
  },

  // 切换支付方式，用户选择什么，后端就只使用什么
  onTogglePaymentMethod(e) {
    const method = e.currentTarget.dataset.method
    const keyMap = {
      deduction: 'useDeduction',
      balance: 'useBalance',
      wechat: 'useWechat'
    }
    const key = keyMap[method]
    if (!key) return

    this.setData({ [key]: !this.data[key] }, () => {
      this.updateAmountCalculation()
    })
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
      this.setData({ selectedType: type }, () => {
        this.checkCanPublish()
      })
    }
  },

  // 初始化用户信息
  initUserInfo() {
    const userInfo = app.getUserInfo()
    if (userInfo) {
      this.checkCanPublish()
    }
  },

  getUsedLocationStorageKey() {
    const userInfo = app.getUserInfo && app.getUserInfo()
    const userId = userInfo && (userInfo._id || userInfo.openid || userInfo._openid)
    return userId ? `${USED_LOCATION_STORAGE_PREFIX}:${userId}` : USED_LOCATION_STORAGE_PREFIX
  },

  normalizeUsedLocation(location = {}) {
    const name = String(location.name || '').trim()
    const longitude = Number(location.longitude)
    const latitude = Number(location.latitude)

    if (!name || !Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      return null
    }

    return {
      name,
      longitude,
      latitude,
      address: String(location.address || '').trim()
    }
  },

  loadUsedLocations() {
    try {
      const locations = wx.getStorageSync(this.getUsedLocationStorageKey())
      const normalized = Array.isArray(locations)
        ? locations
          .map(item => this.normalizeUsedLocation(item))
          .filter(Boolean)
          .slice(0, USED_LOCATION_LIMIT)
        : []

      this.setData({ quickLocations: normalized })
    } catch (err) {
      console.error('加载曾用地点失败:', err)
      this.setData({ quickLocations: [] })
    }
  },

  saveUsedLocation(location) {
    const normalized = this.normalizeUsedLocation(location)
    if (!normalized) return

    const locations = [
      normalized,
      ...this.data.quickLocations.filter(item => item.name !== normalized.name)
    ].slice(0, USED_LOCATION_LIMIT)

    this.setData({ quickLocations: locations })

    try {
      wx.setStorageSync(this.getUsedLocationStorageKey(), locations)
    } catch (err) {
      console.error('保存曾用地点失败:', err)
    }
  },

  // 更新金额计算（平台抽成、帮助者收入）
  updateAmountCalculation() {
    const { rewardAmount } = this.data
    const totalAmount = parseFloat(rewardAmount) || 0
    const platformFee = MoneyUtils.calcPlatformFee(rewardAmount)
    const takerIncome = MoneyUtils.calcTakerIncome(rewardAmount)
    const deductionAmount = this.data.useDeduction
      ? Math.min(totalAmount, this.data.availableDeductionBalance || 0)
      : 0
    const afterDeduction = Math.max(0, Math.round((totalAmount - deductionAmount) * 100) / 100)
    const balanceAmount = this.data.useBalance
      ? Math.min(afterDeduction, this.data.availableBalance || 0)
      : 0
    const afterBalance = Math.max(0, Math.round((afterDeduction - balanceAmount) * 100) / 100)
    const wechatAmount = this.data.useWechat ? afterBalance : 0
    const uncoveredAmount = Math.max(0, Math.round((afterBalance - wechatAmount) * 100) / 100)
    const paymentCovered = totalAmount > 0 && uncoveredAmount === 0

    this.setData({
      platformFee: MoneyUtils.formatAmount(platformFee),
      takerIncome: MoneyUtils.formatAmount(takerIncome),
      deductionAmount: MoneyUtils.formatAmount(deductionAmount),
      balanceAmount: MoneyUtils.formatAmount(balanceAmount),
      wechatAmount: MoneyUtils.formatAmount(wechatAmount),
      uncoveredAmount: MoneyUtils.formatAmount(uncoveredAmount),
      paymentCovered
    }, () => {
      this.checkCanPublish()
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
        }, () => {
          this.checkCanPublish()
        })
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
        this.setData({ locationName: result.data.address }, () => {
          this.checkCanPublish()
        })
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
    this.setData({ locationName: e.detail.value }, () => {
      this.checkCanPublish()
    })
  },

  // 选择曾用地点
  selectQuickLocation(e) {
    const location = e.currentTarget.dataset.location
    this.setData({
      locationName: location.name,
      selectedLocation: location.name,
      longitude: location.longitude,
      latitude: location.latitude,
      addressDetail: location.address || ''
    }, () => {
      this.saveUsedLocation(location)
      this.checkCanPublish()
    })
  },

  // 选择类型
  selectType(e) {
    this.setData({ selectedType: e.currentTarget.dataset.type }, () => {
      this.checkCanPublish()
    })
  },

  // 描述输入
  onDescriptionInput(e) {
    const description = normalizeDescriptionText(e.detail.value)
    this.setData({ description }, () => {
      this.checkCanPublish()
    })
    return description
  },

  // 选择有效期
  selectTime(e) {
    this.setData({ selectedTime: e.currentTarget.dataset.time })
  },

  // 金额滑块变化
  onAmountChange(e) {
    const rewardAmount = e.detail.value
    this.setData({ rewardAmount }, () => {
      this.updateAmountCalculation()
    })
  },

  // 选择快捷金额
  selectQuickAmount(e) {
    const amount = e.currentTarget.dataset.amount
    this.setData({ rewardAmount: amount }, () => {
      this.updateAmountCalculation()
    })
  },

  // 手动输入金额
  onAmountInput(e) {
    const value = normalizeRewardAmountInput(e.detail.value)
    this.setData({ rewardAmount: value }, () => {
      this.updateAmountCalculation()
    })
    return value
  },

  // 检查是否可以发布
  checkCanPublish() {
    const { locationName, selectedType, rewardAmount, description, paymentCovered } = this.data
    const amount = parseFloat(rewardAmount) || 0
    const descriptionText = normalizeDescriptionText(description).trim()
    const canPublish = !!(locationName && selectedType && descriptionText.length >= MIN_DESCRIPTION_LENGTH
      && amount >= PLATFORM_RULES.MIN_REWARD_AMOUNT
      && amount <= PLATFORM_RULES.MAX_REWARD_AMOUNT
      && paymentCovered)
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

  // 显示费用详情
  showAmountDetail() {
    this.setData({ showAmountDetailSheet: true })
  },

  // 关闭费用详情
  hideAmountDetail() {
    this.setData({ showAmountDetailSheet: false })
  },

  preventHide() {},

  finishPublishSuccess(resultData, rewardAmountValue, selectedType, locationName) {
    this.saveUsedLocation({
      name: locationName,
      longitude: this.data.longitude,
      latitude: this.data.latitude,
      address: this.data.addressDetail || ''
    })

    app.globalData.refreshMyNeeds = true
    wx.setStorageSync('forceRefreshIndex', true)
    wx.setStorageSync('forceRefreshTaskHall', true)

    const targetUrl = `/pages/publish-success/publish-success?needId=${resultData.needId}&amount=${rewardAmountValue}&type=${selectedType}&locationName=${encodeURIComponent(locationName)}`
    wx.redirectTo({ url: targetUrl })
  },

  // 发布求助（金额支付版）
  async handlePublish() {
    if (this.data.isPublishing) return

    // 检查用户封禁状态和信誉分
    const userInfo = app.globalData.userInfo
    if (userInfo.ban_status) {
      const now = new Date()
      const endTime = new Date(userInfo.ban_status.end_time)
      if (now < endTime) {
        const isPermanent = endTime.getFullYear() >= 9999
        wx.showModal({
          title: '账号限制',
          content: isPermanent ? '您的账号已被永久封禁' : `您的账号已被封禁，预计 ${endTime.getFullYear()}年${endTime.getMonth() + 1}月${endTime.getDate()}日 可正常使用`,
          showCancel: false
        })
        return
      }
    }
    if (userInfo.credit_score === 0) {
      wx.showModal({
        title: '账号限制',
        content: '您的信誉分已扣至0分，已限制发布求助及帮助权限',
        showCancel: false
      })
      return
    }

    const { locationName, selectedType, rewardAmount, description, selectedTime } = this.data
    const rewardAmountValue = parseFloat(rewardAmount) || 0

    // 前置校验
    if (!locationName) {
      wx.showToast({ title: '请先选择地点', icon: 'none', duration: 2000 })
      return
    }
    if (!selectedType) {
      wx.showToast({ title: '请先选择求助类型', icon: 'none', duration: 2000 })
      return
    }
    const normalizedDescription = normalizeDescriptionText(description)
    const descriptionText = normalizedDescription.trim()
    if (normalizedDescription !== description) {
      this.setData({ description: normalizedDescription })
    }
    if (descriptionText.length < MIN_DESCRIPTION_LENGTH) {
      wx.showToast({ title: `详细描述不少于${MIN_DESCRIPTION_LENGTH}个字`, icon: 'none', duration: 2000 })
      return
    }
    if (rewardAmountValue < PLATFORM_RULES.MIN_REWARD_AMOUNT) {
      wx.showToast({ title: `悬赏金额最少${PLATFORM_RULES.MIN_REWARD_AMOUNT}元`, icon: 'none', duration: 2000 })
      return
    }
    if (rewardAmountValue > PLATFORM_RULES.MAX_REWARD_AMOUNT) {
      wx.showToast({ title: `悬赏金额最多${PLATFORM_RULES.MAX_REWARD_AMOUNT}元`, icon: 'none', duration: 2000 })
      return
    }
    if (!this.data.paymentCovered) {
      wx.showToast({ title: `支付方式还差${this.data.uncoveredAmount}元`, icon: 'none', duration: 2000 })
      return
    }
    if (!this.data.canPublish) return

    const typeInfo = getByType(selectedType)

    this.setData({ isPublishing: true })
    let pendingOrderId = ''
    let wechatPaymentCompleted = false

    try {
      wx.showLoading({ title: '发布中...' })

      // 1. 上传图片
      let imageUrls = []
      if (this.data.images.length > 0) {
        imageUrls = await this.uploadImages()
      }

      const metadata = {
        location: {
          name: locationName,
          coordinates: [this.data.longitude, this.data.latitude]
        },
        type: selectedType,
        description: descriptionText,
        expireMinutes: selectedTime,
        images: imageUrls
      }

      const paymentSelection = {
        useDeduction: this.data.useDeduction,
        useBalance: this.data.useBalance,
        useWechat: this.data.useWechat
      }

      // 无微信补差：钱包资金冻结后直接发布
      if (Number(this.data.wechatAmount) <= 0) {
        const { result } = await wx.cloud.callFunction({
          name: 'wdd-payment',
          data: {
            action: 'payByWallet',
            amount: rewardAmountValue,
            paymentSelection,
            description: `发布求助：${typeInfo.name}`,
            metadata: metadata
          }
        })

        wx.hideLoading()

        if (result.code === 0) {
          this.finishPublishSuccess(result.data, rewardAmountValue, selectedType, locationName)
        } else {
          throw new Error(result.message || '发布失败')
        }
        return
      }

      // 含微信支付：先冻结已选择的钱包资金，再支付微信补差
      wx.showLoading({ title: '创建订单中...' })

      // 2. 创建支付订单
      const { result: orderResult } = await wx.cloud.callFunction({
        name: 'wdd-payment',
        data: {
          action: 'createOrder',
          amount: rewardAmountValue,
          paymentSelection,
          description: `发布求助：${typeInfo.name}`,
          metadata: metadata
        }
      })

      if (orderResult.code !== 0) {
        throw new Error(orderResult.message || '创建订单失败')
      }
      pendingOrderId = orderResult.data.orderId

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
      wechatPaymentCompleted = true
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
        this.finishPublishSuccess(confirmResult.data, rewardAmountValue, selectedType, locationName)
      } else {
        throw new Error(confirmResult.message || '发布失败')
      }

    } catch (err) {
      wx.hideLoading()
      this.setData({ isPublishing: false })

      if (pendingOrderId && !wechatPaymentCompleted) {
        wx.cloud.callFunction({
          name: 'wdd-payment',
          data: {
            action: 'cancelPendingOrder',
            orderId: pendingOrderId
          }
        }).catch(cancelErr => {
          console.error('取消待支付订单失败:', cancelErr)
        })
      }

      if (pendingOrderId && wechatPaymentCompleted) {
        wx.showLoading({ title: '恢复订单中...' })
        try {
          const { result: recoverResult } = await wx.cloud.callFunction({
            name: 'wdd-payment',
            data: {
              action: 'recoverPaidPendingOrder',
              orderId: pendingOrderId
            }
          })
          wx.hideLoading()
          if (recoverResult && recoverResult.code === 0 && recoverResult.data && recoverResult.data.needId) {
            this.finishPublishSuccess(recoverResult.data, rewardAmountValue, selectedType, locationName)
            return
          }
        } catch (recoverErr) {
          wx.hideLoading()
          console.error('恢复已支付订单失败:', recoverErr)
        }
      }

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
