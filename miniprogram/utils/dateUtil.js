// 时间格式化工具函数
// 统一处理项目中各种时间展示场景，避免各页面重复定义

const DateUtil = {
  // 精确时间：YYYY-MM-DD HH:mm
  // 适用于：工单列表、工单详情等需要精确时间的场景
  formatDateTime(dateStr) {
    if (!dateStr) return ''
    const date = new Date(dateStr)
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
    if (!date) return ''

    const now = new Date()
    const msgTime = new Date(date)
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
    if (!date) return ''
    const d = new Date(date)
    const hours = d.getHours().toString().padStart(2, '0')
    const minutes = d.getMinutes().toString().padStart(2, '0')
    return `${hours}:${minutes}`
  },

  // 仅格式化日期为 M月D日
  // 适用于：聊天消息分隔线上的日期显示
  formatDate(date) {
    if (!date) return ''
    const d = new Date(date)
    return `${d.getMonth() + 1}月${d.getDate()}日`
  },

  // 判断两个日期是否为同一天
  isSameDay(date1, date2) {
    const d1 = new Date(date1)
    const d2 = new Date(date2)
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
