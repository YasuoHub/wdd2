// 云函数：接单
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { needId } = event

  if (!needId) {
    return {
      code: -1,
      message: '任务ID不能为空'
    }
  }

  try {
    // 查询帮助者信息
    const userRes = await db.collection('wdd-users')
      .where({
        openid: OPENID
      })
      .get()

    if (userRes.data.length === 0) {
      return {
        code: -1,
        message: '用户不存在'
      }
    }

    const taker = userRes.data[0]
    const takerId = taker._id

    // 查询任务
    const needRes = await db.collection('wdd-needs').doc(needId).get()
    const need = needRes.data

    if (!need) {
      return {
        code: -1,
        message: '任务不存在'
      }
    }

    // 检查任务状态
    if (need.status !== 'pending') {
      return {
        code: -1,
        message: need.status === 'ongoing' ? '该任务已被接单' : '该任务已结束'
      }
    }

    // 检查是否是自己发布的任务
    if (need.user_id === takerId) {
      return {
        code: -1,
        message: '不能接自己的任务'
      }
    }

    // 检查是否已过期
    if (new Date() > new Date(need.expire_time)) {
      return {
        code: -1,
        message: '该任务已过期'
      }
    }

    // 开始事务
    const transaction = await db.startTransaction()

    try {
      // 1. 更新任务状态
      await transaction.collection('wdd-needs').doc(needId).update({
        data: {
          status: 'ongoing',
          taker_id: takerId,
          taker_nickname: taker.nickname,
          taker_avatar: taker.avatar,
          match_time: db.serverDate(),
          update_time: db.serverDate()
        }
      })

      // 2. 创建接单记录
      await transaction.collection('wdd-need-takers').add({
        data: {
          need_id: needId,
          taker_id: takerId,
          need_user_id: need.user_id,
          points: need.points,
          status: 'ongoing',
          create_time: db.serverDate(),
          update_time: db.serverDate()
        }
      })

      // 3. 给求助者发送通知
      await transaction.collection('wdd-notifications').add({
        data: {
          user_id: need.user_id,
          type: 'task_matched',
          title: '有帮助者接单了！',
          content: `${taker.nickname} 已承接您的"${need.type_name}"求助，快去看看吧`,
          need_id: needId,
          is_read: false,
          create_time: db.serverDate()
        }
      })

      // 4. 给帮助者发送通知
      await transaction.collection('wdd-notifications').add({
        data: {
          user_id: takerId,
          type: 'system',
          title: '接单成功',
          content: `您已成功承接"${need.type_name}"任务，请及时提供帮助`,
          need_id: needId,
          is_read: false,
          create_time: db.serverDate()
        }
      })

      await transaction.commit()

      return {
        code: 0,
        message: '接单成功',
        data: {
          needId: needId
        }
      }
    } catch (err) {
      await transaction.rollback()
      throw err
    }
  } catch (err) {
    console.error('接单失败:', err)
    return {
      code: -1,
      message: '接单失败: ' + err.message
    }
  }
}
