/**
 * 举报/申诉类型共用配置
 * 集中管理类型定义，供前端各页面共用
 */

// 举报类型列表（value → label）
const REPORT_TYPES = [
  { value: 'offline_transaction', label: '诱导线下私下交易' },
  { value: 'verbal_abuse', label: '言语辱骂、骚扰人身攻击' },
  { value: 'fraud', label: '虚假承诺、恶意骗单' },
  { value: 'delay', label: '敷衍沟通、故意拖延进度' },
  { value: 'sensitive_content', label: '发布违规敏感内容' },
  { value: 'malicious_difficulty', label: '恶意刁难、无故拖延不配合' },
  { value: 'false_info', label: '提供虚假实时信息（谎报天气/拥堵/营业状态）' },
  { value: 'location_mismatch', label: '接单后定位不符、不在求助地点' },
  { value: 'no_response', label: '恶意接单后不回复、不提供帮助' },
  { value: 'other_violation', label: '其他违规行为' }
]

// 仅 label 数组，用于 picker 的 range 属性
const REPORT_TYPE_LABELS = REPORT_TYPES.map(t => t.label)

// 状态映射
const STATUS_MAP = {
  pending: { text: '待匹配', class: 'pending', icon: 'hourglass' },
  ongoing: { text: '进行中', class: 'ongoing', icon: 'handshake' },
  completed: { text: '已完成', class: 'completed', icon: 'circle-check-big' },
  cancelled: { text: '已取消', class: 'cancelled', icon: 'circle-x' },
  breaking: { text: '审核中', class: 'breaking', icon: 'clock-3' }
}

// 任务类型映射
const TYPE_MAP = {
  weather: { name: '实时天气', icon: 'cloud-sun', color: '#1677D2', bgColor: 'rgba(22, 119, 210, 0.12)' },
  traffic: { name: '道路拥堵', icon: 'car-front', color: '#E9B949', bgColor: 'rgba(255, 209, 102, 0.16)' },
  shop: { name: '店铺营业', icon: 'store', color: '#1677D2', bgColor: 'rgba(22, 119, 210, 0.1)' },
  parking: { name: '停车场空位', icon: 'square-parking', color: '#1F8F7A', bgColor: 'rgba(31, 143, 122, 0.14)' },
  queue: { name: '排队情况', icon: 'users-round', color: '#D96A22', bgColor: 'rgba(217, 106, 34, 0.14)' },
  other: { name: '其他', icon: 'ellipsis', color: '#B8C2CC', bgColor: 'rgba(168, 196, 212, 0.14)' }
}

module.exports = {
  REPORT_TYPES,
  REPORT_TYPE_LABELS,
  STATUS_MAP,
  TYPE_MAP
}
