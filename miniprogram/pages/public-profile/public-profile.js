Page({
  data: {
    userId: '',
    userInfo: null,
    ratings: [],
    loading: true
  },

  onLoad(options) {
    const { userId } = options
    this.setData({ userId })
    this.loadProfile()
  },

  async loadProfile() {
    const { userId } = this.data
    wx.showLoading({ title: '加载中...' })

    try {
      // 获取用户信息
      const userRes = await wx.cloud.database().collection('wdd-users').doc(userId).get()
      const user = userRes.data

      if (!user) {
        wx.showToast({ title: '用户不存在', icon: 'none' })
        this.setData({ loading: false })
        return
      }

      // 查询最近三条五星好评
      const ratingRes = await wx.cloud.database().collection('wdd-ratings')
        .where({
          target_id: userId,
          rating: 5
        })
        .orderBy('create_time', 'desc')
        .limit(3)
        .get()

      const rating = user.rating || 5.0
      const fullStars = Math.floor(rating)
      const starsStr = '★★★★★'.slice(0, fullStars)

      this.setData({
        userInfo: {
          avatar: user.avatar || '',
          nickname: user.nickname || '未知用户',
          rating: rating,
          ratingFormatted: rating.toFixed(1),
          ratingStars: starsStr,
          ratingCount: user.rating_count || 0,
          helpTypes: user.help_types || [],
          frequentLocations: user.frequent_locations || []
        },
        ratings: ratingRes.data || [],
        loading: false
      })
    } catch (err) {
      wx.showToast({ title: '加载失败', icon: 'none' })
      this.setData({ loading: false })
    }

    wx.hideLoading()
  }
})
