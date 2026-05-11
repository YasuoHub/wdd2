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

      // help_types 英文 id 映射为中文名称和图标
      const HELP_TYPE_MAP = {
        weather: { name: '实时天气', icon: '🌤️' },
        traffic: { name: '道路拥堵', icon: '🚗' },
        shop: { name: '店铺营业', icon: '🏪' },
        parking: { name: '停车场空位', icon: '🅿️' },
        queue: { name: '排队情况', icon: '👥' },
        other: { name: '其他', icon: '💬' }
      }
      const helpTypes = (user.help_types || []).map(id => HELP_TYPE_MAP[id] || { name: id, icon: '' })

      // frequent_locations 统一为对象格式
      const frequentLocations = (user.frequent_locations || []).map(loc => {
        if (typeof loc === 'string') {
          return { name: loc }
        }
        return loc
      })

      this.setData({
        userInfo: {
          avatar: user.avatar || '',
          nickname: user.nickname || '未知用户',
          rating: rating,
          ratingFormatted: rating.toFixed(1),
          ratingStars: starsStr,
          ratingCount: user.rating_count || 0,
          helpTypes: helpTypes,
          frequentLocations: frequentLocations
        },
        ratings: ratingRes.data || [],
        loading: false
      })
    } catch (err) {
      wx.showToast({ title: '加载失败', icon: 'none' })
      this.setData({ loading: false })
    }

    wx.hideLoading()
  },

  goToLocation(e) {
    const { index } = e.currentTarget.dataset
    const loc = this.data.userInfo.frequentLocations[index]
    if (!loc || !loc.latitude || !loc.longitude) {
      wx.showToast({ title: '位置信息不完整', icon: 'none' })
      return
    }
    wx.openLocation({
      latitude: loc.latitude,
      longitude: loc.longitude,
      name: loc.name || '地点',
      address: loc.name || ''
    })
  }
})
