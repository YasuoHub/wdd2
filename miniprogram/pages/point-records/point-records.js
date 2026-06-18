// 积分明细页面
const app = getApp()

Page({
  data: {
    // 积分信息
    currentPoints: {
      total: 0
    },

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
    showRulesModal: false
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
          page: newPage
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
          currentPoints: result.data.currentPoints
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
  },

  hideRulesModal() {
    this.setData({ showRulesModal: false })
  }
})
