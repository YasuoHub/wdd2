// 首页逻辑 - 城市绿洲风格
const app = getApp()

Page({
  data: {
    isLoggedIn: false,
    userInfo: null,
    hasSignedToday: false,
    unreadCount: 0,
    nearbyNeeds: [],
    nearbyLoading: false,
    nearbyEmpty: false,
    nearbyError: false
  },

  onLoad() {
    this.checkLoginStatus()
    this.checkSignInStatus()
  },

  onShow() {
    if (this.data.isLoggedIn) {
      this.loadNearbyNeeds()
      this.checkSignInStatus()
    }
  },

  // 检查登录状态
  checkLoginStatus() {
    const isLoggedIn = app.globalData.isLoggedIn
    const userInfo = app.globalData.userInfo

    this.setData({
      isLoggedIn,
      userInfo
    })

    if (isLoggedIn) {
      this.loadNearbyNeeds()
    }
  },

  // 检查今日签到状态
  checkSignInStatus() {
    if (!this.data.isLoggedIn) return

    const lastSignDate = wx.getStorageSync('lastSignDate')
    const today = new Date().toDateString()

    this.setData({
      hasSignedToday: lastSignDate === today
    })
  },

  // 处理登录
  handleLogin() {
    const that = this
    wx.getUserProfile({
      desc: '用于完善用户资料'
    }).then(({ userInfo }) => {
      wx.showLoading({ title: '登录中...' })
      return app.login(userInfo)
    }).then(result => {
      wx.hideLoading()
      if (result.success) {
        that.setData({
          isLoggedIn: true,
          userInfo: result.data.userInfo,
          hasSignedToday: false
        })
        that.loadNearbyNeeds()
        wx.showToast({
          title: '欢迎新用户 🎉',
          icon: 'none',
          duration: 2000
        })
      }
    }).catch(err => {
      wx.hideLoading()
      console.error('登录失败:', err)
      wx.showToast({
        title: '登录取消',
        icon: 'none'
      })
    })
  },

  // 处理签到
  async handleSignIn() {
    if (this.data.hasSignedToday) {
      wx.showToast({
        title: '今天已经签到过了',
        icon: 'none'
      })
      return
    }

    try {
      wx.showLoading({ title: '签到中...' })

      const { result } = await wx.cloud.callFunction({
        name: 'wdd-sign-in',
        data: {}
      })

      wx.hideLoading()

      if (result.code === 0) {
        const { points, consecutiveDays } = result.data

        // 更新本地数据
        const userInfo = this.data.userInfo
        userInfo.total_points += points
        userInfo.available_points += points
        userInfo.consecutive_sign_days = consecutiveDays

        this.setData({
          userInfo,
          hasSignedToday: true
        })

        // 保存签到日期
        wx.setStorageSync('lastSignDate', new Date().toDateString())

        // 更新全局数据
        app.updateUserInfo(userInfo)

        wx.showToast({
          title: `签到成功 +${points}积分`,
          icon: 'none',
          duration: 2000
        })
      } else {
        throw new Error(result.message)
      }
    } catch (err) {
      wx.hideLoading()
      wx.showToast({
        title: err.message || '签到失败',
        icon: 'none'
      })
    }
  },

  // 加载附近任务
  async loadNearbyNeeds() {
    if (this.data.nearbyLoading) return

    this.setData({
      nearbyLoading: true,
      nearbyError: false
    })

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-get-needs',
        data: {
          filter: 'all',
          sort: 'time',
          limit: 5
        }
      })

      if (result.code === 0) {
        const list = (result.data.list || []).map(item => {
          const distanceText = item.distance < 1000 ? item.distance + 'm' : Math.round(item.distance / 100) / 10 + 'km'
          return {
            _id: item._id,
            need_id: item.need_id || item._id,
            type: item.type,
            typeName: item.typeName || item.type_name,
            typeIcon: item.typeIcon,
            bgColor: item.bgColor,
            color: item.color,
            description: item.description,
            location: item.location,
            locationName: item.locationName || (item.location && item.location.name) || '未知位置',
            points: item.points,
            status: item.status,
            distance: item.distance,
            distanceText: distanceText,
            remainTime: item.remainTime,
            userNickname: item.userNickname || item.user_nickname,
            seekerNickname: item.seekerNickname,
            seekerAvatar: item.seekerAvatar,
            takerNickname: item.takerNickname,
            expireTime: item.expireTime,
            createTime: item.createTime,
            hasRated: item.hasRated,
            is_urgent: item.is_urgent || false
          }
        })
        this.setData({
          nearbyNeeds: list,
          nearbyEmpty: list.length === 0,
          nearbyLoading: false
        })
      } else {
        throw new Error(result.message)
      }
    } catch (err) {
      console.error('加载附近任务失败:', err)
      this.setData({
        nearbyLoading: false,
        nearbyError: true
      })
    }
  },

  // 重新加载附近任务（失败时重试）
  reloadNearbyNeeds() {
    this.loadNearbyNeeds()
  },

  // 跳转到发布页
  goToPublish() {
    if (!this.data.isLoggedIn) {
      wx.showToast({
        title: '请先登录',
        icon: 'none'
      })
      return
    }

    wx.navigateTo({
      url: '/pages/publish/publish'
    })
  },

  // 跳转到签到（在"我的"页面）
  goToSignIn() {
    wx.switchTab({
      url: '/pages/my/my'
    })
  },

  // 跳转到任务大厅
  goToTaskHall() {
    wx.switchTab({
      url: '/pages/task-hall/task-hall'
    })
  },

  // 跳转到消息中心
  goToMessages() {
    wx.switchTab({
      url: '/pages/messages/messages'
    })
  },

  // 跳转到任务详情
  goToNeedDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({
      url: `/pages/task-detail/task-detail?id=${id}`
    })
  }
})
