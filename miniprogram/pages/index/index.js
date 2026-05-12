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
    quickTypes: NEED_TYPES,
    // 刷新控制
    lastRefreshTime: 0,      // 上次刷新时间戳
    refreshInterval: 30000,  // 最小刷新间隔 30秒
    currentRequestId: null   // 当前请求ID，用于取消旧请求
  },

  onLoad(options) {
    // 保存邀请人ID（如果有）
    if (options.inviter) {
      wx.setStorageSync('pendingInviterId', options.inviter)
      console.log('收到邀请人ID:', options.inviter)
    }

    this.checkLoginStatus()
    this.checkSignInStatus()

    // 确保位置获取后再加载任务
    this.loadNearbyNeedsWithLocation()
  },

  // 带位置获取的任务加载
  async loadNearbyNeedsWithLocation() {
    // 如果已登录，先等待位置获取
    if (app.globalData.isLoggedIn) {
      let userLocation = app.getUserLocation()

      // 如果没有位置，尝试获取
      if (!userLocation) {
        try {
          await app.updateUserLocation()
        } catch (err) {
          // 位置获取失败，继续加载任务
        }
      }

      // 加载任务
      this.loadNearbyNeeds()
    }
  },

  onShow() {
    // 重新检查登录状态（处理退出登录后返回的情况）
    // 先让 app 同步 globalData 和本地存储
    app.checkLoginStatus()
    this.checkLoginStatus()

    if (this.data.isLoggedIn) {
      // 检查是否需要强制刷新（从发布页返回等情况）
      const forceRefresh = wx.getStorageSync('forceRefreshIndex')
      if (forceRefresh) {
        wx.removeStorageSync('forceRefreshIndex')
        this.refreshLocationAndLoad()
        this.checkSignInStatus()
        app.updateTabBarBadge()
        return
      }

      // 判断是否需要刷新（超过刷新间隔）
      const now = Date.now()
      const shouldRefresh = now - this.data.lastRefreshTime > this.data.refreshInterval

      if (shouldRefresh) {
        // 刷新位置并重新加载任务
        this.refreshLocationAndLoad()
      }
      this.checkSignInStatus()
      // 更新消息角标
      app.updateTabBarBadge()
    }
  },

  // 刷新位置并加载任务
  async refreshLocationAndLoad() {
    // 尝试获取最新位置
    let userLocation = app.getUserLocation()
    if (!userLocation) {
      try {
        await app.updateUserLocation()
      } catch (err) {
        // 位置获取失败，继续加载任务（会显示"--"）
      }
    }

    // 重新加载任务
    this.loadNearbyNeeds()
  },

  // 检查登录状态
  checkLoginStatus() {
    const isLoggedIn = app.globalData.isLoggedIn
    const userInfo = app.globalData.userInfo

    this.setData({
      isLoggedIn,
      userInfo
    })

    // 注意：不在此处加载任务，统一在 onShow 中处理，避免重复加载
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
      const userInfo = result.data.userInfo

      this.setData({
        isLoggedIn: true,
        userInfo: userInfo,
        hasSignedToday: false
      })
      this.loadNearbyNeeds()

      // 判断是否是被邀请注册
      const isInvited = userInfo.inviter_id != null
      const toastTitle = result.data.isNewUser
        ? (isInvited ? '注册成功，获得150积分 🎉' : '欢迎新用户，已送100积分')
        : '登录成功'

      wx.showToast({
        title: toastTitle,
        icon: 'none',
        duration: 2000
      })

      // 检查是否需要完善帮助者资料
      // 新用户或没有帮助者资料的用户，强制跳转
      if (result.data.isNewUser || !userInfo.hasHelperProfile) {
        setTimeout(() => {
          wx.navigateTo({
            url: '/pages/helper-profile/helper-profile?fromLogin=true'
          })
        }, 1500)
      }
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
    // 生成当前请求ID
    const requestId = Date.now()
    this.setData({ currentRequestId: requestId })

    // 未登录时不加载
    if (!this.data.isLoggedIn) {
      this.setData({
        nearbyNeeds: [],
        nearbyEmpty: true,
        nearbyLoading: false
      })
      return
    }

    this.setData({
      nearbyLoading: true,
      nearbyError: false
    })

    try {
      // 先尝试获取用户位置
      let userLocation = app.getUserLocation()

      // 如果全局没有位置，尝试更新位置
      if (!userLocation) {
        try {
          await app.updateUserLocation()
          userLocation = app.getUserLocation()
        } catch (err) {
          // 如果用户拒绝了权限，显示提示
          if (err.errMsg && err.errMsg.includes('auth')) {
            wx.showModal({
              title: '需要位置权限',
              content: '需要您的位置信息来计算任务距离，是否去设置？',
              confirmText: '去设置',
              success: (res) => {
                if (res.confirm) {
                  wx.openSetting()
                }
              }
            })
          }
        }
      }

      // 准备请求参数
      const requestData = {
        filter: 'all',
        sort: 'time',
        limit: 5,
        distance: 5000 // 只显示5公里内的任务
      }

      // 将用户当前位置传递给云函数
      if (userLocation) {
        requestData.latitude = userLocation.latitude
        requestData.longitude = userLocation.longitude
      }

      const { result } = await wx.cloud.callFunction({
        name: 'wdd-get-needs',
        data: requestData
      })

      if (result.code === 0) {
        const list = (result.data.list || []).map(item => {
          // 只有有效距离（小于 999km）才显示距离文本
          let distanceText = ''
          if (item.distance && item.distance < 999000) {
            distanceText = item.distance < 1000 ? item.distance + 'm' : Math.round(item.distance / 100) / 10 + 'km'
          } else if (item.distance >= 999000) {
            distanceText = '--'
          }
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
            locationName: item.locationName || '未知位置',
            points: item.points,
            rewardAmount: item.rewardAmount || 0,
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
        // 检查是否是最新请求的结果
        if (this.data.currentRequestId !== requestId) {
          console.log('请求已过期，忽略结果')
          return
        }

        this.setData({
          nearbyNeeds: list,
          nearbyEmpty: list.length === 0,
          nearbyLoading: false,
          lastRefreshTime: Date.now()  // 更新上次刷新时间
        })
      } else {
        throw new Error(result.message)
      }
    } catch (err) {
      console.error('加载附近任务失败:', err)
      // 检查是否是最新请求的错误
      if (this.data.currentRequestId !== requestId) {
        console.log('请求已过期，忽略错误')
        return
      }
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

  // 跳转到任务详情
  goToNeedDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({
      url: `/pages/task-detail/task-detail?id=${id}`
    })
  }
})
