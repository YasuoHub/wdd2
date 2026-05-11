// 个人中心页面逻辑
const app = getApp()

Page({
  data: {
    userInfo: {},
    isLoggedIn: false,
    hasSignedToday: false,
    signPoints: 5,
    myNeedsCount: 0,
    myTasksCount: 0,
    showInviteModal: false,
    isCustomerService: false
  },

  onLoad() {
    this.loadUserInfo()
  },

  onShow() {
    // 先让 app 同步 globalData 和本地存储
    app.checkLoginStatus()

    // 更新登录状态
    const isLoggedIn = app.globalData.isLoggedIn
    this.setData({ isLoggedIn })

    // 检查是否已登录
    if (!isLoggedIn) {
      // 未登录时清空数据
      this.setData({
        userInfo: {},
        hasSignedToday: false,
        myNeedsCount: 0,
        myTasksCount: 0
      })
      // 清除消息角标
      wx.removeTabBarBadge({ index: 2 })
      return
    }

    this.loadUserInfo()
    this.checkSignInStatus()
    this.loadTaskCounts()
    // 更新消息角标
    app.updateTabBarBadge()
  },

  // 加载用户信息
  async loadUserInfo() {
    // 先从本地获取显示
    const localUserInfo = app.globalData.userInfo || wx.getStorageSync('userInfo')
    const isLoggedIn = !!(localUserInfo && localUserInfo._id)

    // 更新登录状态
    this.setData({ isLoggedIn })

    if (!isLoggedIn) {
      // 未登录状态，清空用户信息显示，并清空任务数
      this.setData({
        userInfo: {},
        myNeedsCount: 0,
        myTasksCount: 0
      })
      return
    }

    // 处理ID显示，只展示最后10位
    if (localUserInfo._id && localUserInfo._id.length > 10) {
      localUserInfo.displayId = localUserInfo._id.slice(-10)
    } else {
      localUserInfo.displayId = localUserInfo._id || '未知'
    }
    this.setData({
      userInfo: localUserInfo
    })

    // 然后从服务器获取最新数据（刷新积分等）
    // 注意：这里依赖本地存储的登录状态，如果用户已退出，不会调用
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-notify',
        data: {
          action: 'getUserInfo'
        }
      })

      if (result.code === 0 && result.data.userInfo) {
        const freshUserInfo = result.data.userInfo
        // 处理ID显示，只展示最后10位
        if (freshUserInfo._id && freshUserInfo._id.length > 10) {
          freshUserInfo.displayId = freshUserInfo._id.slice(-10)
        } else {
          freshUserInfo.displayId = freshUserInfo._id || '未知'
        }
        this.setData({
          userInfo: freshUserInfo
        })
        // 更新全局数据
        app.updateUserInfo(freshUserInfo)

        // 检查是否为客服
        this.checkCustomerService()
      }
    } catch (err) {
      console.error('获取最新用户信息失败:', err)
      // 使用本地数据，不报错
    }
  },

  // 检查签到状态
  async checkSignInStatus() {
    // 先从服务器获取真实的签到状态
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-sign-in',
        data: { action: 'check' }
      })
      if (result.code === 0) {
        this.setData({
          hasSignedToday: result.data.hasSignedToday,
          signPoints: result.data.todayPoints || 5
        })
        // 同步本地存储
        if (result.data.hasSignedToday) {
          wx.setStorageSync('lastSignDate', new Date().toDateString())
        }
        return
      }
    } catch (err) {
      console.error('获取签到状态失败:', err)
    }

    // 降级到本地检查
    const lastSignDate = wx.getStorageSync('lastSignDate')
    const today = new Date().toDateString()
    const hasSignedToday = lastSignDate === today
    this.setData({
      hasSignedToday: hasSignedToday,
      signPoints: hasSignedToday ? this.data.signPoints : 5
    })
  },

  // 加载任务数量
  async loadTaskCounts() {
    // 检查是否已登录
    const isLoggedIn = app.globalData.isLoggedIn
    if (!isLoggedIn) {
      this.setData({
        myNeedsCount: 0,
        myTasksCount: 0
      })
      return
    }

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-notify',
        data: {
          action: 'getTaskCounts'
        }
      })

      if (result.code === 0) {
        this.setData({
          myNeedsCount: result.data.myNeedsCount || 0,
          myTasksCount: result.data.myTasksCount || 0
        })
      }
    } catch (err) {
      console.error('加载任务数量失败:', err)
      // 使用模拟数据
      this.setData({
        myNeedsCount: 0,
        myTasksCount: 0
      })
    }
  },

  // 处理签到
  async handleSignIn() {
    // 检查登录
    if (!this.checkLoginAndShowTip()) return

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

        // 更新本地数据 - 创建新对象确保数据更新
        const userInfo = {
          ...this.data.userInfo,
          total_points: this.data.userInfo.total_points + points,
          available_points: this.data.userInfo.available_points + points,
          consecutive_sign_days: consecutiveDays
        }

        this.setData({
          userInfo,
          hasSignedToday: true,
          signPoints: points
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

  // 检查登录状态，未登录提示
  checkLoginAndShowTip() {
    if (!this.data.isLoggedIn) {
      wx.showToast({
        title: '请先登录',
        icon: 'none'
      })
      return false
    }
    return true
  },

  // 处理登录（一键登录）
  handleLogin() {
    // 跳转到用户信息填写页面获取头像昵称
    wx.navigateTo({
      url: '/pages/user-info/user-info'
    })
  },

  // 跳转到我的求助
  goToMyNeeds() {
    if (!this.checkLoginAndShowTip()) return
    wx.navigateTo({
      url: '/pages/my-needs/my-needs'
    })
  },

  // 跳转到我的接单
  goToMyTasks() {
    if (!this.checkLoginAndShowTip()) return
    wx.navigateTo({
      url: '/pages/my-tasks/my-tasks'
    })
  },

  // 跳转到积分明细
  goToPointRecords() {
    if (!this.checkLoginAndShowTip()) return
    wx.navigateTo({
      url: '/pages/point-records/point-records'
    })
  },

  // 跳转到钱包
  goToWallet() {
    if (!this.checkLoginAndShowTip()) return
    wx.navigateTo({
      url: '/pages/wallet/wallet'
    })
  },

  // 跳转到帮助者资料页面
  goToHelperProfile() {
    if (!this.checkLoginAndShowTip()) return
    wx.navigateTo({
      url: '/pages/helper-profile/helper-profile?edit=true'
    })
  },

  // 检查是否为客服
  async checkCustomerService() {
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-config',
        data: { action: 'isCustomerService' }
      })
      if (result.code === 0) {
        this.setData({ isCustomerService: result.data.isCustomerService })
      }
    } catch (err) {
      console.error('检查客服身份失败:', err)
    }
  },

  // 跳转客服工单列表
  goToTicketList() {
    wx.navigateTo({
      url: '/pages/ticket-list/ticket-list'
    })
  },

  // 显示邀请弹窗
  showInviteModal() {
    if (!this.checkLoginAndShowTip()) return
    this.setData({ showInviteModal: true })
  },

  // 隐藏邀请弹窗
  hideInviteModal() {
    this.setData({ showInviteModal: false })
  },

  // 分享功能
  onShareAppMessage() {
    const userInfo = this.data.userInfo
    return {
      title: `🙏 ${userInfo.nickname || '有人'}邀请你加入问当地，双方各得50积分！`,
      path: `/pages/index/index?inviter=${userInfo._id}`,
      imageUrl: '/images/share-cover.png'
    }
  },

  // 显示关于我们
  showAbout() {
    wx.showModal({
      title: '关于问当地',
      content: '问当地是一款基于地理位置的即时互帮互助小程序。\n\n无论你是想了解异地的实时天气、路况，还是确认某家店是否营业，都可以找当地的用户帮你确认。\n\n成都起步，互帮互助。',
      showCancel: false
    })
  },

  // 显示积分规则
  showRules() {
    wx.showModal({
      title: '积分规则',
      content: '【获取方式】\n1. 新用户注册：+100积分\n2. 每日签到：+5~30积分（连续签到递增）\n3. 邀请好友：双方各+50积分\n\n【积分用途】\n积分可兑换平台内免单券、提现免手续费券等权益（功能开发中，敬请期待）。\n\n【重要说明】\n积分仅用于平台内权益兑换，不可提现、不可转让、无现金价值。\n平台保留调整积分发放规则、有效期、可兑换权益种类与比例的权利。',
      showCancel: false
    })
  },

  // 退出登录
  handleLogout() {
    wx.showModal({
      title: '确认退出',
      content: '退出后需要重新登录',
      confirmColor: '#ff4d4f',
      success: (res) => {
        if (res.confirm) {
          this.performLogout()
        }
      }
    })
  },

  // 执行退出登录
  performLogout() {
    try {
      // 调用 app 的退出登录方法
      app.logout()

      // 5. 重置页面数据
      this.setData({
        userInfo: {},
        hasSignedToday: false,
        myNeedsCount: 0,
        myTasksCount: 0
      })

      wx.showToast({
        title: '已退出登录',
        icon: 'success',
        duration: 1500
      })

      // 6. 延迟切换到首页，让 toast 显示
      setTimeout(() => {
        wx.switchTab({
          url: '/pages/index/index',
          success: () => {
            console.log('已切换到首页')
          },
          fail: (err) => {
            console.error('切换首页失败:', err)
            // 如果 switchTab 失败，尝试 redirectTo
            wx.reLaunch({
              url: '/pages/index/index'
            })
          }
        })
      }, 1500)
    } catch (err) {
      console.error('退出登录失败:', err)
      wx.showToast({
        title: '退出失败，请重试',
        icon: 'none'
      })
    }
  }
})
