// 提现申请审批云函数
// 处理用户提现申请提交、超级管理员审批（通过/驳回）
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

// 驳回理由选项
const REJECT_REASONS = [
  '提现金额超出合理范围',
  '账户存在异常交易行为',
  '身份信息未通过验证',
  '提现频次过高，请稍后再试',
  '不符合平台提现规则',
  '其他原因'
]

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
    'rejected': '已驳回'
  }
  return map[status] || status
}

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
        return await apply(event, OPENID)
      case 'getMyApplications':
        return await getMyApplications(event, OPENID)
      case 'getApplicationList':
        return await getApplicationList(event, OPENID)
      case 'approve':
        return await approve(event, OPENID)
      case 'reject':
        return await rejectApplication(event, OPENID)
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

  // 查询用户
  const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
  if (userRes.data.length === 0) {
    return { code: -1, message: '用户不存在' }
  }

  const user = userRes.data[0]
  const balance = user.balance || 0

  if (balance < minAmount) {
    return { code: -1, message: `余额满${minAmount}元才可申请提现` }
  }

  if (amount > balance) {
    return { code: -1, message: '提现金额不能超过余额' }
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

  // 写入申请记录
  const appRes = await db.collection('wdd-withdraw-applications').add({
    data: {
      user_id: user._id,
      openid: OPENID,
      amount: amount,
      fee: fee,
      actual_amount: actualAmount,
      status: 'pending',
      withdraw_status: 'not_withdrawn',
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
    whereCondition.status = _.in(['approved', 'rejected'])
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
        content: `您的提现申请（¥${application.amount}）已审批通过，请前往钱包页面发起提现。`,
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
      status: 'rejected',
      reject_reason: rejectReason,
      handler_id: OPENID,
      approve_time: new Date(),
      update_time: new Date()
    }
  })

  // 发送通知给申请人
  try {
    await db.collection('wdd-notifications').add({
      data: {
        user_id: application.user_id,
        type: 'system',
        title: '提现申请已驳回',
        content: `您的提现申请（¥${application.amount}）已被驳回，原因：${rejectReason}`,
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
