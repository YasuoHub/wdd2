// 求助类型统一配置
const NEED_TYPES = [
  { type: 'weather', id: 'weather', name: '实时天气', icon: '🌤️', color: '#5DB8E6', lightColor: '#7EC8E8', bgColor: 'rgba(116, 185, 255, 0.15)' },
  { type: 'traffic', id: 'traffic', name: '道路拥堵', icon: '🚗', color: '#FFD166', lightColor: '#FFE08C', bgColor: 'rgba(253, 203, 110, 0.15)' },
  { type: 'shop', id: 'shop', name: '店铺营业', icon: '🏪', color: '#B8B8E8', lightColor: '#D4D4F0', bgColor: 'rgba(162, 155, 254, 0.15)' },
  { type: 'parking', id: 'parking', name: '停车场空位', icon: '🅿️', color: '#6DD5B0', lightColor: '#88D8A3', bgColor: 'rgba(129, 236, 236, 0.15)' },
  { type: 'queue', id: 'queue', name: '排队情况', icon: '👥', color: '#FF8C69', lightColor: '#FF9A8B', bgColor: 'rgba(253, 121, 168, 0.15)' },
  { type: 'other', id: 'other', name: '其他', icon: '📝', color: '#A8C4D4', lightColor: '#C4D8E5', bgColor: 'rgba(168, 230, 207, 0.15)' }
]

const { STATUS_MAP } = require('../config/types')

// 按 type 查找
function getByType(type) {
  return NEED_TYPES.find(item => item.type === type || item.id === type) || null
}

// 按 status 查找
function getByStatus(status) {
  return STATUS_MAP[status] || { text: '未知', class: '', icon: '❓' }
}

module.exports = {
  NEED_TYPES,
  STATUS_MAP,
  getByType,
  getByStatus
}
