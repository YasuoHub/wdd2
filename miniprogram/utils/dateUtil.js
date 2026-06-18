// 时间格式化工具函数
// 统一处理项目中各种时间展示场景，避免各页面重复定义

const DateUtil = {
  // 统一解析云开发 Date、毫秒时间戳、ISO 字符串和常见日期对象
  parseDate(value) {
    if (!value) return null

    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value
    }

    if (typeof value === 'number') {
      const timestamp = value < 10000000000 ? value * 1000 : value
      const date = new Date(timestamp)
      return Number.isNaN(date.getTime()) ? null : date
    }

    if (typeof value === 'string') {
      const raw = value.trim()
      if (!raw) return null
      const normalized = raw.includes('T') ? raw : raw.replace(/-/g, '/')
      const date = new Date(normalized)
      return Number.isNaN(date.getTime()) ? null : date
    }

    if (typeof value === 'object') {
      const rawDate = value.$date || value._date || value.date || value.timestamp
      if (rawDate) return this.parseDate(rawDate)
      if (typeof value.seconds === 'number') return this.parseDate(value.seconds * 1000)
    }

    return null
  },

  // 精确时间：YYYY-MM-DD HH:mm
  // 适用于：工单列表、工单详情等需要精确时间的场景
  formatDateTime(dateStr) {
    const date = this.parseDate(dateStr)
    if (!date) return ''
    const year = date.getFullYear()
    const month = (date.getMonth() + 1).toString().padStart(2, '0')
    const day = date.getDate().toString().padStart(2, '0')
    const hours = date.getHours().toString().padStart(2, '0')
    const minutes = date.getMinutes().toString().padStart(2, '0')
    return `${year}-${month}-${day} ${hours}:${minutes}`
  },

  // 相对时间：刚刚、X分钟前、X小时前、昨天、X天前、M月D日
  // 适用于：消息列表、任务列表等需要友好展示的时间
  formatRelativeTime(date) {
    const msgTime = this.parseDate(date)
    if (!msgTime) return ''
    const now = new Date()
    const diff = now.getTime() - msgTime.getTime()

    // 小于1分钟
    if (diff < 60000) {
      return '刚刚'
    }

    // 小于1小时
    if (diff < 3600000) {
      return Math.floor(diff / 60000) + '分钟前'
    }

    // 小于24小时
    if (diff < 86400000) {
      return Math.floor(diff / 3600000) + '小时前'
    }

    // 昨天
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    if (this.isSameDay(yesterday, msgTime)) {
      return '昨天'
    }

    // 小于7天
    if (diff < 604800000) {
      return Math.floor(diff / 86400000) + '天前'
    }

    // 更早
    return `${msgTime.getMonth() + 1}月${msgTime.getDate()}日`
  },

  // 仅格式化时间为 HH:mm
  // 适用于：聊天消息气泡中的时间显示
  formatTime(date) {
    const d = this.parseDate(date)
    if (!d) return ''
    const hours = d.getHours().toString().padStart(2, '0')
    const minutes = d.getMinutes().toString().padStart(2, '0')
    return `${hours}:${minutes}`
  },

  // 仅格式化日期为 M月D日
  // 适用于：聊天消息分隔线上的日期显示
  formatDate(date) {
    const d = this.parseDate(date)
    if (!d) return ''
    return `${d.getMonth() + 1}月${d.getDate()}日`
  },

  // 判断两个日期是否为同一天
  isSameDay(date1, date2) {
    const d1 = this.parseDate(date1)
    const d2 = this.parseDate(date2)
    if (!d1 || !d2) return false
    return d1.getFullYear() === d2.getFullYear() &&
           d1.getMonth() === d2.getMonth() &&
           d1.getDate() === d2.getDate()
  },

  // 判断 date2 是否为 date1 的昨天
  isYesterday(date1, date2) {
    const yesterday = new Date(date1)
    yesterday.setDate(yesterday.getDate() - 1)
    return this.isSameDay(yesterday, date2)
  }
}

module.exports = DateUtil
