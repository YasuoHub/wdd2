// 云函数：获取任务列表
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command
const $ = db.command.aggregate
const DEFAULT_PUBLIC_DISTANCE = 5000
const DEFAULT_PLATFORM_FEE_RATE = 0.15
const MAX_PAGE_SIZE = 30
const DEFAULT_PAGE_SIZE = 10

async function getPlatformFeeRate() {
  try {
    const configRes = await db.collection('wdd-config').doc('platform').get().catch(() => null)
    const config = configRes && configRes.data ? configRes.data : {}
    return typeof config.platform_fee_rate === 'number'
      ? config.platform_fee_rate
      : DEFAULT_PLATFORM_FEE_RATE
  } catch (err) {
    console.error('获取平台服务费率失败:', err)
    return DEFAULT_PLATFORM_FEE_RATE
  }
}

function calcTakerIncome(amount, feeRate = DEFAULT_PLATFORM_FEE_RATE) {
  const rewardAmount = Number(amount) || 0
  const platformFee = Math.round(rewardAmount * feeRate * 100) / 100
  return Math.round((rewardAmount - platformFee) * 100) / 100
}

function normalizePageParams(page, pageSize, fallbackPageSize = DEFAULT_PAGE_SIZE) {
  const normalizedPage = Math.max(1, parseInt(page, 10) || 1)
  const normalizedPageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(pageSize, 10) || fallbackPageSize))
  return {
    page: normalizedPage,
    pageSize: normalizedPageSize,
    skip: (normalizedPage - 1) * normalizedPageSize
  }
}

function normalizeCoordinate(value) {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function isValidLatitude(value) {
  return typeof value === 'number' && value >= -90 && value <= 90
}

function isValidLongitude(value) {
  return typeof value === 'number' && value >= -180 && value <= 180
}

function getGeoPointFromLatLon(latitude, longitude) {
  const lat = normalizeCoordinate(latitude)
  const lon = normalizeCoordinate(longitude)
  if (!isValidLatitude(lat) || !isValidLongitude(lon)) return null
  return { latitude: lat, longitude: lon }
}

function getDisplayDistanceValue(distance) {
  if (distance === undefined || distance === null || distance === '') return null
  const value = Number(distance)
  if (!Number.isFinite(value) || value < 0 || value >= 999000) return null
  return value
}

function formatDistanceText(distance) {
  const value = getDisplayDistanceValue(distance)
  if (value === null) return ''
  return value < 1000 ? `${Math.ceil(value)}m` : `${(value / 1000).toFixed(1)}km`
}

function getGeoPointFromFrequentLocations(userProfile) {
  const locations = userProfile && Array.isArray(userProfile.frequent_locations)
    ? userProfile.frequent_locations
    : []
  for (const loc of locations) {
    const coords = Array.isArray(loc && loc.coordinates) ? loc.coordinates : null
    const point = coords
      ? getGeoPointFromLatLon(coords[1], coords[0])
      : getGeoPointFromLatLon(loc && loc.latitude, loc && loc.longitude)
    if (point) return point
  }
  return null
}

function pickPublicProfileUser(user) {
  if (!user) return null
  const frequentLocations = Array.isArray(user.frequent_locations)
    ? user.frequent_locations.map(loc => {
      if (typeof loc === 'string') return { name: loc }
      const coords = Array.isArray(loc && loc.coordinates) ? loc.coordinates : []
      const latitude = normalizeCoordinate(loc && loc.latitude) ?? normalizeCoordinate(coords[1])
      const longitude = normalizeCoordinate(loc && loc.longitude) ?? normalizeCoordinate(coords[0])
      return {
        name: String((loc && loc.name) || ''),
        latitude,
        longitude
      }
    })
    : []

  return {
    _id: user._id,
    avatar: user.avatar || '',
    nickname: user.nickname || '未知用户',
    rating: typeof user.rating === 'number' ? user.rating : 5.0,
    rating_count: user.rating_count || 0,
    help_types: Array.isArray(user.help_types) ? user.help_types : [],
    frequent_locations: frequentLocations
  }
}

async function canUseUnlimitedDistance(OPENID) {
  if (!OPENID) return false

  try {
    const configRes = await db.collection('wdd-config').doc('platform').get().catch(() => null)
    const config = configRes && configRes.data ? configRes.data : {}
    const customerServiceOpenids = config.customer_service_openids || []
    const superAdminOpenids = config.super_admin_openids || []
    return customerServiceOpenids.includes(OPENID) || superAdminOpenids.includes(OPENID)
  } catch (err) {
    console.error('判断不限距离权限失败:', err)
    return false
  }
}

// 批量获取用户头像和昵称
async function batchGetUserMap(userIds) {
  const map = new Map()
  if (!userIds || userIds.length === 0) return map
  const uniqueIds = [...new Set(userIds.filter(Boolean))]
  if (uniqueIds.length === 0) return map
  try {
    const res = await db.collection('wdd-users')
      .where({ _id: _.in(uniqueIds) })
      .get()
    res.data.forEach(u => map.set(u._id, { nickname: u.nickname, avatar: u.avatar }))
  } catch (err) {
    console.error('批量获取用户信息失败:', err)
  }
  return map
}

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
      case 'getPublicProfile':
        return await getPublicProfile(event)
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
async function getPublicProfile(event) {
  const { userId } = event || {}
  if (!userId || typeof userId !== 'string') {
    return { code: -1, message: '用户ID不能为空' }
  }

  const userRes = await db.collection('wdd-users').doc(userId).get().catch(() => null)
  const user = userRes && userRes.data
  if (!user) {
    return { code: -1, message: '用户不存在' }
  }

  const ratingRes = await db.collection('wdd-ratings')
    .where({
      target_id: userId,
      rating: 5
    })
    .orderBy('create_time', 'desc')
    .limit(3)
    .get()

  const rawRatings = ratingRes.data || []
  const ratingNeedIds = [...new Set(rawRatings.map(item => item.need_id).filter(Boolean))]
  let ratingNeedMap = new Map()
  if (ratingNeedIds.length > 0) {
    const needRes = await db.collection('wdd-needs')
      .where({ _id: _.in(ratingNeedIds) })
      .get()
    ratingNeedMap = new Map((needRes.data || []).map(item => [item._id, item]))
  }

  const ratings = rawRatings.map(item => {
    const need = ratingNeedMap.get(item.need_id) || {}
    return {
      _id: item._id,
      need_id: item.need_id || '',
      rating: item.rating,
      type: need.type || item.type || item.task_type || 'other',
      tags: Array.isArray(item.tags) ? item.tags : [],
      comment: item.comment || item.content || '',
      create_time: item.create_time
    }
  })

  return {
    code: 0,
    message: '获取成功',
    data: {
      user: pickPublicProfileUser(user),
      ratings
    }
  }
}

function buildPublicNeedWhere({ filter, now, userProfile }) {
  const where = {
    status: 'pending',
    expire_time: _.gt(now)
  }

  if (userProfile && userProfile._id) {
    where.user_id = _.neq(userProfile._id)
  }
  if (filter && filter !== 'all') {
    where.type = filter
  }

  return where
}

async function loadCurrentUserProfile(OPENID) {
  if (!OPENID) return null
  const userRes = await db.collection('wdd-users').where({ openid: OPENID }).get().catch(() => ({ data: [] }))
  return userRes.data.length > 0 ? userRes.data[0] : null
}

function getLocationCoordinates(location) {
  const rawLocation = location && typeof location.toJSON === 'function'
    ? location.toJSON()
    : location
  const coordinates = rawLocation && Array.isArray(rawLocation.coordinates)
    ? rawLocation.coordinates
    : []
  const longitude = normalizeCoordinate(coordinates[0])
  const latitude = normalizeCoordinate(coordinates[1])
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) return null
  return { latitude, longitude }
}

async function getPublicNeedsOptimized(event, OPENID) {
  const {
    filter,
    sort = 'time',
    distance,
    page: rawPage = 1,
    pageSize: rawPageSize,
    limit: rawLimit,
    latitude,
    longitude
  } = event || {}
  const requestedPageSize = rawPageSize !== undefined && rawPageSize !== null && rawPageSize !== ''
    ? rawPageSize
    : rawLimit
  const { page, pageSize, skip } = normalizePageParams(rawPage, requestedPageSize)
  const now = new Date()
  const userProfile = await loadCurrentUserProfile(OPENID)
  const platformFeeRate = await getPlatformFeeRate()
  const where = buildPublicNeedWhere({ filter, now, userProfile })

  const hasDistanceParam = distance !== undefined && distance !== null && distance !== ''
  let effectiveDistance = hasDistanceParam ? Number(distance) : null
  if (hasDistanceParam && (!Number.isFinite(effectiveDistance) || effectiveDistance < 0)) {
    effectiveDistance = DEFAULT_PUBLIC_DISTANCE
  }
  if (hasDistanceParam && effectiveDistance === 0 && !(await canUseUnlimitedDistance(OPENID))) {
    effectiveDistance = DEFAULT_PUBLIC_DISTANCE
  }

  const currentPoint = getGeoPointFromLatLon(latitude, longitude)
  const centerPoint = currentPoint || getGeoPointFromFrequentLocations(userProfile)
  const needsDistanceQuery = sort === 'distance' || (hasDistanceParam && Number.isFinite(effectiveDistance) && effectiveDistance > 0)

  let list = []
  let total = 0

  if (needsDistanceQuery) {
    if (!centerPoint) {
      return {
        code: 0,
        message: '缺少定位，无法按距离筛选',
        data: {
          list: [],
          total: 0,
          page,
          pageSize,
          hasMore: false,
          requireLocation: true,
          userProfile: buildUserProfileSummary(userProfile)
        }
      }
    }

    const buildGeoNearOptions = () => {
      const options = {
        distanceField: 'distance',
        spherical: true,
        key: 'location',
        near: db.Geo.Point(centerPoint.longitude, centerPoint.latitude),
        query: where
      }
      if (Number.isFinite(effectiveDistance) && effectiveDistance > 0) {
        options.maxDistance = effectiveDistance
      }
      return options
    }

    const baseAggregate = () => {
      const aggregate = db.collection('wdd-needs').aggregate().geoNear(buildGeoNearOptions())
      if (sort === 'reward' || sort === 'points') {
        aggregate.sort({ reward_amount: -1, create_time: -1 })
      } else if (sort === 'time') {
        aggregate.sort({ create_time: -1 })
      }
      return aggregate
    }

    const [countRes, listRes] = await Promise.all([
      baseAggregate().count('total').end(),
      baseAggregate().skip(skip).limit(pageSize).end()
    ])
    total = countRes.list && countRes.list[0] ? countRes.list[0].total : 0
    list = listRes.list || []
  } else {
    let query = db.collection('wdd-needs').where(where)
    if (sort === 'reward' || sort === 'points') {
      query = query.orderBy('reward_amount', 'desc').orderBy('create_time', 'desc')
    } else {
      query = query.orderBy('create_time', 'desc')
    }

    const [countRes, listRes] = await Promise.all([
      db.collection('wdd-needs').where(where).count(),
      query.skip(skip).limit(pageSize).get()
    ])
    total = countRes.total
    list = listRes.data || []
  }

  const userIds = [...new Set(list.map(item => item.user_id).filter(Boolean))]
  const userMap = await batchGetUserMap(userIds)
  const formattedList = list.map(item => formatNeedItem(item, userProfile, null, null, userMap, {
    includeTakerIncome: true,
    platformFeeRate
  }))

  return {
    code: 0,
    message: '获取成功',
    data: {
      list: formattedList,
      total,
      page,
      pageSize,
      hasMore: skip + list.length < total,
      userProfile: buildUserProfileSummary(userProfile)
    }
  }
}

function buildUserProfileSummary(userProfile) {
  return userProfile ? {
    hasHelperProfile: !!userProfile.help_willingness,
    helpWillingness: userProfile.help_willingness,
    frequentLocations: userProfile.frequent_locations || [],
    helpTypes: userProfile.help_types || []
  } : null
}

async function getPublicNeeds(event, OPENID) {
  return await getPublicNeedsOptimized(event, OPENID)

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
        where.user_id = _.neq(userProfile._id)
      }
    } catch (err) {
      console.error('获取用户资料失败:', err)
    }
  }

  const platformFeeRate = await getPlatformFeeRate()

  const hasDistanceParam = distance !== undefined && distance !== null && distance !== ''
  let effectiveDistance = hasDistanceParam ? Number(distance) : distance
  if (hasDistanceParam && Number.isFinite(effectiveDistance) && effectiveDistance === 0) {
    const allowedUnlimitedDistance = await canUseUnlimitedDistance(OPENID)
    if (!allowedUnlimitedDistance) {
      console.log('普通用户请求不限距离，已按默认5公里处理')
      effectiveDistance = DEFAULT_PUBLIC_DISTANCE
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
  // distance > 0 表示需要筛选，distance = 0 仅超级管理员/客服表示全部距离
  if (hasDistanceParam && Number.isFinite(effectiveDistance) && effectiveDistance > 0) {
    console.log('执行距离筛选:', effectiveDistance, '米，筛选前数量:', list.length)
    list = list.filter(item => item.distance <= effectiveDistance)
    console.log('筛选后数量:', list.length)
  }

  // 排序
  switch (sort) {
    case 'distance':
      // 按距离从近到远排序
      list.sort((a, b) => a.distance - b.distance)
      break
    case 'points':
    case 'reward':
      // 按悬赏金额从高到低排序
      list.sort((a, b) => {
        const aReward = a.reward_amount || 0
        const bReward = b.reward_amount || 0
        return bReward - aReward
      })
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

  // 批量查询用户最新头像和昵称
  const userIds = [...new Set(pagedList.map(item => item.user_id).filter(Boolean))]
  const userMap = await batchGetUserMap(userIds)

  // 格式化数据
  const formattedList = pagedList.map(item => formatNeedItem(item, userProfile, null, null, userMap, {
    includeTakerIncome: true,
    platformFeeRate
  }))

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
  if (userRes.data.length === 0 || userRes.data[0].is_deleted === true) {
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

  // 预查询当前用户的举报和申诉记录（含已撤销，一次机会用完即不再显示按钮）
  const myReportRes = await db.collection('wdd-reports').where({
    reporter_id: userId
  }).get()
  const myAppealRes = await db.collection('wdd-appeals').where({
    initiator_id: userId
  }).get()
  const myReportNeedIds = new Set(myReportRes.data.map(r => r.need_id))
  const myAppealNeedIds = new Set(myAppealRes.data.map(a => a.need_id))

  const experienceRes = await db.collection('wdd-experiences').where({
    requester_id: userId
  }).get().catch(() => ({ data: [] }))
  const experienceMap = new Map(experienceRes.data.map(item => [item.need_id, item]))

  // 批量查询求助者最新头像和昵称
  const myNeedsUserIds = [...new Set(listRes.data.map(item => item.user_id).filter(Boolean))]
  const myNeedsUserMap = await batchGetUserMap(myNeedsUserIds)

  // 格式化数据，并查询评价状态
  const list = await Promise.all(listRes.data.map(async (item) => {
    console.log('getMyNeeds - 原始数据 location_name:', item.location_name, 'location:', JSON.stringify(item.location))
    const formatted = formatNeedItem(item, null, myReportNeedIds, myAppealNeedIds, myNeedsUserMap)
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

    const experience = experienceMap.get(item._id)
    formatted.experienceId = experience ? experience._id : ''
    formatted.experienceStatus = experience ? experience.status : ''
    formatted.showExperienceShare = item.status === 'completed' &&
      (!experience || ['draft', 'pending_confirmation'].includes(experience.status))

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
  if (userRes.data.length === 0 || userRes.data[0].is_deleted === true) {
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

  // 预查询当前用户的举报和申诉记录（含已撤销，一次机会用完即不再显示按钮）
  const myReportRes = await db.collection('wdd-reports').where({
    reporter_id: userId
  }).get()
  const myAppealRes = await db.collection('wdd-appeals').where({
    initiator_id: userId
  }).get()
  const myReportNeedIds = new Set(myReportRes.data.map(r => r.need_id))
  const myAppealNeedIds = new Set(myAppealRes.data.map(a => a.need_id))

  // 批量获取关联的任务详情
  const needIds = [...new Set(takerRes.data.map(t => t.need_id).filter(Boolean))]
  const needsRes = await db.collection('wdd-needs')
    .where({ _id: _.in(needIds) })
    .get()
  const needMap = new Map()
  needsRes.data.forEach(n => needMap.set(n._id, n))

  // 批量查询求助者最新头像和昵称
  const seekerIds = [...new Set(needsRes.data.map(n => n.user_id).filter(Boolean))]
  const tasksUserMap = await batchGetUserMap(seekerIds)

  // 组装任务列表，并查询评价状态
  const tasks = await Promise.all(takerRes.data.map(async (taker) => {
    const need = needMap.get(taker.need_id)

    if (!need) return null

    const item = {
      ...taker,
      need_id: taker.need_id,
      type: need.type,
      description: need.description,
      location: need.location,
      location_name: need.location_name,
      points: need.points,
      reward_amount: need.reward_amount || 0,
      status: need.status,
      expire_time: need.expire_time,
      complete_time: need.complete_time,
      cancel_time: need.cancel_time,
      cancel_reason: need.cancel_reason,
      create_time: taker.create_time,
      seeker_nickname: (tasksUserMap.get(need.user_id))?.nickname || need.user_nickname,
      seeker_avatar: (tasksUserMap.get(need.user_id))?.avatar || need.user_avatar
    }

    const formatted = formatNeedItem(item, null, myReportNeedIds, myAppealNeedIds, tasksUserMap)

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

    const platformFeeRate = await getPlatformFeeRate()

    // 格式化任务数据
    const formattedNeed = formatNeedItem(need, null, null, null, null, {
      includeTakerIncome: true,
      platformFeeRate
    })

    // 批量查询求助者和帮助者最新头像和昵称
    const detailUserIds = [need.user_id, need.taker_id].filter(Boolean)
    const detailUserMap = await batchGetUserMap(detailUserIds)

    // 补充完整字段
    const detail = {
      ...formattedNeed,
      user_id: need.user_id,
      user_nickname: (detailUserMap.get(need.user_id))?.nickname || need.user_nickname,
      user_avatar: (detailUserMap.get(need.user_id))?.avatar || need.user_avatar,
      taker_id: need.taker_id,
      taker_nickname: need.taker_id ? ((detailUserMap.get(need.taker_id))?.nickname || need.taker_nickname) : null,
      taker_avatar: need.taker_id ? ((detailUserMap.get(need.taker_id))?.avatar || need.taker_avatar) : null,
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
  const normalizedRatingType = ratingType || 'seeker'

  if (!needId) {
    return { code: -1, message: '任务ID不能为空' }
  }
  if (normalizedRatingType !== 'seeker') {
    return { code: -1, message: '仅支持查看求助者对帮助者的评价' }
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
      rating_type: normalizedRatingType
    }).get()

    if (ratingRes.data.length === 0) {
      return { code: -1, message: '评价记录不存在' }
    }

    const rating = ratingRes.data[0]

    // 获取评价对象信息
    const targetUserRes = await db.collection('wdd-users').doc(rating.target_id).get()
    const targetUser = targetUserRes.data || {}

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
          type: need.type,
          description: need.description,
          price: need.reward_amount || 0
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

// 格式化日期时间（强制按北京时间 UTC+8 输出，避免云函数环境时区为 UTC 导致时间差 8 小时）
function formatDateTime(date) {
  if (!date) return ''
  const d = new Date(date)
  if (isNaN(d.getTime())) return ''
  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000)
  const year = bj.getUTCFullYear()
  const month = String(bj.getUTCMonth() + 1).padStart(2, '0')
  const day = String(bj.getUTCDate()).padStart(2, '0')
  const hours = String(bj.getUTCHours()).padStart(2, '0')
  const minutes = String(bj.getUTCMinutes()).padStart(2, '0')
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
function formatNeedItem(item, userProfile, myReportNeedIds, myAppealNeedIds, userMap, options = {}) {
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

  const distanceText = formatDistanceText(distance)

  const rewardAmount = item.reward_amount || 0
  const takerIncome = calcTakerIncome(rewardAmount, options.platformFeeRate)

  return {
    _id: item._id,
    need_id: item.need_id || item._id,
    user_id: item.user_id,
    task_no: item.task_no,
    type: item.type,
    description: item.description,
    images: item.images || [],
    // 处理 GeoJSON - 数据库地理位置对象需要转换为普通对象
    location: item.location && typeof item.location.toJSON === 'function'
      ? item.location.toJSON()
      : item.location,
    locationName: item.location_name || '未知位置',
    points: item.points,
    rewardAmount,
    takerIncome,
    displayRewardAmount: options.includeTakerIncome ? takerIncome : rewardAmount,
    status: item.status,
    distance: distance,
    distanceText,
    remainTime: remainTime,
    userNickname: (userMap && userMap.get(item.user_id))?.nickname || item.user_nickname || item.seeker_nickname,
    user_avatar: (userMap && userMap.get(item.user_id))?.avatar || item.user_avatar || item.seeker_avatar,
    seekerNickname: (userMap && userMap.get(item.user_id))?.nickname || item.seeker_nickname || item.user_nickname,
    seekerAvatar: (userMap && userMap.get(item.user_id))?.avatar || item.seeker_avatar || item.user_avatar,
    takerNickname: (userMap && userMap.get(item.taker_id))?.nickname || item.taker_nickname,
    taker_avatar: (userMap && userMap.get(item.taker_id))?.avatar || item.taker_avatar,
    expireTime: item.expire_time,
    matchTime: item.match_time,
    completeTime: item.complete_time,
    cancelTime: item.cancel_time,
    cancelReason: item.cancel_reason,
    createTime: formatDateTime(item.create_time),
    hasRated: item.has_rated || false,
    // 当前用户个人的举报/申诉状态（用户级别）
    hasMyReport: myReportNeedIds ? myReportNeedIds.has(item._id) : false,
    hasMyAppeal: myAppealNeedIds ? myAppealNeedIds.has(item._id) : false
  }
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
