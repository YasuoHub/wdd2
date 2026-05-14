// 我的求助列表页面逻辑
const app = getApp()
const DateUtil = require('../../utils/dateUtil')
const { STATUS_MAP, TYPE_MAP } = require('../../config/types')

const FILTER_MAP = {
  'all': { text: '', status: ['pending', 'ongoing', 'completed', 'cancelled', 'breaking'] },
  'ongoing': { text: '进行中', status: ['ongoing'] },
  'completed': { text: '已完成', status: ['completed'] },
  'cancelled': { text: '已取消', status: ['cancelled'] },
  'breaking': { text: '审核中', status: ['breaking'] }
}

Page({
  data: {
    currentFilter: 'all',
    filterText: '',
    needs: [],
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
      needs: []
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
      needs: []
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
  formatNeed(item) {
    const typeInfo = TYPE_MAP[item.type] || TYPE_MAP['other']
    const statusInfo = STATUS_MAP[item.status] || STATUS_MAP['pending']

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
      // 云函数已返回 locationName，直接使用，不要覆盖
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
      wx.showToast({
        title: '该任务已被接受，无法取消',
        icon: 'none',
        duration: 2000
      })
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
      content: '确认已获得所需信息？完成后积分将转给帮助者。',
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
        // 跳转到评价页面
        setTimeout(() => {
          wx.navigateTo({
            url: `/pages/rating/rating?needId=${id}&type=seeker`
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

  // 去发布
  goToPublish() {
    wx.switchTab({
      url: '/pages/index/index'
    })
  },

  // 模拟数据
  setMockData() {
    const mockData = [
      {
        _id: '1',
        type: 'shop',
        description: '春熙路的星巴克今天开门吗？想确认一下营业时间和人流情况',
        location: { name: '春熙路' },
        points: 15,
        status: 'ongoing',
        create_time: new Date(Date.now() - 3600000)
      },
      {
        _id: '2',
        type: 'weather',
        description: '天府广场现在在下雨吗？准备出门',
        location: { name: '天府广场' },
        points: 10,
        status: 'completed',
        create_time: new Date(Date.now() - 86400000)
      },
      {
        _id: '3',
        type: 'parking',
        description: '太古里停车场现在好停车吗？有位置吗',
        location: { name: '太古里' },
        points: 12,
        status: 'cancelled',
        create_time: new Date(Date.now() - 172800000)
      }
    ]

    this.setData({
      needs: mockData.map(item => this.formatNeed(item)),
      hasMore: false
    })
  }
})
