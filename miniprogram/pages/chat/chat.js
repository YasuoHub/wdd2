// 聊天页面逻辑
const app = getApp()
const { requirePrivacyAuthorize } = require('../../utils/privacy')
const DateUtil = require('../../utils/dateUtil')
const chatCache = require('../../utils/chatCache')

Page({
  data: {
    // 任务信息
    task: {
      _id: '',
      type: '',
      typeName: '',
      typeIcon: '',
      description: '',
      rewardAmount: 0,
      status: 'ongoing',
      statusText: '进行中',
      expireTime: null
    },

    // 用户信息
    userInfo: null,
    isSeeker: false,
    otherUser: null,
    showReportBtn: false,

    // 消息相关
    messages: [],
    inputValue: '',
    inputFocus: false,  // 初始不自动聚焦，避免进入页面自动打开输入法
    lastMessageId: '',
    hasMoreMessages: true,  // 默认允许下拉刷新，首次加载后根据实际结果更新
    pageSize: 20,

    // 滚动状态
    isAtBottom: true,      // 当前是否在底部
    newMessageCount: 0,     // 未滚动到底部的新消息数
    scrollTop: 0,          // 记录滚动位置
    scrollViewHeight: 0,   // scroll-view 高度

    // 弹窗
    showCompleteModal: false,

    // 任务卡片更多菜单
    showTaskMenu: false,

    // 工具栏展开状态
    isToolbarExpanded: false,

    // 下拉刷新状态
    isRefreshing: false,

    // 监听
    watchListener: null,

    // 轮询备用（当watch不工作时使用）
    messagePollingInterval: null,
    lastWatchActivity: null,

    // 客服查看模式
    isCustomerServiceMode: false,

    // 首屏加载状态（用于骨架屏显示）
    loading: true
  },

  onLoad(options) {
    // 获取页面参数
    const { needId, from } = options

    // 关键：立即保存当前页面任务ID到实例变量，确保后续所有操作使用正确的ID
    this.currentNeedId = needId

    // 判断是否客服查看模式（从工单页面进入）
    const isCustomerServiceMode = from === 'ticket'

    // 先尝试读本地缓存：命中则立即渲染，跳过骨架屏
    // 客服查看模式不复用缓存（避免越权状态泄露）
    let cached = null
    if (!isCustomerServiceMode) {
      cached = chatCache.readCache(needId)
    }

    const initialData = {
      userInfo: app.globalData.userInfo,
      messages: [], // 清空消息列表
      inputValue: '',
      lastMessageId: '',
      isCustomerServiceMode,
      loading: true
    }
    // 缓存里更早的消息（loadMessages 首次只拉最新 20 条，
    // 网络数据回来后需要把这部分老历史 merge 回来,避免列表跳变变短）
    let cachedOlderSnapshot = null
    if (cached && cached.taskMeta && cached.taskMeta.task) {
      // 缓存命中：先渲染缓存的任务信息和消息，骨架屏直接关闭
      // 强制 task._id = needId,防御缓存数据与路由参数不一致
      initialData.task = { ...cached.taskMeta.task, _id: needId }
      initialData.isSeeker = !!cached.taskMeta.isSeeker
      initialData.otherUser = cached.taskMeta.otherUser || null
      initialData.showReportBtn = !!cached.taskMeta.showReportBtn
      initialData.messages = Array.isArray(cached.messages) ? cached.messages : []
      initialData.loading = false
      // 缓存数据进入后,首屏直接落到底部
      initialData.lastMessageId = 'bottom-anchor'
      cachedOlderSnapshot = initialData.messages.slice()
    } else {
      // 缓存未命中:至少把 task._id 占位,避免 loadTaskInfo 前空数据
      initialData['task._id'] = needId
    }

    this.setData(initialData)

    // 重置已处理消息ID集合（带上缓存里的，防止 watch / 网络回调重复添加）
    this.processedMessageIds = new Set(initialData.messages.map(m => m._id).filter(Boolean))

    // 获取 scroll-view 高度
    this.getScrollViewHeight()

    // 并行加载任务信息和历史消息，DB RTT 减半
    Promise.all([this.loadTaskInfo(), this.loadMessages()]).then(([taskResult, msgResult]) => {
      // 关键校验：页面可能已经切换，检查任务ID是否一致
      if (this.currentNeedId !== needId) return
      // 任意一项失败则不再启动监听
      if (!taskResult || taskResult.code !== 0) return
      if (!msgResult || msgResult.code !== 0) return

      // 合并缓存中网络范围之外的老历史，防止 setData 覆盖导致列表变短
      if (cachedOlderSnapshot && cachedOlderSnapshot.length > 0) {
        const networkMessages = this.data.messages
        const networkIds = new Set(networkMessages.map(m => m._id).filter(Boolean))
        const olderFromCache = cachedOlderSnapshot.filter(m =>
          m._id && !String(m._id).startsWith('temp_') && !networkIds.has(m._id)
        )
        if (olderFromCache.length > 0) {
          // 按时间升序合并，重新格式化 showTime
          const combined = [...olderFromCache, ...networkMessages].sort(
            (a, b) => new Date(a.create_time) - new Date(b.create_time)
          )
          const reformatted = combined.map((msg, i) =>
            this.formatMessage(msg, i === 0 ? null : combined[i - 1])
          )
          // 把缓存里恢复回来的 _id 也加入已处理集合
          reformatted.forEach(m => {
            if (m._id) this.processedMessageIds.add(m._id)
          })
          this.setData({ messages: reformatted, lastMessageId: 'bottom-anchor' })
        }
      }

      // 网络数据返回后,写回本地缓存（仅非客服模式）
      if (!this.data.isCustomerServiceMode) {
        chatCache.writeCache(needId, this.data.messages, {
          task: this.data.task,
          isSeeker: this.data.isSeeker,
          otherUser: this.data.otherUser,
          showReportBtn: this.data.showReportBtn
        })
      }

      // 历史消息加载完成后，开始监听新消息
      this.startMessageWatch().catch(err => {
        console.error('启动消息监听失败:', err)
        this.startMessagePolling()
      })
    }).catch(err => {
      console.error('初始化聊天页面失败:', err)
    }).finally(() => {
      // 仅当还在 loading 状态时才隐藏,避免缓存命中后的冗余 setData
      if (this.currentNeedId === needId && this.data.loading) {
        this.setData({ loading: false })
      }
    })
  },

  onShow() {
    // 页面显示时确保监听或轮询已启动
    const hasActiveListener = this.data.watchListener || this.data.messagePollingInterval
    // 使用 currentNeedId 而不是 task._id，确保状态一致性
    if (this.currentNeedId && !hasActiveListener) {
      this.startMessageWatch().catch(err => {
        console.error('启动消息监听失败:', err)
        this.startMessagePolling()
      })
    }
    // 只有在底部时才标记已读
    if (this.data.isAtBottom) {
      this.markMessagesRead()
    }
  },


  onHide() {
    // 页面隐藏时停止轮询以节省资源，但保持watch监听（如果有的话）
    this.stopMessagePolling()
  },

  onUnload() {
    // 页面卸载时清理所有监听和状态
    this.stopMessageWatch()
    this.stopMessagePolling()
    // 清空当前任务ID标记
    this.currentNeedId = null
    // 清空消息数据，防止页面返回后显示错误数据
    this.setData({
      messages: [],
      task: {
        _id: '',
        type: '',
        typeName: '',
        typeIcon: '',
        description: '',
        rewardAmount: 0,
        status: 'ongoing',
        statusText: '进行中',
        expireTime: null
      }
    })
  },

  // 启动消息轮询（watch不可用时的备用方案）
  startMessagePolling() {
    if (this.data.messagePollingInterval) return

    const poll = () => this.pollNewMessages()

    // 立即执行一次
    poll()

    // 每5秒轮询一次（降低频率减少服务器压力）
    const interval = setInterval(poll, 5000)
    this.setData({ messagePollingInterval: interval })
  },

  // 停止消息轮询
  stopMessagePolling() {
    if (this.data.messagePollingInterval) {
      clearInterval(this.data.messagePollingInterval)
      this.setData({ messagePollingInterval: null })
    }
  },

  // 轮询获取新消息
  // 只获取比当前最新消息更新的消息，避免重复加载历史消息
  async pollNewMessages() {
    const { messages } = this.data

    // 关键：使用 currentNeedId 确保获取正确的任务消息
    const currentNeedId = this.currentNeedId
    if (!currentNeedId) return

    // 如果消息列表为空（初始化未完成），跳过轮询
    if (messages.length === 0) return

    // 如果正在处理中，跳过本次轮询
    if (this._isPolling) return
    this._isPolling = true

    try {
      // 计算 afterTime：取最后一条消息的时间
      const afterTime = messages[messages.length - 1].create_time

      const { result } = await wx.cloud.callFunction({
        name: 'wdd-chat',
        data: {
          action: 'getMessages',
          needId: currentNeedId,
          limit: 50,
          afterTime: afterTime
        }
      })

      // 关键校验：请求返回后检查页面是否已切换
      if (this.currentNeedId !== currentNeedId) return

      if (result.code === 0 && result.data.list.length > 0) {
        // 确保 processedMessageIds 已初始化
        if (!this.processedMessageIds) {
          this.processedMessageIds = new Set(messages.map(m => m._id))
        }

        const userInfo = this.data.userInfo
        const newDocs = []
        let messagesToUpdate = null

        for (const msg of result.data.list) {
          // 1. 任务ID校验
          if (msg.need_id !== currentNeedId) continue
          // 2. 去重校验
          if (this.processedMessageIds.has(msg._id)) continue

          // 3. 如果是自己发的消息，尝试替换临时消息
          if (msg.sender_id === userInfo._id) {
            this.processedMessageIds.add(msg._id)
            const incomingClientMsgId = msg.client_msg_id || msg.clientMsgId || ''
            const tempIndex = messages.findIndex(m =>
              (
                incomingClientMsgId &&
                m.sendStatus === 'sending' &&
                m.clientMsgId === incomingClientMsgId
              ) || (
                m._id.startsWith('temp_') &&
                m.type === msg.type &&
                (msg.type === 'text' ? m.content === msg.content : m.isLocalImage)
              )
            )
            if (tempIndex !== -1) {
              // 找到临时消息，替换
              messagesToUpdate = messagesToUpdate || [...messages]
              messagesToUpdate[tempIndex] = {
                ...messagesToUpdate[tempIndex],
                _id: msg._id,
                isLocalImage: false,
                create_time: msg.create_time,
                sendStatus: 'sent'
              }
            } else {
              // 没找到临时消息，当作新消息处理
              newDocs.push(msg)
            }
            continue
          }

          // 4. 对方发的消息
          this.processedMessageIds.add(msg._id)
          newDocs.push(msg)
        }

        // 检查是否有系统消息
        const hasSystemMessage = newDocs.some(doc => doc.type === 'system')
        const normalNewDocsCount = newDocs.filter(doc => doc.type !== 'system').length

        // 合并更新
        if (messagesToUpdate || newDocs.length > 0) {
          let finalMessages = messagesToUpdate || messages
          if (newDocs.length > 0) {
            const lastExistingMsg = finalMessages[finalMessages.length - 1]
            const formattedNewDocs = []
            for (let i = 0; i < newDocs.length; i++) {
              const prevMsg = i === 0 ? lastExistingMsg : formattedNewDocs[i - 1]
              formattedNewDocs.push(this.formatMessage(newDocs[i], prevMsg))
            }
            finalMessages = [...finalMessages, ...formattedNewDocs]
          }

          // 写回本地缓存（与 watch 流程一致,防抖写入）
          if (!this.data.isCustomerServiceMode) {
            chatCache.scheduleWrite(currentNeedId, finalMessages, {
              task: this.data.task,
              isSeeker: this.data.isSeeker,
              otherUser: this.data.otherUser,
              showReportBtn: this.data.showReportBtn
            })
          }

          // 先更新消息，等渲染完成后再处理滚动和已读
          this.setData({
            messages: finalMessages
          }, () => {
            if (newDocs.length > 0) {
              wx.nextTick(() => {
                if (hasSystemMessage) {
                  // 系统消息：刷新任务状态 + 自动滚动到底部 + 标记已读
                  this.loadTaskInfo()
                  this.setData({
                    lastMessageId: 'bottom-anchor',
                    newMessageCount: 0
                  })
                  this.markMessagesRead()
                } else if (this.data.isAtBottom) {
                  // 在底部：滚动到底部 + 标记已读
                  this.setData({ lastMessageId: 'bottom-anchor' })
                  this.markMessagesRead()
                } else {
                  // 不在底部：显示按钮 + 不标记已读
                  this.setData({
                    newMessageCount: this.data.newMessageCount + normalNewDocsCount
                  })
                }
              })
            }
          })
        }
      }
    } catch (err) {
      console.error('轮询消息失败:', err)
    } finally {
      this._isPolling = false
    }
  },

  // 标记当前会话消息为已读
  async markMessagesRead() {
    const currentNeedId = this.currentNeedId
    if (!currentNeedId) return

    try {
      await wx.cloud.callFunction({
        name: 'wdd-notify',
        data: {
          action: 'markAsRead',
          notificationId: currentNeedId,
          type: 'chat'
        }
      })
      console.log('消息已标记为已读')
    } catch (err) {
      console.error('标记已读失败:', err)
    }
  },

  // 获取 scroll-view 高度
  getScrollViewHeight() {
    const query = wx.createSelectorQuery()
    query.select('.message-list').boundingClientRect(rect => {
      if (rect && rect.height) {
        this.setData({ scrollViewHeight: rect.height })
      }
    }).exec()
  },

  // 监听滚动事件，判断是否在底部
  onScroll(e) {
    const { scrollTop, scrollHeight } = e.detail
    const clientHeight = this.data.scrollViewHeight || 0
    const isAtBottom = clientHeight > 0 && (scrollHeight - scrollTop - clientHeight < 50)
    
    if (isAtBottom !== this.data.isAtBottom) {
      this.setData({ isAtBottom })
      if (isAtBottom && newMessageCount > 0) {
        // 滚动到底部：标记已读 + 清零计数
        this.markMessagesRead()
        this.setData({ newMessageCount: 0 })
      }
    }
  },

  // 点击未读消息按钮滚动到底部
  scrollToBottomAndClear() {
    this.setData({
      isAtBottom: true,
      newMessageCount: 0,
      lastMessageId: 'bottom-anchor'
    }, () => {
      // 滚动到底部后标记已读
      this.markMessagesRead()
    })
  },

  // 加载任务信息
  async loadTaskInfo() {
    try {
      // 关键：使用 currentNeedId 确保请求正确的任务
      const needId = this.currentNeedId || this.data.task._id
      if (!needId) {
        console.error('加载任务信息失败: 任务ID为空')
        return { code: -1, message: '任务ID为空' }
      }

      const { result } = await wx.cloud.callFunction({
        name: 'wdd-chat',
        data: {
          action: 'getTaskInfo',
          needId: needId
        }
      })

      // 关键校验：请求返回后检查页面是否已切换
      if (this.currentNeedId !== needId) {
        return { code: -1, message: '页面已切换' }
      }

      if (result.code === 0) {
        const taskData = result.data
        const statusMap = {
          'pending': { text: '待匹配', class: '' },
          'ongoing': { text: '进行中', class: 'ongoing' },
          'completed': { text: '已完成', class: 'completed' },
          'cancelled': { text: '已取消', class: 'cancelled' },
          'breaking': { text: '审核中', class: 'breaking' }
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

        const isCustomerServiceMode = this.data.isCustomerServiceMode

        this.setData({
          task: {
            _id: taskData._id,
            type: taskData.type,
            typeName: typeInfo.name,
            typeIcon: typeInfo.icon,
            description: taskData.description,
            rewardAmount: taskData.reward_amount || taskData.rewardAmount || 0,
            status: taskData.status,
            statusText: statusInfo.text,
            expireTime: taskData.expire_time,
            location: {
              latitude: taskData.location.coordinates[1],
              longitude: taskData.location.coordinates[0],
              name: taskData.location_name
            },
            locationName: taskData.location_name,
            images: taskData.images || []
          },
          isSeeker: !isCustomerServiceMode && result.data.role === 'seeker',
          otherUser: isCustomerServiceMode ? null : result.data.otherUser,
          showReportBtn: !isCustomerServiceMode && result.data.status === 'ongoing' &&
            !result.data.myReportStatus.hasReport &&
            (new Date() <= new Date(new Date(result.data.expire_time).getTime() + 2 * 60 * 60 * 1000))
        })

        // 设置导航栏标题
        if (isCustomerServiceMode) {
          wx.setNavigationBarTitle({ title: '查看聊天记录' })
        } else if (result.data.otherUser && result.data.otherUser.nickname) {
          wx.setNavigationBarTitle({
            title: result.data.otherUser.nickname
          })
        }

        return result
      }
      // 请求失败也返回 result，让上层处理
      return result
    } catch (err) {
      console.error('加载任务信息失败:', err)
      wx.showToast({
        title: '加载失败',
        icon: 'none'
      })
      return { code: -1, message: err.message }
    }
  },

  // 加载历史消息
  // isLoadMore: 是否加载更多（旧消息）
  // shouldScrollToBottom: 是否滚动到底部（加载历史记录时为 false，避免跳屏）
  async loadMessages(isLoadMore = false, shouldScrollToBottom = true) {
    try {
      const { task, pageSize, messages } = this.data

      // 关键：使用 currentNeedId 确保加载正确的任务消息
      const currentNeedId = this.currentNeedId || (task && task._id)

      // 校验：确保有有效的任务ID
      if (!currentNeedId) {
        console.error('加载消息失败: 任务ID无效')
        return { code: -1, message: '任务ID无效' }
      }

      const { result } = await wx.cloud.callFunction({
        name: 'wdd-chat',
        data: {
          action: 'getMessages',
          needId: currentNeedId,
          limit: pageSize,
          beforeTime: isLoadMore && messages.length > 0
            ? messages[0].create_time
            : null
        }
      })

      // 关键校验：请求返回后检查页面是否已切换
      if (this.currentNeedId !== currentNeedId) {
        return { code: -1, message: '页面已切换' }
      }

      if (result.code === 0) {
        const rawList = result.data.list

        // 初始化已处理消息ID集合
        if (!this.processedMessageIds) {
          this.processedMessageIds = new Set()
        }

        // 单次遍历：任务ID过滤 + 去重 + 格式化
        const existingIds = isLoadMore ? new Set(messages.map(m => m._id)) : null
        const newMessages = []
        let lastValidMsg = null  // 记录上一条通过验证的消息

        for (let i = 0; i < rawList.length; i++) {
          const msg = rawList[i]
          // 1. 任务ID过滤
          if (msg.need_id !== currentNeedId) continue
          // 2. 去重（加载更多时需要）
          if (isLoadMore && existingIds.has(msg._id)) continue
          // 3. 格式化（prevMsg 是上一条通过验证的消息）
          newMessages.push(this.formatMessage(msg, lastValidMsg))
          lastValidMsg = msg  // 更新上一条有效消息
        }

        // 更新已处理消息ID集合
        newMessages.forEach(msg => this.processedMessageIds.add(msg._id))

        if (isLoadMore) {
          // 加载更多：合并新消息（历史）和现有消息
          // 注意：newMessages 是更早的消息，应该放在前面
          let mergedMessages = [...newMessages, ...messages]

          // 检查衔接处的时间差（最后一条新消息 和 第一条现有消息）
          if (newMessages.length > 0 && messages.length > 0) {
            const lastNewMsg = newMessages[newMessages.length - 1]
            const firstOldMsg = messages[0]
            const timeDiff = (new Date(firstOldMsg.create_time) - new Date(lastNewMsg.create_time)) / (1000 * 60)

            if (timeDiff > 2) {
              // 时间差超过2分钟，需要显示时间分割线
              // 创建新数组，更新衔接处的 showTime
              mergedMessages = mergedMessages.map((msg, index) => {
                if (index === newMessages.length) {
                  // 这是第一条旧消息的位置
                  return { ...msg, showTime: true }
                }
                return msg
              })
            }
          }

          this.setData({
            messages: mergedMessages,
            hasMoreMessages: newMessages.length >= pageSize
          })
        } else {
          this.setData({
            messages: newMessages,
            hasMoreMessages: newMessages.length >= pageSize,
            lastMessageId: shouldScrollToBottom ? 'bottom-anchor' : ''
          })
        }
      }
      return result
    } catch (err) {
      console.error('加载消息失败:', err)
      return { code: -1, message: err.message }
    }
  },

  // 下拉刷新 - 加载历史消息
  async onRefresh() {
    this.setData({ isRefreshing: true })
    const result = await this.loadMessages(true, false) // 加载更多，不滚动到底部
    if (!result || result.code !== 0) {
      wx.showToast({
        title: result?.message || '加载失败',
        icon: 'none'
      })
    } else if (!result.data?.list || result.data.list.length === 0) {
      // 没有更多消息了
      this.setData({ hasMoreMessages: false })
      wx.showToast({
        title: '没有更多消息了',
        icon: 'none'
      })
    }
    this.setData({ isRefreshing: false })
  },

  // 刷新完成恢复
  onRestore() {
    this.setData({ isRefreshing: false })
  },

  // 格式化消息
  // prevMsg: 上一条消息，用于判断是否显示时间分割线（间隔超过2分钟显示）
  formatMessage(msg, prevMsg = null) {
    const userInfo = this.data.userInfo
    const isSelf = msg.sender_id === userInfo._id

    // 系统消息按当前用户身份渲染不同文案（求助者看"对方的"，帮助者看"您的"）
    let displayContent = msg.content
    if (msg.type === 'system' && msg.system_type === 'task_completed' && typeof msg.amount === 'number') {
      displayContent = this.data.isSeeker
        ? `任务已完成，¥${msg.amount}已计入对方的平台余额`
        : `任务已完成，¥${msg.amount}已计入您的平台余额`
    }

    // 处理时间显示
    const now = new Date()
    const msgTime = new Date(msg.create_time)
    let timeText = ''

    if (DateUtil.isSameDay(now, msgTime)) {
      timeText = DateUtil.formatTime(msgTime)
    } else if (DateUtil.isYesterday(now, msgTime)) {
      timeText = '昨天 ' + DateUtil.formatTime(msgTime)
    } else {
      timeText = DateUtil.formatDate(msgTime) + ' ' + DateUtil.formatTime(msgTime)
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
      content: displayContent,
      clientMsgId: msg.clientMsgId || msg.client_msg_id || msg._id,
      sendStatus: msg.sendStatus || 'sent',
      isSelf,
      isSystem: msg.type === 'system',
      senderAvatar: isSelf ? userInfo.avatar : (this.data.otherUser && this.data.otherUser.avatar) || '/images/default-avatar.png',
      timeText,
      showTime,
      // 统一图片字段为 camelCase（优先使用已有的 imageUrl，否则从 image_url 转换）
      imageUrl: msg.imageUrl || msg.image_url || '',
      // 图片显示尺寸（后端预计算）
      imageWidth: msg.image_width || 0,
      imageHeight: msg.image_height || 0
    }
  },

  // 开始监听新消息
  async startMessageWatch() {
    // 防止重复启动：检查是否正在启动中或已存在
    if (this._isStartingWatch || this.data.watchListener) {
      return
    }
    this._isStartingWatch = true

    // 关键：使用 currentNeedId 确保监听正确的任务
    const needId = this.currentNeedId
    if (!needId) {
      this._isStartingWatch = false
      return
    }

    const db = wx.cloud.database()

    // 初始化已处理消息ID集合（防止监听回调重复添加自己发的消息）
    this.processedMessageIds = new Set(this.data.messages.map(m => m._id))

    try {
      const listener = db.collection('wdd-messages')
        .where({
          need_id: String(needId)
        })
        .watch({
          onChange: (snapshot) => {
            if (snapshot.type === 'init') {
              this.setData({ lastWatchActivity: Date.now() })
              return
            }

            // 记录watch活动时间
            this.setData({ lastWatchActivity: Date.now() })

            // 只处理新增类型的变更
            if (!snapshot.docChanges || snapshot.docChanges.length === 0) {
              return
            }

            // 关键校验：页面是否已切换
            const currentNeedId = this.currentNeedId
            if (!currentNeedId || currentNeedId !== needId) {
              return
            }

            const userInfo = this.data.userInfo
            const currentMessages = this.data.messages
            let messagesToUpdate = null
            const newDocs = []

            for (const change of snapshot.docChanges) {
              if (change.dataType !== 'add') continue

              const doc = change.doc

              // 关键校验：消息必须属于当前任务
              if (doc.need_id !== currentNeedId) continue

              // 跳过已处理的消息
              if (this.processedMessageIds.has(doc._id)) continue

              // 自己发送的消息：确认临时消息
              if (doc.sender_id === userInfo._id) {
                this.processedMessageIds.add(doc._id)
                const incomingClientMsgId = doc.client_msg_id || doc.clientMsgId || ''
                // 查找对应的临时消息（按时间倒序找最新的匹配项）
                const tempIndex = currentMessages.findIndex(m =>
                  (
                    incomingClientMsgId &&
                    m.sendStatus === 'sending' &&
                    m.clientMsgId === incomingClientMsgId
                  ) || (
                    m._id.startsWith('temp_') &&
                    m.type === doc.type &&
                    (doc.type === 'text' ? m.content === doc.content : m.isLocalImage)
                  )
                )
                if (tempIndex !== -1) {
                  messagesToUpdate = [...currentMessages]
                  // 关键：更新 _id 为真实ID，并清除 isLocalImage 标记
                  messagesToUpdate[tempIndex] = {
                    ...messagesToUpdate[tempIndex],
                    _id: doc._id,
                    isLocalImage: false,
                    create_time: doc.create_time,  // 同步服务器时间
                    sendStatus: 'sent'
                  }
                } else {
                  // 没找到临时消息，当作新消息处理（可能是其他设备发送的）
                  newDocs.push(doc)
                }
                continue
              }

              // 对方发的消息
              this.processedMessageIds.add(doc._id)
              newDocs.push(doc)
            }

            // 检查是否有系统消息
            const hasSystemMessage = newDocs.some(doc => doc.type === 'system')
            const normalNewDocsCount = newDocs.filter(doc => doc.type !== 'system').length

            // 更新界面
            if (messagesToUpdate || newDocs.length > 0) {
              let finalMessages = messagesToUpdate || currentMessages
              if (newDocs.length > 0) {
                // 格式化新消息，传入最后一条现有消息用于时间判断
                const lastExistingMsg = finalMessages[finalMessages.length - 1]
                const formattedNewDocs = []
                for (let i = 0; i < newDocs.length; i++) {
                  // prevMsg 应该是上一条已经格式化的消息，确保时间分割线正确
                  const prevMsg = i === 0 ? lastExistingMsg : formattedNewDocs[i - 1]
                  formattedNewDocs.push(this.formatMessage(newDocs[i], prevMsg))
                }
                finalMessages = [...finalMessages, ...formattedNewDocs]
              }

              // 写回本地缓存（防抖,避免 watch 高频触发时频繁阻塞主线程）
              if (!this.data.isCustomerServiceMode) {
                chatCache.scheduleWrite(currentNeedId, finalMessages, {
                  task: this.data.task,
                  isSeeker: this.data.isSeeker,
                  otherUser: this.data.otherUser,
                  showReportBtn: this.data.showReportBtn
                })
              }

              // 先更新消息，等渲染完成后再处理滚动和已读
              this.setData({
                messages: finalMessages
              }, () => {
                if (newDocs.length > 0) {
                  wx.nextTick(() => {
                    if (hasSystemMessage) {
                      // 系统消息:刷新任务状态,完成后同步缓存(避免下次进入读到陈旧 status)
                      this.loadTaskInfo().then(() => {
                        if (this.currentNeedId !== currentNeedId) return
                        if (this.data.isCustomerServiceMode) return
                        const newStatus = this.data.task && this.data.task.status
                        if (newStatus === 'completed') {
                          chatCache.markCompleted(currentNeedId)
                        } else if (newStatus === 'cancelled' || newStatus === 'expired') {
                          chatCache.invalidate(currentNeedId)
                        } else {
                          // 其他状态变化(如 breaking)也写一次,刷新缓存里的 taskMeta
                          chatCache.scheduleWrite(currentNeedId, this.data.messages, {
                            task: this.data.task,
                            isSeeker: this.data.isSeeker,
                            otherUser: this.data.otherUser,
                            showReportBtn: this.data.showReportBtn
                          })
                        }
                      })
                      this.setData({
                        lastMessageId: 'bottom-anchor',
                        newMessageCount: 0
                      })
                      this.markMessagesRead()
                    } else if (this.data.isAtBottom) {
                      // 在底部：滚动到底部 + 标记已读
                      this.setData({ lastMessageId: 'bottom-anchor' })
                      this.markMessagesRead()
                    } else {
                      // 不在底部：显示按钮 + 不标记已读
                      this.setData({
                        newMessageCount: this.data.newMessageCount + normalNewDocsCount
                      })
                    }
                  })
                }
              })
            }
          },
          onError: (err) => {
            console.error('消息监听失败:', err)
            this._isStartingWatch = false
            this.setData({ watchListener: null })
          }
        })

      this.setData({
        watchListener: listener,
        lastWatchActivity: Date.now()
      })
      this._isStartingWatch = false

      // 设置自动降级检测：10秒后检查是否有watch活动
      setTimeout(() => {
        const lastActivity = this.data.lastWatchActivity
        const now = Date.now()
        // 如果10秒内没有watch活动（包括init事件），且页面还开着，切换到轮询
        if (lastActivity && (now - lastActivity > 9000) && !this.data.messagePollingInterval) {
          // 切换到轮询时保留已处理消息ID，避免重复加载
          this.stopMessageWatch(true)
          this.startMessagePolling()
        }
      }, 10000)

    } catch (err) {
      console.error('启动监听异常:', err)
      this._isStartingWatch = false
      // 启动失败时切换到轮询
      this.startMessagePolling()
    }
  },

  // 停止监听
  stopMessageWatch(keepProcessedIds = false) {
    if (this.data.watchListener) {
      try {
        this.data.watchListener.close()
      } catch (e) {
        // 静默处理关闭失败
      }
      this.setData({ watchListener: null })
    }
    this._isStartingWatch = false
    if (!keepProcessedIds) {
      this.processedMessageIds = null
    }
  },

  // 发送文字消息
  async sendTextMessage() {
    const { inputValue, task, userInfo } = this.data
    if (!inputValue.trim()) return

    // 关键：使用 currentNeedId 确保发送给正确的任务
    const currentNeedId = this.currentNeedId
    if (!currentNeedId) {
      console.error('发送消息失败: 任务ID为空')
      return
    }

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

    const tempId = 'temp_' + Date.now()
    const clientMsgId = this.generateClientMsgId()
    const tempMessage = {
      _id: tempId,
      clientMsgId,
      need_id: currentNeedId,
      sender_id: userInfo._id,
      type: 'text',
      content: content,
      create_time: now.toISOString(),
      isSelf: true,
      senderAvatar: userInfo.avatar,
      timeText: DateUtil.formatTime(now),
      showTime: showTime,
      sendStatus: 'sending'
    }

    // 合并输入框清空和消息添加，减少 setData 次数
    const newMessages = [...currentMessages, tempMessage]

    // 将临时消息ID添加到已处理集合，防止重复渲染
    if (!this.processedMessageIds) {
      this.processedMessageIds = new Set(currentMessages.map(m => m._id))
    }
    this.processedMessageIds.add(tempId)

    this.setData({
      inputValue: '',
      messages: newMessages,
      lastMessageId: ''
    }, () => {
      // 使用 nextTick 确保 DOM 更新后再滚动到最新消息
      wx.nextTick(() => {
        this.setData({ lastMessageId: 'msg-' + clientMsgId })
      })
    })

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-chat',
        data: {
          action: 'sendMessage',
          needId: currentNeedId,
          type: 'text',
          content,
          clientMsgId
        }
      })

      if (result.code !== 0) {
        throw new Error(result.message)
      }

      // 发送成功，直接替换临时消息
      const realMessageId = result.data.messageId
      const messages = this.data.messages.map(m => {
        if (m.clientMsgId === clientMsgId) {
          return {
            ...m,
            _id: realMessageId,
            create_time: result.data.createTime || new Date().toISOString(),
            sendStatus: 'sent'
          }
        }
        return m
      })
      this.setData({ messages })

      // 把真实消息 ID 添加到已处理集合，防止 watch 回调重复处理
      this.processedMessageIds.delete(tempId)
      this.processedMessageIds.add(realMessageId)

    } catch (err) {
      console.error('发送消息失败:', err)

      // 发送失败，删除临时消息
      const messages = this.data.messages.filter(m => m._id !== tempId)
      this.setData({ messages })

      // 删除临时消息 ID
      this.processedMessageIds.delete(tempId)

      wx.showToast({
        title: '发送失败',
        icon: 'none'
      })
    }
  },

  // 选择图片
  async chooseImage(e) {
    const source = e.currentTarget.dataset.source

    // 检查任务状态
    if (this.data.task.status !== 'ongoing') {
      wx.showToast({
        title: '任务已结束，无法发送图片',
        icon: 'none'
      })
      return
    }

    try {
      await requirePrivacyAuthorize()
    } catch (err) {
      const msg = err.errno === 112 ? '发送图片暂不可用' : '需要同意隐私协议'
      wx.showToast({ title: msg, icon: 'none' })
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

    // 关键：使用 currentNeedId 确保发送给正确的任务
    const currentNeedId = this.currentNeedId
    if (!currentNeedId) {
      console.error('发送图片失败: 任务ID为空')
      return
    }

    // 获取图片尺寸
    let originalWidth = 0
    let originalHeight = 0
    try {
      const imgInfo = await wx.getImageInfo({ src: filePath })
      originalWidth = imgInfo.width
      originalHeight = imgInfo.height
    } catch (err) {
      console.error('获取图片信息失败:', err)
    }

    // 立即显示本地图片（乐观更新）
    const now = new Date()
    const currentMessages = this.data.messages
    const lastMsg = currentMessages.length > 0 ? currentMessages[currentMessages.length - 1] : null
    const showTime = !lastMsg || (now.getTime() - new Date(lastMsg.create_time).getTime()) / (1000 * 60) > 2

    // 计算显示尺寸（前端预计算，后端二次确认）
    const displaySize = this.calculateImageDisplaySize(originalWidth, originalHeight)

    const tempId = 'temp_img_' + Date.now()
    const clientMsgId = this.generateClientMsgId()
    const tempMessage = {
      _id: tempId,
      clientMsgId,
      need_id: currentNeedId,
      sender_id: userInfo._id,
      type: 'image',
      imageUrl: filePath,
      create_time: now.toISOString(),
      isSelf: true,
      senderAvatar: userInfo.avatar,
      timeText: DateUtil.formatTime(now),
      showTime: showTime,
      isLocalImage: true,
      sendStatus: 'sending',
      // 预计算显示尺寸
      imageWidth: displaySize.width,
      imageHeight: displaySize.height
    }

    // 将临时消息ID添加到已处理集合，防止重复渲染
    if (!this.processedMessageIds) {
      this.processedMessageIds = new Set(currentMessages.map(m => m._id))
    }
    this.processedMessageIds.add(tempId)

    // 合并消息添加
    this.setData({
      messages: [...currentMessages, tempMessage],
      lastMessageId: ''
    }, () => {
      wx.nextTick(() => {
        this.setData({ lastMessageId: 'msg-' + clientMsgId })
      })
    })

    try {
      // 上传到云存储
      const cloudPath = `chat-images/${Date.now()}-${Math.random().toString(36).substr(2, 6)}.jpg`
      const uploadResult = await wx.cloud.uploadFile({
        cloudPath,
        filePath
      })

      // 发送图片消息（带上原始尺寸）
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-chat',
        data: {
          action: 'sendMessage',
          needId: currentNeedId,
          type: 'image',
          imageUrl: uploadResult.fileID,
          imageWidth: originalWidth,
          imageHeight: originalHeight,
          clientMsgId
        }
      })

      if (result.code !== 0) {
        throw new Error(result.message)
      }

      // 发送成功，直接替换临时消息
      const realMessageId = result.data.messageId
      const messages = this.data.messages.map(m => {
        if (m.clientMsgId === clientMsgId) {
          return {
            ...m,
            _id: realMessageId,
            imageUrl: uploadResult.fileID,
            isLocalImage: false,
            create_time: result.data.createTime || new Date().toISOString(),
            sendStatus: 'sent'
          }
        }
        return m
      })
      this.setData({ messages })

      // 把真实消息 ID 添加到已处理集合，防止 watch 回调重复处理
      this.processedMessageIds.delete(tempId)
      this.processedMessageIds.add(realMessageId)

    } catch (err) {
      console.error('发送图片失败:', err)

      // 发送失败，删除临时消息
      const messages = this.data.messages.filter(m => m._id !== tempId)
      this.setData({ messages })

      // 删除临时消息 ID
      this.processedMessageIds.delete(tempId)

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

  // 从任务菜单点击完成：先关菜单，再开确认弹窗
  onCompleteMenuTap() {
    this.setData({
      showTaskMenu: false,
      showCompleteModal: true
    })
  },

  // 隐藏完成任务确认
  hideCompleteModal() {
    this.setData({ showCompleteModal: false })
  },

  // 切换任务卡片更多菜单
  toggleTaskMenu() {
    this.setData({
      showTaskMenu: !this.data.showTaskMenu
    })
  },

  // 隐藏任务卡片更多菜单
  hideTaskMenu() {
    this.setData({
      showTaskMenu: false
    })
  },

  // 切换工具栏展开/收起状态
  toggleToolbar() {
    const newExpanded = !this.data.isToolbarExpanded
    this.setData({
      isToolbarExpanded: newExpanded,
      inputFocus: false
      // 注意：不要在这里设置 inputFocus: false，会导致 iOS 键盘闪烁
      // 使用 hold-keyboard 属性来控制键盘保持
    })
  },

  // 输入框获得焦点时收起工具栏
  onInputFocus() {
    // 如果工具栏展开，先收起工具栏
    // 不手动控制 inputFocus，让输入框自行管理焦点
    if (this.data.isToolbarExpanded) {
      this.setData({
        isToolbarExpanded: false
      })
    }

    // 如果当前不在底部或未读消息不为0，则滚动到底部 + 标记已读
    if(!this.data.isAtBottom || this.data.newMessageCount > 0) {
      this.setData({ 
        isAtBottom: true,
        newMessageCount: 0
      }, () => {
        this.setData({ lastMessageId: 'bottom-anchor' })
        this.markMessagesRead()
      })
    }
  },

  // 完成任务
  async completeTask() {
    this.hideCompleteModal()

    // 关键：使用 currentNeedId 确保完成正确的任务
    const currentNeedId = this.currentNeedId
    if (!currentNeedId) {
      console.error('完成任务失败: 任务ID为空')
      return
    }

    wx.showLoading({ title: '处理中...' })

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-settlement',
        data: {
          action: 'completeTask',
          needId: currentNeedId
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

        // 标记本地缓存为已完成，触发 FIFO 清理
        chatCache.markCompleted(currentNeedId)

        // 设置刷新标记
        wx.setStorageSync('refreshMyNeeds', true)
        wx.setStorageSync('refreshMyTasks', true)

        // 跳转到评价页面
        setTimeout(() => {
          wx.navigateTo({
            url: `/pages/rating/rating?needId=${currentNeedId}`
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

  // 跳转举报页面
  goToReport() {
    const { task } = this.data
    if (!task._id) return
    wx.navigateTo({
      url: `/pages/report/report?needId=${task._id}`
    })
  },

  // 跳转任务详情
  goToTaskDetail() {
    const { task } = this.data
    if (!task._id) return
    wx.navigateTo({
      url: `/pages/task-detail/task-detail?id=${task._id}`
    })
  },

  // 跳转对方公开资料
  goToPublicProfile() {
    const { otherUser } = this.data
    if (!otherUser || !otherUser._id) return
    wx.navigateTo({
      url: `/pages/public-profile/public-profile?userId=${otherUser._id}`
    })
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
      address: location.name  || ''
    })
  },

  // 计算图片显示尺寸
  calculateImageDisplaySize(width, height) {
    const maxWidth = 400
    const maxHeight = 500

    if (!width || !height || width <= 0 || height <= 0) {
      return { width: maxWidth, height: maxHeight }
    }

    const scale = Math.min(maxWidth / width, maxHeight / height, 1)

    return {
      width: Math.round(width * scale),
      height: Math.round(height * scale)
    }
  },


  // 生成稳定的客户端消息ID（用于列表渲染key，避免发送确认后闪烁）
  generateClientMsgId() {
    return `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  }
})
