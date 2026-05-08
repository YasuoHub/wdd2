// 结算云函数 - 处理任务完成、取消和评价
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

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

    // 4. 获取求助者用户信息
    const seekerRes = await transaction.collection('wdd-users').doc(need.user_id).get()
    const seeker = seekerRes.data

    // 5. 获取帮助者用户信息
    const takerUserRes = await transaction.collection('wdd-users').doc(taker.taker_id).get()
    const takerUser = takerUserRes.data

    // 6. 帮助者余额增加（扣除平台抽成后）
    await transaction.collection('wdd-users').doc(takerUser._id).update({
      data: {
        balance: _.inc(takerIncome),
        total_earned: _.inc(takerIncome),
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
        description: `任务「${need.type_name || '求助'}」收入`,
        need_id: needId,
        create_time: new Date()
      }
    })

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
      return { code: -1, message: '该任务已被接受，无法取消' }
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
        content: `您发布的「${need.type_name || '求助'}」任务已取消，如有支付将原路退回`,
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

  if (!needId || !rating) {
    return { code: -1, message: '参数错误' }
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

    // 验证权限
    const isSeeker = need.user_id === currentUserId
    const takerRes = await db.collection('wdd-need-takers').where({ need_id: needId }).orderBy('create_time', 'desc').limit(1).get()
    const taker = takerRes.data[0]
    const isTaker = taker && taker.taker_id === currentUserId

    if (ratingType === 'seeker' && !isSeeker) {
      return { code: -1, message: '只有求助者可以评价帮助者' }
    }
    if (ratingType === 'taker' && !isTaker) {
      return { code: -1, message: '只有帮助者可以评价求助者' }
    }

    // 确定评价对象
    const targetUserId = ratingType === 'seeker' ? taker.taker_id : need.user_id
    const raterUserId = currentUserId

    // 检查是否已评价
    const existingRating = await db.collection('wdd-ratings').where({
      need_id: needId,
      rater_id: raterUserId,
      rating_type: ratingType
    }).count()

    if (existingRating.total > 0) {
      return { code: -1, message: '您已经评价过了' }
    }

    // 创建评价记录
    await db.collection('wdd-ratings').add({
      data: {
        need_id: needId,
        rater_id: raterUserId,
        target_id: targetUserId,
        rating_type: ratingType,
        rating: rating,
        tags: tags || [],
        comment: comment || '',
        create_time: new Date()
      }
    })

    // 更新任务评价状态
    if (ratingType === 'seeker') {
      await db.collection('wdd-needs').doc(needId).update({
        data: {
          seeker_rated: true,
          update_time: new Date()
        }
      })
    } else {
      await db.collection('wdd-need-takers').doc(taker._id).update({
        data: {
          taker_rated: true,
          update_time: new Date()
        }
      })
    }

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
        content: `你帮助完成的「${need.type_name || '求助'}」任务已确认完成，¥${takerIncome}已计入您的平台余额`,
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
        content: `您发布的「${need.type_name || '求助'}」任务已完成，悬赏金额¥${rewardAmount}已结算给帮助者`,
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
        content: `任务已完成，¥${takerIncome}已计入您的平台余额`,
        image_url: '',
        create_time: new Date()
      }
    })
  } catch (err) {
    console.error('发送系统消息失败:', err)
    // 不影响主流程
  }
}
