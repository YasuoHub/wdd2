// 帮助者信息完善页面
const app = getApp()
const { requirePrivacyAuthorize } = require('../../utils/privacy')

// 帮助类型选项
const HELP_TYPES = [
  { id: 'weather', name: '实时天气', icon: '🌤️', color: '#74B9FF' },
  { id: 'traffic', name: '道路拥堵', icon: '🚗', color: '#FDCB6E' },
  { id: 'shop', name: '店铺营业', icon: '🏪', color: '#A29BFE' },
  { id: 'parking', name: '停车场空位', icon: '🅿️', color: '#00CEC9' },
  { id: 'queue', name: '排队情况', icon: '👥', color: '#FD79A8' },
  { id: 'other', name: '其他', icon: '💬', color: '#A8E6CF' }
]

Page({
  data: {
    // 帮助意愿
    helpWillingness: '', // 'willing' | 'request_only'
    willingnessOptions: [
      { value: 'willing', label: '愿意帮助他人', desc: '可以接单帮助附近的人', icon: '🤗' },
      { value: 'request_only', label: '仅求助不帮助', desc: '只发布求助，不接单', icon: '🙏' }
    ],

    // 常去地点（最多3个）
    frequentLocations: [],
    maxLocations: 3,

    // 可帮助类型
    helpTypes: [],
    selectedHelpTypes: [],

    // 页面状态
    isLoading: false,
    isEditing: false, // 是否为编辑模式（老用户修改）
    fromLogin: false,  // 是否来自登录流程
    pageLoading: true  // 页面初始加载中
  },

  onLoad(options) {
    // 检查登录状态
    app.checkLoginStatus()
    if (!app.globalData.isLoggedIn) {
      wx.showToast({
        title: '请先登录',
        icon: 'none'
      })
      setTimeout(() => {
        wx.navigateBack()
      }, 1500)
      return
    }

    // 判断是否来自登录流程
    const fromLogin = options.fromLogin === 'true'
    const isEditing = options.edit === 'true'

    this.setData({
      fromLogin,
      isEditing
    })

    // 初始化帮助类型数据
    this.initHelpTypes()

    // 加载现有资料
    this.loadExistingProfile()
  },

  // 初始化帮助类型（添加选中状态）
  initHelpTypes() {
    const helpTypes = HELP_TYPES.map(item => ({
      ...item,
      selected: false
    }))
    this.setData({ helpTypes })
  },

  // 更新帮助类型选中状态
  updateHelpTypesSelection(selectedIds) {
    const helpTypes = this.data.helpTypes.map(item => ({
      ...item,
      selected: selectedIds.includes(item.id)
    }))
    this.setData({ helpTypes })
  },

  // 加载现有帮助者资料
  async loadExistingProfile() {
    this.setData({ pageLoading: true })

    const userInfo = app.globalData.userInfo
    if (!userInfo || !userInfo._id) {
      this.setData({ pageLoading: false })
      return
    }

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-login',
        data: {
          action: 'getHelperProfile'
        }
      })

      if (result.code === 0 && result.data && result.data.helperProfile) {
        const profile = result.data.helperProfile
        const selectedHelpTypes = profile.help_types || []
        this.setData({
          helpWillingness: profile.help_willingness || '',
          frequentLocations: profile.frequent_locations || [],
          selectedHelpTypes: selectedHelpTypes
        })
        // 更新帮助类型选中状态
        this.updateHelpTypesSelection(selectedHelpTypes)
      }
    } catch (err) {
      console.error('加载帮助者资料失败:', err)
    } finally {
      this.setData({ pageLoading: false })
    }
  },

  // 选择帮助意愿
  selectWillingness(e) {
    const value = e.currentTarget.dataset.value
    this.setData({
      helpWillingness: value
    })
  },

  // 添加常去地点
  async addLocation() {
    if (this.data.frequentLocations.length >= this.data.maxLocations) {
      wx.showToast({
        title: `最多添加${this.data.maxLocations}个地点`,
        icon: 'none'
      })
      return
    }

    try {
      await requirePrivacyAuthorize()
      const res = await wx.chooseLocation({
        title: '选择常去地点'
      })

      // 检查是否已存在相同地点（根据名称简单判断）
      const exists = this.data.frequentLocations.some(
        loc => loc.name === res.name
      )
      if (exists) {
        wx.showToast({
          title: '该地点已添加',
          icon: 'none'
        })
        return
      }

      const newLocation = {
        name: res.name,
        address: res.address,
        latitude: res.latitude,
        longitude: res.longitude
      }

      this.setData({
        frequentLocations: [...this.data.frequentLocations, newLocation]
      })
    } catch (err) {
      // 用户取消选择，不做处理
      if (err.errMsg && err.errMsg.includes('cancel')) return
      if (err.errno === 112) {
        wx.showToast({ title: '定位服务暂不可用', icon: 'none' })
        return
      }
      console.error('选择地点失败:', err)
      wx.showToast({
        title: '选择地点失败',
        icon: 'none'
      })
    }
  },

  // 删除常去地点
  removeLocation(e) {
    const index = e.currentTarget.dataset.index
    const locations = this.data.frequentLocations.filter((_, i) => i !== index)
    this.setData({ frequentLocations: locations })
  },

  // 切换帮助类型选择
  toggleHelpType(e) {
    const typeId = e.currentTarget.dataset.id
    const selected = this.data.selectedHelpTypes
    let newSelected

    if (selected.includes(typeId)) {
      // 取消选择
      newSelected = selected.filter(id => id !== typeId)
    } else {
      // 添加选择
      newSelected = [...selected, typeId]
    }

    this.setData({
      selectedHelpTypes: newSelected
    })

    // 更新帮助类型的选中状态
    this.updateHelpTypesSelection(newSelected)
  },

  // 保存帮助者资料
  async saveProfile() {
    const { helpWillingness, frequentLocations, selectedHelpTypes } = this.data

    // 验证
    if (!helpWillingness) {
      wx.showToast({
        title: '请选择帮助意愿',
        icon: 'none'
      })
      return
    }

    // 如果选择愿意帮助，需要至少一个帮助类型
    if (helpWillingness === 'willing' && selectedHelpTypes.length === 0) {
      wx.showToast({
        title: '请至少选择一个可帮助类型',
        icon: 'none'
      })
      return
    }

    this.setData({ isLoading: true })
    wx.showLoading({ title: '保存中...' })

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-login',
        data: {
          action: 'updateHelperProfile',
          helpWillingness,
          frequentLocations,
          helpTypes: selectedHelpTypes
        }
      })

      wx.hideLoading()
      this.setData({ isLoading: false })

      if (result.code === 0) {
        wx.showToast({
          title: '保存成功',
          icon: 'success'
        })

        // 更新全局数据
        if (app.globalData.userInfo) {
          app.globalData.userInfo.helperProfile = {
            help_willingness: helpWillingness,
            frequent_locations: frequentLocations,
            help_types: selectedHelpTypes
          }
        }

        // 延迟返回或跳转
        setTimeout(() => {
          if (this.data.fromLogin) {
            // 来自登录流程，跳转到首页
            wx.switchTab({
              url: '/pages/index/index'
            })
          } else {
            // 编辑模式，返回上一页
            wx.navigateBack()
          }
        }, 1500)
      } else {
        throw new Error(result.message)
      }
    } catch (err) {
      wx.hideLoading()
      this.setData({ isLoading: false })
      wx.showToast({
        title: err.message || '保存失败',
        icon: 'none'
      })
    }
  },

  // 跳过（仅求助模式可用）
  skip() {
    if (this.data.helpWillingness === 'willing') {
      wx.showToast({
        title: '愿意帮助他人时需要完善资料',
        icon: 'none'
      })
      return
    }

    wx.showModal({
      title: '确认跳过',
      content: '完善资料后可以获得更精准的任务推荐，是否跳过？',
      confirmText: '跳过',
      cancelText: '继续完善',
      success: (res) => {
        if (res.confirm) {
          // 设置为仅求助模式并保存
          this.setData({
            helpWillingness: 'request_only',
            selectedHelpTypes: [],
            frequentLocations: []
          }, () => {
            this.saveProfile()
          })
        }
      }
    })
  }
})
