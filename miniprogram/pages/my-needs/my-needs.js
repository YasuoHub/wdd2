// 我的求助列表页面逻辑
const app = getApp()
const DateUtil = require('../../utils/dateUtil')
const { STATUS_MAP, getByType, resolveTaskType } = require('../../utils/needTypes')

const FILTER_MAP = {
  'all': { text: '', status: ['pending', 'ongoing', 'completed', 'cancelled', 'breaking'] },
  'ongoing': { text: '进行中', status: ['ongoing'] },
  'completed': { text: '已完成', status: ['completed'] },
  'cancelled': { text: '已取消', status: ['cancelled'] },
  'breaking': { text: '审核中', status: ['breaking'] }
}

function getBaseAmount(item = {}) {
  return Number(item.rewardAmount || item.reward_amount || 0)
}

function parseDate(value) {
  return DateUtil.parseDate(value)
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

function getNeedTimeMeta(item, options = {}) {
  const { remainTime, startTimeText, completeTimeText, cancelTimeText } = options

  if (item.status === 'cancelled') {
    return {
      label: '取消时间',
      value: cancelTimeText
    }
  }

  if (item.status === 'pending') {
    return {
      label: '剩余时间',
      value: remainTime || '等待匹配'
    }
  }

  if (item.status === 'ongoing') {
    return {
      label: '开始时间',
      value: startTimeText
    }
  }

  if (item.status === 'breaking') {
    return {
      label: '开始时间',
      value: startTimeText
    }
  }

  if (item.status === 'completed') {
    return {
      label: '完成时间',
      value: completeTimeText
    }
  }

  return {
    label: '发布时间',
    value: formatClock(item.create_time || item.createTime, '待同步')
  }
}

Page({
  data: {
    currentFilter: 'all',
    filterText: '',
    needs: [],
    page: 1,
    pageSize: 10,
    hasMore: false,
    loading: false,
    loaded: false
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
    this.loadNeeds()
  },

  onShow() {
    // 检查登录状态
    if (!app.globalData.isLoggedIn) {
      return
    }
    // 如果标记需要刷新，或者数据为空，则重新加载
    if (this.data.needs.length === 0 || app.globalData.refreshMyNeeds) {
      this.refreshData()
      app.globalData.refreshMyNeeds = false
    }
  },

  // 刷新数据
  refreshData() {
    this.setData({
      page: 1,
      needs: [],
      hasMore: false,
      loaded: false
    }, () => {
      this.loadNeeds()
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
      needs: [],
      hasMore: false,
      loaded: false
    }, () => {
      this.loadNeeds()
    })
  },

  // 加载任务列表
  async loadNeeds() {
    if (this.data.loading) return

    this.setData({ loading: true })

    try {
      wx.showLoading({ title: '加载中...' })

      const { currentFilter, page, pageSize } = this.data
      const statusFilter = FILTER_MAP[currentFilter].status

      const { result } = await wx.cloud.callFunction({
        name: 'wdd-get-needs',
        data: {
          action: 'getMyNeeds',
          status: statusFilter,
          page,
          pageSize
        }
      })

      wx.hideLoading()

      if (result.code === 0) {
        const formattedNeeds = result.data.list.map(item => this.formatNeed(item))

        this.setData({
          needs: page === 1 ? formattedNeeds : [...this.data.needs, ...formattedNeeds],
          hasMore: result.data.hasMore,
          loading: false,
          loaded: true
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
        loaded: true,
        ...(this.data.page === 1 ? { needs: [] } : {})
      })
      wx.showToast({
        title: err.message || '加载失败，请稍后重试',
        icon: 'none'
      })
    }
  },

  // 格式化任务数据
  formatNeed(item) {
    const typeInfo = getByType(resolveTaskType(item))
    const statusInfo = STATUS_MAP[item.status] || STATUS_MAP['pending']

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

    const publishSource = item.create_time || item.createTime
    const matchSource = item.matchTime || item.match_time || item.takeTime || item.take_time
    const completeSource = item.completeTime || item.complete_time
    const cancelSource = item.cancelTime || item.cancel_time
    const startTimeText = formatClock(matchSource, '待同步')
    const completeTimeText = formatClock(completeSource, '待同步')
    const cancelTimeText = formatClock(cancelSource, '待同步')
    const timeMeta = getNeedTimeMeta(item, {
      remainTime,
      startTimeText,
      completeTimeText,
      cancelTimeText
    })

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
      // 云函数已返回 locationName，直接使用，不要覆盖
      locationName: item.locationName || '未知位置',
      displayAmount: getBaseAmount(item),
      publishTime: formatClock(publishSource, createTime),
      takerTimeText: formatElapsed(matchSource, createTime || '刚刚'),
      endTimeText: item.status === 'completed' ? completeTimeText : cancelTimeText,
      timeLabel: timeMeta.label,
      timeValue: timeMeta.value,
      remainTime,
      createTime,
      showAppealBtn,
      showExperienceShare: !!item.showExperienceShare,
      experienceId: item.experienceId || '',
      experienceStatus: item.experienceStatus || ''
    }
  },

  // 加载更多
  loadMore() {
    if (!this.data.hasMore || this.data.loading) return

    this.setData({
      page: this.data.page + 1
    }, () => {
      this.loadNeeds()
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

  isTaskAlreadyAcceptedError(result) {
    return result && result.errorCode === 'TASK_ALREADY_ACCEPTED'
  },

  openChatAfterCancelRejected(id) {
    if (!id) return
    app.globalData.refreshMyNeeds = true
    this.refreshData()
    wx.showToast({
      title: '已接单，打开聊天',
      icon: 'none',
      duration: 900
    })
    setTimeout(() => {
      wx.navigateTo({
        url: `/pages/chat/chat?needId=${id}`
      })
    }, 900)
  },

  // 跳转申诉页面
  goToAppeal(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({
      url: `/pages/appeal/appeal?mode=initiate&needId=${id}`
    })
  },

  // 取消任务
  cancelNeed(e) {
    const { id, status } = e.currentTarget.dataset

    // 如果任务已被接单（ongoing状态），提示不能取消
    if (status === 'ongoing') {
      this.openChatAfterCancelRejected(id)
      return
    }

    if (status !== 'pending') {
      wx.showToast({
        title: '该任务无法取消',
        icon: 'none'
      })
      return
    }

    wx.showModal({
      title: '确认取消',
      content: '取消后悬赏金额将原路退回，确定要取消吗？',
      confirmColor: '#FF6B6B',
      success: (res) => {
        if (res.confirm) {
          this.doCancelNeed(id)
        }
      }
    })
  },

  // 执行取消任务
  async doCancelNeed(id) {
    try {
      wx.showLoading({ title: '处理中...' })

      const { result } = await wx.cloud.callFunction({
        name: 'wdd-settlement',
        data: {
          action: 'cancelTask',
          needId: id
        }
      })

      wx.hideLoading()

      if (result.code === 0) {
        wx.showToast({
          title: result.message || '已取消',
          icon: 'none',
          duration: 2500
        })
        // 设置刷新标记
        app.globalData.refreshMyNeeds = true
        this.refreshData()
      } else if (this.isTaskAlreadyAcceptedError(result)) {
        this.openChatAfterCancelRejected(id)
      } else {
        throw new Error(result.message)
      }
    } catch (err) {
      wx.hideLoading()
      wx.showToast({
        title: err.message || '取消失败',
        icon: 'none'
      })
    }
  },

  // 去评价
  goToRate(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({
      url: `/pages/rating/rating?needId=${id}&type=seeker`
    })
  },

  // 查看评价
  viewRating(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({
      url: `/pages/rating-detail/rating-detail?needId=${id}&type=seeker`
    })
  },

  // 完成任务
  completeNeed(e) {
    const { id } = e.currentTarget.dataset

    wx.showModal({
      title: '确认完成',
      content: '确认已获得所需信息？完成后悬赏将结算给帮助者。',
      confirmColor: '#6DD5B0',
      success: (res) => {
        if (res.confirm) {
          this.doCompleteNeed(id)
        }
      }
    })
  },

  // 执行完成任务
  async doCompleteNeed(id) {
    try {
      wx.showLoading({ title: '处理中...' })

      const { result } = await wx.cloud.callFunction({
        name: 'wdd-settlement',
        data: {
          action: 'completeTask',
          needId: id
        }
      })

      wx.hideLoading()

      if (result.code === 0) {
        wx.showToast({
          title: '任务已完成',
          icon: 'success'
        })
        setTimeout(() => this.promptExperienceShare(id), 700)
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

  promptExperienceShare(id) {
    wx.showModal({
      title: '分享当地经验',
      content: '是否将本次任务整理成公开经验，帮助有相同问题的人？',
      confirmText: '申请分享',
      cancelText: '暂不分享',
      success: res => {
        if (res.confirm) {
          wx.navigateTo({ url: `/pages/experience-edit/experience-edit?needId=${id}` })
        } else {
          wx.navigateTo({ url: `/pages/rating/rating?needId=${id}&type=seeker` })
        }
      }
    })
  },

  shareExperience(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/experience-edit/experience-edit?needId=${id}` })
  },

  // 去发布
  goToPublish() {
    wx.switchTab({
      url: '/pages/index/index'
    })
  }
})
