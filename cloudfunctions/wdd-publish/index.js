// 云函数：发布求助
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

  const {
    location,
    type,
    typeName,
    description,
    expireMinutes,
    points,
    images = []
  } = event


  // 参数校验（新格式: coordinates: [经度, 纬度]）
  if (!location || !location.name || !location.coordinates || !Array.isArray(location.coordinates) || location.coordinates.length !== 2 || !type || !points) {
    return {
      code: -1,
      message: '参数不完整'
    }
  }

  if (points < 10) {
    return {
      code: -1,
      message: '悬赏积分最少10分'
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

    // 检查积分是否足够
    if (user.available_points < points) {
      return {
        code: -1,
        message: '积分不足'
      }
    }

    // 计算过期时间
    const expireTime = new Date(Date.now() + expireMinutes * 60 * 1000)

    // 开始事务
    const transaction = await db.startTransaction()

    try {
      // 1. 创建求助任务
      // 使用 GeoJSON 格式保存位置: type: "Point", coordinates: [经度, 纬度]
      const needRes = await transaction.collection('wdd-needs').add({
        data: {
          user_id: userId,
          user_nickname: user.nickname,
          user_avatar: user.avatar,
          // 位置信息拆分为两个字段
          // location: GeoJSON 格式（数据库地理位置索引用）
          // location_name: 地点名称（展示用）
          location: {
            type: 'Point',
            coordinates: location.coordinates  // [经度, 纬度]
          },
          location_name: location.name,
          type: type,
          type_name: typeName,
          description: description || '',
          images: images || [],
          points: points,
          status: 'pending',      // pending: 待匹配, ongoing: 进行中, completed: 已完成, cancelled: 已取消
          expire_time: expireTime,
          create_time: db.serverDate(),
          update_time: db.serverDate(),
          taker_id: null,
          taker_nickname: null
        }
      })

      // 2. 冻结用户积分
      await transaction.collection('wdd-users').doc(userId).update({
        data: {
          available_points: _.inc(-points),
          frozen_points: _.inc(points),
          update_time: db.serverDate()
        }
      })

      // 3. 创建积分流水
      await transaction.collection('wdd-point-records').add({
        data: {
          user_id: userId,
          type: 'freeze',
          points: points,
          description: `发布求助冻结积分：${typeName}`,
          need_id: needRes._id,
          balance: user.total_points,
          create_time: db.serverDate()
        }
      })

      // 4. 创建系统通知
      await transaction.collection('wdd-notifications').add({
        data: {
          user_id: userId,
          type: 'system',
          title: '求助发布成功',
          content: `您发布的"${typeName}"求助已上线，正在为您匹配附近帮助者...`,
          need_id: needRes._id,
          is_read: false,
          create_time: db.serverDate()
        }
      })

      await transaction.commit()

      return {
        code: 0,
        message: '发布成功',
        data: {
          needId: needRes._id,
          expireTime: expireTime
        }
      }
    } catch (err) {
      await transaction.rollback()
      throw err
    }
  } catch (err) {
    console.error('发布失败:', err)
    return {
      code: -1,
      message: '发布失败: ' + err.message
    }
  }
}
