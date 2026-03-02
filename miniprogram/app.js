// 小程序入口
App({
  globalData: {
    userInfo: null,
    isLoggedIn: false,
    systemInfo: null,
    // 全局消息监听
    globalMessageWatcher: null,
    // 未读消息数缓存
    unreadCount: 0,
    // 消息中心页面刷新回调
    messagePageRefreshCallback: null
  },

  onLaunch() {
    // 初始化云开发
    wx.cloud.init({
      env: 'wdd-2grpiy1r6f9f4cf2',
      traceUser: true
    })

    // 获取系统信息
    this.getSystemInfo()

    // 检查登录状态
    this.checkLoginStatus()

    // 启动全局消息监听
    this.startGlobalMessageWatch()
  },

  onShow() {
    // 小程序显示时刷新角标
    this.updateTabBarBadge()
  },

  // 获取系统信息
  getSystemInfo() {
    wx.getSystemInfo({
      success: (res) => {
        this.globalData.systemInfo = res
      }
    })
  },

  // 检查登录状态
  checkLoginStatus() {
    const userInfo = wx.getStorageSync('userInfo')
    if (userInfo && userInfo._id) {
      this.globalData.userInfo = userInfo
      this.globalData.isLoggedIn = true
      // 已登录用户启动全局消息监听
      this.startGlobalMessageWatch()
    }
  },

  // 用户登录
  login(userProfile) {
    const that = this
    return new Promise((resolve, reject) => {
      wx.showLoading({ title: '登录中...' })

      // 获取待处理的邀请人ID
      const inviterId = wx.getStorageSync('pendingInviterId')

      wx.cloud.callFunction({
        name: 'wdd-login',
        data: {
          nickname: userProfile.nickName,
          avatar: userProfile.avatarUrl,
          inviterId: inviterId || null
        }
      }).then(({ result }) => {
        // 清除待处理的邀请人ID
        if (inviterId) {
          wx.removeStorageSync('pendingInviterId')
        }
        wx.hideLoading()
        if (result.code === 0) {
          // 保存用户信息
          that.globalData.userInfo = result.data.userInfo
          that.globalData.isLoggedIn = true
          wx.setStorageSync('userInfo', result.data.userInfo)

          // 登录成功后启动全局消息监听
          that.onLoginSuccess()

          // 提示新用户
          if (result.data.isNewUser) {
            wx.showToast({
              title: '欢迎新用户，已送100积分',
              icon: 'none',
              duration: 2000
            })
          }

          resolve({ success: true, data: result.data })
        } else {
          reject(new Error(result.message))
        }
      }).catch(err => {
        wx.hideLoading()
        wx.showToast({
          title: '登录失败：' + err.message,
          icon: 'none'
        })
        resolve({ success: false, error: err.message })
      })
    })
  },

  // 获取当前用户信息
  getUserInfo() {
    return this.globalData.userInfo
  },

  // 更新本地用户信息
  updateUserInfo(userInfo) {
    this.globalData.userInfo = userInfo
    wx.setStorageSync('userInfo', userInfo)
  },

  // 更新 TabBar 消息未读数
  async updateTabBarBadge() {
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-notify',
        data: { action: 'getUnreadCount' }
      })

      if (result.code === 0) {
        const unreadCount = result.data.total || 0
        this.globalData.unreadCount = unreadCount
        if (unreadCount > 0) {
          wx.setTabBarBadge({
            index: 2,
            text: String(unreadCount > 99 ? '99+' : unreadCount)
          })
        } else {
          wx.removeTabBarBadge({ index: 2 })
        }
      }
    } catch (err) {
      console.error('更新消息徽章失败:', err)
    }
  },

  // 启动全局消息监听
  startGlobalMessageWatch() {
    // 避免重复启动
    if (this.globalData.globalMessageWatcher) {
      console.log('全局消息监听已存在')
      return
    }

    const userInfo = this.globalData.userInfo
    if (!userInfo || !userInfo._id) {
      console.log('用户未登录，暂不启动消息监听')
      return
    }

    const db = wx.cloud.database()

    try {
      console.log('启动全局消息监听, 用户ID:', userInfo._id)

      const watcher = db.collection('wdd-messages')
        .where({
          receiver_id: userInfo._id,
          is_read: false
        })
        .watch({
          onChange: (snapshot) => {
            console.log('全局消息监听回调:', snapshot.type, '变化数:', snapshot.docChanges?.length || 0)

            if (snapshot.type === 'init') {
              // 初始化时更新一次角标
              this.updateTabBarBadge()
              return
            }

            // 有新消息变化
            if (snapshot.docChanges && snapshot.docChanges.length > 0) {
              const hasNewUnread = snapshot.docChanges.some(
                change => change.dataType === 'add' || (change.dataType === 'update' && change.doc.is_read === false)
              )

              if (hasNewUnread) {
                console.log('检测到新未读消息，更新角标')
                // 更新角标
                this.updateTabBarBadge()

                // 如果消息中心页面已注册回调，通知它刷新
                if (this.globalData.messagePageRefreshCallback) {
                  console.log('通知消息中心页面刷新')
                  this.globalData.messagePageRefreshCallback()
                }
              }
            }
          },
          onError: (err) => {
            console.error('全局消息监听失败:', err)
            // 出错时清除监听，下次登录会重试
            this.globalData.globalMessageWatcher = null
          }
        })

      this.globalData.globalMessageWatcher = watcher
      console.log('全局消息监听启动成功')
    } catch (err) {
      console.error('启动全局消息监听异常:', err)
    }
  },

  // 停止全局消息监听
  stopGlobalMessageWatch() {
    if (this.globalData.globalMessageWatcher) {
      this.globalData.globalMessageWatcher.close()
      this.globalData.globalMessageWatcher = null
      console.log('全局消息监听已停止')
    }
  },

  // 注册消息中心页面刷新回调
  registerMessagePageRefresh(callback) {
    this.globalData.messagePageRefreshCallback = callback
  },

  // 注销消息中心页面刷新回调
  unregisterMessagePageRefresh() {
    this.globalData.messagePageRefreshCallback = null
  },

  // 用户登录成功后重新启动全局监听
  onLoginSuccess() {
    this.startGlobalMessageWatch()
  }
})
