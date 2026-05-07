// 提现云函数 - 处理提现申请、商家转账打款、失败重试与回滚
// 适配新版「商家转账」接口（2025年升级后，单笔单据模式）
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const { MoneyUtils, PLATFORM_RULES } = require('./platformRules')
const { callTransferBill, callQueryBillByOutNo, verifyCallbackSignature, decryptCallbackResource } = require('./transfer')

// 主入口
exports.main = async (event, context) => {
  // 微信支付回调通过云函数 HTTP 触发器接入，event 格式为 { path, httpMethod, headers, body, ... }
  // 没有 action 字段 + 有 httpMethod 时识别为 HTTP 回调
  if (!event.action && event.httpMethod) {
    return await handleTransferCallback(event)
  }

  const { action } = event
  const wxContext = cloud.getWXContext()
  const OPENID = wxContext.OPENID || event.openid

  // 部分定时任务调用没有 OPENID，需要单独区分
  const isInternalCall = !wxContext.OPENID && (action === 'retryFailedTransfer' || action === 'queryTransferStatus')

  if (!OPENID && !isInternalCall) {
    return { code: -1, message: '获取用户openid失败' }
  }

  try {
    switch (action) {
      case 'apply':
        return await applyWithdraw(event, OPENID)
      case 'query':
        return await queryWithdraws(event, OPENID)
      case 'getWithdrawStatus':
        return await getWithdrawStatus(event, OPENID)
      case 'retryFailedTransfer':
        return await retryFailedTransfer(event)
      case 'queryTransferStatus':
        return await queryTransferStatus(event)
      default:
        return { code: -1, message: '未知操作' }
    }
  } catch (err) {
    console.error('提现操作失败:', err)
    return { code: -1, message: err.message }
  }
}

// ========================================
// 业务函数：用户侧
// ========================================

// 申请提现 → 即时打款（无人工审批环节）
async function applyWithdraw(event, OPENID) {
  const { amount } = event

  if (!amount || amount <= 0) {
    return { code: -1, message: '提现金额必须大于0' }
  }

  const amountCheck = MoneyUtils.checkWithdrawAmount(amount, Infinity)
  if (!amountCheck.valid) {
    return { code: -1, message: amountCheck.reason }
  }

  const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
  if (userRes.data.length === 0) {
    return { code: -1, message: '用户不存在' }
  }

  const user = userRes.data[0]

  const withdrawCheck = MoneyUtils.checkCanWithdraw(user.balance || 0)
  if (!withdrawCheck.canWithdraw) {
    return { code: -1, message: withdrawCheck.reason }
  }

  // 单日累计限额校验
  const dailyTotal = await sumTodayWithdrawAmount(OPENID)
  if (dailyTotal + amount > PLATFORM_RULES.WITHDRAW_DAILY_LIMIT) {
    return {
      code: -1,
      message: `超过单日提现限额 ¥${PLATFORM_RULES.WITHDRAW_DAILY_LIMIT}（今日已提现 ¥${dailyTotal}）`
    }
  }

  const fee = MoneyUtils.calcWithdrawFee(amount)
  const actualAmount = MoneyUtils.calcWithdrawActual(amount)
  const withdrawId = generateWithdrawNo()

  const transaction = await db.startTransaction()

  let withdrawRecord = null

  try {
    // 事务内查询最新余额（防并发扣减）
    const latestUserRes = await transaction.collection('wdd-users').doc(user._id).get()
    const latestBalance = latestUserRes.data.balance || 0

    if (amount > latestBalance) {
      await transaction.rollback()
      return { code: -1, message: '余额不足' }
    }

    await transaction.collection('wdd-users').doc(user._id).update({
      data: {
        balance: _.inc(-amount),
        total_withdrawn: _.inc(amount),
        update_time: new Date()
      }
    })

    // 直接置为 processing 状态（跳过 pending 人工审批环节）
    // 新版接口使用 out_bill_no，保留 out_batch_no 兼容旧数据
    withdrawRecord = {
      _id: withdrawId,
      user_id: user._id,
      openid: OPENID,
      type: 'withdraw',
      amount: -amount,
      balance: latestBalance - amount,
      description: `提现 ¥${amount}`,
      withdraw_amount: amount,
      fee: fee,
      actual_amount: actualAmount,
      status: 'processing',
      out_bill_no: withdrawId,
      out_batch_no: withdrawId,      // 兼容旧数据
      bill_id: null,
      batch_id: null,                // 兼容旧数据
      state: null,
      batch_status: null,            // 兼容旧数据
      package_info: null,
      transfer_attempts: 0,
      next_retry_time: null,
      last_transfer_error: null,
      last_query_time: null,
      payment_no: null,
      payment_time: null,
      reject_reason: null,
      apply_time: new Date(),
      create_time: new Date(),
      update_time: new Date()
    }

    await transaction.collection('wdd-balance-records').add({ data: withdrawRecord })

    await transaction.commit()
  } catch (err) {
    await transaction.rollback()
    console.error('提现事务失败:', err)
    return { code: -1, message: '提现申请失败: ' + err.message }
  }

  // 事务外发起真实打款（事务内调用外部 API 会拖长事务、增加风险）
  const transferResult = await executeTransfer(withdrawRecord)
  return {
    code: transferResult.code,
    message: transferResult.message,
    data: {
      withdrawId,
      amount,
      fee,
      actualAmount,
      ...(transferResult.data || {})
    }
  }
}

// 查询提现记录
async function queryWithdraws(event, OPENID) {
  const { page = 0, pageSize = 20 } = event

  try {
    const withdrawRes = await db.collection('wdd-balance-records')
      .where({ openid: OPENID, type: 'withdraw' })
      .orderBy('apply_time', 'desc')
      .skip(page * pageSize)
      .limit(pageSize)
      .get()

    const records = withdrawRes.data.map(item => ({
      _id: item._id,
      amount: item.withdraw_amount,
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

// 查询单条提现状态（前端轮询用）
// 状态为 processing 时主动调一次 queryTransferStatus 拉取微信侧最新状态，避免单纯依赖定时器
async function getWithdrawStatus(event, OPENID) {
  const { withdrawId } = event
  if (!withdrawId) {
    return { code: -1, message: '提现ID不能为空' }
  }

  const recordRes = await db.collection('wdd-balance-records').doc(withdrawId).get().catch(() => null)
  if (!recordRes || !recordRes.data) {
    return { code: -1, message: '提现记录不存在' }
  }

  let record = recordRes.data

  // 越权校验
  if (record.openid !== OPENID) {
    return { code: -1, message: '无权查询' }
  }

  // 仍在处理中 → 主动调微信侧查询，让数据库尽快收敛
  if (record.status === 'processing') {
    try {
      await queryTransferStatus({ withdrawId })
      const refreshed = await db.collection('wdd-balance-records').doc(withdrawId).get()
      if (refreshed && refreshed.data) record = refreshed.data
    } catch (err) {
      console.warn('主动查询转账单状态失败，返回数据库当前状态:', err.message)
    }
  }

  return {
    code: 0,
    data: {
      withdrawId: record._id,
      status: record.status,
      statusText: getWithdrawStatusText(record.status),
      paymentTime: record.payment_time ? formatTime(record.payment_time) : null,
      rejectReason: record.reject_reason || '',
      packageInfo: record.package_info || null
    }
  }
}

// ========================================
// 商家转账核心（新版单笔单据模式）
// ========================================

// 执行商家转账（被 applyWithdraw / retryFailedTransfer 调用）
// 入参 withdraw：完整的提现记录对象（已是 processing 状态）
async function executeTransfer(withdraw) {
  const outBillNo = withdraw.out_bill_no || withdraw._id
  const transferAmountFen = Math.round(withdraw.actual_amount * 100) // 元转分

  try {
    const result = await callTransferBill({
      outBillNo: outBillNo,
      transferAmount: transferAmountFen,
      openid: withdraw.openid,
      transferRemark: `提现单号 ${withdraw._id}`
    })

    // 成功受理（返回 package_info，需前端调起确认页面）
    await db.collection('wdd-balance-records').doc(withdraw._id).update({
      data: {
        bill_id: result.billId,
        batch_id: result.billId,          // 兼容旧数据
        state: result.state,
        batch_status: result.state,       // 兼容旧数据
        package_info: result.packageInfo,
        last_transfer_error: null,
        update_time: new Date()
      }
    })

    return {
      code: 0,
      message: '请确认收款',
      data: {
        withdrawId: withdraw._id,
        billId: result.billId,
        state: result.state,
        packageInfo: result.packageInfo
      }
    }

  } catch (err) {
    console.error('商家转账调用失败:', err)
    return await handleTransferError(withdraw, err)
  }
}

// 处理转账错误：明确业务错误 → 立即回滚；网络/系统错误 → 标记 transfer_pending 待重试
async function handleTransferError(withdraw, err) {
  const errCode = err.errCode || ''
  const errMessage = err.errMessage || err.message || '未知错误'

  // 明确业务错误码（根据 v3 商家转账文档）
  const FATAL_ERROR_CODES = [
    'INVALID_REQUEST',
    'PARAM_ERROR',
    'NOT_ENOUGH',
    'TRANSFER_OVER_LIMIT',
    'OPENID_ERROR',
    'NAME_MISMATCH',
    'FREQUENCY_LIMITED',
    'NO_AUTH',
    'ACCOUNT_ABNORMAL',
    'USER_NOT_EXIST'
  ]
  const isFatal = FATAL_ERROR_CODES.includes(errCode)

  if (isFatal) {
    // 立即回滚余额，并以 code:-1 告知调用者（让前端弹失败 toast）
    const rollbackResult = await rollbackWithdrawBalance(withdraw, `商家转账失败: ${errMessage}`)
    return {
      code: -1,
      message: `提现失败：${errMessage}（金额已退回）`,
      data: { withdrawId: withdraw._id, errCode, ...(rollbackResult.data || {}) }
    }
  }

  // 系统错误/网络错误 → 排队重试
  const attempts = (withdraw.transfer_attempts || 0) + 1
  const maxRetry = PLATFORM_RULES.MAX_TRANSFER_RETRY
  const backoffList = PLATFORM_RULES.TRANSFER_BACKOFF_MINUTES

  if (attempts >= maxRetry) {
    // 达到上限，转为 transfer_failed 等待人工介入（不自动回滚，避免微信侧实际打款成功导致重复退款）
    await db.collection('wdd-balance-records').doc(withdraw._id).update({
      data: {
        status: 'transfer_failed',
        transfer_attempts: attempts,
        last_transfer_error: errMessage,
        update_time: new Date()
      }
    })
    return {
      code: -1,
      message: `商家转账重试达到上限，需人工介入: ${errMessage}`,
      data: { withdrawId: withdraw._id, attempts }
    }
  }

  const backoffMin = backoffList[attempts - 1] || backoffList[backoffList.length - 1]
  const nextRetryTime = new Date(Date.now() + backoffMin * 60 * 1000)

  await db.collection('wdd-balance-records').doc(withdraw._id).update({
    data: {
      status: 'transfer_pending',
      transfer_attempts: attempts,
      next_retry_time: nextRetryTime,
      last_transfer_error: errMessage,
      update_time: new Date()
    }
  })

  return {
    code: 0,
    message: `商家转账失败，已排队重试（第 ${attempts} 次后 ${backoffMin} 分钟）`,
    data: { withdrawId: withdraw._id, attempts, nextRetryTime }
  }
}

// 失败重试（由 wdd-auto-cancel 定时器调用）
async function retryFailedTransfer(event) {
  const { withdrawId } = event
  if (!withdrawId) {
    return { code: -1, message: '提现ID不能为空' }
  }

  const withdrawRes = await db.collection('wdd-balance-records').doc(withdrawId).get()
  if (!withdrawRes.data) {
    return { code: -1, message: '提现记录不存在' }
  }

  const withdraw = withdrawRes.data

  if (withdraw.status !== 'transfer_pending') {
    return { code: -1, message: `状态非 transfer_pending（${withdraw.status}），跳过重试` }
  }

  // 重新置为 processing，再次调用打款
  await db.collection('wdd-balance-records').doc(withdrawId).update({
    data: {
      status: 'processing',
      update_time: new Date()
    }
  })

  return await executeTransfer({ ...withdraw, status: 'processing' })
}

// 主动查询转账单状态（由 wdd-auto-cancel 定时器调用，处理 processing 长时间未回调的情况）
async function queryTransferStatus(event) {
  const { withdrawId } = event
  if (!withdrawId) {
    return { code: -1, message: '提现ID不能为空' }
  }

  const withdrawRes = await db.collection('wdd-balance-records').doc(withdrawId).get()
  if (!withdrawRes.data) {
    return { code: -1, message: '提现记录不存在' }
  }

  const withdraw = withdrawRes.data
  const outBillNo = withdraw.out_bill_no || withdraw._id

  try {
    const result = await callQueryBillByOutNo(outBillNo)

    // 微信侧单据还未建立（刚提交几秒内常见）→ 跳过本次更新，等下次定时器再查
    if (!result) {
      await db.collection('wdd-balance-records').doc(withdrawId).update({
        data: { last_query_time: new Date(), update_time: new Date() }
      })
      return {
        code: 0,
        message: '单据尚未建立，稍后重试',
        data: { withdrawId, state: 'NOT_FOUND' }
      }
    }

    // 根据微信单据状态映射本地状态
    let newStatus = withdraw.status
    let updateData = {
      state: result.state,
      batch_status: result.state,       // 兼容旧数据
      last_query_time: new Date(),
      update_time: new Date()
    }

    if (result.state === 'SUCCESS') {
      // 转账成功
      newStatus = 'completed'
      updateData.payment_time = result.successTime ? new Date(result.successTime) : new Date()
    } else if (result.state === 'FAIL') {
      // 转账失败
      return await rollbackWithdrawBalance(withdraw, `转账失败: ${result.failReason || '微信侧失败'}`)
    } else if (result.state === 'CLOSED') {
      // 单据已关闭
      return await rollbackWithdrawBalance(withdraw, '转账单已关闭')
    }
    // ACCEPTED / WAIT_USER_CONFIRM / PROCESSING / TRANSFERING → 继续等待

    updateData.status = newStatus

    await db.collection('wdd-balance-records').doc(withdrawId).update({ data: updateData })

    return {
      code: 0,
      message: '查询成功',
      data: { withdrawId, state: result.state, status: newStatus }
    }
  } catch (err) {
    console.error('查询转账单状态失败:', err)
    return { code: -1, message: '查询失败: ' + err.message }
  }
}

// ========================================
// 回调处理（新版商家转账回调通知）
// ========================================

// 处理微信支付回调（由云函数 HTTP 触发器接入）
// 微信约定：返回 HTTP 200 + body { "code": "SUCCESS" } 视为成功不再重发；其他视为失败会重试最多 15 次
async function handleTransferCallback(event) {
  // HTTP 触发器格式：{ path, httpMethod, headers, body, ... }
  const headers = event.headers || {}
  const rawBody = event.body || ''

  const httpResponse = (statusCode, code, message) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, message })
  })

  if (!(await verifyCallbackSignature(headers, rawBody))) {
    console.warn('回调验签失败')
    return httpResponse(401, 'FAIL', 'signature invalid')
  }

  let payload
  try {
    payload = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody
  } catch (err) {
    return httpResponse(400, 'FAIL', 'body parse error')
  }

  // v3 回调报文格式：{ id, create_time, event_type, resource_type, resource: { algorithm, ciphertext, associated_data, nonce } }
  let decrypted
  try {
    decrypted = payload.resource ? decryptCallbackResource(payload.resource) : payload
  } catch (err) {
    console.error('回调解密失败:', err)
    // 验签已过但解密失败 → 微信侧不会因此重试，返回 SUCCESS
    return httpResponse(200, 'SUCCESS', 'decrypt failed, ignored')
  }

  if (!decrypted) {
    return httpResponse(200, 'SUCCESS', 'empty resource, ignored')
  }

  // 新版回调使用 out_bill_no，兼容旧版 out_batch_no
  const outBillNo = decrypted.out_bill_no || decrypted.out_batch_no
  const state = decrypted.state || decrypted.batch_status
  const failReason = decrypted.fail_reason || ''

  if (!outBillNo) {
    return httpResponse(200, 'SUCCESS', 'no out_bill_no, ignored')
  }

  // out_bill_no 在 applyWithdraw 中等于 _id，可直接 doc().get()
  const recordRes = await db.collection('wdd-balance-records').doc(outBillNo).get().catch(() => null)
  if (!recordRes || !recordRes.data) {
    return httpResponse(200, 'SUCCESS', 'record not found, ignored')
  }

  const withdraw = recordRes.data

  // 成功到账
  if (state === 'SUCCESS') {
    await db.collection('wdd-balance-records').doc(withdraw._id).update({
      data: {
        status: 'completed',
        state: state,
        batch_status: state,
        payment_time: new Date(),
        update_time: new Date()
      }
    })
    return httpResponse(200, 'SUCCESS', 'completed')
  }

  // 转账失败
  if (state === 'FAIL') {
    await rollbackWithdrawBalance(withdraw, `转账失败: ${failReason}`)
    return httpResponse(200, 'SUCCESS', 'fail and rollback')
  }

  // 单据关闭
  if (state === 'CLOSED') {
    await rollbackWithdrawBalance(withdraw, '转账单已关闭')
    return httpResponse(200, 'SUCCESS', 'closed and rollback')
  }

  // 其他状态（ACCEPTED / WAIT_USER_CONFIRM / PROCESSING / TRANSFERING）仅记录
  await db.collection('wdd-balance-records').doc(withdraw._id).update({
    data: {
      state: state,
      batch_status: state,
      update_time: new Date()
    }
  })
  return httpResponse(200, 'SUCCESS', `progress: ${state}`)
}

// ========================================
// 工具函数
// ========================================

// 余额回滚（驳回或转账明确失败时使用）
async function rollbackWithdrawBalance(withdraw, reason) {
  if (withdraw.status === 'rejected') {
    return { code: -1, message: '已是驳回状态，跳过回滚' }
  }

  const transaction = await db.startTransaction()

  try {
    // 事务内重新查记录，校验状态
    const latestRecord = await transaction.collection('wdd-balance-records').doc(withdraw._id).get()
    if (latestRecord.data.status === 'rejected' || latestRecord.data.status === 'completed') {
      await transaction.rollback()
      return { code: -1, message: `状态已变更（${latestRecord.data.status}），跳过回滚` }
    }

    // 余额回滚
    await transaction.collection('wdd-users').doc(withdraw.user_id).update({
      data: {
        balance: _.inc(withdraw.withdraw_amount),
        total_withdrawn: _.inc(-withdraw.withdraw_amount),
        update_time: new Date()
      }
    })

    // 记录置为 rejected
    await transaction.collection('wdd-balance-records').doc(withdraw._id).update({
      data: {
        status: 'rejected',
        reject_reason: reason,
        update_time: new Date()
      }
    })

    await transaction.commit()

    return {
      code: 0,
      message: '余额已回滚',
      data: { withdrawId: withdraw._id, reason }
    }
  } catch (err) {
    await transaction.rollback()
    console.error('余额回滚失败:', err)
    return { code: -1, message: '回滚失败: ' + err.message }
  }
}

// 累计今日已发起提现金额（processing/completed/transfer_pending 都算占用额度）
async function sumTodayWithdrawAmount(openid) {
  const start = new Date()
  start.setHours(0, 0, 0, 0)

  const res = await db.collection('wdd-balance-records')
    .where({
      openid: openid,
      type: 'withdraw',
      status: _.in(['processing', 'completed', 'transfer_pending']),
      apply_time: _.gte(start)
    })
    .get()

  return res.data.reduce((sum, r) => sum + (r.withdraw_amount || 0), 0)
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
    'rejected': '已驳回',
    'transfer_pending': '打款中（重试）',
    'transfer_failed': '打款失败（待人工处理）'
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
