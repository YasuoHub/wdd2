const DateUtil = require('../../utils/dateUtil')

Page({
  data: {
    activeTab: 'pending',
    isCustomerService: false,

    // 未处理列表
    pendingTickets: [],
    pendingPage: 1,
    pendingHasMore: true,
    pendingLoading: false,
    pendingLoadingMore: false,

    // 已处理列表
    resolvedTickets: [],
    resolvedPage: 1,
    resolvedHasMore: true,
    resolvedLoading: false,
    resolvedLoadingMore: false
  },

  onLoad() {
    this.checkAuth()
  },

  onShow() {
    if (this.data.isCustomerService) {
      const app = getApp()
      // 从详情页返回，有数据变更时需要刷新
      if (app.globalData.ticketsNeedRefresh) {
        app.globalData.ticketsNeedRefresh = false
        this.loadTickets('pending', true)
        this.loadTickets('resolved', true)
        return
      }
      // 首次加载
      if (this.data.pendingTickets.length === 0 && this.data.resolvedTickets.length === 0) {
        this.loadTickets('pending', true)
      }
    }
  },

  async checkAuth() {
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-get-config',
        data: { action: 'isCustomerService' }
      })
      if (result.code === 0 && result.data.isCustomerService) {
        this.setData({ isCustomerService: true, pendingLoading: true })
        this.loadTickets('pending', true)
      } else {
        wx.showModal({
          title: '无权访问',
          content: '您没有客服权限',
          showCancel: false,
          success: () => { wx.navigateBack() }
        })
      }
    } catch (err) {
      wx.showToast({ title: '验证失败', icon: 'none' })
    }
  },

  async loadTickets(status, reset) {
    const key = status === 'pending' ? 'pending' : 'resolved'
    const pageKey = key + 'Page'
    const listKey = key + 'Tickets'
    const hasMoreKey = key + 'HasMore'
    const loadingKey = key + 'Loading'
    const loadingMoreKey = key + 'LoadingMore'

    if (reset) {
      this.setData({
        [pageKey]: 1,
        [hasMoreKey]: true,
        [listKey]: [],
        [loadingKey]: true
      })
    } else {
      if (!this.data[hasMoreKey] || this.data[loadingMoreKey]) return
      this.setData({ [loadingMoreKey]: true })
    }

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-ticket',
        data: {
          action: 'getTicketList',
          status,
          page: this.data[pageKey],
          pageSize: 20
        }
      })

      if (result.code === 0) {
        const list = result.data.list || []
        const newList = reset ? list : this.data[listKey].concat(list)
        this.setData({
          [listKey]: newList,
          [pageKey]: this.data[pageKey] + 1,
          [hasMoreKey]: result.data.hasMore
        })
      }
    } catch (err) {
      wx.showToast({ title: '加载失败', icon: 'none' })
    }

    this.setData({
      [loadingKey]: false,
      [loadingMoreKey]: false
    })
  },

  onTabChange(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.activeTab) return

    this.setData({ activeTab: tab })

    const key = tab === 'pending' ? 'pending' : 'resolved'
    const listKey = key + 'Tickets'
    if (this.data[listKey].length === 0) {
      this.loadTickets(tab, true)
    }
  },

  onScrollToLower() {
    const tab = this.data.activeTab
    const key = tab === 'pending' ? 'pending' : 'resolved'
    if (this.data[key + 'HasMore']) {
      this.loadTickets(tab, false)
    }
  },

  goToDetail(e) {
    const { id } = e.currentTarget.dataset
    wx.navigateTo({
      url: `/pages/ticket-detail/ticket-detail?ticketId=${id}`
    })
  }
})
