// 提现申请审批云函数
// 处理用户提现申请提交、超级管理员审批（通过/驳回）
//
// 当前审核版本说明：
// 为整改“提现存在门槛/用户无法即时提现”的审核反馈，人工资金审批流程已停用。
// 旧代码保留是为了兼容历史审批记录，并便于后续如需恢复“大额人工复核”时快速恢复。
// 新用户提现应直接调用 wdd-withdraw 的 apply 流程，由每日限额、次数限制和微信转账结果做风控。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

// 金额格式化（最多2位小数，尾随零省略）
function formatAmount(n) {
  const num = Math.round(Number(n) * 100) / 100
  if (num % 1 === 0) return String(num)
  if (num * 10 % 1 === 0) return num.toFixed(1)
  return num.toFixed(2)
}

// 驳回理由选项
const REJECT_REASONS = [
  '提现金额超出合理范围',
  '账户存在异常交易行为',
  '身份信息未通过验证',
  '提现频次过高，请稍后再试',
  '不符合平台提现规则',
  '其他原因'
]

// 累计今日已提现金额
async function sumTodayWithdrawAmount(openid) {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const res = await db.collection('wdd-withdraws')
    .where({
      openid: openid,
      status: _.in(['processing', 'completed', 'transfer_pending']),
      apply_time: _.gte(start)
    })
    .get()
  return res.data.reduce((sum, r) => sum + (r.amount || 0), 0)
}

// 累计今日已提现次数
async function sumTodayWithdrawCount(openid) {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const res = await db.collection('wdd-withdraws')
    .where({
      openid: openid,
      status: _.in(['processing', 'completed', 'transfer_pending']),
      apply_time: _.gte(start)
    })
    .count()
  return res.total
}

// 从 wdd-config 加载平台配置
async function loadConfig() {
  const res = await db.collection('wdd-config').doc('platform').get().catch(() => null)
  if (res && res.data) return res.data
  return {}
}

// 判断是否为超级管理员
async function isSuperAdmin(openid) {
  const config = await loadConfig()
  const saOpenids = config.super_admin_openids || []
  return saOpenids.includes(openid)
}

// 格式化时间
function formatTime(date) {
  if (!date) return ''
  const d = new Date(date)
  if (isNaN(d.getTime())) return ''
  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000)
  const year = bj.getUTCFullYear()
  const month = String(bj.getUTCMonth() + 1).padStart(2, '0')
  const day = String(bj.getUTCDate()).padStart(2, '0')
  const hour = String(bj.getUTCHours()).padStart(2, '0')
  const minute = String(bj.getUTCMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}`
}

// 获取状态文本
function getStatusText(status) {
  const map = {
    'pending': '待审批',
    'approved': '已通过',
    'rejected': '已驳回',
    'expired': '已过期'
  }
  return map[status] || status
}

exports.main = async (event, context) => {
  const { action } = event
  const wxContext = cloud.getWXContext()
  const OPENID = wxContext.OPENID

  // expire 由定时任务调用，无 OPENID
  const isInternalCall = (action === 'expire')

  if (!OPENID && !isInternalCall) {
    return { code: -1, message: '获取用户openid失败' }
  }

  try {
    switch (action) {
      case 'apply':
        return await apply(event, OPENID)
      case 'getMyApplications':
        return await getMyApplications(event, OPENID)
      case 'getApplicationList':
        return await getApplicationList(event, OPENID)
      case 'approve':
        return await approve(event, OPENID)
      case 'reject':
        return await rejectApplication(event, OPENID)
      case 'expire':
        return await expireApplication(event)
      default:
        return { code: -1, message: '未知操作' }
    }
  } catch (err) {
    console.error('提现申请操作失败:', err)
    return { code: -1, message: err.message }
  }
}

// ========================================
// 用户提交提现申请
// ========================================
async function apply(event, OPENID) {
  const { amount } = event

  return {
    code: -1,
    message: '当前版本已停用人工提现审批，请返回钱包直接发起提现'
  }

  /*
   * 以下为旧资金审批申请逻辑，当前版本保留但不执行。
   * 停用原因：微信审核反馈提现服务存在提现门槛/无法即时提现风险。
   * 后续如恢复大额人工复核，可移除上方 return，并重新启用钱包页审批入口、资金审批菜单和规则文案。
   */

  if (!amount || amount <= 0) {
    return { code: -1, message: '提现金额必须大于0' }
  }

  const config = await loadConfig()

  // 校验最低提现门槛
  const minAmount = config.withdraw_min_amount || 2
  const maxPerRequest = config.withdraw_max_per_request || 5000
  const minPerRequest = config.withdraw_min_per_request || 1

  if (amount < minPerRequest) {
    return { code: -1, message: `单次提现最低${minPerRequest}元` }
  }
  if (amount > maxPerRequest) {
    return { code: -1, message: `单次提现最高${maxPerRequest}元` }
  }

  // 单日提现次数校验
  const dailyTimes = config.withdraw_daily_times ?? 3
  const dailyCount = await sumTodayWithdrawCount(OPENID)
  if (dailyCount >= dailyTimes) {
    return { code: -1, message: `今日提现次数已达上限（${dailyTimes}次），请明天再试` }
  }

  // 单日累计金额校验
  const dailyLimit = config.withdraw_daily_limit ?? 5000
  const dailyTotal = await sumTodayWithdrawAmount(OPENID)
  if (dailyTotal + amount > dailyLimit) {
    return {
      code: -1,
      message: `超过单日提现限额 ¥${formatAmount(dailyLimit)}（今日已提现 ¥${formatAmount(dailyTotal)}）`
    }
  }

  // 查询用户
  const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
  if (userRes.data.length === 0) {
    return { code: -1, message: '用户不存在' }
  }

  const user = userRes.data[0]
  const balance = user.balance || 0
  const frozenBalance = user.frozen_balance || 0
  const availableBalance = balance - frozenBalance

  if (availableBalance < minAmount) {
    return { code: -1, message: `可用余额满${minAmount}元才可申请提现` }
  }

  if (amount > availableBalance) {
    return { code: -1, message: '可用余额不足（含已冻结金额）' }
  }

  // 校验审批阈值：低于阈值走即时到账，无需提交审批申请
  const approvalThreshold = config.withdraw_approval_threshold
  if (approvalThreshold !== undefined && approvalThreshold !== null && amount <= approvalThreshold) {
    return { code: -1, message: `提现金额不超过¥${approvalThreshold}，无需审批，请直接提现` }
  }

  // 检查是否有待审批的申请（同一用户不允许有重复 pending）
  const existingRes = await db.collection('wdd-withdraw-applications')
    .where({
      user_id: user._id,
      status: 'pending'
    })
    .get()

  if (existingRes.data.length > 0) {
    return { code: -1, message: '您有一个提现申请正在审批中，请耐心等待' }
  }

  // 检查是否有已通过但未提现的申请
  const approvedRes = await db.collection('wdd-withdraw-applications')
    .where({
      user_id: user._id,
      status: 'approved',
      withdraw_status: 'not_withdrawn'
    })
    .get()

  if (approvedRes.data.length > 0) {
    return { code: -1, message: '您有一个已通过的提现申请尚未提现，请先完成提现' }
  }

  // 计算手续费和到账金额
  const feeRate = config.withdraw_fee_rate || 0.01
  const fee = Math.round(amount * feeRate * 100) / 100
  const actualAmount = Math.round((amount - fee) * 100) / 100

  // 事务：原子性冻结金额 + 写入申请记录
  const transaction = await db.startTransaction()
  try {
    const userInTx = await transaction.collection('wdd-users').doc(user._id).get()
    const currentBalance = userInTx.data.balance || 0
    const currentFrozen = userInTx.data.frozen_balance || 0
    const currentAvailable = currentBalance - currentFrozen

    if (amount > currentAvailable) {
      await transaction.rollback()
      return { code: -1, message: '可用余额不足' }
    }

    // 冻结金额
    await transaction.collection('wdd-users').doc(user._id).update({
      data: {
        frozen_balance: _.inc(amount),
        update_time: new Date()
      }
    })

    // 写入冻结流水
    await transaction.collection('wdd-balance-records').add({
      data: {
        user_id: user._id,
        type: 'freeze',
        amount: -amount,
        balance: currentBalance,
        frozen_balance: currentFrozen + amount,
        description: `提现申请冻结 ¥${formatAmount(amount)}`,
        create_time: new Date()
      }
    })

    // 写入申请记录
    const appRes = await transaction.collection('wdd-withdraw-applications').add({
      data: {
        user_id: user._id,
        openid: OPENID,
        amount: amount,
        fee: fee,
        actual_amount: actualAmount,
        status: 'pending',
        withdraw_status: 'not_withdrawn',
        expire_time: null,
        reject_reason: null,
        handler_id: null,
        apply_time: new Date(),
        approve_time: null,
        withdraw_time: null,
        withdraw_id: null,
        create_time: new Date(),
        update_time: new Date()
      }
    })

    await transaction.commit()

    return {
      code: 0,
      message: '提现申请已提交，请等待审批',
      data: {
        applicationId: appRes._id,
        amount,
        fee,
        actualAmount
      }
    }
  } catch (err) {
    await transaction.rollback()
    console.error('提现申请事务失败:', err)
    return { code: -1, message: '提交失败: ' + err.message }
  }
}

// ========================================
// 用户获取自己的申请记录
// ========================================
async function getMyApplications(event, OPENID) {
  const { page = 0, pageSize = 20 } = event

  const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
  if (userRes.data.length === 0) {
    return { code: -1, message: '用户不存在' }
  }

  const userId = userRes.data[0]._id

  const totalRes = await db.collection('wdd-withdraw-applications')
    .where({ user_id: userId })
    .count()

  const listRes = await db.collection('wdd-withdraw-applications')
    .where({ user_id: userId })
    .orderBy('create_time', 'desc')
    .skip(page * pageSize)
    .limit(pageSize + 1)
    .get()

  const hasMore = listRes.data.length > pageSize
  if (hasMore) listRes.data.pop()

  const records = listRes.data.map(item => ({
    _id: item._id,
    amount: item.amount,
    fee: item.fee,
    actualAmount: item.actual_amount,
    status: item.status,
    statusText: getStatusText(item.status),
    withdrawStatus: item.withdraw_status,
    rejectReason: item.reject_reason || '',
    applyTime: formatTime(item.apply_time),
    approveTime: item.approve_time ? formatTime(item.approve_time) : '',
    expireTime: item.expire_time ? formatTime(item.expire_time) : '',
    withdrawTime: item.withdraw_time ? formatTime(item.withdraw_time) : ''
  }))

  return {
    code: 0,
    data: { records, total: totalRes.total, hasMore }
  }
}

// ========================================
// 超级管理员获取审批列表
// ========================================
async function getApplicationList(event, OPENID) {
  if (!(await isSuperAdmin(OPENID))) {
    return { code: -1, message: '无权限访问' }
  }

  const { status = 'pending', page = 0, pageSize = 20 } = event

  let whereCondition = {}
  if (status === 'pending') {
    whereCondition.status = 'pending'
  } else if (status === 'resolved') {
    whereCondition.status = _.in(['approved', 'rejected', 'expired'])
  }

  const listRes = await db.collection('wdd-withdraw-applications')
    .where(whereCondition)
    .orderBy('create_time', 'desc')
    .skip(page * pageSize)
    .limit(pageSize + 1)
    .get()

  const hasMore = listRes.data.length > pageSize
  if (hasMore) listRes.data.pop()

  // 关联查询用户信息
  const userIds = [...new Set(listRes.data.map(item => item.user_id))]
  const usersMap = {}
  if (userIds.length > 0) {
    const usersRes = await db.collection('wdd-users')
      .where({ _id: _.in(userIds) })
      .get()
    usersRes.data.forEach(u => {
      usersMap[u._id] = {
        nickname: u.nickname || '微信用户',
        avatar: u.avatar || ''
      }
    })
  }

  const records = listRes.data.map(item => ({
    _id: item._id,
    userId: item.user_id,
    nickname: (usersMap[item.user_id] && usersMap[item.user_id].nickname) || '微信用户',
    avatar: (usersMap[item.user_id] && usersMap[item.user_id].avatar) || '',
    amount: item.amount,
    fee: item.fee,
    actualAmount: item.actual_amount,
    status: item.status,
    statusText: getStatusText(item.status),
    withdrawStatus: item.withdraw_status,
    rejectReason: item.reject_reason || '',
    applyTime: formatTime(item.apply_time),
    approveTime: item.approve_time ? formatTime(item.approve_time) : '',
    expireTime: item.expire_time ? formatTime(item.expire_time) : '',
    withdrawTime: item.withdraw_time ? formatTime(item.withdraw_time) : ''
  }))

  return {
    code: 0,
    data: { records, hasMore }
  }
}

// ========================================
// 审批通过
// ========================================
async function approve(event, OPENID) {
  if (!(await isSuperAdmin(OPENID))) {
    return { code: -1, message: '无权限操作' }
  }

  const { applicationId } = event
  if (!applicationId) {
    return { code: -1, message: '申请ID不能为空' }
  }

  const appRes = await db.collection('wdd-withdraw-applications').doc(applicationId).get().catch(() => null)
  if (!appRes || !appRes.data) {
    return { code: -1, message: '申请记录不存在' }
  }

  const application = appRes.data
  if (application.status !== 'pending') {
    return { code: -1, message: '该申请已处理，无法重复审批' }
  }

  await db.collection('wdd-withdraw-applications').doc(applicationId).update({
    data: {
      status: 'approved',
      handler_id: OPENID,
      approve_time: new Date(),
      expire_time: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      update_time: new Date()
    }
  })

  // 发送通知给申请人
  try {
    await db.collection('wdd-notifications').add({
      data: {
        user_id: application.user_id,
        type: 'system',
        title: '提现申请已通过',
        content: `您的提现申请（¥${application.amount}）已审批通过，请在3天内前往钱包页面发起提现，逾期需重新申请。`,
        is_read: false,
        create_time: new Date()
      }
    })
  } catch (err) {
    console.warn('发送通知失败:', err)
  }

  return {
    code: 0,
    message: '审批通过'
  }
}

// ========================================
// 审批驳回
// ========================================
async function rejectApplication(event, OPENID) {
  if (!(await isSuperAdmin(OPENID))) {
    return { code: -1, message: '无权限操作' }
  }

  const { applicationId, rejectReason } = event
  if (!applicationId) {
    return { code: -1, message: '申请ID不能为空' }
  }
  if (!rejectReason) {
    return { code: -1, message: '驳回理由不能为空' }
  }

  // 先查申请记录（事务外）
  const appRes = await db.collection('wdd-withdraw-applications').doc(applicationId).get().catch(() => null)
  if (!appRes || !appRes.data) {
    return { code: -1, message: '申请记录不存在' }
  }

  const application = appRes.data
  if (application.status !== 'pending') {
    return { code: -1, message: '该申请已处理，无法重复审批' }
  }

  // 事务：原子性解冻 + 更新状态
  const transaction = await db.startTransaction()
  try {
    const appInTx = await transaction.collection('wdd-withdraw-applications').doc(applicationId).get()
    if (!appInTx.data || appInTx.data.status !== 'pending') {
      await transaction.rollback()
      return { code: -1, message: '该申请已处理，无法重复审批' }
    }

    // 解冻金额
    await transaction.collection('wdd-users').doc(application.user_id).update({
      data: {
        frozen_balance: _.inc(-application.amount),
        update_time: new Date()
      }
    })

    // 写入解冻流水
    const userInTx = await transaction.collection('wdd-users').doc(application.user_id).get()
    await transaction.collection('wdd-balance-records').add({
      data: {
        user_id: application.user_id,
        type: 'unfreeze',
        amount: application.amount,
        balance: userInTx.data.balance || 0,
        frozen_balance: userInTx.data.frozen_balance || 0,
        description: `提现申请驳回，解冻 ¥${formatAmount(application.amount)}`,
        create_time: new Date()
      }
    })

    // 更新申请状态
    await transaction.collection('wdd-withdraw-applications').doc(applicationId).update({
      data: {
        status: 'rejected',
        reject_reason: rejectReason,
        handler_id: OPENID,
        approve_time: new Date(),
        update_time: new Date()
      }
    })

    await transaction.commit()
  } catch (err) {
    await transaction.rollback()
    console.error('驳回事务失败:', err)
    return { code: -1, message: '驳回失败: ' + err.message }
  }

  // 发送通知给申请人（事务外）
  try {
    await db.collection('wdd-notifications').add({
      data: {
        user_id: application.user_id,
        type: 'system',
        title: '提现申请已驳回',
        content: `您的提现申请（¥${application.amount}）已被驳回，原因：${rejectReason}。冻结金额已解冻。`,
        is_read: false,
        create_time: new Date()
      }
    })
  } catch (err) {
    console.warn('发送通知失败:', err)
  }

  return {
    code: 0,
    message: '已驳回'
  }
}

// ========================================
// 过期处理（由定时任务调用）
// ========================================
async function expireApplication(event) {
  const { applicationId } = event
  if (!applicationId) {
    return { code: -1, message: '申请ID不能为空' }
  }

  const transaction = await db.startTransaction()
  try {
    const appInTx = await transaction.collection('wdd-withdraw-applications')
      .doc(applicationId).get().catch(() => null)
    if (!appInTx || !appInTx.data) {
      await transaction.rollback()
      return { code: -1, message: '申请记录不存在' }
    }
    const app = appInTx.data
    if (app.status !== 'approved' || app.withdraw_status !== 'not_withdrawn') {
      await transaction.rollback()
      return { code: -1, message: `申请状态不符合过期条件（当前: ${app.status}/${app.withdraw_status}）` }
    }

    // 解冻金额
    await transaction.collection('wdd-users').doc(app.user_id).update({
      data: {
        frozen_balance: _.inc(-app.amount),
        update_time: new Date()
      }
    })

    // 写入解冻流水
    const userInTx = await transaction.collection('wdd-users').doc(app.user_id).get()
    await transaction.collection('wdd-balance-records').add({
      data: {
        user_id: app.user_id,
        type: 'unfreeze',
        amount: app.amount,
        balance: userInTx.data.balance || 0,
        frozen_balance: userInTx.data.frozen_balance || 0,
        description: `提现申请已过期，解冻 ¥${formatAmount(app.amount)}`,
        create_time: new Date()
      }
    })

    // 更新状态为 expired
    await transaction.collection('wdd-withdraw-applications').doc(applicationId).update({
      data: {
        status: 'expired',
        update_time: new Date()
      }
    })

    await transaction.commit()

    // 发送通知（事务外）
    try {
      await db.collection('wdd-notifications').add({
        data: {
          user_id: app.user_id,
          type: 'system',
          title: '提现申请已过期',
          content: `您的提现申请（¥${app.amount}）已超过3天未提现，已自动过期，冻结金额已解冻。如需提现请重新申请。`,
          is_read: false,
          create_time: new Date()
        }
      })
    } catch (err) {
      console.warn('发送过期通知失败:', err)
    }

    return { code: 0, message: '申请已过期，金额已解冻' }
  } catch (err) {
    await transaction.rollback()
    console.error('过期处理失败:', err)
    return { code: -1, message: '过期处理失败: ' + err.message }
  }
}
