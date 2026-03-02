// 星级评价页面逻辑
const app = getApp()

// 评分对应的文字
const RATING_TEXTS = ['', '非常差', '差', '一般', '好', '非常好']

// 评价标签
const RATING_TAGS = {
  seeker: ['响应迅速', '信息准确', '态度友好', '很有耐心', '非常专业', '乐于助人'],
  taker: ['描述清晰', '沟通顺畅', '有礼貌', '及时确认', '诚信用户', '推荐合作']
}

Page({
  data: {
    needId: '',
    ratingType: 'seeker', // 'seeker': 求助者评价帮助者, 'taker': 帮助者评价求助者
    targetUser: {
      nickname: '',
      avatar: ''
    },
    task: {
      typeName: '',
      description: '',
      points: 0
    },
    rating: 0,
    ratingText: '',
    ratingTags: [],
    selectedTags: [],
    comment: '',
    submitting: false
  },

  onLoad(options) {
    const { needId, type } = options
    const ratingType = type || 'seeker'
    const tagStrings = RATING_TAGS[ratingType]
    const ratingTags = tagStrings.map(text => ({ text, selected: false }))

    this.setData({
      needId,
      ratingType,
      ratingTags
    })

    this.loadTaskInfo()
  },

  // 加载任务信息
  async loadTaskInfo() {
    try {
      wx.showLoading({ title: '加载中...' })

      const { result } = await wx.cloud.callFunction({
        name: 'wdd-chat',
        data: {
          action: 'getTaskInfo',
          needId: this.data.needId
        }
      })

      wx.hideLoading()

      if (result.code === 0) {
        const taskData = result.data
        const typeMap = {
          'weather': '实时天气',
          'traffic': '道路拥堵',
          'shop': '店铺营业',
          'parking': '停车场空位',
          'queue': '排队情况',
          'other': '其他'
        }

        // 根据评价类型确定评价对象
        const isSeeker = this.data.ratingType === 'seeker'
        const targetUser = isSeeker ? {
          nickname: taskData.taker_nickname,
          avatar: taskData.taker_avatar
        } : {
          nickname: taskData.user_nickname,
          avatar: taskData.user_avatar
        }

        this.setData({
          targetUser,
          task: {
            typeName: typeMap[taskData.type] || '其他',
            description: taskData.description,
            points: taskData.points
          }
        })
      } else {
        throw new Error(result.message)
      }
    } catch (err) {
      wx.hideLoading()
      console.error('加载任务信息失败:', err)

      // 使用模拟数据
      this.setData({
        targetUser: { nickname: '测试用户', avatar: '' },
        task: {
          typeName: '店铺营业',
          description: '春熙路的星巴克今天开门吗？',
          points: 15
        }
      })
    }
  },

  // 设置评分
  setRating(e) {
    const score = parseInt(e.currentTarget.dataset.score)
    this.setData({
      rating: score,
      ratingText: RATING_TEXTS[score]
    })
  },

  // 切换标签
  toggleTag(e) {
    const index = e.currentTarget.dataset.index
    const ratingTags = this.data.ratingTags

    // 切换选中状态
    ratingTags[index].selected = !ratingTags[index].selected

    // 更新数据
    this.setData({
      ratingTags: [...ratingTags]
    })

    // 同时更新selectedTags数组用于提交
    const selectedTags = ratingTags
      .filter(tag => tag.selected)
      .map(tag => tag.text)

    this.setData({
      selectedTags
    })
  },

  // 输入评价内容
  onCommentInput(e) {
    this.setData({
      comment: e.detail.value
    })
  },

  // 提交评价
  async submitRating() {
    const { rating, comment, selectedTags, needId, ratingType, submitting } = this.data

    if (rating === 0) {
      wx.showToast({
        title: '请先选择评分',
        icon: 'none'
      })
      return
    }

    if (submitting) return

    this.setData({ submitting: true })

    try {
      wx.showLoading({ title: '提交中...' })

      const { result } = await wx.cloud.callFunction({
        name: 'wdd-settlement',
        data: {
          action: 'submitRating',
          needId,
          ratingType,
          rating,
          tags: selectedTags,
          comment
        }
      })

      wx.hideLoading()

      if (result.code === 0) {
        wx.showToast({
          title: '评价成功',
          icon: 'success'
        })

        // 延迟返回
        setTimeout(() => {
          wx.navigateBack()
        }, 1500)
      } else {
        throw new Error(result.message)
      }
    } catch (err) {
      wx.hideLoading()
      this.setData({ submitting: false })

      wx.showToast({
        title: err.message || '提交失败',
        icon: 'none'
      })
    }
  }
})
