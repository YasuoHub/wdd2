// 求助类型统一配置
const NEED_TYPES = [
  { type: 'weather', id: 'weather', name: '实时天气', icon: 'cloud-sun', color: '#1677D2', lightColor: '#2B8AD8', bgColor: 'rgba(22, 119, 210, 0.12)' },
  { type: 'traffic', id: 'traffic', name: '道路拥堵', icon: 'car-front', color: '#E9B949', lightColor: '#F7D57A', bgColor: 'rgba(255, 209, 102, 0.16)' },
  { type: 'shop', id: 'shop', name: '店铺营业', icon: 'store', color: '#1677D2', lightColor: '#D9ECFB', bgColor: 'rgba(22, 119, 210, 0.1)' },
  { type: 'parking', id: 'parking', name: '停车场空位', icon: 'square-parking', color: '#1F8F7A', lightColor: '#34A98F', bgColor: 'rgba(31, 143, 122, 0.14)' },
  { type: 'queue', id: 'queue', name: '排队情况', icon: 'users-round', color: '#D96A22', lightColor: '#E9823A', bgColor: 'rgba(217, 106, 34, 0.14)' },
  { type: 'other', id: 'other', name: '其他', icon: 'ellipsis', color: '#B8C2CC', lightColor: '#D9E2EC', bgColor: 'rgba(168, 196, 212, 0.14)' }
]

const { STATUS_MAP } = require('../config/types')

// 按 type 查找
function getByType(type) {
  return NEED_TYPES.find(item => item.type === type || item.id === type) || null
}

// 按 status 查找
function getByStatus(status) {
  return STATUS_MAP[status] || { text: '未知', class: '', icon: 'circle-help' }
}

module.exports = {
  NEED_TYPES,
  STATUS_MAP,
  getByType,
  getByStatus
}
