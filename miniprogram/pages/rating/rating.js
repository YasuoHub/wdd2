// 星级评价页面逻辑
const app = getApp()

// 评分对应的文字
const RATING_TEXTS = ['', '非常差', '差', '一般', '好', '非常好']

// 评价标签（按星级分层，每星6个）
const RATING_TAGS = {
  seeker: {
    1: ['响应迟缓', '信息有误', '态度敷衍', '中途失联', '毫不专业', '体验极差'],
    2: ['响应较慢', '信息模糊', '不够主动', '态度冷淡', '专业不足', '体验不佳'],
    3: ['响应正常', '信息基本可用', '态度一般', '中规中矩', '完成任务', '还算靠谱'],
    4: ['响应迅速', '信息准确', '态度友好', '很有耐心', '比较专业', '乐于助人'],
    5: ['秒回消息', '信息精准详尽', '热情用心', '超有耐心', '非常专业', '超出预期']
  },
  taker: {
    1: ['描述不清', '沟通困难', '态度恶劣', '故意刁难', '毫无诚信', '体验极差'],
    2: ['描述模糊', '沟通不畅', '配合度低', '态度敷衍', '信息不全', '体验不佳'],
    3: ['描述基本清楚', '沟通正常', '态度尚可', '及时确认', '中规中矩', '还算靠谱'],
    4: ['描述清晰', '沟通顺畅', '很有礼貌', '及时确认', '诚信用户', '推荐合作'],
    5: ['描述精准详尽', '沟通超顺畅', '非常礼貌', '秒确认完成', '模范用户', '极力推荐']
  }
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
      price: 0
    },
    rating: 5,
    ratingText: '非常好',
    ratingTags: [],
    selectedTags: [],
    comment: '',
    submitting: false
  },

  onLoad(options) {
    const { needId, type } = options
    const ratingType = type || 'seeker'
    const tagStrings = RATING_TAGS[ratingType][5]
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
            price: taskData.reward_amount || 0
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
          price: 1.5
        }
      })
    }
  },

  // 设置评分（切换星级时更新对应标签）
  setRating(e) {
    const score = parseInt(e.currentTarget.dataset.score)
    const tagStrings = RATING_TAGS[this.data.ratingType][score]
    const ratingTags = tagStrings.map(text => ({ text, selected: false }))

    this.setData({
      rating: score,
      ratingText: RATING_TEXTS[score],
      ratingTags,
      selectedTags: []  // 切换星级时清空已选标签
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
