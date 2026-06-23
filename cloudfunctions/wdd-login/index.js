// 云函数：用户登录/注册
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command
const DEFAULT_REGISTER_GIFT_DEDUCTION = 0
const ASSET_FORFEIT_CONSENT_TEXT = '我同意'
const ACTIVE_NEED_STATUSES = ['pending', 'ongoing', 'breaking']
const BLOCKING_PAYMENT_STATUSES = ['pending', 'refund_pending', 'refund_processing', 'refund_failed']
const BLOCKING_WITHDRAW_STATUSES = ['processing', 'transfer_pending', 'transfer_failed']

function normalizeMoneyAmount(value, fallback = 0) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return fallback
  return Math.round(amount * 100) / 100
}

function formatLoginUserInfo(userInfo) {
  return {
    _id: userInfo._id,
    nickname: userInfo.nickname,
    avatar: userInfo.avatar,
    total_points: userInfo.total_points,
    balance: userInfo.balance || 0,
    frozen_balance: userInfo.frozen_balance || 0,
    deduction_balance: userInfo.deduction_balance || 0,
    frozen_deduction_balance: userInfo.frozen_deduction_balance || 0,
    available_deduction_balance: (userInfo.deduction_balance || 0) - (userInfo.frozen_deduction_balance || 0),
    available_balance: (userInfo.balance || 0) - (userInfo.frozen_balance || 0),
    total_earned: userInfo.total_earned || 0,
    total_withdrawn: userInfo.total_withdrawn || 0,
    total_paid: userInfo.total_paid || 0,
    role: userInfo.role,
    consecutive_sign_days: userInfo.consecutive_sign_days,
    credit_score: userInfo.credit_score || 0,
    ban_status: userInfo.ban_status || null,
    rating: userInfo.rating || 5.0,
    rating_count: userInfo.rating_count || 0,
    // 帮助者资料（直接字段）
    help_willingness: userInfo.help_willingness || '',
    frequent_locations: userInfo.frequent_locations || [],
    help_types: userInfo.help_types || [],
    // 帮助者资料（对象形式）
    helperProfile: userInfo.help_willingness ? {
      help_willingness: userInfo.help_willingness,
      frequent_locations: userInfo.frequent_locations || [],
      help_types: userInfo.help_types || []
    } : null,
    hasHelperProfile: !!userInfo.help_willingness
  }
}

function isDeletedUser(user) {
  return !!(user && user.is_deleted === true)
}

async function getActiveUserByOpenid(OPENID) {
  const userRes = await db.collection('wdd-users')
    .where({ openid: OPENID })
    .limit(1)
    .get()

  const user = userRes.data[0] || null
  return isDeletedUser(user) ? null : user
}

function hasPositiveAmount(value) {
  return Number(value || 0) > 0.000001
}

function buildDeletedOpenidMarker(userId) {
  return `deleted:${userId}:${Date.now()}`
}

function getForfeitableAssets(user) {
  return {
    balance: Number(user.balance || 0),
    deductionBalance: Number(user.deduction_balance || 0)
  }
}

function hasForfeitableAssets(user) {
  const assets = getForfeitableAssets(user)
  return hasPositiveAmount(assets.balance) || hasPositiveAmount(assets.deductionBalance)
}

// 从 wdd-config 读取积分配置，未配置时使用默认值
async function getPointsConfig() {
  try {
    const configRes = await db.collection('wdd-config').doc('platform').get()
    const cfg = configRes.data
    if (cfg && cfg.points) {
      return {
        register: cfg.points.register ?? 100,
        invite: cfg.points.invite ?? 50,
        signInMap: cfg.points.signIn?.daily ?? [5, 10, 15, 20, 25, 30, 30]
      }
    }
  } catch (e) {}
  return {
    register: 100,
    invite: 50,
    signInMap: [5, 10, 15, 20, 25, 30, 30]
  }
}

// 从 wdd-config 读取新用户注册平台抵扣金，未配置时默认不发放
async function getRegisterGiftDeduction() {
  try {
    const configRes = await db.collection('wdd-config').doc('platform').get()
    const cfg = configRes.data
    const value = cfg ? (cfg.register_gift_deduction ?? cfg.register_gift_balance) : DEFAULT_REGISTER_GIFT_DEDUCTION
    return normalizeMoneyAmount(value, DEFAULT_REGISTER_GIFT_DEDUCTION)
  } catch (e) {}
  return DEFAULT_REGISTER_GIFT_DEDUCTION
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { inviterId, action } = event

  if (!OPENID) {
    return {
      code: -1,
      message: '获取用户openid失败'
    }
  }

  // 处理帮助者资料相关操作
  if (action === 'getHelperProfile') {
    return await getHelperProfile(OPENID)
  }
  if (action === 'getLoginProfile') {
    return await getLoginProfile(OPENID)
  }
  if (action === 'loginExisting') {
    return await loginExisting(OPENID)
  }
  if (action === 'deleteAccount') {
    return await deleteAccount(event, OPENID)
  }
  if (action === 'updateHelperProfile') {
    return await updateHelperProfile(event, OPENID)
  }

  try {
    // 查询用户是否已存在
    const existingUser = await getActiveUserByOpenid(OPENID)

    let userInfo
    let isNewUser = false

    if (!existingUser) {
      // 新用户，创建记录
      isNewUser = true

      const pointsCfg = await getPointsConfig()
      const registerGiftDeduction = await getRegisterGiftDeduction()

      // 检查是否有邀请人（事务外查询，确保信息可用）
      let inviter = null
      let inviteBonus = 0
      if (inviterId) {
        const inviterRes = await db.collection('wdd-users').doc(inviterId).get()
        if (inviterRes.data) {
          inviter = inviterRes.data
          inviteBonus = pointsCfg.invite
        }
      }

      const registerPoints = pointsCfg.register

      const newUser = {
        openid: OPENID,
        nickname: event.nickname || '微信用户',
        avatar: event.avatar || '',
        total_points: registerPoints + inviteBonus,
        balance: 0,
        frozen_balance: 0,
        deduction_balance: registerGiftDeduction,
        frozen_deduction_balance: 0,
        total_earned: 0,
        total_withdrawn: 0,
        total_paid: 0,
        role: 'both',
        inviter_id: inviter ? inviter._id : null,
        invite_count: 0,
        create_time: db.serverDate(),
        update_time: db.serverDate(),
        last_sign_in_date: null,
        consecutive_sign_days: 0,
        credit_score: 100,
        ban_status: null,
        rating: 5.0,
        rating_count: 0
      }

      // 用户创建 + 注册积分 + 邀请奖励 统一事务
      const transaction = await db.startTransaction()
      let addRes
      try {
        // 1. 创建用户
        addRes = await transaction.collection('wdd-users').add({
          data: newUser
        })

        // 2. 注册积分流水
        await transaction.collection('wdd-point-records').add({
          data: {
            user_id: addRes._id,
            type: 'gain',
            points: registerPoints,
            description: '新用户注册奖励',
            balance: registerPoints,
            create_time: db.serverDate()
          }
        })

        // 3. 注册平台抵扣金奖励
        if (registerGiftDeduction > 0) {
          await transaction.collection('wdd-balance-records').add({
            data: {
              user_id: addRes._id,
              type: 'deduction_gift',
              amount: 0,
              balance: 0,
              frozen_balance: 0,
              deduction_amount: registerGiftDeduction,
              deduction_balance: registerGiftDeduction,
              description: '新用户注册平台抵扣金',
              create_time: db.serverDate()
            }
          })

          await transaction.collection('wdd-notifications').add({
            data: {
              user_id: addRes._id,
              type: 'deduction_gift',
              system_type: 'register_gift_deduction',
              title: '新人平台抵扣金已到账',
              content: `欢迎加入问当地，平台已赠送您 ¥${registerGiftDeduction.toFixed(2)} 平台抵扣金，可用于发布求助时抵扣悬赏，不可提现。`,
              amount: registerGiftDeduction,
              is_read: false,
              create_time: db.serverDate()
            }
          })
        }

        // 4. 邀请奖励（同一事务内）
        if (inviter) {
          await transaction.collection('wdd-point-records').add({
            data: {
              user_id: addRes._id,
              type: 'invite',
              points: inviteBonus,
              description: '接受邀请奖励',
              balance: registerPoints + inviteBonus,
              create_time: db.serverDate()
            }
          })

          await transaction.collection('wdd-users').doc(inviter._id).update({
            data: {
              total_points: _.inc(inviteBonus),
              invite_count: _.inc(1),
              update_time: db.serverDate()
            }
          })

          await transaction.collection('wdd-point-records').add({
            data: {
              user_id: inviter._id,
              type: 'invite',
              points: inviteBonus,
              description: `邀请好友「${newUser.nickname}」奖励`,
              balance: inviter.total_points + inviteBonus,
              create_time: db.serverDate()
            }
          })

          await transaction.collection('wdd-invite-records').add({
            data: {
              inviter_id: inviter._id,
              invitee_id: addRes._id,
              invitee_nickname: newUser.nickname,
              points: inviteBonus,
              create_time: db.serverDate()
            }
          })
        }

        await transaction.commit()
      } catch (err) {
        await transaction.rollback()
        throw new Error('用户注册事务失败: ' + err.message)
      }

      userInfo = {
        _id: addRes._id,
        ...newUser
      }

      // 事务外：发送邀请通知（失败不影响注册结果）
      if (inviter) {
        try {
          await db.collection('wdd-notifications').add({
            data: {
              user_id: inviter._id,
              type: 'points_received',
              title: '邀请成功',
              content: `您邀请的好友「${newUser.nickname}」已注册，获得${inviteBonus}积分奖励`,
              is_read: false,
              create_time: db.serverDate()
            }
          })
        } catch (notifyErr) {
          console.error('发送邀请通知失败:', notifyErr)
        }
      }
    } else {
      // 老用户，返回已有信息
      userInfo = existingUser

      // 更新登录时间和用户信息（如果提供了）
      const updateData = {
        update_time: db.serverDate()
      }

      // 如果传入了新的昵称或头像，则更新
      if (event.nickname) {
        updateData.nickname = event.nickname
      }
      if (event.avatar) {
        updateData.avatar = event.avatar
      }

      await db.collection('wdd-users').doc(userInfo._id).update({
        data: updateData
      })

      // 更新本地 userInfo 对象
      if (event.nickname) userInfo.nickname = event.nickname
      if (event.avatar) userInfo.avatar = event.avatar
    }

    return {
      code: 0,
      message: '登录成功',
      data: {
        userInfo: formatLoginUserInfo(userInfo),
        isNewUser
      }
    }
  } catch (err) {
    console.error('登录失败:', err)
    return {
      code: -1,
      message: '登录失败: ' + err.message
    }
  }
}

// 查询当前微信身份是否已有用户记录，仅用于登录态校验，不创建用户。
async function getLoginProfile(OPENID) {
  try {
    const userInfo = await getActiveUserByOpenid(OPENID)

    if (!userInfo) {
      return {
        code: 0,
        message: '用户不存在',
        data: {
          exists: false
        }
      }
    }

    return {
      code: 0,
      message: '获取成功',
      data: {
        exists: true,
        userInfo: formatLoginUserInfo(userInfo)
      }
    }
  } catch (err) {
    console.error('获取登录资料失败:', err)
    return {
      code: -1,
      message: '获取失败: ' + err.message
    }
  }
}

// 老用户快速登录：存在则登录，不存在则让前端进入资料填写页。
async function loginExisting(OPENID) {
  try {
    const userInfo = await getActiveUserByOpenid(OPENID)

    if (!userInfo) {
      return {
        code: 0,
        message: '用户不存在',
        data: {
          exists: false
        }
      }
    }

    await db.collection('wdd-users').doc(userInfo._id).update({
      data: {
        update_time: db.serverDate()
      }
    })

    return {
      code: 0,
      message: '登录成功',
      data: {
        exists: true,
        userInfo: formatLoginUserInfo(userInfo),
        isNewUser: false
      }
    }
  } catch (err) {
    console.error('老用户登录失败:', err)
    return {
      code: -1,
      message: '登录失败: ' + err.message
    }
  }
}

async function countWhere(collectionName, condition) {
  const res = await db.collection(collectionName).where(condition).count()
  return res.total || 0
}

async function getAccountDeletionBlockers(user) {
  const userId = user._id
  const blockers = []

  if (
    hasPositiveAmount(user.frozen_balance) ||
    hasPositiveAmount(user.frozen_deduction_balance)
  ) {
    blockers.push('账号仍有冻结资金，请等待任务、提现、退款或纠纷完结后再注销')
  }

  const [
    activeNeedsCount,
    activeTakesCount,
    activeTakenNeedsCount,
    pendingReportsCount,
    pendingAppealsCount,
    pendingPaymentsCount,
    pendingWithdrawsCount,
    pendingWithdrawApplicationsCount,
    approvedWithdrawApplicationsCount
  ] = await Promise.all([
    countWhere('wdd-needs', {
      user_id: userId,
      status: _.in(ACTIVE_NEED_STATUSES)
    }),
    countWhere('wdd-need-takers', {
      taker_id: userId,
      status: 'ongoing'
    }),
    countWhere('wdd-needs', {
      taker_id: userId,
      status: _.in(ACTIVE_NEED_STATUSES)
    }),
    countWhere('wdd-reports', {
      reporter_id: userId,
      status: 'pending'
    }),
    countWhere('wdd-appeals', {
      initiator_id: userId,
      status: 'pending'
    }),
    countWhere('wdd-payment-orders', {
      user_id: userId,
      status: _.in(BLOCKING_PAYMENT_STATUSES)
    }),
    countWhere('wdd-withdraws', {
      user_id: userId,
      status: _.in(BLOCKING_WITHDRAW_STATUSES)
    }),
    countWhere('wdd-withdraw-applications', {
      user_id: userId,
      status: 'pending'
    }),
    countWhere('wdd-withdraw-applications', {
      user_id: userId,
      status: 'approved',
      withdraw_status: _.neq('withdrawn')
    })
  ])

  if (activeNeedsCount > 0) blockers.push('还有未结束的求助任务')
  if (activeTakesCount > 0 || activeTakenNeedsCount > 0) blockers.push('还有进行中的帮助任务')
  if (pendingReportsCount > 0) blockers.push('还有待处理的举报')
  if (pendingAppealsCount > 0) blockers.push('还有待处理的申诉')
  if (pendingPaymentsCount > 0) blockers.push('还有待处理的支付或退款订单')
  if (pendingWithdrawsCount > 0) blockers.push('还有待处理的提现')
  if (pendingWithdrawApplicationsCount > 0 || approvedWithdrawApplicationsCount > 0) {
    blockers.push('还有未完结的提现申请')
  }

  return blockers
}

async function anonymizeAccountOpenidReferences(userId, OPENID, deletedOpenidMarker) {
  const updateData = {
    update_time: db.serverDate()
  }

  await Promise.all([
    db.collection('wdd-reports').where({
      reporter_id: userId,
      reporter_openid: OPENID
    }).update({
      data: {
        reporter_openid: deletedOpenidMarker,
        original_reporter_openid: OPENID,
        ...updateData
      }
    }).catch(err => {
      console.error('脱敏举报openid失败:', err)
    }),
    db.collection('wdd-appeals').where({
      initiator_id: userId,
      initiator_openid: OPENID
    }).update({
      data: {
        initiator_openid: deletedOpenidMarker,
        original_initiator_openid: OPENID,
        ...updateData
      }
    }).catch(err => {
      console.error('脱敏申诉openid失败:', err)
    })
  ])
}

async function deleteAccount(event, OPENID) {
  try {
    const user = await getActiveUserByOpenid(OPENID)
    if (!user) {
      return {
        code: -1,
        message: '用户不存在或已注销'
      }
    }

    const blockers = await getAccountDeletionBlockers(user)
    if (blockers.length > 0) {
      return {
        code: -1,
        message: blockers[0],
        data: {
          blockers
        }
      }
    }

    const forfeitableAssets = getForfeitableAssets(user)
    if (hasForfeitableAssets(user) && String(event.assetForfeitConsentText || '').trim() !== ASSET_FORFEIT_CONSENT_TEXT) {
      return {
        code: -1,
        message: '注销前需确认放弃账号余额和平台抵扣金',
        data: {
          requireAssetForfeitConsent: true,
          consentText: ASSET_FORFEIT_CONSENT_TEXT,
          forfeitableAssets
        }
      }
    }

    const deletedOpenidMarker = buildDeletedOpenidMarker(user._id)
    const now = db.serverDate()

    await db.collection('wdd-users').doc(user._id).update({
      data: {
        openid: deletedOpenidMarker,
        original_openid: OPENID,
        deleted_openid_marker: deletedOpenidMarker,
        is_deleted: true,
        deleted_at: now,
        delete_reason: 'user_self_delete',
        nickname: '已注销用户',
        avatar: '',
        role: 'deleted',
        help_willingness: '',
        frequent_locations: [],
        help_types: [],
        helperProfile: null,
        ban_status: null,
        balance: 0,
        deduction_balance: 0,
        frozen_balance: 0,
        frozen_deduction_balance: 0,
        forfeited_balance: forfeitableAssets.balance,
        forfeited_deduction_balance: forfeitableAssets.deductionBalance,
        asset_forfeit_confirmed_at: hasForfeitableAssets(user) ? now : null,
        update_time: now
      }
    })

    await anonymizeAccountOpenidReferences(user._id, OPENID, deletedOpenidMarker)

    return {
      code: 0,
      message: '账号已注销',
      data: {
        userId: user._id,
        deletedAt: new Date(),
        deletedOpenidMarker
      }
    }
  } catch (err) {
    console.error('注销账号失败:', err)
    return {
      code: -1,
      message: '注销失败: ' + err.message
    }
  }
}

// 获取帮助者资料
async function getHelperProfile(OPENID) {
  try {
    const user = await getActiveUserByOpenid(OPENID)

    if (!user) {
      return {
        code: -1,
        message: '用户不存在'
      }
    }

    return {
      code: 0,
      message: '获取成功',
      data: {
        helperProfile: user.help_willingness ? {
          help_willingness: user.help_willingness,
          frequent_locations: user.frequent_locations || [],
          help_types: user.help_types || []
        } : null,
        hasHelperProfile: !!user.help_willingness
      }
    }
  } catch (err) {
    console.error('获取帮助者资料失败:', err)
    return {
      code: -1,
      message: '获取失败: ' + err.message
    }
  }
}

// 更新帮助者资料
async function updateHelperProfile(event, OPENID) {
  const { helpWillingness, frequentLocations, helpTypes } = event

  try {
    const user = await getActiveUserByOpenid(OPENID)

    if (!user) {
      return {
        code: -1,
        message: '用户不存在'
      }
    }

    const userId = user._id

    // 构建更新数据
    const updateData = {
      help_willingness: helpWillingness,
      update_time: db.serverDate()
    }

    // 只有愿意帮助的人才保存这些字段
    if (helpWillingness === 'willing') {
      updateData.frequent_locations = frequentLocations || []
      updateData.help_types = helpTypes || []
    } else {
      updateData.frequent_locations = []
      updateData.help_types = []
    }

    await db.collection('wdd-users').doc(userId).update({
      data: updateData
    })

    return {
      code: 0,
      message: '更新成功',
      data: {
        helperProfile: {
          help_willingness: helpWillingness,
          frequent_locations: updateData.frequent_locations,
          help_types: updateData.help_types
        }
      }
    }
  } catch (err) {
    console.error('更新帮助者资料失败:', err)
    return {
      code: -1,
      message: '更新失败: ' + err.message
    }
  }
}
