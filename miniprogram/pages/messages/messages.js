// 消息中心页面逻辑
const app = getApp()

Page({
  data: {
    // 当前标签
    currentTab: 'chat',

    // 未读数
    unreadCount: 0,
    chatUnread: 0,
    systemUnread: 0,

    // 聊天列表
    chatList: [],

    // 系统通知列表
    systemList: [],

    },

  onLoad() {
    this.loadMessages(true)
    // 注册全局刷新回调
    app.registerMessagePageRefresh(() => {
      console.log('收到全局刷新通知')
      // 新消息来时静默刷新，不显示 loading
      this.loadMessages(false)
    })
  },

  onShow() {
    // 检查是否登录
    if (!app.globalData.isLoggedIn) {
      this.setData({
        chatList: [],
        systemList: [],
        unreadCount: 0,
        chatUnread: 0,
        systemUnread: 0
      })
      return
    }

    this.loadMessages(true)
    this.updateTabBarBadge()
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

  // 切换标签
  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    this.setData({ currentTab: tab })
    this.loadMessages(true)
  },

  // 加载消息列表
  // showLoading: 是否显示 loading，静默刷新时不显示
  async loadMessages(showLoading = true) {
    try {
      if (showLoading) {
        wx.showLoading({ title: '加载中...' })
      }

      const { result } = await wx.cloud.callFunction({
        name: 'wdd-notify',
        data: {
          action: 'getMessageList'
        }
      })

      if (showLoading) {
        wx.hideLoading()
      }

      if (result.code === 0) {
        // 处理聊天列表
        const chatList = result.data.chatList.map(item => ({
          ...item,
          lastTime: this.formatTime(item.lastTime),
          statusText: this.getStatusText(item.needStatus)
        }))

        // 处理系统通知列表
        const systemList = result.data.systemList.map(item => ({
          ...item,
          icon: this.getNotificationIcon(item.type),
          timeText: this.formatTime(item.create_time)
        }))

        this.setData({
          chatList,
          systemList,
          unreadCount: result.data.unreadCount || 0,
          chatUnread: result.data.chatUnread || 0,
          systemUnread: result.data.systemUnread || 0
        }, () => {
          // 更新 TabBar 徽章
          this.updateTabBarBadge()
        })
      }
    } catch (err) {
      if (showLoading) {
        wx.hideLoading()
      }
      console.error('加载消息失败:', err)

      // 清空数据（可能是未登录）
      this.setData({
        chatList: [],
        systemList: [],
        unreadCount: 0,
        chatUnread: 0,
        systemUnread: 0
      })
    }
  },

  // 使用模拟数据（开发阶段）
  setMockData() {
    const mockChatList = [
      {
        needId: '1',
        title: '春熙路星巴克营业情况',
        typeIcon: '🏪',
        lastMessage: '已经开门了，人不多',
        lastTime: '10:30',
        needStatus: 'ongoing',
        isSeeker: true,
        unread: 2
      },
      {
        needId: '2',
        title: '天府广场实时天气',
        typeIcon: '🌤️',
        lastMessage: '[图片]',
        lastTime: '昨天',
        needStatus: 'completed',
        isSeeker: false,
        unread: 0
      }
    ]

    const mockSystemList = [
      {
        _id: '1',
        type: 'task_completed',
        title: '任务已完成',
        content: '你帮助完成的「天府广场实时天气」任务已确认完成，获得 10 积分',
        create_time: new Date(Date.now() - 86400000),
        is_read: false
      },
      {
        _id: '2',
        type: 'system',
        title: '欢迎加入问当地',
        content: '感谢你使用问当地！新用户已到账 100 积分，快去发布第一个求助吧~',
        create_time: new Date(Date.now() - 172800000),
        is_read: true
      }
    ]

    this.setData({
      chatList: mockChatList,
      systemList: mockSystemList.map(item => ({
        ...item,
        icon: this.getNotificationIcon(item.type),
        timeText: this.formatTime(item.create_time)
      })),
      unreadCount: 3,
      chatUnread: 2,
      systemUnread: 1
    })
  },

  // 跳转到聊天页
  goToChat(e) {
    const { needid, isseeker } = e.currentTarget.dataset
    wx.navigateTo({
      url: `/pages/chat/chat?needId=${needid}&isSeeker=${isseeker}`
    })
  },

  // 标记通知为已读
  async readNotification(e) {
    const id = e.currentTarget.dataset.id

    try {
      await wx.cloud.callFunction({
        name: 'wdd-notify',
        data: {
          action: 'markAsRead',
          notificationId: id
        }
      })

      // 更新本地状态
      const systemList = this.data.systemList.map(item => {
        if (item._id === id) {
          return { ...item, is_read: true }
        }
        return item
      })

      this.setData({ systemList })
      this.loadMessages()
    } catch (err) {
      console.error('标记已读失败:', err)
    }
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
