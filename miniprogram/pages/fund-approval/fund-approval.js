// 资金审批页面 - 超级管理员审批用户提现申请
const app = getApp()

Page({
  data: {
    activeTab: 'pending',
    isSuperAdmin: false,

    // 待处理列表
    pendingApplications: [],
    pendingPage: 1,
    pendingHasMore: true,
    pendingLoading: false,
    pendingLoadingMore: false,

    // 已处理列表
    resolvedApplications: [],
    resolvedPage: 1,
    resolvedHasMore: true,
    resolvedLoading: false,
    resolvedLoadingMore: false,

    // 审批弹窗
    showApproveModal: false,
    currentApplication: null,
    approveResult: '',
    rejectReason: '',
    rejectReasons: [
      '提现金额超出合理范围',
      '账户存在异常交易行为',
      '身份信息未通过验证',
      '提现频次过高，请稍后再试',
      '不符合平台提现规则',
      '其他原因'
    ]
  },

  onLoad() {
    this.checkAuth()
  },

  onShow() {
    if (this.data.isSuperAdmin) {
      if (this.data.pendingApplications.length === 0 && this.data.resolvedApplications.length === 0) {
        this.loadApplications('pending', true)
      }
    }
  },

  async checkAuth() {
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-get-config',
        data: { action: 'isSuperAdmin' }
      })
      if (result.code === 0 && result.data.isSuperAdmin) {
        this.setData({ isSuperAdmin: true, pendingLoading: true })
        this.loadApplications('pending', true)
      } else {
        wx.showModal({
          title: '无权访问',
          content: '您没有超级管理员权限',
          showCancel: false,
          success: () => { wx.navigateBack() }
        })
      }
    } catch (err) {
      wx.showToast({ title: '验证失败', icon: 'none' })
    }
  },

  async loadApplications(status, reset) {
    const key = status === 'pending' ? 'pending' : 'resolved'
    const pageKey = key + 'Page'
    const listKey = key + 'Applications'
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
        name: 'wdd-withdraw-approval',
        data: {
          action: 'getApplicationList',
          status,
          page: this.data[pageKey] - 1,
          pageSize: 20
        }
      })

      if (result.code === 0) {
        const list = result.data.records || []
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
    const listKey = key + 'Applications'
    if (this.data[listKey].length === 0) {
      this.loadApplications(tab, true)
    }
  },

  onScrollToLower() {
    const tab = this.data.activeTab
    const key = tab === 'pending' ? 'pending' : 'resolved'
    if (this.data[key + 'HasMore']) {
      this.loadApplications(tab, false)
    }
  },

  // 显示审批弹窗
  showApproveModal(e) {
    const { id } = e.currentTarget.dataset
    const list = this.data.activeTab === 'pending' ? this.data.pendingApplications : this.data.resolvedApplications
    const application = list.find(item => item._id === id)
    if (!application) return
    this.setData({
      showApproveModal: true,
      currentApplication: application,
      approveResult: '',
      rejectReason: ''
    })
  },

  hideApproveModal() {
    this.setData({ showApproveModal: false, currentApplication: null })
  },

  onApproveResultChange(e) {
    const idx = parseInt(e.detail.value)
    this.setData({
      approveResult: idx === 0 ? 'approved' : 'rejected',
      rejectReason: ''
    })
  },

  onRejectReasonChange(e) {
    const idx = parseInt(e.detail.value)
    this.setData({ rejectReason: this.data.rejectReasons[idx] })
  },

  // 提交审批
  async submitApprove() {
    const { currentApplication, approveResult, rejectReason } = this.data
    if (!approveResult) {
      wx.showToast({ title: '请选择审批结果', icon: 'none' })
      return
    }
    if (approveResult === 'rejected' && !rejectReason) {
      wx.showToast({ title: '请选择驳回理由', icon: 'none' })
      return
    }

    wx.showLoading({ title: '提交中...', mask: true })

    try {
      const action = approveResult === 'approved' ? 'approve' : 'reject'
      const data = {
        action,
        applicationId: currentApplication._id
      }
      if (action === 'reject') {
        data.rejectReason = rejectReason
      }

      const { result } = await wx.cloud.callFunction({
        name: 'wdd-withdraw-approval',
        data
      })

      wx.hideLoading()

      if (result.code === 0) {
        wx.showToast({ title: result.message, icon: 'success' })
        this.hideApproveModal()
        // 刷新列表
        this.loadApplications('pending', true)
        this.loadApplications('resolved', true)
      } else {
        wx.showToast({ title: result.message, icon: 'none' })
      }
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  }
})
