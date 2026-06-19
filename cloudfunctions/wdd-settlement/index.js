// 结算云函数 - 处理任务完成、取消和评价
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const ERROR_CODES = {
  TASK_ALREADY_ACCEPTED: 'TASK_ALREADY_ACCEPTED'
}

function calcRecoveredCreditScore(score) {
  const currentScore = typeof score === 'number' ? score : 100
  return Math.min(Math.max(currentScore, 0) + 5, 100)
}

function taskAlreadyAcceptedResponse(needId) {
  return {
    code: -1,
    errorCode: ERROR_CODES.TASK_ALREADY_ACCEPTED,
    message: '该任务已被接受，无法取消',
    data: { needId }
  }
}

// 主入口
exports.main = async (event, context) => {
  const { action } = event
  const wxContext = cloud.getWXContext()
  const OPENID = wxContext.OPENID

  try {
    switch (action) {
      case 'completeTask':
        return await completeTask(event, OPENID)
      case 'cancelTask':
        return await cancelTask(event, OPENID)
      case 'submitRating':
        return await submitRating(event, OPENID)
      default:
        return { code: -1, message: '未知操作' }
    }
  } catch (err) {
    console.error('操作失败:', err)
    return { code: -1, message: err.message }
  }
}

// 完成任务
async function completeTask(event, OPENID) {
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

  // 验证权限
  if (need.user_id !== currentUserId) {
    return { code: -1, message: '只有求助者可以确认完成任务' }
  }

  // 检查任务状态
  if (need.status !== 'ongoing') {
    return { code: -1, message: '任务状态异常，无法完成' }
  }

  // 获取接单记录
  const takerRes = await db.collection('wdd-need-takers').where({
    need_id: needId
  }).get()

  if (takerRes.data.length === 0) {
    return { code: -1, message: '未找到接单记录' }
  }

  const taker = takerRes.data[0]

  // 开启事务处理
  const transaction = await db.startTransaction()

  try {
    // 0. 事务内必须先 get 才能 update（云开发事务强制规则）
    const needResTx = await transaction.collection('wdd-needs').doc(needId).get()
    const needInTx = needResTx.data
    if (!needInTx || needInTx.status !== 'ongoing') {
      await transaction.rollback()
      return { code: -1, message: '任务状态异常，无法完成' }
    }

    const takerResTx = await transaction.collection('wdd-need-takers').where({
      need_id: needId
    }).get()
    if (takerResTx.data.length === 0) {
      await transaction.rollback()
      return { code: -1, message: '未找到接单记录' }
    }
    const takerInTx = takerResTx.data[0]

    // 1. 从数据库读取平台费率配置（优先使用数据库值，失败则回退默认值）
    let feeRate = 0.15
    try {
      const configRes = await db.collection('wdd-config').doc('platform').get()
      feeRate = configRes.data.platform_fee_rate || 0.15
    } catch (e) {
      console.warn('wdd-config/platform 不存在，使用默认费率 15%:', e.message)
    }

    // 1.1 计算平台抽成和帮助者收入
    const rewardAmount = needInTx.reward_amount || 0
    const platformFee = Math.round(rewardAmount * feeRate * 100) / 100
    const takerIncome = Math.round((rewardAmount - platformFee) * 100) / 100

    // 2. 更新任务状态
    await transaction.collection('wdd-needs').doc(needId).update({
      data: {
        status: 'completed',
        platform_fee: platformFee,
        taker_income: takerIncome,
        complete_time: new Date(),
        update_time: new Date()
      }
    })

    // 3. 更新接单记录
    await transaction.collection('wdd-need-takers').doc(takerInTx._id).update({
      data: {
        status: 'completed',
        complete_time: new Date(),
        update_time: new Date()
      }
    })

    // 4. 余额支付后续会更新求助者钱包，事务内需要先读取用户记录
    await transaction.collection('wdd-users').doc(need.user_id).get()

    // 5. 获取帮助者用户信息
    const takerUserRes = await transaction.collection('wdd-users').doc(taker.taker_id).get()
    const takerUser = takerUserRes.data

    // 6. 帮助者余额增加（扣除平台抽成后），正常完成任务恢复信誉分
    await transaction.collection('wdd-users').doc(takerUser._id).update({
      data: {
        balance: _.inc(takerIncome),
        total_earned: _.inc(takerIncome),
        credit_score: calcRecoveredCreditScore(takerUser.credit_score),
        update_time: new Date()
      }
    })

    // 6.5 重新查询帮助者最新余额，确保流水余额准确
    const latestTakerRes = await transaction.collection('wdd-users').doc(taker.taker_id).get()
    const latestTakerBalance = latestTakerRes.data.balance || 0

    // 7. 创建金额流水记录（帮助者收入）
    await transaction.collection('wdd-balance-records').add({
      data: {
        user_id: taker.taker_id,
        type: 'task_income',
        amount: takerIncome,
        balance: latestTakerBalance,
        description: '求助任务收入',
        need_id: needId,
        create_time: new Date()
      }
    })

    // 8. 余额支付：解冻 + 实际扣款（平台抽成部分自然消耗）
    if (needInTx.payment_method === 'balance') {
      await transaction.collection('wdd-users').doc(need.user_id).update({
        data: {
          balance: _.inc(-rewardAmount),
          frozen_balance: _.inc(-rewardAmount),
          total_paid: _.inc(rewardAmount),
          update_time: new Date()
        }
      })
      // 写入求助者支出完成流水
      const latestSeekerRes = await transaction.collection('wdd-users').doc(need.user_id).get()
      await transaction.collection('wdd-balance-records').add({
        data: {
          user_id: need.user_id,
          type: 'task_pay',
          amount: -rewardAmount,
          balance: latestSeekerRes.data.balance || 0,
          frozen_balance: latestSeekerRes.data.frozen_balance || 0,
          description: '求助任务完成，余额支出',
          need_id: needId,
          create_time: new Date()
        }
      })
    }

    // 提交事务
    await transaction.commit()

    // 向消息表写入系统消息（用于实时推送给帮助者）
    await sendSystemMessage(need, taker.taker_id, need.user_id, takerIncome)

    // 发送完成通知
    await sendCompletionNotification(taker.taker_id, need, takerIncome)
    await sendCompletionNotificationToSeeker(need.user_id, need, rewardAmount)

    return {
      code: 0,
      message: '任务完成',
      data: {
        needId,
        rewardAmount: rewardAmount,
        platformFee: platformFee,
        takerIncome: takerIncome
      }
    }

  } catch (err) {
    await transaction.rollback()
    throw err
  }
}

// 取消任务
async function cancelTask(event, OPENID) {
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

  // 验证权限
  if (need.user_id !== currentUserId) {
    return { code: -1, message: '只有求助者可以取消任务' }
  }

  // 检查任务状态
  if (need.status !== 'pending') {
    if (need.status === 'ongoing') {
      return taskAlreadyAcceptedResponse(needId)
    }
    return { code: -1, message: '任务状态异常，无法取消' }
  }

  // 获取用户
  const user = userRes.data[0]

  // 开启事务
  const transaction = await db.startTransaction()

  try {
    // 0. 事务内必须先 get 才能 update（云开发事务强制规则）
    const needResTx = await transaction.collection('wdd-needs').doc(needId).get()
    const needInTx = needResTx.data
    if (!needInTx || needInTx.status !== 'pending') {
      await transaction.rollback()
      if (needInTx && needInTx.status === 'ongoing') {
        return taskAlreadyAcceptedResponse(needId)
      }
      return { code: -1, message: '任务状态异常，无法取消' }
    }

    // 1. 更新任务状态
    await transaction.collection('wdd-needs').doc(needId).update({
      data: {
        status: 'cancelled',
        cancel_time: new Date(),
        update_time: new Date()
      }
    })

    // 2. 给求助者发送取消通知（退款结果在事务外处理）
    await transaction.collection('wdd-notifications').add({
      data: {
        user_id: currentUserId,
        type: 'task_cancelled',
        title: '任务已取消',
        content: '您发布的求助任务已取消，如有支付将原路退回',
        need_id: needId,
        is_read: false,
        create_time: new Date()
      }
    })

    await transaction.commit()

  } catch (err) {
    await transaction.rollback()
    throw err
  }

  // 4. 事务提交后调用退款（避免事务内调用云函数导致不一致，refundOrder 自身已处理 total_paid 和幂等）
  let refundStatus = 'none'
  let refundMessage = ''
  if (need.payment_order_id) {
    try {
      const { result } = await cloud.callFunction({
        name: 'wdd-payment',
        data: {
          action: 'refundOrder',
          orderId: need.payment_order_id,
          openid: OPENID  // 云函数间调用需显式传递 openid
        }
      })
      console.log('退款结果:', result)
      if (result.code === 0) {
        refundStatus = result.status || 'unknown' // 'refunded' | 'pending'
        refundMessage = result.message || ''
      } else {
        refundStatus = 'failed'
        refundMessage = result.message || '退款调用失败'
      }
    } catch (err) {
      refundStatus = 'failed'
      refundMessage = err.message || '退款调用失败'
      console.error('退款调用失败:', err)
    }
  }

  const message = refundStatus === 'refunded'
    ? '任务已取消，悬赏金额已原路退回'
    : refundStatus === 'pending'
      ? '任务已取消，退款已加入队列自动处理，请稍后查看微信账单'
      : '任务已取消，如有支付将原路退回（退款处理中）'

  return {
    code: 0,
    message: message,
    data: { needId, refundStatus }
  }
}

// 提交评价
async function submitRating(event, OPENID) {
  const { needId, ratingType, rating, tags, comment } = event
  const normalizedRatingType = ratingType || 'seeker'
  const ratingValue = Number(rating)

  if (!needId || !rating) {
    return { code: -1, message: '参数错误' }
  }
  if (normalizedRatingType !== 'seeker') {
    return { code: -1, message: '只有求助者可以评价帮助者' }
  }
  if (!Number.isFinite(ratingValue) || ratingValue < 1 || ratingValue > 5) {
    return { code: -1, message: '评分必须在1~5分之间' }
  }
  if (tags && (!Array.isArray(tags) || tags.length > 10 || tags.some(tag => String(tag).length > 20))) {
    return { code: -1, message: '评价标签格式不正确' }
  }

  try {
    // 获取当前用户
    const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
    if (userRes.data.length === 0) {
      return { code: -1, message: '用户不存在' }
    }
    const currentUserId = userRes.data[0]._id

    // 获取任务信息
    const needRes = await db.collection('wdd-needs').doc(needId).get()
    const need = needRes.data

    if (!need) {
      return { code: -1, message: '任务不存在' }
    }
    if (need.status !== 'completed') {
      return { code: -1, message: '任务完成后才能评价' }
    }

    // 验证权限
    const isSeeker = need.user_id === currentUserId
    const takerRes = await db.collection('wdd-need-takers').where({ need_id: needId }).orderBy('create_time', 'desc').limit(1).get()
    const taker = takerRes.data[0]
    if (!taker) {
      return { code: -1, message: '未找到接单记录，无法评价' }
    }

    if (normalizedRatingType === 'seeker' && !isSeeker) {
      return { code: -1, message: '只有求助者可以评价帮助者' }
    }

    // 确定评价对象
    const targetUserId = taker.taker_id
    const raterUserId = currentUserId

    // 检查是否已评价
    const existingRating = await db.collection('wdd-ratings').where({
      need_id: needId,
      rater_id: raterUserId,
      rating_type: normalizedRatingType
    }).count()

    if (existingRating.total > 0) {
      return { code: -1, message: '您已经评价过了' }
    }

    const cleanComment = String(comment || '').trim()
    if (cleanComment) {
      try {
        const checkRes = await cloud.openapi.security.msgSecCheck({
          content: cleanComment,
          version: 2,
          scene: 2,
          openid: OPENID,
          title: '问当地评价'
        })
        if (checkRes.errCode !== 0) {
          return { code: -1, message: '评价内容违规，无法提交' }
        }
      } catch (err) {
        console.error('评价内容安全检测失败:', err)
        return { code: -1, message: '内容审核失败，请稍后重试' }
      }
    }

    // 创建评价记录
    await db.collection('wdd-ratings').add({
      data: {
        need_id: needId,
        rater_id: raterUserId,
        target_id: targetUserId,
        rating_type: normalizedRatingType,
        rating: ratingValue,
        tags: tags || [],
        comment: cleanComment,
        create_time: new Date()
      }
    })

    // 更新任务评价状态
    await db.collection('wdd-needs').doc(needId).update({
      data: {
        seeker_rated: true,
        update_time: new Date()
      }
    })

    // 更新用户评分统计
    await updateUserRating(targetUserId)

    return {
      code: 0,
      message: '评价成功',
      data: { ratingId: needId }
    }
  } catch (err) {
    console.error('提交评价失败:', err)
    return { code: -1, message: err.message }
  }
}

// 更新用户评分统计
async function updateUserRating(userId) {
  try {
    const ratingsRes = await db.collection('wdd-ratings').where({
      target_id: userId
    }).get()

    const ratings = ratingsRes.data
    if (ratings.length === 0) return

    const avgRating = ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length

    await db.collection('wdd-users').doc(userId).update({
      data: {
        rating: Math.round(avgRating * 10) / 10,
        rating_count: ratings.length,
        update_time: new Date()
      }
    })
  } catch (err) {
    console.error('更新用户评分失败:', err)
  }
}

// 发送完成通知给帮助者
async function sendCompletionNotification(takerId, need, takerIncome) {
  try {
    await db.collection('wdd-notifications').add({
      data: {
        user_id: takerId,
        type: 'task_completed',
        title: '任务已完成',
        content: `你帮助完成的求助任务已确认完成，¥${takerIncome}已计入您的余额`,
        need_id: need._id,
        is_read: false,
        create_time: new Date()
      }
    })
  } catch (err) {
    console.error('发送通知失败:', err)
  }
}

// 发送完成通知给求助者
async function sendCompletionNotificationToSeeker(seekerId, need, rewardAmount) {
  try {
    await db.collection('wdd-notifications').add({
      data: {
        user_id: seekerId,
        type: 'task_completed',
        title: '任务已完成',
        content: `您发布的求助任务已完成，悬赏金额¥${rewardAmount}已结算给帮助者`,
        need_id: need._id,
        is_read: false,
        create_time: new Date()
      }
    })
  } catch (err) {
    console.error('发送通知失败:', err)
  }
}

// 发送系统消息到聊天（用于实时推送任务状态变更）
async function sendSystemMessage(need, takerId, seekerId, takerIncome) {
  try {
    await db.collection('wdd-messages').add({
      data: {
        need_id: String(need._id),
        client_msg_id: '',
        sender_id: seekerId,
        receiver_id: takerId,
        type: 'system',
        // system_type/amount 用于前端按当前用户身份渲染不同文案
        // content 作为兜底文案（旧版本客户端无法识别 system_type 时使用帮助者视角文案）
        system_type: 'task_completed',
        amount: takerIncome,
        content: `任务已完成，¥${takerIncome}已计入帮助者的余额`,
        image_url: '',
        create_time: new Date()
      }
    })
  } catch (err) {
    console.error('发送系统消息失败:', err)
    // 不影响主流程
  }
}
