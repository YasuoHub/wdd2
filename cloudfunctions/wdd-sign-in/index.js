// 云函数：每日签到
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()

  if (!OPENID) {
    return {
      code: -1,
      message: '获取用户openid失败'
    }
  }

  try {
    // 查询用户信息
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

    const user = userRes.data[0]
    const userId = user._id

    // 获取今天的日期（YYYY-MM-DD）
    const today = new Date()
    const todayStr = today.toISOString().split('T')[0]

    // 检查今天是否已签到
    const signRes = await db.collection('wdd-sign-in-records')
      .where({
        user_id: userId,
        date: todayStr
      })
      .get()

    if (signRes.data.length > 0) {
      return {
        code: -1,
        message: '今日已签到'
      }
    }

    // 计算连续签到天数
    let consecutiveDays = user.consecutive_sign_days || 0
    const lastSignDate = user.last_sign_in_date

    if (lastSignDate) {
      const lastDate = new Date(lastSignDate)
      const diffDays = Math.floor((today - lastDate) / (1000 * 60 * 60 * 24))

      if (diffDays === 1) {
        // 连续签到
        consecutiveDays++
      } else if (diffDays > 1) {
        // 断签，重置
        consecutiveDays = 1
      }
    } else {
      consecutiveDays = 1
    }

    // 计算签到积分（1-7天递增：5, 10, 15, 20, 25, 30, 30）
    const pointsMap = [5, 10, 15, 20, 25, 30, 30]
    const points = pointsMap[Math.min(consecutiveDays - 1, 6)]

    // 开始事务
    const transaction = await db.startTransaction()

    try {
      // 1. 创建签到记录
      await transaction.collection('wdd-sign-in-records').add({
        data: {
          user_id: userId,
          date: todayStr,
          points: points,
          consecutive_days: consecutiveDays,
          create_time: db.serverDate()
        }
      })

      // 2. 更新用户积分
      await transaction.collection('wdd-users').doc(userId).update({
        data: {
          total_points: _.inc(points),
          available_points: _.inc(points),
          consecutive_sign_days: consecutiveDays,
          last_sign_in_date: todayStr,
          update_time: db.serverDate()
        }
      })

      // 3. 创建积分流水
      await transaction.collection('wdd-point-records').add({
        data: {
          user_id: userId,
          type: 'gain',
          amount: points,
          description: `连续${consecutiveDays}天签到奖励`,
          balance: user.total_points + points,
          create_time: db.serverDate()
        }
      })

      await transaction.commit()

      return {
        code: 0,
        message: '签到成功',
        data: {
          points: points,
          consecutiveDays: consecutiveDays,
          totalPoints: user.total_points + points
        }
      }
    } catch (err) {
      await transaction.rollback()
      throw err
    }
  } catch (err) {
    console.error('签到失败:', err)
    return {
      code: -1,
      message: '签到失败: ' + err.message
    }
  }
}
