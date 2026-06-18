// 我的接单列表页面逻辑
const app = getApp()
const DateUtil = require('../../utils/dateUtil')
const { STATUS_MAP, getByType, resolveTaskType } = require('../../utils/needTypes')
const { MoneyUtils } = require('../../utils/platformRules')

const FILTER_MAP = {
  'all': { text: '', status: ['ongoing', 'completed', 'breaking', 'cancelled'] },
  'ongoing': { text: '进行中', status: ['ongoing'] },
  'completed': { text: '已完成', status: ['completed'] },
  'breaking': { text: '审核中', status: ['breaking'] },
  'cancelled': { text: '已取消', status: ['cancelled'] }
}

function getBaseAmount(item = {}) {
  return Number(item.rewardAmount || item.reward_amount || 0)
}

function parseDate(value) {
  if (!value) return null
  const normalized = typeof value === 'string' ? value.replace(/-/g, '/') : value
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? null : date
}

function padTime(num) {
  return String(num).padStart(2, '0')
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
}

function formatClock(value, fallback = '') {
  const date = parseDate(value)
  if (!date) return fallback
  const now = new Date()
  const clock = `${padTime(date.getHours())}:${padTime(date.getMinutes())}`
  if (isSameDay(now, date)) return clock

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (isSameDay(yesterday, date)) return `昨天 ${clock}`

  return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`
}

function formatElapsed(value, fallback = '') {
  const date = parseDate(value)
  if (!date) return fallback
  const diff = Date.now() - date.getTime()
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`
  return formatClock(value, fallback)
}

function getTimeMeta(item, createTime) {
  if (item.status === 'completed') {
    return {
      label: '完成时间',
      value: formatClock(item.completeTime || item.complete_time, '待同步')
    }
  }

  if (item.status === 'cancelled') {
    return {
      label: '取消时间',
      value: formatClock(item.cancelTime || item.cancel_time, '待同步')
    }
  }

  return {
    label: '接单时间',
    value: formatElapsed(item.create_time || item.createTime, createTime)
  }
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
    if (this.data.tasks.length === 0 || app.globalData.refreshMyTasks) {
      this.refreshData()
      app.globalData.refreshMyTasks = false
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
      this.setData({
        loading: false,
        hasMore: false,
        ...(this.data.page === 1 ? { tasks: [] } : {})
      })
      wx.showToast({
        title: err.message || '加载失败，请稍后重试',
        icon: 'none'
      })
    }
  },

  // 格式化任务数据
  formatTask(item) {
    const typeInfo = getByType(resolveTaskType(item))
    const statusInfo = STATUS_MAP[item.status] || STATUS_MAP['ongoing']

    // 优先使用后端已格式化的字段
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

    const baseAmount = getBaseAmount(item)
    const timeMeta = getTimeMeta(item, createTime)

    // 申诉按钮显示条件：仅客服裁决取消
    const now = new Date()
    const isArbitrationCancelled = item.status === 'cancelled' && item.cancelReason === 'arbitration_cancelled'
    const endTime = isArbitrationCancelled ? item.cancelTime : null
    const appealDeadline = endTime ? new Date(new Date(endTime).getTime() + 2 * 60 * 60 * 1000) : null
    const showAppealBtn = isArbitrationCancelled &&
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
      displayAmount: MoneyUtils.calcTakerIncome(baseAmount),
      timeLabel: timeMeta.label,
      timeValue: timeMeta.value,
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
  }
})
