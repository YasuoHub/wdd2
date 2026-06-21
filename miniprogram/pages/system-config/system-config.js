const app = getApp()
const { callCloudFunction } = require('../../utils/cloud')

const DEFAULT_FORM = {
  platform_fee_rate: '',
  withdraw_fee_rate: '',
  withdraw_min_amount: '',
  withdraw_min_per_request: '',
  withdraw_max_per_request: '',
  withdraw_approval_threshold: '',
  withdraw_daily_limit: '',
  withdraw_daily_times: '',
  min_reward_amount: '',
  max_reward_amount: '',
  register_gift_balance: '',
  points_register: '',
  points_invite: '',
  points_signIn_daily: '',
  customer_service_openids: '',
  max_transfer_retry: '',
  transfer_backoff_minutes: '',
  transfer_query_timeout_minutes: ''
}

function formatArrayValue(value) {
  return Array.isArray(value) ? value.join(',') : ''
}

function splitNumberList(value, label) {
  const text = String(value || '').trim()
  if (!text) throw new Error(`${label}不能为空`)
  return text.split(/[\n,，\s]+/).map((item, index) => {
    const num = Number(item)
    if (!Number.isInteger(num) || num <= 0) {
      throw new Error(`${label}第${index + 1}项必须是正整数`)
    }
    return num
  })
}

function splitOpenids(value) {
  const text = String(value || '').trim()
  if (!text) return []
  return Array.from(new Set(text.split(/[\n,，\s]+/).map(item => item.trim()).filter(Boolean)))
}

function numberValue(form, key, label) {
  const num = Number(form[key])
  if (!Number.isFinite(num)) {
    throw new Error(`${label}必须是有效数字`)
  }
  return num
}

function integerValue(form, key, label) {
  const num = Number(form[key])
  if (!Number.isInteger(num)) {
    throw new Error(`${label}必须是整数`)
  }
  return num
}

Page({
  data: {
    pageLoading: true,
    saving: false,
    hasPermission: true,
    form: { ...DEFAULT_FORM }
  },

  onLoad() {
    this.loadConfig()
  },

  async loadConfig() {
    this.setData({ pageLoading: true, hasPermission: true })
    try {
      const { result } = await callCloudFunction({
        name: 'wdd-config-admin',
        data: { action: 'getConfigForAdmin' }
      })

      if (result.code === 0 && result.data) {
        const cfg = result.data
        const points = cfg.points || {}
        const signIn = points.signIn || {}
        this.setData({
          form: {
            platform_fee_rate: String(cfg.platform_fee_rate ?? ''),
            // 提现手续费率继续按 wdd-config 配置；当前仅停用提现最低门槛和人工审批。
            withdraw_fee_rate: String(cfg.withdraw_fee_rate ?? ''),
            withdraw_min_amount: '0.01',
            withdraw_min_per_request: String(cfg.withdraw_min_per_request ?? ''),
            withdraw_max_per_request: String(cfg.withdraw_max_per_request ?? ''),
            withdraw_approval_threshold: String(cfg.withdraw_approval_threshold ?? ''),
            withdraw_daily_limit: String(cfg.withdraw_daily_limit ?? ''),
            withdraw_daily_times: String(cfg.withdraw_daily_times ?? ''),
            min_reward_amount: String(cfg.min_reward_amount ?? ''),
            max_reward_amount: String(cfg.max_reward_amount ?? ''),
            register_gift_balance: String(cfg.register_gift_balance ?? ''),
            points_register: String(points.register ?? ''),
            points_invite: String(points.invite ?? ''),
            points_signIn_daily: formatArrayValue(signIn.daily),
            customer_service_openids: Array.isArray(cfg.customer_service_openids) ? cfg.customer_service_openids.join('\n') : '',
            max_transfer_retry: String(cfg.max_transfer_retry ?? ''),
            transfer_backoff_minutes: formatArrayValue(cfg.transfer_backoff_minutes),
            transfer_query_timeout_minutes: String(cfg.transfer_query_timeout_minutes ?? '')
          },
          pageLoading: false
        })
        return
      }

      if (result.code === 403) {
        this.setData({ hasPermission: false, pageLoading: false })
        return
      }

      throw new Error(result.message || '加载配置失败')
    } catch (err) {
      console.error('加载系统配置失败:', err)
      this.setData({ pageLoading: false })
      wx.showToast({
        title: err.message || '加载配置失败',
        icon: 'none'
      })
    }
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    this.setData({
      [`form.${key}`]: e.detail.value
    })
  },

  buildConfigPayload() {
    const form = this.data.form
    const payload = {
      platform_fee_rate: numberValue(form, 'platform_fee_rate', '平台服务费率'),
      // 提现手续费率继续按 wdd-config 配置；当前仅停用“余额满 X 元才可提现”的平台门槛。
      // 旧字段保留在 payload 中是为了兼容现有 wdd-config 结构，后续恢复时减少迁移成本。
      withdraw_fee_rate: numberValue(form, 'withdraw_fee_rate', '提现手续费率'),
      withdraw_min_amount: 0.01,
      withdraw_min_per_request: numberValue(form, 'withdraw_min_per_request', '微信单笔转账最低金额'),
      withdraw_max_per_request: numberValue(form, 'withdraw_max_per_request', '单次提现最高金额'),
      withdraw_approval_threshold: numberValue(form, 'withdraw_approval_threshold', '提现审批阈值'),
      withdraw_daily_limit: numberValue(form, 'withdraw_daily_limit', '单日提现金额上限'),
      withdraw_daily_times: integerValue(form, 'withdraw_daily_times', '单日提现次数上限'),
      min_reward_amount: numberValue(form, 'min_reward_amount', '最小悬赏金额'),
      max_reward_amount: numberValue(form, 'max_reward_amount', '最大悬赏金额'),
      register_gift_balance: numberValue(form, 'register_gift_balance', '注册赠送余额'),
      points: {
        register: integerValue(form, 'points_register', '注册奖励积分'),
        invite: integerValue(form, 'points_invite', '邀请奖励积分'),
        signIn: {
          daily: splitNumberList(form.points_signIn_daily, '连续签到积分')
        }
      },
      customer_service_openids: splitOpenids(form.customer_service_openids),
      max_transfer_retry: integerValue(form, 'max_transfer_retry', '最大转账重试次数'),
      transfer_backoff_minutes: splitNumberList(form.transfer_backoff_minutes, '转账重试间隔'),
      transfer_query_timeout_minutes: integerValue(form, 'transfer_query_timeout_minutes', '转账查询超时')
    }

    if (payload.platform_fee_rate < 0 || payload.platform_fee_rate > 1) {
      throw new Error('平台服务费率必须在 0 到 1 之间')
    }
    if (payload.withdraw_fee_rate < 0 || payload.withdraw_fee_rate > 1) {
      throw new Error('提现手续费率必须在 0 到 1 之间')
    }
    if (payload.min_reward_amount > payload.max_reward_amount) {
      throw new Error('最小悬赏金额不能大于最大悬赏金额')
    }
    if (payload.withdraw_min_per_request > payload.withdraw_max_per_request) {
      throw new Error('单次提现最低金额不能大于单次提现最高金额')
    }

    return payload
  },

  confirmSave() {
    let payload
    try {
      payload = this.buildConfigPayload()
    } catch (err) {
      wx.showToast({
        title: err.message,
        icon: 'none'
      })
      return
    }

    wx.showModal({
      title: '确认保存',
      content: '保存后会影响线上发布、提现、积分和客服权限，请确认配置无误。',
      confirmText: '保存',
      confirmColor: '#1677D2',
      success: (res) => {
        if (res.confirm) {
          this.saveConfig(payload)
        }
      }
    })
  },

  async saveConfig(payload) {
    if (this.data.saving) return
    this.setData({ saving: true })
    wx.showLoading({ title: '保存中...' })

    try {
      const { result } = await callCloudFunction({
        name: 'wdd-config-admin',
        data: {
          action: 'updateConfig',
          config: payload
        }
      })

      wx.hideLoading()
      this.setData({ saving: false })

      if (result.code === 0) {
        wx.showToast({
          title: '保存成功',
          icon: 'success'
        })
        app.loadPlatformConfig()
        this.loadConfig()
        return
      }

      throw new Error(result.message || '保存失败')
    } catch (err) {
      wx.hideLoading()
      this.setData({ saving: false })
      wx.showToast({
        title: err.message || '保存失败',
        icon: 'none'
      })
    }
  }
})
