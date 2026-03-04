// 错误状态组件
Component({
  properties: {
    // 容器类型：normal(普通) | card(卡片)
    type: {
      type: String,
      value: 'card'
    },
    // 图标表情
    icon: {
      type: String,
      value: '⚠️'
    },
    // 错误标题
    title: {
      type: String,
      value: '加载失败'
    },
    // 错误描述
    desc: {
      type: String,
      value: '网络异常，请稍后重试'
    },
    // 是否显示重试按钮
    showRetry: {
      type: Boolean,
      value: true
    },
    // 重试按钮文字
    retryText: {
      type: String,
      value: '重新加载'
    },
    // 是否显示返回按钮
    showBack: {
      type: Boolean,
      value: false
    },
    // 返回按钮文字
    backText: {
      type: String,
      value: '返回首页'
    }
  },

  methods: {
    // 重试按钮点击
    onRetryTap() {
      this.triggerEvent('retry')
    },

    // 返回按钮点击
    onBackTap() {
      this.triggerEvent('back')
    }
  }
})
