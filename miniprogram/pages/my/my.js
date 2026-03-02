// 个人中心页面逻辑
const app = getApp()

Page({
  data: {
    userInfo: {},
    hasSignedToday: false,
    signPoints: 5,
    myNeedsCount: 0,
    myTasksCount: 0,
    showInviteModal: false
  },

  onLoad() {
    this.loadUserInfo()
  },

  onShow() {
    this.loadUserInfo()
    this.checkSignInStatus()
    this.loadTaskCounts()
  },

  // 加载用户信息
  loadUserInfo() {
    const userInfo = app.globalData.userInfo || wx.getStorageSync('userInfo')
    if (userInfo) {
      this.setData({
        userInfo: userInfo
      })
    }
  },

  // 检查签到状态
  checkSignInStatus() {
    const lastSignDate = wx.getStorageSync('lastSignDate')
    const today = new Date().toDateString()

    this.setData({
      hasSignedToday: lastSignDate === today
    })
  },

  // 加载任务数量
  async loadTaskCounts() {
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

  // 跳转到我的求助
  goToMyNeeds() {
    wx.navigateTo({
      url: '/pages/my-needs/my-needs'
    })
  },

  // 跳转到我的接单
  goToMyTasks() {
    wx.navigateTo({
      url: '/pages/my-tasks/my-tasks'
    })
  },

  // 跳转到积分明细
  goToPointRecords() {
    wx.showToast({
      title: '功能开发中',
      icon: 'none'
    })
  },

  // 显示邀请弹窗
  showInviteModal() {
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
      title: `🙏 ${userInfo.nickname || '有人'}邀请你加入问当地，新用户送100积分！`,
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
      content: '1. 新用户注册：+100积分\n2. 每日签到：+5~30积分（连续签到递增）\n3. 发布求助：冻结相应积分\n4. 完成求助：支付积分给帮助者\n5. 帮助他人：获得对方悬赏积分\n6. 邀请好友：双方各+50积分\n\n积分当年有效，次年1月1日清零。',
      showCancel: false
    })
  }
})
