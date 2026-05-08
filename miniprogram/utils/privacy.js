// 隐私授权封装
// 在调用 wx.getLocation / chooseLocation / chooseImage / chooseMedia 前使用

/**
 * 检查隐私授权设置（微信 3.0.0+）
 * 先查询是否需要授权，需要时会尝试拉起授权弹窗
 */
function checkPrivacyAuthorize() {
  return new Promise((resolve, reject) => {
    // 1. 先查询是否需要隐私授权
    if (wx.getPrivacySetting) {
      wx.getPrivacySetting({
        success: (res) => {
          if (!res.needAuthorization) {
            // 不需要授权，直接放行
            resolve()
            return
          }
          // 2. 需要授权时，拉起授权弹窗
          if (wx.requirePrivacyAuthorize) {
            wx.requirePrivacyAuthorize({
              success: resolve,
              fail: (err) => {
                // errno 112 = 后台未配置隐私保护指引
                if (err.errno === 112) {
                  console.error('【重要】小程序后台《隐私保护指引》未配置，请在微信公众平台设置')
                }
                reject(err)
              }
            })
          } else {
            reject(new Error('当前微信版本不支持隐私授权'))
          }
        },
        fail: () => {
          // 查询失败时降级：直接尝试拉起授权
          if (wx.requirePrivacyAuthorize) {
            wx.requirePrivacyAuthorize({ success: resolve, fail: reject })
          } else {
            resolve()
          }
        }
      })
    } else if (wx.requirePrivacyAuthorize) {
      // 旧版本：直接拉起授权
      wx.requirePrivacyAuthorize({ success: resolve, fail: reject })
    } else {
      // 更低版本直接放行
      resolve()
    }
  })
}

// 保持兼容旧引用
function requirePrivacyAuthorize() {
  return checkPrivacyAuthorize()
}

module.exports = {
  checkPrivacyAuthorize,
  requirePrivacyAuthorize
}
