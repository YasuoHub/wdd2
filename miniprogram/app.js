// 小程序入口
App({
  globalData: {
    userInfo: null,
    isLoggedIn: false,
    systemInfo: null
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
    }
  },

  // 用户登录
  login(userProfile) {
    const that = this
    return new Promise((resolve, reject) => {
      wx.showLoading({ title: '登录中...' })
      wx.cloud.callFunction({
        name: 'wdd-login',
        data: {
          nickname: userProfile.nickName,
          avatar: userProfile.avatarUrl
        }
      }).then(({ result }) => {
        wx.hideLoading()
        if (result.code === 0) {
          // 保存用户信息
          that.globalData.userInfo = result.data.userInfo
          that.globalData.isLoggedIn = true
          wx.setStorageSync('userInfo', result.data.userInfo)

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
  }
})
