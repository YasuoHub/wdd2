const { REPORT_TYPE_MAP, APPEAL_TYPE_MAP } = require('../../config/types')
const DateUtil = require('../../utils/dateUtil')

Page({
  data: {
    ticketId: '',
    ticket: null,
    task: null,
    seeker: null,
    taker: null,
    reportDetail: null,
    appealDetail: null,
    loading: false,
    // 裁决弹窗
    showArbitrateModal: false,
    taskResult: '',
    partialPercent: 50,
    banTarget: 'none',
    banDuration: '1d',
    isSubmitting: false
  },

  onLoad(options) {
    const { ticketId } = options
    this.setData({ ticketId })
    this.loadDetail()
  },

  async loadDetail() {
    const { ticketId } = this.data
    this.setData({ loading: true })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-ticket',
        data: { action: 'getTicketDetail', ticketId }
      })
      if (result.code === 0) {
        const data = result.data

        // 转换举报类型为中文
        if (data.reportDetail && data.reportDetail.type) {
          data.reportDetail.type = REPORT_TYPE_MAP[data.reportDetail.type] || data.reportDetail.type
        }

        // 转换申诉类型为中文
        if (data.appealDetail) {
          if (data.appealDetail.initiator && data.appealDetail.initiator.type) {
            data.appealDetail.initiator.type = APPEAL_TYPE_MAP[data.appealDetail.initiator.type] || data.appealDetail.initiator.type
          }
          if (data.appealDetail.supplement && data.appealDetail.supplement.type) {
            data.appealDetail.supplement.type = APPEAL_TYPE_MAP[data.appealDetail.supplement.type] || data.appealDetail.supplement.type
          }
        }

        // 格式化任务时间
        const task = data.task ? {
          ...data.task,
          createTimeFormatted: DateUtil.formatDateTime(data.task.createTime),
          takeTimeFormatted: DateUtil.formatDateTime(data.task.takeTime)
        } : null

        this.setData({
          ticket: data.ticket,
          task,
          seeker: data.seeker,
          taker: data.taker,
          reportDetail: data.reportDetail,
          appealDetail: data.appealDetail,
          loading: false
        })
      }
    } catch (err) {
      wx.showToast({ title: '加载失败', icon: 'none' })
      this.setData({ loading: false })
    }
  },

  // 显示裁决弹窗
  showArbitrate() {
    this.setData({
      showArbitrateModal: true,
      taskResult: '',
      partialPercent: 50,
      banTarget: 'none',
      banDuration: '1d'
    })
  },

  // 隐藏裁决弹窗
  hideArbitrate() {
    this.setData({ showArbitrateModal: false })
  },

  // 选择任务结果
  onTaskResultChange(e) {
    const results = ['cancelled', 'completed', 'partial']
    this.setData({ taskResult: results[e.detail.value] })
  },

  // 选择分账比例
  onPartialChange(e) {
    const percents = [10, 30, 50, 70]
    this.setData({ partialPercent: percents[e.detail.value] })
  },

  // 选择封禁对象
  onBanTargetChange(e) {
    const targets = ['none', 'seeker', 'taker', 'both']
    this.setData({ banTarget: targets[e.detail.value] })
  },

  // 选择封禁时长
  onBanDurationChange(e) {
    const durations = ['1d', '1w', '1m', '1y', 'permanent']
    this.setData({ banDuration: durations[e.detail.value] })
  },

  // 提交裁决
  async submitArbitrate() {
    const { ticketId, taskResult, partialPercent, banTarget, banDuration, task } = this.data

    if (!taskResult) {
      wx.showToast({ title: '请选择裁决结果', icon: 'none' })
      return
    }

    // 悬赏<=5元时不可选部分完成
    if (taskResult === 'partial' && task && task.rewardAmount <= 5) {
      wx.showToast({ title: '悬赏≤5元不可部分完成', icon: 'none' })
      return
    }

    this.setData({ isSubmitting: true })
    wx.showLoading({ title: '提交中...' })

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-ticket',
        data: {
          action: 'submitArbitration',
          ticketId,
          taskResult,
          partialPercent: taskResult === 'partial' ? partialPercent : null,
          banInfo: banTarget !== 'none' ? { target: banTarget, duration: banDuration } : null
        }
      })

      wx.hideLoading()
      this.setData({ isSubmitting: false, showArbitrateModal: false })

      if (result.code === 0) {
        wx.showToast({ title: '裁决已提交', icon: 'success' })
        setTimeout(() => { wx.navigateBack() }, 1500)
      } else {
        wx.showToast({ title: result.message || '提交失败', icon: 'none' })
      }
    } catch (err) {
      wx.hideLoading()
      this.setData({ isSubmitting: false })
      wx.showToast({ title: err.message || '提交失败', icon: 'none' })
    }
  },

  // 预览图片
  previewImage(e) {
    const { url } = e.currentTarget.dataset
    const urls = e.currentTarget.dataset.urls || [url]
    wx.previewImage({ current: url, urls })
  },

  // 跳转到聊天页面
  goToChat() {
    const { task } = this.data
    if (!task || !task._id) {
      wx.showToast({ title: '任务信息缺失', icon: 'none' })
      return
    }
    wx.navigateTo({
      url: `/pages/chat/chat?needId=${task._id}`
    })
  }
})
