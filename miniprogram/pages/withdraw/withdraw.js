// 提现页面
const app = getApp()
const { PLATFORM_RULES, MoneyUtils } = require('../../utils/platformRules')

Page({
  data: {
    // 用户余额
    balance: 0,

    // 提现金额
    withdrawAmount: '',

    // 计算值
    withdrawFee: '0.00',
    actualAmount: '0.00',

    // 平台规则
    withdrawMinAmount: PLATFORM_RULES.WITHDRAW_MIN_AMOUNT,
    withdrawFeeRate: Math.round(PLATFORM_RULES.WITHDRAW_FEE_RATE * 100),
    withdrawMinPerRequest: PLATFORM_RULES.WITHDRAW_MIN_PER_REQUEST,
    withdrawMaxPerRequest: PLATFORM_RULES.WITHDRAW_MAX_PER_REQUEST,

    // 状态
    canSubmit: false,
    isSubmitting: false,

    // 错误提示
    errorTip: ''
  },

  onLoad() {
    this.loadBalance()
  },

  onShow() {
    this.loadBalance()
  },

  // 加载余额
  async loadBalance() {
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-notify',
        data: { action: 'getUserInfo' }
      })

      if (result.code === 0 && result.data.userInfo) {
        const balance = result.data.userInfo.balance || 0
        this.setData({ balance })
      }
    } catch (err) {
      console.error('加载余额失败:', err)
    }
  },

  // 输入提现金额
  onAmountInput(e) {
    let value = e.detail.value

    // 只允许数字和小数点
    value = value.replace(/[^0-9.]/g, '')

    // 确保只有一个小数点
    const parts = value.split('.')
    if (parts.length > 2) {
      value = parts[0] + '.' + parts.slice(1).join('')
    }

    // 限制小数位数为2位
    if (parts[1] && parts[1].length > 2) {
      value = parts[0] + '.' + parts[1].slice(0, 2)
    }

    // 限制最大金额
    const numValue = parseFloat(value) || 0
    if (numValue > this.data.balance) {
      value = String(this.data.balance)
    }
    if (numValue > PLATFORM_RULES.WITHDRAW_MAX_PER_REQUEST) {
      value = String(PLATFORM_RULES.WITHDRAW_MAX_PER_REQUEST)
    }

    this.setData({ withdrawAmount: value })
    this.calculateFee()
    this.checkCanSubmit()
  },

  // 全部提现
  withdrawAll() {
    const maxAmount = Math.min(
      this.data.balance,
      PLATFORM_RULES.WITHDRAW_MAX_PER_REQUEST
    )
    const amount = MoneyUtils.formatAmount(maxAmount)
    this.setData({ withdrawAmount: amount })
    this.calculateFee()
    this.checkCanSubmit()
  },

  // 计算手续费和到账金额
  calculateFee() {
    const amount = parseFloat(this.data.withdrawAmount) || 0
    const fee = MoneyUtils.calcWithdrawFee(amount)
    const actual = MoneyUtils.calcWithdrawActual(amount)

    this.setData({
      withdrawFee: MoneyUtils.formatAmount(fee),
      actualAmount: MoneyUtils.formatAmount(actual)
    })
  },

  // 检查是否可以提交
  checkCanSubmit() {
    const amount = parseFloat(this.data.withdrawAmount) || 0
    const check = MoneyUtils.checkWithdrawAmount(amount, this.data.balance)

    this.setData({
      canSubmit: check.valid,
      errorTip: check.valid ? '' : check.reason
    })
  },

  // 提交提现申请
  async handleSubmit() {
    if (!this.data.canSubmit || this.data.isSubmitting) return

    const amount = parseFloat(this.data.withdrawAmount)

    // 二次确认
    wx.showModal({
      title: '确认提现',
      content: `提现金额：¥${amount}\n手续费：¥${this.data.withdrawFee}\n实际到账：¥${this.data.actualAmount}`,
      confirmText: '确认提现',
      confirmColor: '#5DB8E6',
      success: async (res) => {
        if (res.confirm) {
          await this.doWithdraw(amount)
        }
      }
    })
  },

  // 执行提现
  async doWithdraw(amount) {
    this.setData({ isSubmitting: true })
    wx.showLoading({ title: '提交中...', mask: true })

    let withdrawId = null

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-withdraw',
        data: {
          action: 'apply',
          amount: amount
        },
        timeout: 20000
      })

      wx.hideLoading()

      if (result.code !== 0) {
        this.setData({ isSubmitting: false })
        wx.showToast({
          title: result.message || '提现失败',
          icon: 'none',
          duration: 3000
        })
        return
      }

      withdrawId = result.data.withdrawId
      const packageInfo = result.data.packageInfo
      const mchId = result.data.mchId
      const appId = result.data.appId

      if (!packageInfo || !mchId || !appId) {
        this.setData({ isSubmitting: false })
        wx.showToast({
          title: '获取转账信息失败',
          icon: 'none',
          duration: 3000
        })
        return
      }

      // 新版商家转账：调起用户确认收款页面
      await this.requestMerchantTransfer(mchId, appId, packageInfo, withdrawId)

    } catch (err) {
      wx.hideLoading()
      this.setData({ isSubmitting: false })
      wx.showToast({
        title: err.message || '提现失败',
        icon: 'none',
        duration: 3000
      })
    }
  },

  // 调起微信确认收款页面（新版商家转账必需步骤）
  requestMerchantTransfer(mchId, appId, packageInfo, withdrawId) {
    return new Promise((resolve) => {
      // 使用新版商家转账 JSAPI 调起确认页面
      // eslint-disable-next-line
      if (typeof wx.requestMerchantTransfer !== 'function') {
        this.setData({ isSubmitting: false })
        wx.showModal({
          title: '提示',
          content: '当前微信版本不支持此功能，请升级微信后重试',
          showCancel: false
        })
        resolve()
        return
      }

      wx.requestMerchantTransfer({
        mchId: mchId,
        appId: appId,
        package: packageInfo,
        success: (res) => {
          console.log('用户确认收款成功:', res)
          // 用户确认成功，开始轮询到账状态
          wx.showLoading({ title: '打款中...', mask: true })
          this._pollStopped = false
          this.pollWithdrawStatus(withdrawId)
          resolve()
        },
        fail: (err) => {
          console.error('用户取消或未确认收款:', err)
          this.setData({ isSubmitting: false })

          // 用户取消确认，提示可在钱包中重新发起
          wx.showModal({
            title: '未确认收款',
            content: '您尚未确认收款，可在「我的-钱包」中查看并重新确认',
            showCancel: false,
            success: () => {
              wx.navigateBack()
            }
          })
          resolve()
        }
      })
    })
  },

  // 轮询打款状态：每 4 秒查一次，最多 30 次（2 分钟）；连续 3 次拿不到结果即终止
  async pollWithdrawStatus(withdrawId) {
    const MAX_ATTEMPTS = 30
    const INTERVAL_MS = 4000
    const MAX_CONSECUTIVE_FAILS = 3
    let attempts = 0
    let consecutiveFails = 0

    const finish = (title, content) => {
      this._pollStopped = true
      wx.hideLoading()
      this.setData({ isSubmitting: false })
      wx.showModal({
        title,
        content,
        showCancel: false,
        success: () => wx.navigateBack()
      })
    }

    const tick = async () => {
      if (this._pollStopped) return
      if (attempts >= MAX_ATTEMPTS) {
        finish('处理中', '打款仍在处理，可稍后在「我的-钱包」中查看进度。')
        return
      }
      attempts++

      try {
        const { result } = await wx.cloud.callFunction({
          name: 'wdd-withdraw',
          data: { action: 'getWithdrawStatus', withdrawId }
        })

        if (this._pollStopped) return

        if (result && result.code === 0) {
          consecutiveFails = 0
          const { status, rejectReason } = result.data
          if (status === 'completed') {
            finish('已到账', '提现已到账，请在微信「服务通知」中查看到账信息。')
            return
          }
          if (status === 'rejected') {
            finish('打款失败', (rejectReason || '打款失败') + '，金额已退回到余额。')
            return
          }
          if (status === 'transfer_failed') {
            finish('打款异常', '打款多次失败，请联系客服处理。')
            return
          }
          // processing / transfer_pending → 继续轮询
        } else {
          consecutiveFails++
          if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
            finish('查询失败', '无法查询提现状态，请稍后在「我的-钱包」中查看进度。')
            return
          }
        }
      } catch (err) {
        console.warn('查询提现状态失败:', err)
        consecutiveFails++
        if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
          finish('网络异常', '无法查询提现状态，请稍后在「我的-钱包」中查看进度。')
          return
        }
      }

      setTimeout(tick, INTERVAL_MS)
    }

    tick()
  },

  onUnload() {
    // 离开页面时停止轮询，避免无效请求
    this._pollStopped = true
  }
})
