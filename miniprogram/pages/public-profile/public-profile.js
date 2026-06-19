const { getByType, resolveTaskType } = require('../../utils/needTypes')

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
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-get-needs',
        data: {
          action: 'getPublicProfile',
          userId
        }
      })
      const user = result && result.data ? result.data.user : null

      if (!user) {
        wx.showToast({ title: '用户不存在', icon: 'none' })
        this.setData({ loading: false })
        return
      }

      // 查询最近三条好评
      const publicRatings = result && result.data ? (result.data.ratings || []) : []
      const ratings = publicRatings.map(item => {
        const typeInfo = getByType(resolveTaskType(item))
        return {
          ...item,
          typeName: typeInfo.name,
          typeIcon: typeInfo.icon,
          typeColor: typeInfo.color,
          typeBgColor: typeInfo.bgColor
        }
      })

      const rating = user.rating || 5.0
      const helpTypes = (user.help_types || []).map(id => getByType(id))

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
          ratingRounded: Math.floor(rating),
          ratingCount: user.rating_count || 0,
          helpTypes: helpTypes,
          frequentLocations: frequentLocations
        },
        ratings,
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
