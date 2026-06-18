// 提现云函数 - 处理提现申请、商家转账打款、失败重试与回滚
// 适配新版「商家转账」接口（2025年升级后，单笔单据模式）
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const axios = require('axios')
const { loadFromDb, createMoneyUtils } = require('./platformRules')
const { WECHATPAY_CONFIG } = require('./wechatpayConfig')
const { callTransferBill, callQueryBillByOutNo, verifyCallbackSignature, decryptCallbackResource } = require('./transfer')

// 主入口
exports.main = async (event, context) => {
  // ========================================
  // 出口 IP 检测（已注释）
  // ========================================
  // 用途：微信支付商户平台要求配置 API 调用来源 IP 白名单，
  //       云函数的出口 IP 是固定的，只需在首次配置白名单时获取一次。
  // 使用方法：临时取消注释 → 部署云函数 → 调用一次 → 查看日志中的 IP →
  //          将 IP 填入微信支付商户后台"API安全 → IP白名单" → 重新注释 → 重新部署。
  // 删除影响：不影响提现功能；IP 已在白名单中则无需再获取。
  // const ipServices = [
  //   'https://httpbin.org/ip',
  //   'https://api.ipify.org?format=json',
  //   'https://ifconfig.me/ip'
  // ]
  // for (const url of ipServices) {
  //   try {
  //     const ipRes = await axios.get(url, { timeout: 5000 })
  //     const ip = ipRes.data.origin || ipRes.data.ip || ipRes.data
  //     if (ip) {
  //       console.log('云函数出口IP:', ip)
  //       break
  //     }
  //   } catch (e) {
  //     console.log(`获取出口IP失败(${url}):`, e.message)
  //   }
  // }

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

function getBeijingDateKey(date = new Date()) {
  const bj = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const year = bj.getUTCFullYear()
  const month = String(bj.getUTCMonth() + 1).padStart(2, '0')
  const day = String(bj.getUTCDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

function getWithdrawQuotaDocId(openid, dateKey = getBeijingDateKey()) {
  return `${openid}_${dateKey}`
}

function moneyToCents(amount) {
  return Math.round(Number(amount || 0) * 100)
}

async function reserveWithdrawQuota(transaction, openid, amount, rules) {
  const dateKey = getBeijingDateKey()
  const quotaId = getWithdrawQuotaDocId(openid, dateKey)
  const amountCents = moneyToCents(amount)
  const dailyLimitCents = moneyToCents(rules.WITHDRAW_DAILY_LIMIT)
  const dailyTimes = Number(rules.WITHDRAW_DAILY_TIMES || 0)

  const quotaRef = transaction.collection('wdd-withdraw-daily-quotas').doc(quotaId)
  const quotaRes = await quotaRef.get().catch(() => null)
  const quota = quotaRes && quotaRes.data ? quotaRes.data : null
  const usedCents = Number(quota?.amount_cents || 0)
  const usedCount = Number(quota?.count || 0)

  if (dailyLimitCents > 0 && usedCents + amountCents > dailyLimitCents) {
    return {
      allowed: false,
      quotaId,
      message: `超过单日提现限额 ¥${rules.WITHDRAW_DAILY_LIMIT}（今日已提现 ¥${(usedCents / 100).toFixed(2)}）`
    }
  }

  if (dailyTimes > 0 && usedCount >= dailyTimes) {
    return {
      allowed: false,
      quotaId,
      message: `今日提现次数已达上限（${dailyTimes}次），请明天再试`
    }
  }

  const now = new Date()
  if (quota) {
    await quotaRef.update({
      data: {
        amount_cents: _.inc(amountCents),
        amount: _.inc(amount),
        count: _.inc(1),
        update_time: now
      }
    })
  } else {
    await quotaRef.set({
      data: {
        _id: quotaId,
        openid,
        date_key: dateKey,
        amount_cents: amountCents,
        amount,
        count: 1,
        create_time: now,
        update_time: now
      }
    })
  }

  return { allowed: true, quotaId, amountCents }
}

async function releaseWithdrawQuota(transaction, withdraw) {
  if (!withdraw.quota_doc_id) return
  const quotaId = withdraw.quota_doc_id
  const amountCents = moneyToCents(withdraw.quota_amount || withdraw.amount)
  await transaction.collection('wdd-withdraw-daily-quotas').doc(quotaId).update({
    data: {
      amount_cents: _.inc(-amountCents),
      amount: _.inc(-(withdraw.quota_amount || withdraw.amount || 0)),
      count: _.inc(-1),
      update_time: new Date()
    }
  })
}

// 申请提现 → 即时打款（无人工审批环节）
async function applyWithdraw(event, OPENID) {
  const { amount, applicationId } = event

  const rules = await loadFromDb()
  const MoneyUtils = createMoneyUtils(rules)

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

  // 如果传入了 applicationId，校验该申请是否已审批通过且未提现
  let approvedApplication = null
  if (applicationId) {
    const appRes = await db.collection('wdd-withdraw-applications').doc(applicationId).get().catch(() => null)
    if (!appRes || !appRes.data) {
      return { code: -1, message: '提现申请记录不存在' }
    }
    approvedApplication = appRes.data

    if (approvedApplication.user_id !== user._id) {
      return { code: -1, message: '无权操作此申请' }
    }
    if (approvedApplication.status !== 'approved') {
      return { code: -1, message: '该提现申请尚未通过审批' }
    }
    if (approvedApplication.withdraw_status === 'withdrawn') {
      return { code: -1, message: '该申请已提现，请勿重复操作' }
    }
    if (approvedApplication.expire_time && new Date(approvedApplication.expire_time) < new Date()) {
      return { code: -1, message: '该提现申请已过期，请重新申请' }
    }
    if (amount - approvedApplication.amount > 0.01) {
      return { code: -1, message: `提现金额不能超过审批通过金额（¥${approvedApplication.amount}）` }
    }
  }

  if (!approvedApplication) {
    const threshold = rules.WITHDRAW_APPROVAL_THRESHOLD
    if (typeof threshold === 'number' && amount > threshold) {
      return { code: -1, message: `单笔提现超过¥${threshold}需先提交审批申请` }
    }
  }

  const withdrawCheck = MoneyUtils.checkCanWithdraw(
    approvedApplication ? user.balance : ((user.balance || 0) - (user.frozen_balance || 0))
  )
  if (!withdrawCheck.canWithdraw) {
    return { code: -1, message: withdrawCheck.reason }
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
    const latestFrozen = latestUserRes.data.frozen_balance || 0
    const quotaResult = await reserveWithdrawQuota(transaction, OPENID, amount, rules)
    if (!quotaResult.allowed) {
      await transaction.rollback()
      return { code: -1, message: quotaResult.message }
    }

    if (approvedApplication) {
      // 审批路径：扣减实际提现金额，并释放本审批单占用的冻结金额
      const approvedAmount = Number(approvedApplication.amount || 0)
      const expectedAmount = Math.round(Math.min(approvedAmount, latestBalance) * 100) / 100
      if (Math.abs(amount - expectedAmount) > 0.01) {
        await transaction.rollback()
        return {
          code: -1,
          message: `提现金额需按当前余额计算（本次可提现 ¥${MoneyUtils.formatAmount(expectedAmount)}）`
        }
      }
      if (amount > latestBalance) {
        await transaction.rollback()
        return { code: -1, message: '余额不足' }
      }
      if (amount > latestFrozen) {
        await transaction.rollback()
        return { code: -1, message: '冻结金额异常，请联系客服' }
      }
      const frozenDeductAmount = Math.min(approvedAmount, latestFrozen)

      await transaction.collection('wdd-users').doc(user._id).update({
        data: {
          balance: _.inc(-amount),
          frozen_balance: _.inc(-frozenDeductAmount),
          total_withdrawn: _.inc(amount),
          update_time: new Date()
        }
      })
    } else {
      // 即时路径：仅扣减 balance，校验可用余额
      const available = latestBalance - latestFrozen
      if (amount > available) {
        await transaction.rollback()
        return { code: -1, message: `可用余额不足（含已冻结 ¥${MoneyUtils.formatAmount(latestFrozen)}）` }
      }

      await transaction.collection('wdd-users').doc(user._id).update({
        data: {
          balance: _.inc(-amount),
          total_withdrawn: _.inc(amount),
          update_time: new Date()
        }
      })
    }

    // 提现完整记录写入 wdd-withdraws（状态机、微信支付追踪等复杂字段）
    withdrawRecord = {
      _id: withdrawId,
      user_id: user._id,
      openid: OPENID,
      amount: amount,
      fee: fee,
      actual_amount: actualAmount,
      status: 'processing',
      application_id: approvedApplication ? approvedApplication._id : null,
      quota_doc_id: quotaResult.quotaId,
      quota_amount: amount,
      quota_amount_cents: quotaResult.amountCents,
      out_bill_no: withdrawId,
      bill_id: null,
      state: null,
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

    await transaction.collection('wdd-withdraws').add({ data: withdrawRecord })

    await transaction.commit()
  } catch (err) {
    await transaction.rollback()
    console.error('提现事务失败:', err)
    return { code: -1, message: '提现申请失败: ' + err.message }
  }

  // 事务外发起真实打款（事务内调用外部 API 会拖长事务、增加风险）
  const transferResult = await executeTransfer(withdrawRecord)

  // 打款成功后，关联的提现申请标记为已提现（避免打款失败时申请记录已错误标记）
  if (transferResult.code === 0 && approvedApplication) {
    await db.collection('wdd-withdraw-applications').doc(approvedApplication._id).update({
      data: {
        withdraw_status: 'withdrawn',
        withdraw_id: withdrawId,
        withdraw_time: new Date(),
        update_time: new Date()
      }
    }).catch(err => {
      console.error('更新提现申请状态失败:', err)
    })
  }
  return {
    code: transferResult.code,
    message: transferResult.message,
    data: {
      withdrawId,
      amount,
      fee,
      actualAmount,
      mchId: WECHATPAY_CONFIG.MCH_ID,
      appId: WECHATPAY_CONFIG.APP_ID,
      ...(transferResult.data || {})
    }
  }
}

// 查询提现记录
async function queryWithdraws(event, OPENID) {
  const { page = 0, pageSize = 20 } = event

  try {
    const withdrawRes = await db.collection('wdd-withdraws')
      .where({ openid: OPENID })
      .orderBy('apply_time', 'desc')
      .skip(page * pageSize)
      .limit(pageSize)
      .get()

    const records = withdrawRes.data.map(item => ({
      _id: item._id,
      amount: item.amount,
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

  const recordRes = await db.collection('wdd-withdraws').doc(withdrawId).get().catch(() => null)
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
      const refreshed = await db.collection('wdd-withdraws').doc(withdrawId).get()
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
    await db.collection('wdd-withdraws').doc(withdraw._id).update({
      data: {
        bill_id: result.billId,
        state: result.state,
        package_info: result.packageInfo,
        last_transfer_error: null,
        update_time: new Date()
      }
    })

    // 幂等写入收支明细（提现成功才产生记录，失败不留痕）
    const existCount = await db.collection('wdd-balance-records')
      .where({ withdraw_id: withdraw._id }).count()
    if (existCount.total === 0) {
      const userRes = await db.collection('wdd-users')
        .where({ openid: withdraw.openid }).get()
      if (userRes.data.length > 0) {
        await db.collection('wdd-balance-records').add({
          data: {
            user_id: withdraw.user_id,
            type: 'withdraw',
            amount: -withdraw.amount,
            balance: userRes.data[0].balance || 0,
            frozen_balance: userRes.data[0].frozen_balance || 0,
            description: `提现 ¥${withdraw.amount}`,
            withdraw_id: withdraw._id,
            create_time: new Date()
          }
        })
      }
    }

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

  const rules = await loadFromDb()

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
  const maxRetry = rules.MAX_TRANSFER_RETRY
  const backoffList = rules.TRANSFER_BACKOFF_MINUTES

  if (attempts >= maxRetry) {
    // 达到上限，转为 transfer_failed 等待人工介入（不自动回滚，避免微信侧实际打款成功导致重复退款）
    await db.collection('wdd-withdraws').doc(withdraw._id).update({
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

  await db.collection('wdd-withdraws').doc(withdraw._id).update({
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

  const withdrawRes = await db.collection('wdd-withdraws').doc(withdrawId).get()
  if (!withdrawRes.data) {
    return { code: -1, message: '提现记录不存在' }
  }

  const withdraw = withdrawRes.data

  if (withdraw.status !== 'transfer_pending') {
    return { code: -1, message: `状态非 transfer_pending（${withdraw.status}），跳过重试` }
  }

  // 重新置为 processing，再次调用打款
  await db.collection('wdd-withdraws').doc(withdrawId).update({
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

  const withdrawRes = await db.collection('wdd-withdraws').doc(withdrawId).get()
  if (!withdrawRes.data) {
    return { code: -1, message: '提现记录不存在' }
  }

  const withdraw = withdrawRes.data
  const outBillNo = withdraw.out_bill_no || withdraw._id

  try {
    const result = await callQueryBillByOutNo(outBillNo)

    // 微信侧单据还未建立（刚提交几秒内常见）→ 跳过本次更新，等下次定时器再查
    if (!result) {
      await db.collection('wdd-withdraws').doc(withdrawId).update({
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
      last_query_time: new Date(),
      update_time: new Date()
    }

    if (result.state === 'SUCCESS') {
      // 转账成功
      newStatus = 'completed'
      updateData.payment_time = result.successTime ? new Date(result.successTime) : new Date()

      // 幂等写入收支明细
      const existCount = await db.collection('wdd-balance-records')
        .where({ withdraw_id: withdraw._id }).count()
      if (existCount.total === 0) {
        const userRes = await db.collection('wdd-users')
          .where({ openid: withdraw.openid }).get()
        if (userRes.data.length > 0) {
          await db.collection('wdd-balance-records').add({
            data: {
              user_id: withdraw.user_id,
              type: 'withdraw',
              amount: -withdraw.amount,
              balance: userRes.data[0].balance || 0,
              frozen_balance: userRes.data[0].frozen_balance || 0,
              description: `提现 ¥${withdraw.amount}`,
              withdraw_id: withdraw._id,
              create_time: new Date()
            }
          })
        }
      }
    } else if (result.state === 'FAIL') {
      // 转账失败
      return await rollbackWithdrawBalance(withdraw, `转账失败: ${result.failReason || '微信侧失败'}`)
    } else if (result.state === 'CANCELLED') {
      // 单据已撤销
      return await rollbackWithdrawBalance(withdraw, '转账单已撤销')
    }
    // ACCEPTED / WAIT_USER_CONFIRM / PROCESSING / TRANSFERING → 继续等待

    updateData.status = newStatus

    await db.collection('wdd-withdraws').doc(withdrawId).update({ data: updateData })

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
  const recordRes = await db.collection('wdd-withdraws').doc(outBillNo).get().catch(() => null)
  if (!recordRes || !recordRes.data) {
    return httpResponse(200, 'SUCCESS', 'record not found, ignored')
  }

  const withdraw = recordRes.data

  // 成功到账
  if (state === 'SUCCESS') {
    await db.collection('wdd-withdraws').doc(withdraw._id).update({
      data: {
        status: 'completed',
        state: state,
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

  // 单据撤销
  if (state === 'CANCELLED') {
    await rollbackWithdrawBalance(withdraw, '转账单已撤销')
    return httpResponse(200, 'SUCCESS', 'cancelled and rollback')
  }

  // 其他状态（ACCEPTED / WAIT_USER_CONFIRM / PROCESSING / TRANSFERING）仅记录
  await db.collection('wdd-withdraws').doc(withdraw._id).update({
    data: {
      state: state,
      update_time: new Date()
    }
  })
  return httpResponse(200, 'SUCCESS', `progress: ${state}`)
}

// ========================================
// 工具函数
// ========================================

// 余额回滚（驳回或转账明确失败时使用）
// 审批路径的提现：恢复 balance 的同时恢复 frozen_balance（保持冻结状态，用户可重试）
async function rollbackWithdrawBalance(withdraw, reason) {
  if (withdraw.status === 'rejected') {
    return { code: -1, message: '已是驳回状态，跳过回滚' }
  }

  const transaction = await db.startTransaction()

  try {
    // 事务内重新查记录，校验状态
    const latestRecord = await transaction.collection('wdd-withdraws').doc(withdraw._id).get()
    if (latestRecord.data.status === 'rejected' || latestRecord.data.status === 'completed') {
      await transaction.rollback()
      return { code: -1, message: `状态已变更（${latestRecord.data.status}），跳过回滚` }
    }

    const hasApplication = !!(withdraw.application_id || latestRecord.data.application_id)

    // 构建用户更新数据
    const userUpdateData = {
      balance: _.inc(withdraw.amount),
      total_withdrawn: _.inc(-withdraw.amount),
      update_time: new Date()
    }

    // 审批提现同时恢复冻结（保持冻结状态，让用户可以重试）
    if (hasApplication) {
      userUpdateData.frozen_balance = _.inc(withdraw.amount)
    }

    await transaction.collection('wdd-users').doc(withdraw.user_id).update({
      data: userUpdateData
    })

    await releaseWithdrawQuota(transaction, latestRecord.data)

    // 更新 wdd-withdraws 状态为 rejected
    await transaction.collection('wdd-withdraws').doc(withdraw._id).update({
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

  const res = await db.collection('wdd-withdraws')
    .where({
      openid: openid,
      status: _.in(['processing', 'completed', 'transfer_pending']),
      apply_time: _.gte(start)
    })
    .get()

  return res.data.reduce((sum, r) => sum + (r.amount || 0), 0)
}

// 累计今日已发起提现次数（processing/completed/transfer_pending 都算占用次数）
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

// 格式化时间（强制按北京时间 UTC+8 输出，避免云函数环境时区为 UTC 导致时间差 8 小时）
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
