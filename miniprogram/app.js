// 小程序入口
App({
  globalData: {
    userInfo: null,
    isLoggedIn: false,
    systemInfo: null,
    // 用户当前位置（全局共享）
    userLocation: null,
    // 全局消息监听
    globalMessageWatcher: null,
    // 未读消息数缓存
    unreadCount: 0,
    // 消息中心页面刷新回调
    messagePageRefreshCallback: null,
    // 平台全局配置（费率等）
    platformConfig: null
  },

  onLaunch() {
    // release 包屏蔽业务日志
    if (typeof __wxConfig !== 'undefined' && __wxConfig.envVersion === 'release') {
      console.log = () => {}
      console.info = () => {}
    }

    // 初始化云开发
    wx.cloud.init({
      env: 'wdd-2grpiy1r6f9f4cf2',
      traceUser: true
    })

    // 获取系统信息
    this.getSystemInfo()

    // 检查登录状态
    this.checkLoginStatus()

    // 启动全局消息监听（仅已登录用户）
    if (this.globalData.isLoggedIn) {
      this.startGlobalMessageWatch()
    }

    // 获取用户当前位置（不阻塞启动；位置可能因 GPS 弱/未授权 timeout，静默忽略）
    this.updateUserLocation().catch(err => {
      console.warn('启动时获取位置失败:', err.errMsg || err.message)
    })

    // 加载平台全局配置（费率等），不阻塞启动
    this.loadPlatformConfig()
  },

  onShow() {
    // 小程序显示时刷新角标（仅已登录用户）
    if (this.globalData.isLoggedIn) {
      this.updateTabBarBadge()
    }

    // 每次显示小程序时更新用户位置（静默忽略失败）
    this.updateUserLocation().catch(err => {
      console.warn('onShow 获取位置失败:', err.errMsg || err.message)
    })

    // 刷新平台配置（不阻塞；用户在后台修改数据库后切回可自动生效）
    this.loadPlatformConfig()
  },

  // 获取/更新用户当前位置
  async updateUserLocation() {
    try {
      // 1. 先检查隐私授权设置（微信 3.0.0+）
      if (wx.getPrivacySetting) {
        const privacyRes = await new Promise((resolve) => {
          wx.getPrivacySetting({ success: resolve, fail: () => resolve({ needAuthorization: false }) })
        })
        // 需要授权但用户未同意时，尝试拉起授权弹窗
        if (privacyRes.needAuthorization && wx.requirePrivacyAuthorize) {
          try {
            await new Promise((resolve, reject) => {
              wx.requirePrivacyAuthorize({ success: resolve, fail: reject })
            })
          } catch (privacyErr) {
            // 用户拒绝或后台未配置隐私指引
            console.warn('隐私授权失败:', privacyErr.errMsg || privacyErr.message)
            // errno 112 = 后台未配置隐私保护指引
            if (privacyErr.errno === 112) {
              console.error('【重要】请在微信公众平台后台配置《隐私保护指引》，声明"位置信息"权限')
            }
            throw { ...privacyErr, _privacyDenied: true }
          }
        }
      }

      const res = await wx.getLocation({
        type: 'gcj02' // 国测局坐标系，与腾讯地图一致
      })

      this.globalData.userLocation = {
        latitude: res.latitude,
        longitude: res.longitude,
        updateTime: Date.now()
      }

      console.log('全局位置更新成功:', res.latitude, res.longitude)
      return this.globalData.userLocation
    } catch (err) {
      // errno 112 = 后台未配置隐私保护指引
      if (err.errno === 112) {
        console.error('获取位置失败：小程序后台《隐私保护指引》未配置"位置信息"权限')
      } else {
        console.error('获取用户位置失败:', err.errMsg || err.message || err)
      }
      // 抛出错误让调用者知道位置获取失败
      throw err
    }
  },

  // 获取当前用户位置（供页面调用）
  getUserLocation() {
    return this.globalData.userLocation
  },

  // 获取系统信息（使用新 API，兼容旧版）
  getSystemInfo() {
    const gather = () => {
      const info = {}
      try {
        if (wx.getDeviceInfo) Object.assign(info, wx.getDeviceInfo())
        if (wx.getWindowInfo) Object.assign(info, wx.getWindowInfo())
        if (wx.getAppBaseInfo) Object.assign(info, wx.getAppBaseInfo())
      } catch (e) {
        // 低版本兜底
      }
      if (Object.keys(info).length > 0) {
        this.globalData.systemInfo = info
      } else if (wx.getSystemInfoSync) {
        try {
          this.globalData.systemInfo = wx.getSystemInfoSync()
        } catch (e) {}
      }
    }
    gather()
  },

  // 检查登录状态
  checkLoginStatus() {
    const userInfo = wx.getStorageSync('userInfo')
    if (userInfo && userInfo._id) {
      this.globalData.userInfo = userInfo
      this.globalData.isLoggedIn = true
      // 已登录用户启动全局消息监听
      this.startGlobalMessageWatch()
    } else {
      // 没有用户信息时，确保状态为未登录
      this.globalData.userInfo = null
      this.globalData.isLoggedIn = false
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

  // 退出登录
  logout() {
    // 1. 停止全局消息监听
    this.stopGlobalMessageWatch()

    // 2. 清除本地存储
    wx.removeStorageSync('userInfo')
    wx.removeStorageSync('lastSignDate')
    wx.removeStorageSync('pendingInviterId')

    // 3. 停止全局消息监听（真正关闭）
    if (this.globalData.globalMessageWatcher) {
      try {
        this.globalData.globalMessageWatcher.close()
      } catch (e) {
        console.error('关闭消息监听失败:', e)
      }
    }

    // 4. 清除全局数据
    this.globalData.userInfo = null
    this.globalData.isLoggedIn = false
    this.globalData.unreadCount = 0
    this.globalData.globalMessageWatcher = null
    this.globalData.messagePageRefreshCallback = null

    // 4. 清除消息角标
    try {
      wx.removeTabBarBadge({ index: 2 })
    } catch (e) {
      // 角标可能不存在，忽略错误
    }

    console.log('退出登录完成')
  },

  // 更新 TabBar 消息未读数
  async updateTabBarBadge() {
    // 未登录时不获取
    if (!this.globalData.isLoggedIn) {
      wx.removeTabBarBadge({ index: 2 })
      return
    }

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
            var docChangesLength = (snapshot.docChanges && snapshot.docChanges.length) || 0
            console.log('全局消息监听回调:', snapshot.type, '变化数:', docChangesLength)

            if (snapshot.type === 'init') {
              // 初始化时更新一次角标
              this.updateTabBarBadge()
              return
            }

            // 有新消息变化
            if (snapshot.docChanges && snapshot.docChanges.length > 0) {
              var hasNewUnread = snapshot.docChanges.some(
                function(change) {
                  return change.dataType === 'add' || (change.dataType === 'update' && change.doc.is_read === false)
                }
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
  },

  // 加载平台全局配置（费率等）
  async loadPlatformConfig() {
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-get-config'
      })
      if (result.code === 0 && result.data) {
        const { setPlatformConfig } = require('./utils/platformRules')
        setPlatformConfig(result.data)
        this.globalData.platformConfig = result.data
        console.log('平台配置加载成功:', result.data)
      }
    } catch (e) {
      console.warn('获取平台配置失败，使用默认值:', e)
    }
  }
})
