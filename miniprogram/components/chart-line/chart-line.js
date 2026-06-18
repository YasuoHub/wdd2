// 折线图组件 - 支持单线/双线模式
Component({
  properties: {
    data: { type: Array, value: [] },
    // labels: [线1名称, 线2名称(可选)]
    labels: { type: Array, value: ['', ''] },
    // colors: [线1颜色, 线2颜色(可选)]
    colors: { type: Array, value: ['#1677D2', '#e74c3c'] },
    unit: { type: String, value: '' },
    height: { type: Number, value: 440 },
    // 是否显示百分比格式（y轴自动加%）
    isPercent: { type: Boolean, value: false }
  },

  data: {
    tooltip: { visible: false, x: 0, y: 0, items: [] },
    canvasWidth: 0,
    canvasHeight: 0,
    hasData: false
  },

  lifetimes: {
    ready() {
      this._syncDataState()
      this._initCanvas()
    },
    detached() {
      if (this._initTimer) clearTimeout(this._initTimer)
    }
  },

  observers: {
    'data, height'() {
      this._syncDataState()
      if (this._ctx && this.data.hasData) {
        this._draw()
      } else if (this._ctx) {
        this._clearCanvas()
      } else {
        // canvas 尚未就绪，等待 ready
        this._pendingDraw = true
      }
    }
  },

  methods: {
    _syncDataState() {
      const hasData = this._hasRenderableData(this.properties.data || [])
      if (this.data.hasData !== hasData) {
        this.setData({ hasData, 'tooltip.visible': false })
      }
    },

    _hasRenderableData(data) {
      if (!Array.isArray(data) || data.length === 0) return false
      return data.some(d => (Number(d.value1) || 0) > 0 || (Number(d.value2) || 0) > 0)
    },

    async _initCanvas(retry = 0) {
      const sysInfo = wx.getSystemInfoSync()
      const dpr = sysInfo.pixelRatio || 2
      const query = this.createSelectorQuery()
      query.select('#line-canvas')
        .fields({ node: true, size: true })
        .exec((res) => {
          if (!res || !res[0] || !res[0].node) {
            console.error('chart-line: canvas 节点未找到')
            this._retryInitCanvas(retry)
            return
          }
          const canvas = res[0].node
          const boxWidth = res[0].width
          const boxHeight = res[0].height || (this.properties.height / 750) * sysInfo.screenWidth

          if (!boxWidth || !boxHeight) {
            this._retryInitCanvas(retry)
            return
          }

          canvas.width = boxWidth * dpr
          canvas.height = boxHeight * dpr

          this._ctx = canvas.getContext('2d')
          this._dpr = dpr
          this._boxWidth = boxWidth
          this._boxHeight = boxHeight

          this.setData({ canvasWidth: boxWidth, canvasHeight: boxHeight })

          if (this.data.hasData) {
            this._pendingDraw = false
            this._draw()
          } else {
            this._pendingDraw = false
            this._clearCanvas()
          }
        })
    },

    _retryInitCanvas(retry) {
      if (retry >= 6) return
      if (this._initTimer) clearTimeout(this._initTimer)
      this._initTimer = setTimeout(() => {
        this._initCanvas(retry + 1)
      }, 80)
    },

    _clearCanvas() {
      const ctx = this._ctx
      const dpr = this._dpr
      const w = this._boxWidth
      const h = this._boxHeight
      if (!ctx || !w || !h) return
      ctx.save()
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, w, h)
      ctx.restore()
    },

    _draw() {
      const ctx = this._ctx
      const dpr = this._dpr
      const w = this._boxWidth
      const h = this._boxHeight
      const data = this.properties.data || []
      const labels = this.properties.labels
      const colors = this.properties.colors
      const isDual = labels.length >= 2 && data.length > 0 && data[0].value2 !== undefined

      if (!ctx || !w || !h) return
      if (!this._hasRenderableData(data)) {
        this._clearCanvas()
        return
      }

      ctx.save()
      ctx.scale(dpr, dpr)

      // 边距
      const pad = { top: 20, right: 20, bottom: 50, left: 50 }
      const cw = w - pad.left - pad.right
      const ch = h - pad.top - pad.bottom

      // 清空
      ctx.clearRect(0, 0, w, h)

      if (data.length === 0) {
        ctx.fillStyle = '#999'
        ctx.font = '14px sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText('暂无数据', w / 2, h / 2)
        ctx.restore()
        return
      }

      // 计算 Y 轴范围
      let maxVal = 0
      data.forEach(d => {
        maxVal = Math.max(maxVal, d.value1 || 0)
        if (isDual) maxVal = Math.max(maxVal, d.value2 || 0)
      })
      if (maxVal === 0) maxVal = 1
      // 向上取整到合适的值
      maxVal = this._niceCeil(maxVal)

      // Y 轴刻度
      const ySteps = 5
      const yStepVal = maxVal / ySteps

      // 绘制网格线和 Y 轴标签
      ctx.strokeStyle = '#eee'
      ctx.lineWidth = 0.5
      ctx.fillStyle = '#999'
      ctx.font = '10px sans-serif'
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'

      for (let i = 0; i <= ySteps; i++) {
        const y = pad.top + (ch / ySteps) * i
        // 网格线
        ctx.beginPath()
        ctx.moveTo(pad.left, y)
        ctx.lineTo(w - pad.right, y)
        ctx.stroke()
        // 标签
        const val = maxVal - yStepVal * i
        const label = this.properties.isPercent
          ? (Math.round(val * 10000) / 100) + '%'
          : this._formatNum(val)
        ctx.fillText(label, pad.left - 5, y)
      }

      // X 轴标签（跳过部分以避免重叠）
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillStyle = '#999'
      ctx.font = '10px sans-serif'

      const maxLabels = Math.floor(cw / 50) // 每 50px 最多一个标签
      const step = Math.max(1, Math.ceil(data.length / maxLabels))

      for (let i = 0; i < data.length; i += step) {
        const x = pad.left + (cw / (data.length - 1 || 1)) * i
        const dateStr = data[i].date
        // 只显示月-日
        const short = dateStr.length >= 10 ? dateStr.substring(5, 10) : dateStr
        ctx.save()
        ctx.translate(x, pad.top + ch + 5)
        ctx.rotate(-Math.PI / 4)
        ctx.fillText(short, 0, 0)
        ctx.restore()
      }

      // 裁剪区域（防止折线超出）
      ctx.save()
      ctx.beginPath()
      ctx.rect(pad.left, pad.top, cw, ch)
      ctx.clip()

      // 绘制折线
      const drawLine = (key, color) => {
        ctx.strokeStyle = color
        ctx.lineWidth = 2
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        ctx.beginPath()
        let first = true
        data.forEach((d, i) => {
          const x = pad.left + (cw / (data.length - 1 || 1)) * i
          const val = d[key] || 0
          const y = pad.top + ch - (val / maxVal) * ch
          if (first) { ctx.moveTo(x, y); first = false }
          else ctx.lineTo(x, y)
        })
        ctx.stroke()

        // 数据点
        data.forEach((d, i) => {
          const x = pad.left + (cw / (data.length - 1 || 1)) * i
          const val = d[key] || 0
          const y = pad.top + ch - (val / maxVal) * ch
          ctx.fillStyle = '#fff'
          ctx.strokeStyle = color
          ctx.lineWidth = 1.5
          ctx.beginPath()
          ctx.arc(x, y, 3, 0, Math.PI * 2)
          ctx.fill()
          ctx.stroke()
        })
      }

      drawLine('value1', colors[0])
      if (isDual) drawLine('value2', colors[1])

      ctx.restore() // 裁剪区域

      // 图例
      if (labels[0]) {
        const legendY = pad.top - 12
        let legendX = pad.left

        const drawLegend = (label, color) => {
          ctx.fillStyle = color
          ctx.fillRect(legendX, legendY, 12, 4)
          ctx.fillStyle = '#666'
          ctx.font = '10px sans-serif'
          ctx.textAlign = 'left'
          ctx.textBaseline = 'bottom'
          ctx.fillText(label, legendX + 16, legendY + 4)
          // 测量文字宽度来移动下一个图例
          const metrics = ctx.measureText ? ctx.measureText(label) : { width: label.length * 10 }
          legendX += 16 + (metrics.width || label.length * 10) + 16
        }

        drawLegend(labels[0], colors[0])
        if (isDual && labels[1]) drawLegend(labels[1], colors[1])
      }

      // 底部 X 轴标签占位已完成，不需要额外处理

      ctx.restore() // 最外层 save
    },

    _formatNum(num) {
      if (num >= 10000) return (num / 10000).toFixed(1) + 'w'
      if (num >= 1000) return (num / 1000).toFixed(1) + 'k'
      if (Number.isInteger(num)) return num.toString()
      return num.toFixed(1)
    },

    _niceCeil(val) {
      if (val <= 0) return 1
      const magnitude = Math.pow(10, Math.floor(Math.log10(val)))
      const normalized = val / magnitude
      let nice
      if (normalized <= 1) nice = 1
      else if (normalized <= 2) nice = 2
      else if (normalized <= 5) nice = 5
      else nice = 10
      return nice * magnitude
    },

    onCanvasTouch(e) {
      // 简化触摸处理：清除 tooltip（避免复杂坐标转换）
      this.setData({ 'tooltip.visible': false })
    }
  }
})
