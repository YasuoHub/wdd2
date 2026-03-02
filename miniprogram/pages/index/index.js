// 首页逻辑 - 城市绿洲风格
const app = getApp()

// 求助类型配置
const NEED_TYPES = [
  { type: 'weather', name: '实时天气', icon: '🌤️', color: '#5DB8E6', lightColor: '#7EC8E8' },
  { type: 'traffic', name: '道路拥堵', icon: '🚗', color: '#FFD166', lightColor: '#FFE08C' },
  { type: 'shop', name: '店铺营业', icon: '🏪', color: '#B8B8E8', lightColor: '#D4D4F0' },
  { type: 'parking', name: '停车场', icon: '🅿️', color: '#6DD5B0', lightColor: '#88D8A3' },
  { type: 'queue', name: '排队情况', icon: '👥', color: '#FF8C69', lightColor: '#FF9A8B' },
  { type: 'other', name: '其他', icon: '📝', color: '#A8C4D4', lightColor: '#C4D8E5' }
]

Page({
  data: {
    isLoggedIn: false,
    userInfo: null,
    hasSignedToday: false,
    unreadCount: 0,
    nearbyNeeds: [],
    nearbyLoading: false,
    nearbyEmpty: false,
    nearbyError: false,
    quickTypes: NEED_TYPES
  },

  onLoad(options) {
    // 保存邀请人ID（如果有）
    if (options.inviter) {
      wx.setStorageSync('pendingInviterId', options.inviter)
      console.log('收到邀请人ID:', options.inviter)
    }

    this.checkLoginStatus()
    this.checkSignInStatus()
  },

  onShow() {
    // 重新检查登录状态（处理退出登录后返回的情况）
    this.checkLoginStatus()

    if (this.data.isLoggedIn) {
      this.loadNearbyNeeds()
      this.checkSignInStatus()
      // 更新消息角标
      app.updateTabBarBadge()
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
    // 跳转到用户信息填写页面获取头像昵称
    wx.navigateTo({
      url: '/pages/user-info/user-info'
    })
  },

  // 登录成功回调
  onLoginSuccess(result) {
    if (result.success) {
      this.setData({
        isLoggedIn: true,
        userInfo: result.data.userInfo,
        hasSignedToday: false
      })
      this.loadNearbyNeeds()

      // 判断是否是被邀请注册
      const isInvited = result.data.userInfo.inviter_id != null
      const toastTitle = result.data.isNewUser
        ? (isInvited ? '注册成功，获得150积分 🎉' : '欢迎新用户，已送100积分')
        : '登录成功'

      wx.showToast({
        title: toastTitle,
        icon: 'none',
        duration: 2000
      })
    }
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

  // 跳转到发布页并自动选择类型
  goToPublishWithType(e) {
    if (!this.data.isLoggedIn) {
      wx.showToast({
        title: '请先登录',
        icon: 'none'
      })
      return
    }

    const type = e.currentTarget.dataset.type
    wx.navigateTo({
      url: `/pages/publish/publish?type=${type}`
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
