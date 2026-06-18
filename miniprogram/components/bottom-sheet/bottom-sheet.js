Component({
  properties: {
    show: {
      type: Boolean,
      value: false
    },
    title: {
      type: String,
      value: ''
    },
    maxHeight: {
      type: String,
      value: '80vh'
    },
    closeThreshold: {
      type: Number,
      value: 90
    }
  },

  data: {
    startY: 0,
    dragOffset: 0
  },

  methods: {
    onMaskTap() {
      this.close()
    },

    preventBubble() {},

    preventTouchMove() {
      return false
    },

    onTouchStart(e) {
      const touch = e.touches && e.touches[0]
      if (!touch) return
      this.setData({
        startY: touch.clientY,
        dragOffset: 0
      })
    },

    onTouchMove(e) {
      const touch = e.touches && e.touches[0]
      if (!touch) return
      const deltaY = Math.max(0, touch.clientY - this.data.startY)
      this.setData({ dragOffset: deltaY * 2 })
    },

    onTouchEnd(e) {
      const touch = (e.changedTouches && e.changedTouches[0]) || null
      const deltaY = touch ? Math.max(0, touch.clientY - this.data.startY) : 0
      if (deltaY >= this.data.closeThreshold) {
        this.close()
        return
      }
      this.setData({ dragOffset: 0 })
    },

    close() {
      this.setData({ dragOffset: 0 })
      this.triggerEvent('close')
    }
  }
})
