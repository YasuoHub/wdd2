// 日志封装：release 环境下屏蔽业务日志
const isRelease = (typeof __wxConfig !== 'undefined' && __wxConfig.envVersion === 'release')

const logger = {
  debug(...args) {
    if (!isRelease) {
      console.log(...args)
    }
  },
  info(...args) {
    if (!isRelease) {
      console.info(...args)
    }
  },
  warn(...args) {
    console.warn(...args)
  },
  error(...args) {
    console.error(...args)
  }
}

module.exports = {
  logger
}
