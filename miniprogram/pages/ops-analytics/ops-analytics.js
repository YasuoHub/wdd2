// 运营分析页面
const CLOUD_FUNC = 'wdd-ops-analytics'
const { callCloudFunction } = require('../../utils/cloud')
const { getByType } = require('../../utils/needTypes')

// 平台资金流水类型映射
const FLOW_TYPE_MAP = {
  platform_revenue: '平台收入',
  withdraw: '提现支出'
}

Page({
  data: {
    // 日期
    startDate: '',
    endDate: '',
    today: '',
    activePreset: '30d',

    // KPI
    kpi: { totalTasks: 0, completionRateText: '0%', platformRevenueText: '0', newUsers: 0 },

    // 各图表数据
    revenueTrend: [],
    userTrend: [],
    typeRanking: [],
    funnelStages: [],
    completionTrend: [],
    reportTrend: [],
    waitTimeData: [],
    avgMatchTrend: [],
    hotLocations: [],
    fundFlowTrend: [],

    // 资金流水明细
    fundFlowDetails: [],
    fundFlowPage: 1,
    fundFlowHasMore: false,
    fundFlowLoadingMore: false,
    fundFlowLoaded: false,

    // 加载状态
    loading: {
      revenue: true,
      userTrend: true,
      typeRanking: true,
      funnel: true,
      completionTrend: true,
      reportTrend: true,
      waitTime: true,
      avgMatch: true,
      locations: true,
      fundFlowTrend: true,
      fundFlowDetails: true
    }
  },

  onLoad() {
    const now = new Date()
    const today = this._formatDate(now)
    const start30 = this._formatDate(new Date(now.getTime() - 30 * 86400000))

    this.setData({ today, startDate: start30, endDate: today })
    this._checkAuth()
  },

  onReachBottom() {
    this.loadMoreFlow()
  },

  // ===================== 权限检查 =====================

  async _checkAuth() {
    try {
      const { result } = await callCloudFunction({
        name: 'wdd-get-config',
        data: { action: 'getRoleFlags' },
        dedupe: true,
        dedupeKey: 'wdd-get-config:role-flags'
      })
      if (result.code !== 0 || !result.data.isSuperAdmin) {
        wx.showModal({
          title: '无权限',
          content: '您没有超级管理员权限',
          showCancel: false,
          success: () => wx.navigateBack()
        })
        return
      }
      this._loadAll()
    } catch (err) {
      console.error('权限检查失败:', err)
      wx.showModal({
        title: '错误',
        content: '权限检查失败，请重试',
        showCancel: false,
        success: () => wx.navigateBack()
      })
    }
  },

  // ===================== 数据加载 =====================

  async _loadAll() {
    const { startDate, endDate } = this.data
    const params = { startDate, endDate }

    // 并行请求所有指标（除流水明细）
    const actions = [
      'getKpiOverview', 'getRevenueTrend', 'getUserTrend',
      'getTaskTypeRanking', 'getConversionFunnel', 'getCompletionCancelTrend',
      'getReportRateTrend', 'getWaitTimeDistribution', 'getAvgMatchTimeTrend',
      'getHotLocationRanking', 'getFundFlow'
    ]

    const promises = actions.map(action =>
      wx.cloud.callFunction({ name: CLOUD_FUNC, data: { action, ...params } })
        .then(res => ({ action, result: res.result }))
        .catch(err => ({ action, error: err }))
    )

    const results = await Promise.all(promises)

    const updateData = {}
    const loading = { ...this.data.loading }

    results.forEach(({ action, result, error }) => {
      if (error || !result || result.code !== 0) {
        console.error(`[ops] ${action} 加载失败:`, error || result)
        // 标记加载完成但数据为空
        switch (action) {
          case 'getKpiOverview': break // KPI 保持默认值
          case 'getRevenueTrend': updateData.revenueTrend = []; break
          case 'getUserTrend': updateData.userTrend = []; break
          case 'getTaskTypeRanking': updateData.typeRanking = []; break
          case 'getConversionFunnel': updateData.funnelStages = []; break
          case 'getCompletionCancelTrend': updateData.completionTrend = []; break
          case 'getReportRateTrend': updateData.reportTrend = []; break
          case 'getWaitTimeDistribution': updateData.waitTimeData = []; break
          case 'getAvgMatchTimeTrend': updateData.avgMatchTrend = []; break
          case 'getHotLocationRanking': updateData.hotLocations = []; break
          case 'getFundFlow': updateData.fundFlowTrend = []; break
        }
        return
      }

      const data = result.data
      switch (action) {
        case 'getKpiOverview':
          updateData.kpi = {
            totalTasks: data.totalTasks || 0,
            completionRateText: this._fmtPct(data.completionRate),
            platformRevenueText: this._fmtMoney(data.platformRevenue),
            newUsers: data.newUsers || 0
          }
          break

        case 'getRevenueTrend':
          updateData.revenueTrend = (data.trend || []).map(d => ({
            date: d.date, value1: d.revenue || 0
          }))
          break

        case 'getUserTrend':
          updateData.userTrend = (data.trend || []).map(d => ({
            date: d.date, value1: d.count || 0
          }))
          break

        case 'getTaskTypeRanking':
          updateData.typeRanking = (data.ranking || []).map(d => ({
            label: getByType(d.type).name, value: d.count
          }))
          break

        case 'getConversionFunnel':
          updateData.funnelStages = [
            { value: data.published || 0 },
            { value: data.matched || 0 },
            { value: data.completed || 0 },
            { value: data.rated || 0 }
          ]
          break

        case 'getCompletionCancelTrend':
          updateData.completionTrend = (data.trend || []).map(d => ({
            date: d.date,
            value1: d.completionRate || 0,
            value2: d.cancelRate || 0
          }))
          break

        case 'getReportRateTrend':
          updateData.reportTrend = (data.trend || []).map(d => ({
            date: d.date,
            value1: d.totalReportRate || 0,
            value2: d.validReportRate || 0
          }))
          break

        case 'getWaitTimeDistribution':
          updateData.waitTimeData = (data.distribution || []).map(d => ({
            label: d.label, value: d.count
          }))
          break

        case 'getAvgMatchTimeTrend':
          updateData.avgMatchTrend = (data.trend || []).map(d => ({
            date: d.date, value1: d.avgMinutes || 0
          }))
          break

        case 'getHotLocationRanking': {
          const locations = data.ranking || []
          const maxCount = Math.max(...locations.map(l => l.count || 0), 1)
          updateData.hotLocations = locations.map(l => ({
            ...l,
            _percent: Math.round((l.count || 0) / maxCount * 100)
          }))
          break
        }

        case 'getFundFlow':
          updateData.fundFlowTrend = (data.trend || []).map(d => ({
            date: d.date,
            value1: d.income || 0,
            value2: d.expense || 0
          }))
          break
      }

      // 标记加载完成
      const loadingKey = this._actionToLoadingKey(action)
      if (loadingKey) loading[loadingKey] = false
    })

    updateData.loading = loading
    this.setData(updateData)

    // 流水明细单独加载
    this._loadFlowDetails()
  },

  // 加载资金流水明细
  async _loadFlowDetails(page = 1) {
    const { startDate, endDate } = this.data
    if (page > 1 && (this.data.fundFlowLoadingMore || this.data.loading.fundFlowDetails)) return

    if (page === 1) {
      this.setData({
        'loading.fundFlowDetails': true,
        fundFlowLoadingMore: false,
        fundFlowLoaded: false
      })
    } else {
      this.setData({ fundFlowLoadingMore: true })
    }

    try {
      const { result } = await wx.cloud.callFunction({
        name: CLOUD_FUNC,
        data: { action: 'getFundFlowDetails', startDate, endDate, page, pageSize: 20 }
      })

      if (result.code === 0) {
        const records = (result.data.records || []).map(r => ({
          ...r,
          _typeName: FLOW_TYPE_MAP[r.type] || r.type || '未知',
          _time: this._formatDateTime(r.create_time),
          _amountPrefix: (r.amount || 0) >= 0 ? '+' : '-',
          _amountAbsText: this._fmtMoney(Math.abs(r.amount || 0))
        }))

        const existing = page === 1 ? [] : this.data.fundFlowDetails
        this.setData({
          fundFlowDetails: [...existing, ...records],
          fundFlowPage: page,
          fundFlowHasMore: result.data.hasMore || false,
          fundFlowLoaded: true,
          fundFlowLoadingMore: false,
          'loading.fundFlowDetails': false
        })
      } else {
        this.setData({
          fundFlowHasMore: false,
          fundFlowLoaded: true,
          fundFlowLoadingMore: false,
          'loading.fundFlowDetails': false
        })
      }
    } catch (err) {
      console.error('流水明细加载失败:', err)
      this.setData({
        fundFlowHasMore: false,
        fundFlowLoaded: true,
        fundFlowLoadingMore: false,
        'loading.fundFlowDetails': false
      })
    }
  },

  loadMoreFlow() {
    if (!this.data.fundFlowHasMore || this.data.fundFlowLoadingMore || this.data.loading.fundFlowDetails) return
    this._loadFlowDetails(this.data.fundFlowPage + 1)
  },

  // ===================== 时间筛选 =====================

  setPreset(e) {
    const preset = e.currentTarget.dataset.preset
    const now = new Date()
    const today = this._formatDate(now)
    let startDate = today
    let days = 30

    if (preset === '7d') days = 7
    else if (preset === '30d') days = 30
    else if (preset === '90d') days = 90

    startDate = this._formatDate(new Date(now.getTime() - days * 86400000))

    this.setData({ activePreset: preset, startDate, endDate: today })

    // 重置加载状态
    const loading = {}
    Object.keys(this.data.loading).forEach(k => { loading[k] = true })
    this.setData({
      loading,
      fundFlowDetails: [],
      fundFlowPage: 1,
      fundFlowHasMore: false,
      fundFlowLoadingMore: false,
      fundFlowLoaded: false
    })
    this._loadAll()
  },

  onStartDateChange(e) {
    this.setData({ startDate: e.detail.value, activePreset: '' })
    this._reload()
  },

  onEndDateChange(e) {
    this.setData({ endDate: e.detail.value, activePreset: '' })
    this._reload()
  },

  _reload() {
    const loading = {}
    Object.keys(this.data.loading).forEach(k => { loading[k] = true })
    this.setData({
      loading,
      fundFlowDetails: [],
      fundFlowPage: 1,
      fundFlowHasMore: false,
      fundFlowLoadingMore: false,
      fundFlowLoaded: false
    })
    this._loadAll()
  },

  // ===================== 工具函数 =====================

  _actionToLoadingKey(action) {
    const map = {
      getRevenueTrend: 'revenue',
      getUserTrend: 'userTrend',
      getTaskTypeRanking: 'typeRanking',
      getConversionFunnel: 'funnel',
      getCompletionCancelTrend: 'completionTrend',
      getReportRateTrend: 'reportTrend',
      getWaitTimeDistribution: 'waitTime',
      getAvgMatchTimeTrend: 'avgMatch',
      getHotLocationRanking: 'locations',
      getFundFlow: 'fundFlowTrend'
    }
    return map[action] || null
  },

  _formatDate(date) {
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  },

  _formatDateTime(date) {
    if (!date) return ''
    const d = new Date(date)
    const dateStr = this._formatDate(d)
    const h = String(d.getHours()).padStart(2, '0')
    const min = String(d.getMinutes()).padStart(2, '0')
    return `${dateStr} ${h}:${min}`
  },

  _fmtPct(rate) {
    if (rate === undefined || rate === null) return '0%'
    return Math.round(rate * 10000) / 100 + '%'
  },

  _fmtMoney(amount) {
    if (amount === undefined || amount === null) return '0'
    if (amount >= 10000) return (amount / 10000).toFixed(1) + 'w'
    const num = Math.round(amount * 100) / 100
    if (num % 1 === 0) return String(num)
    if (num * 10 % 1 === 0) return num.toFixed(1)
    return num.toFixed(2)
  }
})
