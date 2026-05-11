// 申诉云函数
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 申诉类型映射（value → label），数据库存储 value，展示使用 label
const APPEAL_TYPE_MAP = {
  unjust_rejection: '任务已完成被无故驳回',
  lost_contact: '对方失联拒不验收结算',
  unfair_judgment: '任务判定结果不合理',
  amount_dispute: '悬赏金额结算有异议',
  malicious_report: '被对方恶意举报诬陷',
  unjust_deduction: '保证金/权益无故被扣',
  other_dispute: '其他任务纠纷申诉',
  false_helper_info: '帮助者提供虚假信息导致任务无效',
  helper_location_mismatch: '帮助者定位不符无法完成帮助',
  malicious_rejection: '求助者恶意驳回已完成的信息帮助'
}

// 根据 value 获取 label
function getAppealTypeLabel(value) {
  return APPEAL_TYPE_MAP[value] || value
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
  const { needId, appealType, reason, images, mode = 'initiate' } = event

  // 参数校验
  if (!needId || !appealType || !reason) {
    return { code: -1, message: '参数不完整' }
  }
  if (!APPEAL_TYPE_MAP[appealType]) {
    return { code: -1, message: '申诉类型无效' }
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

  // 前置校验
  if (['breaking', 'completed', 'cancelled'].includes(need.status)) {
    return { code: -1, message: '当前任务状态不允许申诉' }
  }
  if (need.was_appealed) {
    return { code: -1, message: '该任务已发起过申诉，不可重复提交' }
  }

  // 时效校验：仅允许在 expire_time 或 expire_time + 2小时 内提交
  const now = new Date()
  const expireTime = new Date(need.expire_time)
  const deadline = new Date(expireTime.getTime() + 2 * 60 * 60 * 1000)
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

  // 校验：创建时间在 5 分钟内
  const createTime = new Date(appeal.create_time)
  const now = new Date()
  if (now.getTime() - createTime.getTime() > 5 * 60 * 1000) {
    return { code: -1, message: '撤销时效已过，提交后超过5分钟无法撤销' }
  }

  // 校验：工单状态为 pending
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

    // 3. 恢复任务状态
    await transaction.collection('wdd-needs').doc(appeal.need_id).update({
      data: {
        status: 'ongoing',
        has_appeal: false,
        update_time: new Date()
      }
    })

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

  if (!appealId || !appealType || !reason) {
    return { code: -1, message: '参数不完整' }
  }
  if (!APPEAL_TYPE_MAP[appealType]) {
    return { code: -1, message: '申诉类型无效' }
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

  // 校验：不是发起者（补充材料的是另一方）
  if (appeal.initiator_id === user._id) {
    return { code: -1, message: '申诉发起方无需补充材料' }
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
  await db.collection('wdd-appeals').doc(appealId).update({
    data: {
      supplement_id: user._id,
      supplement_type: appealType,
      supplement_reason: reason,
      supplement_images: images || [],
      has_supplement: true,
      update_time: new Date()
    }
  })

  // 向发起方发送站内消息通知
  await db.collection('wdd-notifications').add({
    data: {
      user_id: appeal.initiator_id,
      type: 'appeal_reminder',
      title: '申诉提醒',
      content: `您发起申诉的任务，对方已补充提交申诉材料，平台将综合双方材料进行仲裁。`,
      need_id: appeal.need_id,
      appeal_id: appealId,
      is_read: false,
      create_time: new Date()
    }
  })

  return {
    code: 0,
    message: '补充材料提交成功'
  }
}

// 查询申诉详情
async function getAppealDetail(event, OPENID) {
  const { needId } = event

  if (!needId) {
    return { code: -1, message: '任务ID不能为空' }
  }

  // 获取当前用户
  const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
  if (userRes.data.length === 0) {
    return { code: -1, message: '用户不存在' }
  }
  const user = userRes.data[0]

  // 获取申诉记录
  const appealRes = await db.collection('wdd-appeals').where({
    need_id: needId
  }).orderBy('create_time', 'desc').limit(1).get()

  if (appealRes.data.length === 0) {
    return {
      code: 0,
      data: { hasAppeal: false }
    }
  }

  const appeal = appealRes.data[0]

  // 查询发起方信息
  const initiatorRes = await db.collection('wdd-users').doc(appeal.initiator_id).get().catch(() => null)
  const initiator = initiatorRes ? initiatorRes.data : null

  // 查询补充方信息
  let supplementUser = null
  if (appeal.supplement_id) {
    const supplementRes = await db.collection('wdd-users').doc(appeal.supplement_id).get().catch(() => null)
    supplementUser = supplementRes ? supplementRes.data : null
  }

  // 计算是否可以补充材料
  const now = new Date()
  const deadline = new Date(appeal.supplement_deadline)
  const canSupplement = appeal.initiator_id !== user._id &&
    !appeal.has_supplement &&
    !appeal.is_supplement_timeout &&
    now <= deadline

  // 计算是否可以撤销
  const createTime = new Date(appeal.create_time)
  const canCancel = appeal.status === 'pending' &&
    appeal.initiator_id === user._id &&
    (now.getTime() - createTime.getTime() <= 5 * 60 * 1000)

  return {
    code: 0,
    data: {
      hasAppeal: true,
      appealId: appeal._id,
      status: appeal.status,
      initiator: {
        id: appeal.initiator_id,
        nickname: initiator ? initiator.nickname : '未知用户',
        avatar: initiator ? initiator.avatar : '',
        typeValue: appeal.initiator_type,
        typeLabel: getAppealTypeLabel(appeal.initiator_type),
        reason: appeal.initiator_reason,
        images: appeal.initiator_images || []
      },
      supplement: appeal.has_supplement ? {
        id: appeal.supplement_id,
        nickname: supplementUser ? supplementUser.nickname : '未知用户',
        avatar: supplementUser ? supplementUser.avatar : '',
        typeValue: appeal.supplement_type,
        typeLabel: getAppealTypeLabel(appeal.supplement_type),
        reason: appeal.supplement_reason,
        images: appeal.supplement_images || []
      } : null,
      supplementDeadline: appeal.supplement_deadline,
      isSupplementTimeout: appeal.is_supplement_timeout,
      canSupplement: canSupplement,
      canCancel: canCancel,
      cancelDeadline: new Date(createTime.getTime() + 5 * 60 * 1000),
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

      // 向发起方发送站内消息通知
      await db.collection('wdd-notifications').add({
        data: {
          user_id: appeal.initiator_id,
          type: 'appeal_reminder',
          title: '申诉提醒',
          content: `您发起申诉的任务，对方未在24小时内补充申诉材料，视为放弃申诉，平台将尽快依据您提交的材料完成仲裁。`,
          need_id: appeal.need_id,
          appeal_id: appeal._id,
          is_read: false,
          create_time: new Date()
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

    await db.collection('wdd-notifications').add({
      data: {
        user_id: otherUserId,
        type: 'appeal_notice',
        title: '申诉通知',
        content: `您参与的任务「${need.type_name || '求助'}」已被对方发起申诉，请在24小时内补充提交申诉材料，超时未提交将视为放弃申诉权利，平台将仅依据对方材料进行仲裁。`,
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
