// 举报云函数
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 举报类型映射（value → label），数据库存储 value，展示使用 label
const REPORT_TYPE_MAP = {
  offline_transaction: '诱导线下私下交易',
  verbal_abuse: '言语辱骂、骚扰人身攻击',
  fraud: '虚假承诺、恶意骗单',
  delay: '敷衍沟通、故意拖延进度',
  sensitive_content: '发布违规敏感内容',
  malicious_difficulty: '恶意刁难、无故拖延不配合',
  other_violation: '其他违规行为',
  false_info: '提供虚假实时信息（谎报天气/拥堵/营业状态）',
  location_mismatch: '接单后定位不符、不在求助地点',
  no_response: '恶意接单后不回复、不提供帮助'
}

// 根据 value 获取 label
function getReportTypeLabel(value) {
  return REPORT_TYPE_MAP[value] || value
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
      case 'submitReport':
        return await submitReport(event, OPENID)
      case 'cancelReport':
        return await cancelReport(event, OPENID)
      case 'getReportStatus':
        return await getReportStatus(event, OPENID)
      default:
        return { code: -1, message: '未知操作' }
    }
  } catch (err) {
    console.error('举报操作失败:', err)
    return { code: -1, message: err.message }
  }
}

// 提交举报
async function submitReport(event, OPENID) {
  const { needId, reportType, reason, images } = event

  // 参数校验
  if (!needId || !reportType || !reason) {
    return { code: -1, message: '参数不完整' }
  }
  if (!REPORT_TYPE_MAP[reportType]) {
    return { code: -1, message: '举报类型无效' }
  }
  if (reason.length < 5 || reason.length > 300) {
    return { code: -1, message: '举报理由需在5~300字之间' }
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
  if (need.status === 'breaking') {
    return { code: -1, message: '任务已进入客服审核状态' }
  }
  if (need.was_reported) {
    return { code: -1, message: '该任务已发起过举报，不可重复提交' }
  }

  // 时效校验：仅允许在 expire_time 或 expire_time + 2小时 内提交
  const now = new Date()
  const expireTime = new Date(need.expire_time)
  const deadline = new Date(expireTime.getTime() + 2 * 60 * 60 * 1000)
  if (now > deadline) {
    return { code: -1, message: '举报时效已过，任务结束后超过2小时无法举报' }
  }

  // 内容安全检测
  try {
    const checkRes = await cloud.openapi.security.msgSecCheck({
      content: reason,
      version: 2,
      scene: 2,
      openid: OPENID,
      title: '问当地举报'
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
    // 1. 创建举报记录
    const reportRes = await transaction.collection('wdd-reports').add({
      data: {
        need_id: needId,
        reporter_id: user._id,
        reporter_openid: OPENID,
        report_type: reportType,
        reason: reason,
        images: images || [],
        status: 'pending',
        create_time: new Date(),
        update_time: new Date()
      }
    })

    // 2. 创建工单记录
    const ticketRes = await transaction.collection('wdd-tickets').add({
      data: {
        type: 'report',
        need_id: needId,
        report_id: reportRes._id,
        appeal_id: null,
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
        has_report: true,
        was_reported: true,
        update_time: new Date()
      }
    })

    await transaction.commit()

    return {
      code: 0,
      message: '举报提交成功',
      data: {
        reportId: reportRes._id,
        ticketId: ticketRes._id
      }
    }
  } catch (err) {
    await transaction.rollback()
    throw err
  }
}

// 撤销举报（5分钟内可撤销1次）
async function cancelReport(event, OPENID) {
  const { reportId } = event

  if (!reportId) {
    return { code: -1, message: '举报ID不能为空' }
  }

  // 获取当前用户
  const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
  if (userRes.data.length === 0) {
    return { code: -1, message: '用户不存在' }
  }
  const user = userRes.data[0]

  // 获取举报记录
  const reportRes = await db.collection('wdd-reports').doc(reportId).get()
  if (!reportRes.data) {
    return { code: -1, message: '举报记录不存在' }
  }
  const report = reportRes.data

  // 校验：当前用户是发起者
  if (report.reporter_id !== user._id) {
    return { code: -1, message: '无权撤销此举报' }
  }

  // 校验：创建时间在 5 分钟内
  const createTime = new Date(report.create_time)
  const now = new Date()
  if (now.getTime() - createTime.getTime() > 5 * 60 * 1000) {
    return { code: -1, message: '撤销时效已过，提交后超过5分钟无法撤销' }
  }

  // 校验：工单状态为 pending
  const ticketRes = await db.collection('wdd-tickets').where({
    report_id: reportId
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
    // 1. 更新举报记录状态
    await transaction.collection('wdd-reports').doc(reportId).update({
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
    await transaction.collection('wdd-needs').doc(report.need_id).update({
      data: {
        status: 'ongoing',
        has_report: false,
        update_time: new Date()
      }
    })

    await transaction.commit()

    return {
      code: 0,
      message: '举报已撤销，任务恢复正常',
      data: { reportId }
    }
  } catch (err) {
    await transaction.rollback()
    throw err
  }
}

// 查询举报状态
async function getReportStatus(event, OPENID) {
  const { needId } = event

  if (!needId) {
    return { code: -1, message: '任务ID不能为空' }
  }

  const reportRes = await db.collection('wdd-reports').where({
    need_id: needId
  }).orderBy('create_time', 'desc').limit(1).get()

  if (reportRes.data.length === 0) {
    return {
      code: 0,
      data: { hasReport: false }
    }
  }

  const report = reportRes.data[0]
  const now = new Date()
  const createTime = new Date(report.create_time)
  const canCancel = report.status === 'pending' && (now.getTime() - createTime.getTime() <= 5 * 60 * 1000)

  return {
    code: 0,
    data: {
      hasReport: true,
      reportId: report._id,
      status: report.status,
      reportTypeValue: report.report_type,
      reportTypeLabel: getReportTypeLabel(report.report_type),
      reason: report.reason,
      createTime: report.create_time,
      canCancel: canCancel,
      cancelDeadline: new Date(createTime.getTime() + 5 * 60 * 1000)
    }
  }
}
