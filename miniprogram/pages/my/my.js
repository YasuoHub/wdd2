// 个人中心页面逻辑
const app = getApp()
const { callCloudFunction } = require('../../utils/cloud')

const DEFAULT_INVITE_POINTS = 50

function getInvitePointsFromConfig(config) {
  const points = config && config.points ? config.points : {}
  const invitePoints = Number(points.invite)
  return Number.isFinite(invitePoints) ? invitePoints : DEFAULT_INVITE_POINTS
}

Page({
  data: {
    userInfo: {},
    isLoggedIn: false,
    hasSignedToday: false,
    signPoints: 5,
    invitePoints: DEFAULT_INVITE_POINTS,
    myNeedsCount: 0,
    myTasksCount: 0,
    showInviteModal: false,
    isCustomerService: false,
    isSuperAdmin: false,
    showAboutModal: false
  },

  onLoad() {
    this.loadInvitePoints()
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
    this.loadInvitePoints()
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

        this.checkRoleFlags()
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

  // 检查客服/超管身份
  async checkRoleFlags() {
    try {
      const { result } = await callCloudFunction({
        name: 'wdd-get-config',
        data: { action: 'getRoleFlags' },
        dedupe: true,
        dedupeKey: 'wdd-get-config:role-flags'
      })
      if (result.code === 0) {
        this.setData({
          isCustomerService: !!result.data.isCustomerService,
          isSuperAdmin: !!result.data.isSuperAdmin
        })
      }
    } catch (err) {
      console.error('检查角色身份失败:', err)
    }
  },

  async loadInvitePoints() {
    const localConfig = app.globalData.platformConfig
    if (localConfig) {
      this.setData({
        invitePoints: getInvitePointsFromConfig(localConfig)
      })
      return
    }

    if (typeof app.loadPlatformConfig !== 'function') return

    try {
      await app.loadPlatformConfig()
      this.setData({
        invitePoints: getInvitePointsFromConfig(app.globalData.platformConfig)
      })
    } catch (err) {
      console.error('加载邀请积分配置失败:', err)
    }
  },

  // 跳转客服工单列表
  goToTicketList() {
    wx.navigateTo({
      url: '/pages/ticket-list/ticket-list'
    })
  },

  // 跳转运营分析
  goToOpsAnalytics() {
    wx.navigateTo({
      url: '/pages/ops-analytics/ops-analytics'
    })
  },

  // 跳转资金审批
  goToFundApproval() {
    wx.navigateTo({
      url: '/pages/fund-approval/fund-approval'
    })
  },

  // 跳转系统配置
  goToSystemConfig() {
    wx.navigateTo({
      url: '/pages/system-config/system-config'
    })
  },

  // 跳转到我的举报
  goToMyReports() {
    if (!this.checkLoginAndShowTip()) return
    wx.navigateTo({
      url: '/pages/my-reports/my-reports'
    })
  },

  // 跳转到我的申诉
  goToMyAppeals() {
    if (!this.checkLoginAndShowTip()) return
    wx.navigateTo({
      url: '/pages/my-appeals/my-appeals'
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
    const invitePoints = this.data.invitePoints
    return {
      title: `${userInfo.nickname || '有人'}邀请你加入问当地，双方各得${invitePoints}积分！`,
      path: `/pages/index/index?inviter=${userInfo._id}`
    }
  },

  // 显示关于我们
  showAbout() {
    this.setData({ showAboutModal: true })
  },

  hideAboutModal() {
    this.setData({ showAboutModal: false })
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
