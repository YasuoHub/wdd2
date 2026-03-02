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
    unfrozenPoints: 0,
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
        await cancelPendingNeed(need)
        results.cancelledNeeds++
        results.unfrozenPoints += need.points
        console.log(`已取消任务: ${need._id}`)
      } catch (err) {
        console.error(`取消任务失败 ${need._id}:`, err)
        results.errors.push({ needId: need._id, error: err.message })
      }
    }

    // 注意：进行中的任务（ongoing）不会被自动取消
    // 任务被接单后，由求助者手动确认完成，或平台另外的机制处理
    // 不进行自动取消，避免帮助者正在提供帮助时任务被意外取消

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
}// 取消待匹配任务
async function cancelPendingNeed(need) {
  const transaction = await db.startTransaction()

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

    // 3. 解冻用户积分
    await transaction.collection('wdd-users').doc(need.user_id).update({
      data: {
        frozen_points: _.inc(-need.points),
        available_points: _.inc(need.points),
        update_time: new Date()
      }
    })

    // 4. 创建积分流水记录
    await transaction.collection('wdd-point-records').add({
      data: {
        user_id: need.user_id,
        type: 'task_cancel',
        points: need.points,
        description: `任务「${need.type_name || '求助'}」超时取消，积分退还`,
        need_id: need._id,
        balance: seeker.total_points,
        create_time: new Date()
      }
    })

    // 4. 发送系统通知
    await transaction.collection('wdd-notifications').add({
      data: {
        user_id: need.user_id,
        type: 'task_cancelled',
        title: '任务已超时取消',
        content: `您发布的「${need.type_name || '求助'}」任务已超时，${need.points}积分已退还`,
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
}

