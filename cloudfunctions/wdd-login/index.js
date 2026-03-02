// 云函数：用户登录/注册
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { inviterId } = event  // 邀请人ID

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

      // 检查是否有邀请人
      let inviter = null
      let inviteBonus = 0
      if (inviterId) {
        const inviterRes = await db.collection('wdd-users').doc(inviterId).get()
        if (inviterRes.data) {
          inviter = inviterRes.data
          inviteBonus = 50  // 邀请奖励积分
        }
      }

      const newUser = {
        openid: OPENID,
        nickname: event.nickname || '微信用户',
        avatar: event.avatar || '',
        total_points: 100 + inviteBonus,      // 总积分（注册100 + 邀请奖励）
        available_points: 100 + inviteBonus,  // 可用积分
        frozen_points: 0,                      // 冻结积分
        role: 'both',                          // both: 双角色
        inviter_id: inviter ? inviter._id : null,
        invite_count: 0,                       // 邀请人数
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

      // 记录新用户积分流水（注册奖励）
      await db.collection('wdd-point-records').add({
        data: {
          user_id: addRes._id,
          type: 'gain',
          points: 100,
          description: '新用户注册奖励',
          balance: 100,
          create_time: db.serverDate()
        }
      })

      // 如果有邀请人，处理邀请奖励
      if (inviter) {
        const transaction = await db.startTransaction()
        try {
          // 1. 给被邀请人添加邀请奖励流水
          await transaction.collection('wdd-point-records').add({
            data: {
              user_id: addRes._id,
              type: 'invite',
              points: inviteBonus,
              description: '接受邀请奖励',
              balance: 100 + inviteBonus,
              create_time: db.serverDate()
            }
          })

          // 2. 给邀请人增加积分
          await transaction.collection('wdd-users').doc(inviter._id).update({
            data: {
              total_points: _.inc(inviteBonus),
              available_points: _.inc(inviteBonus),
              invite_count: _.inc(1),
              update_time: db.serverDate()
            }
          })

          // 3. 给邀请人添加积分流水
          await transaction.collection('wdd-point-records').add({
            data: {
              user_id: inviter._id,
              type: 'invite',
              points: inviteBonus,
              description: `邀请好友「${newUser.nickname}」奖励`,
              balance: inviter.total_points + inviteBonus,
              create_time: db.serverDate()
            }
          })

          // 4. 给邀请人发送通知
          await transaction.collection('wdd-notifications').add({
            data: {
              user_id: inviter._id,
              type: 'points_received',
              title: '邀请成功',
              content: `您邀请的好友「${newUser.nickname}」已注册，获得${inviteBonus}积分奖励`,
              is_read: false,
              create_time: db.serverDate()
            }
          })

          // 5. 记录邀请关系
          await transaction.collection('wdd-invite-records').add({
            data: {
              inviter_id: inviter._id,
              invitee_id: addRes._id,
              invitee_nickname: newUser.nickname,
              points: inviteBonus,
              create_time: db.serverDate()
            }
          })

          await transaction.commit()
        } catch (err) {
          await transaction.rollback()
          console.error('处理邀请奖励失败:', err)
          // 邀请失败不影响注册流程
        }
      }
    } else {
      // 老用户，返回已有信息
      userInfo = userRes.data[0]

      // 更新登录时间和用户信息（如果提供了）
      const updateData = {
        update_time: db.serverDate()
      }

      // 如果传入了新的昵称或头像，则更新
      if (event.nickname) {
        updateData.nickname = event.nickname
      }
      if (event.avatar) {
        updateData.avatar = event.avatar
      }

      await db.collection('wdd-users').doc(userInfo._id).update({
        data: updateData
      })

      // 更新本地 userInfo 对象
      if (event.nickname) userInfo.nickname = event.nickname
      if (event.avatar) userInfo.avatar = event.avatar
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
