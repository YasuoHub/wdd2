const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const MEDIA_CHECK_CALLBACK_COLLECTION = 'wdd-media-check-callbacks'
const CALLBACK_TOKEN_ENV = 'WDD_MSG_CALLBACK_TOKEN'

function httpResponse(statusCode, body, contentType = 'text/plain; charset=utf-8') {
  return {
    statusCode,
    headers: { 'Content-Type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  }
}

function getCallbackToken() {
  const token = process.env[CALLBACK_TOKEN_ENV]
  if (!token) {
    throw new Error(`缺少云函数环境变量 ${CALLBACK_TOKEN_ENV}`)
  }
  return token
}

function getHttpMethod(event) {
  return String(
    event.httpMethod ||
    event.method ||
    event.requestContext?.httpMethod ||
    event.requestContext?.http?.method ||
    ''
  ).toUpperCase()
}

function getHttpQuery(event) {
  return event.queryStringParameters || event.query || event.queryString || {}
}

function verifyWechatSignature(query) {
  const token = getCallbackToken()
  const { signature, timestamp, nonce } = query
  if (!signature || !timestamp || !nonce) {
    throw new Error('消息推送请求缺少 signature/timestamp/nonce')
  }
  const digest = [token, timestamp, nonce]
    .sort()
    .join('')
  const expected = crypto.createHash('sha1').update(digest).digest('hex')
  if (expected !== signature) {
    throw new Error('消息推送签名校验失败')
  }
}

function parseHttpBody(event) {
  if (event.body && typeof event.body === 'object') return event.body
  const rawBody = event.isBase64Encoded
    ? Buffer.from(String(event.body || ''), 'base64').toString('utf8')
    : String(event.body || '')
  if (!rawBody.trim()) throw new Error('消息推送 POST body 为空')
  return JSON.parse(rawBody)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function maskMediaUrl(url) {
  const text = String(url || '')
  if (text.length <= 80) return text
  return `${text.slice(0, 44)}...${text.slice(-24)}`
}

async function savePendingCallback(traceId, callback, suggest) {
  const collection = db.collection(MEDIA_CHECK_CALLBACK_COLLECTION)
  const existingRes = await collection.where({ trace_id: traceId }).limit(1).get()
  const data = {
    trace_id: traceId,
    suggest: suggest.suggest,
    audit_error: suggest.auditError || null,
    callback,
    processed: false,
    update_time: new Date()
  }

  if (existingRes.data.length > 0) {
    await collection.doc(existingRes.data[0]._id).update({ data })
    return
  }

  await collection.add({
    data: {
      ...data,
      create_time: new Date()
    }
  })
}

async function markPendingCallbackProcessed(traceId, messageId) {
  const callbackRes = await db.collection(MEDIA_CHECK_CALLBACK_COLLECTION).where({
    trace_id: traceId,
    processed: false
  }).limit(1).get()

  if (callbackRes.data.length === 0) return

  await db.collection(MEDIA_CHECK_CALLBACK_COLLECTION).doc(callbackRes.data[0]._id).update({
    data: {
      processed: true,
      message_id: messageId,
      processed_at: new Date(),
      update_time: new Date()
    }
  })
}

function parseMediaCheckCallback(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error(`媒体审核回调格式错误：event 必须是对象，实际为 ${typeof event}`)
  }
  if (event.Event !== 'wxa_media_check') {
    throw new Error(`媒体审核回调事件类型错误：Event=${event.Event || ''}`)
  }
  if (!event.trace_id) {
    throw new Error('媒体审核回调缺少 trace_id')
  }
  if (event.errcode && Number(event.errcode) !== 0) {
    return {
      callback: event,
      traceId: event.trace_id,
      suggest: 'error',
      auditError: {
        errcode: Number(event.errcode),
        errmsg: event.errmsg || ''
      },
      label: '',
      detail: []
    }
  }
  if (!Array.isArray(event.detail) || event.detail.length === 0) {
    throw new Error('媒体审核回调缺少 detail 数组')
  }

  const primaryDetail = event.detail[0]
  if (!primaryDetail || typeof primaryDetail !== 'object') {
    throw new Error('媒体审核回调 detail[0] 格式错误')
  }
  if (!['pass', 'review', 'risky'].includes(primaryDetail.suggest)) {
    throw new Error(`媒体审核回调 suggest 非法：${primaryDetail.suggest || ''}`)
  }

  return {
    callback: event,
    traceId: event.trace_id,
    suggest: primaryDetail.suggest,
    auditError: null,
    label: primaryDetail.label || '',
    detail: event.detail
  }
}

async function applyCallbackToMessage(msg, auditResult) {
  const { suggest, auditError = null } = auditResult

  if (suggest === 'pass') {
    await db.collection('wdd-messages').doc(msg._id).update({
      data: {
        status: 'normal',
        is_read: false,
        approved_at: new Date(),
        // 以实际送达时间参与排序和增量轮询，避免审核期间的新消息把它越过去。
        create_time: new Date()
      }
    })

    // 审核通过才更新会话的最后消息时间，接收者此时才收到新消息。
    const takerRes = await db.collection('wdd-need-takers').where({
      need_id: msg.need_id
    }).orderBy('create_time', 'desc').limit(1).get()
    if (takerRes.data.length > 0) {
      await db.collection('wdd-need-takers').doc(takerRes.data[0]._id).update({
        data: { last_message_time: new Date() }
      })
    }
    return { code: 0, message: '审核通过，消息已送达' }
  }

  // 非明确通过（包括 risky/review）和审核服务错误均不得送达接收者。
  await db.collection('wdd-messages').doc(msg._id).update({
    data: {
      status: 'violated',
      is_read: true,
      violated_at: new Date(),
      audit_error: auditError,
      create_time: new Date()
    }
  })

  // 给发送者发系统通知
  await db.collection('wdd-notifications').add({
    data: {
      user_id: msg.sender_id,
      type: 'system',
      title: '内容未通过审核',
      content: auditError
        ? `您发送的媒体消息审核失败：${auditError.errmsg || auditError.errcode}，可在聊天中点击红色感叹号重新提交。`
        : '您发送的媒体消息未通过安全审核，可在聊天中点击红色感叹号重新提交。',
      is_read: false,
      create_time: new Date()
    }
  })

  return { code: 0, message: '未通过审核，消息已拦截' }
}

async function handleMediaCheckCallback(payload) {
  const { callback, traceId, suggest, auditError, label, detail } = parseMediaCheckCallback(payload)

  console.log('收到媒体审核回调:', {
    traceId,
    suggest,
    auditError,
    label,
    detail
  })

  // 只处理当前 trace_id 且仍处于待审核状态的消息；重试后的旧回调不会覆盖新结果。
  const msgRes = await db.collection('wdd-messages').where({
    check_trace_id: traceId,
    status: 'pending'
  }).get()

  if (msgRes.data.length === 0) {
    const existingMsgRes = await db.collection('wdd-messages').where({
      check_trace_id: traceId
    }).limit(1).get()

    if (existingMsgRes.data.length > 0) {
      console.log('媒体审核回调对应消息已处理，忽略重复回调:', {
        traceId,
        messageId: existingMsgRes.data[0]._id,
        status: existingMsgRes.data[0].status
      })
      await markPendingCallbackProcessed(traceId, existingMsgRes.data[0]._id)
      return { code: 0, message: '消息已处理，忽略重复回调' }
    }

    console.warn('媒体审核回调暂未匹配到消息，准备暂存并延迟重查:', { traceId })
    await savePendingCallback(traceId, callback, { suggest, auditError })

    await sleep(800)
    const retryMsgRes = await db.collection('wdd-messages').where({
      check_trace_id: traceId,
      status: 'pending'
    }).get()

    if (retryMsgRes.data.length === 0) {
      const retryExistingMsgRes = await db.collection('wdd-messages').where({
        check_trace_id: traceId
      }).limit(1).get()

      if (retryExistingMsgRes.data.length > 0) {
        console.log('媒体审核回调延迟重查发现消息已处理:', {
          traceId,
          messageId: retryExistingMsgRes.data[0]._id,
          status: retryExistingMsgRes.data[0].status
        })
        await markPendingCallbackProcessed(traceId, retryExistingMsgRes.data[0]._id)
        return { code: 0, message: '消息已处理，忽略重复回调' }
      }

      return { code: 0, message: '消息尚未写入，已暂存审核回调' }
    }

    const retryMsg = retryMsgRes.data[0]
    console.log('媒体审核回调延迟重查匹配消息:', {
      traceId,
      messageId: retryMsg._id,
      messageType: retryMsg.type,
      checkMediaUrlKind: retryMsg.check_media_url_kind || '',
      submittedMediaUrl: maskMediaUrl(retryMsg.check_submitted_media_url || '')
    })
    const result = await applyCallbackToMessage(retryMsg, { suggest, auditError })
    await markPendingCallbackProcessed(traceId, retryMsg._id)
    return result
  }

  const msg = msgRes.data[0]
  console.log('媒体审核回调匹配消息:', {
    traceId,
    messageId: msg._id,
    messageType: msg.type,
    checkMediaUrlKind: msg.check_media_url_kind || '',
    submittedMediaUrl: maskMediaUrl(msg.check_submitted_media_url || '')
  })
  return await applyCallbackToMessage(msg, { suggest, auditError })
}

async function handleHttpRequest(event) {
  const method = getHttpMethod(event)
  const query = getHttpQuery(event)

  try {
    verifyWechatSignature(query)

    if (method === 'GET') {
      if (!query.echostr) throw new Error('消息推送 URL 验证缺少 echostr')
      return httpResponse(200, query.echostr)
    }

    if (method !== 'POST') {
      return httpResponse(405, 'method not allowed')
    }

    if (query.encrypt_type && query.encrypt_type !== 'raw') {
      throw new Error(`当前仅支持明文 JSON 消息推送，收到 encrypt_type=${query.encrypt_type}`)
    }

    const payload = parseHttpBody(event)
    await handleMediaCheckCallback(payload)
    return httpResponse(200, 'success')
  } catch (err) {
    console.error('媒体审核 HTTP 回调处理失败:', {
      message: err.message,
      method,
      query,
      body: event.body
    })
    return httpResponse(500, err.message)
  }
}

exports.main = async (event) => {
  if (getHttpMethod(event)) {
    return await handleHttpRequest(event)
  }

  try {
    return await handleMediaCheckCallback(event)
  } catch (err) {
    console.error('媒体审核回调处理失败:', {
      message: err.message,
      event
    })
    return { code: -1, message: err.message }
  }
}
