// 云函数入口文件
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

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

  // 验证权限（只有求助者可以确认完成）
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
    // 1. 更新任务状态
    await transaction.collection('wdd-needs').doc(needId).update({
      data: {
        status: 'completed',
        complete_time: new Date(),
        update_time: new Date()
      }
    })

    // 2. 更新接单记录
    await transaction.collection('wdd-need-takers').doc(taker._id).update({
      data: {
        status: 'completed',
        complete_time: new Date(),
        update_time: new Date()
      }
    })

    // 3. 获取求助者用户信息
    const seekerRes = await transaction.collection('wdd-users').doc(need.user_id).get()
    const seeker = seekerRes.data

    // 4. 获取帮助者用户信息
    const takerUserRes = await transaction.collection('wdd-users').doc(taker.taker_id).get()
    const takerUser = takerUserRes.data

    // 5. 扣除求助者冻结积分（总积分也相应减少）
    await transaction.collection('wdd-users').doc(seeker._id).update({
      data: {
        frozen_points: _.inc(-need.points),
        total_points: _.inc(-need.points),
        update_time: new Date()
      }
    })

    // 6. 增加帮助者可用积分和总积分
    await transaction.collection('wdd-users').doc(takerUser._id).update({
      data: {
        available_points: _.inc(need.points),
        total_points: _.inc(need.points),
        update_time: new Date()
      }
    })

    // 7. 创建积分流水记录（求助者）
    await transaction.collection('wdd-point-records').add({
      data: {
        user_id: need.user_id,
        type: 'task_pay',
        points: -need.points,
        balance: seeker.total_points - need.points,
        description: `任务「${need.type_name || '求助'}」支出`,
        need_id: needId,
        create_time: new Date()
      }
    })

    // 8. 创建积分流水记录（帮助者）
    await transaction.collection('wdd-point-records').add({
      data: {
        user_id: taker.taker_id,
        type: 'task_reward',
        points: need.points,
        balance: takerUser.total_points + need.points,
        description: `任务「${need.type_name || '求助'}」收入`,
        need_id: needId,
        create_time: new Date()
      }
    })

    // 提交事务
    await transaction.commit()

    // 发送完成通知给帮助者和求助者
    await sendCompletionNotification(taker.taker_id, need)
    await sendCompletionNotificationToSeeker(need.user_id, need)

    return {
      code: 0,
      message: '任务完成',
      data: {
        needId,
        points: need.points
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
  if (need.status !== 'pending' && need.status !== 'ongoing') {
    return { code: -1, message: '任务状态异常，无法取消' }
  }

  // 获取用户
  const user = userRes.data[0]

  // 开启事务
  const transaction = await db.startTransaction()

  try {
    // 1. 更新任务状态
    await transaction.collection('wdd-needs').doc(needId).update({
      data: {
        status: 'cancelled',
        cancel_time: new Date(),
        update_time: new Date()
      }
    })

    // 2. 如果有接单，更新接单记录
    if (need.status === 'ongoing') {
      const takerRes = await transaction.collection('wdd-need-takers').where({
        need_id: needId
      }).get()

      if (takerRes.data.length > 0) {
        await transaction.collection('wdd-need-takers').doc(takerRes.data[0]._id).update({
          data: {
            status: 'cancelled',
            cancel_time: new Date(),
            update_time: new Date()
          }
        })

        // 通知帮助者任务已取消
        await sendCancellationNotification(takerRes.data[0].taker_id, need)
      }
    }

    // 3. 解冻积分（冻结积分减少，可用积分增加）
    await transaction.collection('wdd-users').doc(user._id).update({
      data: {
        frozen_points: _.inc(-need.points),
        available_points: _.inc(need.points),
        update_time: new Date()
      }
    })

    // 4. 创建积分流水记录
    await transaction.collection('wdd-point-records').add({
      data: {
        user_id: currentUserId,
        type: 'task_cancel',
        points: need.points,
        balance: user.available_points + need.points,
        description: `任务「${need.type_name || '求助'}」取消，积分退还`,
        need_id: needId,
        create_time: new Date()
      }
    })

    // 5. 给求助者发送取消通知
    await transaction.collection('wdd-notifications').add({
      data: {
        user_id: currentUserId,
        type: 'task_cancelled',
        title: '任务已取消',
        content: `您发布的「${need.type_name || '求助'}」任务已取消，${need.points}积分已退还`,
        need_id: needId,
        is_read: false,
        create_time: new Date()
      }
    })

    await transaction.commit()

    return {
      code: 0,
      message: '任务已取消，积分已退还',
      data: { needId }
    }

  } catch (err) {
    await transaction.rollback()
    throw err
  }
}

// 发送完成通知给帮助者
async function sendCompletionNotification(takerId, need) {
  try {
    await db.collection('wdd-notifications').add({
      data: {
        user_id: takerId,
        type: 'task_completed',
        title: '任务已完成',
        content: `你帮助完成的「${need.type_name || '求助'}」任务已确认完成，获得 ${need.points} 积分`,
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
async function sendCompletionNotificationToSeeker(seekerId, need) {
  try {
    await db.collection('wdd-notifications').add({
      data: {
        user_id: seekerId,
        type: 'task_completed',
        title: '任务已完成',
        content: `您发布的「${need.type_name || '求助'}」任务已完成，${need.points}积分已支付给帮助者`,
        need_id: need._id,
        is_read: false,
        create_time: new Date()
      }
    })
  } catch (err) {
    console.error('发送通知失败:', err)
  }
}

// 发送取消通知
async function sendCancellationNotification(takerId, need) {
  try {
    await db.collection('wdd-notifications').add({
      data: {
        user_id: takerId,
        type: 'task_cancelled',
        title: '任务已取消',
        content: `你承接的「${need.type_name || '求助'}」任务已被求助者取消`,
        need_id: need._id,
        is_read: false,
        create_time: new Date()
      }
    })
  } catch (err) {
    console.error('发送通知失败:', err)
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
    const takerRes = await db.collection('wdd-need-takers').where({ need_id: needId }).get()
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
    // 获取该用户的所有评价
    const ratingsRes = await db.collection('wdd-ratings').where({
      target_id: userId
    }).get()

    const ratings = ratingsRes.data
    if (ratings.length === 0) return

    // 计算平均分
    const avgRating = ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length

    // 更新用户评分
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
