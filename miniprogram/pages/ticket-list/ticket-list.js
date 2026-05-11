const DateUtil = require('../../utils/dateUtil')

Page({
  data: {
    tickets: [],
    loading: false,
    isCustomerService: false
  },

  onLoad() {
    this.checkAuth()
  },

  onShow() {
    if (this.data.isCustomerService) {
      this.loadTickets()
    }
  },

  async checkAuth() {
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-get-config',
        data: { action: 'isCustomerService' }
      })
      if (result.code === 0 && result.data.isCustomerService) {
        this.setData({ isCustomerService: true })
        this.loadTickets()
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

  async loadTickets() {
    this.setData({ loading: true })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-ticket',
        data: { action: 'getTicketList', status: 'pending' }
      })
      if (result.code === 0) {
        const tickets = (result.data.list || []).map(item => ({
          ...item,
          createTimeFormatted: DateUtil.formatDateTime(item.createTime)
        }))
        this.setData({ tickets })
      }
    } catch (err) {
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
    this.setData({ loading: false })
  },

  goToDetail(e) {
    const { id } = e.currentTarget.dataset
    wx.navigateTo({
      url: `/pages/ticket-detail/ticket-detail?ticketId=${id}`
    })
  }
})
