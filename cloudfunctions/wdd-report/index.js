// 举报云函数
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
      case 'submitReport':
        return await submitReport(event, OPENID)
      case 'cancelReport':
        return await cancelReport(event, OPENID)
      case 'getReportStatus':
        return await getReportStatus(event, OPENID)
      case 'submitSupplement':
        return await submitSupplement(event, OPENID)
      case 'getReportDetail':
        return await getReportDetail(event, OPENID)
      case 'checkSupplementTimeout':
        return await checkSupplementTimeout(event)
      case 'getMyReportList':
        return await getMyReportList(event, OPENID)
      case 'getReportDetailById':
        return await getReportDetailById(event, OPENID)
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
  const { needId, reportType, reportTypeLabel, reason, images } = event

  // 参数校验
  if (!needId || !reportType || !reason) {
    return { code: -1, message: '参数不完整' }
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
  const parties = await getTaskParties(needId, need)
  if (!isTaskParticipant(user._id, parties)) {
    return { code: -1, message: '只有任务双方可以发起举报' }
  }

  // 被举报方
  const otherUserId = user._id === parties.seekerId ? parties.takerId : parties.seekerId

  // 前置校验：仅进行中和已完成的任务可举报
  if (need.status === 'breaking') {
    return { code: -1, message: '任务已进入客服审核状态' }
  }
  if (need.status !== 'ongoing' && need.status !== 'completed') {
    return { code: -1, message: '当前任务状态不允许举报' }
  }

  // 检查当前用户是否已对该任务有过举报（含已撤销，一次机会）
  const existingReportRes = await db.collection('wdd-reports').where({
    need_id: needId,
    reporter_openid: OPENID
  }).get()
  if (existingReportRes.data.length > 0) {
    return { code: -1, message: '您已对该任务发起过举报（含已撤销），不可再次举报' }
  }

  // 时效校验：任务完成后 72 小时内可举报
  const now = new Date()
  const expireTime = new Date(need.expire_time)
  const deadline = new Date(expireTime.getTime() + 72 * 60 * 60 * 1000)
  if (now > deadline) {
    return { code: -1, message: '举报时效已过，任务完成后超过72小时无法举报' }
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
    const now = new Date()

    // 1. 创建举报记录（含补充材料字段初始值）
    const reportRes = await transaction.collection('wdd-reports').add({
      data: {
        need_id: needId,
        reporter_id: user._id,
        reporter_openid: OPENID,
        report_type: reportType,
        report_type_label: reportTypeLabel || '',
        reason: reason,
        images: images || [],
        supplement_id: null,
        supplement_type: null,
        supplement_reason: null,
        supplement_images: [],
        supplement_deadline: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        has_supplement: false,
        is_supplement_timeout: false,
        status: 'pending',
        previous_task_status: need.status,
        create_time: now,
        update_time: now
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

    // 4. 向被举报方发送站内消息通知（事务外）
    await sendReportNotice(need, user._id, reportRes._id, reportTypeLabel)

    // 5. 向聊天插入系统消息（事务外，触发双方聊天页面实时刷新 breaking 状态）
    if (otherUserId) {
      try {
        await db.collection('wdd-messages').add({
          data: {
            need_id: String(needId),
            sender_id: user._id,
            receiver_id: otherUserId,
            type: 'system',
            system_type: 'report_filed',
            content: '对方已发起举报，聊天暂时不可用',
            create_time: new Date()
          }
        })
      } catch (err) {
        console.error('插入举报系统消息失败:', err)
      }
    }

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

  // 校验：工单状态为 pending（客服未处理）
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

    // 3. 检查是否还有其他 pending 的举报或申诉工单
    const otherPendingReport = await db.collection('wdd-reports').where({
      need_id: report.need_id,
      status: 'pending',
      _id: _.neq(reportId)
    }).count()
    const otherPendingAppeal = await db.collection('wdd-appeals').where({
      need_id: report.need_id,
      status: 'pending'
    }).count()

    // 只有在没有其他 pending 工单时才恢复任务状态
    if (otherPendingReport.total === 0 && otherPendingAppeal.total === 0) {
      await transaction.collection('wdd-needs').doc(report.need_id).update({
        data: {
          status: report.previous_task_status || 'ongoing',
          has_report: false,
          has_appeal: false,
          update_time: new Date()
        }
      })
    } else {
      // 还有其他 pending 工单，只清除 has_report 标记（如果也没有其他 pending 举报）
      if (otherPendingReport.total === 0) {
        await transaction.collection('wdd-needs').doc(report.need_id).update({
          data: {
            has_report: false,
            update_time: new Date()
          }
        })
      }
    }

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
    need_id: needId,
    reporter_openid: OPENID
  }).orderBy('create_time', 'desc').limit(1).get()

  if (reportRes.data.length === 0) {
    return {
      code: 0,
      data: { hasReport: false }
    }
  }

  const report = reportRes.data[0]
  const canCancel = report.status === 'pending'

  return {
    code: 0,
    data: {
      hasReport: true,
      reportId: report._id,
      status: report.status,
      reportTypeValue: report.report_type,
      reportTypeLabel: report.report_type_label || report.report_type,
      reason: report.reason,
      createTime: report.create_time,
      canCancel: canCancel
    }
  }
}

// 向任务另一方发送举报通知
async function sendReportNotice(need, reporterId, reportId, reportTypeLabel) {
  try {
    const takerRes = await db.collection('wdd-need-takers')
      .where({ need_id: need._id })
      .orderBy('create_time', 'desc')
      .limit(1)
      .get()
    const taker = takerRes.data[0]

    const otherUserId = reporterId === need.user_id
      ? (taker ? taker.taker_id : null)
      : need.user_id

    if (!otherUserId) {
      console.warn('无法确定举报通知接收方')
      return
    }

    const reporterRes = await db.collection('wdd-users').doc(reporterId).get().catch(() => null)
    const reporterNickname = reporterRes ? reporterRes.data.nickname : '对方'

    const label = reportTypeLabel || '其他违规行为'

    const now = new Date()
    // 强制按北京时间 UTC+8 输出，避免云函数环境时区为 UTC 导致时间差 8 小时
    const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000)
    const timeStr = `${bj.getUTCFullYear()}-${String(bj.getUTCMonth() + 1).padStart(2, '0')}-${String(bj.getUTCDate()).padStart(2, '0')} ${String(bj.getUTCHours()).padStart(2, '0')}:${String(bj.getUTCMinutes()).padStart(2, '0')}`

    const taskNumber = need._id.toUpperCase()

    await db.collection('wdd-notifications').add({
      data: {
        user_id: otherUserId,
        type: 'report_notice',
        title: '举报通知',
        content: `【举报通知】用户"${reporterNickname}"于${timeStr}对任务「${need.type_name || '求助'}」（任务单号：${taskNumber}）发起举报，举报类型：${label}。请在24小时内提交反驳材料，超时未提交将视为放弃权利，平台将仅依据对方材料进行仲裁。`,
        need_id: need._id,
        report_id: reportId,
        is_read: false,
        create_time: new Date()
      }
    })
  } catch (err) {
    console.error('发送举报通知失败:', err)
  }
}

// 补充举报反驳材料（被举报方提交）
async function submitSupplement(event, OPENID) {
  const { reportId, reportType, reason, images } = event

  if (!reportId || !reason) {
    return { code: -1, message: '参数不完整' }
  }
  if (reason.length < 5 || reason.length > 300) {
    return { code: -1, message: '反驳理由需在5~300字之间' }
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

  // 获取举报记录
  const reportRes = await db.collection('wdd-reports').doc(reportId).get()
  if (!reportRes.data) {
    return { code: -1, message: '举报记录不存在' }
  }
  const report = reportRes.data
  if (report.status !== 'pending') {
    return { code: -1, message: '举报已处理或已撤销，无法补充材料' }
  }

  const parties = await getTaskParties(report.need_id)
  if (!parties.need) {
    return { code: -1, message: '任务不存在' }
  }

  // 校验：补充材料者必须是任务另一方
  if (!isCounterparty(user._id, report.reporter_id, parties)) {
    return { code: -1, message: '只有被举报方可以补充材料' }
  }

  const ticketRes = await db.collection('wdd-tickets').where({
    report_id: reportId
  }).limit(1).get()
  if (ticketRes.data.length === 0 || ticketRes.data[0].status !== 'pending') {
    return { code: -1, message: '工单已处理，无法补充材料' }
  }

  // 校验：在补充截止时间之前
  const now = new Date()
  const deadline = new Date(report.supplement_deadline)
  if (now > deadline) {
    return { code: -1, message: '补充材料截止时间已过' }
  }

  // 校验：对方未补充过
  if (report.has_supplement) {
    return { code: -1, message: '对方已补充过材料，不可重复提交' }
  }

  // 内容安全检测
  try {
    const checkRes = await cloud.openapi.security.msgSecCheck({
      content: reason,
      version: 2,
      scene: 2,
      openid: OPENID,
      title: '问当地举报反驳'
    })
    if (checkRes.errCode !== 0) {
      return { code: -1, message: '内容违规，无法提交' }
    }
  } catch (err) {
    console.error('内容安全检测失败:', err)
    return { code: -1, message: '内容审核失败，请稍后重试' }
  }

  // 更新举报记录
  const supplementData = {
    supplement_id: user._id,
    supplement_reason: reason,
    supplement_images: images || [],
    has_supplement: true,
    update_time: new Date()
  }
  if (reportType) {
    supplementData.supplement_type = reportType
  }

  await db.collection('wdd-reports').doc(reportId).update({
    data: supplementData
  })


  return {
    code: 0,
    message: '反驳材料提交成功'
  }
}

// 查询举报详情（供前端补充模式使用）
async function getReportDetail(event, OPENID) {
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

  // 按 reportId 精确查询
  const reportRes = await db.collection('wdd-reports').doc(reportId).get()
  if (!reportRes.data) {
    return { code: -1, message: '举报记录不存在' }
  }
  const report = reportRes.data

  // 校验任务参与者身份
  const needId = report.need_id
  const parties = await getTaskParties(needId)
  if (!parties.need) {
    return { code: -1, message: '任务不存在' }
  }
  if (!isTaskParticipant(user._id, parties)) {
    return { code: -1, message: '无权查看此举报' }
  }

  // 查询发起方信息
  const initiatorRes = await db.collection('wdd-users').doc(report.reporter_id).get().catch(() => null)
  const initiator = initiatorRes ? initiatorRes.data : null

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
  const deadline = new Date(report.supplement_deadline)
  const canSupplement = report.status === 'pending' &&
    report.reporter_id !== user._id &&
    !report.has_supplement &&
    !report.is_supplement_timeout &&
    now <= deadline

  // 计算是否可以撤销（客服处理前随时可撤销）
  const canCancel = report.status === 'pending' &&
    report.reporter_id === user._id

  // 计算当前用户作为补充方的已提交材料
  let mySupplement = null
  if (report.has_supplement && report.supplement_id === user._id) {
    mySupplement = {
      type: report.supplement_type,
      reason: report.supplement_reason,
      images: report.supplement_images || []
    }
  }

  return {
    code: 0,
    data: {
      hasReport: true,
      reportId: report._id,
      status: report.status,
      initiator: {
        id: report.reporter_id,
        nickname: initiator ? initiator.nickname : '未知用户',
        avatar: initiator ? initiator.avatar : '',
        typeValue: report.report_type,
        typeLabel: report.report_type_label || report.report_type,
        reason: report.reason,
        images: report.images || []
      },
      mySupplement: mySupplement,
      taskInfo: taskInfo,
      supplementDeadline: report.supplement_deadline,
      isSupplementTimeout: report.is_supplement_timeout,
      canSupplement: canSupplement,
      canCancel: canCancel,
      createTime: report.create_time
    }
  }
}

// 检查补充材料超时
async function checkSupplementTimeout(event) {
  const now = new Date()

  // 查找已超时但未标记的举报
  const reportRes = await db.collection('wdd-reports').where({
    has_supplement: false,
    is_supplement_timeout: false,
    supplement_deadline: _.lt(now)
  }).get()

  const results = []

  for (const report of reportRes.data) {
    try {
      // 标记超时
      await db.collection('wdd-reports').doc(report._id).update({
        data: {
          is_supplement_timeout: true,
          update_time: new Date()
        }
      })


      results.push({ reportId: report._id, status: 'timeout_marked' })
    } catch (err) {
      console.error(`标记举报超时失败 ${report._id}:`, err)
      results.push({ reportId: report._id, status: 'error', error: err.message })
    }
  }

  return {
    code: 0,
    message: `检查了 ${reportRes.data.length} 条举报，标记了 ${results.filter(r => r.status === 'timeout_marked').length} 条超时`,
    data: { results }
  }
}

// 查询我的举报列表
async function getMyReportList(event, OPENID) {
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

  // 查询举报列表
  const query = db.collection('wdd-reports').where({
    reporter_openid: OPENID,
    status: statusFilter
  }).orderBy('create_time', 'desc').skip(skip).limit(limit)

  const countQuery = db.collection('wdd-reports').where({
    reporter_openid: OPENID,
    status: statusFilter
  }).count()

  const [reportRes, countRes] = await Promise.all([query.get(), countQuery])

  const list = reportRes.data
  const hasMore = skip + list.length < countRes.total

  if (list.length === 0) {
    return { code: 0, data: { list: [], hasMore: false, total: 0 } }
  }

  // 批量查关联任务信息
  const needIds = [...new Set(list.map(r => r.need_id))]
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
  const enrichedList = list.map(r => ({
    _id: r._id,
    needId: r.need_id,
    reportType: r.report_type,
    reportTypeLabel: r.report_type_label || r.report_type,
    reason: r.reason,
    images: r.images || [],
    status: r.status,
    createTime: r.create_time,
    cancelTime: r.cancel_time || null,
    updateTime: r.update_time,
    taskInfo: needMap[r.need_id] || null
  }))

  return {
    code: 0,
    data: { list: enrichedList, hasMore, total: countRes.total }
  }
}

// 按 ID 查询举报详情
async function getReportDetailById(event, OPENID) {
  const { reportId } = event

  if (!reportId) {
    return { code: -1, message: '举报ID不能为空' }
  }

  const reportRes = await db.collection('wdd-reports').doc(reportId).get()
  if (!reportRes.data) {
    return { code: -1, message: '举报记录不存在' }
  }
  const report = reportRes.data

  // 只允许举报发起人查看
  if (report.reporter_openid !== OPENID) {
    return { code: -1, message: '无权查看此举报' }
  }

  return {
    code: 0,
    data: {
      _id: report._id,
      needId: report.need_id,
      reportType: report.report_type,
      reportTypeLabel: report.report_type_label || report.report_type,
      reason: report.reason,
      images: report.images || [],
      status: report.status,
      createTime: report.create_time,
      cancelTime: report.cancel_time || null,
      updateTime: report.update_time
    }
  }
}
