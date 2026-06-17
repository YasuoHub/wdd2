// 饼图组件 - Canvas 2D 实现
const PALETTE = [
  '#1677D2', '#e74c3c', '#2ecc71', '#f39c12', '#9b59b6',
  '#1abc9c', '#e67e22', '#3498db', '#e91e63', '#00bcd4',
  '#ff5722', '#8bc34a', '#ff9800', '#9c27b0', '#3f51b5',
  '#cddc39', '#795548', '#607d8b', '#f44336', '#4caf50'
]

Component({
  properties: {
    data: { type: Array, value: [] }
  },

  data: {
    legend: []
  },

  lifetimes: {
    attached() {
      this._initCanvas()
    }
  },

  observers: {
    'data'() {
      if (this._ctx) {
        this._draw()
      } else {
        this._pendingDraw = true
      }
    }
  },

  methods: {
    _initCanvas() {
      const query = this.createSelectorQuery()
      query.select('#pie-canvas')
        .fields({ node: true, size: true })
        .exec((res) => {
          if (!res || !res[0] || !res[0].node) return
          const canvas = res[0].node
          const dpr = wx.getSystemInfoSync().pixelRatio || 2
          const size = res[0].width

          canvas.width = size * dpr
          canvas.height = size * dpr

          this._ctx = canvas.getContext('2d')
          this._dpr = dpr
          this._size = size

          if (this._pendingDraw) {
            this._pendingDraw = false
            this._draw()
          }
        })
    },

    _draw() {
      const ctx = this._ctx
      const dpr = this._dpr
      const size = this._size
      const data = this.properties.data || []

      if (!ctx || !size) return

      ctx.save()
      ctx.scale(dpr, dpr)

      const cx = size / 2
      const cy = size / 2
      const outerR = size * 0.38
      const innerR = size * 0.22 // 环形图

      ctx.clearRect(0, 0, size, size)

      if (data.length === 0) {
        ctx.fillStyle = '#999'
        ctx.font = '12px sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText('暂无数据', cx, cy)
        ctx.restore()
        return
      }

      const total = data.reduce((s, d) => s + (d.value || 0), 0)
      if (total === 0) {
        ctx.fillStyle = '#999'
        ctx.font = '12px sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText('暂无数据', cx, cy)
        ctx.restore()
        return
      }

      const legend = []
      let startAngle = -Math.PI / 2 // 从12点方向开始

      data.forEach((d, i) => {
        const val = d.value || 0
        const pct = val / total
        const endAngle = startAngle + pct * Math.PI * 2
        const color = PALETTE[i % PALETTE.length]

        // 绘制扇形
        ctx.beginPath()
        ctx.arc(cx, cy, outerR, startAngle, endAngle)
        ctx.arc(cx, cy, innerR, endAngle, startAngle, true)
        ctx.closePath()
        ctx.fillStyle = color
        ctx.fill()

        // 标签线（仅当占比 >= 3% 时显示，避免太密）
        if (pct >= 0.03) {
          const midAngle = startAngle + (endAngle - startAngle) / 2
          const midR = (outerR + innerR) / 2
          const labelX = cx + Math.cos(midAngle) * midR
          const labelY = cy + Math.sin(midAngle) * midR

          // 百分比文字
          ctx.fillStyle = '#fff'
          ctx.font = '9px sans-serif'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          const pctText = Math.round(pct * 100) + '%'
          ctx.fillText(pctText, labelX, labelY)
        }

        legend.push({
          label: d.label || d.bucket || '',
          color,
          percent: Math.round(pct * 1000) / 10
        })

        startAngle = endAngle
      })

      this.setData({ legend })

      ctx.restore() // 最外层 save
    }
  }
})
