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
      case 'getRatingDetail':
        return await getRatingDetail(event, OPENID)
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
  const { filter, sort, distance, page = 1, pageSize = 10, limit, userId, latitude, longitude } = event

  // 记录接收到的参数（调试用）
  console.log('接收到参数:', { latitude, longitude, filter, sort, distance })

  const now = new Date()

  // 构建查询条件
  let where = {
    status: 'pending', // 只查询待匹配的任务
    expire_time: _.gt(now) // 只查询未过期的任务
  }

  // 获取用户帮助者资料（用于个性化推荐）
  let userProfile = null
  if (OPENID) {
    try {
      const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
      if (userRes.data.length > 0) {
        userProfile = userRes.data[0]
      }
    } catch (err) {
      console.error('获取用户资料失败:', err)
    }
  }

  // 类型筛选
  if (filter && filter !== 'all') {
    where.type = filter
  }
  // 注：当filter为'all'时，不限制类型，显示所有任务

  // 查询数据（先不分页，因为需要根据距离筛选）
  let query = db.collection('wdd-needs')
    .where(where)

  const listRes = await query.get()
  let list = listRes.data
  console.log('查询到任务数:', list.length)
  if (list.length > 0) {
    console.log('第一个任务状态:', list[0].status, '过期时间:', list[0].expire_time)
  }

  // 如果有用户当前位置，计算每个任务的距离
  const userLocation = (latitude && longitude) ? { latitude, longitude } : null
  // console.log('用户位置:', userLocation)

  if (userLocation) {
    // 计算每个任务与用户当前位置的距离
    // 使用 GeoJSON 格式: coordinates: [经度, 纬度]
    list = list.map(item => {
      let dist = Infinity
      // 处理 GeoJSON 格式 - 数据库可能返回特殊对象
      let locationData = item.location
      // 如果是数据库地理位置对象，转换为普通对象
      if (locationData && typeof locationData.toJSON === 'function') {
        locationData = locationData.toJSON()
      }
      console.log('任务location:', JSON.stringify(locationData))
      if (locationData && locationData.type === 'Point' && locationData.coordinates) {
        const [taskLon, taskLat] = locationData.coordinates
        console.log('用户位置:', userLocation.latitude, userLocation.longitude)
        console.log('任务位置:', taskLat, taskLon)
        dist = calculateDistance(
          userLocation.latitude,
          userLocation.longitude,
          taskLat,
          taskLon
        )
        console.log('计算距离:', dist)
      } else {
        console.log('任务location格式不正确')
      }
      return {
        ...item,
        distance: dist
      }
    })
  } else {
    // 没有用户位置，使用常去地点计算距离（兼容旧逻辑）
    if (userProfile && userProfile.frequent_locations && userProfile.frequent_locations.length > 0) {
      list = list.map(item => {
        let minDistance = Infinity
        // 处理 GeoJSON 格式 - 数据库可能返回特殊对象
        let locationData = item.location
        if (locationData && typeof locationData.toJSON === 'function') {
          locationData = locationData.toJSON()
        }
        if (locationData && locationData.type === 'Point' && locationData.coordinates) {
          const [taskLon, taskLat] = locationData.coordinates
          for (const loc of userProfile.frequent_locations) {
            if (loc.latitude && loc.longitude) {
              const dist = calculateDistance(
                taskLat,
                taskLon,
                loc.latitude,
                loc.longitude
              )
              if (dist < minDistance) {
                minDistance = dist
              }
            }
          }
        }
        return {
          ...item,
          distance: minDistance === Infinity ? 99999999 : minDistance
        }
      })
    } else {
      // 既没有用户位置也没有常去地点，距离设为无穷大
      list = list.map(item => ({ ...item, distance: 99999999 }))
    }
  }

  // 距离筛选（无论是否有用户位置，只要传入了distance参数就进行筛选）
  // distance > 0 表示需要筛选，distance = 0 表示全部距离
  if (distance > 0) {
    console.log('执行距离筛选:', distance, '米，筛选前数量:', list.length)
    list = list.filter(item => item.distance <= distance)
    console.log('筛选后数量:', list.length)
  }

  // 排序
  switch (sort) {
    case 'distance':
      // 按距离从近到远排序
      list.sort((a, b) => a.distance - b.distance)
      break
    case 'points':
      // 按积分从高到低排序
      list.sort((a, b) => b.points - a.points)
      break
    case 'time':
    default:
      // 按时间从新到旧排序
      list.sort((a, b) => new Date(b.create_time) - new Date(a.create_time))
      break
  }

  // 计算总数
  const total = list.length

  // 分页处理（内存分页）
  const startIndex = (page - 1) * pageSize
  const endIndex = startIndex + pageSize
  const pagedList = list.slice(startIndex, endIndex)

  // 格式化数据
  const formattedList = pagedList.map(item => formatNeedItem(item, userProfile))

  return {
    code: 0,
    message: '获取成功',
    data: {
      list: formattedList,
      total,
      page,
      pageSize,
      hasMore: endIndex < total,
      // 返回用户帮助者资料状态，用于前端提示
      userProfile: userProfile ? {
        hasHelperProfile: !!userProfile.help_willingness,
        helpWillingness: userProfile.help_willingness,
        frequentLocations: userProfile.frequent_locations || [],
        helpTypes: userProfile.help_types || []
      } : null
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

  // 格式化数据，并查询评价状态
  const list = await Promise.all(listRes.data.map(async (item) => {
    console.log('getMyNeeds - 原始数据 location_name:', item.location_name, 'location:', JSON.stringify(item.location))
    const formatted = formatNeedItem(item)
    console.log('getMyNeeds - 格式化后 locationName:', formatted.locationName)

    // 如果任务已完成，查询是否已评价
    if (item.status === 'completed') {
      const ratingRes = await db.collection('wdd-ratings').where({
        need_id: item._id,
        rater_id: userId,
        rating_type: 'seeker'
      }).count()
      formatted.hasRated = ratingRes.total > 0
    }

    return formatted
  }))

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

  // 获取关联的任务详情，并查询评价状态
  const tasks = await Promise.all(takerRes.data.map(async (taker) => {
    const needRes = await db.collection('wdd-needs').doc(taker.need_id).get()
    const need = needRes.data

    if (!need) return null

    const item = {
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

    const formatted = formatNeedItem(item)

    // 如果任务已完成，查询是否已评价
    if (taker.status === 'completed') {
      const ratingRes = await db.collection('wdd-ratings').where({
        need_id: taker.need_id,
        rater_id: userId,
        rating_type: 'taker'
      }).count()
      formatted.hasRated = ratingRes.total > 0
    }

    return formatted
  }))

  // 过滤null值
  const list = tasks.filter(item => item !== null)

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

// 获取评价详情
async function getRatingDetail(event, OPENID) {
  const { needId, ratingType } = event

  if (!needId) {
    return { code: -1, message: '任务ID不能为空' }
  }

  try {
    // 获取当前用户
    const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get()
    if (userRes.data.length === 0) {
      return { code: -1, message: '用户不存在' }
    }
    const currentUserId = userRes.data[0]._id

    // 获取任务信息
    const needRes = await db.collection('wdd-needs').doc(needId).get()
    const need = needRes.data

    if (!need) {
      return { code: -1, message: '任务不存在' }
    }

    // 获取评价记录
    const ratingRes = await db.collection('wdd-ratings').where({
      need_id: needId,
      rater_id: currentUserId,
      rating_type: ratingType || 'seeker'
    }).get()

    if (ratingRes.data.length === 0) {
      return { code: -1, message: '评价记录不存在' }
    }

    const rating = ratingRes.data[0]

    // 获取评价对象信息
    const targetUserRes = await db.collection('wdd-users').doc(rating.target_id).get()
    const targetUser = targetUserRes.data || {}

    // 格式化任务信息
    const typeMap = {
      'weather': '实时天气',
      'traffic': '道路拥堵',
      'shop': '店铺营业',
      'parking': '停车场空位',
      'queue': '排队情况',
      'other': '其他'
    }

    return {
      code: 0,
      message: '获取成功',
      data: {
        rating: {
          rating: rating.rating,
          tags: rating.tags || [],
          comment: rating.comment || '',
          createTime: formatDateTime(rating.create_time)
        },
        task: {
          typeName: typeMap[need.type] || '其他',
          description: need.description,
          points: need.points
        },
        targetUser: {
          nickname: targetUser.nickname || '未知用户',
          avatar: targetUser.avatar || ''
        }
      }
    }
  } catch (err) {
    console.error('获取评价详情失败:', err)
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

// 计算两点之间的距离（米）
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000 // 地球半径（米）
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return Math.round(R * c)
}

// 根据常活动地点排序
function sortByNearestLocation(needs, frequentLocations) {
  // 为每个任务计算到最近常去地点的距离
  const needsWithDistance = needs.map(need => {
    let minDistance = Infinity

    // 使用 GeoJSON 格式: coordinates: [经度, 纬度]
    if (need.location && need.location.type === 'Point' && need.location.coordinates) {
      const [needLon, needLat] = need.location.coordinates
      for (const loc of frequentLocations) {
        if (loc.latitude && loc.longitude) {
          const dist = calculateDistance(
            needLat,
            needLon,
            loc.latitude,
            loc.longitude
          )
          if (dist < minDistance) {
            minDistance = dist
          }
        }
      }
    }

    return {
      ...need,
      nearestDistance: minDistance === Infinity ? 99999999 : minDistance
    }
  })

  // 按最近距离排序
  return needsWithDistance.sort((a, b) => a.nearestDistance - b.nearestDistance)
}

// 格式化任务项
function formatNeedItem(item, userProfile) {
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

  // 计算距离（优先使用已计算的距离）
  // 注意：要处理 0 是有效距离的情况
  let distance
  if (item.distance !== undefined && item.distance !== null && item.distance !== Infinity) {
    distance = Number(item.distance)
  } else if (item.nearestDistance !== undefined && item.nearestDistance !== null && item.nearestDistance !== Infinity) {
    distance = Number(item.nearestDistance)
  } else {
    distance = 99999999
  }

  // 如果小于1公里，显示米，否则显示公里
  let distanceText = ''
  if (distance < 1000) {
    distanceText = distance + 'm'
  } else {
    distanceText = (distance / 1000).toFixed(1) + 'km'
  }

  return {
    _id: item._id,
    need_id: item.need_id || item._id,
    type: item.type,
    typeName: item.type_name || getTypeName(item.type),
    typeIcon: getTypeIcon(item.type),
    bgColor: getTypeBgColor(item.type),
    color: getTypeColor(item.type),
    description: item.description,
    images: item.images || [],
    // 处理 GeoJSON - 数据库地理位置对象需要转换为普通对象
    location: item.location && typeof item.location.toJSON === 'function'
      ? item.location.toJSON()
      : item.location,
    locationName: item.location_name || '未知位置',
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
