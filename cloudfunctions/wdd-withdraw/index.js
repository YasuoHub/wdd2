// 提现云函数 - 处理提现申请
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const { MoneyUtils, PLATFORM_RULES } = require('./platformRules')

// 主入口
exports.main = async (event, context) => {
  const { action } = event
  const wxContext = cloud.getWXContext()
  const OPENID = wxContext.OPENID

  if (!OPENID) {
    return { code: -1, message: '获取用户openid失败' }
  }

  try {
    switch (action) {
      case 'apply':
        return await applyWithdraw(event, OPENID)
      case 'query':
        return await queryWithdraws(event, OPENID)
      case 'adminApprove':
        return await adminApprove(event, OPENID)
      default:
        return { code: -1, message: '未知操作' }
    }
  } catch (err) {
    console.error('提现操作失败:', err)
    return { code: -1, message: err.message }
  }
}

// 申请提现
async function applyWithdraw(event, OPENID) {
  const { amount } = event

  if (!amount || amount <= 0) {
    return { code: -1, message: '提现金额必须大于0' }
  }

  // 校验提现金额
  const amountCheck = MoneyUtils.checkWithdrawAmount(amount, Infinity)
  if (!amountCheck.valid) {
    return { code: -1, message: amountCheck.reason }
  }

  // 获取用户信息
  const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
  if (userRes.data.length === 0) {
    return { code: -1, message: '用户不存在' }
  }

  const user = userRes.data[0]

  // 检查最低提现门槛（业务规则，事务外快速拒绝）
  const withdrawCheck = MoneyUtils.checkCanWithdraw(user.balance || 0)
  if (!withdrawCheck.canWithdraw) {
    return { code: -1, message: withdrawCheck.reason }
  }

  // 计算手续费和到账金额
  const fee = MoneyUtils.calcWithdrawFee(amount)
  const actualAmount = MoneyUtils.calcWithdrawActual(amount)

  // 生成提现单号
  const withdrawId = generateWithdrawNo()

  // 开启事务
  const transaction = await db.startTransaction()

  try {
    // 1. 事务内查询最新余额（防止并发扣减）
    const latestUserRes = await transaction.collection('wdd-users').doc(user._id).get()
    const latestBalance = latestUserRes.data.balance || 0

    // 检查余额是否足够
    if (amount > latestBalance) {
      await transaction.rollback()
      return { code: -1, message: '余额不足' }
    }

    // 2. 扣除用户余额
    await transaction.collection('wdd-users').doc(user._id).update({
      data: {
        balance: _.inc(-amount),
        total_withdrawn: _.inc(amount),
        update_time: new Date()
      }
    })

    // 3. 写入余额流水（使用事务内查询的最新余额）
    await transaction.collection('wdd-balance-records').add({
      data: {
        _id: withdrawId,
        user_id: user._id,
        openid: OPENID,
        type: 'withdraw',
        amount: -amount,
        balance: latestBalance - amount,
        description: `提现申请 ¥${amount}`,
        // 提现专属字段
        withdraw_amount: amount,
        fee: fee,
        actual_amount: actualAmount,
        status: 'pending', // pending: 待审核, processing: 处理中, completed: 已完成, rejected: 已拒绝
        payment_no: null,
        payment_time: null,
        reject_reason: null,
        apply_time: new Date(),
        create_time: new Date(),
        update_time: new Date()
      }
    })

    await transaction.commit()

    return {
      code: 0,
      message: '提现申请已提交',
      data: {
        withdrawId: withdrawId,
        amount: amount,
        fee: fee,
        actualAmount: actualAmount
      }
    }

  } catch (err) {
    await transaction.rollback()
    console.error('提现事务失败:', err)
    return { code: -1, message: '提现申请失败: ' + err.message }
  }
}

// 查询提现记录
async function queryWithdraws(event, OPENID) {
  const { page = 0, pageSize = 20 } = event

  try {
    // 提现记录已合并到 wdd-balance-records，通过 type='withdraw' 筛选
    const withdrawRes = await db.collection('wdd-balance-records')
      .where({ openid: OPENID, type: 'withdraw' })
      .orderBy('apply_time', 'desc')
      .skip(page * pageSize)
      .limit(pageSize)
      .get()

    const records = withdrawRes.data.map(item => ({
      _id: item._id,
      amount: item.withdraw_amount, // 提现金额存在 withdraw_amount 字段（amount 是负数流水）
      fee: item.fee,
      actualAmount: item.actual_amount,
      status: item.status,
      statusText: getWithdrawStatusText(item.status),
      applyTime: formatTime(item.apply_time),
      paymentTime: item.payment_time ? formatTime(item.payment_time) : null
    }))

    return {
      code: 0,
      message: '查询成功',
      data: { records }
    }
  } catch (err) {
    console.error('查询提现记录失败:', err)
    return { code: -1, message: '查询失败: ' + err.message }
  }
}

// 管理员审核通过（预留）
async function adminApprove(event, OPENID) {
  const { withdrawId } = event

  // TODO: 添加管理员权限校验

  if (!withdrawId) {
    return { code: -1, message: '提现ID不能为空' }
  }

  // 查询提现记录（已合并到 wdd-balance-records）
  const withdrawRes = await db.collection('wdd-balance-records').doc(withdrawId).get()
  if (!withdrawRes.data) {
    return { code: -1, message: '提现记录不存在' }
  }

  const withdraw = withdrawRes.data

  // 校验是否为提现类型记录
  if (withdraw.type !== 'withdraw') {
    return { code: -1, message: '该记录非提现申请' }
  }

  if (withdraw.status !== 'pending') {
    return { code: -1, message: '提现状态不允许审核' }
  }

  // 更新提现状态
  await db.collection('wdd-balance-records').doc(withdrawId).update({
    data: {
      status: 'completed',
      payment_time: new Date(),
      update_time: new Date()
    }
  })

  // TODO: 真实支付场景下，这里调用企业付款到零钱API

  return {
    code: 0,
    message: '提现审核通过',
    data: { withdrawId }
  }
}

// 生成提现单号
function generateWithdrawNo() {
  const now = new Date()
  const dateStr = now.getFullYear().toString().slice(2) +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0')
  const timeStr = String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0')
  const randomStr = Math.random().toString(36).substr(2, 6).toUpperCase()
  return `WDW${dateStr}${timeStr}${randomStr}`
}

// 获取提现状态文本
function getWithdrawStatusText(status) {
  const statusMap = {
    'pending': '待审核',
    'processing': '处理中',
    'completed': '已完成',
    'rejected': '已拒绝'
  }
  return statusMap[status] || status
}

// 格式化时间
function formatTime(date) {
  if (!date) return ''
  const d = new Date(date)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hour = String(d.getHours()).padStart(2, '0')
  const minute = String(d.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}`
}
