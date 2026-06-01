// 漏斗图组件 - CSS 实现
Component({
  properties: {
    data: { type: Array, value: [] },
    // labels 对应 data 中每个阶段的名称
    labels: { type: Array, value: ['发布', '匹配', '完成', '评价'] }
  },

  observers: {
    'data, labels'(newData, labels) {
      if (!newData || newData.length === 0) {
        this.setData({ _stages: [] })
        return
      }
      const maxVal = Math.max(...newData.map(d => d.value || 0), 1)
      const stages = newData.map((d, i) => {
        const prev = i > 0 ? (newData[i - 1].value || 0) : d.value || 0
        const curr = d.value || 0
        return {
          label: labels[i] || d.label || `阶段${i + 1}`,
          value: curr,
          width: Math.max(20, Math.round((curr / maxVal) * 100)),
          rate: i > 0 ? Math.round((curr / (prev || 1)) * 100) : null
        }
      })
      this.setData({ _stages: stages })
    }
  },

  data: {
    _stages: []
  }
})
