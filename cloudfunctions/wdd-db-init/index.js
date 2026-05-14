// 数据库初始化云函数
// 用于初始化金额账本相关字段和集合
// 只需执行一次，或在新增字段时执行

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

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
        balance: 0,           // 余额（元）
        frozen_balance: 0,    // 冻结金额（元）
        total_earned: 0,      // 累计收入（元）
        total_withdrawn: 0,   // 累计提现（元）
        total_paid: 0,        // 累计支付（元）
        update_time: db.serverDate()
      }
    })
    results.push({ step: '用户表金额字段初始化', updated: userUpdateRes.stats.updated || 0 })

    // 2.5 为用户表新增信誉分、封禁状态、评分字段
    const userStatusRes = await db.collection('wdd-users').where({
      credit_score: db.command.exists(false)
    }).update({
      data: {
        credit_score: 100,      // 信誉分，满分100，初始100
        ban_status: null,       // 封禁状态：null=正常，对象={reason, end_time}
        rating: 5.0,            // 平均评价星级，初始5.0
        rating_count: 0,        // 评价总数，初始0
        update_time: db.serverDate()
      }
    })
    results.push({ step: '用户表信誉分/封禁/评分字段初始化', updated: userStatusRes.stats.updated || 0 })

    // 修复已被 _.inc 扣成负分的用户（字段存在但值为负数）
    const negativeCreditRes = await db.collection('wdd-users').where({
      credit_score: _.lt(0)
    }).update({
      data: {
        credit_score: 100,
        update_time: db.serverDate()
      }
    })
    results.push({ step: '修复负信誉分用户', updated: negativeCreditRes.stats.updated || 0 })

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

    // 3.5 为任务表新增举报/申诉标记字段
    const needFlagRes = await db.collection('wdd-needs').where({
      was_reported: db.command.exists(false)
    }).update({
      data: {
        was_reported: false,    // 是否曾发起过举报（含已撤销的，防止再次发起）
        was_appealed: false,    // 是否曾发起过申诉（含已撤销的，防止再次发起）
        update_time: db.serverDate()
      }
    })
    results.push({ step: '任务表举报申诉标记字段初始化', updated: needFlagRes.stats.updated || 0 })

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

    // 5. 为 wdd-reports 集合新增 supplement 相关字段（兼容旧数据）
    const reportSupplementRes = await db.collection('wdd-reports').where({
      supplement_deadline: db.command.exists(false)
    }).update({
      data: {
        supplement_id: null,
        supplement_type: null,
        supplement_reason: null,
        supplement_images: [],
        supplement_deadline: db.command.set(null),
        has_supplement: false,
        is_supplement_timeout: false,
        update_time: db.serverDate()
      }
    })
    results.push({ step: '举报表补充材料字段初始化', updated: reportSupplementRes.stats ? reportSupplementRes.stats.updated : 0 })

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
