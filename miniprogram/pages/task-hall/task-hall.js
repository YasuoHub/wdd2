// 任务大厅
const app = getApp()

// 筛选标签
const FILTERS = [
  { id: 'all', name: '全部', icon: '✨' },
  { id: 'weather', name: '天气', icon: '🌤️' },
  { id: 'traffic', name: '路况', icon: '🚗' },
  { id: 'shop', name: '店铺', icon: '🏪' },
  { id: 'parking', name: '停车', icon: '🅿️' },
  { id: 'queue', name: '排队', icon: '👥' },
  { id: 'other', name: '其他', icon: '💬' }
]

// 排序选项
const SORT_OPTIONS = [
  { value: 'distance', label: '距离最近', icon: '📍' },
  { value: 'points', label: '积分最高', icon: '💎' },
  { value: 'time', label: '时间最新', icon: '⏱️' }
]

// 距离选项
const DISTANCE_OPTIONS = [
  { value: 1000, label: '1公里内', icon: '🚶' },
  { value: 3000, label: '3公里内', icon: '🚲' },
  { value: 5000, label: '5公里内', icon: '🚗' },
  { value: 10000, label: '10公里内', icon: '🚇' },
  { value: 0, label: '全部距离', icon: '🌍' }
]

Page({
  data: {
    currentCity: '成都',
    filters: FILTERS,
    activeFilter: 'all',
    sortOptions: SORT_OPTIONS,
    currentSort: SORT_OPTIONS[0],
    distanceOptions: DISTANCE_OPTIONS,
    currentDistance: DISTANCE_OPTIONS[2], // 默认5公里
    taskList: [],
    totalCount: 0,
    isRefreshing: false,
    isLoading: false,
    isLoadingMore: false,
    hasMore: true,
    isLocating: false,
    showBackToTop: false,
    showSortPopup: false,
    showDistancePopup: false,
    page: 1,
    pageSize: 10
  },

  onLoad() {
    this.loadTasks()
  },

  onShow() {
    // 每次显示页面时刷新
    if (this.data.taskList.length === 0) {
      this.loadTasks()
    }
  },

  // 加载任务列表
  async loadTasks(isRefresh = false) {
    if (this.data.isLoading) return

    this.setData({
      isLoading: !isRefresh,
      isRefreshing: isRefresh,
      page: isRefresh ? 1 : this.data.page
    })

    try {
      // 调用云函数获取真实数据
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-get-needs',
        data: {
          filter: this.data.activeFilter,
          sort: this.data.currentSort.value,
          distance: this.data.currentDistance.value,
          page: this.data.page,
          pageSize: this.data.pageSize
        }
      })

      if (result.code === 0) {
        const list = result.data.list || []
        const total = result.data.total || 0
        const hasMore = result.data.hasMore || false

        const processedList = list.map(item => ({
          ...item,
          distanceText: item.distance < 1000 
            ? item.distance + 'm' 
            : (item.distance / 1000).toFixed(1) + 'km'
        }))

        this.setData({
          taskList: isRefresh ? processedList : [...this.data.taskList, ...processedList],
          totalCount: total,
          hasMore: hasMore
        })
      } else {
        throw new Error(result.message)
      }
    } catch (err) {
      console.error('加载任务失败:', err)
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

  // 选择筛选标签
  selectFilter(e) {
    const filter = e.currentTarget.dataset.filter
    this.setData({
      activeFilter: filter,
      page: 1
    })
    this.loadTasks(true)
  },

  // 显示排序选项
  showSortOptions() {
    this.setData({ showSortPopup: true })
  },

  // 显示距离选项
  showDistanceOptions() {
    this.setData({ showDistancePopup: true })
  },

  // 隐藏弹窗
  hidePopups() {
    this.setData({
      showSortPopup: false,
      showDistancePopup: false
    })
  },

  preventBubble() {
    // 阻止冒泡
  },

  // 选择排序
  selectSort(e) {
    const sort = e.currentTarget.dataset.sort
    this.setData({
      currentSort: sort,
      showSortPopup: false,
      page: 1
    })
    this.loadTasks(true)
  },

  // 选择距离
  selectDistance(e) {
    const distance = e.currentTarget.dataset.distance
    this.setData({
      currentDistance: distance,
      showDistancePopup: false,
      page: 1
    })
    this.loadTasks(true)
  },

  // 下拉刷新
  onRefresh() {
    this.loadTasks(true)
  },

  // 加载更多
  onLoadMore() {
    if (this.data.isLoadingMore || !this.data.hasMore) return

    this.setData({
      isLoadingMore: true,
      page: this.data.page + 1
    })

    this.loadTasks().then(() => {
      this.setData({ isLoadingMore: false })
    })
  },

  // 滚动事件
  onScroll(e) {
    const scrollTop = e.detail.scrollTop
    this.setData({
      showBackToTop: scrollTop > 500
    })
  },

  // 回到顶部
  scrollToTop() {
    wx.pageScrollTo({
      scrollTop: 0,
      duration: 300
    })
    this.setData({ showBackToTop: false })
  },

  // 跳转任务详情
  goToTaskDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({
      url: `/pages/task-detail/task-detail?id=${id}`
    })
  },

  // 接单
  async takeTask(e) {
    const id = e.currentTarget.dataset.id

    // 检查登录
    if (!app.globalData.isLoggedIn) {
      wx.showToast({
        title: '请先登录',
        icon: 'none'
      })
      return
    }

    wx.showModal({
      title: '确认接单',
      content: '接单后请及时提供帮助，完成后将获得积分奖励',
      confirmColor: '#A8E6CF',
      success: (res) => {
        if (res.confirm) {
          this.doTakeTask(id)
        }
      }
    })
  },

  // 执行接单
  async doTakeTask(needId) {
    try {
      wx.showLoading({ title: '接单中...' })

      // 调用云函数
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-take-need',
        data: { needId }
      })

      wx.hideLoading()

      if (result.code === 0) {
        wx.showToast({
          title: '接单成功',
          icon: 'success'
        })

        // 刷新列表
        this.loadTasks(true)

        // 跳转到聊天页
        setTimeout(() => {
          wx.navigateTo({
            url: `/pages/chat/chat?needId=${needId}&isSeeker=false`
          })
        }, 1000)
      } else {
        throw new Error(result.message)
      }
    } catch (err) {
      wx.hideLoading()
      wx.showToast({
        title: err.message || '接单失败',
        icon: 'none'
      })
    }
  },

  // 切换位置
  changeLocation() {
    wx.showToast({
      title: '目前仅开放成都地区',
      icon: 'none'
    })
  },

  // 显示帮助
  showHelp() {
    wx.showModal({
      title: '任务大厅',
      content: '这里展示成都地区的所有待帮助任务。您可以根据类型、距离筛选，点击"接单"即可开始帮助。',
      showCancel: false
    })
  }
})
