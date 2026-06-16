const ICONFONT_MAP = require('./iconfont-map')
const FALLBACK_ICON = 'circle-help'

Component({
  properties: {
    name: {
      type: String,
      value: FALLBACK_ICON,
      observer: 'updateGlyph'
    },
    color: {
      type: String,
      value: '#1178DC'
    },
    size: {
      type: Number,
      value: 32
    }
  },

  data: {
    glyph: ''
  },

  lifetimes: {
    attached() {
      this.updateGlyph(this.data.name)
    }
  },

  methods: {
    updateGlyph(name) {
      const codePoint = ICONFONT_MAP[name] || ICONFONT_MAP[FALLBACK_ICON]
      const glyph = String.fromCharCode(codePoint)

      if (glyph !== this.data.glyph) {
        this.setData({ glyph })
      }
    }
  }
})
