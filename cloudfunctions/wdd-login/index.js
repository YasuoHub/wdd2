// 云函数：用户登录/注册
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
    // 查询用户是否已存在
    const userRes = await db.collection('wdd-users')
      .where({
        openid: OPENID
      })
      .get()

    let userInfo
    let isNewUser = false

    if (userRes.data.length === 0) {
      // 新用户，创建记录
      isNewUser = true
      const newUser = {
        openid: OPENID,
        nickname: event.nickname || '微信用户',
        avatar: event.avatar || '',
        total_points: 100,      // 总积分
        available_points: 100,  // 可用积分
        frozen_points: 0,       // 冻结积分
        role: 'both',           // both: 双角色
        create_time: db.serverDate(),
        update_time: db.serverDate(),
        last_sign_in_date: null,
        consecutive_sign_days: 0
      }

      const addRes = await db.collection('wdd-users').add({
        data: newUser
      })

      userInfo = {
        _id: addRes._id,
        ...newUser
      }

      // 记录积分流水
      await db.collection('wdd-point-records').add({
        data: {
          user_id: addRes._id,
          type: 'gain',           // gain: 获得
          amount: 100,
          description: '新用户注册奖励',
          balance: 100,
          create_time: db.serverDate()
        }
      })
    } else {
      // 老用户，返回已有信息
      userInfo = userRes.data[0]

      // 更新登录时间
      await db.collection('wdd-users').doc(userInfo._id).update({
        data: {
          update_time: db.serverDate()
        }
      })
    }

    return {
      code: 0,
      message: '登录成功',
      data: {
        userInfo: {
          _id: userInfo._id,
          nickname: userInfo.nickname,
          avatar: userInfo.avatar,
          total_points: userInfo.total_points,
          available_points: userInfo.available_points,
          frozen_points: userInfo.frozen_points,
          role: userInfo.role,
          consecutive_sign_days: userInfo.consecutive_sign_days
        },
        isNewUser
      }
    }
  } catch (err) {
    console.error('登录失败:', err)
    return {
      code: -1,
      message: '登录失败: ' + err.message
    }
  }
}
