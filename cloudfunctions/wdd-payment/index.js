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

// 金额格式化（最多2位小数，尾随零省略）
function formatAmount(n) {
  const num = Math.round(Number(n) * 100) / 100
  if (num % 1 === 0) return String(num)
  if (num * 10 % 1 === 0) return num.toFixed(1)
  return num.toFixed(2)
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
  const isInternalCall = !wxContext.OPENID && ['refundOrder', 'retryRefund'].includes(action)

  if (!OPENID && !isInternalCall) {
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
      case 'payByBalance':
        return await payByBalance(event, OPENID)
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
  const userLimit = checkUserCanPublish(user)
  if (!userLimit.allowed) {
    return { code: -1, message: userLimit.message }
  }

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

  if (!MOCK_PAYMENT) {
    const preOrderRes = await db.collection('wdd-payment-orders').doc(orderId).get().catch(() => null)
    const preOrder = preOrderRes && preOrderRes.data
    if (!preOrder) {
      return { code: -1, message: '订单不存在' }
    }
    if (preOrder.openid !== OPENID) {
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
        payment_method: 'wechat',
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

// 余额支付：一步完成冻结余额 + 创建订单 + 创建任务
async function payByBalance(event, OPENID) {
  const { amount, description, metadata } = event

  if (!amount || amount <= 0) {
    return { code: -1, message: '金额必须大于0' }
  }

  const rules = await loadFromDb()
  const minAmount = rules.MIN_REWARD_AMOUNT ?? 1
  const maxAmount = rules.MAX_REWARD_AMOUNT || 500

  if (amount < minAmount) {
    return { code: -1, message: `悬赏金额最低¥${minAmount}` }
  }
  if (amount > maxAmount) {
    return { code: -1, message: `悬赏金额最高¥${maxAmount}` }
  }

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
  const availableBalance = (user.balance || 0) - (user.frozen_balance || 0)

  if (availableBalance < amount) {
    return { code: -1, message: `可用余额不足（当前可用 ¥${formatAmount(availableBalance)}）` }
  }

  // location 强校验
  const loc = (metadata && metadata.location) || {}
  if (!loc || !Array.isArray(loc.coordinates) || loc.coordinates.length !== 2 ||
      typeof loc.coordinates[0] !== 'number' || typeof loc.coordinates[1] !== 'number' ||
      !loc.name || typeof loc.name !== 'string') {
    return { code: -1, message: '位置信息不完整' }
  }

  const orderId = generateOrderNo()
  const expireMinutes = (metadata && metadata.expireMinutes) || rules.DEFAULT_EXPIRE_MINUTES
  const expireTime = new Date(Date.now() + expireMinutes * 60 * 1000)

  const transaction = await db.startTransaction()

  try {
    // 事务内重新查询余额（防并发）
    const userInTx = await transaction.collection('wdd-users').doc(user._id).get()
    const currentBalance = userInTx.data.balance || 0
    const currentFrozen = userInTx.data.frozen_balance || 0
    const currentAvailable = currentBalance - currentFrozen

    if (currentAvailable < amount) {
      await transaction.rollback()
      return { code: -1, message: '可用余额不足' }
    }

    // 冻结余额：只增加 frozen_balance，balance 不动
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
        amount: 0,
        balance: currentBalance,
        frozen_balance: currentFrozen + amount,
        description: `余额支付冻结 ¥${formatAmount(amount)}：${description || '求助'}`,
        create_time: new Date()
      }
    })

    // 创建支付订单（一步到位，status=paid）
    await transaction.collection('wdd-payment-orders').add({
      data: {
        _id: orderId,
        user_id: user._id,
        openid: OPENID,
        amount: amount,
        description: description || '发布求助',
        status: 'paid',
        payment_method: 'balance',
        metadata: {
          ...(metadata || {}),
          need_id: null
        },
        out_trade_no: orderId,
        transaction_id: null,
        refund_id: null,
        refund_amount: null,
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
    const needRes = await transaction.collection('wdd-needs').add({
      data: {
        user_id: user._id,
        location: {
          type: 'Point',
          coordinates: loc.coordinates
        },
        location_name: loc.name,
        type: (metadata && metadata.type) || '',
        type_name: (metadata && metadata.typeName) || '',
        description: (metadata && metadata.description) || '',
        images: (metadata && metadata.images) || [],
        points: 0,
        reward_amount: amount,
        platform_fee: 0,
        taker_income: 0,
        status: 'pending',
        payment_status: 'paid',
        payment_method: 'balance',
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
        content: `您发布的"${(metadata && metadata.typeName) || '求助'}"已上线，悬赏金额¥${amount}（余额支付），正在为您匹配附近帮助者...`,
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
        orderId: orderId,
        amount: amount
      }
    }
  } catch (err) {
    await transaction.rollback()
    console.error('余额支付事务失败:', err)
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

// 余额支付退款：直接解冻退回余额（无需调用微信 API）
async function refundByBalance(order, options = {}) {
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

    // 只允许从 paid 状态发起退款（余额支付不存在 refund_pending）
    if (orderInTx.status !== 'paid') {
      await transaction.rollback()
      return { code: -1, message: '订单状态不允许退款', status: 'failed' }
    }

    const requestedRefundAmount = Number(options.refundAmount || orderInTx.refund_amount || orderInTx.amount)
    if (!Number.isFinite(requestedRefundAmount) || requestedRefundAmount <= 0) {
      await transaction.rollback()
      return { code: -1, message: '退款金额必须大于0', status: 'failed' }
    }
    if (requestedRefundAmount > orderInTx.amount) {
      await transaction.rollback()
      return { code: -1, message: '退款金额不能超过订单金额', status: 'failed' }
    }
    const refundAmount = Math.round(requestedRefundAmount * 100) / 100
    const isFullRefund = Math.round(refundAmount * 100) >= Math.round(orderInTx.amount * 100)
    const refundReason = options.refundReason || orderInTx.refund_reason || '任务取消'

    // 获取用户信息
    const userRes = await transaction.collection('wdd-users').where({
      openid: orderInTx.openid
    }).get()
    if (userRes.data.length === 0) {
      await transaction.rollback()
      return { code: -1, message: '用户不存在', status: 'failed' }
    }
    const user = userRes.data[0]
    const currentFrozen = user.frozen_balance || 0
    if (currentFrozen < refundAmount) {
      await transaction.rollback()
      return { code: -1, message: '冻结金额不足，无法退款', status: 'failed' }
    }

    // 解冻退回（balance 在支付时未扣，无需恢复）
    await transaction.collection('wdd-users').doc(user._id).update({
      data: {
        frozen_balance: _.inc(-refundAmount),
        update_time: new Date()
      }
    })

    // 写入退款流水
    const latestUser = await transaction.collection('wdd-users').doc(user._id).get()
    await transaction.collection('wdd-balance-records').add({
      data: {
        user_id: user._id,
        type: 'refund',
        amount: refundAmount,
        balance: latestUser.data.balance || 0,
        frozen_balance: latestUser.data.frozen_balance || 0,
        description: isFullRefund ? '任务取消，余额退回' : '任务部分退款，余额解冻',
        create_time: new Date()
      }
    })

    // 更新订单状态
    await transaction.collection('wdd-payment-orders').doc(order._id).update({
      data: {
        status: isFullRefund ? 'refunded' : 'partially_refunded',
        refund_time: new Date(),
        refund_amount: refundAmount,
        refund_reason: refundReason,
        update_time: new Date()
      }
    })

    await transaction.commit()

    return {
      code: 0,
      message: '退款成功',
      status: isFullRefund ? 'refunded' : 'partially_refunded',
      data: {
        orderId: order._id,
        refundAmount: refundAmount
      }
    }
  } catch (err) {
    await transaction.rollback()
    console.error('余额退款事务失败:', err)
    return { code: -1, message: '退款失败: ' + err.message, status: 'failed' }
  }
}

// 退款核心逻辑（refundOrder 和 retryRefund 共用）
// 行为：
//   - 余额支付订单 → 直接解冻退回余额
//   - 微信支付订单 → 调用微信退款 API
//   - 微信退款 API 成功 → 订单转 refunded / partially_refunded，扣减 total_paid
//   - 微信退款 API 失败 → 订单转 refund_pending，记录失败次数和下次重试时间（不报错给上游）
//   - refund_attempts 达到 MAX_REFUND_ATTEMPTS → 转 refund_failed，需人工介入
async function executeRefund(order, options = {}) {
  const requestedRefundAmount = Number(options.refundAmount || order.refund_amount || order.amount)
  if (!Number.isFinite(requestedRefundAmount) || requestedRefundAmount <= 0) {
    return { code: -1, message: '退款金额必须大于0', status: 'failed' }
  }
  if (requestedRefundAmount > order.amount) {
    return { code: -1, message: '退款金额不能超过订单金额', status: 'failed' }
  }
  const refundAmount = Math.round(requestedRefundAmount * 100) / 100
  const refundReason = options.refundReason || order.refund_reason || '任务取消'

  // 余额支付：直接解冻退回，不走微信退款 API
  if (order.payment_method === 'balance') {
    return await refundByBalance(order, { refundAmount, refundReason })
  }

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
      refundResult = await createRealRefund(order, refundAmount)
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
            refund_amount: refundAmount,
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
          refund_amount: refundAmount,
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

    // 退款成功（或 mock 模式）：全额退款转 refunded，部分退款转 partially_refunded
    const isFullRefund = Math.round(refundAmount * 100) >= Math.round(orderInTx.amount * 100)
    const orderUpdateData = {
      status: isFullRefund ? 'refunded' : 'partially_refunded',
      refund_time: new Date(),
      refund_amount: refundAmount,
      refund_reason: refundReason,
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
          total_paid: _.inc(-refundAmount),
          update_time: new Date()
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
        refundAmount: refundAmount
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
    const payerOpenid = res.openid
    const transactionId = res.transactionId || res.transaction_id

    if (tradeState && tradeState !== 'SUCCESS') {
      return { success: false, message: `微信支付状态为 ${tradeState}` }
    }

    if (totalFee != null && Number(totalFee) !== Math.round(order.amount * 100)) {
      return { success: false, message: '微信支付金额与订单金额不一致' }
    }

    if (payerOpenid && payerOpenid !== order.openid) {
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
  const totalFee = Math.round(order.amount * 100)
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
      refundId: res.refundId || null
    }
  } catch (err) {
    console.error('真实退款失败:', err)
    throw new Error('退款失败: ' + err.message)
  }
}
