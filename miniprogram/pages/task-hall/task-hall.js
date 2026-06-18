// 任务大厅
const app = getApp()

const { callCloudFunction } = require('../../utils/cloud')
const { NEED_TYPES, withTypeMeta } = require('../../utils/needTypes')

// 筛选标签
const FILTERS = [
  { id: 'all', name: '全部', icon: 'sparkles', color: 'var(--brand-primary)' },
  ...NEED_TYPES.map(item => ({
    id: item.type,
    name: item.shortName,
    icon: item.icon,
    color: item.color
  }))
]

// 排序选项
const SORT_OPTIONS = [
  { value: 'distance', label: '距离最近', icon: 'map-pin', color: 'var(--brand-primary)' },
  { value: 'reward', label: '金额最高', icon: 'circle-dollar-sign', color: 'var(--vitality-orange)' },
  { value: 'time', label: '时间最新', icon: 'clock-3', color: 'var(--text-tertiary)' }
]

// 距离选项
const LIMITED_DISTANCE_OPTIONS = [
  { value: 1000, label: '1公里内', icon: 'locate-fixed', color: 'var(--brand-primary)' },
  { value: 3000, label: '3公里内', icon: 'route', color: 'var(--brand-primary)' },
  { value: 5000, label: '5公里内', icon: 'map-pin', color: 'var(--brand-primary)' },
  { value: 10000, label: '10公里内', icon: 'map', color: 'var(--brand-primary)' }
]
const UNLIMITED_DISTANCE_OPTION = { value: 0, label: '不限距离', icon: 'circle-ellipsis', color: 'var(--text-tertiary)' }
const DISTANCE_OPTIONS = [...LIMITED_DISTANCE_OPTIONS, UNLIMITED_DISTANCE_OPTION]
const DEFAULT_DISTANCE_OPTION = LIMITED_DISTANCE_OPTIONS[2]

Page({
  data: {
    filters: FILTERS,
    activeFilter: 'all',
    sortOptions: SORT_OPTIONS,
    currentSort: SORT_OPTIONS[0],
    distanceOptions: LIMITED_DISTANCE_OPTIONS,
    currentDistance: DEFAULT_DISTANCE_OPTION, // 默认5公里
    canUseUnlimitedDistance: false,
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
    pageSize: 10,
    // 帮助者资料提示
    showHelperProfileTip: false,
    userProfile: null,
    // 用户当前位置（从全局获取）
    userLocation: null,
    // 刷新控制
    lastRefreshTime: 0,      // 上次刷新时间戳
    refreshInterval: 30000,  // 最小刷新间隔 30秒
    currentRequestId: null   // 当前请求ID，用于取消旧请求
  },

  onLoad() {
    // 从全局数据获取位置
    this.syncUserLocationFromGlobal()
    // 加载任务
    this.loadTasks()
  },

  // 从全局同步用户位置
  syncUserLocationFromGlobal() {
    const globalLocation = app.getUserLocation()
    if (globalLocation) {
      this.setData({
        userLocation: globalLocation
      })
      console.log('从全局同步位置:', globalLocation.latitude, globalLocation.longitude)
    }
  },

  onShow() {
    // 更新消息角标
    app.updateTabBarBadge()
    // 用户登录状态或后台权限变更后，刷新距离筛选权限
    this.refreshDistancePermission()

    // 检查是否需要强制刷新
    const forceRefresh = wx.getStorageSync('forceRefreshTaskHall')
    if (forceRefresh) {
      wx.removeStorageSync('forceRefreshTaskHall')
      this.syncUserLocationFromGlobal()
      this.loadTasks(true)
      return
    }

    // 判断是否需要刷新（超过刷新间隔）
    const now = Date.now()
    const shouldRefresh = now - this.data.lastRefreshTime > this.data.refreshInterval

    if (shouldRefresh) {
      // 从全局同步最新位置并刷新任务列表
      this.syncUserLocationFromGlobal()
      this.loadTasks(true)
    }
  },

  // 刷新距离筛选权限：仅超级管理员和客服可使用“不限距离”
  async refreshDistancePermission() {
    app.checkLoginStatus()

    if (!app.globalData.isLoggedIn) {
      this.applyDistancePermission(false)
      return
    }

    try {
      const { result } = await callCloudFunction({
        name: 'wdd-get-config',
        data: { action: 'getRoleFlags' },
        dedupe: true,
        dedupeKey: 'wdd-get-config:role-flags'
      })

      const flags = result && result.code === 0 && result.data ? result.data : {}
      this.applyDistancePermission(!!(flags.isCustomerService || flags.isSuperAdmin))
    } catch (err) {
      console.error('刷新距离筛选权限失败:', err)
      this.applyDistancePermission(false)
    }
  },

  applyDistancePermission(canUseUnlimitedDistance) {
    const wasUnlimited = this.data.currentDistance && this.data.currentDistance.value === 0
    const nextData = {
      canUseUnlimitedDistance,
      distanceOptions: canUseUnlimitedDistance ? DISTANCE_OPTIONS : LIMITED_DISTANCE_OPTIONS
    }

    if (!canUseUnlimitedDistance && wasUnlimited) {
      nextData.currentDistance = DEFAULT_DISTANCE_OPTION
      nextData.showDistancePopup = false
      nextData.page = 1
    }

    this.setData(nextData)

    if (!canUseUnlimitedDistance && wasUnlimited) {
      this.loadTasks(true)
    }
  },

// 加载任务列表
  async loadTasks(isRefresh = false) {
    // 生成当前请求ID
    const requestId = Date.now()
    this.setData({ currentRequestId: requestId })

    this.setData({
      isLoading: !isRefresh,
      isRefreshing: isRefresh,
      page: isRefresh ? 1 : this.data.page
    })

    try {
      console.log('开始加载任务列表...')
      const sortValue = typeof this.data.currentSort === 'string'
        ? this.data.currentSort
        : this.data.currentSort.value
      const distanceValue = typeof this.data.currentDistance === 'number'
        ? this.data.currentDistance
        : this.data.currentDistance.value
      // 准备请求参数
      const requestData = {
        filter: this.data.activeFilter,
        sort: sortValue,
        distance: distanceValue === 0 && !this.data.canUseUnlimitedDistance
          ? DEFAULT_DISTANCE_OPTION.value
          : distanceValue,
        page: this.data.page,
        pageSize: this.data.pageSize
      }

      // 如果用户位置存在，传递给云函数
      if (this.data.userLocation) {
        requestData.latitude = this.data.userLocation.latitude
        requestData.longitude = this.data.userLocation.longitude
      }

      // 调用云函数获取真实数据
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-get-needs',
        data: requestData
      })

      console.log('云函数返回结果:', result)

      if (result.code === 0) {
        const list = result.data.list || []
        const total = result.data.total || 0
        const hasMore = result.data.hasMore || false

        console.log('获取到任务数量:', list.length, '总数:', total)

        const processedList = list.map(item => {
          const typeMeta = withTypeMeta(item)
          // 只有有效距离（小于 999km）才显示距离文本
          let distanceText = ''
          if (item.distance && item.distance < 999000) {
            distanceText = item.distance < 1000
              ? item.distance + 'm'
              : (item.distance / 1000).toFixed(1) + 'km'
          }
          return {
            ...item,
            type: typeMeta.type,
            typeName: typeMeta.typeName,
            distanceText,
            typeIcon: typeMeta.typeIcon,
            iconColor: typeMeta.iconColor
          }
        })

        // 检查是否需要显示帮助者资料完善提示
        const userProfile = result.data.userProfile
        const showHelperProfileTip = userProfile && !userProfile.hasHelperProfile

        // 根据用户设置重新排序筛选标签
        const sortedFilters = this.sortFiltersByUserPreference(userProfile)

        // 检查是否是最新请求的结果
        if (this.data.currentRequestId !== requestId) {
          console.log('请求已过期，忽略结果')
          return
        }

        this.setData({
          taskList: isRefresh ? processedList : [...this.data.taskList, ...processedList],
          totalCount: total,
          hasMore: hasMore,
          isRefreshing: false,
          isLoading: false,
          showHelperProfileTip,
          userProfile,
          filters: sortedFilters,
          lastRefreshTime: Date.now()  // 更新上次刷新时间
        })
      } else {
        throw new Error(result.message)
      }
    } catch (err) {
      console.error('加载任务失败:', err)
      // 检查是否是最新请求的错误
      if (this.data.currentRequestId !== requestId) {
        console.log('请求已过期，忽略错误')
        return
      }
      this.setData({
        taskList: [],
        isRefreshing: false,
        isLoading: false
      })
      wx.showToast({
        title: '加载失败',
        icon: 'none'
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
    const nextSort = typeof sort === 'string'
      ? (SORT_OPTIONS.find(item => item.value === sort) || SORT_OPTIONS[0])
      : sort
    this.setData({
      currentSort: nextSort,
      showSortPopup: false,
      page: 1
    })
    this.loadTasks(true)
  },

  // 选择距离
  selectDistance(e) {
    const distance = e.currentTarget.dataset.distance
    const distanceValue = typeof distance === 'number' ? distance : Number(distance && distance.value)
    const nextDistance = typeof distance === 'object'
      ? distance
      : (DISTANCE_OPTIONS.find(item => item.value === distanceValue) || DEFAULT_DISTANCE_OPTION)
    this.setData({
      currentDistance: nextDistance,
      showDistancePopup: false,
      page: 1
    })
    this.loadTasks(true)
  },

  // 下拉刷新
  onRefresh() {
    // 从全局同步最新位置，再刷新任务
    this.syncUserLocationFromGlobal()
    this.loadTasks(true)
  },

  // 加载更多
  onLoadMore() {
    if (this.data.isLoadingMore || !this.data.hasMore) return

    this.setData({
      isLoadingMore: true,
      page: this.data.page + 1
    })

    this.loadTasks(false).then(() => {
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
    const incomeAmount = parseFloat(e.currentTarget.dataset.amount) || 0

    // 检查登录
    if (!app.globalData.isLoggedIn) {
      wx.showToast({
        title: '请先登录',
        icon: 'none'
      })
      return
    }

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

    wx.showModal({
      title: '确认去帮助',
      content: `完成此任务可获得 ${incomeAmount} 元，确定要去帮助吗？`,
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
      wx.showLoading({ title: '处理中...' })

      // 调用云函数
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-take-need',
        data: { needId }
      })

      wx.hideLoading()

      if (result.code === 0) {
        wx.showToast({
          title: '已开始帮助',
          icon: 'success'
        })

        // 刷新列表
        this.loadTasks(true)

        // 设置刷新标记，返回时刷新"我的接单"页面
        app.globalData.refreshMyTasks = true

        // 跳转到聊天页
        setTimeout(() => {
          wx.navigateTo({
            url: `/pages/chat/chat?needId=${needId}`
          })
        }, 1000)
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
      content: '这里展示成都地区的所有待帮助任务。您可以根据类型、距离筛选，点击"去帮助"即可开始帮助。',
      showCancel: false
    })
  },

  // 关闭帮助者资料提示
  closeHelperProfileTip() {
    this.setData({
      showHelperProfileTip: false
    })
  },

  // 跳转到帮助者资料页面
  goToHelperProfile() {
    wx.navigateTo({
      url: '/pages/helper-profile/helper-profile?edit=true'
    })
  },

  // 空状态按钮点击 - 查看全部类型
  onViewAllTap() {
    this.setData({
      activeFilter: 'all',
      page: 1
    })
    this.loadTasks(true)
  },

  // 根据用户设置的帮助类型重新排序筛选标签
  sortFiltersByUserPreference(userProfile) {
    // 如果没有用户资料或没有设置帮助类型，返回默认排序
    if (!userProfile || !userProfile.helpTypes || userProfile.helpTypes.length === 0) {
      return FILTERS
    }

    const userHelpTypes = userProfile.helpTypes

    // 分离用户设置的类型和其他类型
    const userTypes = []
    const otherTypes = []

    FILTERS.forEach(filter => {
      if (filter.id === 'all') {
        // "全部"保持不动
        return
      }
      if (userHelpTypes.includes(filter.id)) {
        // 按照用户设置的顺序添加
        const index = userHelpTypes.indexOf(filter.id)
        userTypes[index] = filter
      } else {
        otherTypes.push(filter)
      }
    })

    // 合并：全部 + 用户设置的类型（按设置顺序）+ 其他类型
    const sortedFilters = [
      FILTERS[0], // "全部"
      ...userTypes.filter(Boolean), // 用户设置的类型（去除空位）
      ...otherTypes // 其他类型
    ]

    return sortedFilters
  }
})
