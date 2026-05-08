// 微信支付商户配置（仅用于「商家转账」新版接口）
//
// 重要：敏感配置通过云函数环境变量注入，不在代码中明文存储：
//   - MCH_ID     → 环境变量 WECHATPAY_MCH_ID
//   - SERIAL_NO  → 环境变量 WECHATPAY_SERIAL_NO
//   - NOTIFY_URL → 环境变量 WECHATPAY_NOTIFY_URL
//   - API_KEY    → 环境变量 WECHATPAY_API_KEY
//   - 商户私钥（apiclient_key.pem）放在 .cert/ 目录，被 .gitignore 排除

function getEnv(name, fallback = '') {
  return process.env[name] || fallback
}

const WECHATPAY_CONFIG = {
  // 商户号（10位数字），与 wdd-payment/index.js 中的 SUB_MCH_ID 一致
  get MCH_ID() { return getEnv('WECHATPAY_MCH_ID') },

  // 小程序 AppID
  APP_ID: 'wx37902a802fff342d',

  // 商户 API 证书序列号
  get SERIAL_NO() { return getEnv('WECHATPAY_SERIAL_NO') },

  // 微信支付 API 域名（主域名）
  API_HOST: 'https://api.mch.weixin.qq.com',

  // 备用域名（异地接入点，主域名故障时切换）
  API_HOST_BACKUP: 'https://api2.mch.weixin.qq.com',

  // ===================== 新版商家转账接口路径（2025升级后） =====================
  TRANSFER_BILL_PATH: '/v3/fund-app/mch-transfer/transfer-bills',
  TRANSFER_QUERY_BY_OUT_NO_PATH: '/v3/fund-app/mch-transfer/transfer-bills/out-bill-no',

  // ===================== 回调通知地址 =====================
  get NOTIFY_URL() { return getEnv('WECHATPAY_NOTIFY_URL') },

  // ===================== 商户私钥 =====================
  PRIVATE_KEY_PATH: '.cert/apiclient_key.pem',

  // ===================== 转账场景配置 =====================
  TRANSFER_SCENE_ID: '1005',
  DEFAULT_TRANSFER_REMARK: '提现到零钱',
  TRANSFER_SCENE_REPORT_INFOS: [
    { info_type: '岗位类型', info_content: '信息提供者' },
    { info_type: '报酬说明', info_content: '信息悬赏报酬' }
  ]
}

module.exports = {
  WECHATPAY_CONFIG
}
