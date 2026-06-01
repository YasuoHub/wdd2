// 运营分析云函数
// 为超级管理员提供平台运营数据，所有操作需超管权限
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

// 等待时间分桶定义
const WAIT_BUCKETS = [
  { key: '<1min', label: '1分钟内', min: 0, max: 1 },
  { key: '1-5min', label: '1~5分钟', min: 1, max: 5 },
  { key: '5-15min', label: '5~15分钟', min: 5, max: 15 },
  { key: '15-30min', label: '15~30分钟', min: 15, max: 30 },
  { key: '30min-1h', label: '30分钟~1小时', min: 30, max: 60 },
  { key: '>1h', label: '1小时以上', min: 60, max: Infinity }
]

exports.main = async (event, context) => {
  const { action, startDate, endDate, page = 1, pageSize = 20 } = event
  const { OPENID } = cloud.getWXContext()

  if (!(await isSuperAdmin(OPENID))) {
    return { code: -1, message: '无权限访问' }
  }

  try {
    switch (action) {
      case 'getKpiOverview': return await getKpiOverview(startDate, endDate)
      case 'getRevenueTrend': return await getRevenueTrend(startDate, endDate)
      case 'getUserTrend': return await getUserTrend(startDate, endDate)
      case 'getTaskTypeRanking': return await getTaskTypeRanking(startDate, endDate)
      case 'getConversionFunnel': return await getConversionFunnel(startDate, endDate)
      case 'getCompletionCancelTrend': return await getCompletionCancelTrend(startDate, endDate)
      case 'getReportRateTrend': return await getReportRateTrend(startDate, endDate)
      case 'getWaitTimeDistribution': return await getWaitTimeDistribution(startDate, endDate)
      case 'getAvgMatchTimeTrend': return await getAvgMatchTimeTrend(startDate, endDate)
      case 'getHotLocationRanking': return await getHotLocationRanking(startDate, endDate)
      case 'getFundFlow': return await getFundFlow(startDate, endDate)
      case 'getFundFlowDetails': return await getFundFlowDetails(startDate, endDate, page, pageSize)
      default: return { code: -1, message: `未知操作: ${action}` }
    }
  } catch (err) {
    console.error(`[wdd-ops-analytics] ${action} 执行失败:`, err)
    return { code: -1, message: `数据查询失败: ${err.message}` }
  }
}

// ===================== 鉴权 =====================

async function isSuperAdmin(openid) {
  try {
    const configRes = await db.collection('wdd-config').doc('platform').get()
    const saOpenids = configRes && configRes.data ? (configRes.data.super_admin_openids || []) : []
    return saOpenids.includes(openid)
  } catch (err) {
    console.error('鉴权失败:', err)
    return false
  }
}

// ===================== 工具函数 =====================

/** 解析日期范围，返回 { start: Date, end: Date }，start 为 00:00:00，end 为 23:59:59 */
function parseDateRange(startDate, endDate) {
  const start = new Date(startDate + 'T00:00:00.000Z')
  const end = new Date(endDate + 'T23:59:59.999Z')
  return { start, end }
}

/** 生成日期范围内的所有日期字符串数组（YYYY-MM-DD，北京时间） */
function getDateArray(startDate, endDate) {
  const dates = []
  const start = new Date(startDate + 'T00:00:00.000Z')
  const end = new Date(endDate + 'T00:00:00.000Z')
  const current = new Date(start)
  while (current <= end) {
    dates.push(current.toISOString().split('T')[0])
    current.setUTCDate(current.getUTCDate() + 1)
  }
  return dates
}

/** 将 Date 对象转为北京时间日期字符串 YYYY-MM-DD */
function toBeijingDate(date) {
  const d = new Date(date.getTime() + 8 * 3600000)
  return d.toISOString().split('T')[0]
}

/** 补零：对日期范围内缺失的日期填默认值 */
function fillZeroTrend(dateArray, dataMap, key) {
  return dateArray.map(date => {
    if (dataMap[date] !== undefined) {
      return typeof dataMap[date] === 'object' ? { date, ...dataMap[date] } : { date, [key]: dataMap[date] }
    }
    return { date, [key]: 0 }
  })
}

/** 分页查询全部数据（自动处理云数据库 100 条限制） */
async function fetchAll(collection, query, maxLimit = 2000) {
  let allData = []
  let offset = 0
  const batchSize = 100
  while (offset < maxLimit) {
    const res = await collection.where(query).skip(offset).limit(batchSize).get()
    if (res.data.length === 0) break
    allData = allData.concat(res.data)
    offset += batchSize
  }
  return allData
}

// ===================== Action 1: KPI 概览 =====================

async function getKpiOverview(startDate, endDate) {
  const { start, end } = parseDateRange(startDate, endDate)

  const [totalRes, completedRes, cancelledRes, revenueData, newUsersRes] = await Promise.all([
    db.collection('wdd-needs').where({ create_time: _.gte(start).and(_.lte(end)) }).count(),
    db.collection('wdd-needs').where({ create_time: _.gte(start).and(_.lte(end)), status: 'completed' }).count(),
    db.collection('wdd-needs').where({ create_time: _.gte(start).and(_.lte(end)), status: 'cancelled' }).count(),
    fetchAll(db.collection('wdd-needs'), { status: 'completed', complete_time: _.gte(start).and(_.lte(end)) }),
    db.collection('wdd-users').where({ create_time: _.gte(start).and(_.lte(end)) }).count()
  ])

  const resolved = completedRes.total + cancelledRes.total
  const completionRate = resolved > 0 ? completedRes.total / resolved : 0
  const platformRevenue = revenueData.reduce((sum, n) => sum + (n.platform_fee || 0), 0)

  return {
    code: 0,
    data: {
      totalTasks: totalRes.total,
      completionRate: Math.round(completionRate * 10000) / 10000,
      platformRevenue: Math.round(platformRevenue * 100) / 100,
      newUsers: newUsersRes.total
    }
  }
}

// ===================== Action 2: 平台收入趋势 =====================

async function getRevenueTrend(startDate, endDate) {
  const { start, end } = parseDateRange(startDate, endDate)
  const dateArray = getDateArray(startDate, endDate)

  const data = await fetchAll(db.collection('wdd-needs'), {
    status: 'completed',
    complete_time: _.gte(start).and(_.lte(end))
  })

  const dateMap = {}
  data.forEach(item => {
    const date = toBeijingDate(item.complete_time)
    if (!dateMap[date]) dateMap[date] = 0
    dateMap[date] += (item.platform_fee || 0)
  })

  // 四舍五入
  Object.keys(dateMap).forEach(d => { dateMap[d] = Math.round(dateMap[d] * 100) / 100 })

  return {
    code: 0,
    data: { trend: fillZeroTrend(dateArray, dateMap, 'revenue') }
  }
}

// ===================== Action 3: 新增用户趋势 =====================

async function getUserTrend(startDate, endDate) {
  const { start, end } = parseDateRange(startDate, endDate)
  const dateArray = getDateArray(startDate, endDate)

  const data = await fetchAll(db.collection('wdd-users'), {
    create_time: _.gte(start).and(_.lte(end))
  })

  const dateMap = {}
  data.forEach(item => {
    const date = toBeijingDate(item.create_time)
    dateMap[date] = (dateMap[date] || 0) + 1
  })

  return {
    code: 0,
    data: { trend: fillZeroTrend(dateArray, dateMap, 'count') }
  }
}

// ===================== Action 4: 任务类型排行 =====================

async function getTaskTypeRanking(startDate, endDate) {
  const { start, end } = parseDateRange(startDate, endDate)

  const data = await fetchAll(db.collection('wdd-needs'), {
    create_time: _.gte(start).and(_.lte(end)),
    type_name: _.neq(null)
  })

  const typeMap = {}
  data.forEach(item => {
    const name = item.type_name || '其他'
    typeMap[name] = (typeMap[name] || 0) + 1
  })

  const total = data.length
  const ranking = Object.entries(typeMap)
    .map(([typeName, count]) => ({
      typeName,
      count,
      percentage: total > 0 ? Math.round((count / total) * 10000) / 10000 : 0
    }))
    .sort((a, b) => b.count - a.count)

  return { code: 0, data: { ranking } }
}

// ===================== Action 5: 转化漏斗 =====================

async function getConversionFunnel(startDate, endDate) {
  const { start, end } = parseDateRange(startDate, endDate)

  const [publishedRes, matchedRes, completedRes, ratedRes] = await Promise.all([
    db.collection('wdd-needs').where({ create_time: _.gte(start).and(_.lte(end)) }).count(),
    db.collection('wdd-needs').where({ match_time: _.gte(start).and(_.lte(end)) }).count(),
    db.collection('wdd-needs').where({ status: 'completed', complete_time: _.gte(start).and(_.lte(end)) }).count(),
    db.collection('wdd-ratings').where({ create_time: _.gte(start).and(_.lte(end)) }).count()
  ])

  return {
    code: 0,
    data: {
      published: publishedRes.total,
      matched: matchedRes.total,
      completed: completedRes.total,
      rated: ratedRes.total
    }
  }
}

// ===================== Action 6: 完结率/取消率趋势 =====================

async function getCompletionCancelTrend(startDate, endDate) {
  const { start, end } = parseDateRange(startDate, endDate)
  const dateArray = getDateArray(startDate, endDate)

  const data = await fetchAll(db.collection('wdd-needs'), {
    create_time: _.gte(start).and(_.lte(end)),
    status: _.in(['completed', 'cancelled'])
  })

  // 按日期分组统计
  const dateMap = {}
  data.forEach(item => {
    const date = toBeijingDate(item.create_time)
    if (!dateMap[date]) dateMap[date] = { completed: 0, cancelled: 0 }
    if (item.status === 'completed') dateMap[date].completed++
    else if (item.status === 'cancelled') dateMap[date].cancelled++
  })

  const trend = dateArray.map(date => {
    const d = dateMap[date] || { completed: 0, cancelled: 0 }
    const total = d.completed + d.cancelled
    return {
      date,
      completionRate: total > 0 ? Math.round((d.completed / total) * 10000) / 10000 : 0,
      cancelRate: total > 0 ? Math.round((d.cancelled / total) * 10000) / 10000 : 0
    }
  })

  return { code: 0, data: { trend } }
}

// ===================== Action 7: 举报率趋势 =====================

async function getReportRateTrend(startDate, endDate) {
  const { start, end } = parseDateRange(startDate, endDate)
  const dateArray = getDateArray(startDate, endDate)

  // 按天统计已完成任务数（作为分母）
  const needsData = await fetchAll(db.collection('wdd-needs'), {
    status: 'completed',
    complete_time: _.gte(start).and(_.lte(end))
  })

  const completedByDate = {}
  needsData.forEach(item => {
    const date = toBeijingDate(item.complete_time)
    completedByDate[date] = (completedByDate[date] || 0) + 1
  })

  // 按天统计举报数（总数和有效数）
  const reportsData = await fetchAll(db.collection('wdd-reports'), {
    create_time: _.gte(start).and(_.lte(end))
  })

  const reportsByDate = {}
  const validReportsByDate = {}
  reportsData.forEach(item => {
    const date = toBeijingDate(item.create_time)
    reportsByDate[date] = (reportsByDate[date] || 0) + 1
    // 有效举报：状态不是 cancelled（未被举报人撤销）
    if (item.status !== 'cancelled') {
      validReportsByDate[date] = (validReportsByDate[date] || 0) + 1
    }
  })

  const trend = dateArray.map(date => {
    const taskCount = completedByDate[date] || 0
    const totalReports = reportsByDate[date] || 0
    const validReports = validReportsByDate[date] || 0
    return {
      date,
      totalReportRate: taskCount > 0 ? Math.round((totalReports / taskCount) * 10000) / 10000 : 0,
      validReportRate: taskCount > 0 ? Math.round((validReports / taskCount) * 10000) / 10000 : 0
    }
  })

  return { code: 0, data: { trend } }
}

// ===================== Action 8: 等待时间分布 =====================

async function getWaitTimeDistribution(startDate, endDate) {
  const { start, end } = parseDateRange(startDate, endDate)

  // 拉取期内匹配的任务
  const data = await fetchAll(db.collection('wdd-needs'), {
    match_time: _.gte(start).and(_.lte(end)).and(_.neq(null))
  })

  // 初始化分桶
  const buckets = WAIT_BUCKETS.map(b => ({ ...b, count: 0 }))

  data.forEach(item => {
    const waitMinutes = (new Date(item.match_time).getTime() - new Date(item.create_time).getTime()) / 60000
    for (const bucket of buckets) {
      if (waitMinutes >= bucket.min && waitMinutes < bucket.max) {
        bucket.count++
        break
      }
    }
  })

  const total = data.length
  const distribution = buckets.map(b => ({
    bucket: b.key,
    label: b.label,
    count: b.count,
    percentage: total > 0 ? Math.round((b.count / total) * 10000) / 10000 : 0
  }))

  return { code: 0, data: { distribution, total } }
}

// ===================== Action 9: 平均匹配时长趋势 =====================

async function getAvgMatchTimeTrend(startDate, endDate) {
  const { start, end } = parseDateRange(startDate, endDate)
  const dateArray = getDateArray(startDate, endDate)

  const data = await fetchAll(db.collection('wdd-needs'), {
    match_time: _.gte(start).and(_.lte(end)).and(_.neq(null))
  })

  // 按匹配日期分组
  const dateMap = {}
  data.forEach(item => {
    const date = toBeijingDate(item.match_time)
    if (!dateMap[date]) dateMap[date] = { totalWait: 0, count: 0 }
    const waitMinutes = (new Date(item.match_time).getTime() - new Date(item.create_time).getTime()) / 60000
    dateMap[date].totalWait += waitMinutes
    dateMap[date].count++
  })

  const trend = dateArray.map(date => {
    const d = dateMap[date]
    return {
      date,
      avgMinutes: d && d.count > 0 ? Math.round((d.totalWait / d.count) * 100) / 100 : 0
    }
  })

  return { code: 0, data: { trend } }
}

// ===================== Action 10: 热门地点排行 =====================

async function getHotLocationRanking(startDate, endDate) {
  const { start, end } = parseDateRange(startDate, endDate)

  const data = await fetchAll(db.collection('wdd-needs'), {
    create_time: _.gte(start).and(_.lte(end)),
    location_name: _.neq(null).and(_.neq(''))
  })

  const locationMap = {}
  data.forEach(item => {
    const name = item.location_name || '未知地点'
    locationMap[name] = (locationMap[name] || 0) + 1
  })

  const ranking = Object.entries(locationMap)
    .map(([locationName, count]) => ({ locationName, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)

  return { code: 0, data: { ranking } }
}

// ===================== Action 11a: 资金流水趋势 =====================

async function getFundFlow(startDate, endDate) {
  const { start, end } = parseDateRange(startDate, endDate)
  const dateArray = getDateArray(startDate, endDate)

  // 平台收入：从已完成任务的 platform_fee 按天汇总
  const revenueData = await fetchAll(db.collection('wdd-needs'), {
    status: 'completed',
    complete_time: _.gte(start).and(_.lte(end))
  })

  const incomeByDate = {}
  revenueData.forEach(item => {
    const date = toBeijingDate(item.complete_time)
    incomeByDate[date] = (incomeByDate[date] || 0) + (item.platform_fee || 0)
  })

  // 平台支出：从余额流水中提现记录按天汇总
  const expenseData = await fetchAll(db.collection('wdd-balance-records'), {
    type: 'withdraw',
    create_time: _.gte(start).and(_.lte(end))
  })

  const expenseByDate = {}
  expenseData.forEach(item => {
    const date = toBeijingDate(item.create_time)
    // amount 是负数，取绝对值
    expenseByDate[date] = (expenseByDate[date] || 0) + Math.abs(item.amount || 0)
  })

  const trend = dateArray.map(date => {
    const income = Math.round((incomeByDate[date] || 0) * 100) / 100
    const expense = Math.round((expenseByDate[date] || 0) * 100) / 100
    return {
      date,
      income,
      expense,
      net: Math.round((income - expense) * 100) / 100
    }
  })

  return { code: 0, data: { trend } }
}

// ===================== Action 11b: 资金流水明细（分页） =====================

async function getFundFlowDetails(startDate, endDate, page, pageSize) {
  const { start, end } = parseDateRange(startDate, endDate)
  const skip = (Math.max(1, page) - 1) * pageSize

  const [listRes, countRes] = await Promise.all([
    db.collection('wdd-balance-records')
      .where({ create_time: _.gte(start).and(_.lte(end)) })
      .orderBy('create_time', 'desc')
      .skip(skip)
      .limit(pageSize)
      .get(),
    db.collection('wdd-balance-records')
      .where({ create_time: _.gte(start).and(_.lte(end)) })
      .count()
  ])

  return {
    code: 0,
    data: {
      records: listRes.data,
      total: countRes.total,
      page,
      pageSize,
      hasMore: skip + pageSize < countRes.total
    }
  }
}
