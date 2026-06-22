// 钱包/余额页面
const app = getApp()
const { PLATFORM_RULES, MoneyUtils } = require('../../utils/platformRules')

function toAmount(value) {
  return Math.round((Number(value) || 0) * 100) / 100
}

Page({
  data: {
    // 余额信息
    balance: 0,
    frozenBalance: 0,
    availableBalance: 0,
    deductionBalance: 0,
    frozenDeductionBalance: 0,
    availableDeductionBalance: 0,
    totalEarned: 0,
    totalWithdrawn: 0,
    totalPaid: 0,

    // 平台规则
    withdrawMinAmount: PLATFORM_RULES.WITHDRAW_MIN_AMOUNT,
    withdrawFeeRate: Math.round(PLATFORM_RULES.WITHDRAW_FEE_RATE * 100),
    withdrawMinPerRequest: PLATFORM_RULES.WITHDRAW_MIN_PER_REQUEST,
    withdrawMaxPerRequest: PLATFORM_RULES.WITHDRAW_MAX_PER_REQUEST,
    withdrawApprovalThreshold: PLATFORM_RULES.WITHDRAW_APPROVAL_THRESHOLD,
    withdrawDailyLimit: PLATFORM_RULES.WITHDRAW_DAILY_LIMIT,
    withdrawDailyTimes: PLATFORM_RULES.WITHDRAW_DAILY_TIMES,

    // 提现条件
    canWithdraw: false,
    withdrawTip: '',
    quotaLoaded: false,
    quotaLoading: false,
    quotaTip: '',
    canApplyByQuota: true,
    todayWithdrawAmount: 0,
    todayWithdrawCount: 0,
    remainingDailyAmount: PLATFORM_RULES.WITHDRAW_DAILY_LIMIT,
    remainingDailyTimes: PLATFORM_RULES.WITHDRAW_DAILY_TIMES,
    dailyAmountLimitEnabled: true,
    dailyTimesLimitEnabled: true,

    // 账单列表
    records: [],
    loading: false,
    hasMore: true,
    page: 0,
    pageSize: 20,

    // 申请记录
    // 当前审核版本停用人工资金审批：用户可提现余额在每日限额内直接走微信确认收款。
    // 以下数据字段保留，便于后续如果恢复“大额人工复核”时少改动。
    applications: [],
    appLoading: false,
    appHasMore: true,
    appPage: 0,
    appPageSize: 20,

    // 申请提现弹窗
    showApplyModal: false,
    applyAmount: '',
    applyFee: '0.00',
    applyActual: '0.00',
    canSubmitApply: false,
    applyErrorTip: '',
    isSubmitting: false,
    // 旧字段：提现审批提示状态。当前版本不再按审批阈值分流，保留字段兼容旧 WXML/样式。
    needApproval: false,

    // 提现规则弹窗
    showRulesModal: false,

    // 用户信息
    userInfo: {}
  },

  async onLoad() {
    this.loadUserInfo()
    await this.applyPlatformConfig()
    await Promise.all([
      this.loadBalance(),
      this.loadQuotaStatus(),
      this.loadRecords()
    ])
    // 为避免审核认为“可提现余额需人工审批后才能提现”，当前版本不加载资金审批申请记录。
    // 如后续恢复大额人工复核，可取消下一行注释。
    // this.loadApplications(true)
  },

  async onShow() {
    await this.applyPlatformConfig()
    await Promise.all([
      this.loadBalance(),
      this.loadQuotaStatus(),
      this.loadRecords(true)
    ])
    // 为避免审核认为“可提现余额需人工审批后才能提现”，当前版本不加载资金审批申请记录。
    // 如后续恢复大额人工复核，可取消下一行注释。
    // this.loadApplications(true)
  },

  // 应用平台配置到页面数据（从数据库动态加载的费率/阈值）
  async applyPlatformConfig() {
    if (app && typeof app.loadPlatformConfig === 'function') {
      await app.loadPlatformConfig()
    }
    this.setData({
      withdrawMinAmount: PLATFORM_RULES.WITHDRAW_MIN_AMOUNT,
      withdrawFeeRate: Math.round(PLATFORM_RULES.WITHDRAW_FEE_RATE * 100),
      withdrawMinPerRequest: PLATFORM_RULES.WITHDRAW_MIN_PER_REQUEST,
      withdrawMaxPerRequest: PLATFORM_RULES.WITHDRAW_MAX_PER_REQUEST,
      withdrawApprovalThreshold: PLATFORM_RULES.WITHDRAW_APPROVAL_THRESHOLD,
      withdrawDailyLimit: PLATFORM_RULES.WITHDRAW_DAILY_LIMIT,
      withdrawDailyTimes: PLATFORM_RULES.WITHDRAW_DAILY_TIMES
    })
  },

  // 加载用户信息
  loadUserInfo() {
    const userInfo = app.getUserInfo()
    if (userInfo) {
      this.setData({ userInfo })
    }
  },

  // 加载余额信息
  async loadBalance() {
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-notify',
        data: { action: 'getUserInfo' }
      })

      if (result.code === 0 && result.data.userInfo) {
        const userInfo = result.data.userInfo
        const balance = toAmount(userInfo.balance)
        const frozenBalance = toAmount(userInfo.frozen_balance)
        const availableBalance = toAmount(balance - frozenBalance)
        const deductionBalance = toAmount(userInfo.deduction_balance)
        const frozenDeductionBalance = toAmount(userInfo.frozen_deduction_balance)
        const availableDeductionBalance = toAmount(deductionBalance - frozenDeductionBalance)

        this.setData({
          balance: balance,
          frozenBalance: frozenBalance,
          availableBalance: availableBalance,
          deductionBalance,
          frozenDeductionBalance,
          availableDeductionBalance,
          totalEarned: userInfo.total_earned || 0,
          totalWithdrawn: userInfo.total_withdrawn || 0,
          totalPaid: userInfo.total_paid || 0,
          userInfo: userInfo
        })
        this.refreshWithdrawEligibility()

        // 更新全局数据
        app.updateUserInfo(userInfo)
      }
    } catch (err) {
      console.error('加载余额失败:', err)
    }
  },

  async loadQuotaStatus() {
    if (this.data.quotaLoading) return
    this.setData({ quotaLoading: true })

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-withdraw',
        data: { action: 'getQuotaStatus' }
      })

      if (result.code === 0 && result.data) {
        const quota = result.data
        this.setData({
          quotaLoaded: true,
          quotaLoading: false,
          quotaTip: quota.tip || '',
          canApplyByQuota: quota.canApply !== false,
          todayWithdrawAmount: quota.usedAmount || 0,
          todayWithdrawCount: quota.usedCount || 0,
          remainingDailyAmount: typeof quota.remainingAmount === 'number'
            ? quota.remainingAmount
            : PLATFORM_RULES.WITHDRAW_DAILY_LIMIT,
          remainingDailyTimes: typeof quota.remainingTimes === 'number'
            ? quota.remainingTimes
            : PLATFORM_RULES.WITHDRAW_DAILY_TIMES,
          dailyAmountLimitEnabled: quota.amountLimitEnabled !== false,
          dailyTimesLimitEnabled: quota.timesLimitEnabled !== false
        })
      } else {
        this.setData({
          quotaLoaded: false,
          quotaLoading: false,
          canApplyByQuota: true,
          quotaTip: ''
        })
      }
    } catch (err) {
      console.error('加载提现配额失败:', err)
      this.setData({
        quotaLoaded: false,
        quotaLoading: false,
        canApplyByQuota: true,
        quotaTip: ''
      })
    }

    this.refreshWithdrawEligibility()
  },

  refreshWithdrawEligibility() {
    const withdrawCheck = MoneyUtils.checkCanWithdraw(this.data.availableBalance)
    if (!withdrawCheck.canWithdraw) {
      this.setData({
        canWithdraw: false,
        withdrawTip: withdrawCheck.reason
      })
      return
    }

    if (this.data.quotaLoaded && !this.data.canApplyByQuota) {
      this.setData({
        canWithdraw: false,
        withdrawTip: this.data.quotaTip || '今日提现额度已用完，请明天再试'
      })
      return
    }

    this.setData({
      canWithdraw: true,
      withdrawTip: ''
    })
  },

  getMaxApplyAmount() {
    const limits = [
      toAmount(this.data.availableBalance),
      toAmount(PLATFORM_RULES.WITHDRAW_MAX_PER_REQUEST)
    ]
    if (this.data.dailyAmountLimitEnabled) {
      limits.push(toAmount(this.data.remainingDailyAmount))
    }
    return toAmount(Math.max(0, Math.min(...limits)))
  },

  getAmountLimitReason(maxAmount) {
    const maxText = MoneyUtils.formatAmount(maxAmount)
    if (this.data.dailyAmountLimitEnabled && maxAmount === toAmount(this.data.remainingDailyAmount)) {
      return `提现金额不能超过今日剩余额度 ¥${maxText}`
    }
    return `本次最多可提现 ¥${maxText}`
  },

  // 加载申请记录
  // 当前审核版本停用人工资金审批，函数保留但入口不再调用。
  // 保留原因：后续如果恢复“大额提现人工复核”，可直接恢复调用并沿用旧申请记录展示。
  async loadApplications(reset = false) {
    if (this.data.appLoading) return

    const page = reset ? 0 : this.data.appPage

    this.setData({ appLoading: true })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-withdraw-approval',
        data: {
          action: 'getMyApplications',
          page: page,
          pageSize: this.data.appPageSize
        }
      })
      if (result.code === 0) {
        const resultData = result.data || {}
        const now = new Date()
        const newApplications = (resultData.records || []).map(item => {
          const expireTime = item.expireTime ? new Date(item.expireTime.replace(/-/g, '/')) : null
          const isExpired = item.status === 'approved' && item.withdrawStatus === 'not_withdrawn' && expireTime && expireTime < now
          let expireCountdown = ''
          if (item.status === 'approved' && item.withdrawStatus === 'not_withdrawn' && expireTime && !isExpired) {
            const diffMs = expireTime - now
            if (diffMs > 0) {
              const days = Math.floor(diffMs / (1000 * 60 * 60 * 24))
              const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))
              expireCountdown = days > 0 ? `${days}天${hours}小时` : `${hours}小时`
            }
          }
          return {
            ...item,
            expireTimeStr: item.expireTime || '',
            isExpired,
            expireCountdown
          }
        })
        this.setData({
          applications: reset ? newApplications : [...this.data.applications, ...newApplications],
          appPage: page + 1,
          appHasMore: typeof resultData.hasMore === 'boolean'
            ? resultData.hasMore
            : newApplications.length >= this.data.appPageSize,
          appLoading: false
        })
      } else {
        this.setData({ appLoading: false })
      }
    } catch (err) {
      console.error('加载申请记录失败:', err)
      this.setData({ appLoading: false })
    }
  },

  // 加载账单记录
  async loadRecords(reset = false) {
    if (this.data.loading) return

    const page = reset ? 0 : this.data.page

    this.setData({ loading: true })

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-get-point-records',
        data: {
          action: 'getBalanceRecords',
          page: page,
          pageSize: this.data.pageSize
        }
      })

      if (result.code === 0) {
        const resultData = result.data || {}
        const newRecords = (resultData.records || []).map(item => this.normalizeBalanceRecord(item))

        this.setData({
          records: reset ? newRecords : [...this.data.records, ...newRecords],
          page: page + 1,
          hasMore: typeof resultData.hasMore === 'boolean'
            ? resultData.hasMore
            : newRecords.length >= this.data.pageSize,
          loading: false
        })
      } else {
        this.setData({ loading: false })
      }
    } catch (err) {
      console.error('加载账单失败:', err)
      this.setData({ loading: false })
    }
  },

  // 下拉刷新
  async onPullDownRefresh() {
    await this.loadBalance()
    await this.loadQuotaStatus()
    await this.loadRecords(true)
    // 当前审核版本停用人工资金审批，不刷新旧审批申请记录。
    // await this.loadApplications(true)
    wx.stopPullDownRefresh()
  },

  // 加载更多申请记录
  // 当前审核版本停用人工资金审批，函数保留供后续恢复旧审批列表时使用。
  loadMoreApplications() {
    if (this.data.appHasMore && !this.data.appLoading) {
      this.loadApplications()
    }
  },

  // 加载更多收支记录
  loadMoreRecords() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadRecords()
    }
  },

  // 显示申请提现弹窗
  async showApplyModal() {
    await this.loadQuotaStatus()
    if (!this.data.canWithdraw) {
      wx.showToast({
        title: this.data.withdrawTip,
        icon: 'none',
        duration: 2000
      })
      return
    }
    this.setData({
      showApplyModal: true,
      applyAmount: '',
      applyFee: '0.00',
      applyActual: '0.00',
      canSubmitApply: false,
      applyErrorTip: '',
      isSubmitting: false,
      needApproval: false
    })
  },

  hideApplyModal() {
    this.setData({ showApplyModal: false })
  },

  // 输入申请金额
  onApplyAmountInput(e) {
    let value = e.detail.value
    value = value.replace(/[^0-9.]/g, '')
    const parts = value.split('.')
    if (parts.length > 2) {
      value = parts[0] + '.' + parts.slice(1).join('')
    }
    if (parts[1] && parts[1].length > 2) {
      value = parts[0] + '.' + parts[1].slice(0, 2)
    }

    const numValue = parseFloat(value) || 0
    const maxAvailable = this.getMaxApplyAmount()
    if (numValue > maxAvailable) {
      value = MoneyUtils.formatAmount(maxAvailable)
    }

    this.setData({ applyAmount: value })
    this.calcApplyFee()
    this.checkCanSubmitApply()
  },

  // 全部提现
  withdrawAll() {
    const maxAmount = this.getMaxApplyAmount()
    const amount = MoneyUtils.formatAmount(maxAmount)
    this.setData({ applyAmount: amount })
    this.calcApplyFee()
    this.checkCanSubmitApply()
  },

  calcApplyFee() {
    const amount = parseFloat(this.data.applyAmount) || 0
    const fee = MoneyUtils.calcWithdrawFee(amount)
    const actual = MoneyUtils.calcWithdrawActual(amount)
    this.setData({
      applyFee: MoneyUtils.formatAmount(fee),
      applyActual: MoneyUtils.formatAmount(actual)
    })
  },

  checkCanSubmitApply() {
    const amount = parseFloat(this.data.applyAmount) || 0
    const maxAmount = this.getMaxApplyAmount()
    const check = MoneyUtils.checkWithdrawAmount(amount, this.data.availableBalance)
    let valid = check.valid
    let reason = check.reason

    if (valid && this.data.quotaLoaded && !this.data.canApplyByQuota) {
      valid = false
      reason = this.data.quotaTip || '今日提现额度已用完，请明天再试'
    }

    if (valid && amount > maxAmount) {
      valid = false
      reason = this.getAmountLimitReason(maxAmount)
    }

    this.setData({
      canSubmitApply: valid,
      applyErrorTip: valid ? '' : reason,
      needApproval: false
    })
  },

  // 提交提现申请
  // 当前审核版本不再区分“即时提现/审批提现”，所有提现在每日限额内直接进入微信提现确认流程。
  async submitApply() {
    if (!this.data.canSubmitApply || this.data.isSubmitting) return

    const amount = parseFloat(this.data.applyAmount)

    await this.doWithdraw(amount)

    /*
     * 旧资金审批分流逻辑已停用。
     * 停用原因：微信审核反馈提现服务存在提现门槛/无法即时提现风险。
     * 当前版本要求“可提现余额大于 0 且未超过每日限额即可直接提现”，不再因金额超过阈值提交人工审批。
     * 后续如恢复大额人工复核，可重新启用下方代码，并同步更新审核材料和页面规则文案。
     *
     * const threshold = this.data.withdrawApprovalThreshold
     * if (amount <= threshold) {
     *   this.setData({ showApplyModal: false })
     *   wx.navigateTo({
     *     url: `/pages/withdraw/withdraw?amount=${amount}`
     *   })
     *   return
     * }
     *
     * wx.showModal({
     *   title: '确认申请',
     *   content: `提现金额 ${amount} 元（手续费 ${this.data.applyFee} 元，到账 ${this.data.applyActual} 元），单笔超过 ${threshold} 元需管理员审批，确认提交？`,
     *   confirmText: '确认申请',
     *   confirmColor: '#1677D2',
     *   success: async (res) => {
     *     if (res.confirm) {
     *       await this.doApply(amount)
     *     }
     *   }
     * })
   */
  },

  // 在钱包提现弹窗内直接执行提现，不再跳转独立提现页。
  async doWithdraw(amount) {
    this.setData({ isSubmitting: true })
    wx.showLoading({ title: '提交中...', mask: true })

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
        this.loadBalance()
        this.loadQuotaStatus()
        wx.showToast({
          title: result.message || '提现失败',
          icon: 'none',
          duration: 3000
        })
        return
      }

      const withdrawId = result.data.withdrawId
      const packageInfo = result.data.packageInfo
      const mchId = result.data.mchId
      const appId = result.data.appId

      if (!packageInfo || !mchId || !appId) {
        this.setData({ isSubmitting: false })
        this.loadBalance()
        this.loadQuotaStatus()
        wx.showToast({
          title: '获取转账信息失败',
          icon: 'none',
          duration: 3000
        })
        return
      }

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

  // 调起微信提现确认收款页面。
  requestMerchantTransfer(mchId, appId, packageInfo, withdrawId) {
    return new Promise((resolve) => {
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
        mchId,
        appId,
        package: packageInfo,
        success: () => {
          wx.showLoading({ title: '打款中...', mask: true })
          this._pollStopped = false
          this.pollWithdrawStatus(withdrawId)
          resolve()
        },
        fail: () => {
          this.setData({ isSubmitting: false })
          this.loadBalance()
          this.loadQuotaStatus()
          this.loadRecords(true)
          wx.showModal({
            title: '未确认收款',
            content: '您尚未确认收款，本次提现已进入处理中。系统会继续查询微信结果；如长时间未到账或未退回，请联系客服处理。',
            showCancel: false
          })
          resolve()
        }
      })
    })
  },

  // 轮询提现状态：成功或失败后刷新钱包余额和流水。
  async pollWithdrawStatus(withdrawId) {
    const MAX_ATTEMPTS = 30
    const INTERVAL_MS = 4000
    const MAX_CONSECUTIVE_FAILS = 3
    let attempts = 0
    let consecutiveFails = 0

    const finish = (title, content, shouldCloseModal = false) => {
      this._pollStopped = true
      wx.hideLoading()
      this.setData({
        isSubmitting: false,
        showApplyModal: shouldCloseModal ? false : this.data.showApplyModal,
        applyAmount: shouldCloseModal ? '' : this.data.applyAmount
      })
      this.loadBalance()
      this.loadQuotaStatus()
      this.loadRecords(true)
      wx.showModal({
        title,
        content,
        showCancel: false
      })
    }

    const tick = async () => {
      if (this._pollStopped) return
      if (attempts >= MAX_ATTEMPTS) {
        finish('处理中', '打款仍在处理，可稍后在钱包收支明细中查看进度。', true)
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
            finish('已到账', '提现已到账，请在微信「服务通知」中查看到账信息。', true)
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
        } else {
          consecutiveFails++
          if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
            finish('查询失败', '无法查询提现状态，请稍后在钱包中查看进度。', true)
            return
          }
        }
      } catch (err) {
        console.warn('查询提现状态失败:', err)
        consecutiveFails++
        if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
          finish('网络异常', '无法查询提现状态，请稍后在钱包中查看进度。', true)
          return
        }
      }

      setTimeout(tick, INTERVAL_MS)
    }

    tick()
  },

  // 旧资金审批申请提交逻辑已停用。
  // 保留原因：后续如果恢复“大额提现人工复核”，可重新启用该函数和 wdd-withdraw-approval 云函数。
  // 当前版本不调用该函数，避免用户可提现余额被人工审批流程阻断。
  async doApply(amount) {
    wx.showToast({
      title: '当前版本已停用人工审批，请直接提现',
      icon: 'none'
    })

    /*
     * 旧资金审批申请提交实现。
     * 停用原因：微信审核整改要求可提现余额在额度内直接进入微信提现确认收款流程。
     * 后续恢复大额人工复核时，可移除上方停用提示并恢复下方代码。
     *
    this.setData({ isSubmitting: true })

    try {
      const { result } = await wx.cloud.callFunction({
        name: 'wdd-withdraw-approval',
        data: {
          action: 'apply',
          amount: amount
        }
      })

      if (result.code === 0) {
        this.setData({ showApplyModal: false })
        wx.showToast({ title: '申请已提交', icon: 'success' })
        this.loadApplications(true)
      } else {
        wx.showToast({ title: result.message, icon: 'none', duration: 3000 })
      }
    } catch (err) {
      wx.showToast({ title: '提交失败', icon: 'none' })
    }

    this.setData({ isSubmitting: false })
     */
  },

  // 跳转到提现页面（旧审批通过后发起真实提现）
  // 当前审核版本不展示审批申请记录，此函数保留供后续恢复旧审批流程。
  goToWithdraw(e) {
    const { id } = e.currentTarget.dataset
    if (!id) return
    wx.navigateTo({
      url: `/pages/withdraw/withdraw?applicationId=${id}`
    })
  },

  // 显示提现规则
  showWithdrawRules() {
    this.setData({ showRulesModal: true })
  },

  hideRulesModal() {
    this.setData({ showRulesModal: false })
  },

  onUnload() {
    this._pollStopped = true
  },

  normalizeBalanceRecord(item) {
    const title = item.title || ''
    const amount = Number(item.amount || 0)
    const isIncome = amount >= 0
    const fallback = isIncome
      ? { icon: 'circle-dollar-sign', color: 'var(--fresh-mint)', bg: 'var(--fresh-mint-14)' }
      : { icon: 'credit-card', color: 'var(--vitality-orange)', bg: 'var(--vitality-orange-14)' }

    const iconMap = [
      { match: '收入', icon: 'hand-coins', color: 'var(--fresh-mint)', bg: 'var(--fresh-mint-14)' },
      { match: '支付', icon: 'credit-card', color: 'var(--vitality-orange)', bg: 'var(--vitality-orange-14)' },
      { match: '退款', icon: 'refresh-cw', color: 'var(--fresh-mint)', bg: 'var(--fresh-mint-14)' },
      { match: '提现手续费', icon: 'receipt-text', color: 'var(--vitality-orange)', bg: 'var(--vitality-orange-14)' },
      { match: '提现', icon: 'landmark', color: 'var(--brand-primary)', bg: 'var(--brand-primary-12)' }
    ]

    const matched = iconMap.find(meta => title.includes(meta.match)) || fallback

    return {
      ...item,
      amountPrefix: amount > 0 ? '+' : amount < 0 ? '-' : '',
      displayAmountAbs: MoneyUtils.formatAmount(Math.abs(amount)),
      icon: item.icon && /^[a-z0-9-]+$/.test(item.icon) ? item.icon : matched.icon,
      iconColor: item.iconColor || matched.color,
      iconBg: item.iconBg || matched.bg
    }
  }
})
