// 聊天页面逻辑
const app = getApp()

Page({
  data: {
    // 任务信息
    task: {
      _id: '',
      type: '',
      typeName: '',
      typeIcon: '',
      description: '',
      points: 0,
      status: 'ongoing',
      statusText: '进行中',
      expireTime: null
    },

    // 用户信息
    userInfo: null,
    isSeeker: false,
    otherUser: null,

    // 消息相关
    messages: [],
    inputValue: '',
    inputFocus: false,
    lastMessageId: '',
    hasMoreMessages: false,
    pageSize: 20,

    // 倒计时
    countdownText: '',
    countdownTimer: null,

    // 弹窗
    showCompleteModal: false,

    // 监听
    watchListener: null
  },

  onLoad(options) {
    // 获取页面参数
    const { needId, isSeeker } = options

    this.setData({
      'task._id': needId,
      isSeeker: isSeeker === 'true',
      userInfo: app.globalData.userInfo
    })

    // 加载任务信息
    this.loadTaskInfo()

    // 加载历史消息
    this.loadMessages()

    // 开始监听新消息
    this.startMessageWatch()
  },

  onShow() {
    // 页面显示时重新连接监听
    if (!this.data.watchListener && this.data.task._id) {
      this.startMessageWatch()
    }
  },

  onHide() {
    // 页面隐藏时暂停监听
    this.stopMessageWatch()
  },

  onUnload() {
    // 页面卸载时清理
    this.stopMessageWatch()
    this.stopCountdown()
  },

  // 加载任务信息
  async loadTaskInfo() {
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-chat',
        data: {
          action: 'getTaskInfo',
          needId: this.data.task._id
        }
      })

      if (result.code === 0) {
        const taskData = result.data
        const statusMap = {
          'pending': { text: '待匹配', class: '' },
          'ongoing': { text: '进行中', class: 'ongoing' },
          'completed': { text: '已完成', class: 'completed' },
          'cancelled': { text: '已取消', class: 'cancelled' }
        }

        const typeMap = {
          'weather': { name: '实时天气', icon: '🌤️' },
          'traffic': { name: '道路拥堵', icon: '🚗' },
          'shop': { name: '店铺营业', icon: '🏪' },
          'parking': { name: '停车场空位', icon: '🅿️' },
          'queue': { name: '排队情况', icon: '👥' },
          'other': { name: '其他', icon: '📌' }
        }

        const typeInfo = typeMap[taskData.type] || typeMap['other']
        const statusInfo = statusMap[taskData.status] || statusMap['pending']

        this.setData({
          task: {
            _id: taskData._id,
            type: taskData.type,
            typeName: typeInfo.name,
            typeIcon: typeInfo.icon,
            description: taskData.description,
            points: taskData.points,
            status: taskData.status,
            statusText: statusInfo.text,
            expireTime: taskData.expire_time
          },
          otherUser: result.data.otherUser
        })

        // 如果任务进行中，启动倒计时
        if (taskData.status === 'ongoing') {
          this.startCountdown()
        }
      }
    } catch (err) {
      console.error('加载任务信息失败:', err)
      wx.showToast({
        title: '加载失败',
        icon: 'none'
      })
    }
  },

  // 加载历史消息
  async loadMessages(isLoadMore = false) {
    try {
      const { task, pageSize, messages } = this.data

      const { result } = await wx.cloud.callFunction({
        name: 'wdd-chat',
        data: {
          action: 'getMessages',
          needId: task._id,
          limit: pageSize,
          beforeTime: isLoadMore && messages.length > 0
            ? messages[0].create_time
            : null
        }
      })

      if (result.code === 0) {
        const newMessages = result.data.list.map(msg => this.formatMessage(msg))

        if (isLoadMore) {
          this.setData({
            messages: [...newMessages, ...messages],
            hasMoreMessages: newMessages.length >= pageSize
          })
        } else {
          this.setData({
            messages: newMessages,
            hasMoreMessages: newMessages.length >= pageSize
          }, () => {
            // 首次加载滚动到底部
            this.scrollToBottom()
          })
        }
      }
    } catch (err) {
      console.error('加载消息失败:', err)
    }
  },

  // 加载更多消息
  loadMoreMessages() {
    this.loadMessages(true)
  },

  // 格式化消息
  formatMessage(msg) {
    const userInfo = this.data.userInfo
    const isSelf = msg.sender_id === userInfo._id

    // 处理时间显示
    const now = new Date()
    const msgTime = new Date(msg.create_time)
    let timeText = ''

    if (this.isSameDay(now, msgTime)) {
      timeText = this.formatTime(msgTime)
    } else if (this.isYesterday(now, msgTime)) {
      timeText = '昨天 ' + this.formatTime(msgTime)
    } else {
      timeText = this.formatDate(msgTime) + ' ' + this.formatTime(msgTime)
    }

    return {
      ...msg,
      isSelf,
      senderAvatar: isSelf ? userInfo.avatar : (this.data.otherUser && this.data.otherUser.avatar) || '/images/default-avatar.png',
      timeText,
      showTime: true, // 后续可根据需要优化时间显示逻辑
      // 统一图片字段为 camelCase
      imageUrl: msg.image_url || ''
    }
  },

  // 开始监听新消息
  startMessageWatch() {
    if (this.data.watchListener) return

    const db = wx.cloud.database()
    const _ = db.command

    // 使用最后一条消息的时间作为监听起点，避免漏消息
    const lastMessage = this.data.messages[this.data.messages.length - 1]
    const watchStartTime = lastMessage ? new Date(lastMessage.create_time) : new Date()

    const listener = db.collection('wdd-messages')
      .where({
        need_id: this.data.task._id,
        create_time: _.gt(watchStartTime)
      })
      .watch({
        onChange: (snapshot) => {
          if (snapshot.docChanges.length > 0) {
            // 有新消息，过滤掉已存在的消息
            const existingIds = new Set(this.data.messages.map(m => m._id))
            const newMessages = snapshot.docChanges
              .filter(change => change.dataType === 'add')
              .map(change => change.doc)
              .filter(doc => !existingIds.has(doc._id))
              .map(doc => this.formatMessage(doc))

            if (newMessages.length > 0) {
              this.setData({
                messages: [...this.data.messages, ...newMessages]
              }, () => {
                this.scrollToBottom()
              })
            }
          }
        },
        onError: (err) => {
          console.error('消息监听失败:', err)
        }
      })

    this.setData({ watchListener: listener })
  },

  // 停止监听
  stopMessageWatch() {
    if (this.data.watchListener) {
      this.data.watchListener.close()
      this.setData({ watchListener: null })
    }
  },

  // 发送文字消息
  async sendTextMessage() {
    const { inputValue, task } = this.data
    if (!inputValue.trim()) return

    // 检查任务状态
    if (task.status !== 'ongoing') {
      wx.showToast({
        title: '任务已结束，无法发送消息',
        icon: 'none'
      })
      return
    }

    const content = inputValue.trim()

    // 清空输入框
    this.setData({ inputValue: '' })

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-chat',
        data: {
          action: 'sendMessage',
          needId: task._id,
          type: 'text',
          content
        }
      })

      if (result.code !== 0) {
        throw new Error(result.message)
      }

      // 发送成功，消息会通过监听自动添加
    } catch (err) {
      console.error('发送消息失败:', err)
      wx.showToast({
        title: '发送失败',
        icon: 'none'
      })
      // 恢复输入内容
      this.setData({ inputValue: content })
    }
  },

  // 选择图片
  chooseImage(e) {
    const source = e.currentTarget.dataset.source

    // 检查任务状态
    if (this.data.task.status !== 'ongoing') {
      wx.showToast({
        title: '任务已结束，无法发送图片',
        icon: 'none'
      })
      return
    }

    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: [source],
      success: (res) => {
        this.uploadImage(res.tempFilePaths[0])
      }
    })
  },

  // 上传图片
  async uploadImage(filePath) {
    wx.showLoading({ title: '发送中...' })

    try {
      // 上传到云存储
      const cloudPath = `chat-images/${Date.now()}-${Math.random().toString(36).substr(2, 6)}.jpg`
      const uploadResult = await wx.cloud.uploadFile({
        cloudPath,
        filePath
      })

      // 发送图片消息
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-chat',
        data: {
          action: 'sendMessage',
          needId: this.data.task._id,
          type: 'image',
          imageUrl: uploadResult.fileID
        }
      })

      if (result.code !== 0) {
        throw new Error(result.message)
      }

      wx.hideLoading()
    } catch (err) {
      wx.hideLoading()
      console.error('发送图片失败:', err)
      wx.showToast({
        title: '发送失败',
        icon: 'none'
      })
    }
  },

  // 预览图片
  previewImage(e) {
    const url = e.currentTarget.dataset.url
    const imageUrls = this.data.messages
      .filter(msg => msg.type === 'image')
      .map(msg => msg.imageUrl)

    wx.previewImage({
      current: url,
      urls: imageUrls
    })
  },

  // 输入框变化
  onInput(e) {
    this.setData({
      inputValue: e.detail.value
    })
  },

  // 滚动到底部
  scrollToBottom() {
    this.setData({
      lastMessageId: 'bottom-anchor'
    })
  },

  // 显示完成任务确认
  showCompleteConfirm() {
    this.setData({ showCompleteModal: true })
  },

  // 隐藏完成任务确认
  hideCompleteModal() {
    this.setData({ showCompleteModal: false })
  },

  // 完成任务
  async completeTask() {
    this.hideCompleteModal()

    wx.showLoading({ title: '处理中...' })

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-settlement',
        data: {
          action: 'completeTask',
          needId: this.data.task._id
        }
      })

      wx.hideLoading()

      if (result.code === 0) {
        wx.showToast({
          title: '任务已完成',
          icon: 'success'
        })

        // 更新任务状态
        this.setData({
          'task.status': 'completed',
          'task.statusText': '已完成'
        })

        this.stopCountdown()

        // 跳转到评价页面
        setTimeout(() => {
          wx.navigateTo({
            url: `/pages/rating/rating?needId=${this.data.task._id}`
          })
        }, 1500)
      } else {
        throw new Error(result.message)
      }
    } catch (err) {
      wx.hideLoading()
      wx.showToast({
        title: err.message || '操作失败',
        icon: 'none'
      })
    }
  },

  // 启动倒计时
  startCountdown() {
    this.updateCountdown()
    const timer = setInterval(() => {
      this.updateCountdown()
    }, 1000)
    this.setData({ countdownTimer: timer })
  },

  // 停止倒计时
  stopCountdown() {
    if (this.data.countdownTimer) {
      clearInterval(this.data.countdownTimer)
      this.setData({ countdownTimer: null })
    }
  },

  // 更新倒计时显示
  updateCountdown() {
    const expireTime = this.data.task.expireTime
    if (!expireTime) return

    const now = new Date().getTime()
    const expire = new Date(expireTime).getTime()
    const diff = expire - now

    if (diff <= 0) {
      this.setData({ countdownText: '已过期' })
      this.stopCountdown()
      // 刷新任务状态
      this.loadTaskInfo()
      return
    }

    const hours = Math.floor(diff / (1000 * 60 * 60))
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
    const seconds = Math.floor((diff % (1000 * 60)) / 1000)

    let text = ''
    if (hours > 0) {
      text = `${hours}时${minutes}分`
    } else if (minutes > 0) {
      text = `${minutes}分${seconds}秒`
    } else {
      text = `${seconds}秒`
    }

    this.setData({ countdownText: text })
  },

  // 辅助函数：是否为同一天
  isSameDay(date1, date2) {
    return date1.getFullYear() === date2.getFullYear() &&
           date1.getMonth() === date2.getMonth() &&
           date1.getDate() === date2.getDate()
  },

  // 辅助函数：是否为昨天
  isYesterday(date1, date2) {
    const yesterday = new Date(date1)
    yesterday.setDate(yesterday.getDate() - 1)
    return this.isSameDay(yesterday, date2)
  },

  // 辅助函数：格式化日期
  formatDate(date) {
    return `${date.getMonth() + 1}月${date.getDate()}日`
  },

  // 辅助函数：格式化时间
  formatTime(date) {
    const hours = date.getHours().toString().padStart(2, '0')
    const minutes = date.getMinutes().toString().padStart(2, '0')
    return `${hours}:${minutes}`
  }
})
