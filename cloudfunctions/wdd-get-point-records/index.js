// 云函数：获取积分/余额记录
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command
const POINTS_PER_DEDUCTION_YUAN = 100

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100
}

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
      case 'exchangePointsForDeduction':
        return await exchangePointsForDeduction(user, event.points)
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

async function exchangePointsForDeduction(user, rawPoints) {
  const points = Number(rawPoints)
  if (!Number.isInteger(points) || points <= 0) {
    return { code: -1, message: '兑换积分必须是正整数' }
  }
  if (points % POINTS_PER_DEDUCTION_YUAN !== 0) {
    return { code: -1, message: `兑换积分需为 ${POINTS_PER_DEDUCTION_YUAN} 的整数倍` }
  }
  const currentPoints = Number(user.total_points || 0)
  if (currentPoints < points) {
    return { code: -1, message: '积分不足' }
  }

  const deductionAmount = roundMoney(points / POINTS_PER_DEDUCTION_YUAN)
  const transaction = await db.startTransaction()

  try {
    const userInTx = await transaction.collection('wdd-users').doc(user._id).get()
    const latestUser = userInTx.data
    const latestPoints = Number(latestUser.total_points || 0)
    if (latestPoints < points) {
      await transaction.rollback()
      return { code: -1, message: '积分不足' }
    }

    const nextPoints = latestPoints - points
    const nextDeductionBalance = roundMoney((latestUser.deduction_balance || 0) + deductionAmount)

    await transaction.collection('wdd-users').doc(user._id).update({
      data: {
        total_points: _.inc(-points),
        deduction_balance: _.inc(deductionAmount),
        update_time: db.serverDate()
      }
    })

    await transaction.collection('wdd-point-records').add({
      data: {
        user_id: user._id,
        type: 'exchange',
        points: -points,
        description: `兑换 ¥${deductionAmount.toFixed(2)} 平台抵扣金`,
        balance: nextPoints,
        deduction_amount: deductionAmount,
        create_time: db.serverDate()
      }
    })

    await transaction.collection('wdd-balance-records').add({
      data: {
        user_id: user._id,
        type: 'deduction_exchange',
        amount: 0,
        balance: latestUser.balance || 0,
        frozen_balance: latestUser.frozen_balance || 0,
        deduction_amount: deductionAmount,
        deduction_balance: nextDeductionBalance,
        description: `积分兑换平台抵扣金 ¥${deductionAmount.toFixed(2)}`,
        create_time: db.serverDate()
      }
    })

    await transaction.commit()

    return {
      code: 0,
      message: '兑换成功',
      data: {
        usedPoints: points,
        deductionAmount,
        totalPoints: nextPoints,
        deductionBalance: nextDeductionBalance
      }
    }
  } catch (err) {
    await transaction.rollback()
    console.error('积分兑换平台抵扣金失败:', err)
    return { code: -1, message: '兑换失败: ' + err.message }
  }
}

// 获取余额记录
async function getBalanceRecords(userId, page, pageSize) {
  // 余额记录使用 0-based 分页（客户端 wallet.js 从 0 开始传）
  const skip = page * pageSize
  const visibleRecordWhere = {
    user_id: userId,
    // 钱包收支明细只展示实际余额发生变化的记录。
    // 纯平台抵扣金赠送、兑换或支付的 amount 均为 0，因此不会混入余额流水。
    // 冻结、解冻、取消退款属于资金状态回退，也不作为收支展示。
    type: _.nin(['freeze', 'unfreeze', 'refund', 'arbitration_refund']),
    amount: _.neq(0)
  }

  // 查询总数
  const countRes = await db.collection('wdd-balance-records')
    .where(visibleRecordWhere)
    .count()

  const total = countRes.total

  // 查询记录
  const recordsRes = await db.collection('wdd-balance-records')
    .where(visibleRecordWhere)
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
        total: user.total_points,
        deductionBalance: user.deduction_balance || 0,
        frozenDeductionBalance: user.frozen_deduction_balance || 0,
        exchangeRate: POINTS_PER_DEDUCTION_YUAN
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
      icon: 'hand-coins',
      iconColor: '#1F8F7A',
      iconBg: 'rgba(7, 193, 96, 0.1)',
      amountType: 'income'
    },
    'deduction_gift': {
      title: item.description || '平台抵扣金',
      icon: 'ticket',
      iconColor: '#1F8F7A',
      iconBg: 'rgba(7, 193, 96, 0.1)',
      amountType: 'income'
    },
    'deduction_exchange': {
      title: item.description || '积分兑换平台抵扣金',
      icon: 'ticket',
      iconColor: '#1F8F7A',
      iconBg: 'rgba(7, 193, 96, 0.1)',
      amountType: 'income'
    },
    'system_gift': {
      title: item.description || '系统赠送',
      icon: 'gift',
      iconColor: '#1F8F7A',
      iconBg: 'rgba(7, 193, 96, 0.1)',
      amountType: 'income'
    },
    'task_pay': {
      title: item.description || '任务支付',
      icon: 'credit-card',
      iconColor: '#D96A22',
      iconBg: 'rgba(255, 59, 48, 0.1)',
      amountType: 'expense'
    },
    'refund': {
      title: item.description || '退款',
      icon: 'refresh-cw',
      iconColor: '#1F8F7A',
      iconBg: 'rgba(7, 193, 96, 0.1)',
      amountType: 'income'
    },
    'withdraw': {
      title: item.description || '提现',
      icon: 'landmark',
      iconColor: '#1677D2',
      iconBg: 'rgba(255, 59, 48, 0.1)',
      amountType: 'expense'
    },
    'withdraw_fee': {
      title: item.description || '提现手续费',
      icon: 'receipt-text',
      iconColor: '#D96A22',
      iconBg: 'rgba(255, 149, 0, 0.1)',
      amountType: 'expense'
    },
    'freeze': {
      title: item.description || '提现冻结',
      icon: '🔒',
      iconBg: 'rgba(255, 149, 0, 0.1)',
      amountType: 'expense'
    },
    'unfreeze': {
      title: item.description || '冻结解除',
      icon: '🔓',
      iconBg: 'rgba(7, 193, 96, 0.1)',
      amountType: 'income'
    },
    'arbitration_refund': {
      title: item.description || '客服退款',
      icon: '↩️',
      iconBg: 'rgba(7, 193, 96, 0.1)',
      amountType: 'income'
    }
  }

  const typeInfo = typeMap[item.type] || {
    title: item.description || '其他',
    icon: 'circle-dollar-sign',
    iconColor: item.amount >= 0 ? '#1F8F7A' : '#D96A22',
    iconBg: 'rgba(153, 153, 153, 0.1)',
    amountType: item.amount >= 0 ? 'income' : 'expense'
  }

  return {
    _id: item._id,
    icon: typeInfo.icon,
    iconColor: typeInfo.iconColor,
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
    'invite': { label: '邀请奖励', color: '#07c160', icon: '+' },
    'exchange': { label: '权益兑换', color: '#D96A22', icon: '-' }
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
    amount: pointValue,
    description: item.description,
    balance: item.balance,
    needId: item.need_id || null,
    timeText: formatTimeText(item.create_time),
    createTime: item.create_time
  }
}

// 格式化时间（用于余额记录）
// 注意：绝对时间分支强制按北京时间 UTC+8 输出，避免云函数环境时区为 UTC 导致时间差 8 小时
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

  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000)
  const nowBj = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  const year = bj.getUTCFullYear()
  const month = String(bj.getUTCMonth() + 1).padStart(2, '0')
  const day = String(bj.getUTCDate()).padStart(2, '0')
  const hours = String(bj.getUTCHours()).padStart(2, '0')
  const minutes = String(bj.getUTCMinutes()).padStart(2, '0')

  if (year === nowBj.getUTCFullYear()) {
    return `${month}月${day}日 ${hours}:${minutes}`
  }
  return `${year}年${month}月${day}日 ${hours}:${minutes}`
}

// 格式化时间文本（用于积分记录，保持兼容）
// 注意：超过 7 天的日期按北京时间 UTC+8 输出
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
  const bj = new Date(createTime.getTime() + 8 * 60 * 60 * 1000)
  return `${bj.getUTCMonth() + 1}月${bj.getUTCDate()}日`
}
