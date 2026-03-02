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

    // 弹窗
    showCompleteModal: false,

    // 任务卡片收起状态
    isTaskCardCollapsed: false,

    // 监听
    watchListener: null,

    // 轮询备用（当watch不工作时使用）
    messagePollingInterval: null,
    lastWatchActivity: null
  },

  onLoad(options) {
    // 获取页面参数
    const { needId, isSeeker } = options

    this.setData({
      'task._id': needId,
      isSeeker: isSeeker === 'true',
      userInfo: app.globalData.userInfo
    })

    // 串行加载，避免同时发起多个云函数调用
    this.loadTaskInfo().then(() => {
      // 任务信息加载完成后再加载消息
      return this.loadMessages()
    }).then(() => {
      // 历史消息加载完成后，开始监听新消息
      this.startMessageWatch().catch(err => {
        console.error('启动消息监听失败:', err)
        // 监听失败时切换到轮询
        this.startMessagePolling()
      })
    })
  },

  onShow() {
    // 页面显示时确保监听或轮询已启动
    const hasActiveListener = this.data.watchListener || this.data.messagePollingInterval
    if (this.data.task._id && !hasActiveListener) {
      console.log('页面显示，启动消息监听')
      this.startMessageWatch().catch(err => {
        console.error('启动消息监听失败:', err)
        this.startMessagePolling()
      })
    }
  },

  onHide() {
    // 页面隐藏时停止轮询以节省资源，但保持watch监听（如果有的话）
    console.log('页面隐藏，停止轮询')
    this.stopMessagePolling()
  },

  onUnload() {
    // 页面卸载时清理
    this.stopMessageWatch()
    this.stopMessagePolling()
  },

  // 启动消息轮询（watch不可用时的备用方案）
  startMessagePolling() {
    if (this.data.messagePollingInterval) {
      console.log('轮询已存在，跳过')
      return
    }

    console.log('启动消息轮询（watch备用方案）')

    const poll = () => {
      this.pollNewMessages()
    }

    // 立即执行一次
    poll()

    // 每3秒轮询一次
    const interval = setInterval(poll, 3000)
    this.setData({ messagePollingInterval: interval })
  },

  // 停止消息轮询
  stopMessagePolling() {
    if (this.data.messagePollingInterval) {
      clearInterval(this.data.messagePollingInterval)
      this.setData({ messagePollingInterval: null })
      console.log('消息轮询已停止')
    }
  },

  // 轮询获取新消息
  async pollNewMessages() {
    const { task, messages } = this.data
    if (!task._id) return

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-chat',
        data: {
          action: 'getMessages',
          needId: task._id,
          limit: 50
        }
      })

      if (result.code === 0) {
        const serverMessages = result.data.list

        // 找出本地没有的新消息
        const existingIds = new Set(messages.map(m => m._id))
        const newServerMessages = serverMessages.filter(m => !existingIds.has(m._id))

        if (newServerMessages.length > 0) {
          console.log('轮询发现', newServerMessages.length, '条新消息')

          // 格式化新消息
          const lastExistingMsg = messages[messages.length - 1]
          const formattedNewMessages = newServerMessages.map((msg, index) => {
            const prevMsg = index === 0 ? lastExistingMsg : newServerMessages[index - 1]
            return this.formatMessage(msg, prevMsg)
          })

          this.setData({
            messages: [...messages, ...formattedNewMessages],
            lastMessageId: 'bottom-anchor'
          })
        }
      }
    } catch (err) {
      console.error('轮询消息失败:', err)
    }
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
            expireTime: taskData.expire_time,
            location: taskData.location,
            images: taskData.images || []
          },
          otherUser: result.data.otherUser
        })

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
        // 格式化消息，传入上一条消息用于时间显示判断
        const rawList = result.data.list
        const newMessages = rawList.map((msg, index) => {
          const prevMsg = index > 0 ? rawList[index - 1] : null
          return this.formatMessage(msg, prevMsg)
        })

        // 更新已处理消息ID集合
        if (!this.processedMessageIds) {
          this.processedMessageIds = new Set()
        }
        newMessages.forEach(msg => this.processedMessageIds.add(msg._id))

        if (isLoadMore) {
          // 加载更多时，需要重新计算合并后所有消息的 showTime
          const mergedMessages = [...newMessages, ...messages]
          const recalculatedMessages = mergedMessages.map((msg, index) => {
            if (index === 0) return { ...msg, showTime: true }
            const prevMsg = mergedMessages[index - 1]
            const currTime = new Date(msg.create_time).getTime()
            const prevTime = new Date(prevMsg.create_time).getTime()
            const diffMinutes = (currTime - prevTime) / (1000 * 60)
            return { ...msg, showTime: diffMinutes > 2 }
          })
          this.setData({
            messages: recalculatedMessages,
            hasMoreMessages: newMessages.length >= pageSize
          })
        } else {
          this.setData({
            messages: newMessages,
            hasMoreMessages: newMessages.length >= pageSize,
            lastMessageId: 'bottom-anchor'
          })
        }
      }
      return result
    } catch (err) {
      console.error('加载消息失败:', err)
      return { code: -1, message: err.message }
    }
  },

  // 加载更多消息
  loadMoreMessages() {
    this.loadMessages(true)
  },

  // 格式化消息
  // prevMsg: 上一条消息，用于判断是否显示时间分割线（间隔超过2分钟显示）
  formatMessage(msg, prevMsg = null) {
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

    // 判断是否显示时间分割线
    // 1. 第一条消息显示时间
    // 2. 与上一条消息间隔超过2分钟显示时间
    let showTime = true
    if (prevMsg && prevMsg.create_time) {
      const prevTime = new Date(prevMsg.create_time).getTime()
      const currTime = msgTime.getTime()
      const diffMinutes = (currTime - prevTime) / (1000 * 60)
      showTime = diffMinutes > 2
    }

    return {
      ...msg,
      isSelf,
      senderAvatar: isSelf ? userInfo.avatar : (this.data.otherUser && this.data.otherUser.avatar) || '/images/default-avatar.png',
      timeText,
      showTime,
      // 统一图片字段为 camelCase（优先使用已有的 imageUrl，否则从 image_url 转换）
      imageUrl: msg.imageUrl || msg.image_url || ''
    }
  },

  // 开始监听新消息
  async startMessageWatch() {
    if (this.data.watchListener) {
      console.log('监听已存在，跳过')
      return
    }

    const needId = this.data.task._id
    if (!needId) {
      console.error('启动监听失败: needId 为空')
      return
    }

    const db = wx.cloud.database()

    // 初始化已处理消息ID集合（防止监听回调重复添加自己发的消息）
    if (!this.processedMessageIds) {
      this.processedMessageIds = new Set(this.data.messages.map(m => m._id))
    }

    console.log('启动消息监听, needId:', needId, '类型:', typeof needId)
    console.log('监听条件: need_id =', String(needId))
    console.log('当前已加载消息数:', this.data.messages.length)
    console.log('已处理消息IDs:', Array.from(this.processedMessageIds))

    // 诊断查询：先验证 where 条件能否正确匹配数据
    let diagnosticMatchCount = 0
    try {
      const diagnosticRes = await db.collection('wdd-messages')
        .where({ need_id: String(needId) })
        .limit(5)
        .get()
      diagnosticMatchCount = diagnosticRes.data.length
      console.log('诊断查询结果：匹配到', diagnosticMatchCount, '条记录')
      if (diagnosticMatchCount > 0) {
        console.log('样例记录 need_id:', diagnosticRes.data[0].need_id, '类型:', typeof diagnosticRes.data[0].need_id)
      }
    } catch (diagErr) {
      console.error('诊断查询失败:', diagErr)
    }

    try {
      const listener = db.collection('wdd-messages')
        .where({
          need_id: String(needId)
        })
        .watch({
          onChange: (snapshot) => {
            console.log('=== 收到监听回调 ===')
            console.log('快照类型:', snapshot.type)
            console.log('变化文档数:', snapshot.docChanges ? snapshot.docChanges.length : 0)
            console.log('当前文档数:', snapshot.docs ? snapshot.docs.length : 0)

            if (snapshot.type === 'init') {
              const matchCount = snapshot.docs ? snapshot.docs.length : 0
              console.log('监听初始化完成，当前匹配文档数:', matchCount)

              // 记录watch活动时间
              this.setData({ lastWatchActivity: Date.now() })

              // 如果诊断查询有结果但watch init没有匹配到，可能where条件有问题
              if (diagnosticMatchCount > 0 && matchCount === 0) {
                console.warn('警告：诊断查询有', diagnosticMatchCount, '条记录，但watch init匹配到0条')
                console.warn('可能是数据库权限或where条件问题，建议切换到轮询方案')
              }

              // 打印前几个文档的 need_id 用于调试
              if (snapshot.docs && snapshot.docs.length > 0) {
                console.log('样例文档 need_id:', snapshot.docs[0].need_id, '类型:', typeof snapshot.docs[0].need_id)
              }
              return
            }

            // 记录watch活动时间
            this.setData({ lastWatchActivity: Date.now() })

            // 只处理新增类型的变更
            if (!snapshot.docChanges || snapshot.docChanges.length === 0) {
              console.log('没有文档变化')
              return
            }

            const userInfo = this.data.userInfo
            const currentMessages = this.data.messages
            let messagesToUpdate = null
            const newDocs = []

            for (const change of snapshot.docChanges) {
              console.log('处理变化:', change.dataType, 'doc._id:', change.doc._id)
              if (change.dataType !== 'add') {
                console.log('  跳过非新增类型')
                continue
              }
              const doc = change.doc

              // 跳过已处理的消息（通过真实ID）
              if (this.processedMessageIds.has(doc._id)) {
                console.log('  跳过已处理消息:', doc._id)
                continue
              }

              // 检查是否是自己刚发的消息的确认
              if (doc.sender_id === userInfo._id) {
                console.log('  处理自己发送的消息确认:', doc._id)
                this.processedMessageIds.add(doc._id)
                // 找到对应的临时消息，清除 isLocalImage 标记
                const tempIndex = currentMessages.findIndex(m =>
                  m._id.startsWith('temp_') &&
                  m.type === doc.type &&
                  (doc.type === 'text' ? m.content === doc.content : m.isLocalImage)
                )
                if (tempIndex !== -1) {
                  // 创建新数组，只修改对应项的 isLocalImage
                  messagesToUpdate = [...currentMessages]
                  messagesToUpdate[tempIndex] = { ...messagesToUpdate[tempIndex], isLocalImage: false }
                }
                continue
              }

              // 真正的新消息（别人发的）
              console.log('  添加新消息（来自对方）:', doc._id)
              this.processedMessageIds.add(doc._id)
              newDocs.push(doc)
            }

            // 合并更新：如果有自己消息确认，使用更新后的数组；如果有新消息，追加到末尾
            if (messagesToUpdate || newDocs.length > 0) {
              console.log('准备更新界面, 自己消息确认:', !!messagesToUpdate, '新消息数:', newDocs.length)
              let finalMessages = messagesToUpdate || currentMessages
              if (newDocs.length > 0) {
                // 格式化新消息，传入最后一条现有消息用于时间判断
                const lastExistingMsg = finalMessages[finalMessages.length - 1]
                const formattedNewDocs = newDocs.map((doc, index) => {
                  const prevMsg = index === 0 ? lastExistingMsg : newDocs[index - 1]
                  return this.formatMessage(doc, prevMsg)
                })
                finalMessages = [...finalMessages, ...formattedNewDocs]
              }
              this.setData({
                messages: finalMessages,
                lastMessageId: newDocs.length > 0 ? 'bottom-anchor' : this.data.lastMessageId
              })
            } else {
              console.log('没有需要更新的消息')
            }
          },
          onError: (err) => {
            console.error('消息监听失败:', err)
            this.setData({ watchListener: null })
          }
        })

      this.setData({
        watchListener: listener,
        lastWatchActivity: Date.now()
      })
      console.log('消息监听启动成功')

      // 设置自动降级检测：10秒后检查是否有watch活动
      setTimeout(() => {
        const lastActivity = this.data.lastWatchActivity
        const now = Date.now()
        // 如果10秒内没有watch活动（包括init事件），且页面还开着，切换到轮询
        if (lastActivity && (now - lastActivity > 9000) && !this.data.messagePollingInterval) {
          console.log('watch 10秒内无活动，自动切换到轮询方案')
          this.stopMessageWatch()
          this.startMessagePolling()
        }
      }, 10000)

    } catch (err) {
      console.error('启动监听异常:', err)
      // 启动失败时切换到轮询
      this.startMessagePolling()
    }
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
    const { inputValue, task, userInfo } = this.data
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

    // 立即显示消息（乐观更新）
    const now = new Date()
    const currentMessages = this.data.messages
    const lastMsg = currentMessages.length > 0 ? currentMessages[currentMessages.length - 1] : null
    const showTime = !lastMsg || (now.getTime() - new Date(lastMsg.create_time).getTime()) / (1000 * 60) > 2

    const tempMessage = {
      _id: 'temp_' + Date.now(),
      need_id: task._id,
      sender_id: userInfo._id,
      type: 'text',
      content: content,
      create_time: now.toISOString(),
      isSelf: true,
      senderAvatar: userInfo.avatar,
      timeText: this.formatTime(now),
      showTime: showTime
    }

    // 合并输入框清空和消息添加，减少 setData 次数
    const newMessages = [...currentMessages, tempMessage]
    this.setData({
      inputValue: '',
      messages: newMessages,
      lastMessageId: 'bottom-anchor'
    })

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

      // 发送成功，监听回调会自动添加消息到列表
      console.log('消息发送成功，等待监听回调:', result.data.messageId)

    } catch (err) {
      console.error('发送消息失败:', err)

      wx.showToast({
        title: '发送失败',
        icon: 'none'
      })
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
    const { task, userInfo } = this.data

    // 立即显示本地图片（乐观更新）
    const now = new Date()
    const currentMessages = this.data.messages
    const lastMsg = currentMessages.length > 0 ? currentMessages[currentMessages.length - 1] : null
    const showTime = !lastMsg || (now.getTime() - new Date(lastMsg.create_time).getTime()) / (1000 * 60) > 2

    const tempMessage = {
      _id: 'temp_img_' + Date.now(),
      need_id: task._id,
      sender_id: userInfo._id,
      type: 'image',
      imageUrl: filePath,
      create_time: now.toISOString(),
      isSelf: true,
      senderAvatar: userInfo.avatar,
      timeText: this.formatTime(now),
      showTime: showTime,
      isLocalImage: true
    }

    // 合并消息添加和滚动，减少 setData 次数
    this.setData({
      messages: [...currentMessages, tempMessage],
      lastMessageId: 'bottom-anchor'
    })

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
          needId: task._id,
          type: 'image',
          imageUrl: uploadResult.fileID
        }
      })

      if (result.code !== 0) {
        throw new Error(result.message)
      }

      console.log('图片发送成功，等待监听回调:', result.data.messageId)

    } catch (err) {
      console.error('发送图片失败:', err)
      wx.showToast({ title: '发送失败', icon: 'none' })
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

  // 预览任务图片
  previewTaskImages(e) {
    const { index } = e.currentTarget.dataset
    const { images } = this.data.task
    wx.previewImage({
      current: images[index],
      urls: images
    })
  },

  // 输入框变化
  onInput(e) {
    this.setData({
      inputValue: e.detail.value
    })
  },

  // 滚动到底部 - 使用标志位避免频繁设置
  scrollToBottom() {
    // 如果已经设置过，先清空再设置，确保能触发滚动
    if (this.data.lastMessageId === 'bottom-anchor') {
      this.setData({ lastMessageId: '' }, () => {
        wx.nextTick(() => {
          this.setData({ lastMessageId: 'bottom-anchor' })
        })
      })
    } else {
      this.setData({ lastMessageId: 'bottom-anchor' })
    }
  },

  // 显示完成任务确认
  showCompleteConfirm() {
    this.setData({ showCompleteModal: true })
  },

  // 隐藏完成任务确认
  hideCompleteModal() {
    this.setData({ showCompleteModal: false })
  },

  // 切换任务卡片收起/展开状态
  toggleTaskCard() {
    this.setData({
      isTaskCardCollapsed: !this.data.isTaskCardCollapsed
    })
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

        // 设置刷新标记
        wx.setStorageSync('refreshMyNeeds', true)
        wx.setStorageSync('refreshMyTasks', true)

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

  // 打开地图查看位置
  openLocation() {
    const location = this.data.task.location
    if (!location || !location.latitude || !location.longitude) {
      wx.showToast({
        title: '位置信息不完整',
        icon: 'none'
      })
      return
    }

    wx.openLocation({
      latitude: location.latitude,
      longitude: location.longitude,
      name: location.name || '任务地点',
      address: location.name || ''
    })
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
  // 辅助函数：格式化时间
  formatTime(date) {
    const hours = date.getHours().toString().padStart(2, '0')
    const minutes = date.getMinutes().toString().padStart(2, '0')
    return `${hours}:${minutes}`
  },

  // 辅助函数：格式化日期
  formatDate(date) {
    return `${date.getMonth() + 1}月${date.getDate()}日`
  }
})
