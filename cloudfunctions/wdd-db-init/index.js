// 数据库初始化云函数
// 用于初始化金额账本相关字段和集合
// 只需执行一次，或在新增字段时执行

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  try {
    const results = []

    // 1. 确保新集合存在（云数据库会自动创建，这里只是记录）
    // wdd-payment-orders: 支付订单
    // wdd-settlement-records: 结算记录
    // wdd-withdraw-records: 提现记录

    // 2. 为用户表新增金额字段（如果字段不存在则设置默认值）
    const userUpdateRes = await db.collection('wdd-users').where({
      balance: db.command.exists(false)
    }).update({
      data: {
        balance: 0,           // 平台余额（元）
        frozen_balance: 0,    // 冻结金额（元）
        total_earned: 0,      // 累计收入（元）
        total_withdrawn: 0,   // 累计提现（元）
        total_paid: 0,        // 累计支付（元）
        update_time: db.serverDate()
      }
    })
    results.push({ step: '用户表金额字段初始化', updated: userUpdateRes.stats.updated || 0 })

    // 3. 为任务表新增金额字段
    const needUpdateRes = await db.collection('wdd-needs').where({
      reward_amount: db.command.exists(false)
    }).update({
      data: {
        reward_amount: db.command.set(0),  // 悬赏金额（元）
        payment_status: 'none',             // 支付状态: none/pending/paid/refunded
        payment_order_id: null,             // 关联支付订单ID
        platform_fee: 0,                    // 平台服务费（元）
        taker_income: 0,                    // 帮助者到账金额（元）
        update_time: db.serverDate()
      }
    })
    results.push({ step: '任务表金额字段初始化', updated: needUpdateRes.stats.updated || 0 })

    // 4. 将现有任务的 points 字段迁移到 reward_amount（10积分=1元）
    // 云开发不支持 update 中使用聚合表达式，改为循环处理
    const migrateQuery = await db.collection('wdd-needs').where({
      points: db.command.exists(true),
      reward_amount: 0
    }).get()

    let migratedCount = 0
    for (const need of migrateQuery.data) {
      if (need.points > 0) {
        await db.collection('wdd-needs').doc(need._id).update({
          data: {
            reward_amount: need.points / 10,
            update_time: db.serverDate()
          }
        })
        migratedCount++
      }
    }
    results.push({ step: '积分字段迁移为金额', updated: migratedCount })

    return {
      code: 0,
      message: '数据库初始化完成',
      data: { results }
    }

  } catch (err) {
    console.error('数据库初始化失败:', err)
    return {
      code: -1,
      message: '初始化失败: ' + err.message
    }
  }
}
