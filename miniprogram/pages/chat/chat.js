// 聊天页面逻辑
const app = getApp()
const { requirePrivacyAuthorize } = require('../../utils/privacy')
const DateUtil = require('../../utils/dateUtil')
const chatCache = require('../../utils/chatCache')
const avatarCache = require('../../utils/avatarCache')
const { STATUS_MAP, getByType, resolveTaskType } = require('../../utils/needTypes')
const { MoneyUtils } = require('../../utils/platformRules')

const VOICE_MIN_WIDTH = 220
const VOICE_MAX_WIDTH = 430
const VOICE_CANCEL_VERTICAL_THRESHOLD = 56
const VOICE_CANCEL_HORIZONTAL_THRESHOLD = 120
const MEDIA_STATUS_POLL_INTERVAL_MS = 2500
const MEDIA_STATUS_MAX_POLL_MS = 2 * 60 * 1000

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
    canCompleteTask: false,
    showReportBtn: false,

    // 消息相关
    messages: [],
    inputValue: '',
    inputFocus: false,  // 初始不自动聚焦，避免进入页面自动打开输入法
    isInputFocused: false,
    lastMessageId: '',
    hasMoreMessages: true,  // 默认允许下拉刷新，首次加载后根据实际结果更新
    pageSize: 20,

    // 滚动状态
    isAtBottom: true,      // 当前是否在底部
    newMessageCount: 0,     // 未滚动到底部的新消息数
    scrollTop: 0,          // 记录滚动位置
    scrollViewHeight: 0,   // scroll-view 高度

    // 任务卡片更多菜单
    showTaskMenu: false,

    // 工具栏展开状态
    isToolbarExpanded: false,

    // 语音录制与播放
    isRecording: false,
    voiceRecordCancelActive: false,
    recordingSeconds: 0,
    recordingCountdown: 0,
    playingVoiceId: '',

    // 下拉刷新状态
    isRefreshing: false,

    // 监听
    watchListener: null,

    // 轮询备用（当watch不工作时使用）
    messagePollingInterval: null,
    lastWatchActivity: null,

    // 客服查看模式
    isCustomerServiceMode: false,

    // 客服模式下：{ [userId]: { nickname, avatar } }
    participants: {},

    // 首屏加载状态（用于骨架屏显示）
    loading: true,

    // 隐藏画布尺寸，用于拍照可信水印生成
    watermarkCanvasWidth: 1,
    watermarkCanvasHeight: 1
  },

  onLoad(options) {
    this.initVoiceManagers()
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
      initialData.isSeeker = !!cached.taskMeta.isSeeker
      initialData.task = this.normalizeTaskAmount({ ...cached.taskMeta.task, _id: needId }, initialData.isSeeker)
      initialData.otherUser = this.withCachedAvatar(cached.taskMeta.otherUser || null)
      initialData.canCompleteTask = this.canCompleteTask(initialData.isSeeker, initialData.task)
      initialData.showReportBtn = !!cached.taskMeta.showReportBtn
      initialData.messages = this.hydrateCachedMessageAvatars(
        Array.isArray(cached.messages) ? cached.messages : [],
        initialData.otherUser
      )
      initialData.loading = false
      // 缓存数据进入后,首屏直接落到底部
      initialData.lastMessageId = 'bottom-anchor'
      cachedOlderSnapshot = initialData.messages.slice()
    } else {
      // 缓存未命中:至少把 task._id 占位,避免 loadTaskInfo 前空数据
      initialData['task._id'] = needId
    }

    this.setData(initialData)
    this.updateNavigationTitle(initialData.otherUser, isCustomerServiceMode)

    // 重置已处理消息ID集合（带上缓存里的，防止 watch / 网络回调重复添加）
    this.processedMessageIds = new Set(initialData.messages.map(m => m._id).filter(Boolean))

    // 获取 scroll-view 高度
    this.getScrollViewHeight()

    // 先加载任务信息（含 otherUser/participants），再加载消息（formatMessage 需要前者）
    ;(async () => {
      try {
        const taskResult = await this.loadTaskInfo()
        if (this.currentNeedId !== needId) return
        if (!taskResult || taskResult.code !== 0) return

        const msgResult = await this.loadMessages()
        if (this.currentNeedId !== needId) return
        if (!msgResult || msgResult.code !== 0) return

        // 标记消息已加载完成，后续轮询可以正常工作
        this._messagesLoaded = true

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
          chatCache.writeCache(needId, this.data.messages, this.buildCacheTaskMeta())
        }

        // 历史消息加载完成后，开始监听新消息
        this.startMessageWatch().catch(err => {
          console.error('启动消息监听失败:', err)
          this.startMessagePolling()
        })
      } catch (err) {
        console.error('初始化聊天页面失败:', err)
      } finally {
        if (this.currentNeedId === needId && this.data.loading) {
          this.setData({ loading: false })
        }
      }
    })()
  },

  onShow() {
    this.updateNavigationTitle(this.data.otherUser, this.data.isCustomerServiceMode)

    // 页面显示时确保监听或轮询已启动
    const hasActiveListener = this.data.watchListener || this.data.messagePollingInterval
    // 使用 currentNeedId 而不是 task._id，确保状态一致性
    if (this.currentNeedId && this._messagesLoaded && !hasActiveListener) {
      this.startMessageWatch().catch(err => {
        console.error('启动消息监听失败:', err)
        this.startMessagePolling()
      })
    } else if (this.currentNeedId && this._messagesLoaded && this.data.watchListener) {
      this.startMediaStatusPolling()
    }
    // 立即拉取一次消息，防止隐藏期间有遗漏
    if (this.currentNeedId && this._messagesLoaded) {
      this.pollNewMessages()
    }
    // 只有在底部时才标记已读
    if (this.data.isAtBottom) {
      this.markMessagesRead()
    }
  },


  onHide() {
    // 页面隐藏时停止轮询以节省资源，但保持watch监听（如果有的话）
    this.stopMessagePolling()
    this.stopMediaStatusPolling()
    this.stopVoicePlayback()
    this.clearMessageInputLongPressTimer()
    if (this.data.isRecording) this.cancelVoiceRecording()
  },

  onUnload() {
    // 页面卸载时清理所有监听和状态
    this.stopMessageWatch()
    this.stopMessagePolling()
    this.stopMediaStatusPolling()
    this.clearMessageInputLongPressTimer()
    this.clearReviewLoadingTimers()
    this.destroyVoiceManagers()
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
        takerIncome: 0,
        displayRewardAmount: 0,
        status: 'ongoing',
        statusText: '进行中',
        expireTime: null
      }
    })
  },

  updateNavigationTitle(otherUser, isCustomerServiceMode = this.data.isCustomerServiceMode) {
    const pages = getCurrentPages()
    if (pages[pages.length - 1] !== this) return

    const title = isCustomerServiceMode
      ? '查看聊天记录'
      : (this.getUserDisplayName(otherUser) || '聊天')
    wx.setNavigationBarTitle({ title })
  },

  getUserDisplayName(user) {
    if (!user) return ''
    return user.nickname || user.nickName || user.name || ''
  },

  calculateVoiceWidth(duration) {
    const seconds = Math.min(60, Math.max(1, Number(duration) || 1))
    const ratio = (seconds - 1) / 59
    return Math.round(VOICE_MIN_WIDTH + (VOICE_MAX_WIDTH - VOICE_MIN_WIDTH) * ratio)
  },

  normalizeTaskAmount(task = {}, isSeeker = false) {
    const rewardAmount = Number(task.rewardAmount || task.reward_amount || 0)
    const takerIncome = Number(task.takerIncome || task.taker_income || MoneyUtils.calcTakerIncome(rewardAmount))
    return {
      ...task,
      rewardAmount,
      takerIncome,
      displayRewardAmount: isSeeker ? rewardAmount : takerIncome
    }
  },

  withCachedAvatar(user) {
    if (!user) return user
    const userId = user._id || user.id || user.user_id || user.userId
    const remoteAvatar = user.avatar || user.remoteAvatar || ''
    const displayAvatar = avatarCache.getCachedAvatar(userId, remoteAvatar)
    return {
      ...user,
      avatar: remoteAvatar,
      displayAvatar
    }
  },

  withCachedParticipants(participants = {}) {
    const next = {}
    Object.keys(participants || {}).forEach(userId => {
      next[userId] = this.withCachedAvatar({
        _id: userId,
        ...participants[userId]
      })
    })
    return next
  },

  hydrateCachedMessageAvatars(messages, otherUser = null, participants = {}) {
    const userInfo = app.globalData.userInfo || this.data.userInfo || {}
    const cachedOtherUser = this.withCachedAvatar(otherUser)
    const cachedParticipants = this.withCachedParticipants(participants)

    return messages.map(msg => {
      if (!msg || msg.isSystem || msg.isSelf || msg.sender_id === userInfo._id) {
        return msg
      }

      const senderInfo = cachedParticipants[msg.sender_id] || cachedOtherUser
      if (!senderInfo) return msg

      return {
        ...msg,
        senderAvatar: senderInfo.displayAvatar || senderInfo.avatar || msg.senderAvatar,
        senderName: senderInfo.nickname || msg.senderName
      }
    })
  },

  buildCacheTaskMeta() {
    return {
      task: this.data.task,
      isSeeker: this.data.isSeeker,
      otherUser: this.data.otherUser,
      showReportBtn: this.data.showReportBtn
    }
  },

  async warmChatAvatarCache(otherUser, participants = {}) {
    if (this.data.isCustomerServiceMode) return
    const needId = this.currentNeedId

    const users = []
    if (otherUser && otherUser._id && otherUser.avatar) {
      users.push(otherUser)
    }
    Object.keys(participants || {}).forEach(userId => {
      const participant = participants[userId]
      if (participant && participant.avatar) {
        users.push({ _id: userId, ...participant })
      }
    })

    for (const user of users) {
      const userId = user._id || user.id || user.user_id || user.userId
      const remoteAvatar = user.avatar || ''
      try {
        const localAvatar = await avatarCache.cacheAvatar(userId, remoteAvatar)
        if (this.currentNeedId === needId && localAvatar && localAvatar !== remoteAvatar) {
          this.applyCachedAvatarToMessages(userId, remoteAvatar, localAvatar)
        }
      } catch (err) {
        console.warn('缓存聊天头像失败:', err.errMsg || err.message || err)
      }
    }
  },

  applyCachedAvatarToMessages(userId, remoteAvatar, localAvatar) {
    const updates = {}
    const otherUser = this.data.otherUser
    if (otherUser && (otherUser._id === userId || otherUser.id === userId)) {
      updates.otherUser = {
        ...otherUser,
        avatar: remoteAvatar,
        displayAvatar: localAvatar
      }
    }

    const participants = this.data.participants || {}
    if (participants[userId]) {
      updates.participants = {
        ...participants,
        [userId]: {
          ...participants[userId],
          avatar: remoteAvatar,
          displayAvatar: localAvatar
        }
      }
    }

    let changed = false
    const messages = this.data.messages.map(msg => {
      if (msg && !msg.isSelf && msg.sender_id === userId && msg.senderAvatar !== localAvatar) {
        changed = true
        return { ...msg, senderAvatar: localAvatar }
      }
      return msg
    })

    if (changed) updates.messages = messages
    if (Object.keys(updates).length === 0) return

    this.setData(updates, () => {
      if (!this.data.isCustomerServiceMode) {
        chatCache.scheduleWrite(this.currentNeedId, this.data.messages, this.buildCacheTaskMeta())
      }
    })
  },

  buildOtherUser(taskData, isSeeker) {
    if (taskData.otherUser) {
      return this.withCachedAvatar({
        ...taskData.otherUser,
        nickname: this.getUserDisplayName(taskData.otherUser)
      })
    }

    const otherUser = isSeeker
      ? {
          _id: taskData.taker_id || '',
          nickname: taskData.takerNickname || taskData.taker_nickname || '',
          avatar: taskData.takerAvatar || taskData.taker_avatar || ''
        }
      : {
          _id: taskData.user_id || '',
          nickname: taskData.seekerNickname || taskData.user_nickname || '',
          avatar: taskData.seekerAvatar || taskData.user_avatar || ''
        }
    return this.withCachedAvatar(otherUser)
  },

  canCompleteTask(isSeeker, task) {
    return !!(isSeeker && task && task.status === 'ongoing')
  },

  // 启动消息轮询（watch不可用时的备用方案）
  startMessagePolling() {
    if (this.data.messagePollingInterval) return

    const poll = () => this.pollNewMessages()

    // 立即执行一次
    poll()

    // 每5秒轮询一次（降低频率减少服务器压力）
    const interval = setInterval(poll, 2500)
    this.setData({ messagePollingInterval: interval })
  },

  // 停止消息轮询
  stopMessagePolling() {
    if (this.data.messagePollingInterval) {
      clearInterval(this.data.messagePollingInterval)
      this.setData({ messagePollingInterval: null })
    }
  },

  startMediaStatusPolling() {
    if (this.mediaStatusPollingInterval) return

    const poll = () => this.refreshPendingMediaStatuses()
    this.mediaStatusPollingStartedAt = Date.now()
    poll()
    this.mediaStatusPollingInterval = setInterval(() => {
      if (Date.now() - this.mediaStatusPollingStartedAt > MEDIA_STATUS_MAX_POLL_MS) {
        this.stopMediaStatusPolling()
        return
      }
      poll()
    }, MEDIA_STATUS_POLL_INTERVAL_MS)
  },

  stopMediaStatusPolling() {
    if (!this.mediaStatusPollingInterval) return
    clearInterval(this.mediaStatusPollingInterval)
    this.mediaStatusPollingInterval = null
    this.mediaStatusPollingStartedAt = 0
  },

  initVoiceManagers() {
    this.recorderManager = wx.getRecorderManager()
    this.innerAudioContext = wx.createInnerAudioContext()
    this.innerAudioContext.obeyMuteSwitch = false

    this.recorderManager.onStart(() => {
      this._recordingStartedAt = Date.now()
      this._voiceRecordingCancelled = !!this._voiceRecordingCancelled
      this._voiceCountdownVibrated = false
      this.setData({
        isRecording: true,
        voiceRecordCancelActive: !!this._voiceCancelActive,
        recordingSeconds: 0,
        recordingCountdown: 0
      })
      this.startVoiceRecordingTimer()
      if (!this._voiceTouchHeld) this.recorderManager.stop()
    })
    this.recorderManager.onStop(result => {
      this.clearVoiceRecordingTimer()
      this.setData({ isRecording: false, voiceRecordCancelActive: false, recordingSeconds: 0, recordingCountdown: 0 })
      if (this._voiceRecordingCancelled) return
      const duration = Math.ceil(Number(result.duration || 0) / 1000)
      if (!result.tempFilePath || duration < 1) {
        wx.showToast({ title: '录音时间太短', icon: 'none' })
        return
      }
      this.uploadVoice(result.tempFilePath, Math.min(60, duration))
    })
    this.recorderManager.onError(err => {
      console.error('录音失败:', err)
      this.clearVoiceRecordingTimer()
      this.setData({ isRecording: false, voiceRecordCancelActive: false, recordingSeconds: 0, recordingCountdown: 0 })
      wx.showToast({ title: '录音失败，请检查麦克风权限', icon: 'none' })
    })

    const clearPlayingState = () => this.setData({ playingVoiceId: '' })
    this.innerAudioContext.onEnded(clearPlayingState)
    this.innerAudioContext.onStop(clearPlayingState)
    this.innerAudioContext.onError(err => {
      console.error('语音播放失败:', err)
      clearPlayingState()
      wx.showToast({ title: '语音播放失败', icon: 'none' })
    })
  },

  destroyVoiceManagers() {
    this.clearVoiceRecordingTimer()
    if (this.innerAudioContext) {
      this.innerAudioContext.stop()
      this.innerAudioContext.destroy()
      this.innerAudioContext = null
    }
    this.recorderManager = null
  },

  startVoiceRecordingTimer() {
    this.clearVoiceRecordingTimer()
    this.voiceRecordingTimer = setInterval(() => {
      if (!this.data.isRecording) return
      const seconds = Math.min(60, Math.floor((Date.now() - this._recordingStartedAt) / 1000))
      const countdown = seconds >= 50 ? Math.max(0, 60 - seconds) : 0
      if (seconds >= 50 && !this._voiceCountdownVibrated) {
        this._voiceCountdownVibrated = true
        wx.vibrateLong({ fail: () => {} })
      }
      this.setData({ recordingSeconds: seconds, recordingCountdown: countdown })
    }, 250)
  },

  clearVoiceRecordingTimer() {
    if (this.voiceRecordingTimer) {
      clearInterval(this.voiceRecordingTimer)
      this.voiceRecordingTimer = null
    }
  },

  async ensureRecordPermission() {
    try {
      await requirePrivacyAuthorize()
      await new Promise((resolve, reject) => {
        wx.authorize({ scope: 'scope.record', success: resolve, fail: reject })
      })
      return true
    } catch (err) {
      wx.showModal({
        title: '需要麦克风权限',
        content: '发送语音需要使用麦克风，请在设置中开启权限。',
        confirmText: '去设置',
        success: result => {
          if (result.confirm) wx.openSetting()
        }
      })
      return false
    }
  },

  clearMessageInputLongPressTimer() {
    if (this._messageInputLongPressTimer) {
      clearTimeout(this._messageInputLongPressTimer)
      this._messageInputLongPressTimer = null
    }
  },

  scheduleReviewLoadingHide(messageKey, delay = 1000) {
    if (!messageKey) return
    if (!this._reviewLoadingTimers) this._reviewLoadingTimers = {}
    if (this._reviewLoadingTimers[messageKey]) {
      clearTimeout(this._reviewLoadingTimers[messageKey])
    }

    this._reviewLoadingTimers[messageKey] = setTimeout(() => {
      delete this._reviewLoadingTimers[messageKey]
      const messages = this.data.messages.map(item => {
        if (item._id !== messageKey && item.clientMsgId !== messageKey) return item
        if (item.status !== 'pending' || !item.reviewLoadingVisible) return item
        return { ...item, reviewLoadingVisible: false }
      })
      this.setData({ messages })
    }, delay)
  },

  clearReviewLoadingTimers() {
    if (!this._reviewLoadingTimers) return
    Object.keys(this._reviewLoadingTimers).forEach(key => {
      clearTimeout(this._reviewLoadingTimers[key])
    })
    this._reviewLoadingTimers = {}
  },

  onMessageInputTouchStart(e) {
    if (this.data.task.status !== 'ongoing') return
    this.clearMessageInputLongPressTimer()
    const touch = e.touches && e.touches[0]
    this._voiceTouchStartPoint = touch ? { x: touch.clientX, y: touch.clientY } : null
    this._voiceCancelActive = false
    this._messageInputLongPressed = false
    this._messageInputTouchEnded = false
    this._messageInputLongPressTimer = setTimeout(async () => {
      this._messageInputLongPressTimer = null
      this._messageInputLongPressed = true
      await this.startVoiceRecording()
      if (this._messageInputTouchEnded) {
        this.finishVoiceRecording()
      }
    }, 320)
  },

  onMessageInputTouchMove(e) {
    if (!this._voiceTouchStartPoint) return
    const touch = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0])
    if (!touch) return

    const deltaX = touch.clientX - this._voiceTouchStartPoint.x
    const deltaY = touch.clientY - this._voiceTouchStartPoint.y
    const shouldCancel =
      deltaY <= -VOICE_CANCEL_VERTICAL_THRESHOLD ||
      Math.abs(deltaX) >= VOICE_CANCEL_HORIZONTAL_THRESHOLD

    if (this._voiceCancelActive === shouldCancel) return
    this._voiceCancelActive = shouldCancel
    if (this.data.isRecording) {
      this.setData({ voiceRecordCancelActive: shouldCancel })
      wx.vibrateShort({ type: shouldCancel ? 'medium' : 'light', fail: () => {} })
    }
  },

  onMessageInputTouchEnd() {
    this._messageInputTouchEnded = true
    if (this._messageInputLongPressTimer) {
      const shouldFocusInput = !this._voiceCancelActive
      this.clearMessageInputLongPressTimer()
      if (shouldFocusInput) this.focusMessageInput()
      this._voiceTouchStartPoint = null
      this._voiceCancelActive = false
      return
    }
    if (this._messageInputLongPressed) {
      if (this._voiceCancelActive || this.data.voiceRecordCancelActive) {
        this.cancelVoiceRecording()
      } else {
        this.finishVoiceRecording()
      }
    }
    this._voiceTouchStartPoint = null
    this._voiceCancelActive = false
  },

  onMessageInputTouchCancel() {
    this._messageInputTouchEnded = true
    this.clearMessageInputLongPressTimer()
    if (this._messageInputLongPressed) {
      this.cancelVoiceRecording()
    }
    this._voiceTouchStartPoint = null
    this._voiceCancelActive = false
  },

  focusMessageInput() {
    if (this.data.task.status !== 'ongoing') return
    this.setData({
      inputFocus: true,
      isInputFocused: true,
      isToolbarExpanded: false
    })
  },

  async startVoiceRecording() {
    if (this.data.task.status !== 'ongoing' || this.data.isRecording || !this.recorderManager) return false
    const hasPermission = await this.ensureRecordPermission()
    if (!hasPermission) return false
    this.stopVoicePlayback()
    this._voiceTouchHeld = true
    this._voiceRecordingCancelled = false
    this.setData({
      inputFocus: false,
      isInputFocused: false,
      isToolbarExpanded: false,
      voiceRecordCancelActive: !!this._voiceCancelActive
    })
    this.recorderManager.start({
      duration: 60000,
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 48000,
      format: 'mp3'
    })
    return true
  },

  finishVoiceRecording() {
    this._voiceTouchHeld = false
    this._voiceTouchStartPoint = null
    this._voiceCancelActive = false
    if (this.data.isRecording && this.recorderManager) this.recorderManager.stop()
  },

  cancelVoiceRecording() {
    this._voiceTouchHeld = false
    this._voiceRecordingCancelled = true
    this._voiceTouchStartPoint = null
    this._voiceCancelActive = false
    if (this.data.voiceRecordCancelActive) {
      this.setData({ voiceRecordCancelActive: false })
    }
    if (this.data.isRecording && this.recorderManager) this.recorderManager.stop()
  },

  async uploadVoice(filePath, duration) {
    const currentNeedId = this.currentNeedId
    const userInfo = this.data.userInfo
    if (!currentNeedId || !userInfo) return

    const now = new Date()
    const currentMessages = this.data.messages
    const lastMsg = currentMessages[currentMessages.length - 1]
    const tempId = 'temp_voice_' + Date.now()
    const clientMsgId = this.generateClientMsgId()
    const tempMessage = {
      _id: tempId,
      clientMsgId,
      need_id: currentNeedId,
      sender_id: userInfo._id,
      type: 'voice',
      voiceUrl: filePath,
      voiceDuration: duration,
      voiceWidth: this.calculateVoiceWidth(duration),
      status: 'pending',
      sendStatus: 'sending',
      reviewLoadingVisible: true,
      create_time: now.toISOString(),
      isSelf: true,
      senderAvatar: userInfo.avatar,
      timeText: DateUtil.formatTime(now),
      showTime: !lastMsg || (now.getTime() - new Date(lastMsg.create_time).getTime()) / 60000 > 2
    }
    if (!this.processedMessageIds) this.processedMessageIds = new Set(currentMessages.map(item => item._id))
    this.processedMessageIds.add(tempId)
    this.setData({ messages: [...currentMessages, tempMessage], lastMessageId: '' }, () => {
      wx.nextTick(() => this.setData({ lastMessageId: 'msg-' + clientMsgId }))
    })
    this.scheduleReviewLoadingHide(clientMsgId)

    try {
      const uploadResult = await wx.cloud.uploadFile({
        cloudPath: `chat-voices/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`,
        filePath
      })
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-chat',
        data: {
          action: 'sendMessage',
          needId: currentNeedId,
          type: 'voice',
          voiceUrl: uploadResult.fileID,
          voiceDuration: duration,
          clientMsgId
        }
      })
      if (!result || result.code !== 0) throw new Error(result?.message || '发送失败')

      const realMessageId = result.data.messageId
      const messages = this.data.messages.map(message => message.clientMsgId === clientMsgId ? {
        ...message,
        _id: realMessageId,
        voiceUrl: uploadResult.fileID,
        status: result.data.status || 'pending',
        sendStatus: 'reviewing',
        reviewLoadingVisible: message.reviewLoadingVisible && (result.data.status || 'pending') === 'pending',
        create_time: result.data.createTime || now.toISOString()
      } : message)
      this.processedMessageIds.delete(tempId)
      this.processedMessageIds.add(realMessageId)
      const updates = { messages }
      if (this.data.playingVoiceId === tempId) {
        updates.playingVoiceId = realMessageId
      }
      this.setData(updates)
      if ((result.data.status || 'pending') === 'pending') {
        this.startMediaStatusPolling()
      }
    } catch (err) {
      console.error('发送语音失败:', err)
      this.processedMessageIds.delete(tempId)
      this.setData({ messages: this.data.messages.filter(message => message._id !== tempId) })
      wx.showToast({ title: err.message || '语音发送失败', icon: 'none' })
    }
  },

  async toggleVoicePlayback(e) {
    const messageId = e.currentTarget.dataset.id
    let message = this.data.messages.find(item => item._id === messageId)
    if (!message || !this.innerAudioContext) return
    const canPlayOwnPendingVoice = message.isSelf && message.type === 'voice' && message.status === 'pending'
    if (message.status !== 'normal' && !canPlayOwnPendingVoice) {
      await this.refreshPendingMediaStatuses()
      message = this.data.messages.find(item => item._id === messageId)
      const canPlayUpdatedOwnPendingVoice = message && message.isSelf && message.type === 'voice' && message.status === 'pending'
      if (!message || (message.status !== 'normal' && !canPlayUpdatedOwnPendingVoice)) {
        wx.showToast({
          title: message && message.status === 'violated' ? '语音未通过审核' : '审核通过后可播放',
          icon: 'none'
        })
        return
      }
    }
    if (!message.voiceUrl) return
    if (this.data.playingVoiceId === messageId) {
      this.stopVoicePlayback()
      return
    }
    this.innerAudioContext.stop()
    try {
      let playableUrl = message.voiceUrl
      if (playableUrl.startsWith('cloud://')) {
        const tempResult = await wx.cloud.getTempFileURL({ fileList: [playableUrl] })
        playableUrl = tempResult.fileList?.[0]?.tempFileURL || ''
      }
      if (!playableUrl) throw new Error('语音地址无效')
      this.innerAudioContext.src = playableUrl
      this.setData({ playingVoiceId: messageId })
      this.innerAudioContext.play()
    } catch (err) {
      console.error('获取语音播放地址失败:', err)
      this.setData({ playingVoiceId: '' })
      wx.showToast({ title: '语音播放失败', icon: 'none' })
    }
  },

  stopVoicePlayback() {
    if (this.innerAudioContext) this.innerAudioContext.stop()
    if (this.data.playingVoiceId) this.setData({ playingVoiceId: '' })
  },

  async retryMediaMessage(e) {
    const messageId = e.currentTarget.dataset.id
    const message = this.data.messages.find(item => item._id === messageId)
    if (!message || message.status !== 'violated') return
    this.setData({
      messages: this.data.messages.map(item => item._id === messageId
        ? { ...item, status: 'pending', sendStatus: 'reviewing', reviewLoadingVisible: true }
        : item)
    })
    this.scheduleReviewLoadingHide(messageId)
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-chat',
        data: { action: 'retryMediaMessage', messageId }
      })
      if (!result || result.code !== 0) throw new Error(result?.message || '重发失败')
      this.startMediaStatusPolling()
    } catch (err) {
      this.setData({
        messages: this.data.messages.map(item => item._id === messageId
          ? { ...item, status: 'violated', sendStatus: 'failed', reviewLoadingVisible: false }
          : item)
      })
      wx.showToast({ title: err.message || '重发失败', icon: 'none' })
    }
  },

  // 轮询获取新消息
  // 只获取比当前最新消息更新的消息，避免重复加载历史消息
  async pollNewMessages() {
    const { messages } = this.data

    // 关键：使用 currentNeedId 确保获取正确的任务消息
    const currentNeedId = this.currentNeedId
    if (!currentNeedId) return

    // 仅当初始化未完成时才跳过（消息列表为空但有可能是真没消息）
    if (!this._messagesLoaded) return

    // 如果正在处理中，跳过本次轮询
    if (this._isPolling) return
    this._isPolling = true

    try {
      await this.refreshPendingMediaStatuses()

      // 计算 afterTime：取最后一条消息的时间，没有消息则传 null 获取全部
      const afterTime = messages.length > 0
        ? messages[messages.length - 1].create_time
        : null

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
          // 2. 已存在的消息仍需合并审核状态变化。
          if (this.processedMessageIds.has(msg._id)) {
            const sourceMessages = messagesToUpdate || messages
            const existingIndex = sourceMessages.findIndex(item => item._id === msg._id)
            if (existingIndex !== -1) {
              messagesToUpdate = messagesToUpdate || [...messages]
              const previous = existingIndex > 0 ? messagesToUpdate[existingIndex - 1] : null
              messagesToUpdate[existingIndex] = this.formatMessage({
                ...messagesToUpdate[existingIndex],
                ...msg,
                sendStatus: 'sent'
              }, previous)
            }
            continue
          }

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
                ...msg,
                _id: msg._id,
                isLocalImage: false,
                create_time: msg.create_time,
                sendStatus: msg.status === 'pending' ? 'reviewing' : 'sent'
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
            chatCache.scheduleWrite(currentNeedId, finalMessages, this.buildCacheTaskMeta())
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

  async refreshPendingMediaStatuses() {
    const pendingIds = this.data.messages
      .filter(message =>
        message && message.isSelf &&
        ['image', 'voice'].includes(message.type) &&
        message.status === 'pending' && message._id &&
        !String(message._id).startsWith('temp_')
      )
      .map(message => message._id)
      .slice(0, 20)
    if (pendingIds.length === 0) {
      this.stopMediaStatusPolling()
      return 0
    }

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-chat',
        data: { action: 'getMediaStatuses', messageIds: pendingIds }
      })
      if (!result || result.code !== 0 || !Array.isArray(result.data?.list)) return
      const statusMap = new Map(result.data.list.map(item => [item.messageId, item]))
      let changed = false
      const messages = this.data.messages.map(message => {
        const latest = statusMap.get(message._id)
        if (!latest || latest.status === message.status) return message
        changed = true
        return this.formatMessage({
          ...message,
          status: latest.status,
          create_time: latest.createTime || message.create_time,
          sendStatus: latest.status === 'violated' ? 'failed' : 'sent'
        })
      }).sort((a, b) => new Date(a.create_time) - new Date(b.create_time))
      if (changed) {
        this.setData({ messages })
        if (!this.data.isCustomerServiceMode) {
          chatCache.scheduleWrite(this.currentNeedId, messages, this.buildCacheTaskMeta())
        }
      }
    } catch (err) {
      console.error('刷新媒体审核状态失败:', err)
    }
    return pendingIds.length
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
    if (this.data.showTaskMenu) {
      this.setData({ showTaskMenu: false })
    }

    const { scrollTop, scrollHeight } = e.detail
    const clientHeight = this.data.scrollViewHeight || 0
    const isAtBottom = clientHeight > 0 && (scrollHeight - scrollTop - clientHeight < 50)

    if (isAtBottom !== this.data.isAtBottom) {
      this.setData({ isAtBottom })
      if (isAtBottom && this.data.newMessageCount > 0) {
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
        const typeInfo = getByType(resolveTaskType(taskData))
        const statusInfo = STATUS_MAP[taskData.status] || STATUS_MAP['pending']
        const currentUser = this.data.userInfo || app.globalData.userInfo || {}
        const isSeeker = result.data.role === 'seeker' || taskData.user_id === currentUser._id
        const otherUser = this.buildOtherUser(taskData, isSeeker)
        const participants = this.withCachedParticipants(result.data.participants || {})
        const task = this.normalizeTaskAmount({
          _id: taskData._id,
          taskNo: taskData.task_no,
          type: typeInfo.type,
          typeName: typeInfo.name,
          typeIcon: typeInfo.icon,
          typeColor: typeInfo.color,
          typeBgColor: typeInfo.bgColor,
          description: taskData.description,
          rewardAmount: taskData.rewardAmount || taskData.reward_amount || 0,
          takerIncome: taskData.takerIncome || taskData.taker_income || 0,
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
        }, isSeeker)

        this.setData({
          task,
          isSeeker,
          otherUser,
          canCompleteTask: this.canCompleteTask(isSeeker, task),
          participants,
          showReportBtn: (result.data.status === 'ongoing' || result.data.status === 'completed') &&
            !result.data.myReportStatus.hasReport &&
            (new Date() <= new Date(new Date(result.data.expire_time).getTime() + 72 * 60 * 60 * 1000))
        })

        this.updateNavigationTitle(otherUser, this.data.isCustomerServiceMode)
        this.warmChatAvatarCache(otherUser, participants)

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
        ? `任务已完成，${msg.amount}元已计入对方的余额`
        : `任务已完成，${msg.amount}元已计入您的余额`
    }
    if (msg.type === 'system' && msg.system_type === 'report_filed') {
      if (this.data.userInfo && msg.sender_id === this.data.userInfo._id) {
        displayContent = '您已发起举报，聊天暂时不可用'
      }
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
      sendStatus: msg.status === 'pending'
        ? 'reviewing'
        : (msg.status === 'violated' ? 'failed' : (msg.sendStatus || 'sent')),
      reviewLoadingVisible: !!msg.reviewLoadingVisible && msg.status === 'pending',
      isSelf,
      isSystem: msg.type === 'system',
      senderAvatar: isSelf
        ? userInfo.avatar
        : this.getOtherSenderInfo(msg.sender_id).displayAvatar,
      senderName: isSelf
        ? (userInfo.nickname || '我')
        : this.getOtherSenderInfo(msg.sender_id).nickname,
      timeText,
      showTime,
      // 统一图片字段为 camelCase（优先使用已有的 imageUrl，否则从 image_url 转换）
      imageUrl: (msg.status === 'violated' && !isSelf) ? '' : (msg.imageUrl || msg.image_url || ''),
      // 图片显示尺寸（后端预计算）
      imageWidth: msg.image_width || 0,
      imageHeight: msg.image_height || 0,
      imageSource: msg.image_source || msg.imageSource || 'album',
      isTrustedPhoto: !!(msg.is_trusted_photo || msg.isTrustedPhoto),
      watermarkInfo: msg.watermark_info || msg.watermarkInfo || null,
      voiceUrl: (msg.status === 'violated' && !isSelf) ? '' : (msg.voiceUrl || msg.voice_url || ''),
      voiceDuration: Math.max(1, Number(msg.voiceDuration || msg.voice_duration) || 1),
      voiceWidth: this.calculateVoiceWidth(msg.voiceDuration || msg.voice_duration)
    }
  },

  // 获取非己方发送者的头像和昵称
  getOtherSenderInfo(senderId) {
    const participant = this.data.participants && this.data.participants[senderId]
    if (participant) {
      return {
        avatar: participant.avatar || '/images/default-avatar.png',
        displayAvatar: participant.displayAvatar || participant.avatar || '/images/default-avatar.png',
        nickname: participant.nickname || ''
      }
    }
    if (this.data.otherUser) {
      return {
        avatar: this.data.otherUser.avatar || '/images/default-avatar.png',
        displayAvatar: this.data.otherUser.displayAvatar || this.data.otherUser.avatar || '/images/default-avatar.png',
        nickname: this.data.otherUser.nickname || ''
      }
    }
    return { avatar: '/images/default-avatar.png', displayAvatar: '/images/default-avatar.png', nickname: '' }
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
    const _ = db.command

    // 初始化已处理消息ID集合（防止监听回调重复添加自己发的消息）
    this.processedMessageIds = new Set(this.data.messages.map(m => m._id))

    try {
      const listener = db.collection('wdd-messages')
        .where(_.and([
          { need_id: String(needId) },
          _.or([
            { status: 'normal' },
            { type: 'system' }
          ])
        ]))
        .watch({
          onChange: (snapshot) => {
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
              if (change.dataType === 'remove') continue

              const doc = change.doc
              if (!doc) continue

              // 关键校验：消息必须属于当前任务
              if (doc.need_id !== currentNeedId) continue
              // 客户端监听只接收已送达消息和系统消息；待审核媒体由发送者状态轮询处理。
              if (doc.status !== 'normal' && doc.type !== 'system') continue

              // 已处理的消息仍可能收到状态/字段更新，需要合并而不是直接跳过。
              if (this.processedMessageIds.has(doc._id)) {
                const sourceMessages = messagesToUpdate || currentMessages
                const existingIndex = sourceMessages.findIndex(item => item._id === doc._id)
                if (existingIndex !== -1) {
                  messagesToUpdate = messagesToUpdate || [...currentMessages]
                  const previous = existingIndex > 0 ? messagesToUpdate[existingIndex - 1] : null
                  messagesToUpdate[existingIndex] = this.formatMessage({
                    ...messagesToUpdate[existingIndex],
                    ...doc,
                    sendStatus: 'sent'
                  }, previous)
                }
                continue
              }

              // 自己发送的消息：确认临时消息
              if (doc.sender_id === userInfo._id) {
                this.processedMessageIds.add(doc._id)
                const incomingClientMsgId = doc.client_msg_id || doc.clientMsgId || ''
                const sourceMessages = messagesToUpdate || currentMessages
                // 查找对应的临时消息（按时间倒序找最新的匹配项）
                const tempIndex = sourceMessages.findIndex(m =>
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
                  messagesToUpdate = messagesToUpdate || [...currentMessages]
                  // 关键：更新 _id 为真实ID，并清除 isLocalImage 标记
                  const tempId = messagesToUpdate[tempIndex]._id
                  messagesToUpdate[tempIndex] = {
                    ...messagesToUpdate[tempIndex],
                    ...doc,
                    _id: doc._id,
                    isLocalImage: false,
                    create_time: doc.create_time,  // 同步服务器时间
                    sendStatus: doc.status === 'pending' ? 'reviewing' : 'sent'
                  }
                  if (this.data.playingVoiceId === tempId) {
                    this.setData({ playingVoiceId: doc._id })
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
            // init 事件仅在发现遗漏消息时才更新界面（去重保证安全）
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
                chatCache.scheduleWrite(currentNeedId, finalMessages, this.buildCacheTaskMeta())
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
                        } else if (newStatus === 'cancelled') {
                          chatCache.invalidate(currentNeedId)
                        } else {
                          // 其他状态变化(如 breaking)也写一次,刷新缓存里的 taskMeta
                          chatCache.scheduleWrite(currentNeedId, this.data.messages, this.buildCacheTaskMeta())
                        }
                      })
                      this.setData({
                        lastMessageId: 'bottom-anchor',
                        newMessageCount: 0
                      })
                      this.markMessagesRead()
                    } else if (snapshot.type === 'init') {
                      // init 事件补漏的消息：不自动滚动，只更新列表
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
            this.stopMediaStatusPolling()
            this.startMessagePolling()
          }
        })

      this.setData({
        watchListener: listener,
        lastWatchActivity: Date.now()
      })
      this._isStartingWatch = false
      this.startMediaStatusPolling()

      // 设置自动降级检测：3秒后检查是否有watch活动
      setTimeout(() => {
        const lastActivity = this.data.lastWatchActivity
        const now = Date.now()
        // 如果3秒内没有watch活动（包括init事件），且页面还开着，切换到轮询
        if (lastActivity && (now - lastActivity > 2500) && !this.data.messagePollingInterval) {
          // 切换到轮询时保留已处理消息ID，避免重复加载
          this.stopMessageWatch(true)
          this.stopMediaStatusPolling()
          this.startMessagePolling()
        }
      }, 3000)

    } catch (err) {
      console.error('启动监听异常:', err)
      this._isStartingWatch = false
      this.stopMediaStatusPolling()
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
    this.stopMediaStatusPolling()
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
      if ((result.data.status || 'pending') === 'pending') {
        this.startMediaStatusPolling()
      }

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

    const trustedContext = source === 'camera' ? await this.prepareTrustedPhotoContext() : null

    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: [source],
      success: (res) => {
        this.uploadImage(res.tempFilePaths[0], {
          source,
          trustedContext
        })
      }
    })
  },

  // 可信现场照辅助方法
  // 准备拍照可信上下文：位置失败时降级为普通照片，不阻断发送。
  async prepareTrustedPhotoContext() {
    try {
      let location = app.getUserLocation && app.getUserLocation()
      if (!location || Date.now() - (location.updateTime || 0) > 2 * 60 * 1000) {
        location = await app.updateUserLocation()
      }

      if (!location || !location.latitude || !location.longitude) {
        return null
      }

      const locationName = await this.resolveTrustedLocationName(location)

      return {
        locationName,
        latitude: Number(location.latitude),
        longitude: Number(location.longitude)
      }
    } catch (err) {
      console.warn('获取拍照位置失败，按普通图片发送:', err.errMsg || err.message || err)
      wx.showToast({ title: '未获取到位置，将按普通图片发送', icon: 'none' })
      return null
    }
  },

  async resolveTrustedLocationName(location) {
    const fallbackName = this.data.task.locationName || this.data.task.location?.name || '现场位置'
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-geo',
        data: {
          action: 'reverseGeocode',
          longitude: Number(location.longitude),
          latitude: Number(location.latitude)
        }
      })

      if (result && result.code === 0 && result.data && result.data.address) {
        return result.data.address
      }
    } catch (err) {
      console.warn('当前位置地名解析失败，使用任务地点名:', err.errMsg || err.message || err)
    }

    return fallbackName
  },

  buildTrustedPhotoContext(preparedContext) {
    const capturedAt = new Date()
    const taskNo = this.data.task.taskNo || ''

    return {
      ...preparedContext,
      capturedAt: capturedAt.toISOString(),
      displayTime: this.formatWatermarkDateTime(capturedAt),
      needShortId: taskNo ? String(taskNo).toUpperCase() : '',
      nonce: Math.random().toString(36).slice(2, 10)
    }
  },

  formatWatermarkDateTime(date) {
    const d = new Date(date)
    const year = d.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const hours = String(d.getHours()).padStart(2, '0')
    const minutes = String(d.getMinutes()).padStart(2, '0')
    return `${year}-${month}-${day} ${hours}:${minutes}`
  },

  truncateWatermarkText(text, maxLength) {
    const value = String(text || '')
    if (value.length <= maxLength) {
      return value
    }
    return value.slice(0, maxLength - 1) + '…'
  },

  // 给拍照图片生成可见水印和低透明度暗水印。
  async createTrustedWatermarkImage(filePath, trustedContext) {
    if (!trustedContext) {
      return { filePath, imageWidth: 0, imageHeight: 0, watermarkInfo: null }
    }

    const imgInfo = await wx.getImageInfo({ src: filePath })
    const width = Math.max(1, imgInfo.width || 0)
    const height = Math.max(1, imgInfo.height || 0)

    await new Promise(resolve => {
      this.setData({
        watermarkCanvasWidth: width,
        watermarkCanvasHeight: height
      }, resolve)
    })

    const ctx = wx.createCanvasContext('trustedPhotoCanvas', this)
    ctx.clearRect(0, 0, width, height)
    ctx.drawImage(filePath, 0, 0, width, height)

    const shortCoord = `${trustedContext.latitude.toFixed(5)},${trustedContext.longitude.toFixed(5)}`
    const hiddenCode = `WDD|${this.currentNeedId}|${trustedContext.capturedAt}|${shortCoord}|${trustedContext.nonce}`

    ctx.save()
    ctx.setGlobalAlpha(0.08)
    ctx.setFillStyle('#ffffff')
    ctx.setFontSize(Math.max(18, Math.round(width * 0.035)))
    ctx.translate(width / 2, height / 2)
    ctx.rotate(-Math.PI / 6)
    const stepX = Math.max(260, Math.round(width * 0.45))
    const stepY = Math.max(180, Math.round(height * 0.22))
    for (let x = -width; x <= width; x += stepX) {
      for (let y = -height; y <= height; y += stepY) {
        ctx.fillText(hiddenCode, x, y)
      }
    }
    ctx.restore()

    const panelHeight = Math.max(116, Math.round(height * 0.12))
    const padding = Math.max(24, Math.round(width * 0.028))
    const bottom = height - panelHeight
    const titleSize = Math.max(26, Math.round(width * 0.038))
    const textSize = Math.max(20, Math.round(width * 0.028))

    ctx.setFillStyle('rgba(0, 0, 0, 0.52)')
    ctx.fillRect(0, bottom, width, panelHeight)
    ctx.setFillStyle('#ffffff')
    ctx.setFontSize(titleSize)
    ctx.fillText('问当地 现场拍摄', padding, bottom + padding + titleSize)
    ctx.setFontSize(textSize)
    ctx.fillText(`时间 ${trustedContext.displayTime}`, padding, bottom + padding + titleSize + textSize + 14)
    ctx.fillText(`地点 ${this.truncateWatermarkText(trustedContext.locationName, 28)}`, padding, bottom + padding + titleSize + textSize * 2 + 28)

    ctx.setFillStyle('rgba(255, 255, 255, 0.78)')
    ctx.setFontSize(Math.max(18, Math.round(width * 0.024)))
    const codeText = trustedContext.needShortId ? `任务 ${trustedContext.needShortId}` : '可信现场照'
    ctx.setTextAlign('right')
    ctx.fillText(codeText, width - padding, bottom + padding + titleSize)
    ctx.setTextAlign('left')

    const watermarkedPath = await new Promise((resolve, reject) => {
      ctx.draw(false, () => {
        wx.canvasToTempFilePath({
          canvasId: 'trustedPhotoCanvas',
          destWidth: width,
          destHeight: height,
          fileType: 'jpg',
          quality: 0.9,
          success: res => resolve(res.tempFilePath),
          fail: reject
        }, this)
      })
    })

    return {
      filePath: watermarkedPath,
      imageWidth: width,
      imageHeight: height,
      watermarkInfo: {
        capturedAt: trustedContext.capturedAt,
        locationName: trustedContext.locationName,
        latitude: trustedContext.latitude,
        longitude: trustedContext.longitude,
        needShortId: trustedContext.needShortId,
        nonce: trustedContext.nonce,
        hiddenCode
      }
    }
  },
  // 上传图片
  async uploadImage(filePath, options = {}) {
    const { task, userInfo } = this.data

    // 关键：使用 currentNeedId 确保发送给正确的任务
    const currentNeedId = this.currentNeedId
    const imageSource = options.source || 'album'
    let uploadFilePath = filePath
    let watermarkInfo = null
    let isTrustedPhoto = false
    if (!currentNeedId) {
      console.error('发送图片失败: 任务ID为空')
      return
    }

    // 获取图片尺寸
    let originalWidth = 0
    let originalHeight = 0
    if (imageSource === 'camera' && options.trustedContext) {
      try {
        const trustedContext = this.buildTrustedPhotoContext(options.trustedContext)
        const watermarked = await this.createTrustedWatermarkImage(filePath, trustedContext)
        uploadFilePath = watermarked.filePath
        watermarkInfo = watermarked.watermarkInfo
        isTrustedPhoto = !!watermarkInfo
      } catch (err) {
        console.error('生成可信水印失败，按普通图片发送:', err)
        wx.showToast({ title: '水印生成失败，将按普通图片发送', icon: 'none' })
      }
    }

    try {
      const imgInfo = await wx.getImageInfo({ src: uploadFilePath })
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
      imageUrl: uploadFilePath,
      create_time: now.toISOString(),
      isSelf: true,
      senderAvatar: userInfo.avatar,
      timeText: DateUtil.formatTime(now),
      showTime: showTime,
      isLocalImage: true,
      sendStatus: 'sending',
      reviewLoadingVisible: true,
      // 预计算显示尺寸
      imageWidth: displaySize.width,
      imageHeight: displaySize.height,
      imageSource,
      isTrustedPhoto,
      watermarkInfo,
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
    this.scheduleReviewLoadingHide(clientMsgId)

    try {
      // 上传到云存储
      const cloudPath = `chat-images/${Date.now()}-${Math.random().toString(36).substr(2, 6)}.jpg`
      const uploadResult = await wx.cloud.uploadFile({
        cloudPath,
        filePath: uploadFilePath
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
          clientMsgId,
          imageSource,
          isTrustedPhoto,
          watermarkInfo
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
            status: result.data.status || 'pending',
            create_time: result.data.createTime || new Date().toISOString(),
            sendStatus: (result.data.status || 'pending') === 'pending' ? 'reviewing' : 'sent',
            reviewLoadingVisible: m.reviewLoadingVisible && (result.data.status || 'pending') === 'pending'
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
    const status = e.currentTarget.dataset.status
    const isSelf = e.currentTarget.dataset.isSelf === true || e.currentTarget.dataset.isSelf === 'true'
    if (status !== 'normal' && !isSelf) return
    const url = e.currentTarget.dataset.url
    const imageUrls = this.data.messages
      .filter(msg => msg.type === 'image' && msg.status !== 'violated' && msg.imageUrl)
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
    wx.showModal({
      title: '确认完成任务',
      content: '确认已获得所需信息？确认后任务将完成，悬赏金额将结算给帮助者。',
      confirmText: '确认',
      success: (res) => {
        if (res.confirm) {
          this.completeTask()
        }
      }
    })
  },

  // 从任务菜单点击完成：先关菜单，再开确认弹窗
  onCompleteMenuTap() {
    this.setData({ showTaskMenu: false }, () => {
      this.showCompleteConfirm()
    })
  },

  // 切换任务卡片更多菜单
  toggleTaskMenu() {
    this.setData({
      showTaskMenu: !this.data.showTaskMenu
    })
  },

  // 切换工具栏展开/收起状态
  toggleToolbar() {
    const newExpanded = !this.data.isToolbarExpanded
    this.setData({
      isToolbarExpanded: newExpanded,
      inputFocus: false,
      isInputFocused: false
    })
  },

  // 输入框获得焦点时收起工具栏
  onInputFocus() {
    // 如果工具栏展开，先收起工具栏
    // 不手动控制 inputFocus，让输入框自行管理焦点
    const nextData = { isInputFocused: true }
    if (this.data.isToolbarExpanded) nextData.isToolbarExpanded = false
    this.setData(nextData)

    // 如果当前不在底部或未读消息不为0，则滚动到底部 + 标记已读
    if (!this.data.isAtBottom || this.data.newMessageCount > 0) {
      this.setData({
        isAtBottom: true,
        newMessageCount: 0
      }, () => {
        this.setData({ lastMessageId: 'bottom-anchor' })
        this.markMessagesRead()
      })
    }
  },

  onInputBlur() {
    this.setData({
      inputFocus: false,
      isInputFocused: false
    })
  },

  // 完成任务
  async completeTask() {
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
          'task.statusText': '已完成',
          canCompleteTask: false
        })

        // 标记本地缓存为已完成，触发 FIFO 清理
        chatCache.markCompleted(currentNeedId)

        // 设置刷新标记
        app.globalData.refreshMyNeeds = true
        app.globalData.refreshMyTasks = true

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
    this.setData({ showTaskMenu: false })
    wx.navigateTo({
      url: `/pages/report/report?needId=${task._id}`
    })
  },

  // 跳转任务详情
  goToTaskDetail() {
    const { task } = this.data
    if (!task._id) return
    this.setData({ showTaskMenu: false })
    wx.navigateTo({
      url: `/pages/task-detail/task-detail?id=${task._id}`
    })
  },

  // 跳转对方公开资料
  goToPublicProfile(e) {
    // 优先使用消息中传入的 sender_id，后备使用 otherUser
    const userId = (e && e.currentTarget.dataset.userId) || (this.data.otherUser && this.data.otherUser._id)
    if (!userId) return
    wx.navigateTo({
      url: `/pages/public-profile/public-profile?userId=${userId}`
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
