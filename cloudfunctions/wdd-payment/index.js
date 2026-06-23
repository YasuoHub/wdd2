// 支付云函数 - 处理平台抵扣金、余额与微信混合支付

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

// 引入平台规则
const { loadFromDb } = require('./platformRules')

// 模拟支付开关：true=模拟支付（无需商户号），false=真实微信支付
const MOCK_PAYMENT = false

// 微信支付商户号（10位数字），通过环境变量注入
const SUB_MCH_ID = process.env.WECHATPAY_MCH_ID || ''

const ALLOWED_NEED_TYPES = new Set(['weather', 'traffic', 'shop', 'parking', 'queue', 'other'])
const ALLOWED_EXPIRE_MINUTES = new Set([30, 60, 120, 240, 720, 1440])
const MIN_DESCRIPTION_LENGTH = 5
const MAX_DESCRIPTION_LENGTH = 500
const MAX_IMAGE_COUNT = 3
const MAX_IMAGE_URL_LENGTH = 500
const MAX_LOCATION_NAME_LENGTH = 120
const DESCRIPTION_LINE_BREAK_RE = /[\r\n\u2028\u2029]+/g

// 金额格式化（最多2位小数，尾随零省略）
function formatAmount(n) {
  const num = Math.round(Number(n) * 100) / 100
  if (num % 1 === 0) return String(num)
  if (num * 10 % 1 === 0) return num.toFixed(1)
  return num.toFixed(2)
}

function normalizeMoneyAmount(value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) {
    return { valid: false, message: '金额必须大于0' }
  }

  const cents = Math.round(num * 100)
  if (Math.abs(num * 100 - cents) > 1e-8) {
    return { valid: false, message: '金额最多支持两位小数' }
  }

  return { valid: true, amount: cents / 100 }
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100
}

function getAvailableDeduction(user) {
  return Math.max(0, roundMoney((user.deduction_balance || 0) - (user.frozen_deduction_balance || 0)))
}

function getAvailableBalance(user) {
  return Math.max(0, roundMoney((user.balance || 0) - (user.frozen_balance || 0)))
}

async function getCurrentUser(OPENID) {
  const userRes = await db.collection('wdd-users').where({ openid: OPENID }).limit(1).get()
  const user = userRes.data[0] || null
  return user && user.is_deleted !== true ? user : null
}

async function verifyCurrentOrderOwner(order, OPENID) {
  const user = await getCurrentUser(OPENID)
  if (!user || order.user_id !== user._id) {
    return { ok: false, user: null }
  }
  return { ok: true, user }
}

function normalizePaymentSelection(selection = {}) {
  return {
    useDeduction: selection.useDeduction === true,
    useBalance: selection.useBalance === true,
    useWechat: selection.useWechat === true
  }
}

function calculatePaymentAllocation(user, totalAmount, rawSelection) {
  const selection = normalizePaymentSelection(rawSelection)
  const total = roundMoney(totalAmount)
  const availableDeduction = selection.useDeduction ? getAvailableDeduction(user) : 0
  const deductionAmount = Math.min(total, availableDeduction)
  const afterDeduction = roundMoney(total - deductionAmount)
  const availableBalance = selection.useBalance ? getAvailableBalance(user) : 0
  const balanceAmount = Math.min(afterDeduction, availableBalance)
  const afterBalance = roundMoney(afterDeduction - balanceAmount)
  const wechatAmount = selection.useWechat ? afterBalance : 0
  const uncoveredAmount = roundMoney(afterBalance - wechatAmount)
  const paymentMethods = []
  if (deductionAmount > 0) paymentMethods.push('deduction')
  if (balanceAmount > 0) paymentMethods.push('balance')
  if (wechatAmount > 0) paymentMethods.push('wechat')

  return {
    totalAmount: total,
    deductionAmount,
    balanceAmount,
    wechatAmount,
    uncoveredAmount,
    paymentMethods,
    selection
  }
}

function splitRefundAmounts(order, requestedTotalRefundAmount) {
  const totalAmount = roundMoney(order.total_amount || 0)
  const deductionAmount = roundMoney(order.deduction_amount || 0)
  const balanceAmount = roundMoney(order.balance_amount || 0)
  const wechatAmount = roundMoney(order.wechat_amount || 0)
  const refundAmount = Math.min(roundMoney(requestedTotalRefundAmount), totalAmount)

  if (totalAmount <= 0) {
    return {
      refundAmount: 0,
      deductionRefundAmount: 0,
      balanceRefundAmount: 0,
      wechatRefundAmount: 0,
      isFullRefund: true
    }
  }

  if (Math.round(refundAmount * 100) >= Math.round(totalAmount * 100)) {
    return {
      refundAmount: totalAmount,
      deductionRefundAmount: deductionAmount,
      balanceRefundAmount: balanceAmount,
      wechatRefundAmount: wechatAmount,
      isFullRefund: true
    }
  }

  const totalCents = Math.round(totalAmount * 100)
  const refundCents = Math.round(refundAmount * 100)
  const parts = [
    { key: 'deduction', cents: Math.round(deductionAmount * 100) },
    { key: 'balance', cents: Math.round(balanceAmount * 100) },
    { key: 'wechat', cents: Math.round(wechatAmount * 100) }
  ].map(part => {
    const exact = refundCents * part.cents / totalCents
    return {
      ...part,
      refundCents: Math.min(part.cents, Math.floor(exact)),
      remainder: exact - Math.floor(exact)
    }
  })

  let remainingCents = refundCents - parts.reduce((sum, part) => sum + part.refundCents, 0)
  parts
    .sort((a, b) => b.remainder - a.remainder)
    .forEach(part => {
      if (remainingCents > 0 && part.refundCents < part.cents) {
        part.refundCents++
        remainingCents--
      }
    })

  const refundByKey = Object.fromEntries(parts.map(part => [part.key, part.refundCents / 100]))
  const deductionRefundAmount = refundByKey.deduction
  const balanceRefundAmount = refundByKey.balance
  const wechatRefundAmount = refundByKey.wechat
  return {
    refundAmount,
    deductionRefundAmount,
    balanceRefundAmount,
    wechatRefundAmount,
    isFullRefund: false
  }
}

function normalizeOrderDescription(description, fallback = '发布求助') {
  return String(description || fallback).trim().slice(0, 80) || fallback
}

function normalizeNeedDescription(description) {
  return String(description || '').replace(DESCRIPTION_LINE_BREAK_RE, ' ').trim()
}

function validatePublishMetadata(metadata, rules) {
  const data = metadata && typeof metadata === 'object' ? metadata : {}
  const type = String(data.type || '').trim()
  if (!ALLOWED_NEED_TYPES.has(type)) {
    return { valid: false, message: '任务类型不合法' }
  }

  const description = normalizeNeedDescription(data.description)
  if (description.length < MIN_DESCRIPTION_LENGTH) {
    return { valid: false, message: `描述至少${MIN_DESCRIPTION_LENGTH}个字` }
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return { valid: false, message: `描述最多${MAX_DESCRIPTION_LENGTH}个字` }
  }

  const expireMinutes = Number(data.expireMinutes || rules.DEFAULT_EXPIRE_MINUTES)
  if (!Number.isInteger(expireMinutes) || !ALLOWED_EXPIRE_MINUTES.has(expireMinutes)) {
    return { valid: false, message: '过期时间不合法' }
  }

  const loc = data.location || {}
  const coordinates = Array.isArray(loc.coordinates) ? loc.coordinates.map(Number) : []
  const longitude = coordinates[0]
  const latitude = coordinates[1]
  if (
    coordinates.length !== 2 ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    longitude < -180 ||
    longitude > 180 ||
    latitude < -90 ||
    latitude > 90
  ) {
    return { valid: false, message: '经纬度范围不合法' }
  }

  const locationName = String(loc.name || '').trim()
  if (!locationName || locationName.length > MAX_LOCATION_NAME_LENGTH) {
    return { valid: false, message: '位置信息不完整或过长' }
  }

  const images = Array.isArray(data.images) ? data.images : []
  if (images.length > MAX_IMAGE_COUNT) {
    return { valid: false, message: `图片最多上传${MAX_IMAGE_COUNT}张` }
  }
  const safeImages = []
  for (const image of images) {
    if (typeof image !== 'string' || image.length > MAX_IMAGE_URL_LENGTH || !image.startsWith('cloud://')) {
      return { valid: false, message: '图片来源不合法' }
    }
    safeImages.push(image)
  }

  return {
    valid: true,
    metadata: {
      type,
      description,
      expireMinutes,
      location: {
        name: locationName,
        coordinates: [longitude, latitude]
      },
      images: safeImages
    }
  }
}

// 主入口
exports.main = async (event, context) => {
  // 识别微信支付异步回调（无 action 但有 returnCode）
  if (!event.action && event.returnCode) {
    return await handlePayCallback(event)
  }

  const { action } = event
  const wxContext = cloud.getWXContext()
  // 前端直接调用时 wxContext.OPENID 必存在，优先使用（防伪造）；云函数间调用时为空，回退到 event.openid
  const OPENID = wxContext.OPENID || event.openid
  const isInternalCall = !wxContext.OPENID && ['refundOrder', 'retryRefund', 'recoverPaidPendingOrder'].includes(action)

  if (!OPENID && !isInternalCall) {
    return { code: -1, message: '获取用户openid失败' }
  }

  try {
    switch (action) {
      case 'createOrder':
        return await createOrder(event, OPENID)
      case 'confirmPayment':
        return await confirmPayment(event, OPENID)
      case 'recoverPaidPendingOrder':
        return await recoverPaidPendingOrder(event, OPENID, isInternalCall)
      case 'cancelPendingOrder':
        return await cancelPendingOrder(event, OPENID)
      case 'queryOrder':
        return await queryOrder(event, OPENID)
      case 'refundOrder':
        return await refundOrder(event, OPENID)
      case 'retryRefund':
        return await retryRefund(event, OPENID)
      case 'payByWallet':
        return await payByWallet(event, OPENID)
      default:
        return { code: -1, message: '未知操作' }
    }
  } catch (err) {
    console.error('支付操作失败:', err)
    return { code: -1, message: err.message }
  }
}

// 处理微信支付异步回调
// 注意：仅记录 transactionId，订单状态由前端 confirmPayment 主导，避免竞争导致 need_id 缺失
async function handlePayCallback(event) {
  try {
    if (event.returnCode !== 'SUCCESS' || event.resultCode !== 'SUCCESS') {
      console.warn('支付回调非成功状态:', event)
      return { errcode: 0 }
    }

    const orderId = event.outTradeNo
    if (!orderId) return { errcode: 0 }

    const orderRes = await db.collection('wdd-payment-orders').doc(orderId).get().catch(() => null)
    if (!orderRes || !orderRes.data) return { errcode: 0 }

    // 仅在交易号未记录时回填，不动 status
    if (!orderRes.data.transaction_id && event.transactionId) {
      await db.collection('wdd-payment-orders').doc(orderId).update({
        data: {
          transaction_id: event.transactionId,
          update_time: new Date()
        }
      })
    }

    return { errcode: 0 }
  } catch (err) {
    console.error('支付回调处理失败:', err)
    // 即使失败也返回成功，避免微信重复回调
    return { errcode: 0 }
  }
}

// 创建支付订单
async function createOrder(event, OPENID) {
  const { amount: rawAmount, description, metadata, paymentSelection } = event

  const rules = await loadFromDb()

  const amountCheck = normalizeMoneyAmount(rawAmount)
  if (!amountCheck.valid) {
    return { code: -1, message: amountCheck.message }
  }
  const totalAmount = amountCheck.amount
  if (totalAmount < rules.MIN_REWARD_AMOUNT || totalAmount > rules.MAX_REWARD_AMOUNT) {
    return { code: -1, message: `支付金额必须在${rules.MIN_REWARD_AMOUNT}-${rules.MAX_REWARD_AMOUNT}元之间` }
  }
  const metadataCheck = validatePublishMetadata(metadata, rules)
  if (!metadataCheck.valid) {
    return { code: -1, message: metadataCheck.message }
  }
  const orderDescription = normalizeOrderDescription(description, metadataCheck.metadata.description)

  // 获取用户信息
  const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
  if (userRes.data.length === 0) {
    return { code: -1, message: '用户不存在' }
  }
  const user = userRes.data[0]
  const userLimit = checkUserCanPublish(user)
  if (!userLimit.allowed) {
    return { code: -1, message: userLimit.message }
  }
  const initialAllocation = calculatePaymentAllocation(user, totalAmount, paymentSelection)
  if (initialAllocation.uncoveredAmount > 0) {
    return { code: -1, message: `所选支付方式还差¥${formatAmount(initialAllocation.uncoveredAmount)}` }
  }
  if (initialAllocation.wechatAmount <= 0) {
    return { code: -1, message: '本次无需微信支付，请使用钱包支付发布' }
  }

  // 生成订单号
  const orderId = generateOrderNo()
  const now = new Date()
  const expireTime = new Date(now.getTime() + 30 * 60 * 1000) // 30分钟过期
  let finalAllocation = initialAllocation

  // 创建支付订单记录
  const transaction = await db.startTransaction()
  try {
    const userInTx = await transaction.collection('wdd-users').doc(user._id).get()
    const allocation = calculatePaymentAllocation(userInTx.data || {}, totalAmount, paymentSelection)
    if (allocation.uncoveredAmount > 0) {
      await transaction.rollback()
      return { code: -1, message: `所选支付方式还差¥${formatAmount(allocation.uncoveredAmount)}` }
    }
    if (allocation.wechatAmount <= 0) {
      await transaction.rollback()
      return { code: -1, message: '本次无需微信支付，请重新提交' }
    }
    finalAllocation = allocation

    const freezeUpdateData = { update_time: now }
    if (allocation.deductionAmount > 0) {
      freezeUpdateData.frozen_deduction_balance = _.inc(allocation.deductionAmount)
    }
    if (allocation.balanceAmount > 0) {
      freezeUpdateData.frozen_balance = _.inc(allocation.balanceAmount)
    }
    if (allocation.deductionAmount > 0 || allocation.balanceAmount > 0) {
      await transaction.collection('wdd-users').doc(user._id).update({
        data: freezeUpdateData
      })
      await transaction.collection('wdd-balance-records').add({
        data: {
          user_id: user._id,
          type: 'freeze',
          amount: 0,
          balance: userInTx.data.balance || 0,
          frozen_balance: roundMoney((userInTx.data.frozen_balance || 0) + allocation.balanceAmount),
          description: `发布求助冻结余额¥${formatAmount(allocation.balanceAmount)}，平台抵扣金¥${formatAmount(allocation.deductionAmount)}：${orderDescription}`,
          create_time: now
        }
      })
    }

    await transaction.collection('wdd-payment-orders').add({
      data: {
        _id: orderId,
        user_id: user._id,
        openid: OPENID,
        total_amount: allocation.totalAmount,
        deduction_amount: allocation.deductionAmount,
        balance_amount: allocation.balanceAmount,
        wechat_amount: allocation.wechatAmount,
        payment_methods: allocation.paymentMethods,
        payment_selection: allocation.selection,
        description: orderDescription,
        status: 'pending',
        metadata: metadataCheck.metadata,
        create_time: now,
        expire_time: expireTime,
        update_time: now,
        out_trade_no: orderId,
        transaction_id: null,
        refund_id: null
      }
    })

    await transaction.commit()
  } catch (err) {
    await transaction.rollback()
    throw err
  }

  let paymentData

  try {
    if (MOCK_PAYMENT) {
      // 模拟支付：返回模拟的支付参数
      paymentData = generateMockPayment(orderId)
    } else {
      // 真实支付：调用微信支付统一下单API
      const realPayRes = await createRealPayment(orderId, finalAllocation.wechatAmount, orderDescription, OPENID)
      paymentData = realPayRes.payment
      // 记录微信支付交易号（createOrder 不在事务中，直接更新即可）
      if (realPayRes.transactionId) {
        await db.collection('wdd-payment-orders').doc(orderId).update({
          data: {
            transaction_id: realPayRes.transactionId,
            update_time: new Date()
          }
        })
      }
    }
  } catch (err) {
    await releasePendingOrderFunds(orderId, '微信支付下单失败')
    throw err
  }

  return {
    code: 0,
    message: '订单创建成功',
    data: {
      orderId: orderId,
      payment: paymentData,
      expireTime: expireTime,
      totalAmount: finalAllocation.totalAmount,
      deductionAmount: finalAllocation.deductionAmount,
      balanceAmount: finalAllocation.balanceAmount,
      wechatAmount: finalAllocation.wechatAmount,
      paymentMethods: finalAllocation.paymentMethods
    }
  }
}

async function releasePendingOrderFunds(orderId, reason) {
  const transaction = await db.startTransaction()

  try {
    const orderResTx = await transaction.collection('wdd-payment-orders').doc(orderId).get()
    const orderInTx = orderResTx.data
    if (!orderInTx || orderInTx.status !== 'pending') {
      await transaction.rollback()
      return false
    }

    const deductionAmount = roundMoney(orderInTx.deduction_amount || 0)
    const balanceAmount = roundMoney(orderInTx.balance_amount || 0)
    if ((deductionAmount > 0 || balanceAmount > 0) && orderInTx.user_id) {
      await transaction.collection('wdd-users').doc(orderInTx.user_id).get()
      const userUpdateData = { update_time: new Date() }
      if (deductionAmount > 0) {
        userUpdateData.frozen_deduction_balance = _.inc(-deductionAmount)
      }
      if (balanceAmount > 0) {
        userUpdateData.frozen_balance = _.inc(-balanceAmount)
      }
      await transaction.collection('wdd-users').doc(orderInTx.user_id).update({
        data: userUpdateData
      })
    }

    await transaction.collection('wdd-payment-orders').doc(orderId).update({
      data: {
        status: 'cancelled',
        cancel_reason: reason || 'pending_order_cancelled',
        deduction_released_amount: deductionAmount,
        balance_released_amount: balanceAmount,
        update_time: new Date()
      }
    })

    await transaction.commit()
    return true
  } catch (err) {
    await transaction.rollback()
    console.error('释放待支付订单冻结资金失败:', err)
    return false
  }
}

async function cancelPendingOrder(event, OPENID) {
  const { orderId } = event
  if (!orderId) {
    return { code: -1, message: '订单ID不能为空' }
  }

  const orderRes = await db.collection('wdd-payment-orders').doc(orderId).get().catch(() => null)
  const order = orderRes && orderRes.data
  if (!order) {
    return { code: -1, message: '订单不存在或无权操作' }
  }
  const owner = await verifyCurrentOrderOwner(order, OPENID)
  if (!owner.ok) {
    return { code: -1, message: '订单不存在或无权操作' }
  }
  if (order.status !== 'pending') {
    return { code: 0, message: '订单无需取消' }
  }

  if (roundMoney(order.wechat_amount || 0) > 0) {
    const recoverResult = await recoverPaidPendingOrder({ orderId }, OPENID, false)
    if (recoverResult && recoverResult.code === 0 && recoverResult.paid) {
      return {
        code: 0,
        message: '微信支付已成功，订单已恢复发布',
        data: recoverResult.data
      }
    }
    if (!recoverResult || recoverResult.code !== 0) {
      return { code: -1, message: recoverResult?.message || '微信订单状态确认失败，请稍后重试' }
    }
  }

  const released = await releasePendingOrderFunds(orderId, '用户取消微信支付')
  return released
    ? { code: 0, message: '订单已取消，冻结资金已释放' }
    : { code: -1, message: '订单取消失败，请稍后重试' }
}

// 前端确认发布失败或定时任务扫描过期订单时，用它补偿“微信已扣款但订单仍 pending”的中间态。
async function recoverPaidPendingOrder(event, OPENID, isInternalCall = false) {
  const { orderId } = event
  if (!orderId) {
    return { code: -1, message: '订单ID不能为空' }
  }

  const orderRes = await db.collection('wdd-payment-orders').doc(orderId).get().catch(() => null)
  const order = orderRes && orderRes.data
  if (!order) {
    return { code: -1, message: '订单不存在' }
  }

  const callerOpenid = isInternalCall ? (event.openid || order.openid) : OPENID
  const owner = await verifyCurrentOrderOwner(order, callerOpenid)
  if (!owner.ok) {
    return { code: -1, message: '订单归属错误' }
  }

  if (order.status === 'paid' && order.metadata && order.metadata.need_id) {
    return {
      code: 0,
      message: '订单已恢复',
      recovered: true,
      paid: true,
      data: { needId: order.metadata.need_id, orderId }
    }
  }

  if (order.status !== 'pending') {
    return { code: 0, message: '订单无需恢复', recovered: false, paid: false, status: order.status }
  }

  if (roundMoney(order.wechat_amount || 0) <= 0) {
    return { code: 0, message: '订单不含微信支付，无需恢复', recovered: false, paid: false }
  }

  const verifyRes = MOCK_PAYMENT
    ? { success: true, transactionId: order.transaction_id || null }
    : await verifyRealPayment(order)

  if (!verifyRes.success) {
    const message = verifyRes.message || '微信侧尚未确认付款'
    if (message.includes('微信支付确认失败') || message.includes('真实支付尚未配置') || message.includes('微信订单查询失败')) {
      return {
        code: -1,
        message,
        recovered: false,
        paid: false
      }
    }
    return {
      code: 0,
      message,
      recovered: false,
      paid: false
    }
  }

  if (verifyRes.transactionId && !order.transaction_id) {
    await db.collection('wdd-payment-orders').doc(orderId).update({
      data: {
        transaction_id: verifyRes.transactionId,
        update_time: new Date()
      }
    })
  }

  const confirmResult = await confirmPayment({ orderId }, order.openid)
  return {
    ...confirmResult,
    recovered: confirmResult.code === 0,
    paid: true
  }
}

// 确认支付（支付成功后调用）
async function confirmPayment(event, OPENID) {
  const { orderId } = event

  if (!orderId) {
    return { code: -1, message: '订单ID不能为空' }
  }

  const currentUser = await getCurrentUser(OPENID)
  if (!currentUser) {
    return { code: -1, message: '用户不存在' }
  }

  if (!MOCK_PAYMENT) {
    const preOrderRes = await db.collection('wdd-payment-orders').doc(orderId).get().catch(() => null)
    const preOrder = preOrderRes && preOrderRes.data
    if (!preOrder) {
      return { code: -1, message: '订单不存在' }
    }
    if (preOrder.user_id !== currentUser._id) {
      return { code: -1, message: '订单归属错误' }
    }
    if (preOrder.status === 'pending') {
      const verifyRes = await verifyRealPayment(preOrder)
      if (!verifyRes.success) {
        return { code: -1, message: verifyRes.message || '微信支付尚未确认成功' }
      }
      if (verifyRes.transactionId && !preOrder.transaction_id) {
        await db.collection('wdd-payment-orders').doc(orderId).update({
          data: {
            transaction_id: verifyRes.transactionId,
            update_time: new Date()
          }
        })
      }
    }
  }

  // 开启事务：更新订单状态 + 创建任务（订单状态必须从事务内读取，避免并发修改）
  const transaction = await db.startTransaction()

  try {
    // 0. 事务内必须先 get 订单，才能 update（云开发事务强制规则）
    const orderResTx = await transaction.collection('wdd-payment-orders').doc(orderId).get()
    const orderInTx = orderResTx.data
    if (!orderInTx) {
      await transaction.rollback()
      return { code: -1, message: '订单不存在' }
    }
    const rawMetadata = orderInTx.metadata || {}
    if (orderInTx.user_id !== currentUser._id) {
      await transaction.rollback()
      return { code: -1, message: '订单归属错误' }
    }
    if (orderInTx.status === 'paid' && orderInTx.metadata && orderInTx.metadata.need_id) {
      await transaction.rollback()
      return { code: 0, message: '订单已支付', data: { needId: orderInTx.metadata.need_id } }
    }
    if (orderInTx.status !== 'pending') {
      await transaction.rollback()
      return { code: -1, message: '订单状态异常，无法确认支付' }
    }
    if (new Date() > orderInTx.expire_time && roundMoney(orderInTx.wechat_amount || 0) <= 0) {
      const deductionAmount = roundMoney(orderInTx.deduction_amount || 0)
      const balanceAmount = roundMoney(orderInTx.balance_amount || 0)
      if (deductionAmount > 0 || balanceAmount > 0) {
        await transaction.collection('wdd-users').doc(orderInTx.user_id).get()
        const userUpdateData = { update_time: new Date() }
        if (deductionAmount > 0) {
          userUpdateData.frozen_deduction_balance = _.inc(-deductionAmount)
        }
        if (balanceAmount > 0) {
          userUpdateData.frozen_balance = _.inc(-balanceAmount)
        }
        await transaction.collection('wdd-users').doc(orderInTx.user_id).update({
          data: userUpdateData
        })
      }
      await transaction.collection('wdd-payment-orders').doc(orderId).update({
        data: {
          status: 'cancelled',
          deduction_released_amount: deductionAmount,
          balance_released_amount: balanceAmount,
          update_time: new Date()
        }
      })
      await transaction.commit()
      return { code: -1, message: '订单已过期，请重新创建' }
    }

    // 1. 获取用户信息
    const userRes = await transaction.collection('wdd-users').where({
      openid: OPENID
    }).get()
    const user = userRes.data[0]

    // 2. 计算过期时间
    const rules = await loadFromDb()
    const metadataCheck = validatePublishMetadata(rawMetadata, rules)
    if (!metadataCheck.valid) {
      throw new Error(metadataCheck.message)
    }
    const metadata = metadataCheck.metadata
    const expireMinutes = metadata.expireMinutes
    const expireTime = new Date(Date.now() + expireMinutes * 60 * 1000)

    const loc = metadata.location

    // 3. 创建任务
    const taskNo = generateTaskNo()

    const needRes = await transaction.collection('wdd-needs').add({
      data: {
        task_no: taskNo,
        user_id: user._id,
        location: {
          type: 'Point',
          coordinates: loc.coordinates
        },
        location_name: loc.name,
        type: metadata.type,
        description: metadata.description || '',
        images: metadata.images || [],
        points: 0, // 积分字段保留但设为0
        reward_amount: orderInTx.total_amount,
        total_amount: orderInTx.total_amount,
        deduction_amount: orderInTx.deduction_amount || 0,
        balance_amount: orderInTx.balance_amount || 0,
        wechat_amount: orderInTx.wechat_amount || 0,
        payment_methods: orderInTx.payment_methods || [],
        platform_fee: 0, // 完成后计算
        taker_income: 0, // 完成后计算
        status: 'pending',
        payment_status: 'paid',
        payment_order_id: orderId,
        expire_time: expireTime,
        create_time: new Date(),
        update_time: new Date(),
        taker_id: null
      }
    })

    // 4. 更新订单状态（云开发事务中同一文档只能 update 一次，合并 status + metadata）
    await transaction.collection('wdd-payment-orders').doc(orderId).update({
      data: {
        status: 'paid',
        pay_time: new Date(),
        'metadata.need_id': needRes._id,
        update_time: new Date()
      }
    })

    // 5. 更新用户累计支付金额
    await transaction.collection('wdd-users').doc(user._id).update({
      data: {
        total_paid: _.inc(orderInTx.wechat_amount || 0),
        update_time: new Date()
      }
    })

    // 6. 创建系统通知
    await transaction.collection('wdd-notifications').add({
      data: {
        user_id: user._id,
        type: 'system',
        title: '求助发布成功',
        content: `您发布的求助任务已上线，悬赏金额¥${orderInTx.total_amount}，正在为您匹配附近帮助者...`,
        need_id: needRes._id,
        is_read: false,
        create_time: new Date()
      }
    })

    await transaction.commit()

    return {
      code: 0,
      message: '支付成功，任务已发布',
      data: {
        needId: needRes._id,
        taskNo: taskNo,
        orderId: orderId,
        totalAmount: orderInTx.total_amount,
        deductionAmount: orderInTx.deduction_amount || 0,
        balanceAmount: orderInTx.balance_amount || 0,
        wechatAmount: orderInTx.wechat_amount || 0,
        paymentMethods: orderInTx.payment_methods || []
      }
    }

  } catch (err) {
    await transaction.rollback()
    console.error('确认支付事务失败:', err)
    return { code: -1, message: '支付处理失败: ' + err.message }
  }
}

// 无微信补差时，冻结所选钱包资金并直接创建任务
async function payByWallet(event, OPENID) {
  const { amount: rawAmount, description, metadata, paymentSelection } = event

  const amountCheck = normalizeMoneyAmount(rawAmount)
  if (!amountCheck.valid) {
    return { code: -1, message: amountCheck.message }
  }
  const totalAmount = amountCheck.amount

  const rules = await loadFromDb()
  const minAmount = rules.MIN_REWARD_AMOUNT ?? 1
  const maxAmount = rules.MAX_REWARD_AMOUNT || 500

  if (totalAmount < minAmount) {
    return { code: -1, message: `悬赏金额最低¥${minAmount}` }
  }
  if (totalAmount > maxAmount) {
    return { code: -1, message: `悬赏金额最高¥${maxAmount}` }
  }
  const metadataCheck = validatePublishMetadata(metadata, rules)
  if (!metadataCheck.valid) {
    return { code: -1, message: metadataCheck.message }
  }
  const safeMetadata = metadataCheck.metadata
  const orderDescription = normalizeOrderDescription(description, safeMetadata.description)

  // 查询用户
  const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
  if (userRes.data.length === 0) {
    return { code: -1, message: '用户不存在' }
  }
  const user = userRes.data[0]
  const userLimit = checkUserCanPublish(user)
  if (!userLimit.allowed) {
    return { code: -1, message: userLimit.message }
  }
  const initialAllocation = calculatePaymentAllocation(user, totalAmount, paymentSelection)
  if (initialAllocation.wechatAmount > 0) {
    return { code: -1, message: '本次包含微信支付，请创建微信支付订单' }
  }
  if (initialAllocation.uncoveredAmount > 0) {
    return { code: -1, message: `所选支付方式还差¥${formatAmount(initialAllocation.uncoveredAmount)}` }
  }
  if (initialAllocation.paymentMethods.length === 0) {
    return { code: -1, message: '请至少选择一种支付方式' }
  }

  const loc = safeMetadata.location

  const orderId = generateOrderNo()
  const expireMinutes = safeMetadata.expireMinutes
  const expireTime = new Date(Date.now() + expireMinutes * 60 * 1000)

  const transaction = await db.startTransaction()

  try {
    // 事务内重新查询余额（防并发）
    const userInTx = await transaction.collection('wdd-users').doc(user._id).get()
    const currentBalance = userInTx.data.balance || 0
    const currentFrozen = userInTx.data.frozen_balance || 0
    const allocation = calculatePaymentAllocation(userInTx.data || {}, totalAmount, paymentSelection)
    if (allocation.wechatAmount > 0 || allocation.uncoveredAmount > 0) {
      await transaction.rollback()
      return { code: -1, message: `钱包资金发生变化，请重新确认支付方式` }
    }

    const freezeUpdateData = { update_time: new Date() }
    if (allocation.balanceAmount > 0) {
      freezeUpdateData.frozen_balance = _.inc(allocation.balanceAmount)
    }
    if (allocation.deductionAmount > 0) {
      freezeUpdateData.frozen_deduction_balance = _.inc(allocation.deductionAmount)
    }
    await transaction.collection('wdd-users').doc(user._id).update({ data: freezeUpdateData })

    // 写入冻结流水
    await transaction.collection('wdd-balance-records').add({
      data: {
        user_id: user._id,
        type: 'freeze',
        amount: 0,
        balance: currentBalance,
        frozen_balance: currentFrozen + allocation.balanceAmount,
        description: `发布求助冻结余额¥${formatAmount(allocation.balanceAmount)}，平台抵扣金¥${formatAmount(allocation.deductionAmount)}：${orderDescription}`,
        create_time: new Date()
      }
    })

    // 创建支付订单（一步到位，status=paid）
    await transaction.collection('wdd-payment-orders').add({
      data: {
        _id: orderId,
        user_id: user._id,
        openid: OPENID,
        total_amount: allocation.totalAmount,
        deduction_amount: allocation.deductionAmount,
        balance_amount: allocation.balanceAmount,
        wechat_amount: 0,
        payment_methods: allocation.paymentMethods,
        payment_selection: allocation.selection,
        description: orderDescription,
        status: 'paid',
        metadata: {
          ...safeMetadata,
          need_id: null
        },
        out_trade_no: orderId,
        transaction_id: null,
        refund_id: null,
        total_refund_amount: null,
        deduction_refund_amount: null,
        balance_refund_amount: null,
        wechat_refund_amount: null,
        refund_attempts: 0,
        next_retry_time: null,
        last_refund_error: null,
        create_time: new Date(),
        expire_time: new Date(Date.now() + 30 * 60 * 1000),
        pay_time: new Date(),
        refund_time: null,
        update_time: new Date()
      }
    })

    // 创建任务
    const taskNo = generateTaskNo()

    const needRes = await transaction.collection('wdd-needs').add({
      data: {
        task_no: taskNo,
        user_id: user._id,
        location: {
          type: 'Point',
          coordinates: loc.coordinates
        },
        location_name: loc.name,
        type: safeMetadata.type,
        description: safeMetadata.description,
        images: safeMetadata.images,
        points: 0,
        reward_amount: allocation.totalAmount,
        total_amount: allocation.totalAmount,
        deduction_amount: allocation.deductionAmount,
        balance_amount: allocation.balanceAmount,
        wechat_amount: 0,
        payment_methods: allocation.paymentMethods,
        platform_fee: 0,
        taker_income: 0,
        status: 'pending',
        payment_status: 'paid',
        payment_order_id: orderId,
        expire_time: expireTime,
        create_time: new Date(),
        update_time: new Date(),
        taker_id: null
      }
    })

    // 回填 need_id 到订单 metadata
    await transaction.collection('wdd-payment-orders').doc(orderId).update({
      data: {
        'metadata.need_id': needRes._id,
        update_time: new Date()
      }
    })

    // 发送通知
    await transaction.collection('wdd-notifications').add({
      data: {
        user_id: user._id,
        type: 'system',
        title: '求助发布成功',
        content: `您发布的求助任务已上线，悬赏金额¥${allocation.totalAmount}，正在为您匹配附近帮助者...`,
        need_id: needRes._id,
        is_read: false,
        create_time: new Date()
      }
    })

    await transaction.commit()

    return {
      code: 0,
      message: '发布成功',
      data: {
        needId: needRes._id,
        taskNo: taskNo,
        orderId: orderId,
        totalAmount: allocation.totalAmount,
        deductionAmount: allocation.deductionAmount,
        balanceAmount: allocation.balanceAmount,
        wechatAmount: 0,
        paymentMethods: allocation.paymentMethods
      }
    }
  } catch (err) {
    await transaction.rollback()
    console.error('钱包支付事务失败:', err)
    return { code: -1, message: '支付处理失败: ' + err.message }
  }
}

// 查询订单状态
async function queryOrder(event, OPENID) {
  const { orderId } = event

  const orderRes = await db.collection('wdd-payment-orders').doc(orderId).get()
  if (!orderRes.data) {
    return { code: -1, message: '订单不存在' }
  }

  const order = orderRes.data
  const owner = await verifyCurrentOrderOwner(order, OPENID)
  if (!owner.ok) {
    return { code: -1, message: '无权查看此订单' }
  }

  return {
    code: 0,
    message: '查询成功',
    data: {
      orderId: order._id,
      status: order.status,
      totalAmount: order.total_amount,
      deductionAmount: order.deduction_amount || 0,
      balanceAmount: order.balance_amount || 0,
      wechatAmount: order.wechat_amount || 0,
      paymentMethods: order.payment_methods || [],
      createTime: order.create_time,
      payTime: order.pay_time,
      needId: order.metadata?.need_id
    }
  }
}

// 退款（任务取消时调用）
async function refundOrder(event, OPENID) {
  const { orderId, needId } = event

  if (!orderId && !needId) {
    return { code: -1, message: '订单ID或任务ID必须提供' }
  }

  // 退款只能由任务取消、自动取消或客服裁定等后端流程触发，禁止前端直接拿订单号退款。
  if (cloud.getWXContext().OPENID) {
    return { code: -1, message: '退款需通过任务取消或客服流程发起' }
  }

  // 云函数间调用需从 event 读取 openid；前端直接调用使用 wxContext 的 OPENID
  const callerOpenid = event.openid || OPENID

  let order

  // 优先使用调用方传来的预查询订单数据，避免重复查库（但仍校验 openid）
  if (event.orderData && event.orderData.out_trade_no) {
    order = event.orderData
  } else if (orderId) {
    const orderRes = await db.collection('wdd-payment-orders').doc(orderId).get()
    if (!orderRes.data) {
      return { code: -1, message: '订单不存在' }
    }
    order = orderRes.data
  } else {
    // 通过任务ID查找订单（同时兼容 paid 和 refund_pending 状态）
    const orderRes = await db.collection('wdd-payment-orders')
      .where({
        'metadata.need_id': needId,
        status: _.in(['paid', 'refund_pending'])
      })
      .limit(1)
      .get()
    if (orderRes.data.length === 0) {
      return { code: -1, message: '未找到关联的支付订单' }
    }
    order = orderRes.data[0]
  }

  // 校验订单归属
  if (order.openid !== callerOpenid) {
    return { code: -1, message: '订单归属错误' }
  }

  return await executeRefund(order, {
    refundAmount: event.refundAmount,
    refundReason: event.refundReason
  })
}

// 退款重试（由 wdd-auto-cancel 定时器调用，专门处理 refund_pending 状态的订单）
async function retryRefund(event, OPENID) {
  const { orderId } = event
  if (!orderId) {
    return { code: -1, message: '订单ID不能为空' }
  }

  const orderRes = await db.collection('wdd-payment-orders').doc(orderId).get()
  if (!orderRes.data) {
    return { code: -1, message: '订单不存在' }
  }

  const order = orderRes.data
  if (order.status !== 'refund_pending') {
    return { code: -1, message: '订单状态非待退款，无需重试' }
  }

  return await executeRefund(order)
}

async function prepareRefundAttempt(order, refundPlan) {
  const transaction = await db.startTransaction()
  try {
    const orderResTx = await transaction.collection('wdd-payment-orders').doc(order._id).get()
    const orderInTx = orderResTx.data
    if (!orderInTx) {
      await transaction.rollback()
      return { code: -1, message: '订单不存在', status: 'failed' }
    }

    if (orderInTx.status === 'refunded') {
      await transaction.rollback()
      return {
        code: 0,
        done: true,
        message: '订单已退款',
        status: 'refunded',
        data: { orderId: order._id, refundAmount: orderInTx.total_refund_amount || orderInTx.total_amount }
      }
    }

    if (!['paid', 'refund_pending', 'refund_processing'].includes(orderInTx.status)) {
      await transaction.rollback()
      return { code: -1, message: '订单状态不允许退款', status: 'failed' }
    }

    await transaction.collection('wdd-payment-orders').doc(order._id).update({
      data: {
        status: 'refund_pending',
        total_refund_amount: refundPlan.refundAmount,
        deduction_refund_amount: refundPlan.deductionRefundAmount,
        balance_refund_amount: refundPlan.balanceRefundAmount,
        wechat_refund_amount: refundPlan.wechatRefundAmount,
        refund_reason: refundPlan.refundReason,
        next_retry_time: null,
        update_time: new Date()
      }
    })

    await transaction.commit()
    return {
      code: 0,
      order: {
        ...orderInTx,
        status: 'refund_pending',
        total_refund_amount: refundPlan.refundAmount,
        deduction_refund_amount: refundPlan.deductionRefundAmount,
        balance_refund_amount: refundPlan.balanceRefundAmount,
        wechat_refund_amount: refundPlan.wechatRefundAmount,
        refund_reason: refundPlan.refundReason
      }
    }
  } catch (err) {
    await transaction.rollback()
    console.error('准备退款状态失败:', err)
    return { code: -1, message: '准备退款失败: ' + err.message, status: 'failed' }
  }
}

// 退款核心逻辑：按订单三项支付明细拆分，钱包资金结算与微信退款在同一结果中落账。
async function executeRefund(order, options = {}) {
  const maxRefundAmount = roundMoney(order.total_amount || 0)
  const requestedRefundAmount = Number(options.refundAmount || order.total_refund_amount || maxRefundAmount)
  if (!Number.isFinite(requestedRefundAmount) || requestedRefundAmount <= 0) {
    return { code: -1, message: '退款金额必须大于0', status: 'failed' }
  }
  if (requestedRefundAmount > maxRefundAmount) {
    return { code: -1, message: '退款金额不能超过订单金额', status: 'failed' }
  }
  const {
    refundAmount,
    deductionRefundAmount,
    balanceRefundAmount,
    wechatRefundAmount,
    isFullRefund
  } = splitRefundAmounts(order, requestedRefundAmount)
  const refundReason = options.refundReason || order.refund_reason || '任务取消'

  const MAX_REFUND_ATTEMPTS = 5
  const BACKOFF_MINUTES = [5, 10, 20, 40, 80]

  const refundPlan = {
    refundAmount,
    deductionRefundAmount,
    balanceRefundAmount,
    wechatRefundAmount,
    refundReason
  }
  const prepared = await prepareRefundAttempt(order, refundPlan)
  if (prepared.done || prepared.code !== 0) {
    return prepared
  }
  const refundOrderData = prepared.order

  let refundResult = null
  let refundError = null

  // 微信部分先原路退款；失败时保持钱包冻结，等待整体重试。
  if (!MOCK_PAYMENT && wechatRefundAmount > 0) {
    if (!refundOrderData.out_trade_no) {
      return { code: -1, message: '订单缺少支付单号，无法退款', status: 'failed' }
    }
    try {
      refundResult = await createRealRefund(refundOrderData, wechatRefundAmount)
    } catch (err) {
      refundError = err
      console.error('微信退款失败:', err)
    }
  }

  const transaction = await db.startTransaction()

  try {
    const orderResTx = await transaction.collection('wdd-payment-orders').doc(order._id).get()
    const orderInTx = orderResTx.data
    if (!orderInTx) {
      await transaction.rollback()
      return { code: -1, message: '订单不存在', status: 'failed' }
    }

    // 幂等：已退款则直接返回成功
    if (orderInTx.status === 'refunded') {
      await transaction.rollback()
      return {
        code: 0,
        message: '订单已退款',
        status: 'refunded',
        data: { orderId: order._id, refundAmount: orderInTx.total_refund_amount || orderInTx.total_amount }
      }
    }

    // 只允许从 paid / refund_pending 状态发起退款
    if (orderInTx.status !== 'paid' && orderInTx.status !== 'refund_pending' && orderInTx.status !== 'refund_processing') {
      await transaction.rollback()
      return { code: -1, message: '订单状态不允许退款', status: 'failed' }
    }

    if (refundError) {
      // 退款失败：挂入待重试队列，由 wdd-auto-cancel 扫描重试
      const attempts = (orderInTx.refund_attempts || 0) + 1
      const errMsg = (refundError.message || '微信退款失败').slice(0, 200)

      if (attempts >= MAX_REFUND_ATTEMPTS) {
        // 达到重试上限 → 标记失败，不再自动重试
        await transaction.collection('wdd-payment-orders').doc(order._id).update({
          data: {
            status: 'refund_failed',
            total_refund_amount: refundAmount,
            deduction_refund_amount: deductionRefundAmount,
            balance_refund_amount: balanceRefundAmount,
            wechat_refund_amount: wechatRefundAmount,
            refund_reason: refundReason,
            refund_attempts: attempts,
            last_refund_error: errMsg,
            update_time: new Date()
          }
        })
        await transaction.commit()
        return {
          code: -1,
          message: '退款重试次数已达上限，请联系客服处理',
          status: 'failed',
          data: { orderId: order._id }
        }
      }

      // 计算下次重试时间（指数退避）
      const backoffMin = BACKOFF_MINUTES[attempts - 1] || BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1]
      const nextRetryTime = new Date(Date.now() + backoffMin * 60 * 1000)

      await transaction.collection('wdd-payment-orders').doc(order._id).update({
        data: {
          status: 'refund_pending',
          total_refund_amount: refundAmount,
          deduction_refund_amount: deductionRefundAmount,
          balance_refund_amount: balanceRefundAmount,
          wechat_refund_amount: wechatRefundAmount,
          refund_reason: refundReason,
          refund_attempts: attempts,
          last_refund_error: errMsg,
          next_retry_time: nextRetryTime,
          update_time: new Date()
        }
      })
      await transaction.commit()
      return {
        code: 0,
        message: `退款已加入重试队列，将在约 ${backoffMin} 分钟内自动重试`,
        status: 'pending',
        data: { orderId: order._id, attempts, nextRetryTime }
      }
    }

    const spentBalanceAmount = roundMoney((orderInTx.balance_amount || 0) - balanceRefundAmount)
    const spentDeductionAmount = roundMoney((orderInTx.deduction_amount || 0) - deductionRefundAmount)
    const orderUpdateData = {
      status: isFullRefund ? 'refunded' : 'partially_refunded',
      refund_time: new Date(),
      total_refund_amount: refundAmount,
      deduction_refund_amount: deductionRefundAmount,
      balance_refund_amount: balanceRefundAmount,
      wechat_refund_amount: wechatRefundAmount,
      refund_reason: refundReason,
      update_time: new Date()
    }
    if (refundResult && refundResult.refundId) {
      orderUpdateData.refund_id = refundResult.refundId
    }
    if (refundResult && refundResult.outRefundNo) {
      orderUpdateData.out_refund_no = refundResult.outRefundNo
    }

    await transaction.collection('wdd-payment-orders').doc(order._id).update({
      data: orderUpdateData
    })

    const userRes = await transaction.collection('wdd-users').where({
      openid: orderInTx.openid
    }).get()
    const hasWalletFunds = (orderInTx.balance_amount || 0) > 0 || (orderInTx.deduction_amount || 0) > 0
    if (hasWalletFunds && userRes.data.length === 0) {
      await transaction.rollback()
      return { code: -1, message: '用户钱包不存在，无法完成退款', status: 'failed' }
    }
    if (userRes.data.length > 0) {
      const user = userRes.data[0]
      if ((user.frozen_balance || 0) < (orderInTx.balance_amount || 0)) {
        await transaction.rollback()
        return { code: -1, message: '冻结余额不足，无法完成退款', status: 'failed' }
      }
      if ((user.frozen_deduction_balance || 0) < (orderInTx.deduction_amount || 0)) {
        await transaction.rollback()
        return { code: -1, message: '冻结平台抵扣金不足，无法完成退款', status: 'failed' }
      }
      const userUpdateData = {
        total_paid: _.inc(spentBalanceAmount - wechatRefundAmount),
        update_time: new Date()
      }
      if ((orderInTx.balance_amount || 0) > 0) {
        userUpdateData.balance = _.inc(-spentBalanceAmount)
        userUpdateData.frozen_balance = _.inc(-orderInTx.balance_amount)
      }
      if ((orderInTx.deduction_amount || 0) > 0) {
        userUpdateData.deduction_balance = _.inc(-spentDeductionAmount)
        userUpdateData.frozen_deduction_balance = _.inc(-orderInTx.deduction_amount)
      }
      await transaction.collection('wdd-users').doc(user._id).update({ data: userUpdateData })

      await transaction.collection('wdd-balance-records').add({
        data: {
          user_id: user._id,
          type: 'refund',
          amount: balanceRefundAmount,
          balance: roundMoney((user.balance || 0) - spentBalanceAmount),
          frozen_balance: roundMoney((user.frozen_balance || 0) - (orderInTx.balance_amount || 0)),
          description: isFullRefund ? '任务取消，所选支付资金已退回' : '任务部分完成，未消费资金已退回',
          create_time: new Date()
        }
      })
    }

    await transaction.commit()

    return {
      code: 0,
      message: '退款成功',
      status: orderUpdateData.status,
      data: {
        orderId: order._id,
        refundAmount: refundAmount,
        deductionRefundAmount,
        balanceRefundAmount,
        wechatRefundAmount
      }
    }

  } catch (err) {
    await transaction.rollback()
    console.error('退款事务失败:', err)
    return { code: -1, message: '退款失败: ' + err.message, status: 'failed' }
  }
}

// 生成订单号
function generateOrderNo() {
  const now = new Date()
  const dateStr = now.getFullYear().toString().slice(2) +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0')
  const timeStr = String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0')
  const randomStr = Math.random().toString(36).substr(2, 6).toUpperCase()
  return `WDD${dateStr}${timeStr}${randomStr}`
}

// 生成 16 位任务单号：W + 年月日 + 9 位随机码
function generateTaskNo() {
  const now = new Date()
  const dateStr = now.getFullYear().toString().slice(2) +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0')
  const randomStr = Math.random().toString(36).slice(2, 11).toUpperCase().padEnd(9, '0')
  return `W${dateStr}${randomStr}`
}

// 生成模拟支付参数
function generateMockPayment(orderId) {
  const now = Math.floor(Date.now() / 1000)
  return {
    timeStamp: String(now),
    nonceStr: Math.random().toString(36).substr(2, 16),
    package: `prepay_id=mock_${orderId}`,
    signType: 'RSA',
    paySign: 'MOCK_PAYMENT_SIGNATURE'
  }
}

// 真实支付：调用微信支付统一下单API
async function createRealPayment(orderId, amount, description, openid) {
  if (!SUB_MCH_ID) {
    throw new Error('真实支付尚未配置：请在代码中填入 SUB_MCH_ID（微信支付商户号）')
  }

  try {
    const res = await cloud.cloudPay.unifiedOrder({
      body: description || '发布求助',
      outTradeNo: orderId,
      totalFee: Math.round(amount * 100),
      spbillCreateIp: '127.0.0.1',
      subMchId: SUB_MCH_ID,
      envId: 'wdd-2grpiy1r6f9f4cf2',
      functionName: 'wdd-payment',
      tradeType: 'JSAPI',
      openid: openid
    })

    if (res.returnCode !== 'SUCCESS' || res.resultCode !== 'SUCCESS') {
      throw new Error(res.returnMsg || '统一下单失败')
    }

    // 只返回支付参数和交易号，数据库统一在事务中更新
    return {
      payment: res.payment,
      transactionId: res.transactionId || null
    }
  } catch (err) {
    console.error('真实支付下单失败:', err)
    throw new Error('支付下单失败: ' + err.message)
  }
}

function checkUserCanPublish(user) {
  if (!user) return { allowed: false, message: '用户不存在' }

  if (user.ban_status) {
    const endTime = new Date(user.ban_status.end_time)
    if (!isNaN(endTime.getTime()) && new Date() < endTime) {
      const isPermanent = endTime.getFullYear() >= 9999
      return {
        allowed: false,
        message: isPermanent
          ? '您的账号已被永久封禁，无法发布求助'
          : `您的账号已被封禁，暂时无法发布求助`
      }
    }
  }

  if ((user.credit_score ?? 100) <= 0) {
    return { allowed: false, message: '您的信誉分已扣至0分，已限制发单权限' }
  }

  return { allowed: true, message: '' }
}

// 查询微信侧订单，确认真实付款成功后才允许创建任务
async function verifyRealPayment(order) {
  if (!SUB_MCH_ID) {
    return { success: false, message: '真实支付尚未配置：请在环境变量中配置 WECHATPAY_MCH_ID' }
  }
  if (!order.out_trade_no) {
    return { success: false, message: '订单缺少支付单号，无法确认支付' }
  }

  try {
    const res = await cloud.cloudPay.queryOrder({
      outTradeNo: order.out_trade_no,
      subMchId: SUB_MCH_ID
    })

    if (res.returnCode !== 'SUCCESS' || res.resultCode !== 'SUCCESS') {
      return { success: false, message: res.returnMsg || '微信订单查询失败' }
    }

    const tradeState = res.tradeState || res.trade_state
    const totalFee = typeof res.totalFee === 'number' ? res.totalFee : res.total_fee
    const payerOpenids = [
      res.subOpenid,
      res.sub_openid,
      res.openid
    ].filter(Boolean)
    const transactionId = res.transactionId || res.transaction_id
    const payerMatchesOrder = payerOpenids.includes(order.openid)

    if (tradeState && tradeState !== 'SUCCESS') {
      return { success: false, message: `微信支付状态为 ${tradeState}` }
    }

    if (totalFee != null && Number(totalFee) !== Math.round((order.wechat_amount || 0) * 100)) {
      return { success: false, message: '微信支付金额与订单金额不一致' }
    }

    if (payerOpenids.length > 0 && !payerMatchesOrder) {
      console.warn('微信支付用户与订单用户不一致:', {
        orderId: order._id,
        outTradeNo: order.out_trade_no,
        orderOpenid: order.openid,
        payOpenid: res.openid || null,
        paySubOpenid: res.subOpenid || res.sub_openid || null
      })
      return { success: false, message: '微信支付用户与订单用户不一致' }
    }

    return {
      success: true,
      transactionId: transactionId || order.transaction_id || null
    }
  } catch (err) {
    console.error('微信订单查询失败:', err)
    return { success: false, message: '微信支付确认失败: ' + err.message }
  }
}

// 真实退款：调用微信退款API
async function createRealRefund(order, refundAmount) {
  if (!SUB_MCH_ID) {
    throw new Error('真实退款尚未配置：请在代码中填入 SUB_MCH_ID（微信支付商户号）')
  }

  if (!order.out_trade_no) {
    throw new Error('订单缺少微信支付商户订单号，无法退款')
  }

  const refundFee = Math.round(refundAmount * 100)
  const totalFee = Math.round((order.wechat_amount || 0) * 100)
  const refundNo = refundFee === totalFee
    ? 'RF' + order.out_trade_no
    : 'RF' + order.out_trade_no + 'P' + refundFee

  try {
    const res = await cloud.cloudPay.refund({
      outTradeNo: order.out_trade_no,
      outRefundNo: refundNo,
      totalFee,
      refundFee,
      subMchId: SUB_MCH_ID,
      envId: 'wdd-2grpiy1r6f9f4cf2'
    })

    if (res.returnCode !== 'SUCCESS' || res.resultCode !== 'SUCCESS') {
      throw new Error(res.returnMsg || '微信退款失败')
    }

    // 只返回退款结果，数据库统一在事务中更新
    return {
      refundId: res.refundId || null,
      outRefundNo: refundNo
    }
  } catch (err) {
    console.error('真实退款失败:', err)
    throw new Error('退款失败: ' + err.message)
  }
}
