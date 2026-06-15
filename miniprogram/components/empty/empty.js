// 空状态组件
Component({
  properties: {
    // 容器类型：normal(普通) | card(卡片)
    type: {
      type: String,
      value: 'card'
    },
    // 图标类型：icon(线性图标) | image(图片)
    iconType: {
      type: String,
      value: 'icon'
    },
    // 图标内容：线性图标名称或图片路径
    icon: {
      type: String,
      value: 'inbox'
    },
    // 标题
    title: {
      type: String,
      value: '暂无数据'
    },
    // 描述
    desc: {
      type: String,
      value: ''
    },
    // 是否显示按钮
    showBtn: {
      type: Boolean,
      value: false
    },
    // 按钮文字
    btnText: {
      type: String,
      value: '去逛逛'
    },
    // 按钮类型：primary(主色) | secondary(次要)
    btnType: {
      type: String,
      value: 'primary'
    }
  },

  methods: {
    // 按钮点击事件
    onBtnTap() {
      this.triggerEvent('btnTap')
    }
  }
})
