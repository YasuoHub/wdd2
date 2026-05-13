const DateUtil = require('../../utils/dateUtil')
const { TYPE_MAP } = require('../../config/types')

Page({
  data: {
    activeTab: 'pending',
    pendingList: [],
    processedList: [],
    pendingSkip: 0,
    processedSkip: 0,
    pendingHasMore: true,
    processedHasMore: true,
    loading: false
  },

  onLoad() {
    this.loadList('pending', true)
  },

  onShow() {
    if (this.data.activeTab === 'pending') {
      this.loadList('pending', true)
    }
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.activeTab) return
    this.setData({ activeTab: tab })
    const listKey = tab === 'pending' ? 'pendingList' : 'processedList'
    if (this.data[listKey].length === 0) {
      this.loadList(tab, true)
    }
  },

  async loadList(status, reset) {
    if (this.data.loading) return

    const skip = reset ? 0 : this.data[status + 'Skip']
    this.setData({ loading: true })

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-appeal',
        data: { action: 'getMyAppealList', status, skip, limit: 20 }
      })

      if (result.code !== 0) {
        wx.showToast({ title: result.message || '加载失败', icon: 'none' })
        return
      }

      const { list, hasMore } = result.data
      const listKey = status === 'pending' ? 'pendingList' : 'processedList'
      const skipKey = status === 'pending' ? 'pendingSkip' : 'processedSkip'
      const moreKey = status === 'pending' ? 'pendingHasMore' : 'processedHasMore'

      const formattedList = list.map(item => {
        const taskType = item.taskInfo && item.taskInfo.type
        const typeMeta = TYPE_MAP[taskType] || {}
        return {
          ...item,
          createTimeText: DateUtil.formatDateTime(item.createTime),
          taskIcon: typeMeta.icon || '📌',
          taskColor: typeMeta.color || '#636e72',
          taskBgColor: typeMeta.bgColor || 'rgba(99, 110, 114, 0.1)'
        }
      })

      const newList = reset ? formattedList : this.data[listKey].concat(formattedList)

      this.setData({
        [listKey]: newList,
        [skipKey]: skip + list.length,
        [moreKey]: hasMore
      })
    } catch (err) {
      console.error('加载申诉列表失败:', err)
      wx.showToast({ title: '加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  loadMore() {
    const status = this.data.activeTab
    const moreKey = status === 'pending' ? 'pendingHasMore' : 'processedHasMore'
    if (!this.data[moreKey] || this.data.loading) return
    this.loadList(status, false)
  },

  cancelAppeal(e) {
    const { id } = e.currentTarget.dataset
    wx.showModal({
      title: '确认撤销',
      content: '撤销后任务将恢复正常，但不可再次发起申诉。确定要撤销吗？',
      confirmColor: '#e17055',
      success: async (res) => {
        if (!res.confirm) return
        try {
          wx.showLoading({ title: '撤销中...' })
          const { result } = await wx.cloud.callFunction({
            name: 'wdd-appeal',
            data: { action: 'cancelAppeal', appealId: id }
          })
          wx.hideLoading()

          if (result.code === 0) {
            wx.showToast({ title: '已撤销', icon: 'success' })
            this.loadList('pending', true)
            this.setData({ processedList: [], processedSkip: 0, processedHasMore: true })
          } else {
            wx.showToast({ title: result.message || '撤销失败', icon: 'none' })
          }
        } catch (err) {
          wx.hideLoading()
          console.error('撤销申诉失败:', err)
          wx.showToast({ title: '撤销失败', icon: 'none' })
        }
      }
    })
  },

  goDetail(e) {
    const { id } = e.currentTarget.dataset
    wx.navigateTo({
      url: '/pages/appeal-detail/appeal-detail?appealId=' + id
    })
  }
})
