// 评价详情页面 - 查看已提交的评价
const app = getApp()

Page({
  data: {
    needId: '',
    ratingType: 'seeker',
    loading: true,
    rating: null,
    task: null,
    targetUser: null
  },

  onLoad(options) {
    const { needId, type } = options
    this.setData({
      needId: needId || '',
      ratingType: type || 'seeker'
    })

    if (!needId) {
      wx.showToast({
        title: '参数错误',
        icon: 'none'
      })
      return
    }

    this.loadRatingDetail()
  },

  // 加载评价详情
  async loadRatingDetail() {
    this.setData({ loading: true })

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-get-needs',
        data: {
          action: 'getRatingDetail',
          needId: this.data.needId,
          ratingType: this.data.ratingType
        }
      })

      if (result.code === 0 && result.data) {
        this.setData({
          rating: result.data.rating,
          task: result.data.task,
          targetUser: result.data.targetUser,
          loading: false
        })
      } else {
        throw new Error(result.message || '获取评价详情失败')
      }
    } catch (err) {
      console.error('加载评价详情失败:', err)
      this.setData({ loading: false })

      wx.showToast({
        title: err.message || '加载失败',
        icon: 'none'
      })

      // 延迟返回
      setTimeout(() => {
        wx.navigateBack()
      }, 1500)
    }
  }
})
