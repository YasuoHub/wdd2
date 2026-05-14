// 申诉云函数
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

async function getTaskParties(needId, loadedNeed) {
  const need = loadedNeed || (await db.collection('wdd-needs').doc(needId).get()).data
  if (!need) {
    return { need: null, seekerId: null, takerId: null }
  }

  const takerRes = await db.collection('wdd-need-takers')
    .where({ need_id: needId })
    .orderBy('create_time', 'desc')
    .limit(1)
    .get()
  const taker = takerRes.data[0] || null

  return {
    need,
    seekerId: need.user_id,
    takerId: taker ? taker.taker_id : null
  }
}

function isTaskParticipant(userId, parties) {
  return userId === parties.seekerId || userId === parties.takerId
}

function isCounterparty(userId, initiatorId, parties) {
  return isTaskParticipant(userId, parties) && userId !== initiatorId
}

exports.main = async (event, context) => {
  const { action } = event
  const wxContext = cloud.getWXContext()
  const OPENID = wxContext.OPENID

  if (!OPENID) {
    return { code: -1, message: '获取用户openid失败' }
  }

  try {
    switch (action) {
      case 'submitAppeal':
        return await submitAppeal(event, OPENID)
      case 'cancelAppeal':
        return await cancelAppeal(event, OPENID)
      case 'submitSupplement':
        return await submitSupplement(event, OPENID)
      case 'getAppealDetail':
        return await getAppealDetail(event, OPENID)
      case 'checkSupplementTimeout':
        return await checkSupplementTimeout(event)
      case 'getMyAppealList':
        return await getMyAppealList(event, OPENID)
      case 'getAppealDetailById':
        return await getAppealDetailById(event, OPENID)
      default:
        return { code: -1, message: '未知操作' }
    }
  } catch (err) {
    console.error('申诉操作失败:', err)
    return { code: -1, message: err.message }
  }
}

// 提交申诉
async function submitAppeal(event, OPENID) {
  const { needId, appealType, appealTypeLabel, reason, images, mode = 'initiate' } = event

  // 参数校验
  if (!needId || !appealType || !reason) {
    return { code: -1, message: '参数不完整' }
  }
  if (reason.length < 5 || reason.length > 300) {
    return { code: -1, message: '申诉理由需在5~300字之间' }
  }
  if (!images || images.length === 0 || images.length > 3) {
    return { code: -1, message: '请上传1~3张证据图片' }
  }

  // 获取当前用户
  const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
  if (userRes.data.length === 0) {
    return { code: -1, message: '用户不存在' }
  }
  const user = userRes.data[0]

  // 获取任务信息
  const needRes = await db.collection('wdd-needs').doc(needId).get()
  if (!needRes.data) {
    return { code: -1, message: '任务不存在' }
  }
  const need = needRes.data
  const parties = await getTaskParties(needId, need)
  if (!isTaskParticipant(user._id, parties)) {
    return { code: -1, message: '只有任务双方可以发起申诉' }
  }

  // 前置校验：仅已完成 或 客服裁决取消 的任务可申诉
  const isCompleted = need.status === 'completed'
  const isArbitrationCancelled = need.status === 'cancelled' && need.cancel_reason === 'arbitration_cancelled'
  if (!isCompleted && !isArbitrationCancelled) {
    return { code: -1, message: '当前任务状态不允许申诉' }
  }

  // 检查当前用户是否已对该任务有过申诉（含已撤销，一次机会）
  const existingAppealRes = await db.collection('wdd-appeals').where({
    need_id: needId,
    initiator_openid: OPENID
  }).get()
  if (existingAppealRes.data.length > 0) {
    return { code: -1, message: '您已对该任务发起过申诉（含已撤销），不可再次申诉' }
  }

  // 时效校验：任务结束后 2 小时内可申诉
  const now = new Date()
  const endTime = isCompleted ? new Date(need.complete_time) : new Date(need.cancel_time)
  const deadline = new Date(endTime.getTime() + 2 * 60 * 60 * 1000)
  if (now > deadline) {
    return { code: -1, message: '申诉时效已过，任务结束后超过2小时无法申诉' }
  }

  // 内容安全检测
  try {
    const checkRes = await cloud.openapi.security.msgSecCheck({
      content: reason,
      version: 2,
      scene: 2,
      openid: OPENID,
      title: '问当地申诉'
    })
    if (checkRes.errCode !== 0) {
      return { code: -1, message: '内容违规，无法提交' }
    }
  } catch (err) {
    console.error('内容安全检测失败:', err)
    return { code: -1, message: '内容审核失败，请稍后重试' }
  }

  // 开启事务
  const transaction = await db.startTransaction()

  try {
    // 1. 创建申诉记录
    const appealRes = await transaction.collection('wdd-appeals').add({
      data: {
        need_id: needId,
        initiator_id: user._id,
        initiator_openid: OPENID,
        initiator_type: appealType,
        initiator_type_label: appealTypeLabel || '',
        initiator_reason: reason,
        initiator_images: images || [],
        supplement_id: null,
        supplement_type: null,
        supplement_reason: null,
        supplement_images: [],
        supplement_deadline: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        has_supplement: false,
        is_supplement_timeout: false,
        status: 'pending',
        previous_task_status: need.status,
        create_time: new Date(),
        update_time: new Date()
      }
    })

    // 2. 创建工单记录
    const ticketRes = await transaction.collection('wdd-tickets').add({
      data: {
        type: 'appeal',
        need_id: needId,
        report_id: null,
        appeal_id: appealRes._id,
        status: 'pending',
        handler_id: null,
        result: null,
        create_time: new Date(),
        update_time: new Date()
      }
    })

    // 3. 更新任务状态
    await transaction.collection('wdd-needs').doc(needId).update({
      data: {
        status: 'breaking',
        has_appeal: true,
        was_appealed: true,
        update_time: new Date()
      }
    })

    await transaction.commit()

    // 4. 向另一方发送站内消息通知（事务外）
    await sendAppealNotice(need, user._id, appealRes._id)

    return {
      code: 0,
      message: '申诉提交成功',
      data: {
        appealId: appealRes._id,
        ticketId: ticketRes._id
      }
    }
  } catch (err) {
    await transaction.rollback()
    throw err
  }
}

// 撤销申诉（5分钟内可撤销1次）
async function cancelAppeal(event, OPENID) {
  const { appealId } = event

  if (!appealId) {
    return { code: -1, message: '申诉ID不能为空' }
  }

  // 获取当前用户
  const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
  if (userRes.data.length === 0) {
    return { code: -1, message: '用户不存在' }
  }
  const user = userRes.data[0]

  // 获取申诉记录
  const appealRes = await db.collection('wdd-appeals').doc(appealId).get()
  if (!appealRes.data) {
    return { code: -1, message: '申诉记录不存在' }
  }
  const appeal = appealRes.data

  // 校验：当前用户是发起者
  if (appeal.initiator_id !== user._id) {
    return { code: -1, message: '无权撤销此申诉' }
  }

  // 校验：工单状态为 pending（客服未处理）
  const ticketRes = await db.collection('wdd-tickets').where({
    appeal_id: appealId
  }).get()
  if (ticketRes.data.length === 0) {
    return { code: -1, message: '关联工单不存在' }
  }
  const ticket = ticketRes.data[0]
  if (ticket.status !== 'pending') {
    return { code: -1, message: '工单已被处理，无法撤销' }
  }

  // 开启事务
  const transaction = await db.startTransaction()

  try {
    // 1. 更新申诉记录状态
    await transaction.collection('wdd-appeals').doc(appealId).update({
      data: {
        status: 'cancelled',
        cancel_time: new Date(),
        update_time: new Date()
      }
    })

    // 2. 关闭工单
    await transaction.collection('wdd-tickets').doc(ticket._id).update({
      data: {
        status: 'closed',
        update_time: new Date()
      }
    })

    // 3. 检查是否还有其他 pending 的举报或申诉工单
    const otherPendingAppeal = await db.collection('wdd-appeals').where({
      need_id: appeal.need_id,
      status: 'pending',
      _id: _.neq(appealId)
    }).count()
    const otherPendingReport = await db.collection('wdd-reports').where({
      need_id: appeal.need_id,
      status: 'pending'
    }).count()

    // 只有在没有其他 pending 工单时才恢复任务状态
    if (otherPendingAppeal.total === 0 && otherPendingReport.total === 0) {
      await transaction.collection('wdd-needs').doc(appeal.need_id).update({
        data: {
          status: appeal.previous_task_status || 'ongoing',
          has_appeal: false,
          has_report: false,
          update_time: new Date()
        }
      })
    } else {
      // 还有其他 pending 工单，只清除 has_appeal 标记（如果也没有其他 pending 申诉）
      if (otherPendingAppeal.total === 0) {
        await transaction.collection('wdd-needs').doc(appeal.need_id).update({
          data: {
            has_appeal: false,
            update_time: new Date()
          }
        })
      }
    }

    await transaction.commit()

    return {
      code: 0,
      message: '申诉已撤销，任务恢复正常',
      data: { appealId }
    }
  } catch (err) {
    await transaction.rollback()
    throw err
  }
}

// 补充申诉材料
async function submitSupplement(event, OPENID) {
  const { appealId, appealType, reason, images } = event

  if (!appealId || !reason) {
    return { code: -1, message: '参数不完整' }
  }
  if (reason.length < 5 || reason.length > 300) {
    return { code: -1, message: '申诉理由需在5~300字之间' }
  }
  if (!images || images.length === 0 || images.length > 3) {
    return { code: -1, message: '请上传1~3张证据图片' }
  }

  // 获取当前用户
  const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
  if (userRes.data.length === 0) {
    return { code: -1, message: '用户不存在' }
  }
  const user = userRes.data[0]

  // 获取申诉记录
  const appealRes = await db.collection('wdd-appeals').doc(appealId).get()
  if (!appealRes.data) {
    return { code: -1, message: '申诉记录不存在' }
  }
  const appeal = appealRes.data
  if (appeal.status !== 'pending') {
    return { code: -1, message: '申诉已处理或已撤销，无法补充材料' }
  }

  const parties = await getTaskParties(appeal.need_id)
  if (!parties.need) {
    return { code: -1, message: '任务不存在' }
  }

  // 校验：补充材料者必须是任务另一方
  if (!isCounterparty(user._id, appeal.initiator_id, parties)) {
    return { code: -1, message: '只有被申诉方可以补充材料' }
  }

  const ticketRes = await db.collection('wdd-tickets').where({
    appeal_id: appealId
  }).limit(1).get()
  if (ticketRes.data.length === 0 || ticketRes.data[0].status !== 'pending') {
    return { code: -1, message: '工单已处理，无法补充材料' }
  }

  // 校验：在补充截止时间之前
  const now = new Date()
  const deadline = new Date(appeal.supplement_deadline)
  if (now > deadline) {
    return { code: -1, message: '补充材料截止时间已过' }
  }

  // 校验：对方未补充过
  if (appeal.has_supplement) {
    return { code: -1, message: '对方已补充过材料，不可重复提交' }
  }

  // 内容安全检测
  try {
    const checkRes = await cloud.openapi.security.msgSecCheck({
      content: reason,
      version: 2,
      scene: 2,
      openid: OPENID,
      title: '问当地申诉补充'
    })
    if (checkRes.errCode !== 0) {
      return { code: -1, message: '内容违规，无法提交' }
    }
  } catch (err) {
    console.error('内容安全检测失败:', err)
    return { code: -1, message: '内容审核失败，请稍后重试' }
  }

  // 更新申诉记录
  const supplementData = {
    supplement_id: user._id,
    supplement_reason: reason,
    supplement_images: images || [],
    has_supplement: true,
    update_time: new Date()
  }
  // 如果传了申诉类型，也保存
  if (appealType) {
    supplementData.supplement_type = appealType
  }

  await db.collection('wdd-appeals').doc(appealId).update({
    data: supplementData
  })

  return {
    code: 0,
    message: '补充材料提交成功'
  }
}

// 查询申诉详情
async function getAppealDetail(event, OPENID) {
  const { appealId } = event

  if (!appealId) {
    return { code: -1, message: '申诉ID不能为空' }
  }

  // 获取当前用户
  const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
  if (userRes.data.length === 0) {
    return { code: -1, message: '用户不存在' }
  }
  const user = userRes.data[0]

  // 按 appealId 精确查询
  const appealRes = await db.collection('wdd-appeals').doc(appealId).get()
  if (!appealRes.data) {
    return { code: -1, message: '申诉记录不存在' }
  }
  const appeal = appealRes.data

  // 校验任务参与者身份
  const needId = appeal.need_id
  const parties = await getTaskParties(needId)
  if (!parties.need) {
    return { code: -1, message: '任务不存在' }
  }
  if (!isTaskParticipant(user._id, parties)) {
    return { code: -1, message: '无权查看此申诉' }
  }

  // 查询发起方信息
  const initiatorRes = await db.collection('wdd-users').doc(appeal.initiator_id).get().catch(() => null)
  const initiator = initiatorRes ? initiatorRes.data : null

  // 查询补充方信息
  let supplementUser = null
  if (appeal.supplement_id) {
    const supplementRes = await db.collection('wdd-users').doc(appeal.supplement_id).get().catch(() => null)
    supplementUser = supplementRes ? supplementRes.data : null
  }

  // 查询任务摘要信息
  let taskInfo = null
  try {
    const needRes = await db.collection('wdd-needs').doc(needId).get()
    if (needRes.data) {
      const need = needRes.data
      taskInfo = {
        _id: need._id,
        type: need.type,
        typeName: need.type_name || need.typeName || '',
        rewardAmount: need.reward_amount || need.rewardAmount || 0,
        status: need.status
      }
    }
  } catch (err) {
    console.error('获取任务摘要失败:', err)
  }

  // 计算是否可以补充材料
  const now = new Date()
  const deadline = new Date(appeal.supplement_deadline)
  const canSupplement = appeal.status === 'pending' &&
    appeal.initiator_id !== user._id &&
    !appeal.has_supplement &&
    !appeal.is_supplement_timeout &&
    now <= deadline

  // 计算是否可以撤销（客服处理前随时可撤销）
  const canCancel = appeal.status === 'pending' &&
    appeal.initiator_id === user._id

  // 计算当前用户作为补充方的已提交材料
  let mySupplement = null
  if (appeal.has_supplement && appeal.supplement_id === user._id) {
    mySupplement = {
      type: appeal.supplement_type,
      reason: appeal.supplement_reason,
      images: appeal.supplement_images || []
    }
  }

  return {
    code: 0,
    data: {
      hasAppeal: true,
      appealId: appeal._id,
      taskInfo: taskInfo,
      status: appeal.status,
      initiator: {
        id: appeal.initiator_id,
        nickname: initiator ? initiator.nickname : '未知用户',
        avatar: initiator ? initiator.avatar : '',
        typeValue: appeal.initiator_type,
        typeLabel: appeal.initiator_type_label || appeal.initiator_type,
        reason: appeal.initiator_reason,
        images: appeal.initiator_images || []
      },
      mySupplement: mySupplement,
      supplement: appeal.has_supplement ? {
        id: appeal.supplement_id,
        nickname: supplementUser ? supplementUser.nickname : '未知用户',
        avatar: supplementUser ? supplementUser.avatar : '',
        typeValue: appeal.supplement_type,
        typeLabel: appeal.supplement_type_label || appeal.supplement_type,
        reason: appeal.supplement_reason,
        images: appeal.supplement_images || []
      } : null,
      supplementDeadline: appeal.supplement_deadline,
      isSupplementTimeout: appeal.is_supplement_timeout,
      canSupplement: canSupplement,
      canCancel: canCancel,
      createTime: appeal.create_time
    }
  }
}

// 检查补充材料超时
async function checkSupplementTimeout(event) {
  const now = new Date()

  // 查找已超时但未标记的申诉
  const appealRes = await db.collection('wdd-appeals').where({
    has_supplement: false,
    is_supplement_timeout: false,
    supplement_deadline: _.lt(now)
  }).get()

  const results = []

  for (const appeal of appealRes.data) {
    try {
      // 标记超时
      await db.collection('wdd-appeals').doc(appeal._id).update({
        data: {
          is_supplement_timeout: true,
          update_time: new Date()
        }
      })


      results.push({ appealId: appeal._id, status: 'timeout_marked' })
    } catch (err) {
      console.error(`标记申诉超时失败 ${appeal._id}:`, err)
      results.push({ appealId: appeal._id, status: 'error', error: err.message })
    }
  }

  return {
    code: 0,
    message: `检查了 ${appealRes.data.length} 条申诉，标记了 ${results.filter(r => r.status === 'timeout_marked').length} 条超时`,
    data: { results }
  }
}

// 查询我的申诉列表
async function getMyAppealList(event, OPENID) {
  const { status, skip = 0, limit = 20 } = event

  // 构建状态筛选
  let statusFilter
  if (status === 'pending') {
    statusFilter = 'pending'
  } else if (status === 'processed') {
    statusFilter = _.in(['cancelled', 'resolved'])
  } else {
    return { code: -1, message: 'status 参数无效，可选值：pending / processed' }
  }

  // 查询申诉列表
  const query = db.collection('wdd-appeals').where({
    initiator_openid: OPENID,
    status: statusFilter
  }).orderBy('create_time', 'desc').skip(skip).limit(limit)

  const countQuery = db.collection('wdd-appeals').where({
    initiator_openid: OPENID,
    status: statusFilter
  }).count()

  const [appealRes, countRes] = await Promise.all([query.get(), countQuery])

  const list = appealRes.data
  const hasMore = skip + list.length < countRes.total

  if (list.length === 0) {
    return { code: 0, data: { list: [], hasMore: false, total: 0 } }
  }

  // 批量查关联任务信息
  const needIds = [...new Set(list.map(a => a.need_id))]
  const needRes = await db.collection('wdd-needs').where({
    _id: _.in(needIds)
  }).get()
  const needMap = {}
  needRes.data.forEach(n => {
    needMap[n._id] = {
      type: n.type,
      typeName: n.type_name || n.typeName || '',
      rewardAmount: n.reward_amount || n.rewardAmount || 0
    }
  })

  // 组装返回数据
  const enrichedList = list.map(a => ({
    _id: a._id,
    needId: a.need_id,
    appealType: a.initiator_type,
    appealTypeLabel: a.initiator_type_label || a.initiator_type,
    reason: a.initiator_reason,
    images: a.initiator_images || [],
    status: a.status,
    createTime: a.create_time,
    cancelTime: a.cancel_time || null,
    updateTime: a.update_time,
    taskInfo: needMap[a.need_id] || null
  }))

  return {
    code: 0,
    data: { list: enrichedList, hasMore, total: countRes.total }
  }
}

// 按 ID 查询申诉详情
async function getAppealDetailById(event, OPENID) {
  const { appealId } = event

  if (!appealId) {
    return { code: -1, message: '申诉ID不能为空' }
  }

  const appealRes = await db.collection('wdd-appeals').doc(appealId).get()
  if (!appealRes.data) {
    return { code: -1, message: '申诉记录不存在' }
  }
  const appeal = appealRes.data

  // 只允许申诉发起人查看
  if (appeal.initiator_openid !== OPENID) {
    return { code: -1, message: '无权查看此申诉' }
  }

  return {
    code: 0,
    data: {
      _id: appeal._id,
      needId: appeal.need_id,
      appealType: appeal.initiator_type,
      appealTypeLabel: appeal.initiator_type_label || appeal.initiator_type,
      reason: appeal.initiator_reason,
      images: appeal.initiator_images || [],
      status: appeal.status,
      createTime: appeal.create_time,
      cancelTime: appeal.cancel_time || null,
      updateTime: appeal.update_time
    }
  }
}

// 向任务另一方发送申诉通知
async function sendAppealNotice(need, initiatorId, appealId) {
  try {
    // 获取接单记录
    const takerRes = await db.collection('wdd-need-takers')
      .where({ need_id: need._id })
      .orderBy('create_time', 'desc')
      .limit(1)
      .get()
    const taker = takerRes.data[0]

    // 确定另一方用户ID
    const otherUserId = initiatorId === need.user_id
      ? (taker ? taker.taker_id : null)
      : need.user_id

    if (!otherUserId) {
      console.warn('无法确定申诉通知接收方')
      return
    }

    // 获取发起人信息
    const initiatorRes = await db.collection('wdd-users').doc(initiatorId).get().catch(() => null)
    const initiatorNickname = initiatorRes ? initiatorRes.data.nickname : '对方'

    // 获取申诉记录以取得申诉类型标签
    const appealRes = await db.collection('wdd-appeals').doc(appealId).get().catch(() => null)
    const label = appealRes ? (appealRes.data.initiator_type_label || appealRes.data.initiator_type) : '其他任务纠纷申诉'

    const now = new Date()
    // 强制按北京时间 UTC+8 输出，避免云函数环境时区为 UTC 导致时间差 8 小时
    const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000)
    const timeStr = `${bj.getUTCFullYear()}-${String(bj.getUTCMonth() + 1).padStart(2, '0')}-${String(bj.getUTCDate()).padStart(2, '0')} ${String(bj.getUTCHours()).padStart(2, '0')}:${String(bj.getUTCMinutes()).padStart(2, '0')}`

    const taskNumber = need._id.toUpperCase()

    await db.collection('wdd-notifications').add({
      data: {
        user_id: otherUserId,
        type: 'appeal_notice',
        title: '申诉通知',
        content: `【申诉通知】用户"${initiatorNickname}"于${timeStr}对任务「${need.type_name || '求助'}」（任务单号：${taskNumber}）发起申诉，申诉类型：${label}。请在24小时内补充提交申诉材料，超时未提交将视为放弃申诉权利，平台将仅依据对方材料进行仲裁。`,
        need_id: need._id,
        appeal_id: appealId,
        is_read: false,
        create_time: new Date()
      }
    })
  } catch (err) {
    console.error('发送申诉通知失败:', err)
  }
}
