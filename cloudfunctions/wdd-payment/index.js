// 支付云函数 - 处理微信支付相关逻辑

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

  if (!OPENID) {
    return { code: -1, message: '获取用户openid失败' }
  }

  try {
    switch (action) {
      case 'createOrder':
        return await createOrder(event, OPENID)
      case 'confirmPayment':
        return await confirmPayment(event, OPENID)
      case 'queryOrder':
        return await queryOrder(event, OPENID)
      case 'refundOrder':
        return await refundOrder(event, OPENID)
      case 'retryRefund':
        return await retryRefund(event, OPENID)
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
  const { amount, description, metadata } = event

  const rules = await loadFromDb()

  // 参数校验
  if (!amount || amount <= 0) {
    return { code: -1, message: '支付金额必须大于0' }
  }
  if (amount < rules.MIN_REWARD_AMOUNT || amount > rules.MAX_REWARD_AMOUNT) {
    return { code: -1, message: `支付金额必须在${rules.MIN_REWARD_AMOUNT}-${rules.MAX_REWARD_AMOUNT}元之间` }
  }

  // 获取用户信息
  const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
  if (userRes.data.length === 0) {
    return { code: -1, message: '用户不存在' }
  }
  const user = userRes.data[0]

  // 生成订单号
  const orderId = generateOrderNo()
  const now = new Date()
  const expireTime = new Date(now.getTime() + 30 * 60 * 1000) // 30分钟过期

  // 创建支付订单记录
  await db.collection('wdd-payment-orders').add({
    data: {
      _id: orderId,
      user_id: user._id,
      openid: OPENID,
      amount: amount,
      description: description || '发布求助',
      status: 'pending', // pending: 待支付, paid: 已支付, cancelled: 已取消, refunded: 已退款
      metadata: metadata || {},
      create_time: now,
      expire_time: expireTime,
      update_time: now,
      // 真实支付字段（预留）
      out_trade_no: orderId,
      transaction_id: null,
      refund_id: null
    }
  })

  let paymentData

  if (MOCK_PAYMENT) {
    // 模拟支付：返回模拟的支付参数
    paymentData = generateMockPayment(orderId)
  } else {
    // 真实支付：调用微信支付统一下单API
    const realPayRes = await createRealPayment(orderId, amount, description, OPENID)
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

  return {
    code: 0,
    message: '订单创建成功',
    data: {
      orderId: orderId,
      payment: paymentData,
      expireTime: expireTime,
      amount: amount
    }
  }
}

// 确认支付（支付成功后调用）
async function confirmPayment(event, OPENID) {
  const { orderId } = event

  if (!orderId) {
    return { code: -1, message: '订单ID不能为空' }
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
    const metadata = orderInTx.metadata || {}
    if (orderInTx.openid !== OPENID) {
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
    if (new Date() > orderInTx.expire_time) {
      await transaction.collection('wdd-payment-orders').doc(orderId).update({
        data: { status: 'cancelled', update_time: new Date() }
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
    const expireMinutes = metadata.expireMinutes || rules.DEFAULT_EXPIRE_MINUTES
    const expireTime = new Date(Date.now() + expireMinutes * 60 * 1000)

    // location 强校验：缺少经纬度或名称直接拒绝
    const loc = metadata.location
    if (!loc || !Array.isArray(loc.coordinates) || loc.coordinates.length !== 2 ||
        typeof loc.coordinates[0] !== 'number' || typeof loc.coordinates[1] !== 'number' ||
        !loc.name || typeof loc.name !== 'string') {
      throw new Error('LOCATION_REQUIRED')
    }

    // 3. 创建任务
    const needRes = await transaction.collection('wdd-needs').add({
      data: {
        user_id: user._id,
        location: {
          type: 'Point',
          coordinates: loc.coordinates
        },
        location_name: loc.name,
        type: metadata.type,
        type_name: metadata.typeName,
        description: metadata.description || '',
        images: metadata.images || [],
        points: 0, // 积分字段保留但设为0
        reward_amount: orderInTx.amount, // 悬赏金额（元）
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
        total_paid: _.inc(orderInTx.amount),
        update_time: new Date()
      }
    })

    // 6. 创建系统通知
    await transaction.collection('wdd-notifications').add({
      data: {
        user_id: user._id,
        type: 'system',
        title: '求助发布成功',
        content: `您发布的"${metadata.typeName || '求助'}"已上线，悬赏金额¥${orderInTx.amount}，正在为您匹配附近帮助者...`,
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
        orderId: orderId,
        amount: orderInTx.amount
      }
    }

  } catch (err) {
    await transaction.rollback()
    console.error('确认支付事务失败:', err)
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
  if (order.openid !== OPENID) {
    return { code: -1, message: '无权查看此订单' }
  }

  return {
    code: 0,
    message: '查询成功',
    data: {
      orderId: order._id,
      status: order.status,
      amount: order.amount,
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

  // 云函数间调用需从 event 读取 openid；前端直接调用使用 wxContext 的 OPENID
  const callerOpenid = event.openid || OPENID

  let order

  if (orderId) {
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

  return await executeRefund(order)
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

// 退款核心逻辑（refundOrder 和 retryRefund 共用）
// 行为：
//   - 微信退款 API 成功 → 订单转 refunded，扣减 total_paid
//   - 微信退款 API 失败 → 订单转 refund_pending，记录失败次数和下次重试时间（不报错给上游）
//   - refund_attempts 达到 MAX_REFUND_ATTEMPTS → 转 refund_failed，需人工介入
async function executeRefund(order) {
  const MAX_REFUND_ATTEMPTS = 5
  // 指数退避：第1/2/3/4/5次失败后，分别 5/10/20/40/80 分钟后重试
  const BACKOFF_MINUTES = [5, 10, 20, 40, 80]

  let refundResult = null
  let refundError = null

  // 1. 调用微信退款 API（在事务外，只调 API 不操作数据库）
  if (!MOCK_PAYMENT) {
    if (!order.out_trade_no) {
      return { code: -1, message: '订单缺少支付单号，无法退款', status: 'failed' }
    }
    try {
      refundResult = await createRealRefund(order)
    } catch (err) {
      refundError = err
      console.error('微信退款失败:', err)
    }
  }

  // 2. 开启事务更新订单状态
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
        data: { orderId: order._id, refundAmount: orderInTx.refund_amount || orderInTx.amount }
      }
    }

    // 只允许从 paid / refund_pending 状态发起退款
    if (orderInTx.status !== 'paid' && orderInTx.status !== 'refund_pending') {
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

    // 退款成功（或 mock 模式）：转 refunded 并扣减 total_paid
    const orderUpdateData = {
      status: 'refunded',
      refund_time: new Date(),
      refund_amount: orderInTx.amount,
      refund_reason: orderInTx.refund_reason || '任务取消',
      update_time: new Date()
    }
    if (refundResult && refundResult.refundId) {
      orderUpdateData.refund_id = refundResult.refundId
    }

    await transaction.collection('wdd-payment-orders').doc(order._id).update({
      data: orderUpdateData
    })

    // 扣减用户累计支付金额（只在最终成功时扣，避免 pending 状态重复扣）
    const userRes = await transaction.collection('wdd-users').where({
      openid: orderInTx.openid
    }).get()
    if (userRes.data.length > 0) {
      const user = userRes.data[0]
      await transaction.collection('wdd-users').doc(user._id).update({
        data: {
          total_paid: _.inc(-orderInTx.amount),
          update_time: new Date()
        }
      })
    }

    await transaction.commit()

    return {
      code: 0,
      message: '退款成功',
      status: 'refunded',
      data: {
        orderId: order._id,
        refundAmount: orderInTx.amount
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

// 真实退款：调用微信退款API
async function createRealRefund(order) {
  if (!SUB_MCH_ID) {
    throw new Error('真实退款尚未配置：请在代码中填入 SUB_MCH_ID（微信支付商户号）')
  }

  if (!order.out_trade_no) {
    throw new Error('订单缺少微信支付商户订单号，无法退款')
  }

  const refundNo = 'RF' + order.out_trade_no

  try {
    const res = await cloud.cloudPay.refund({
      outTradeNo: order.out_trade_no,
      outRefundNo: refundNo,
      totalFee: Math.round(order.amount * 100),
      refundFee: Math.round(order.amount * 100),
      subMchId: SUB_MCH_ID,
      envId: 'wdd-2grpiy1r6f9f4cf2'
    })

    if (res.returnCode !== 'SUCCESS' || res.resultCode !== 'SUCCESS') {
      throw new Error(res.returnMsg || '微信退款失败')
    }

    // 只返回退款结果，数据库统一在事务中更新
    return {
      refundId: res.refundId || null
    }
  } catch (err) {
    console.error('真实退款失败:', err)
    throw new Error('退款失败: ' + err.message)
  }
}
