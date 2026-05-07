// 微信支付商户配置（仅用于「商家转账」新版接口）
//
// 重要：这些配置中：
//   - 公开信息（mchid、appid、serial_no）可以提交到代码仓库
//   - 商户私钥（apiclient_key.pem）必须放在 .cert/ 目录，被 .gitignore 排除
//   - APIv3 密钥从环境变量 WECHATPAY_API_KEY 读取（云开发控制台 → 云函数 → 配置 → 环境变量）

const WECHATPAY_CONFIG = {
  // 商户号（10位数字），与 wdd-payment/index.js 中的 SUB_MCH_ID 一致
  MCH_ID: '1112246384',

  // 小程序 AppID
  APP_ID: 'wx37902a802fff342d',

  // 商户 API 证书序列号（在商户平台 → API安全 → API证书 → 查看证书 中获取）
  // 也可用命令验证：openssl x509 -in .cert/apiclient_cert.pem -noout -serial
  SERIAL_NO: '6C3E1DBB05BFEB6F0ABCE303373F2EFB0E8AC275',

  // 微信支付 API 域名（主域名）
  API_HOST: 'https://api.mch.weixin.qq.com',

  // 备用域名（异地接入点，主域名故障时切换）
  API_HOST_BACKUP: 'https://api2.mch.weixin.qq.com',

  // ===================== 新版商家转账接口路径（2025升级后） =====================
  // 旧版路径（已停用）：/v3/transfer/batches
  // 新版路径：/v3/fund-app/mch-transfer/transfer-bills

  // 发起转账接口（单笔单据模式）
  TRANSFER_BILL_PATH: '/v3/fund-app/mch-transfer/transfer-bills',

  // 通过商户单号查询转账单
  TRANSFER_QUERY_BY_OUT_NO_PATH: '/v3/fund-app/mch-transfer/transfer-bills/out-bill-no',

  // ===================== 回调通知地址 =====================
  // 新版商家转账支持通过 notify_url 接收异步回调通知。
  // 需在云开发控制台开启 HTTP 触发器，路径：/wdd-withdraw
  NOTIFY_URL: 'https://wdd-2grpiy1r6f9f4cf2-1406090658.ap-shanghai.app.tcloudbase.com/wdd-withdraw',

  // ===================== 商户私钥 =====================
  PRIVATE_KEY_PATH: '.cert/apiclient_key.pem',

  // ===================== 转账场景配置 =====================
  // 转账场景 ID（必填，需在商户平台「产品中心 → 商家转账 → 场景配置」中申请）
  // 当前配置：1005 = 佣金报酬
  TRANSFER_SCENE_ID: '1005',

  // 用户收款感知：不传，使用 1005 场景默认文案「劳务报酬」

  // 转账备注
  DEFAULT_TRANSFER_REMARK: '提现到零钱',

  // 场景报备信息（必填，需与商户平台报备内容一致）
  TRANSFER_SCENE_REPORT_INFOS: [
    { info_type: '岗位类型', info_content: '信息提供者' },
    { info_type: '报酬说明', info_content: '信息悬赏报酬' }
  ]
}

module.exports = {
  WECHATPAY_CONFIG
}
