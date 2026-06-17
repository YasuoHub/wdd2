const DateUtil = require('../../utils/dateUtil')
const { getByType, resolveTaskType } = require('../../utils/needTypes')

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
        name: 'wdd-report',
        data: { action: 'getMyReportList', status, skip, limit: 20 }
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
        const taskType = resolveTaskType(item.taskInfo)
        const typeMeta = getByType(taskType)
        return {
          ...item,
          taskInfo: item.taskInfo ? { ...item.taskInfo, type: taskType, typeName: typeMeta.name } : item.taskInfo,
          displayTitle: (item.taskInfo && (item.taskInfo.title || item.taskInfo.description || item.taskInfo.locationName)) || item.reason || '举报记录',
          displayTaskName: item.taskInfo ? typeMeta.name : '关联任务',
          displayTarget: item.reportedNickname || item.targetNickname || item.reportedUserNickname || '任务相关用户',
          displayRewardAmount: item.taskInfo ? (item.taskInfo.rewardAmount || 0) : 0,
          createTimeText: DateUtil.formatDateTime(item.createTime),
          taskIcon: typeMeta.icon || 'clipboard-list',
          taskColor: typeMeta.color || 'var(--type-other-color)',
          taskBgColor: typeMeta.bgColor || 'var(--type-other-bg)'
        }
      })

      const newList = reset ? formattedList : this.data[listKey].concat(formattedList)

      this.setData({
        [listKey]: newList,
        [skipKey]: skip + list.length,
        [moreKey]: hasMore
      })
    } catch (err) {
      console.error('加载举报列表失败:', err)
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

  cancelReport(e) {
    const { id } = e.currentTarget.dataset
    wx.showModal({
      title: '确认撤销',
      content: '撤销后任务将恢复正常，但不可再次发起举报。确定要撤销吗？',
      confirmColor: '#e17055',
      success: async (res) => {
        if (!res.confirm) return
        try {
          wx.showLoading({ title: '撤销中...' })
          const { result } = await wx.cloud.callFunction({
            name: 'wdd-report',
            data: { action: 'cancelReport', reportId: id }
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
          console.error('撤销举报失败:', err)
          wx.showToast({ title: '撤销失败', icon: 'none' })
        }
      }
    })
  },

  goDetail(e) {
    const { id } = e.currentTarget.dataset
    wx.navigateTo({
      url: '/pages/report-detail/report-detail?reportId=' + id
    })
  }
})
