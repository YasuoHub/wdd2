// 横向柱状图组件 - CSS 实现
Component({
  properties: {
    data: { type: Array, value: [] },
    maxValue: { type: Number, value: 0 }
  },

  observers: {
    'data'(newData) {
      if (!newData || newData.length === 0) return
      const max = this.properties.maxValue || Math.max(...newData.map(d => d.value || 0), 1)
      const processed = newData.map(d => ({
        label: d.label || d.typeName || '',
        value: d.value || 0,
        percent: max > 0 ? Math.round((d.value || 0) / max * 100) : 0
      }))
      this.setData({ _processed: processed })
    }
  },

  data: {
    _processed: []
  }
})
