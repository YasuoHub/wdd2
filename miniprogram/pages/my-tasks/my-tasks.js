// 我的接单列表页面逻辑
const app = getApp()
const DateUtil = require('../../utils/dateUtil')
const { STATUS_MAP, TYPE_MAP } = require('../../config/types')

const FILTER_MAP = {
  'all': { text: '', status: ['ongoing', 'completed', 'breaking', 'cancelled'] },
  'ongoing': { text: '进行中', status: ['ongoing'] },
  'completed': { text: '已完成', status: ['completed'] },
  'breaking': { text: '审核中', status: ['breaking'] },
  'cancelled': { text: '已取消', status: ['cancelled'] }
}

Page({
  data: {
    currentFilter: 'all',
    filterText: '',
    tasks: [],
    stats: {
      total: 0,
      ongoing: 0,
      points: 0
    },
    page: 1,
    pageSize: 10,
    hasMore: false,
    loading: false
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
    this.loadTasks()
  },

  onShow() {
    // 检查登录状态
    if (!app.globalData.isLoggedIn) {
      return
    }
    // 如果标记需要刷新，或者数据为空，则重新加载
    if (this.data.tasks.length === 0 || wx.getStorageSync('refreshMyTasks')) {
      this.refreshData()
      wx.removeStorageSync('refreshMyTasks')
    }
  },

  // 刷新数据
  refreshData() {
    this.setData({
      page: 1,
      tasks: []
    }, () => {
      this.loadTasks()
    })
  },

  // 下拉刷新
  onPullDownRefresh() {
    this.refreshData()
    // 停止下拉刷新动画
    wx.stopPullDownRefresh()
  },

  // 切换筛选条件
  switchFilter(e) {
    const filter = e.currentTarget.dataset.filter
    this.setData({
      currentFilter: filter,
      filterText: FILTER_MAP[filter].text,
      page: 1,
      tasks: []
    }, () => {
      this.loadTasks()
    })
  },

  // 加载任务列表
  async loadTasks() {
    if (this.data.loading) return

    this.setData({ loading: true })

    try {
      wx.showLoading({ title: '加载中...' })

      const { currentFilter, page, pageSize } = this.data
      const statusFilter = FILTER_MAP[currentFilter].status

      const { result } = await wx.cloud.callFunction({
        name: 'wdd-get-needs',
        data: {
          action: 'getMyTasks',
          status: statusFilter,
          page,
          pageSize
        }
      })

      wx.hideLoading()

      if (result.code === 0) {
        const formattedTasks = result.data.list.map(item => this.formatTask(item))

        this.setData({
          tasks: page === 1 ? formattedTasks : [...this.data.tasks, ...formattedTasks],
          stats: result.data.stats || this.data.stats,
          hasMore: result.data.hasMore,
          loading: false
        })
      } else {
        throw new Error(result.message)
      }
    } catch (err) {
      wx.hideLoading()
      console.error('加载任务失败:', err)
      this.setData({ loading: false })

      // 使用模拟数据展示效果
      if (this.data.page === 1) {
        this.setMockData()
      }
    }
  },

  // 格式化任务数据
  formatTask(item) {
    const typeInfo = TYPE_MAP[item.type] || TYPE_MAP['other']
    const statusInfo = STATUS_MAP[item.status] || STATUS_MAP['ongoing']

    // 优先使用后端已格式化的字段，兼容旧字段
    let remainTime = item.remainTime || ''
    if (!remainTime && item.expire_time) {
      const expire = new Date(item.expire_time)
      const now = new Date()
      const diff = expire - now

      if (diff > 0) {
        const hours = Math.floor(diff / (1000 * 60 * 60))
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
        remainTime = hours > 0 ? `${hours}时${minutes}分` : `${minutes}分钟`
      }
    }

    // 优先使用后端已格式化的 createTime
    let createTime = item.createTime
    if (!createTime && item.create_time) {
      createTime = DateUtil.formatRelativeTime(item.create_time)
    }

    // 申诉按钮显示条件：仅已完成 或 客服裁决取消
    const now = new Date()
    const isCompleted = item.status === 'completed'
    const isArbitrationCancelled = item.status === 'cancelled' && item.cancelReason === 'arbitration_cancelled'
    const endTime = isCompleted ? item.completeTime : (isArbitrationCancelled ? item.cancelTime : null)
    const appealDeadline = endTime ? new Date(new Date(endTime).getTime() + 2 * 60 * 60 * 1000) : null
    const showAppealBtn = (isCompleted || isArbitrationCancelled) &&
      !item.hasMyAppeal &&
      appealDeadline &&
      now <= appealDeadline

    return {
      ...item,
      typeName: typeInfo.name,
      typeIcon: typeInfo.icon,
      color: typeInfo.color,
      bgColor: typeInfo.bgColor,
      statusText: statusInfo.text,
      statusClass: statusInfo.class,
      locationName: item.locationName || '未知位置',
      seekerNickname: item.seeker_nickname || item.seekerNickname || '匿名用户',
      remainTime,
      createTime,
      showAppealBtn
    }
  },

  // 加载更多
  loadMore() {
    if (!this.data.hasMore || this.data.loading) return

    this.setData({
      page: this.data.page + 1
    }, () => {
      this.loadTasks()
    })
  },

  // 跳转到详情
  goToDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({
      url: `/pages/task-detail/task-detail?id=${id}`
    })
  },

  // 进入聊天
  goToChat(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({
      url: `/pages/chat/chat?needId=${id}`
    })
  },

  // 跳转申诉页面
  goToAppeal(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({
      url: `/pages/appeal/appeal?mode=initiate&needId=${id}`
    })
  },

  // 去评价
  goToRate(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({
      url: `/pages/rating/rating?needId=${id}&type=taker`
    })
  },

  // 查看评价
  viewRating(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({
      url: `/pages/rating-detail/rating-detail?needId=${id}&type=taker`
    })
  },

  // 去大厅
  goToHall() {
    wx.switchTab({
      url: '/pages/task-hall/task-hall'
    })
  },

  // 模拟数据
  setMockData() {
    const mockData = [
      {
        _id: '1',
        need_id: '101',
        type: 'weather',
        description: '天府广场现在在下雨吗？准备出门',
        location: { name: '天府广场' },
        points: 10,
        status: 'ongoing',
        seeker_nickname: '小明',
        create_time: new Date(Date.now() - 1800000)
      },
      {
        _id: '2',
        need_id: '102',
        type: 'shop',
        description: '春熙路HM开门了吗？',
        location: { name: '春熙路' },
        points: 15,
        status: 'completed',
        seeker_nickname: '小红',
        create_time: new Date(Date.now() - 172800000)
      }
    ]

    this.setData({
      tasks: mockData.map(item => this.formatTask(item)),
      stats: { total: 12, ongoing: 2, points: 156 },
      hasMore: false
    })
  }
})
