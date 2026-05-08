// 用户信息填写页面
const app = getApp()
const { requirePrivacyAuthorize } = require('../../utils/privacy')

Page({
  data: {
    nickname: '',
    avatarUrl: '',
    isLoading: false,
    privacyTip: '' // 隐私授权提示
  },

  onLoad() {
    // 检查是否已有用户信息（老用户登录）
    const userInfo = app.globalData.userInfo
    if (userInfo && userInfo._id) {
      this.setData({
        nickname: userInfo.nickname || '',
        avatarUrl: userInfo.avatar || ''
      })
    }

    // 预检隐私授权状态（chooseAvatar 是组件级 open-type，无法前置拦截）
    this.checkPrivacyStatus()
  },

  // 检查隐私授权状态
  async checkPrivacyStatus() {
    if (!wx.getPrivacySetting) return
    try {
      const res = await new Promise((resolve) => {
        wx.getPrivacySetting({ success: resolve, fail: () => resolve({ needAuthorization: false }) })
      })
      if (res.needAuthorization) {
        this.setData({ privacyTip: '首次使用需同意隐私协议，点击头像时会弹出授权提示' })
      }
    } catch (e) {
      // 忽略错误
    }
  },

  // 选择头像
  onChooseAvatar(e) {
    const { avatarUrl } = e.detail
    this.setData({ avatarUrl })
  },

  // 输入昵称
  onInputNickname(e) {
    this.setData({ nickname: e.detail.value })
  },

  // 处理登录
  async handleLogin() {
    const { nickname, avatarUrl } = this.data

    if (!nickname.trim()) {
      wx.showToast({ title: '请输入昵称', icon: 'none' })
      return
    }

    if (!avatarUrl) {
      wx.showToast({ title: '请选择头像', icon: 'none' })
      return
    }

    this.setData({ isLoading: true })
    wx.showLoading({ title: '登录中...' })

    try {
      // 先上传头像到云存储
      let cloudAvatarUrl = avatarUrl
      if (avatarUrl.startsWith('wxfile://') || avatarUrl.startsWith('http://tmp/')) {
        const uploadRes = await wx.cloud.uploadFile({
          cloudPath: `avatars/${Date.now()}-${Math.random().toString(36).substr(2, 6)}.jpg`,
          filePath: avatarUrl
        })
        cloudAvatarUrl = uploadRes.fileID
      }

      // 调用登录
      const result = await app.login({
        nickName: nickname.trim(),
        avatarUrl: cloudAvatarUrl
      })

      wx.hideLoading()
      this.setData({ isLoading: false })

      if (result.success) {
        // 通知首页登录成功
        const pages = getCurrentPages()
        const indexPage = pages.find(p => p.route === 'pages/index/index')
        if (indexPage && indexPage.onLoginSuccess) {
          indexPage.onLoginSuccess(result)
        }

        // 返回上一页
        wx.navigateBack()
      } else {
        throw new Error(result.error || '登录失败')
      }
    } catch (err) {
      wx.hideLoading()
      this.setData({ isLoading: false })
      wx.showToast({ title: err.message || '登录失败', icon: 'none' })
    }
  },

  // 取消登录
  handleCancel() {
    wx.navigateBack()
  }
})
