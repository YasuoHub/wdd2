// 加载状态组件
Component({
  properties: {
    // 加载模式：spinner(转圈) | dots(点状) | skeleton(骨架屏)
    mode: {
      type: String,
      value: 'spinner'
    },
    // 容器类型：normal(普通) | full(全屏卡片)
    type: {
      type: String,
      value: 'normal'
    },
    // 加载提示文字
    text: {
      type: String,
      value: ''
    },
    // 图标大小（rpx）
    size: {
      type: Number,
      value: 64
    },
    // 文字大小（rpx）
    textSize: {
      type: Number,
      value: 28
    },
    // 骨架屏行数配置
    rows: {
      type: Array,
      value: [
        { width: 100 },
        { width: 80 },
        { width: 90 },
        { width: 60 }
      ]
    }
  }
})
