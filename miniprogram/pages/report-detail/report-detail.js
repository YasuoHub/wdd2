const DateUtil = require('../../utils/dateUtil')
const { getByType, resolveTaskType } = require('../../utils/needTypes')

const REPORT_COPY = {
  infoTitle: '举报信息',
  typeLabel: '举报类型',
  reasonLabel: '举报理由',
  descriptionLabel: '举报描述',
  evidenceLabel: '提交证据',
  taskTitle: '关联任务',
  targetTitle: '被举报对象',
  targetFallback: '被举报用户',
  noticeTitle: '温馨提示',
  noticeText: '平台已受理此举报，客服将依据证据与规则进行核实处理，处理结果将通过消息通知。'
}

const STATUS_LABELS = {
  pending: '处理中',
  cancelled: '已撤销',
  resolved: '已处理'
}

Page({
  data: {
    detail: null,
    loading: true,
    copy: REPORT_COPY
  },

  onLoad(options) {
    const { reportId } = options
    if (!reportId) {
      wx.showToast({ title: '参数错误', icon: 'none' })
      return
    }
    this.loadDetail(reportId)
  },

  async loadDetail(reportId) {
    try {
      wx.showLoading({ title: '加载中...' })
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-report',
        data: { action: 'getReportDetailById', reportId }
      })
      wx.hideLoading()

      if (result.code !== 0) {
        wx.showToast({ title: result.message || '加载失败', icon: 'none' })
        return
      }

      const d = result.data
      this.setData({
        detail: this.formatDetail(d),
        loading: false
      })
    } catch (err) {
      wx.hideLoading()
      console.error('加载举报详情失败:', err)
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  formatDetail(d) {
    const images = Array.isArray(d.images) ? d.images.filter(Boolean) : []
    const status = d.status || 'pending'
    const taskInfo = this.formatTaskInfo(d.taskInfo || {})
    return {
      ...d,
      images,
      evidenceImages: images.slice(0, 3),
      evidenceCountText: `共${images.length}张`,
      hasEvidence: images.length > 0,
      typeLabel: taskInfo.typeName,
      reasonText: d.reportTypeLabel || d.reportType || '其他',
      descriptionText: d.reason || '—',
      statusClass: status,
      statusLabel: STATUS_LABELS[status] || '处理中',
      taskInfo,
      targetUser: this.formatTargetUser(d.targetUser || {}),
      createTimeText: this.formatTimelineTime(d.createTime),
      updateTimeText: this.formatTimelineTime(d.updateTime),
      updateStatusText: status === 'pending' ? '客服处理中' : '',
      cancelTimeText: d.cancelTime ? this.formatTimelineTime(d.cancelTime) : '—',
      resolveTimeText: d.resolveTime ? this.formatTimelineTime(d.resolveTime) : '—'
    }
  },

  formatTaskInfo(taskInfo = {}) {
    taskInfo = taskInfo || {}
    const taskType = resolveTaskType(taskInfo)
    const typeMeta = getByType(taskType)
    return {
      ...taskInfo,
      type: taskType,
      typeName: typeMeta.name,
      typeIcon: typeMeta.icon,
      typeColor: typeMeta.color,
      typeBgColor: typeMeta.bgColor,
      title: taskInfo.title || taskInfo.description || '关联任务',
      locationName: taskInfo.locationName || taskInfo.location_name || '位置未填写',
      rewardAmount: taskInfo.rewardAmount || taskInfo.reward_amount || 0
    }
  },

  formatTargetUser(targetUser = {}) {
    targetUser = targetUser || {}
    return {
      ...targetUser,
      id: targetUser.id || '',
      nickname: targetUser.nickname || REPORT_COPY.targetFallback,
      avatar: targetUser.avatar || '/images/default-avatar.png',
      roleLabel: targetUser.roleLabel || '任务相关用户',
      creditScore: targetUser.creditScore || 100
    }
  },

  formatTimelineTime(dateStr) {
    if (!dateStr) return '—'
    const date = new Date(dateStr)
    const time = DateUtil.formatTime(date)
    const now = new Date()

    if (DateUtil.isSameDay(now, date)) {
      return `今天 ${time}`
    }
    if (DateUtil.isYesterday(now, date)) {
      return `昨天 ${time}`
    }
    if (now.getFullYear() === date.getFullYear()) {
      return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`
    }
    return DateUtil.formatDateTime(date)
  },

  previewImage(e) {
    const { url } = e.currentTarget.dataset
    const { detail } = this.data
    const urls = detail.images || []
    wx.previewImage({ current: url, urls })
  },

  goToTask() {
    const needId = this.data.detail && this.data.detail.needId
    if (!needId) return
    wx.navigateTo({
      url: '/pages/task-detail/task-detail?id=' + needId
    })
  },

  goToTarget() {
    const targetUser = this.data.detail && this.data.detail.targetUser
    if (!targetUser || !targetUser.id) return
    wx.navigateTo({
      url: '/pages/public-profile/public-profile?userId=' + targetUser.id
    })
  }
})
