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

// 从 wdd-config 获取客服白名单
async function getCustomerServiceOpenids() {
  try {
    const configRes = await db.collection('wdd-config').doc('platform').get()
    return configRes.data.customer_service_openids || []
  } catch (e) {
    return []
  }
}

// 判断是否为客服
async function isCustomerService(OPENID) {
  const csOpenids = await getCustomerServiceOpenids()
  return csOpenids.includes(OPENID)
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

  // 第一批并行：当前用户 + 任务详情 + 接单记录 + 客服身份判断
  // 这四项互不依赖，可同时发起
  const [userRes, needRes, takerRes, isCs] = await Promise.all([
    db.collection('wdd-users').where({ openid: OPENID }).get(),
    db.collection('wdd-needs').doc(needId).get().catch(() => null),
    db.collection('wdd-need-takers').where({ need_id: needId }).get(),
    isCustomerService(OPENID)
  ])

  if (userRes.data.length === 0) {
    return { code: -1, message: '用户不存在' }
  }
  const currentUserId = userRes.data[0]._id

  if (!needRes || !needRes.data) {
    return { code: -1, message: '任务不存在' }
  }
  const need = needRes.data
  const taker = takerRes.data[0]

  const isSeeker = need.user_id === currentUserId
  const isTaker = taker && taker.taker_id === currentUserId

  if (!isSeeker && !isTaker && !isCs) {
    return { code: -1, message: '无权查看此任务' }
  }

  // 客服模式：纯客服（非任务参与者）返回双方信息，不含操作权限
  if (isCs) {
    const takerUserId = taker ? taker.taker_id : null
    const userIds = [need.user_id, takerUserId].filter(Boolean)

    // 查询双方用户信息
    const participantsRes = await Promise.all(
      userIds.map(uid => db.collection('wdd-users').doc(uid).get().catch(() => null))
    )

    const participants = {}
    participantsRes.forEach((res, i) => {
      if (res && res.data) {
        participants[userIds[i]] = {
          nickname: res.data.nickname || '',
          avatar: res.data.avatar || ''
        }
      }
    })

    return {
      code: 0,
      data: {
        ...need,
        role: 'customer_service',
        otherUser: null,
        participants,
        myReportStatus: { hasReport: false },
        myAppealStatus: { hasAppeal: false }
      }
    }
  }

  // 第二批并行：对方用户 + 举报状态 + 申诉状态
  const otherUserId = isSeeker ? taker?.taker_id : need.user_id

  const [otherUserRes, reportRes, appealRes] = await Promise.all([
    otherUserId
      ? db.collection('wdd-users').doc(otherUserId).get().catch(() => null)
      : Promise.resolve(null),
    db.collection('wdd-reports').where({
      need_id: needId,
      reporter_openid: OPENID
    }).orderBy('create_time', 'desc').limit(1).get().catch(() => ({ data: [] })),
    db.collection('wdd-appeals').where({
      need_id: needId,
      initiator_openid: OPENID
    }).orderBy('create_time', 'desc').limit(1).get().catch(() => ({ data: [] }))
  ])

  const otherUser = otherUserRes && otherUserRes.data ? otherUserRes.data : null
  const myReport = reportRes.data.length > 0 ? reportRes.data[0] : null
  const myAppeal = appealRes.data.length > 0 ? appealRes.data[0] : null

  const currentUser = userRes.data[0]

  // 根据角色计算双方头像和昵称
  let seekerNickname, seekerAvatar, takerNickname, takerAvatar
  if (isSeeker) {
    seekerNickname = currentUser.nickname
    seekerAvatar = currentUser.avatar
    takerNickname = otherUser?.nickname
    takerAvatar = otherUser?.avatar
  } else {
    seekerNickname = otherUser?.nickname
    seekerAvatar = otherUser?.avatar
    takerNickname = currentUser.nickname
    takerAvatar = currentUser.avatar
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
      } : null,
      seekerNickname,
      seekerAvatar,
      takerNickname,
      takerAvatar,
      // 当前用户的举报/申诉状态（个人级别）
      myReportStatus: myReport ? {
        hasReport: true,
        reportId: myReport._id,
        reportType: myReport.report_type,
        createTime: myReport.create_time
      } : { hasReport: false },
      myAppealStatus: myAppeal ? {
        hasAppeal: true,
        appealId: myAppeal._id,
        appealType: myAppeal.initiator_type,
        createTime: myAppeal.create_time
      } : { hasAppeal: false }
    }
  }
}

// 获取历史消息
async function getMessages(event, OPENID) {
  const { needId, limit = 20, beforeTime, afterTime } = event

  // 构建消息查询条件 - 必须同时满足 need_id 和 create_time（分页用）
  let msgQuery
  if (beforeTime && afterTime) {
    msgQuery = db.collection('wdd-messages').where({
      need_id: needId,
      create_time: _.and(_.gt(new Date(afterTime)), _.lt(new Date(beforeTime)))
    })
  } else if (beforeTime) {
    msgQuery = db.collection('wdd-messages').where({
      need_id: needId,
      create_time: _.lt(new Date(beforeTime))
    })
  } else if (afterTime) {
    msgQuery = db.collection('wdd-messages').where({
      need_id: needId,
      create_time: _.gt(new Date(afterTime))
    })
  } else {
    msgQuery = db.collection('wdd-messages').where({
      need_id: needId
    })
  }

  // 鉴权 + 消息查询全部并行（消息查询失败由 catch 兜底，鉴权失败再统一拒绝）
  const [userRes, needRes, takerRes, isCs, msgRes] = await Promise.all([
    db.collection('wdd-users').where({ openid: OPENID }).get(),
    db.collection('wdd-needs').doc(needId).get().catch(() => null),
    db.collection('wdd-need-takers').where({ need_id: needId }).orderBy('create_time', 'desc').limit(1).get(),
    isCustomerService(OPENID),
    msgQuery.orderBy('create_time', 'desc').limit(limit).get()
  ])

  if (userRes.data.length === 0) {
    return { code: -1, message: '用户不存在' }
  }
  const currentUserId = userRes.data[0]._id

  if (!needRes || !needRes.data) {
    return { code: -1, message: '任务不存在' }
  }
  const need = needRes.data
  const taker = takerRes.data[0]

  const isSeeker = need.user_id === currentUserId
  const isTaker = taker && taker.taker_id === currentUserId

  if (!isSeeker && !isTaker && !isCs) {
    return { code: -1, message: '无权查看消息' }
  }

  // 反转顺序（按时间正序排列）
  const messages = msgRes.data.reverse()

  // 标记已读 fire-and-forget：不 await，主流程立即返回。
  // 标记失败不影响用户阅读消息。
  if (!isCs) {
    markMessagesAsRead(needId, currentUserId).catch(err => {
      console.error('异步标记已读失败:', err)
    })
  }

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
// 单次批量 update，无需逐条循环。
async function markMessagesAsRead(needId, userId) {
  try {
    await db.collection('wdd-messages').where({
      need_id: needId,
      receiver_id: userId,
      is_read: false
    }).update({
      data: { is_read: true }
    })
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
