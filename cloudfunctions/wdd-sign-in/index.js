// 云函数：每日签到
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

// 从 wdd-config 读取积分配置，未配置时使用默认值
async function getPointsConfig() {
  try {
    const configRes = await db.collection('wdd-config').doc('platform').get()
    const cfg = configRes.data
    if (cfg && cfg.points) {
      return {
        register: cfg.points.register ?? 100,
        invite: cfg.points.invite ?? 50,
        signInMap: cfg.points.signIn?.daily ?? [5, 10, 15, 20, 25, 30, 30]
      }
    }
  } catch (e) {}
  return {
    register: 100,
    invite: 50,
    signInMap: [5, 10, 15, 20, 25, 30, 30]
  }
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { action = 'sign' } = event

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

    const hasSignedToday = signRes.data.length > 0

    const pointsCfg = await getPointsConfig()

    // 如果是检查动作，直接返回签到状态
    if (action === 'check') {
      // 计算今天应得积分
      const consecutiveDays = user.consecutive_sign_days || 0
      const lastSignDate = user.last_sign_in_date
      let todayPoints = pointsCfg.signInMap[0]
      let willBeDay = 1

      if (lastSignDate) {
        const lastDate = new Date(lastSignDate)
        const diffDays = Math.floor((today - lastDate) / (1000 * 60 * 60 * 24))
        if (diffDays === 1) {
          willBeDay = consecutiveDays + 1
        } else if (diffDays === 0) {
          willBeDay = consecutiveDays
        } else {
          willBeDay = 1
        }
      }

      const signInMap = pointsCfg.signInMap
      todayPoints = signInMap[Math.min(willBeDay - 1, signInMap.length - 1)]

      return {
        code: 0,
        message: '获取签到状态成功',
        data: {
          hasSignedToday,
          todayPoints,
          consecutiveDays: hasSignedToday ? consecutiveDays : willBeDay
        }
      }
    }

    // 签到动作：检查今天是否已签到
    if (hasSignedToday) {
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

    // 计算签到积分（从配置读取）
    const signInMap = pointsCfg.signInMap
    const points = signInMap[Math.min(consecutiveDays - 1, signInMap.length - 1)]

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
          points: points,
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
