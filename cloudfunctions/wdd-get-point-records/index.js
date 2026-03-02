// 云函数：获取积分记录
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { page = 1, pageSize = 20 } = event

  if (!OPENID) {
    return {
      code: -1,
      message: '获取用户openid失败'
    }
  }

  try {
    // 查询用户信息
    const userRes = await db.collection('wdd-users')
      .where({ openid: OPENID })
      .get()

    if (userRes.data.length === 0) {
      return {
        code: -1,
        message: '用户不存在'
      }
    }

    const user = userRes.data[0]
    const userId = user._id

    // 查询积分记录总数
    const countRes = await db.collection('wdd-point-records')
      .where({ user_id: userId })
      .count()

    const total = countRes.total

    // 查询积分记录
    const recordsRes = await db.collection('wdd-point-records')
      .where({ user_id: userId })
      .orderBy('create_time', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get()

    // 格式化记录
    const records = recordsRes.data.map(item => formatRecord(item))

    return {
      code: 0,
      message: '获取成功',
      data: {
        records,
        total,
        page,
        pageSize,
        hasMore: page * pageSize < total,
        // 当前积分信息
        currentPoints: {
          total: user.total_points,
          available: user.available_points,
          frozen: user.frozen_points
        }
      }
    }
  } catch (err) {
    console.error('获取积分记录失败:', err)
    return {
      code: -1,
      message: '获取失败: ' + err.message
    }
  }
}

// 格式化记录
function formatRecord(item) {
  // 类型映射
  const typeMap = {
    'gain': { label: '获得', color: '#07c160', icon: '+' },
    'freeze': { label: '冻结', color: '#ff9500', icon: '-' },
    'unfreeze': { label: '解冻', color: '#07c160', icon: '+' },
    'task_pay': { label: '任务支出', color: '#ff3b30', icon: '-' },
    'task_reward': { label: '任务收入', color: '#07c160', icon: '+' },
    'task_cancel': { label: '任务取消', color: '#07c160', icon: '+' },
    'invite': { label: '邀请奖励', color: '#07c160', icon: '+' }
  }

  const typeInfo = typeMap[item.type] || { label: '其他', color: '#999', icon: '' }

  // 格式化时间
  const createTime = new Date(item.create_time)
  const now = new Date()
  const diff = now - createTime

  let timeText = ''
  if (diff < 60000) {
    timeText = '刚刚'
  } else if (diff < 3600000) {
    timeText = Math.floor(diff / 60000) + '分钟前'
  } else if (diff < 86400000) {
    timeText = Math.floor(diff / 3600000) + '小时前'
  } else if (diff < 604800000) {
    timeText = Math.floor(diff / 86400000) + '天前'
  } else {
    timeText = `${createTime.getMonth() + 1}月${createTime.getDate()}日`
  }

  // 兼容处理：有些旧记录可能使用 amount 字段
  const pointValue = item.points !== undefined ? item.points : (item.amount || 0)

  return {
    _id: item._id,
    type: item.type,
    typeLabel: typeInfo.label,
    typeColor: typeInfo.color,
    icon: typeInfo.icon,
    amount: Math.abs(pointValue),
    description: item.description,
    balance: item.balance,
    needId: item.need_id || null,
    timeText,
    createTime: item.create_time
  }
}
