// 客服工单云函数
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

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

exports.main = async (event, context) => {
  const { action } = event
  const wxContext = cloud.getWXContext()
  const OPENID = wxContext.OPENID

  if (!OPENID) {
    return { code: -1, message: '获取用户openid失败' }
  }

  try {
    switch (action) {
      case 'getTicketList':
        return await getTicketList(event, OPENID)
      case 'getTicketDetail':
        return await getTicketDetail(event, OPENID)
      case 'submitArbitration':
        return await submitArbitration(event, OPENID)
      case 'autoCancelTimeout':
        return await autoCancelTimeout(event)
      default:
        return { code: -1, message: '未知操作' }
    }
  } catch (err) {
    console.error('工单操作失败:', err)
    return { code: -1, message: err.message }
  }
}

// 获取工单列表（仅客服可调用）
async function getTicketList(event, OPENID) {
  // 校验客服身份
  if (!await isCustomerService(OPENID)) {
    return { code: -1, message: '无权访问' }
  }

  const { status = 'pending', page = 1, pageSize = 20 } = event

  // 构建查询条件
  const where = { status }
  if (status === 'pending') {
    // 待处理包含 pending 和超时未处理的
  }

  // 查询工单
  const ticketRes = await db.collection('wdd-tickets')
    .where(where)
    .orderBy('create_time', 'asc') // 先按创建时间正序（早创建的先处理）
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get()

  // 获取关联的任务信息（用于排序和展示）
  const tickets = await Promise.all(ticketRes.data.map(async (ticket) => {
    // 获取任务信息
    const needRes = await db.collection('wdd-needs').doc(ticket.need_id).get().catch(() => null)
    const need = needRes ? needRes.data : null

    // 获取双方用户信息
    let seeker = null
    let taker = null
    if (need) {
      const seekerRes = await db.collection('wdd-users').doc(need.user_id).get().catch(() => null)
      seeker = seekerRes ? seekerRes.data : null

      const takerRes = await db.collection('wdd-need-takers')
        .where({ need_id: ticket.need_id })
        .orderBy('create_time', 'desc')
        .limit(1)
        .get()
      if (takerRes.data.length > 0) {
        const takerUserRes = await db.collection('wdd-users').doc(takerRes.data[0].taker_id).get().catch(() => null)
        taker = takerUserRes ? takerUserRes.data : null
      }
    }

    // 获取申诉补充状态（如果是申诉工单）
    let supplementStatus = ''
    if (ticket.type === 'appeal' && ticket.appeal_id) {
      const appealRes = await db.collection('wdd-appeals').doc(ticket.appeal_id).get().catch(() => null)
      if (appealRes && appealRes.data) {
        const appeal = appealRes.data
        if (appeal.has_supplement) {
          supplementStatus = '对方已补充材料'
        } else if (appeal.is_supplement_timeout) {
          supplementStatus = '对方超时未补充'
        } else {
          supplementStatus = '等待对方补充'
        }
      }
    }

    return {
      _id: ticket._id,
      type: ticket.type,
      needId: ticket.need_id,
      status: ticket.status,
      taskTitle: need ? need.type_name : '未知任务',
      taskNumber: need ? need._id.slice(-8).toUpperCase() : '',
      rewardAmount: need ? need.reward_amount : 0,
      expireTime: need ? need.expire_time : null,
      seekerNickname: seeker ? seeker.nickname : '未知用户',
      takerNickname: taker ? taker.nickname : '未知用户',
      supplementStatus,
      createTime: ticket.create_time
    }
  }))

  // 按任务过期时间倒序排列（剩余时间越短越靠前）
  tickets.sort((a, b) => {
    const timeA = a.expireTime ? new Date(a.expireTime).getTime() : 0
    const timeB = b.expireTime ? new Date(b.expireTime).getTime() : 0
    return timeA - timeB
  })

  return {
    code: 0,
    data: {
      list: tickets,
      total: tickets.length
    }
  }
}

// 获取工单详情
async function getTicketDetail(event, OPENID) {
  if (!await isCustomerService(OPENID)) {
    return { code: -1, message: '无权访问' }
  }

  const { ticketId } = event
  if (!ticketId) {
    return { code: -1, message: '工单ID不能为空' }
  }

  // 获取工单
  const ticketRes = await db.collection('wdd-tickets').doc(ticketId).get()
  if (!ticketRes.data) {
    return { code: -1, message: '工单不存在' }
  }
  const ticket = ticketRes.data

  // 获取任务信息
  const needRes = await db.collection('wdd-needs').doc(ticket.need_id).get().catch(() => null)
  const need = needRes ? needRes.data : null

  // 获取双方用户信息
  let seeker = null
  let taker = null
  if (need) {
    const seekerRes = await db.collection('wdd-users').doc(need.user_id).get().catch(() => null)
    seeker = seekerRes ? seekerRes.data : null

    const takerRes = await db.collection('wdd-need-takers')
      .where({ need_id: ticket.need_id })
      .orderBy('create_time', 'desc')
      .limit(1)
      .get()
    if (takerRes.data.length > 0) {
      const takerUserRes = await db.collection('wdd-users').doc(takerRes.data[0].taker_id).get().catch(() => null)
      taker = takerUserRes ? takerUserRes.data : null
    }
  }

  // 获取举报/申诉详情
  let reportDetail = null
  let appealDetail = null

  if (ticket.type === 'report' && ticket.report_id) {
    const reportRes = await db.collection('wdd-reports').doc(ticket.report_id).get().catch(() => null)
    if (reportRes && reportRes.data) {
      const report = reportRes.data
      const reporterRes = await db.collection('wdd-users').doc(report.reporter_id).get().catch(() => null)
      reportDetail = {
        type: report.report_type,
        reason: report.reason,
        images: report.images || [],
        reporterNickname: reporterRes ? reporterRes.data.nickname : '未知用户',
        createTime: report.create_time
      }
    }
  }

  if (ticket.type === 'appeal' && ticket.appeal_id) {
    const appealRes = await db.collection('wdd-appeals').doc(ticket.appeal_id).get().catch(() => null)
    if (appealRes && appealRes.data) {
      const appeal = appealRes.data
      const initiatorRes = await db.collection('wdd-users').doc(appeal.initiator_id).get().catch(() => null)
      appealDetail = {
        initiator: {
          nickname: initiatorRes ? initiatorRes.data.nickname : '未知用户',
          type: appeal.initiator_type,
          reason: appeal.initiator_reason,
          images: appeal.initiator_images || []
        },
        supplement: appeal.has_supplement ? {
          type: appeal.supplement_type,
          reason: appeal.supplement_reason,
          images: appeal.supplement_images || []
        } : null,
        supplementDeadline: appeal.supplement_deadline,
        isSupplementTimeout: appeal.is_supplement_timeout,
        createTime: appeal.create_time
      }
    }
  }

  return {
    code: 0,
    data: {
      ticket: {
        _id: ticket._id,
        type: ticket.type,
        status: ticket.status,
        createTime: ticket.create_time
      },
      task: need ? {
        _id: need._id,
        type: need.type,
        typeName: need.type_name,
        description: need.description,
        rewardAmount: need.reward_amount || 0,
        status: need.status,
        locationName: need.location_name,
        expireTime: need.expire_time,
        createTime: need.create_time
      } : null,
      seeker: seeker ? {
        _id: seeker._id,
        nickname: seeker.nickname,
        avatar: seeker.avatar,
        rating: seeker.rating || 5.0,
        ratingCount: seeker.rating_count || 0,
        creditScore: seeker.credit_score || 100
      } : null,
      taker: taker ? {
        _id: taker._id,
        nickname: taker.nickname,
        avatar: taker.avatar,
        rating: taker.rating || 5.0,
        ratingCount: taker.rating_count || 0,
        creditScore: taker.credit_score || 100
      } : null,
      reportDetail,
      appealDetail
    }
  }
}

// 提交裁决
async function submitArbitration(event, OPENID) {
  if (!await isCustomerService(OPENID)) {
    return { code: -1, message: '无权访问' }
  }

  const {
    ticketId,
    taskResult, // cancelled | completed | partial
    partialPercent, // 10 | 30 | 50 | 70（仅 partial 时有效）
    banInfo // { target: 'seeker'|'taker'|'both'|'none', duration: '1d'|'1w'|'1m'|'1y'|'permanent' }
  } = event

  if (!ticketId || !taskResult) {
    return { code: -1, message: '参数不完整' }
  }
  if (!['cancelled', 'completed', 'partial'].includes(taskResult)) {
    return { code: -1, message: '裁决结果无效' }
  }
  if (taskResult === 'partial' && ![10, 30, 50, 70].includes(partialPercent)) {
    return { code: -1, message: '分账比例无效' }
  }

  // 获取工单
  const ticketRes = await db.collection('wdd-tickets').doc(ticketId).get()
  if (!ticketRes.data) {
    return { code: -1, message: '工单不存在' }
  }
  const ticket = ticketRes.data

  if (ticket.status !== 'pending') {
    return { code: -1, message: '工单已处理' }
  }

  // 获取任务信息
  const needRes = await db.collection('wdd-needs').doc(ticket.need_id).get()
  if (!needRes.data) {
    return { code: -1, message: '任务不存在' }
  }
  const need = needRes.data

  // 获取接单记录
  const takerRes = await db.collection('wdd-need-takers')
    .where({ need_id: ticket.need_id })
    .orderBy('create_time', 'desc')
    .limit(1)
    .get()
  const takerRecord = takerRes.data[0]

  // 开启事务
  const transaction = await db.startTransaction()

  try {
    // 1. 更新工单状态
    await transaction.collection('wdd-tickets').doc(ticketId).update({
      data: {
        status: 'resolved',
        handler_id: OPENID,
        result: {
          task_result: taskResult,
          partial_percent: taskResult === 'partial' ? partialPercent : null,
          ban_info: banInfo || null
        },
        resolve_time: new Date(),
        update_time: new Date()
      }
    })

    // 2. 读取平台费率
    let feeRate = 0.15
    try {
      const configRes = await db.collection('wdd-config').doc('platform').get()
      feeRate = configRes.data.platform_fee_rate || 0.15
    } catch (e) {}

    const rewardAmount = need.reward_amount || 0

    // 3. 根据裁决结果处理资金和任务状态
    let seekerRefund = 0
    let takerIncome = 0
    let platformFee = 0
    let finalStatus = ''

    if (taskResult === 'cancelled') {
      // 取消任务：全额退款给求助者
      seekerRefund = rewardAmount
      takerIncome = 0
      platformFee = 0
      finalStatus = 'cancelled'

      // 更新求助者余额
      await transaction.collection('wdd-users').doc(need.user_id).update({
        data: {
          balance: _.inc(seekerRefund),
          update_time: new Date()
        }
      })

      // 创建退款流水
      const latestSeekerRes = await transaction.collection('wdd-users').doc(need.user_id).get()
      await transaction.collection('wdd-balance-records').add({
        data: {
          user_id: need.user_id,
          type: 'arbitration_refund',
          amount: seekerRefund,
          balance: latestSeekerRes.data.balance || seekerRefund,
          description: `客服裁决：任务取消，全额退款`,
          need_id: need._id,
          create_time: new Date()
        }
      })

      // 扣减帮助者信誉分 10 分
      await transaction.collection('wdd-users').doc(takerRecord.taker_id).update({
        data: {
          credit_score: _.inc(-10),
          update_time: new Date()
        }
      })

    } else if (taskResult === 'completed') {
      // 完成任务：正常结算
      platformFee = Math.round(rewardAmount * feeRate * 100) / 100
      takerIncome = Math.round((rewardAmount - platformFee) * 100) / 100
      seekerRefund = 0
      finalStatus = 'completed'

      // 更新帮助者余额
      await transaction.collection('wdd-users').doc(takerRecord.taker_id).update({
        data: {
          balance: _.inc(takerIncome),
          total_earned: _.inc(takerIncome),
          update_time: new Date()
        }
      })

      // 创建收入流水
      const latestTakerRes = await transaction.collection('wdd-users').doc(takerRecord.taker_id).get()
      await transaction.collection('wdd-balance-records').add({
        data: {
          user_id: takerRecord.taker_id,
          type: 'task_income',
          amount: takerIncome,
          balance: latestTakerRes.data.balance || takerIncome,
          description: `客服裁决：任务完成收入`,
          need_id: need._id,
          create_time: new Date()
        }
      })

      // 更新接单记录
      await transaction.collection('wdd-need-takers').doc(takerRecord._id).update({
        data: {
          status: 'completed',
          complete_time: new Date(),
          update_time: new Date()
        }
      })

      // 扣减求助者信誉分 10 分
      await transaction.collection('wdd-users').doc(need.user_id).update({
        data: {
          credit_score: _.inc(-10),
          update_time: new Date()
        }
      })

    } else if (taskResult === 'partial') {
      // 部分完成：按比例分配
      const takerRawIncome = Math.round(rewardAmount * partialPercent / 100 * 100) / 100
      platformFee = Math.round(takerRawIncome * feeRate * 100) / 100
      takerIncome = Math.round((takerRawIncome - platformFee) * 100) / 100
      seekerRefund = Math.round((rewardAmount - takerRawIncome) * 100) / 100
      finalStatus = 'completed'

      // 更新帮助者余额
      await transaction.collection('wdd-users').doc(takerRecord.taker_id).update({
        data: {
          balance: _.inc(takerIncome),
          total_earned: _.inc(takerIncome),
          update_time: new Date()
        }
      })

      // 更新求助者余额（退款部分）
      await transaction.collection('wdd-users').doc(need.user_id).update({
        data: {
          balance: _.inc(seekerRefund),
          update_time: new Date()
        }
      })

      // 创建流水
      const latestTakerRes = await transaction.collection('wdd-users').doc(takerRecord.taker_id).get()
      await transaction.collection('wdd-balance-records').add({
        data: {
          user_id: takerRecord.taker_id,
          type: 'task_income',
          amount: takerIncome,
          balance: latestTakerRes.data.balance || takerIncome,
          description: `客服裁决：部分完成(${partialPercent}%)收入`,
          need_id: need._id,
          create_time: new Date()
        }
      })

      const latestSeekerRes = await transaction.collection('wdd-users').doc(need.user_id).get()
      await transaction.collection('wdd-balance-records').add({
        data: {
          user_id: need.user_id,
          type: 'arbitration_refund',
          amount: seekerRefund,
          balance: latestSeekerRes.data.balance || seekerRefund,
          description: `客服裁决：部分完成，剩余退款`,
          need_id: need._id,
          create_time: new Date()
        }
      })

      // 更新接单记录
      await transaction.collection('wdd-need-takers').doc(takerRecord._id).update({
        data: {
          status: 'completed',
          complete_time: new Date(),
          update_time: new Date()
        }
      })

      // 部分完成：双方均不扣信誉分
    }

    // 4. 更新任务状态
    await transaction.collection('wdd-needs').doc(need._id).update({
      data: {
        status: finalStatus,
        platform_fee: platformFee,
        taker_income: takerIncome,
        update_time: new Date(),
        ...(taskResult === 'completed' ? { complete_time: new Date() } : {}),
        ...(taskResult === 'cancelled' ? { cancel_time: new Date(), cancel_reason: 'arbitration_cancelled' } : {})
      }
    })

    // 5. 处理封禁
    if (banInfo && banInfo.target !== 'none') {
      const banEndTime = calculateBanEndTime(banInfo.duration)
      const banData = {
        reason: `客服裁决：${taskResult === 'cancelled' ? '取消任务' : taskResult === 'completed' ? '完成任务' : '部分完成'}`,
        end_time: banEndTime,
        ticket_id: ticketId,
        create_time: new Date()
      }

      if (banInfo.target === 'seeker' || banInfo.target === 'both') {
        await transaction.collection('wdd-users').doc(need.user_id).update({
          data: { ban_status: banData, update_time: new Date() }
        })
      }
      if (banInfo.target === 'taker' || banInfo.target === 'both') {
        await transaction.collection('wdd-users').doc(takerRecord.taker_id).update({
          data: { ban_status: banData, update_time: new Date() }
        })
      }
    }

    await transaction.commit()

    // 6. 发送站内消息通知（事务外）
    await sendArbitrationNotifications(need, takerRecord, taskResult, partialPercent, takerIncome, seekerRefund, banInfo)

    return {
      code: 0,
      message: '裁决已提交',
      data: { ticketId, taskResult, takerIncome, seekerRefund }
    }

  } catch (err) {
    await transaction.rollback()
    throw err
  }
}

// 计算封禁结束时间
function calculateBanEndTime(duration) {
  const now = new Date()
  switch (duration) {
    case '1d': return new Date(now.getTime() + 24 * 60 * 60 * 1000)
    case '1w': return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
    case '1m': return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
    case '1y': return new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000)
    case 'permanent': return new Date('9999-12-31T23:59:59.999Z')
    default: return new Date(now.getTime() + 24 * 60 * 60 * 1000)
  }
}

// 发送裁决通知
async function sendArbitrationNotifications(need, takerRecord, taskResult, partialPercent, takerIncome, seekerRefund, banInfo) {
  const now = new Date()

  // 求助者通知
  let seekerContent = ''
  let takerContent = ''

  if (taskResult === 'cancelled') {
    seekerContent = `客服已裁决：任务取消，悬赏金额¥${seekerRefund}已退回您的平台余额。帮助者信誉分-10。`
    takerContent = `客服已裁决：任务取消，您未获得收入。您的信誉分-10。`
  } else if (taskResult === 'completed') {
    seekerContent = `客服已裁决：任务完成。帮助者获得¥${takerIncome}（已扣除平台服务费）。您的信誉分-10。`
    takerContent = `客服已裁决：任务完成，您获得¥${takerIncome}（已扣除平台服务费），已计入平台余额。求助者信誉分-10。`
  } else if (taskResult === 'partial') {
    seekerContent = `客服已裁决：部分完成(${partialPercent}%)。帮助者获得¥${takerIncome}，剩余¥${seekerRefund}已退回您的平台余额。双方均不扣信誉分。`
    takerContent = `客服已裁决：部分完成(${partialPercent}%)，您获得¥${takerIncome}，已计入平台余额。双方均不扣信誉分。`
  }

  // 封禁信息
  if (banInfo && banInfo.target !== 'none') {
    const isPermanent = banInfo.duration === 'permanent'
    const banText = isPermanent ? '永久封禁' : `封禁${banInfo.duration}`
    if (banInfo.target === 'seeker' || banInfo.target === 'both') {
      seekerContent += ` 您的账号已被${banText}。`
    }
    if (banInfo.target === 'taker' || banInfo.target === 'both') {
      takerContent += ` 您的账号已被${banText}。`
    }
  }

  // 发送求助者通知
  await db.collection('wdd-notifications').add({
    data: {
      user_id: need.user_id,
      type: 'arbitration_result',
      title: '客服裁决结果',
      content: seekerContent,
      need_id: need._id,
      is_read: false,
      create_time: now
    }
  })

  // 发送帮助者通知
  if (takerRecord) {
    await db.collection('wdd-notifications').add({
      data: {
        user_id: takerRecord.taker_id,
        type: 'arbitration_result',
        title: '客服裁决结果',
        content: takerContent,
        need_id: need._id,
        is_read: false,
        create_time: now
      }
    })
  }
}

// 超时自动裁决（48小时未处理自动取消）
async function autoCancelTimeout(event) {
  const now = new Date()
  const timeoutThreshold = new Date(now.getTime() - 48 * 60 * 60 * 1000)

  // 查找超时未处理的工单
  const ticketRes = await db.collection('wdd-tickets').where({
    status: 'pending',
    create_time: _.lt(timeoutThreshold)
  }).get()

  const results = []

  for (const ticket of ticketRes.data) {
    try {
      // 获取任务信息
      const needRes = await db.collection('wdd-needs').doc(ticket.need_id).get()
      if (!needRes.data) {
        results.push({ ticketId: ticket._id, status: 'need_not_found' })
        continue
      }
      const need = needRes.data

      // 获取接单记录
      const takerRes = await db.collection('wdd-need-takers')
        .where({ need_id: ticket.need_id })
        .orderBy('create_time', 'desc')
        .limit(1)
        .get()
      const takerRecord = takerRes.data[0]

      // 开启事务：取消任务，全额退款
      const transaction = await db.startTransaction()

      try {
        // 更新工单状态
        await transaction.collection('wdd-tickets').doc(ticket._id).update({
          data: {
            status: 'resolved',
            result: { task_result: 'cancelled', auto_cancelled: true },
            resolve_time: new Date(),
            update_time: new Date()
          }
        })

        // 更新任务状态
        await transaction.collection('wdd-needs').doc(need._id).update({
          data: {
            status: 'cancelled',
            cancel_time: new Date(),
            cancel_reason: 'arbitration_timeout_auto_cancel',
            update_time: new Date()
          }
        })

        // 退款给求助者
        const rewardAmount = need.reward_amount || 0
        if (rewardAmount > 0) {
          await transaction.collection('wdd-users').doc(need.user_id).update({
            data: {
              balance: _.inc(rewardAmount),
              update_time: new Date()
            }
          })

          const latestSeekerRes = await transaction.collection('wdd-users').doc(need.user_id).get()
          await transaction.collection('wdd-balance-records').add({
            data: {
              user_id: need.user_id,
              type: 'arbitration_refund',
              amount: rewardAmount,
              balance: latestSeekerRes.data.balance || rewardAmount,
              description: '客服超时未处理，自动取消并全额退款',
              need_id: need._id,
              create_time: new Date()
            }
          })
        }

        await transaction.commit()

        // 发送通知
        await db.collection('wdd-notifications').add({
          data: {
            user_id: need.user_id,
            type: 'arbitration_result',
            title: '申诉超时自动处理',
            content: `您参与的任务因客服超时未处理，已自动取消并全额退款¥${need.reward_amount || 0}。双方均不扣信誉分。`,
            need_id: need._id,
            is_read: false,
            create_time: new Date()
          }
        })

        if (takerRecord) {
          await db.collection('wdd-notifications').add({
            data: {
              user_id: takerRecord.taker_id,
              type: 'arbitration_result',
              title: '申诉超时自动处理',
              content: `您参与的任务因客服超时未处理，已自动取消。双方均不扣信誉分。`,
              need_id: need._id,
              is_read: false,
              create_time: new Date()
            }
          })
        }

        results.push({ ticketId: ticket._id, status: 'auto_cancelled', refundAmount: rewardAmount })
      } catch (err) {
        await transaction.rollback()
        throw err
      }
    } catch (err) {
      console.error(`自动裁决失败 ${ticket._id}:`, err)
      results.push({ ticketId: ticket._id, status: 'error', error: err.message })
    }
  }

  return {
    code: 0,
    message: `检查了 ${ticketRes.data.length} 条工单，自动取消了 ${results.filter(r => r.status === 'auto_cancelled').length} 条`,
    data: { results }
  }
}
