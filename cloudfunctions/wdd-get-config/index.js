// 获取平台配置云函数
// 读取 wdd-config 集合中的平台全局配置
// 如果数据库中不存在，返回硬编码默认值

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

// 默认配置（与代码中的硬编码保持一致）
const DEFAULT_CONFIG = {
  platform_fee_rate: 0.15,
  withdraw_fee_rate: 0.01,
  withdraw_min_amount: 2,
  min_reward_amount: 0.1,
  max_reward_amount: 500
}

exports.main = async (event, context) => {
  try {
    let config = null

    try {
      const res = await db.collection('wdd-config').doc('platform').get()
      config = res.data
    } catch (dbErr) {
      // 文档不存在或其他数据库错误，使用默认值
      console.warn('wdd-config/platform 不存在，使用默认配置:', dbErr.message)
      config = null
    }

    // 合并默认值与数据库值（数据库值优先）
    const result = {
      ...DEFAULT_CONFIG,
      ...config
    }

    // 移除数据库内部字段（如 _openid 等）
    delete result._openid

    return {
      code: 0,
      data: result,
      message: 'success'
    }
  } catch (err) {
    console.error('获取平台配置失败:', err)
    return {
      code: -1,
      message: err.message,
      data: DEFAULT_CONFIG
    }
  }
}
