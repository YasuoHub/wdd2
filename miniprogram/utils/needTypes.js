// 求助类型统一配置
const NEED_TYPES = [
  { type: 'weather', id: 'weather', name: '实时天气', icon: 'cloud-sun', color: '#5DB8E6', lightColor: '#7EC8E8', bgColor: 'rgba(93, 184, 230, 0.12)' },
  { type: 'traffic', id: 'traffic', name: '道路拥堵', icon: 'car-front', color: '#FFD166', lightColor: '#FFE08C', bgColor: 'rgba(255, 209, 102, 0.16)' },
  { type: 'shop', id: 'shop', name: '店铺营业', icon: 'store', color: '#5DB8E6', lightColor: '#A8D8F0', bgColor: 'rgba(93, 184, 230, 0.1)' },
  { type: 'parking', id: 'parking', name: '停车场空位', icon: 'square-parking', color: '#6DD5B0', lightColor: '#88D8A3', bgColor: 'rgba(109, 213, 176, 0.14)' },
  { type: 'queue', id: 'queue', name: '排队情况', icon: 'users-round', color: '#FF8C69', lightColor: '#FF9A8B', bgColor: 'rgba(255, 140, 105, 0.14)' },
  { type: 'other', id: 'other', name: '其他', icon: 'ellipsis', color: '#A8C4D4', lightColor: '#C4D8E5', bgColor: 'rgba(168, 196, 212, 0.14)' }
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
