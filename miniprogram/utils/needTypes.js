// 求助类型统一配置：后端只保存 type 枚举，展示名称、图标、颜色都从这里取。
const NEED_TYPES = [
  {
    type: 'weather',
    id: 'weather',
    name: '实时天气',
    shortName: '天气',
    icon: 'cloud-sun',
    color: 'var(--brand-primary)',
    lightColor: 'var(--brand-primary-light)',
    bgColor: 'var(--brand-primary-10)',
    tone: 'brand'
  },
  {
    type: 'traffic',
    id: 'traffic',
    name: '道路拥堵',
    shortName: '路况',
    icon: 'car-front',
    color: 'var(--brand-primary)',
    lightColor: 'var(--brand-primary-light)',
    bgColor: 'var(--brand-primary-10)',
    tone: 'brand'
  },
  {
    type: 'shop',
    id: 'shop',
    name: '店铺营业',
    shortName: '店铺',
    icon: 'store',
    color: 'var(--brand-primary)',
    lightColor: 'var(--brand-primary-light)',
    bgColor: 'var(--brand-primary-10)',
    tone: 'brand'
  },
  {
    type: 'parking',
    id: 'parking',
    name: '停车场空位',
    shortName: '停车',
    icon: 'square-parking',
    color: 'var(--brand-primary)',
    lightColor: 'var(--brand-primary-light)',
    bgColor: 'var(--brand-primary-10)',
    tone: 'brand'
  },
  {
    type: 'queue',
    id: 'queue',
    name: '排队情况',
    shortName: '排队',
    icon: 'users-round',
    color: 'var(--brand-primary)',
    lightColor: 'var(--brand-primary-light)',
    bgColor: 'var(--brand-primary-10)',
    tone: 'brand'
  },
  {
    type: 'other',
    id: 'other',
    name: '其他',
    shortName: '其他',
    icon: 'ellipsis',
    color: 'var(--brand-primary)',
    lightColor: 'var(--brand-primary-light)',
    bgColor: 'var(--brand-primary-08)',
    tone: 'brand'
  }
]

const TYPE_MAP = NEED_TYPES.reduce((map, item) => {
  map[item.type] = item
  return map
}, {})

const STATUS_MAP = {
  pending: { text: '待匹配', class: 'pending', icon: 'hourglass' },
  ongoing: { text: '进行中', class: 'ongoing', icon: 'handshake' },
  completed: { text: '已完成', class: 'completed', icon: 'circle-check-big' },
  cancelled: { text: '已取消', class: 'cancelled', icon: 'circle-x' },
  breaking: { text: '审核中', class: 'breaking', icon: 'clock-3' }
}

function normalizeType(type) {
  return TYPE_MAP[type] ? type : 'other'
}

function getByType(type) {
  return TYPE_MAP[normalizeType(type)]
}

function getByStatus(status) {
  return STATUS_MAP[status] || { text: '未知', class: '', icon: 'circle-help' }
}

function resolveTaskType(item = {}) {
  return normalizeType(item.type || item.taskType || item.task_type || item.needType || item.need_type)
}

function withTypeMeta(item = {}) {
  const type = resolveTaskType(item)
  const typeInfo = getByType(type)
  return {
    ...item,
    type,
    typeName: typeInfo.name,
    typeShortName: typeInfo.shortName,
    typeIcon: typeInfo.icon,
    color: typeInfo.color,
    iconColor: typeInfo.color,
    bgColor: typeInfo.bgColor,
    typeColor: typeInfo.color,
    typeBgColor: typeInfo.bgColor,
    iconTone: typeInfo.tone
  }
}

module.exports = {
  NEED_TYPES,
  TYPE_MAP,
  STATUS_MAP,
  normalizeType,
  resolveTaskType,
  withTypeMeta,
  getByType,
  getByStatus
}
