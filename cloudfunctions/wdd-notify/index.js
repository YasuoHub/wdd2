// 云函数入口文件
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command
const $ = db.command.aggregate

// 主入口
exports.main = async (event, context) => {
  const { action } = event
  const wxContext = cloud.getWXContext()
  const OPENID = wxContext.OPENID

  try {
    switch (action) {
      case 'getMessageList':
        return await getMessageList(OPENID)
      case 'markAsRead':
        return await markAsRead(event, OPENID)
      case 'getUnreadCount':
        return await getUnreadCount(OPENID)
      case 'getTaskCounts':
        return await getTaskCounts(OPENID)
      default:
        return { code: -1, message: '未知操作' }
    }
  } catch (err) {
    console.error('操作失败:', err)
    return { code: -1, message: err.message }
  }
}

// 获取消息列表
async function getMessageList(OPENID) {
  // 获取当前用户
  const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
  if (userRes.data.length === 0) {
    return { code: -1, message: '用户不存在' }
  }
  const userId = userRes.data[0]._id

  // 1. 获取聊天会话列表
  const chatSessions = await getChatSessions(userId)

  // 2. 获取系统通知列表
  const systemList = await getSystemNotifications(userId)

  // 3. 计算未读数
  const chatUnread = chatSessions.reduce((sum, item) => sum + (item.unread || 0), 0)
  const systemUnread = systemList.filter(item => !item.is_read).length

  return {
    code: 0,
    data: {
      chatList: chatSessions,
      systemList: systemList,
      chatUnread,
      systemUnread,
      unreadCount: chatUnread + systemUnread
    }
  }
}

// 获取聊天会话列表
async function getChatSessions(userId) {
  // 获取用户相关的所有任务
  const [needsRes, takersRes] = await Promise.all([
    // 用户作为求助者的任务
    db.collection('wdd-needs').where({
      user_id: userId,
      status: _.in(['ongoing', 'completed'])
    }).get(),
    // 用户作为帮助者的任务
    db.collection('wdd-need-takers').where({
      taker_id: userId
    }).get()
  ])

  const myNeeds = needsRes.data
  const myTakers = takersRes.data

  // 获取所有相关的need_id
  const needIds = [
    ...myNeeds.map(n => n._id),
    ...myTakers.map(t => t.need_id)
  ]

  if (needIds.length === 0) {
    return []
  }

  // 获取每个会话的最新消息和未读数
  const sessions = await Promise.all(needIds.map(async (needId) => {
    // 获取任务信息
    const need = myNeeds.find(n => n._id === needId) ||
      await db.collection('wdd-needs').doc(needId).get().then(res => res.data)

    if (!need) return null

    // 判断是否求助者
    const isSeeker = need.user_id === userId

    // 获取最新消息
    const lastMessageRes = await db.collection('wdd-messages')
      .where({ need_id: needId })
      .orderBy('create_time', 'desc')
      .limit(1)
      .get()

    const lastMessage = lastMessageRes.data[0]

    // 获取未读数
    const unreadRes = await db.collection('wdd-messages').where({
      need_id: needId,
      receiver_id: userId,
      is_read: false
    }).count()

    // 格式化最后消息内容
    let lastMessageText = '暂无消息'
    let lastTime = need.create_time
    if (lastMessage) {
      lastTime = lastMessage.create_time
      if (lastMessage.type === 'text') {
        lastMessageText = lastMessage.content.length > 20
          ? lastMessage.content.substring(0, 20) + '...'
          : lastMessage.content
      } else if (lastMessage.type === 'image') {
        lastMessageText = '[图片]'
      }
    }

    return {
      needId: needId,
      title: need.description.length > 15
        ? need.description.substring(0, 15) + '...'
        : need.description,
      typeIcon: getTypeIcon(need.type),
      lastMessage: lastMessageText,
      lastTime: lastTime,
      needStatus: need.status,
      isSeeker: isSeeker,
      unread: unreadRes.total
    }
  }))

  // 过滤null，按最后消息时间排序
  return sessions
    .filter(s => s !== null)
    .sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime))
}

// 获取系统通知列表
async function getSystemNotifications(userId) {
  const notifyRes = await db.collection('wdd-notifications')
    .where({
      user_id: userId
    })
    .orderBy('create_time', 'desc')
    .limit(50)
    .get()

  return notifyRes.data
}

// 标记通知为已读
async function markAsRead(event, OPENID) {
  const { notificationId, type } = event

  // 获取当前用户
  const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
  if (userRes.data.length === 0) {
    return { code: -1, message: '用户不存在' }
  }
  const userId = userRes.data[0]._id

  if (type === 'chat') {
    // 标记聊天消息为已读
    await db.collection('wdd-messages').where({
      need_id: notificationId,
      receiver_id: userId,
      is_read: false
    }).update({
      data: {
        is_read: true
      }
    })
  } else {
    // 标记系统通知为已读
    await db.collection('wdd-notifications').doc(notificationId).update({
      data: {
        is_read: true,
        read_time: new Date()
      }
    })
  }

  return {
    code: 0,
    message: '已标记为已读'
  }
}

// 获取未读数
async function getUnreadCount(OPENID) {
  // 获取当前用户
  const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
  if (userRes.data.length === 0) {
    return { code: -1, message: '用户不存在' }
  }
  const userId = userRes.data[0]._id

  // 获取聊天未读数
  const chatUnreadRes = await db.collection('wdd-messages').where({
    receiver_id: userId,
    is_read: false
  }).count()

  // 获取系统通知未读数
  const systemUnreadRes = await db.collection('wdd-notifications').where({
    user_id: userId,
    is_read: false
  }).count()

  return {
    code: 0,
    data: {
      chatUnread: chatUnreadRes.total,
      systemUnread: systemUnreadRes.total,
      total: chatUnreadRes.total + systemUnreadRes.total
    }
  }
}

// 获取任务统计数量
async function getTaskCounts(OPENID) {
  try {
    // 获取当前用户
    const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
    if (userRes.data.length === 0) {
      return { code: -1, message: '用户不存在' }
    }
    const userId = userRes.data[0]._id

    // 获取我的求助数量（非取消状态的）
    const myNeedsRes = await db.collection('wdd-needs').where({
      user_id: userId,
      status: db.command.in(['pending', 'ongoing', 'completed'])
    }).count()

    // 获取我的接单数量
    const myTasksRes = await db.collection('wdd-need-takers').where({
      taker_id: userId,
      status: db.command.in(['ongoing', 'completed'])
    }).count()

    return {
      code: 0,
      data: {
        myNeedsCount: myNeedsRes.total,
        myTasksCount: myTasksRes.total
      }
    }
  } catch (err) {
    console.error('获取任务统计失败:', err)
    return { code: -1, message: '获取失败: ' + err.message }
  }
}

// 获取类型图标
function getTypeIcon(type) {
  const iconMap = {
    'weather': '🌤️',
    'traffic': '🚗',
    'shop': '🏪',
    'parking': '🅿️',
    'queue': '👥',
    'other': '📌'
  }
  return iconMap[type] || '📌'
}
