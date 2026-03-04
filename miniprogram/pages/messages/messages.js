// 消息中心页面逻辑
const app = getApp()

Page({
  data: {
    // 当前聊天tab
    currentChatTab: 'seeker', // 'seeker' | 'helper'

    // 未读数
    unreadCount: 0,
    seekerChatUnread: 0,
    helperChatUnread: 0,
    systemUnread: 0,

    // 聊天列表
    seekerChatList: [], // 求助聊天
    helperChatList: [], // 帮助聊天

    // 系统通知列表
    systemList: [],

    // 系统通知弹窗
    showSystemModal: false,

    // 下拉刷新
    isRefreshing: false
  },

  onLoad() {
    // 检查登录状态
    app.checkLoginStatus()
    if (!app.globalData.isLoggedIn) {
      // 未登录时清空数据
      this.setData({
        seekerChatList: [],
        helperChatList: [],
        systemList: [],
        unreadCount: 0,
        seekerChatUnread: 0,
        helperChatUnread: 0,
        systemUnread: 0
      })
    } else {
      this.loadMessages(true)
    }

    // 注册全局刷新回调
    app.registerMessagePageRefresh(() => {
      console.log('收到全局刷新通知')
      // 新消息来时静默刷新，不显示 loading
      if (app.globalData.isLoggedIn) {
        this.loadMessages(false)
      }
    })
  },

  onShow() {
    // 先让 app 同步 globalData 和本地存储
    app.checkLoginStatus()

    // 检查是否登录
    if (!app.globalData.isLoggedIn) {
      // 未登录时清空数据并清除角标
      this.setData({
        seekerChatList: [],
        helperChatList: [],
        systemList: [],
        unreadCount: 0,
        seekerChatUnread: 0,
        helperChatUnread: 0,
        systemUnread: 0
      }, () => {
        // 清除 TabBar 角标
        wx.removeTabBarBadge({ index: 2 })
      })
      return
    }

    this.loadMessages(true)
    // 确保全局监听已启动
    app.startGlobalMessageWatch()
  },

  onHide() {
    // 页面隐藏时不停止全局监听
    // 全局监听由 app.js 统一管理
  },

  onUnload() {
    // 注销全局刷新回调
    app.unregisterMessagePageRefresh()
  },

  // 更新 TabBar 未读徽章
  updateTabBarBadge() {
    const { unreadCount } = this.data
    if (unreadCount > 0) {
      wx.setTabBarBadge({
        index: 2,
        text: String(unreadCount > 99 ? '99+' : unreadCount)
      })
    } else {
      wx.removeTabBarBadge({ index: 2 })
    }
  },

  // 切换聊天标签
  switchChatTab(e) {
    const tab = e.currentTarget.dataset.tab
    this.setData({ currentChatTab: tab })
  },

  // 打开系统通知弹窗
  async openSystemNotifications() {
    this.setData({ showSystemModal: true })

    // 如果有未读系统通知，全部标记为已读
    if (this.data.systemUnread > 0) {
      await this.markAllSystemNotificationsRead()
    }
  },

  // 关闭系统通知弹窗
  closeSystemNotifications() {
    this.setData({ showSystemModal: false })
  },

  // 标记所有系统通知为已读
  async markAllSystemNotificationsRead() {
    try {
      const unreadNotifications = this.data.systemList.filter(item => !item.is_read)
      if (unreadNotifications.length === 0) return

      // 调用云函数批量标记已读
      await wx.cloud.callFunction({
        name: 'wdd-notify',
        data: {
          action: 'markAllAsRead'
        }
      })

      // 更新本地状态
      const systemList = this.data.systemList.map(item => ({
        ...item,
        is_read: true
      }))

      this.setData({
        systemList,
        systemUnread: 0
      })

      // 重新计算总未读数
      this.calculateTotalUnread()
    } catch (err) {
      console.error('标记全部已读失败:', err)
    }
  },

  // 计算总未读数
  calculateTotalUnread() {
    const { seekerChatUnread, helperChatUnread, systemUnread } = this.data
    this.setData({
      unreadCount: seekerChatUnread + helperChatUnread + systemUnread
    }, () => {
      this.updateTabBarBadge()
    })
  },

  // 下拉刷新
  async onRefresh() {
    this.setData({ isRefreshing: true })
    await this.loadMessages(false)
    this.setData({ isRefreshing: false })
  },

  // 加载消息列表
  // showLoading: 是否显示 loading，静默刷新时不显示
  async loadMessages(showLoading = true) {
    let loadingTimer = null

    try {
      // 延迟显示 loading，超过1秒才显示
      if (showLoading) {
        loadingTimer = setTimeout(() => {
          wx.showLoading({ title: '加载中...' })
        }, 1000)
      }

      const { result } = await wx.cloud.callFunction({
        name: 'wdd-notify',
        data: {
          action: 'getMessageList'
        }
      })

      // 清除 loading 定时器
      if (loadingTimer) {
        clearTimeout(loadingTimer)
        loadingTimer = null
      }
      // 隐藏已显示的 loading
      if (showLoading) {
        wx.hideLoading()
      }

      if (result.code === 0) {
        // 分离求助聊天和帮助聊天
        const chatList = result.data.chatList.map(item => ({
          ...item,
          lastTime: this.formatTime(item.lastTime),
          statusText: this.getStatusText(item.needStatus)
        }))

        const seekerChatList = chatList.filter(item => item.isSeeker)
        const helperChatList = chatList.filter(item => !item.isSeeker)

        // 计算各类型未读数
        const seekerChatUnread = seekerChatList.reduce((sum, item) => sum + (item.unread || 0), 0)
        const helperChatUnread = helperChatList.reduce((sum, item) => sum + (item.unread || 0), 0)

        // 处理系统通知列表
        const systemList = result.data.systemList.map(item => ({
          ...item,
          icon: this.getNotificationIcon(item.type),
          timeText: this.formatTime(item.create_time)
        }))

        const systemUnread = result.data.systemUnread || 0

        this.setData({
          seekerChatList,
          helperChatList,
          systemList,
          seekerChatUnread,
          helperChatUnread,
          systemUnread,
          unreadCount: seekerChatUnread + helperChatUnread + systemUnread
        }, () => {
          // 更新 TabBar 徽章
          this.updateTabBarBadge()
        })
      }
    } catch (err) {
      // 清除 loading 定时器
      if (loadingTimer) {
        clearTimeout(loadingTimer)
      }
      // 隐藏已显示的 loading
      if (showLoading) {
        wx.hideLoading()
      }
      console.error('加载消息失败:', err)

      // 清空数据（可能是未登录）
      this.setData({
        seekerChatList: [],
        helperChatList: [],
        systemList: [],
        unreadCount: 0,
        seekerChatUnread: 0,
        helperChatUnread: 0,
        systemUnread: 0
      })
    }
  },

  // 跳转到任务大厅
  goToHall() {
    wx.switchTab({
      url: '/pages/task-hall/task-hall'
    })
  },

  // 跳转到聊天页
  goToChat(e) {
    const { needid, isseeker } = e.currentTarget.dataset
    const isSeekerBool = isseeker === true || isseeker === 'true'

    // 本地立即清零对应会话的未读数（优化体验）
    this.clearLocalUnread(needid, isSeekerBool)

    wx.navigateTo({
      url: `/pages/chat/chat?needId=${needid}&isSeeker=${isSeekerBool}`
    })
  },

  // 本地清零指定会话的未读数
  clearLocalUnread(needId, isSeeker) {
    const listKey = isSeeker ? 'seekerChatList' : 'helperChatList'
    const list = this.data[listKey].map(item => {
      if (item.needId === needId) {
        return { ...item, unread: 0 }
      }
      return item
    })

    // 重新计算未读数
    const newSeekerUnread = isSeeker
      ? list.reduce((sum, item) => sum + (item.unread || 0), 0)
      : this.data.seekerChatUnread
    const newHelperUnread = !isSeeker
      ? list.reduce((sum, item) => sum + (item.unread || 0), 0)
      : this.data.helperChatUnread

    this.setData({
      [listKey]: list,
      seekerChatUnread: newSeekerUnread,
      helperChatUnread: newHelperUnread,
      unreadCount: newSeekerUnread + newHelperUnread + this.data.systemUnread
    }, () => {
      this.updateTabBarBadge()
    })
  },

  // 获取状态文本
  getStatusText(status) {
    const statusMap = {
      'pending': '待匹配',
      'ongoing': '进行中',
      'completed': '已完成',
      'cancelled': '已取消'
    }
    return statusMap[status] || status
  },

  // 获取通知图标
  getNotificationIcon(type) {
    const iconMap = {
      'task_completed': '✅',
      'task_cancelled': '❌',
      'task_matched': '🎯',
      'points_received': '💰',
      'system': '📢'
    }
    return iconMap[type] || '📢'
  },

  // 格式化时间
  formatTime(date) {
    if (!date) return ''

    const now = new Date()
    const msgTime = new Date(date)
    const diff = now.getTime() - msgTime.getTime()

    // 小于1分钟
    if (diff < 60000) {
      return '刚刚'
    }

    // 小于1小时
    if (diff < 3600000) {
      return Math.floor(diff / 60000) + '分钟前'
    }

    // 小于24小时
    if (diff < 86400000) {
      return Math.floor(diff / 3600000) + '小时前'
    }

    // 昨天
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    if (this.isSameDay(yesterday, msgTime)) {
      return '昨天'
    }

    // 小于7天
    if (diff < 604800000) {
      return Math.floor(diff / 86400000) + '天前'
    }

    // 更早
    return `${msgTime.getMonth() + 1}月${msgTime.getDate()}日`
  },

  // 是否为同一天
  isSameDay(date1, date2) {
    return date1.getFullYear() === date2.getFullYear() &&
           date1.getMonth() === date2.getMonth() &&
           date1.getDate() === date2.getDate()
  }
})
