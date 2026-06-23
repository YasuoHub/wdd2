// 积分明细页面
const app = getApp()

const DEFAULT_POINTS_CONFIG = {
  register: 100,
  invite: 50,
  signInDaily: [5, 10, 15, 20, 25, 30, 30]
}

function toRuleNumber(value, fallback) {
  const num = Number(value)
  return Number.isFinite(num) && num >= 0 ? num : fallback
}

function normalizeSignInDaily(points) {
  if (!Array.isArray(points)) return DEFAULT_POINTS_CONFIG.signInDaily
  const values = points
    .map(item => Number(item))
    .filter(item => Number.isFinite(item) && item >= 0)
  return values.length > 0 ? values : DEFAULT_POINTS_CONFIG.signInDaily
}

function formatPointValue(value) {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100)
}

function buildSignInRuleText(signInDaily) {
  const values = normalizeSignInDaily(signInDaily)
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) {
    return `每日签到可获得 ${formatPointValue(min)} 积分。`
  }
  return `每日签到可获得 ${formatPointValue(min)}~${formatPointValue(max)} 积分，连续签到会递增。`
}

function buildPointsRules(config, exchangeRate = 100) {
  const points = config && config.points ? config.points : {}
  const signIn = points.signIn || {}
  const signInDaily = normalizeSignInDaily(signIn.daily)
  const rate = Number(exchangeRate) || 100

  return {
    register: formatPointValue(toRuleNumber(points.register, DEFAULT_POINTS_CONFIG.register)),
    invite: formatPointValue(toRuleNumber(points.invite, DEFAULT_POINTS_CONFIG.invite)),
    signInText: buildSignInRuleText(signInDaily),
    exchangeRate: formatPointValue(rate)
  }
}

Page({
  data: {
    // 积分信息
    currentPoints: {
      total: 0,
      deductionBalance: 0,
      exchangeRate: 100
    },
    exchangeInput: '',
    exchangePreviewAmount: '0.00',
    showExchangeModal: false,
    exchangeErrorTip: '',

    // 记录列表
    records: [],

    // 分页
    page: 1,
    pageSize: 20,
    hasMore: true,

    // 状态
    isLoading: false,
    isRefreshing: false,
    isLoadingMore: false,
    isEmpty: false,

    // 积分规则弹窗
    showRulesModal: false,
    pointsRules: buildPointsRules(null)
  },

  onLoad() {
    // 检查登录状态
    app.checkLoginStatus()
    if (!app.globalData.isLoggedIn) {
      wx.showToast({
        title: '请先登录',
        icon: 'none'
      })
      setTimeout(() => {
        wx.navigateBack()
      }, 1500)
      return
    }
    this.loadPointRecords()
    this.loadPointsRulesConfig()
  },

  onShow() {
    // 检查登录状态
    if (!app.globalData.isLoggedIn) {
      return
    }
    // 只在有数据时刷新积分余额，不重新加载列表
    if (this.data.records.length > 0) {
      this.refreshPointsOnly()
    }
  },

  // 加载积分记录
  async loadPointRecords(isRefresh = false) {
    if (this.data.isLoading) return

    this.setData({
      isLoading: !isRefresh,
      isRefreshing: isRefresh
    })

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-get-point-records',
        data: {
          page: isRefresh ? 1 : this.data.page,
          pageSize: this.data.pageSize
        }
      })

      if (result.code === 0) {
        const { records = [], hasMore, currentPoints } = result.data

        // 计算新的 page：有下一页时才推进页码，避免触底后重复请求空页。
        const newPage = hasMore ? (isRefresh ? 2 : this.data.page + 1) : (isRefresh ? 1 : this.data.page)
        const nextRecords = isRefresh ? records : [...this.data.records, ...records]

        this.setData({
          currentPoints,
          records: nextRecords,
          hasMore,
          isEmpty: nextRecords.length === 0,
          page: newPage,
          pointsRules: buildPointsRules(app.globalData.platformConfig, currentPoints.exchangeRate || 100)
        })
      } else {
        throw new Error(result.message)
      }
    } catch (err) {
      console.error('加载积分记录失败:', err)
      wx.showToast({
        title: '加载失败',
        icon: 'none'
      })
    } finally {
      this.setData({
        isLoading: false,
        isRefreshing: false,
        isLoadingMore: false
      })
    }
  },

  // 刷新数据
  async refreshData() {
    this.setData({
      page: 1,
      records: [],
      hasMore: true,
      isEmpty: false,
      isLoadingMore: false
    })
    await this.loadPointRecords(true)
  },

  // 仅刷新积分余额（不刷新列表）
  async refreshPointsOnly() {
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-get-point-records',
        data: {
          page: 1,
          pageSize: 1
        }
      })

      if (result.code === 0) {
        this.setData({
          currentPoints: result.data.currentPoints,
          exchangePreviewAmount: this.calcExchangePreview(this.data.exchangeInput, result.data.currentPoints.exchangeRate || 100),
          pointsRules: buildPointsRules(app.globalData.platformConfig, result.data.currentPoints.exchangeRate || 100)
        })
      }
    } catch (err) {
      console.error('刷新积分失败:', err)
    }
  },

  // 下拉刷新
  async onPullDownRefresh() {
    await this.refreshData()
    wx.stopPullDownRefresh()
  },

  // 加载更多积分记录
  async loadMoreRecords() {
    if (!this.data.hasMore || this.data.isLoading || this.data.isLoadingMore) return
    this.setData({ isLoadingMore: true })
    await this.loadPointRecords()
  },

  // 兼容页面触底场景，主要加载入口来自列表内部滚动
  onReachBottom() {
    this.loadMoreRecords()
  },

  // 返回上一页
  goBack() {
    wx.navigateBack()
  },

  // 跳转到积分规则
  showRules() {
    this.setData({ showRulesModal: true })
    this.loadPointsRulesConfig()
  },

  hideRulesModal() {
    this.setData({ showRulesModal: false })
  },

  async loadPointsRulesConfig() {
    const exchangeRate = this.data.currentPoints.exchangeRate || 100
    if (app.globalData.platformConfig) {
      this.setData({
        pointsRules: buildPointsRules(app.globalData.platformConfig, exchangeRate)
      })
      return
    }

    if (typeof app.loadPlatformConfig !== 'function') return

    try {
      await app.loadPlatformConfig()
      this.setData({
        pointsRules: buildPointsRules(app.globalData.platformConfig, exchangeRate)
      })
    } catch (err) {
      console.error('加载积分规则配置失败:', err)
    }
  },

  showExchangeModal() {
    if ((this.data.currentPoints.total || 0) < (this.data.currentPoints.exchangeRate || 100)) {
      wx.showToast({ title: `满${this.data.currentPoints.exchangeRate || 100}积分可兑换1元`, icon: 'none' })
      return
    }
    this.setData({
      showExchangeModal: true,
      exchangeInput: '',
      exchangePreviewAmount: '0.00',
      exchangeErrorTip: ''
    })
  },

  hideExchangeModal() {
    this.setData({ showExchangeModal: false })
  },

  calcExchangePreview(points, rate) {
    const value = Number(points)
    const exchangeRate = rate || this.data.currentPoints.exchangeRate || 100
    if (!Number.isInteger(value) || value <= 0 || value % exchangeRate !== 0) {
      return '0.00'
    }
    return (value / exchangeRate).toFixed(2)
  },

  onExchangeInput(e) {
    const value = String(e.detail.value || '').replace(/[^\d]/g, '')
    const rate = this.data.currentPoints.exchangeRate || 100
    let errorTip = ''
    const points = Number(value)
    if (value && (!Number.isInteger(points) || points <= 0)) {
      errorTip = '请输入有效积分'
    } else if (value && points % rate !== 0) {
      errorTip = `兑换积分必须是${rate}的整数倍`
    } else if (value && points > (this.data.currentPoints.total || 0)) {
      errorTip = '积分不足'
    }

    this.setData({
      exchangeInput: value,
      exchangePreviewAmount: this.calcExchangePreview(value, rate),
      exchangeErrorTip: errorTip
    })
  },

  async doExchangeDeduction() {
    if (this.data.isLoading) return
    const points = Number(this.data.exchangeInput)
    const rate = this.data.currentPoints.exchangeRate || 100
    if (!Number.isInteger(points) || points <= 0) {
      this.setData({ exchangeErrorTip: '请输入兑换积分' })
      return
    }
    if (points % rate !== 0) {
      this.setData({ exchangeErrorTip: `兑换积分必须是${rate}的整数倍` })
      return
    }
    if (points > (this.data.currentPoints.total || 0)) {
      this.setData({ exchangeErrorTip: '积分不足' })
      return
    }

    wx.showLoading({ title: '兑换中...' })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-get-point-records',
        data: {
          action: 'exchangePointsForDeduction',
          points
        }
      })

      wx.hideLoading()
      if (result.code !== 0) {
        throw new Error(result.message || '兑换失败')
      }

      wx.showToast({ title: '兑换成功，可在我的钱包查看', icon: 'none' })
      this.hideExchangeModal()
      await this.refreshData()
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '兑换失败', icon: 'none' })
    }
  }
})
