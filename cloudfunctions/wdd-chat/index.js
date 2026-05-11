// 云函数入口文件
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

// 消息类型
const MSG_TYPE = {
  TEXT: 'text',
  IMAGE: 'image'
}

// 计算图片显示尺寸
function calculateDisplaySize(width, height) {
  const maxWidth = 400  // rpx
  const maxHeight = 500 // rpx

  // 如果没有尺寸信息，返回默认值
  if (!width || !height || width <= 0 || height <= 0) {
    return { width: maxWidth, height: maxHeight }
  }

  // 计算缩放比例
  const scale = Math.min(maxWidth / width, maxHeight / height, 1)

  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale)
  }
}


// 主入口
exports.main = async (event, context) => {
  const { action } = event
  const wxContext = cloud.getWXContext()
  const OPENID = wxContext.OPENID

  try {
    switch (action) {
      case 'getTaskInfo':
        return await getTaskInfo(event, OPENID)
      case 'getMessages':
        return await getMessages(event, OPENID)
      case 'sendMessage':
        return await sendMessage(event, OPENID)
      default:
        return { code: -1, message: '未知操作' }
    }
  } catch (err) {
    console.error('操作失败:', err)
    return { code: -1, message: err.message }
  }
}

// 获取任务信息
async function getTaskInfo(event, OPENID) {
  const { needId } = event

  // 获取当前用户
  const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
  if (userRes.data.length === 0) {
    return { code: -1, message: '用户不存在' }
  }
  const currentUserId = userRes.data[0]._id

  // 获取任务详情
  const needRes = await db.collection('wdd-needs').doc(needId).get()
  const need = needRes.data

  if (!need) {
    return { code: -1, message: '任务不存在' }
  }

  // 检查权限（只有求助者或接单者可以查看）
  const isSeeker = need.user_id === currentUserId

  // 获取接单记录
  const takerRes = await db.collection('wdd-need-takers').where({
    need_id: needId
  }).get()
  const taker = takerRes.data[0]

  const isTaker = taker && taker.taker_id === currentUserId

  if (!isSeeker && !isTaker) {
    return { code: -1, message: '无权查看此任务' }
  }

  // 获取对方用户信息
  const otherUserId = isSeeker ? taker?.taker_id : need.user_id
  let otherUser = null

  if (otherUserId) {
    const otherUserRes = await db.collection('wdd-users').doc(otherUserId).get()
    otherUser = otherUserRes.data || null
  }

  return {
    code: 0,
    data: {
      ...need,
      role: isSeeker ? 'seeker' : 'taker',
      otherUser: otherUser ? {
        _id: otherUser._id,
        nickname: otherUser.nickname,
        avatar: otherUser.avatar,
        rating: otherUser.rating || 5.0,
        rating_count: otherUser.rating_count || 0
      } : null,
      // 举报/申诉相关字段
      was_reported: need.was_reported || false,
      was_appealed: need.was_appealed || false,
      has_report: need.has_report || false,
      has_appeal: need.has_appeal || false
    }
  }
}

// 获取历史消息
async function getMessages(event, OPENID) {
  const { needId, limit = 20, beforeTime, afterTime } = event

  // 获取当前用户
  const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
  if (userRes.data.length === 0) {
    return { code: -1, message: '用户不存在' }
  }
  const currentUserId = userRes.data[0]._id

  // 验证权限
  const needRes = await db.collection('wdd-needs').doc(needId).get().catch(() => null)
  if (!needRes || !needRes.data) {
    return { code: -1, message: '任务不存在' }
  }

  const need = needRes.data
  const takerRes = await db.collection('wdd-need-takers').where({ need_id: needId }).orderBy('create_time', 'desc').limit(1).get()
  const taker = takerRes.data[0]

  const isSeeker = need.user_id === currentUserId
  const isTaker = taker && taker.taker_id === currentUserId

  if (!isSeeker && !isTaker) {
    return { code: -1, message: '无权查看消息' }
  }

  // 构建查询条件 - 必须同时满足 need_id 和 create_time（分页用）
  let query
  if (beforeTime && afterTime) {
    // 既指定了beforeTime又指定了afterTime（用于获取中间段消息，一般不会用到）
    console.log('查询条件: need_id=', needId, ', create_time between', afterTime, 'and', beforeTime)
    query = db.collection('wdd-messages').where({
      need_id: needId,
      create_time: _.and(_.gt(new Date(afterTime)), _.lt(new Date(beforeTime)))
    })
  } else if (beforeTime) {
    // 向上滚动加载历史消息（比beforeTime更早的消息）
    console.log('查询条件: need_id=', needId, ', create_time <', beforeTime)
    query = db.collection('wdd-messages').where({
      need_id: needId,
      create_time: _.lt(new Date(beforeTime))
    })
  } else if (afterTime) {
    // 轮询获取新消息（比afterTime更晚的消息）
    console.log('查询条件: need_id=', needId, ', create_time >', afterTime)
    query = db.collection('wdd-messages').where({
      need_id: needId,
      create_time: _.gt(new Date(afterTime))
    })
  } else {
    // 首次加载，无时间限制
    console.log('查询条件: need_id=', needId, ', 无时间限制')
    query = db.collection('wdd-messages').where({
      need_id: needId
    })
  }

  // 执行查询
  const msgRes = await query
    .orderBy('create_time', 'desc')
    .limit(limit)
    .get()

  // 反转顺序（按时间正序排列）
  const messages = msgRes.data.reverse()

  // 标记消息为已读
  await markMessagesAsRead(needId, currentUserId)

  return {
    code: 0,
    data: {
      list: messages,
      total: messages.length
    }
  }
}

// 发送消息
async function sendMessage(event, OPENID) {
  const {
    needId,
    type,
    content,
    imageUrl,
    imageWidth: clientWidth,
    imageHeight: clientHeight,
    clientMsgId
  } = event

  // 验证参数
  if (!needId || !type) {
    return { code: -1, message: '参数错误' }
  }

  if (type === MSG_TYPE.TEXT && !content) {
    return { code: -1, message: '消息内容不能为空' }
  }

  if (type === MSG_TYPE.IMAGE && !imageUrl) {
    return { code: -1, message: '图片不能为空' }
  }

  // 获取当前用户
  const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
  if (userRes.data.length === 0) {
    return { code: -1, message: '用户不存在' }
  }
  const currentUserId = userRes.data[0]._id

  // 验证任务状态和权限
  const needRes = await db.collection('wdd-needs').doc(needId).get().catch(() => null)
  if (!needRes || !needRes.data) {
    return { code: -1, message: '任务不存在' }
  }

  const need = needRes.data

  // 检查任务状态
  if (need.status === 'breaking') {
    return { code: -1, message: '任务已进入客服审核，无法发送消息' }
  }
  if (need.status !== 'ongoing') {
    return { code: -1, message: '任务已结束，无法发送消息' }
  }

  // 获取接单记录
  const takerRes = await db.collection('wdd-need-takers').where({ need_id: needId }).orderBy('create_time', 'desc').limit(1).get()
  const taker = takerRes.data[0]

  const isSeeker = need.user_id === currentUserId
  const isTaker = taker && taker.taker_id === currentUserId

  if (!isSeeker && !isTaker) {
    return { code: -1, message: '无权发送消息' }
  }

  // 确定接收者
  const receiverId = isSeeker ? taker.taker_id : need.user_id

  // 文字消息内容安全检测（v2）
  if (type === MSG_TYPE.TEXT) {
    try {
      const checkRes = await cloud.openapi.security.msgSecCheck({
        content: content,
        version: 2,
        scene: 2,
        openid: OPENID,
        title: '问当地聊天'
      })
      if (checkRes.errCode !== 0) {
        return { code: -1, message: '消息包含敏感内容，无法发送' }
      }
    } catch (err) {
      console.error('内容安全检测失败:', err)
      return { code: -1, message: '内容审核失败，请稍后重试' }
    }
  }

  // 图片消息：内容安全检测 + 获取并计算显示尺寸
  let imageDisplayWidth = 0
  let imageDisplayHeight = 0
  let checkTraceId = ''

  if (type === MSG_TYPE.IMAGE && imageUrl) {
    // 优先使用前端传来的图片尺寸
    const originalWidth = clientWidth || 0
    const originalHeight = clientHeight || 0

    // 计算显示尺寸
    const displaySize = calculateDisplaySize(originalWidth, originalHeight)
    imageDisplayWidth = displaySize.width
    imageDisplayHeight = displaySize.height

    // 异步图片内容安全检测
    try {
      const checkRes = await cloud.openapi.security.mediaCheckAsync({
        media_type: 2,
        media_url: imageUrl,
        version: 2,
        openid: OPENID,
        scene: 2
      })
      checkTraceId = checkRes.trace_id || ''
    } catch (err) {
      console.error('图片安全检测提交失败:', err)
    }
  }

  // 创建消息记录
  // 确保 need_id 是字符串类型，与前端监听查询保持一致
  const message = {
    need_id: String(needId),
    client_msg_id: clientMsgId || '',
    sender_id: currentUserId,
    receiver_id: receiverId,
    type: type,
    content: type === MSG_TYPE.TEXT ? content : '',
    image_url: type === MSG_TYPE.IMAGE ? imageUrl : '',
    // 图片显示尺寸（后端预计算）
    image_width: imageDisplayWidth,
    image_height: imageDisplayHeight,
    // 图片内容安全审核 trace_id，用于回调关联
    check_trace_id: checkTraceId,
    status: 'normal',
    is_read: false,
    create_time: new Date()
  }

  const msgRes = await db.collection('wdd-messages').add({
    data: message
  })

  // 更新最后消息时间
  await db.collection('wdd-need-takers').doc(taker._id).update({
    data: {
      last_message_time: new Date()
    }
  })

  // 注意：不再发送系统通知，避免通知过多
  // 用户通过消息页面的实时监听获取新消息

  return {
    code: 0,
    data: {
      messageId: msgRes._id,
      createTime: message.create_time
    }
  }
}

// 标记消息为已读
async function markMessagesAsRead(needId, userId) {
  try {
    const unreadMessages = await db.collection('wdd-messages').where({
      need_id: needId,
      receiver_id: userId,
      is_read: false
    }).get()

    const updatePromises = unreadMessages.data.map(msg => {
      return db.collection('wdd-messages').doc(msg._id).update({
        data: { is_read: true }
      })
    })

    await Promise.all(updatePromises)
  } catch (err) {
    console.error('标记已读失败:', err)
  }
}

// 发送消息通知
async function sendNotification(receiverId, senderId, need, msgType, content, imageUrl) {
  try {
    // 获取发送者信息
    const senderRes = await db.collection('wdd-users').doc(senderId).get()
    const sender = senderRes.data

    // 构建通知内容
    let messageContent = ''
    if (msgType === MSG_TYPE.TEXT) {
      messageContent = content.length > 20 ? content.substring(0, 20) + '...' : content
    } else {
      messageContent = '[图片]'
    }

    // 创建系统通知记录
    await db.collection('wdd-notifications').add({
      data: {
        user_id: receiverId,
        type: 'chat_message',
        title: `${sender?.nickname || '有人'}发来新消息`,
        content: messageContent,
        need_id: need._id,
        is_read: false,
        create_time: new Date()
      }
    })

    // 这里可以集成微信订阅消息通知
    // 需要用户授权后才能发送

  } catch (err) {
    console.error('发送通知失败:', err)
  }
}
