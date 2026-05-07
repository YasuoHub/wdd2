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

  // ===================== 回调通知地址（可选）=====================
  // 新版商家转账支持通过 notify_url 接收异步回调通知。
  // 但微信云开发的 HTTP 触发器在 2025 年后配置困难（入口变更/套餐限制），
  // 因此当前方案采用「不传 notify_url + 纯轮询」模式：
  //   - 前端轮询：用户确认收款后，前端每4秒查一次状态
  //   - 定时轮询：wdd-auto-cancel 每5分钟查一次 processing 状态的记录
  // 如需开启回调，取消下面注释并配置 HTTP 触发器：
  // NOTIFY_URL: 'https://wdd-2grpiy1r6f9f4cf2.service.tcloudbase.com/wdd-withdraw',

  // ===================== 商户私钥 =====================
  PRIVATE_KEY_PATH: '.cert/apiclient_key.pem',

  // ===================== 转账场景配置 =====================
  // 转账场景 ID（必填，需在商户平台「产品中心 → 商家转账 → 场景配置」中申请）
  // 当前配置：1005 = 佣金报酬
  TRANSFER_SCENE_ID: '1005',

  // 用户收款感知（展示给用户看的转账原因）
  USER_RECV_PERCEPTION: '佣金提现',

  // 转账备注
  DEFAULT_TRANSFER_REMARK: '提现到零钱',

  // 场景报备信息（必填，需与商户平台报备内容一致）
  TRANSFER_SCENE_REPORT_INFOS: [
    { info_type: '活动名称', info_content: '问当地用户提现' },
    { info_type: '奖励说明', info_content: '帮助者收益提现' }
  ]
}

module.exports = {
  WECHATPAY_CONFIG
}
