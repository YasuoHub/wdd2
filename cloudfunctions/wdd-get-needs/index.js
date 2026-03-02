// 云函数：获取任务列表
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command
const $ = db.command.aggregate

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { action } = event

  try {
    switch (action) {
      case 'getMyNeeds':
        return await getMyNeeds(event, OPENID)
      case 'getMyTasks':
        return await getMyTasks(event, OPENID)
      case 'getNeedDetail':
        return await getNeedDetail(event, OPENID)
      default:
        return await getPublicNeeds(event, OPENID)
    }
  } catch (err) {
    console.error('获取任务失败:', err)
    return {
      code: -1,
      message: '获取失败: ' + err.message
    }
  }
}

// 获取公共任务列表（任务大厅）
async function getPublicNeeds(event, OPENID) {
  const { filter, sort, distance, page = 1, pageSize = 10, limit } = event

  // 构建查询条件
  let where = {
    status: 'pending' // 只查询待匹配的任务
  }

  // 类型筛选
  if (filter && filter !== 'all') {
    where.type = filter
  }

  // 距离筛选（如果有用户位置）
  if (distance && distance > 0) {
    // 这里简化处理，实际应该根据用户位置计算
    // where.location = ...
  }

  // 查询总数
  const countRes = await db.collection('wdd-needs').where(where).count()
  const total = countRes.total

  // 构建排序
  let orderByField = 'create_time'
  let orderByDirection = 'desc'

  switch (sort) {
    case 'points':
      orderByField = 'points'
      orderByDirection = 'desc'
      break
    case 'time':
      orderByField = 'create_time'
      orderByDirection = 'desc'
      break
  }

  // 查询数据
  let query = db.collection('wdd-needs')
    .where(where)
    .orderBy(orderByField, orderByDirection)

  // 分页或限制
  if (limit) {
    query = query.limit(limit)
  } else {
    query = query.skip((page - 1) * pageSize).limit(pageSize)
  }

  const listRes = await query.get()

  // 格式化数据
  const list = listRes.data.map(item => formatNeedItem(item))

  return {
    code: 0,
    message: '获取成功',
    data: {
      list,
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total
    }
  }
}

// 获取我的求助列表
async function getMyNeeds(event, OPENID) {
  const { status, page = 1, pageSize = 10 } = event

  // 获取当前用户
  const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
  if (userRes.data.length === 0) {
    return { code: -1, message: '用户不存在' }
  }

  const userId = userRes.data[0]._id

  // 构建查询条件
  let where = {
    user_id: userId
  }

  // 状态筛选
  if (status && status.length > 0) {
    where.status = _.in(status)
  }

  // 查询总数
  const countRes = await db.collection('wdd-needs').where(where).count()
  const total = countRes.total

  // 查询数据
  const listRes = await db.collection('wdd-needs')
    .where(where)
    .orderBy('create_time', 'desc')
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get()

  // 格式化数据
  const list = listRes.data.map(item => formatNeedItem(item))

  return {
    code: 0,
    message: '获取成功',
    data: {
      list,
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total
    }
  }
}

// 获取我的接单列表
async function getMyTasks(event, OPENID) {
  const { status, page = 1, pageSize = 10 } = event

  // 获取当前用户
  const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
  if (userRes.data.length === 0) {
    return { code: -1, message: '用户不存在' }
  }

  const userId = userRes.data[0]._id

  // 构建查询条件 - 从 need_takers 表中查询
  let takerWhere = {
    taker_id: userId
  }

  // 状态筛选
  if (status && status.length > 0) {
    takerWhere.status = _.in(status)
  }

  // 查询接单记录
  const takerRes = await db.collection('wdd-need-takers')
    .where(takerWhere)
    .orderBy('create_time', 'desc')
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get()

  // 获取关联的任务详情
  const tasks = await Promise.all(takerRes.data.map(async (taker) => {
    const needRes = await db.collection('wdd-needs').doc(taker.need_id).get()
    const need = needRes.data

    if (!need) return null

    return {
      ...taker,
      need_id: taker.need_id,
      type: need.type,
      type_name: need.type_name,
      description: need.description,
      location: need.location,
      points: need.points,
      status: taker.status,
      expire_time: need.expire_time,
      create_time: taker.create_time,
      seeker_nickname: need.user_nickname,
      seeker_avatar: need.user_avatar
    }
  }))

  // 过滤null值
  const list = tasks.filter(item => item !== null).map(item => formatNeedItem(item))

  // 统计信息
  const totalRes = await db.collection('wdd-need-takers').where({
    taker_id: userId
  }).count()

  const ongoingRes = await db.collection('wdd-need-takers').where({
    taker_id: userId,
    status: 'ongoing'
  }).count()

  const completedRes = await db.collection('wdd-need-takers').where({
    taker_id: userId,
    status: 'completed'
  }).get()

  const totalPoints = completedRes.data.reduce((sum, item) => sum + (item.points || 0), 0)

  return {
    code: 0,
    message: '获取成功',
    data: {
      list,
      stats: {
        total: totalRes.total,
        ongoing: ongoingRes.total,
        points: totalPoints
      },
      page,
      pageSize,
      hasMore: list.length === pageSize
    }
  }
}

// 获取任务详情
async function getNeedDetail(event, OPENID) {
  const { needId } = event

  if (!needId) {
    return { code: -1, message: '任务ID不能为空' }
  }

  try {
    // 获取任务详情
    const needRes = await db.collection('wdd-needs').doc(needId).get()
    const need = needRes.data

    if (!need) {
      return { code: -1, message: '任务不存在' }
    }

    // 格式化任务数据
    const formattedNeed = formatNeedItem(need)

    // 补充完整字段
    const detail = {
      ...formattedNeed,
      user_id: need.user_id,
      user_nickname: need.user_nickname,
      user_avatar: need.user_avatar,
      taker_id: need.taker_id,
      taker_nickname: need.taker_nickname,
      taker_avatar: need.taker_avatar,
      match_time: need.match_time,
      complete_time: need.complete_time,
      cancel_time: need.cancel_time,
      expire_time: need.expire_time,
      create_time: need.create_time,
      update_time: need.update_time
    }

    // 格式化时间字段
    if (need.match_time) {
      detail.matchTime = formatDateTime(need.match_time)
    }
    if (need.complete_time) {
      detail.completeTime = formatDateTime(need.complete_time)
    }
    if (need.cancel_time) {
      detail.cancelTime = formatDateTime(need.cancel_time)
    }

    return {
      code: 0,
      message: '获取成功',
      data: detail
    }
  } catch (err) {
    console.error('获取任务详情失败:', err)
    return { code: -1, message: '获取失败: ' + err.message }
  }
}

// 格式化日期时间
function formatDateTime(date) {
  const d = new Date(date)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}`
}

// 格式化任务项
function formatNeedItem(item) {
  // 计算剩余时间
  let remainTime = ''
  if (item.expire_time && (item.status === 'pending' || item.status === 'ongoing')) {
    const expireTime = new Date(item.expire_time)
    const now = new Date()
    const remainMinutes = Math.ceil((expireTime - now) / (1000 * 60))

    if (remainMinutes <= 0) {
      remainTime = '即将过期'
    } else if (remainMinutes < 60) {
      remainTime = `${remainMinutes}分钟`
    } else {
      remainTime = `${Math.floor(remainMinutes / 60)}小时${remainMinutes % 60}分钟`
    }
  }

  // 格式化距离（示例）
  const distance = Math.floor(Math.random() * 5000) + 100

  return {
    _id: item._id,
    need_id: item.need_id || item._id,
    type: item.type,
    typeName: item.type_name || getTypeName(item.type),
    typeIcon: getTypeIcon(item.type),
    bgColor: getTypeBgColor(item.type),
    color: getTypeColor(item.type),
    description: item.description,
    location: item.location,
    locationName: item.location?.name || '未知位置',
    points: item.points,
    status: item.status,
    distance: distance,
    remainTime: remainTime,
    userNickname: item.user_nickname || item.seeker_nickname,
    user_avatar: item.user_avatar || item.seeker_avatar,
    seekerNickname: item.seeker_nickname,
    seekerAvatar: item.seeker_avatar,
    takerNickname: item.taker_nickname,
    taker_avatar: item.taker_avatar,
    expireTime: item.expire_time,
    createTime: formatTime(item.create_time),
    hasRated: item.has_rated || false
  }
}

// 获取类型名称
function getTypeName(type) {
  const names = {
    weather: '实时天气',
    traffic: '道路拥堵',
    shop: '店铺营业',
    parking: '停车场空位',
    queue: '排队情况',
    other: '其他'
  }
  return names[type] || '其他'
}

// 获取类型图标
function getTypeIcon(type) {
  const icons = {
    weather: '🌤️',
    traffic: '🚗',
    shop: '🏪',
    parking: '🅿️',
    queue: '👥',
    other: '💬'
  }
  return icons[type] || '💬'
}

// 获取类型背景色
function getTypeBgColor(type) {
  const colors = {
    weather: 'rgba(116, 185, 255, 0.15)',
    traffic: 'rgba(253, 203, 110, 0.15)',
    shop: 'rgba(162, 155, 254, 0.15)',
    parking: 'rgba(129, 236, 236, 0.15)',
    queue: 'rgba(253, 121, 168, 0.15)',
    other: 'rgba(168, 230, 207, 0.15)'
  }
  return colors[type] || 'rgba(168, 230, 207, 0.15)'
}

// 获取类型主色
function getTypeColor(type) {
  const colors = {
    weather: '#74B9FF',
    traffic: '#FDCB6E',
    shop: '#A29BFE',
    parking: '#00CEC9',
    queue: '#FD79A8',
    other: '#A8E6CF'
  }
  return colors[type] || '#A8E6CF'
}

// 格式化时间
function formatTime(date) {
  const now = new Date()
  const time = new Date(date)
  const diff = now - time
  const minutes = Math.floor(diff / (1000 * 60))

  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}小时前`
  return `${Math.floor(minutes / 1440)}天前`
}
