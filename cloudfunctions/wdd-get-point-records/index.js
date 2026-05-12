// 云函数：获取积分/余额记录
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { action, page = 1, pageSize = 20 } = event

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

    // 根据 action 路由到不同处理逻辑
    switch (action) {
      case 'getBalanceRecords':
        return await getBalanceRecords(userId, page, pageSize)
      case 'getPointRecords':
      default:
        return await getPointRecords(userId, page, pageSize, user)
    }
  } catch (err) {
    console.error('获取记录失败:', err)
    return {
      code: -1,
      message: '获取失败: ' + err.message
    }
  }
}

// 获取余额记录
async function getBalanceRecords(userId, page, pageSize) {
  // 余额记录使用 0-based 分页（客户端 wallet.js 从 0 开始传）
  const skip = page * pageSize

  // 查询总数
  const countRes = await db.collection('wdd-balance-records')
    .where({ user_id: userId })
    .count()

  const total = countRes.total

  // 查询记录
  const recordsRes = await db.collection('wdd-balance-records')
    .where({ user_id: userId })
    .orderBy('create_time', 'desc')
    .skip(skip)
    .limit(pageSize)
    .get()

  // 格式化记录
  const records = recordsRes.data.map(item => formatBalanceRecord(item))

  return {
    code: 0,
    message: '获取成功',
    data: {
      records,
      total,
      page,
      pageSize,
      hasMore: skip + records.length < total
    }
  }
}

// 获取积分记录
async function getPointRecords(userId, page, pageSize, user) {
  // 积分记录使用 1-based 分页（兼容旧客户端 point-records.js）
  const skip = (page - 1) * pageSize

  // 查询积分记录总数
  const countRes = await db.collection('wdd-point-records')
    .where({ user_id: userId })
    .count()

  const total = countRes.total

  // 查询积分记录
  const recordsRes = await db.collection('wdd-point-records')
    .where({ user_id: userId })
    .orderBy('create_time', 'desc')
    .skip(skip)
    .limit(pageSize)
    .get()

  // 格式化记录
  const records = recordsRes.data.map(item => formatPointRecord(item))

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
        total: user.total_points
      }
    }
  }
}

// 格式化余额记录（适配 wallet.wxml 展示）
function formatBalanceRecord(item) {
  // 类型映射
  const typeMap = {
    'task_income': {
      title: item.description || '任务收入',
      icon: '💰',
      iconBg: 'rgba(7, 193, 96, 0.1)',
      amountType: 'income'
    },
    'task_pay': {
      title: item.description || '任务支付',
      icon: '💳',
      iconBg: 'rgba(255, 59, 48, 0.1)',
      amountType: 'expense'
    },
    'refund': {
      title: item.description || '退款',
      icon: '↩️',
      iconBg: 'rgba(7, 193, 96, 0.1)',
      amountType: 'income'
    },
    'withdraw': {
      title: item.description || '提现',
      icon: '🏦',
      iconBg: 'rgba(255, 59, 48, 0.1)',
      amountType: 'expense'
    },
    'withdraw_fee': {
      title: item.description || '提现手续费',
      icon: '📋',
      iconBg: 'rgba(255, 149, 0, 0.1)',
      amountType: 'expense'
    }
  }

  const typeInfo = typeMap[item.type] || {
    title: item.description || '其他',
    icon: '💵',
    iconBg: 'rgba(153, 153, 153, 0.1)',
    amountType: item.amount >= 0 ? 'income' : 'expense'
  }

  return {
    _id: item._id,
    icon: typeInfo.icon,
    iconBg: typeInfo.iconBg,
    title: typeInfo.title,
    time: formatTime(item.create_time),
    amount: Number(item.amount),
    type: typeInfo.amountType,
    balance: item.balance || 0,
    needId: item.need_id || null
  }
}

// 格式化积分记录（适配 point-records 页面）
function formatPointRecord(item) {
  // 类型映射
  const typeMap = {
    'gain': { label: '获得', color: '#07c160', icon: '+' },
    'invite': { label: '邀请奖励', color: '#07c160', icon: '+' }
  }

  const typeInfo = typeMap[item.type] || { label: '其他', color: '#999', icon: '' }

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
    timeText: formatTimeText(item.create_time),
    createTime: item.create_time
  }
}

// 格式化时间（用于余额记录）
function formatTime(date) {
  const d = new Date(date)
  const now = new Date()
  const diff = now - d

  if (diff < 60000) {
    return '刚刚'
  } else if (diff < 3600000) {
    return Math.floor(diff / 60000) + '分钟前'
  } else if (diff < 86400000) {
    return Math.floor(diff / 3600000) + '小时前'
  } else if (diff < 604800000) {
    return Math.floor(diff / 86400000) + '天前'
  }

  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')

  if (year === now.getFullYear()) {
    return `${month}月${day}日 ${hours}:${minutes}`
  }
  return `${year}年${month}月${day}日 ${hours}:${minutes}`
}

// 格式化时间文本（用于积分记录，保持兼容）
function formatTimeText(date) {
  const createTime = new Date(date)
  const now = new Date()
  const diff = now - createTime

  if (diff < 60000) {
    return '刚刚'
  } else if (diff < 3600000) {
    return Math.floor(diff / 60000) + '分钟前'
  } else if (diff < 86400000) {
    return Math.floor(diff / 3600000) + '小时前'
  } else if (diff < 604800000) {
    return Math.floor(diff / 86400000) + '天前'
  }
  return `${createTime.getMonth() + 1}月${createTime.getDate()}日`
}
