// 积分明细页面
const app = getApp()

Page({
  data: {
    // 积分信息
    currentPoints: {
      total: 0,
      available: 0,
      frozen: 0
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
    isEmpty: false
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
        const { records, hasMore, currentPoints } = result.data

        // 计算新的 page：如果是刷新，从第2页开始；如果是加载更多，page+1
        // 但如果 hasMore 为 false，保持当前 page
        const newPage = isRefresh ? 2 : (hasMore ? this.data.page + 1 : this.data.page)

        this.setData({
          currentPoints,
          records: isRefresh ? records : [...this.data.records, ...records],
          hasMore,
          isEmpty: records.length === 0 && isRefresh,
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
        isRefreshing: false
      })
    }
  },

  // 刷新数据
  refreshData() {
    this.setData({
      page: 1,
      records: [],
      hasMore: true
    })
    this.loadPointRecords(true)
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
  onPullDownRefresh() {
    this.refreshData()
    wx.stopPullDownRefresh()
  },

  // 上拉加载更多
  onReachBottom() {
    if (this.data.hasMore && !this.data.isLoadingMore) {
      this.setData({ isLoadingMore: true })
      this.loadPointRecords().then(() => {
        this.setData({ isLoadingMore: false })
      })
    }
  },

  // 返回上一页
  goBack() {
    wx.navigateBack()
  },

  // 跳转到积分规则
  showRules() {
    wx.showModal({
      title: '积分规则',
      content: '1. 新用户注册：+100积分\n2. 每日签到：+5~30积分（连续签到递增）\n3. 发布求助：冻结相应积分\n4. 完成求助：支付积分给帮助者\n5. 帮助他人：获得对方悬赏积分\n6. 邀请好友：双方各+50积分\n\n积分当年有效，次年1月1日清零。\n\n10积分 = 1元（未来可提现）',
      showCancel: false
    })
  }
})
