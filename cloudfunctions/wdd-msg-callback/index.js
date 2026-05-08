const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

exports.main = async (event) => {
  // 解析回调内容（mediaCheckAsync 推送 XML/JSON）
  const callback = event

  // 微信推送的回调字段
  const result = callback.result || {}
  const suggest = result.suggest
  const traceId = callback.trace_id || callback.msg_id || ''

  if (suggest !== 'risky') {
    return { code: 0, message: '审核通过' }
  }

  // 违规处理：尝试根据 trace_id 找到消息
  // 注意：trace_id 需要在调用 mediaCheckAsync 时存入消息记录
  try {
    const msgRes = await db.collection('wdd-messages').where({
      check_trace_id: traceId
    }).get()

    if (msgRes.data.length > 0) {
      const msg = msgRes.data[0]
      // 标记消息违规
      await db.collection('wdd-messages').doc(msg._id).update({
        data: {
          status: 'violated',
          violated_at: new Date()
        }
      })

      // 给发送者发系统通知
      await db.collection('wdd-notifications').add({
        data: {
          user_id: msg.sender_id,
          type: 'system',
          title: '违规内容提醒',
          content: '您发送的消息包含违规内容，已被系统自动拦截。请遵守社区规范。',
          is_read: false,
          create_time: new Date()
        }
      })
    }

    return { code: 0, message: '已处理违规内容' }
  } catch (err) {
    console.error('回调处理失败:', err)
    return { code: -1, message: err.message }
  }
}
