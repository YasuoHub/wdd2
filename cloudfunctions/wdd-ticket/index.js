// 客服工单云函数
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 格式化日期（强制按北京时间 UTC+8 输出，避免云函数环境时区为 UTC 导致时间差 8 小时）
function formatDate(date) {
  if (!date) return ''
  const d = new Date(date)
  if (isNaN(d.getTime())) return ''
  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000)
  const pad = n => n.toString().padStart(2, '0')
  return `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())} ${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100
}

function calcPayParts(need) {
  return {
    totalAmount: roundMoney(need.total_amount || need.reward_amount || 0),
    deductionAmount: roundMoney(need.deduction_amount || 0),
    balanceAmount: roundMoney(need.balance_amount || 0),
    wechatAmount: roundMoney(need.wechat_amount || 0)
  }
}

function getPaymentMode(need) {
  const { deductionAmount, balanceAmount, wechatAmount } = calcPayParts(need)
  const methodCount = [deductionAmount, balanceAmount, wechatAmount].filter(amount => amount > 0).length
  if (methodCount > 1) return 'mixed'
  if (wechatAmount > 0) return 'wechat'
  if (balanceAmount > 0) return 'balance'
  if (deductionAmount > 0) return 'deduction'
  return 'none'
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
      case 'retryArbitrationRefund':
        return await retryArbitrationRefund(event, OPENID)
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
  const queryStatus = status === 'pending' ? 'pending' : 'resolved'
  const where = { status: queryStatus }

  // 查询工单（多取一条判断是否有更多）
  const ticketRes = await db.collection('wdd-tickets')
    .where(where)
    .orderBy('create_time', 'desc')
    .skip((page - 1) * pageSize)
    .limit(pageSize + 1)
    .get()

  const hasMore = ticketRes.data.length > pageSize
  const listData = hasMore ? ticketRes.data.slice(0, pageSize) : ticketRes.data

  // 获取关联的任务信息
  const tickets = await Promise.all(listData.map(async (ticket) => {
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

    // 获取申诉/举报补充状态
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
    } else if (ticket.type === 'report' && ticket.report_id) {
      const reportRes = await db.collection('wdd-reports').doc(ticket.report_id).get().catch(() => null)
      if (reportRes && reportRes.data) {
        const report = reportRes.data
        if (report.has_supplement) {
          supplementStatus = '对方已补充材料'
        } else if (report.is_supplement_timeout) {
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
      taskType: need ? need.type : '',
      taskTitle: need ? '求助任务' : '未知任务',
      taskNumber: need ? need.task_no : '',
      rewardAmount: need ? need.reward_amount : 0,
      expireTime: need ? need.expire_time : null,
      seekerNickname: seeker ? seeker.nickname : '未知用户',
      takerNickname: taker ? taker.nickname : '未知用户',
      supplementStatus,
      createTime: ticket.create_time,
      createTimeFormatted: formatDate(ticket.create_time)
    }
  }))

  return {
    code: 0,
    data: {
      list: tickets,
      hasMore
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
  let takerRecord = null
  if (need) {
    const seekerRes = await db.collection('wdd-users').doc(need.user_id).get().catch(() => null)
    seeker = seekerRes ? seekerRes.data : null

    const takerRes = await db.collection('wdd-need-takers')
      .where({ need_id: ticket.need_id })
      .orderBy('create_time', 'desc')
      .limit(1)
      .get()
    if (takerRes.data.length > 0) {
      takerRecord = takerRes.data[0]
      const takerUserRes = await db.collection('wdd-users').doc(takerRecord.taker_id).get().catch(() => null)
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

      // 计算被举报人昵称和头像：任务双方中非举报人的那一方
      let reportedNickname = '未知用户'
      let reportedAvatar = ''
      if (need) {
        if (report.reporter_id === need.user_id) {
          // 求助者是举报人，被举报人是帮助者
          reportedNickname = taker ? taker.nickname : '未知用户'
          reportedAvatar = taker ? taker.avatar || '' : ''
        } else {
          // 帮助者是举报人，被举报人是求助者
          reportedNickname = seeker ? seeker.nickname : '未知用户'
          reportedAvatar = seeker ? seeker.avatar || '' : ''
        }
      }

      reportDetail = {
        type: report.report_type,
        typeLabel: report.report_type_label || report.report_type,
        reason: report.reason,
        images: report.images || [],
        reporterNickname: reporterRes ? reporterRes.data.nickname : '未知用户',
        reporterAvatar: reporterRes ? reporterRes.data.avatar || '' : '',
        reportedNickname,
        reportedAvatar,
        createTime: report.create_time,
        supplement: report.has_supplement ? {
          type: report.supplement_type,
          typeLabel: report.supplement_type_label || report.supplement_type,
          reason: report.supplement_reason,
          images: report.supplement_images || []
        } : null,
        supplementDeadline: report.supplement_deadline,
        isSupplementTimeout: report.is_supplement_timeout
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
          typeLabel: appeal.initiator_type_label || appeal.initiator_type,
          reason: appeal.initiator_reason,
          images: appeal.initiator_images || []
        },
        supplement: appeal.has_supplement ? {
          type: appeal.supplement_type,
          typeLabel: appeal.supplement_type_label || appeal.supplement_type,
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
        description: need.description,
        rewardAmount: need.reward_amount || 0,
        status: need.status,
        locationName: need.location_name,
        expireTime: need.expire_time,
        createTime: need.create_time,
        takeTime: takerRecord ? takerRecord.create_time : null
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
  const {
    ticketId,
    taskResult, // cancelled | completed | partial
    partialPercent, // 10 | 30 | 50 | 70（仅 partial 时有效）
    banInfo // { target: 'seeker'|'taker'|'both', duration: '1d'|'1w'|'1m'|'1y'|'permanent', durationLabel: '1天'|'1周'|'1个月'|'1年'|'永久封禁' }
  } = event

  if (!ticketId || !taskResult) {
    return { code: -1, message: '参数不完整' }
  }
  if (!['cancelled', 'completed', 'partial'].includes(taskResult)) {
    return { code: -1, message: '处理结果无效' }
  }
  if (taskResult === 'partial' && ![10, 30, 50, 70].includes(partialPercent)) {
    return { code: -1, message: '分账比例无效' }
  }

  // 权限检查（业务查询前先行拦截，避免无权限用户消耗数据库配额）
  const configRes = await db.collection('wdd-config').doc('platform').get().catch(() => ({ data: {} }))
  const csOpenids = configRes.data.customer_service_openids || []
  if (!csOpenids.includes(OPENID)) {
    return { code: -1, message: '无权访问' }
  }
  const feeRate = configRes.data.platform_fee_rate || 0.15

  // 第一批：串行查询（有依赖关系）
  const ticketRes = await db.collection('wdd-tickets').doc(ticketId).get()
  if (!ticketRes.data) {
    return { code: -1, message: '工单不存在' }
  }
  const ticket = ticketRes.data

  if (ticket.status !== 'pending') {
    return { code: -1, message: '工单已处理' }
  }

  const needRes = await db.collection('wdd-needs').doc(ticket.need_id).get()
  if (!needRes.data) {
    return { code: -1, message: '任务不存在' }
  }
  const need = needRes.data

  if (need.status !== 'breaking') {
    return { code: -1, message: '任务当前不在审核中，无法裁决' }
  }

  // 第二批：并行查询（互不依赖，config 已在权限检查阶段获取）
  const [takerRes, seekerUserRes] = await Promise.all([
    db.collection('wdd-need-takers')
      .where({ need_id: ticket.need_id })
      .orderBy('create_time', 'desc')
      .limit(1)
      .get(),
    db.collection('wdd-users').doc(need.user_id).get().catch(() => ({ data: {} }))
  ])
  const takerRecord = takerRes.data[0]

  // 取消任务和完成任务都需要帮助者存在
  if ((taskResult === 'cancelled' || taskResult === 'completed' || taskResult === 'partial') && !takerRecord) {
    return { code: -1, message: '该任务无接单记录，无法裁决' }
  }

  // 预读用户当前余额和封禁状态，用于流水记录和封禁累加
  const seekerCurrentBalance = seekerUserRes.data.balance || 0
  const seekerBanStatus = seekerUserRes.data.ban_status || null

  // 第三批：依赖 takerRecord
  let takerCurrentBalance = 0
  let takerBanStatus = null
  if (takerRecord) {
    try {
      const takerUserRes = await db.collection('wdd-users').doc(takerRecord.taker_id).get()
      takerCurrentBalance = takerUserRes.data.balance || 0
      takerBanStatus = takerUserRes.data.ban_status || null
    } catch (e) {}
  }

  const rewardAmount = need.reward_amount || 0

  // 3. 根据处理结果处理资金和任务状态
  let seekerRefund = 0
  let takerIncome = 0
  let platformFee = 0
  let finalStatus = ''
  let seekerNewBalance = seekerCurrentBalance
  let takerNewBalance = takerCurrentBalance

  if (taskResult === 'cancelled') {
    seekerRefund = rewardAmount
    takerIncome = 0
    platformFee = 0
    finalStatus = 'cancelled'
    seekerNewBalance = Math.round((seekerCurrentBalance + seekerRefund) * 100) / 100
  } else if (taskResult === 'completed') {
    platformFee = Math.round(rewardAmount * feeRate * 100) / 100
    takerIncome = Math.round((rewardAmount - platformFee) * 100) / 100
    seekerRefund = 0
    finalStatus = 'completed'
    takerNewBalance = Math.round((takerCurrentBalance + takerIncome) * 100) / 100
  } else if (taskResult === 'partial') {
    const takerRawIncome = Math.round(rewardAmount * partialPercent / 100 * 100) / 100
    platformFee = Math.round(takerRawIncome * feeRate * 100) / 100
    takerIncome = Math.round((takerRawIncome - platformFee) * 100) / 100
    seekerRefund = Math.round((rewardAmount - takerRawIncome) * 100) / 100
    finalStatus = 'completed'
    takerNewBalance = Math.round((takerCurrentBalance + takerIncome) * 100) / 100
    seekerNewBalance = Math.round((seekerCurrentBalance + seekerRefund) * 100) / 100
  }

  // 开启事务 —— 事务中只进行纯粹的写操作，不再有任何读操作
  const transaction = await db.startTransaction()

  try {
    // 1. 更新工单状态
    // 使用 _.set 直接设置整个 result 对象，避免 result 为 null 时点路径报错 PathNotViable
    await transaction.collection('wdd-tickets').doc(ticketId).update({
      data: {
        status: 'resolved',
        handler_id: OPENID,
        result: _.set({
          task_result: taskResult,
          partial_percent: taskResult === 'partial' ? partialPercent : null,
          ban_info: banInfo || null,
          refund: buildRefundStatus(need, seekerRefund, {
            status: seekerRefund > 0 ? 'not_started' : 'not_required',
            message: seekerRefund > 0 ? '等待裁定事务提交后按支付明细退款' : ''
          })
        }),
        resolve_time: new Date(),
        update_time: new Date()
      }
    })

    if (taskResult === 'cancelled') {
      // 扣减帮助者信誉分 10 分
      await transaction.collection('wdd-users').doc(takerRecord.taker_id).update({
        data: {
          credit_score: _.inc(-10),
          update_time: new Date()
        }
      })

      // 更新接单记录状态为 cancelled
      await transaction.collection('wdd-need-takers').doc(takerRecord._id).update({
        data: {
          status: 'cancelled',
          cancel_time: new Date(),
          update_time: new Date()
        }
      })

    } else if (taskResult === 'completed') {
      // 更新帮助者余额
      await transaction.collection('wdd-users').doc(takerRecord.taker_id).update({
        data: {
          balance: takerNewBalance,
          total_earned: _.inc(takerIncome),
          update_time: new Date()
        }
      })

      // 创建收入流水
      await transaction.collection('wdd-balance-records').add({
        data: {
          user_id: takerRecord.taker_id,
          type: 'task_income',
          amount: takerIncome,
          balance: takerNewBalance,
          description: `客服裁决：任务完成收入`,
          need_id: need._id,
          create_time: new Date()
        }
      })

      // 消费冻结的钱包资金；微信部分已在发布时支付
      const { balanceAmount, deductionAmount } = calcPayParts(need)
      if (balanceAmount > 0 || deductionAmount > 0) {
        const userUpdateData = {
          total_paid: _.inc(balanceAmount),
          update_time: new Date()
        }
        if (balanceAmount > 0) {
          userUpdateData.balance = _.inc(-balanceAmount)
          userUpdateData.frozen_balance = _.inc(-balanceAmount)
        }
        if (deductionAmount > 0) {
          userUpdateData.deduction_balance = _.inc(-deductionAmount)
          userUpdateData.frozen_deduction_balance = _.inc(-deductionAmount)
        }
        await transaction.collection('wdd-users').doc(need.user_id).update({ data: userUpdateData })
      }

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
      // 更新帮助者余额
      await transaction.collection('wdd-users').doc(takerRecord.taker_id).update({
        data: {
          balance: takerNewBalance,
          total_earned: _.inc(takerIncome),
          update_time: new Date()
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

    // 4. 更新对应的举报/申诉状态
    if (ticket.type === 'report' && ticket.report_id) {
      await transaction.collection('wdd-reports').doc(ticket.report_id).update({
        data: {
          status: 'resolved',
          update_time: new Date()
        }
      })
    } else if (ticket.type === 'appeal' && ticket.appeal_id) {
      await transaction.collection('wdd-appeals').doc(ticket.appeal_id).update({
        data: {
          status: 'resolved',
          update_time: new Date()
        }
      })
    }

    // 5. 更新任务状态（同时清除对应的举报/申诉标记）
    const needUpdateData = {
      status: finalStatus,
      platform_fee: platformFee,
      taker_income: takerIncome,
      update_time: new Date(),
      ...(taskResult === 'completed' ? { complete_time: new Date() } : {}),
      ...(taskResult === 'cancelled' ? { cancel_time: new Date(), cancel_reason: 'arbitration_cancelled' } : {})
    }
    if (ticket.type === 'report') {
      needUpdateData.has_report = false
    } else if (ticket.type === 'appeal') {
      needUpdateData.has_appeal = false
    }
    await transaction.collection('wdd-needs').doc(need._id).update({
      data: needUpdateData
    })

    // 6. 处理封禁（若已有有效封禁则累加时长）
    if (banInfo && banInfo.target !== 'none') {
      if (banInfo.target === 'seeker' || banInfo.target === 'both') {
        const seekerBaseTime = seekerBanStatus ? seekerBanStatus.end_time : null
        const banEndTime = calculateBanEndTime(banInfo.duration, seekerBaseTime)
        await transaction.collection('wdd-users').doc(need.user_id).update({
          data: {
            ban_status: {
              reason: `客服裁决：${taskResult === 'cancelled' ? '取消任务' : taskResult === 'completed' ? '完成任务' : '部分完成'}`,
              end_time: banEndTime,
              ticket_id: ticketId,
              create_time: new Date()
            },
            update_time: new Date()
          }
        })
      }
      if (banInfo.target === 'taker' || banInfo.target === 'both') {
        const takerBaseTime = takerBanStatus ? takerBanStatus.end_time : null
        const banEndTime = calculateBanEndTime(banInfo.duration, takerBaseTime)
        await transaction.collection('wdd-users').doc(takerRecord.taker_id).update({
          data: {
            ban_status: {
              reason: `客服裁决：${taskResult === 'cancelled' ? '取消任务' : taskResult === 'completed' ? '完成任务' : '部分完成'}`,
              end_time: banEndTime,
              ticket_id: ticketId,
              create_time: new Date()
            },
            update_time: new Date()
          }
        })
      }
    }

    await transaction.commit()

    // 7. 发送站内消息通知（事务外）
    const refundResult = await refundPaymentAfterArbitration(need, seekerRefund, taskResult, partialPercent)
    if (seekerRefund > 0) {
      await updateTicketRefundStatus(ticketId, need, seekerRefund, refundResult)
    }

    await sendArbitrationNotifications(
      need,
      takerRecord,
      taskResult,
      partialPercent,
      takerIncome,
      seekerRefund,
      banInfo,
      refundResult
    )

    return {
      code: 0,
      message: '裁决已提交',
      data: { ticketId, taskResult, takerIncome, seekerRefund, refundResult }
    }

  } catch (err) {
    try { await transaction.rollback() } catch (rollbackErr) {}
    throw err
  }
}

async function retryArbitrationRefund(event, OPENID) {
  if (!await isCustomerService(OPENID)) {
    return { code: -1, message: '无权访问' }
  }

  const { ticketId } = event
  if (!ticketId) {
    return { code: -1, message: '工单ID不能为空' }
  }

  const ticketRes = await db.collection('wdd-tickets').doc(ticketId).get().catch(() => null)
  if (!ticketRes || !ticketRes.data) {
    return { code: -1, message: '工单不存在' }
  }
  const ticket = ticketRes.data
  if (ticket.status !== 'resolved') {
    return { code: -1, message: '只有已处理工单才能重试退款' }
  }

  const refund = ticket.result && ticket.result.refund
  if (!refund || refund.mode === 'none') {
    return { code: -1, message: '该工单没有需要重试的退款' }
  }
  if (refund.status !== 'failed') {
    return { code: -1, message: `当前退款状态为 ${refund.status}，无需人工重试` }
  }
  if (!refund.order_id || !refund.amount || refund.amount <= 0) {
    return { code: -1, message: '退款信息不完整，无法重试' }
  }

  const needRes = await db.collection('wdd-needs').doc(ticket.need_id).get().catch(() => null)
  if (!needRes || !needRes.data) {
    return { code: -1, message: '任务不存在' }
  }
  const need = needRes.data

  const taskResult = ticket.result.task_result || (need.status === 'cancelled' ? 'cancelled' : 'partial')
  const partialPercent = ticket.result.partial_percent || null
  const refundResult = await refundPaymentAfterArbitration(need, refund.amount, taskResult, partialPercent)
  const savedRefund = await updateTicketRefundStatus(ticketId, need, refund.amount, refundResult)

  return {
    code: refundResult.status === 'failed' ? -1 : 0,
    message: refundResult.message || (refundResult.status === 'failed' ? '退款重试失败' : '退款重试已发起'),
    data: {
      ticketId,
      refund: savedRefund
    }
  }
}

// 计算封禁结束时间
// baseTime: 已有的解封时间，如果仍在有效期内则从此时间累加，否则从现在起算
function calculateBanEndTime(duration, baseTime) {
  const now = new Date()
  const baseDate = baseTime ? new Date(baseTime) : null
  const effectiveBase = (baseDate && baseDate > now) ? baseDate : now
  switch (duration) {
    case '1d': return new Date(effectiveBase.getTime() + 24 * 60 * 60 * 1000)
    case '1w': return new Date(effectiveBase.getTime() + 7 * 24 * 60 * 60 * 1000)
    case '1m': return new Date(effectiveBase.getTime() + 30 * 24 * 60 * 60 * 1000)
    case '1y': return new Date(effectiveBase.getTime() + 365 * 24 * 60 * 60 * 1000)
    case 'permanent': return new Date('9999-12-31T23:59:59.999Z')
    default: return new Date(effectiveBase.getTime() + 24 * 60 * 60 * 1000)
  }
}

function buildRefundStatus(need, amount, result = {}) {
  const refundAmount = Math.round((Number(amount) || 0) * 100) / 100
  const mode = refundAmount > 0 ? getPaymentMode(need) : 'none'

  return {
    mode,
    status: result.status || (refundAmount > 0 ? 'pending' : 'not_required'),
    amount: refundAmount,
    message: result.message || '',
    order_id: need.payment_order_id || null,
    updated_time: new Date()
  }
}

async function updateTicketRefundStatus(ticketId, need, amount, refundResult) {
  const refund = buildRefundStatus(need, amount, refundResult)
  try {
    const now = new Date()
    await Promise.all([
      db.collection('wdd-tickets').doc(ticketId).update({
        data: {
          'result.refund': refund,
          update_time: now
        }
      }),
      need && need._id
        ? db.collection('wdd-needs').doc(need._id).update({
            data: {
              arbitration_refund_status: refund.status,
              arbitration_refund_amount: refund.amount,
              arbitration_refund_message: refund.message || '',
              update_time: now
            }
          })
        : Promise.resolve()
    ])
  } catch (err) {
    console.error('更新工单退款状态失败:', err)
  }
  return refund
}

async function refundPaymentAfterArbitration(need, seekerRefund, taskResult, partialPercent) {
  const mode = getPaymentMode(need)
  if (!seekerRefund || seekerRefund <= 0) {
    return { mode, status: 'not_required' }
  }
  if (!need.payment_order_id) {
    return { mode, status: 'failed', message: '缺少支付订单，无法退款' }
  }

  try {
    const orderRes = await db.collection('wdd-payment-orders').doc(need.payment_order_id).get()
    const order = orderRes.data
    if (!order || !order.openid) {
      return { mode, status: 'failed', message: '支付订单不存在或缺少openid' }
    }

    const refundReason = taskResult === 'partial'
      ? `客服裁决：部分完成(${partialPercent}%)，退还剩余金额`
      : '客服裁决：任务取消，全额退款'

    const { result } = await cloud.callFunction({
      name: 'wdd-payment',
      data: {
        action: 'refundOrder',
        orderId: need.payment_order_id,
        openid: order.openid,
        refundAmount: seekerRefund,
        refundReason,
        // 传递预查询的订单数据，避免 wdd-payment 重复查询
        orderData: {
          _id: order._id,
          openid: order.openid,
          out_trade_no: order.out_trade_no,
          total_amount: order.total_amount,
          deduction_amount: order.deduction_amount,
          balance_amount: order.balance_amount,
          wechat_amount: order.wechat_amount,
          payment_methods: order.payment_methods,
          status: order.status
        }
      }
    })

    return {
      mode,
      status: result && result.code === 0 ? (result.status || 'processing') : 'failed',
      message: result ? result.message : '退款调用无返回',
      refundAmount: seekerRefund
    }
  } catch (err) {
    console.error('客服裁决退款调用失败:', err)
    return { mode, status: 'failed', message: err.message, refundAmount: seekerRefund }
  }
}

// 发送裁决通知
async function sendArbitrationNotifications(need, takerRecord, taskResult, partialPercent, takerIncome, seekerRefund, banInfo, refundResult) {
  const now = new Date()

  // 求助者通知
  let seekerContent = ''
  let takerContent = ''

  if (taskResult === 'cancelled') {
    const refundText = `悬赏金额¥${seekerRefund}将按原支付明细退回。`
    seekerContent = `客服已裁决：任务取消，${refundText}帮助者信誉分-10。`
    takerContent = `客服已裁决：任务取消，您未获得收入。您的信誉分-10。`
  } else if (taskResult === 'completed') {
    seekerContent = `客服已裁决：任务完成。帮助者获得¥${takerIncome}（已扣除平台服务费）。您的信誉分-10。`
    takerContent = `客服已裁决：任务完成，您获得¥${takerIncome}（已扣除平台服务费），已计入余额。求助者信誉分-10。`
  } else if (taskResult === 'partial') {
    const refundText = `剩余¥${seekerRefund}将按原支付明细退回。`
    seekerContent = `客服已裁决：部分完成(${partialPercent}%)。帮助者获得¥${takerIncome}，${refundText}双方均不扣信誉分。`
    takerContent = `客服已裁决：部分完成(${partialPercent}%)，您获得¥${takerIncome}，已计入余额。双方均不扣信誉分。`
  }

  if (refundResult && refundResult.status === 'failed') {
    seekerContent += ` 退款发起异常：${refundResult.message || '请联系客服处理'}。`
  }

  // 封禁信息
  if (banInfo && banInfo.target !== 'none') {
    const isPermanent = banInfo.duration === 'permanent'
    const banText = isPermanent ? '永久封禁' : `封禁${banInfo.durationLabel || banInfo.duration}`
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
      title: '客服处理结果',
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
        title: '客服处理结果',
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
      if (need.status !== 'breaking') {
        results.push({ ticketId: ticket._id, status: 'skip_need_not_breaking', needStatus: need.status })
        continue
      }
      const rewardAmount = need.reward_amount || 0

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
            result: {
              task_result: 'cancelled',
              auto_cancelled: true,
              refund: buildRefundStatus(need, rewardAmount, {
                status: 'not_started',
                message: '等待自动裁定事务提交后按支付明细退款'
              })
            },
            resolve_time: new Date(),
            update_time: new Date()
          }
        })

        // 更新对应的举报/申诉状态
        if (ticket.type === 'report' && ticket.report_id) {
          await transaction.collection('wdd-reports').doc(ticket.report_id).update({
            data: { status: 'resolved', update_time: new Date() }
          })
        } else if (ticket.type === 'appeal' && ticket.appeal_id) {
          await transaction.collection('wdd-appeals').doc(ticket.appeal_id).update({
            data: { status: 'resolved', update_time: new Date() }
          })
        }

        // 更新任务状态（同时清除对应的举报/申诉标记）
        const needUpdateData = {
          status: 'cancelled',
          cancel_time: new Date(),
          cancel_reason: 'arbitration_timeout_auto_cancel',
          update_time: new Date()
        }
        if (ticket.type === 'report') {
          needUpdateData.has_report = false
        } else if (ticket.type === 'appeal') {
          needUpdateData.has_appeal = false
        }
        await transaction.collection('wdd-needs').doc(need._id).update({
          data: needUpdateData
        })

        await transaction.commit()

        const refundResult = await refundPaymentAfterArbitration(need, rewardAmount, 'cancelled')
        await updateTicketRefundStatus(ticket._id, need, rewardAmount, refundResult)
        const seekerRefundText = `已自动取消，悬赏金额¥${need.reward_amount || 0}将按原支付明细退回。`
        const refundFailedText = refundResult.status === 'failed'
          ? ` 退款发起异常：${refundResult.message || '请联系客服处理'}。`
          : ''

        // 发送通知
        await db.collection('wdd-notifications').add({
          data: {
            user_id: need.user_id,
            type: 'arbitration_result',
            title: '申诉超时自动处理',
            content: `您参与的任务因客服超时未处理，${seekerRefundText}双方均不扣信誉分。${refundFailedText}`,
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
