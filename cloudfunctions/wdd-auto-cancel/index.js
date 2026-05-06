// 云函数：自动取消过期任务
// 定时触发器：每5分钟执行一次

const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  console.log('开始执行自动取消任务检查:', new Date().toISOString())

  const now = new Date()
  const results = {
    cancelledNeeds: 0,
    refundedAmount: 0,
    errors: []
  }

  try {
    // 1. 查找已过期且状态为 pending 的任务（无人接单）
    const expiredPendingRes = await db.collection('wdd-needs')
      .where({
        status: 'pending',
        expire_time: _.lt(now)
      })
      .get()

    console.log(`找到 ${expiredPendingRes.data.length} 个过期待匹配任务`)

    // 处理过期待匹配任务
    for (const need of expiredPendingRes.data) {
      try {
        const cancelResult = await cancelPendingNeed(need)
        results.cancelledNeeds++
        if (cancelResult.refundAmount) {
          results.refundedAmount += cancelResult.refundAmount
        }
        console.log(`已取消任务: ${need._id}`)
      } catch (err) {
        console.error(`取消任务失败 ${need._id}:`, err)
        results.errors.push({ needId: need._id, error: err.message })
      }
    }

    // 注意：进行中的任务（ongoing）不会被自动取消
    // 任务被接单后，由求助者手动确认完成

    console.log('自动取消任务检查完成:', results)

    return {
      code: 0,
      message: '执行成功',
      data: results
    }
  } catch (err) {
    console.error('自动取消任务执行失败:', err)
    return {
      code: -1,
      message: '执行失败: ' + err.message,
      data: results
    }
  }
}

// 取消待匹配任务
async function cancelPendingNeed(need) {
  const transaction = await db.startTransaction()
  const result = { refundAmount: 0 }

  try {
    // 1. 获取求助者信息
    const seekerRes = await transaction.collection('wdd-users').doc(need.user_id).get()
    const seeker = seekerRes.data

    // 2. 更新任务状态
    await transaction.collection('wdd-needs').doc(need._id).update({
      data: {
        status: 'cancelled',
        cancel_time: new Date(),
        cancel_reason: 'expired',
        update_time: new Date()
      }
    })

    // 3. 保留积分解冻逻辑（兼容旧数据）
    if (need.points > 0) {
      await transaction.collection('wdd-users').doc(need.user_id).update({
        data: {
          frozen_points: _.inc(-need.points),
          available_points: _.inc(need.points),
          update_time: new Date()
        }
      })

      await transaction.collection('wdd-point-records').add({
        data: {
          user_id: need.user_id,
          type: 'task_cancel',
          points: need.points,
          description: `任务「${need.type_name || '求助'}」超时取消，积分退还`,
          need_id: need._id,
          balance: seeker.total_points || 0,
          create_time: new Date()
        }
      })
    }

    // 4. 发送系统通知（退款结果在事务外处理，避免事务内调用云函数）
    await transaction.collection('wdd-notifications').add({
      data: {
        user_id: need.user_id,
        type: 'task_cancelled',
        title: '任务已超时取消',
        content: `您发布的「${need.type_name || '求助'}」任务已超时，如有支付将原路退回`,
        need_id: need._id,
        is_read: false,
        create_time: new Date()
      }
    })

    await transaction.commit()
  } catch (err) {
    await transaction.rollback()
    throw err
  }

  // 5. 事务提交后调用退款（避免事务内调用云函数导致不一致）
  if (need.payment_order_id) {
    try {
      // 查询订单获取 openid（定时触发器无 wxContext.OPENID）
      const orderRes = await db.collection('wdd-payment-orders').doc(need.payment_order_id).get()
      const orderOpenid = orderRes.data ? orderRes.data.openid : null

      const { result: refundRes } = await cloud.callFunction({
        name: 'wdd-payment',
        data: {
          action: 'refundOrder',
          orderId: need.payment_order_id,
          openid: orderOpenid
        }
      })
      if (refundRes.code === 0) {
        result.refundAmount = refundRes.data.refundAmount || 0
      } else {
        console.error('自动退款业务失败:', refundRes.message)
      }
    } catch (err) {
      console.error('自动退款调用失败:', err)
    }
  }

  return result
}
