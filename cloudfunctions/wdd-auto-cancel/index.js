// 云函数：自动取消过期任务 + 退款重试
// 定时触发器：每5分钟执行一次

const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  console.log('开始执行自动取消任务检查:', new Date().toISOString())

  const now = new Date()
  const results = {
    cancelledNeeds: 0,
    refundedAmount: 0,
    retriedRefunds: 0,
    retriedPending: 0,
    retriedTransfers: 0,
    queriedTransfers: 0,
    errors: []
  }

  try {
    // 1. 查找已过期且状态为 pending 的任务（无人接单）
    const expiredPendingRes = await db.collection('wdd-needs')
      .where({
        status: 'pending',
        expire_time: _.lt(now)
      })
      .get()

    console.log(`找到 ${expiredPendingRes.data.length} 个过期待匹配任务`)

    // 处理过期待匹配任务
    for (const need of expiredPendingRes.data) {
      try {
        const cancelResult = await cancelPendingNeed(need)
        results.cancelledNeeds++
        if (cancelResult.refundAmount) {
          results.refundedAmount += cancelResult.refundAmount
        }
        console.log(`已取消任务: ${need._id}`)
      } catch (err) {
        console.error(`取消任务失败 ${need._id}:`, err)
        results.errors.push({ needId: need._id, error: err.message })
      }
    }

    // 2. 扫描待重试退款订单
    const pendingRefundRes = await db.collection('wdd-payment-orders')
      .where({
        status: 'refund_pending',
        next_retry_time: _.lte(now)
      })
      .get()

    console.log(`找到 ${pendingRefundRes.data.length} 个待重试退款订单`)

    for (const order of pendingRefundRes.data) {
      try {
        const { result } = await cloud.callFunction({
          name: 'wdd-payment',
          data: {
            action: 'retryRefund',
            orderId: order._id
          }
        })
        if (result.code === 0) {
          if (result.status === 'refunded') {
            results.retriedRefunds++
          } else if (result.status === 'pending') {
            results.retriedPending++
          }
        } else {
          console.error(`重试退款业务失败 ${order._id}:`, result.message)
        }
      } catch (err) {
        console.error(`重试退款调用失败 ${order._id}:`, err)
        results.errors.push({ orderId: order._id, error: err.message })
      }
    }

    // 3. 处理 ongoing 任务超时（自动完成兜底）
    const ongoingResults = await handleOngoingTimeouts(now)
    results.ongoingUrged = ongoingResults.urged
    results.ongoingAutoCompleted = ongoingResults.autoCompleted
    results.ongoingErrors = ongoingResults.errors

    // 4. 扫描待重试的提现（新版商家转账失败重试中）
    const pendingTransferRes = await db.collection('wdd-balance-records')
      .where({
        type: 'withdraw',
        status: 'transfer_pending',
        next_retry_time: _.lte(now)
      })
      .limit(20)
      .get()

    console.log(`找到 ${pendingTransferRes.data.length} 条待重试提现`)

    for (const record of pendingTransferRes.data) {
      try {
        const { result } = await cloud.callFunction({
          name: 'wdd-withdraw',
          data: {
            action: 'retryFailedTransfer',
            withdrawId: record._id
          }
        })
        if (result.code === 0) {
          results.retriedTransfers++
        } else {
          console.error(`重试提现业务失败 ${record._id}:`, result.message)
        }
      } catch (err) {
        console.error(`重试提现调用失败 ${record._id}:`, err)
        results.errors.push({ withdrawId: record._id, error: err.message })
      }
    }

    // 4. 扫描 processing 长时间未回调的提现（兜底查询）
    // 注：与 wdd-withdraw/platformRules.js 中 TRANSFER_QUERY_TIMEOUT_MINUTES 保持一致
    const queryTimeoutMin = 1
    const queryThreshold = new Date(now.getTime() - queryTimeoutMin * 60 * 1000)
    const stuckProcessingRes = await db.collection('wdd-balance-records')
      .where(_.and([
        { type: 'withdraw' },
        { status: 'processing' },
        { update_time: _.lte(queryThreshold) },
        _.or([
          { last_query_time: _.exists(false) },
          { last_query_time: null },
          { last_query_time: _.lte(queryThreshold) }
        ])
      ]))
      .limit(20)
      .get()

    console.log(`找到 ${stuckProcessingRes.data.length} 条长时间处理中的提现，触发查询`)

    for (const record of stuckProcessingRes.data) {
      try {
        const { result } = await cloud.callFunction({
          name: 'wdd-withdraw',
          data: {
            action: 'queryTransferStatus',
            withdrawId: record._id
          }
        })
        if (result.code === 0) {
          results.queriedTransfers++
        } else {
          console.error(`查询提现业务失败 ${record._id}:`, result.message)
        }
      } catch (err) {
        console.error(`查询提现调用失败 ${record._id}:`, err)
        results.errors.push({ withdrawId: record._id, error: err.message })
      }
    }

    console.log('自动取消任务检查完成:', results)

    return {
      code: 0,
      message: '执行成功',
      data: results
    }
  } catch (err) {
    console.error('自动取消任务执行失败:', err)
    return {
      code: -1,
      message: '执行失败: ' + err.message,
      data: results
    }
  }
}

// 取消待匹配任务
async function cancelPendingNeed(need) {
  const transaction = await db.startTransaction()
  const result = { refundAmount: 0 }

  try {
    // 1. 获取求助者信息
    const seekerRes = await transaction.collection('wdd-users').doc(need.user_id).get()
    const seeker = seekerRes.data

    // 2. 云开发事务要求先 get 再 update
    const needResTx = await transaction.collection('wdd-needs').doc(need._id).get()
    if (!needResTx.data || needResTx.data.status !== 'pending') {
      await transaction.rollback()
      throw new Error('任务不存在或状态已变更')
    }

    // 3. 更新任务状态
    await transaction.collection('wdd-needs').doc(need._id).update({
      data: {
        status: 'cancelled',
        cancel_time: new Date(),
        cancel_reason: 'expired',
        update_time: new Date()
      }
    })

    // 4. 发送系统通知（退款结果在事务外处理，避免事务内调用云函数导致不一致）
    await transaction.collection('wdd-notifications').add({
      data: {
        user_id: need.user_id,
        type: 'task_cancelled',
        title: '任务已超时取消',
        content: `您发布的「${need.type_name || '求助'}」任务已超时，如有支付将原路退回`,
        need_id: need._id,
        is_read: false,
        create_time: new Date()
      }
    })

    await transaction.commit()
  } catch (err) {
    await transaction.rollback()
    throw err
  }

  // 6. 事务提交后调用退款（避免事务内调用云函数导致不一致）
  if (need.payment_order_id) {
    try {
      // 查询订单获取 openid（定时触发器无 wxContext.OPENID）
      const orderRes = await db.collection('wdd-payment-orders').doc(need.payment_order_id).get()
      const orderOpenid = orderRes.data ? orderRes.data.openid : null

      const { result: refundRes } = await cloud.callFunction({
        name: 'wdd-payment',
        data: {
          action: 'refundOrder',
          orderId: need.payment_order_id,
          openid: orderOpenid
        }
      })
      if (refundRes.code === 0) {
        result.refundAmount = refundRes.data ? refundRes.data.refundAmount || 0 : 0
      } else {
        console.error('自动退款业务失败:', refundRes.message)
      }
    } catch (err) {
      console.error('自动退款调用失败:', err)
    }
  }

  return result
}

// ongoing 任务超时处理
// expire_time + 24h → 催办通知
// expire_time + 72h → 自动完成 + 结算给帮助者
async function handleOngoingTimeouts(now) {
  const results = { urged: 0, autoCompleted: 0, errors: [] }

  const urgeThreshold = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const autoCompleteThreshold = new Date(now.getTime() - 72 * 60 * 60 * 1000)

  try {
    // 查找 ongoing 且 expire_time 超过 24h 的任务
    const expiredOngoingRes = await db.collection('wdd-needs')
      .where({
        status: 'ongoing',
        expire_time: _.lt(urgeThreshold)
      })
      .get()

    for (const need of expiredOngoingRes.data) {
      try {
        const expiredMs = now.getTime() - new Date(need.expire_time).getTime()
        const expiredHours = expiredMs / (1000 * 60 * 60)

        if (expiredHours >= 72) {
          // 自动完成 + 结算给帮助者
          const completeResult = await autoCompleteOngoingNeed(need)
          if (completeResult.success) {
            results.autoCompleted++
          }
        } else if (expiredHours >= 24) {
          // 催办通知（幂等：通过 need._id 查是否已发送）
          const notified = await db.collection('wdd-notifications').where({
            need_id: need._id,
            type: 'ongoing_urge',
            create_time: _.gte(urgeThreshold)
          }).count()

          if (notified.total === 0) {
            await urgeTaskCompletion(need)
            results.urged++
          }
        }
      } catch (err) {
        console.error(`处理 ongoing 超时任务失败 ${need._id}:`, err)
        results.errors.push({ needId: need._id, error: err.message })
      }
    }
  } catch (err) {
    console.error('扫描 ongoing 超时任务失败:', err)
  }

  return results
}

// 双向推送催办通知
async function urgeTaskCompletion(need) {
  // 获取接单者
  const takerRes = await db.collection('wdd-need-takers')
    .where({ need_id: need._id })
    .orderBy('create_time', 'desc')
    .limit(1)
    .get()
  const taker = takerRes.data[0]

  const messages = [
    {
      user_id: need.user_id,
      type: 'ongoing_urge',
      title: '任务已超时，请尽快处理',
      content: `您的「${need.type_name || '求助'}」任务已过期超过 24 小时，请尽快确认完成或联系帮助者。`,
      need_id: need._id,
      is_read: false,
      create_time: new Date()
    }
  ]

  if (taker) {
    messages.push({
      user_id: taker.taker_id,
      type: 'ongoing_urge',
      title: '任务已超时，请尽快完成',
      content: `您承接的「${need.type_name || '求助'}」任务已过期超过 24 小时，请尽快提供信息反馈。超时 72 小时将自动完成并结算。`,
      need_id: need._id,
      is_read: false,
      create_time: new Date()
    })
  }

  await Promise.all(messages.map(msg => db.collection('wdd-notifications').add({ data: msg })))
}

// 自动完成 ongoing 任务（超时 72 小时未处理，自动结算给帮助者）
async function autoCompleteOngoingNeed(need) {
  const transaction = await db.startTransaction()
  let takerIncome = 0

  try {
    // 原子更新：仅在 status === 'ongoing' 时生效
    const needResTx = await transaction.collection('wdd-needs').doc(need._id).get()
    if (!needResTx.data || needResTx.data.status !== 'ongoing') {
      await transaction.rollback()
      return { success: false, reason: '状态已变更' }
    }
    const needInTx = needResTx.data

    // 获取接单者
    const takerRes = await transaction.collection('wdd-need-takers')
      .where({ need_id: need._id })
      .orderBy('create_time', 'desc')
      .limit(1)
      .get()
    const taker = takerRes.data[0]

    if (!taker) {
      await transaction.rollback()
      return { success: false, reason: '未找到接单记录' }
    }

    // 读取平台费率配置
    let feeRate = 0.15
    try {
      const configRes = await db.collection('wdd-config').doc('platform').get()
      feeRate = configRes.data.platform_fee_rate || 0.15
    } catch (e) {
      console.warn('wdd-config/platform 不存在，使用默认费率 15%:', e.message)
    }

    // 计算平台抽成和帮助者收入
    const rewardAmount = needInTx.reward_amount || 0
    const platformFee = Math.round(rewardAmount * feeRate * 100) / 100
    takerIncome = Math.round((rewardAmount - platformFee) * 100) / 100

    // 更新任务状态为已完成
    await transaction.collection('wdd-needs').doc(need._id).update({
      data: {
        status: 'completed',
        platform_fee: platformFee,
        taker_income: takerIncome,
        complete_time: new Date(),
        complete_type: 'auto',
        update_time: new Date()
      }
    })

    // 更新接单记录为已完成
    await transaction.collection('wdd-need-takers').doc(taker._id).update({
      data: {
        status: 'completed',
        complete_time: new Date(),
        update_time: new Date()
      }
    })

    // 帮助者余额增加
    await transaction.collection('wdd-users').doc(taker.taker_id).update({
      data: {
        balance: _.inc(takerIncome),
        total_earned: _.inc(takerIncome),
        update_time: new Date()
      }
    })

    // 重新查询帮助者最新余额
    const latestTakerRes = await transaction.collection('wdd-users').doc(taker.taker_id).get()
    const latestTakerBalance = latestTakerRes.data.balance || 0

    // 创建余额流水记录
    await transaction.collection('wdd-balance-records').add({
      data: {
        user_id: taker.taker_id,
        type: 'task_income',
        amount: takerIncome,
        balance: latestTakerBalance,
        description: `任务「${need.type_name || '求助'}」自动完成收入`,
        need_id: need._id,
        create_time: new Date()
      }
    })

    // 通知双方
    await transaction.collection('wdd-notifications').add({
      data: {
        user_id: need.user_id,
        type: 'task_auto_completed',
        title: '任务已自动完成',
        content: `您的「${need.type_name || '求助'}」任务因超时 72 小时未处理，已自动完成并结算给帮助者。`,
        need_id: need._id,
        is_read: false,
        create_time: new Date()
      }
    })

    if (taker) {
      await transaction.collection('wdd-notifications').add({
        data: {
          user_id: taker.taker_id,
          type: 'task_completed',
          title: '任务已自动完成，收入已到账',
          content: `您承接的「${need.type_name || '求助'}」任务因超时未处理，已自动完成。收入 ¥${takerIncome.toFixed(2)} 已到账。`,
          need_id: need._id,
          is_read: false,
          create_time: new Date()
        }
      })
    }

    await transaction.commit()
  } catch (err) {
    await transaction.rollback()
    throw err
  }

  return { success: true, takerIncome }
}
