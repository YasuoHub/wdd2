# 申诉、举报、客服介入功能开发 Todo 清单

## 批次1：数据库基建 + 用户状态

- [ ] **1.1** 修改 `wdd-db-init` 云函数，新增 `credit_score`、`ban_status` 字段初始化逻辑
  - 文件：`cloudfunctions/wdd-db-init/index.js`
  - 说明：为已有用户补充字段，新用户注册时自动包含

- [ ] **1.2** 创建数据库集合 `wdd-reports`
  - 字段：need_id, reporter_id, report_type, reason, images[], status, create_time
  - 在 `wdd-db-init` 中添加集合创建逻辑

- [ ] **1.3** 创建数据库集合 `wdd-appeals`
  - 字段：need_id, initiator_id, initiator_type, initiator_reason, initiator_images[], supplement_id, supplement_type, supplement_reason, supplement_images[], supplement_deadline, has_supplement, is_supplement_timeout, status, create_time
  - 在 `wdd-db-init` 中添加集合创建逻辑

- [ ] **1.4** 创建数据库集合 `wdd-tickets`
  - 字段：type, need_id, report_id, appeal_id, status, handler_id, result(对象), create_time, resolve_time
  - 在 `wdd-db-init` 中添加集合创建逻辑

- [ ] **1.5** 修改 `wdd-login` 云函数，返回新增字段
  - 文件：`cloudfunctions/wdd-login/index.js`
  - 在返回的 userInfo 中增加 `credit_score`、`ban_status`

- [ ] **1.7** 部署并执行 `wdd-db-init` 云函数，初始化所有新集合和字段

---

## 批次2：breaking 状态 + 聊天锁定

- [ ] **2.1** 修改 `wdd-chat` 云函数，增加 breaking 状态拦截
  - 文件：`cloudfunctions/wdd-chat/index.js`
  - `getTaskInfo`：正常返回 breaking 状态的任务信息
  - `sendMessage`：任务状态为 breaking 时返回「任务已进入客服审核，无法发送消息」

- [ ] **2.2** 修改 `pages/chat/chat` 页面，增加举报入口和 breaking 状态展示
  - 文件：`miniprogram/pages/chat/chat.js`、`chat.wxml`、`chat.wxss`
  - 顶部导航栏增加举报按钮（仅在 ongoing 状态显示）
  - breaking 状态时隐藏输入框和工具栏，显示「客服审核中」提示条
  - 状态映射增加 breaking：{ text: '客服审核中', class: 'breaking' }

- [ ] **2.3** 修改 `wdd-get-needs` 云函数，返回申诉/举报标识
  - 文件：`cloudfunctions/wdd-get-needs/index.js`
  - `getMyNeeds` 和 `getMyTasks` 返回中增加 `has_report`、`has_appeal` 字段

- [ ] **2.4** 修改 `wdd-auto-cancel` 云函数，排除 breaking 状态任务
  - 文件：`cloudfunctions/wdd-auto-cancel/index.js`
  - 自动取消逻辑中不处理 status = 'breaking' 的任务

---

## 批次3：举报 + 申诉 + 双方申诉机制

- [ ] **3.1** 创建 `wdd-report` 云函数
  - 文件：`cloudfunctions/wdd-report/index.js`
  - action：submitReport（提交举报）
    - 校验：任务不能已有举报，任务状态不能是 breaking
    - 创建 wdd-reports 记录
    - 创建 wdd-tickets 记录（type='report'）
    - 更新 wdd-needs：status='breaking', has_report=true
  - action：getReportStatus（查询举报状态）

- [ ] **3.2** 创建举报表单页面 `pages/report/report`
  - 文件：`miniprogram/pages/report/report.js`、`report.wxml`、`report.wxss`、`report.json`
  - 下拉选择举报类型（7个选项）
  - 多行输入举报理由（5~300字限制）
  - 图片上传组件（最多3张，至少1张）
  - 提交前弹窗确认文案
  - 提交后跳转回聊天页或上一页

- [ ] **3.3** 创建 `wdd-appeal` 云函数
  - 文件：`cloudfunctions/wdd-appeal/index.js`
  - action：submitAppeal（提交申诉）
    - 校验：任务不能已有申诉，不能是 breaking/completed/cancelled 状态
    - 创建 wdd-appeals 记录（设置 supplement_deadline = now + 24h）
    - 创建 wdd-tickets 记录（type='appeal'）
    - 更新 wdd-needs：status='breaking', has_appeal=true
    - 向另一方发送站内消息（直接写入 wdd-notifications，type='appeal_notice'）
  - action：submitSupplement（补充申诉材料）
    - 校验：在 supplement_deadline 之前，且对方未补充过
    - 更新 wdd-appeals（supplement_* 字段）
    - 向发起方发送站内消息（type='appeal_reminder'，内容：对方已补充）
  - action：getAppealDetail（查询申诉详情，含双方材料）
  - action：checkSupplementTimeout（检查超时，由定时触发或查询时判断）
    - 超时未补充：设置 is_supplement_timeout=true
    - 向发起方发送站内消息（type='appeal_reminder'，内容：对方超时未补充）

- [ ] **3.4** 创建申诉表单页面 `pages/appeal/appeal`
  - 文件：`miniprogram/pages/appeal/appeal.js`、`appeal.wxml`、`appeal.wxss`、`appeal.json`
  - 支持两种模式：发起申诉 / 补充材料（通过页面参数区分）
  - 表单结构与举报一致：类型下拉+理由+图片上传
  - 补充材料模式：显示剩余时间倒计时

- [ ] **3.5** 创建申诉通知详情页 `pages/appeal-notice/appeal-notice`
  - 文件：`miniprogram/pages/appeal-notice/appeal-notice.js` 等
  - 用户点击站内申诉通知后进入此页
  - 展示对方申诉摘要（类型+理由，图片可预览）
  - 提供「补充申诉材料」按钮（24小时内可点击，超时置灰）
  - 点击后跳转 `pages/appeal/appeal?mode=supplement&needId=xxx`

- [ ] **3.6** 修改 `pages/my-needs/my-needs`，增加申诉入口
  - 文件：`miniprogram/pages/my-needs/my-needs.js`、`my-needs.wxml`
  - ongoing 状态的任务显示申诉按钮
  - 已完结 / breaking / has_appeal=true 时隐藏
  - 点击跳转 `pages/appeal/appeal?mode=initiate&needId=xxx`

- [ ] **3.7** 修改 `pages/my-tasks/my-tasks`，增加申诉入口
  - 文件：`miniprogram/pages/my-tasks/my-tasks.js`、`my-tasks.wxml`
  - 逻辑同 my-needs，帮助者视角

- [ ] **3.8** 配置云函数定时触发器（可选）
  - 文件：`cloudfunctions/wdd-appeal/config.json`
  - 每10分钟执行一次 checkSupplementTimeout，处理超时申诉
  - 如果不使用定时触发，改为查询时惰性判断超时

- [ ] **3.9** 在 `pages/messages/messages.js` 中增加新通知类型的图标映射
  - 新增：'appeal_notice'、'appeal_reminder'、'arbitration_result'

---

## 批次4：信誉分 + 封禁拦截

- [ ] **4.1** 编写封禁检查工具函数（可复制到各云函数目录）
  - 函数：`checkUserBanStatus(db, userId)`
  - 返回：{ isBanned, message, banEndTime, isPermanent }
  - 逻辑：查询 wdd-users.ban_status，判断是否封禁中

- [ ] **4.2** 修改 `pages/publish/publish`，发布前校验
  - 文件：`miniprogram/pages/publish/publish.js`
  - 调用 `wdd-login` 或本地缓存获取用户信誉分和封禁状态
  - 封禁中：弹窗拦截，显示解封时间
  - 信誉分=0：弹窗提示「您的信誉分已扣至0分，已限制发单及接单权限」

- [ ] **4.3** 修改 `pages/task-hall/task-hall`，接单前校验
  - 文件：`miniprogram/pages/task-hall/task-hall.js`
  - 点击接单按钮时，先校验封禁状态和信誉分
  - 封禁中/信誉分=0：弹窗拦截，阻止继续

- [ ] **4.4** 修改 `wdd-take-need` 云函数，增加服务端校验
  - 文件：`cloudfunctions/wdd-take-need/index.js`
  - 接单前检查用户 ban_status 和 credit_score
  - 服务端兜底校验，防止绕过前端

---

## 批次5：客服系统

- [ ] **5.1** 配置客服白名单
  - 文件：`cloudfunctions/wdd-get-config/index.js`
  - 在 wdd-config/platform 文档中增加 `customer_service_openids` 数组
  - 提供 action：isCustomerService(OPENID) 判断是否客服

- [ ] **5.2** 修改 `pages/my/my`，增加客服入口
  - 文件：`miniprogram/pages/my/my.js`、`my.wxml`
  - 登录时获取是否客服身份
  - 客服用户显示「客服工单处理」入口按钮
  - 点击跳转 `pages/ticket-list/ticket-list`

- [ ] **5.3** 创建 `wdd-ticket` 云函数
  - 文件：`cloudfunctions/wdd-ticket/index.js`
  - action：getTicketList（获取工单列表）
    - 仅客服可调用
    - 返回待处理工单，含任务标题、编号、发起时间、纠纷状态、双方昵称
    - 双人申诉工单标注对方补充状态
  - action：getTicketDetail（获取工单详情）
    - 返回：任务完整信息 + 举报/申诉详情 + 双方申诉材料 + 聊天记录摘要
  - action：submitArbitration（提交裁决）
    - 参数：ticketId, taskResult(cancelled/completed/partial), partialPercent, banInfo
    - 处理流程：
      1. 更新 wdd-tickets 为 resolved，记录 result
      2. 更新 wdd-needs status（按裁决结果）
      3. 调用 wdd-settlement 的 arbitrateSettle 处理资金
      4. 扣减信誉分（按规则：取消→帮助者-10；完成→求助者-10；部分→不扣）
      5. 如有封禁，更新 wdd-users.ban_status
      6. 向双方发送站内消息（直接写入 wdd-notifications）

- [ ] **5.4** 创建客服工单列表页 `pages/ticket-list/ticket-list`
  - 文件：`miniprogram/pages/ticket-list/ticket-list.js` 等
  - 列表展示：任务标题、编号、发起时间、纠纷状态、求助者/帮助者昵称
  - 双人申诉标注：「对方已补充材料」/「对方超时未补充」
  - 每条工单有「任务详情」按钮，点击跳转 `pages/ticket-detail/ticket-detail`

- [ ] **5.5** 创建客服工单详情页 `pages/ticket-detail/ticket-detail`
  - 文件：`miniprogram/pages/ticket-detail/ticket-detail.js` 等
  - 展示任务完整信息（标题、类型、悬赏、状态等）
  - 展示举报/申诉类型、理由、证据图片（可预览大图）
  - 双人申诉场景下，额外展示另一方补充材料
  - 「聊天详情」按钮，点击跳转 `pages/chat-view/chat-view`
  - 底部固定「处理裁决」按钮

- [ ] **5.6** 创建客服裁决弹窗组件（可在 ticket-detail 页面内实现）
  - 弹窗内容：
    - 任务流转结果下拉：取消任务 / 完成任务 / 部分完成
    - 部分完成时显示分账档位：10% / 30% / 50% / 70%
    - 账号封禁下拉：1天 / 1周 / 1个月 / 1年 / 永久封禁
    - 扣减信誉分：自动显示（取消→帮助者-10；完成→求助者-10；部分→不扣）
    - 警告提醒：自动提示（无需选择）
  - 提交前二次确认

- [ ] **5.7** 创建只读聊天查看页 `pages/chat-view/chat-view`
  - 文件：`miniprogram/pages/chat-view/chat-view.js` 等
  - 复用 chat 页面样式，但隐藏输入框和所有操作按钮
  - 仅展示聊天历史消息，不支持发送
  - 从 `wdd-chat` 云函数获取消息（复用 getMessages）

- [ ] **5.8** 修改 `wdd-settlement` 云函数，增加仲裁结算
  - 文件：`cloudfunctions/wdd-settlement/index.js`
  - action：arbitrateSettle
    - 参数：needId, result(cancelled/completed/partial), partialPercent
    - 取消任务：全额退款至求助者余额
    - 完成任务：正常结算逻辑（同 completeTask）
    - 部分完成：按 partialPercent 比例发放给帮助者，剩余退回求助者
    - 使用事务保证资金一致性

---

## 批次6：公开资料 + 站内消息完善

- [ ] **6.1** 创建公开个人资料页 `pages/public-profile/public-profile`
  - 文件：`miniprogram/pages/public-profile/public-profile.js` 等
  - 展示：用户头像、昵称、评价星级（rating）、提供的服务类型（help_types）、主要活跃地区（frequent_locations）
  - 最近三条五星好评：查询 wdd-ratings 中 target_id = 该用户 且 rating = 5 的记录，取最近3条
  - 页面可被任意用户访问（通过用户ID参数）

- [ ] **6.2** 修改 `pages/task-detail/task-detail`，增加个人资料入口
  - 文件：`miniprogram/pages/task-detail/task-detail.js`、`task-detail.wxml`
  - 在求助者/帮助者信息区域添加点击跳转
  - 跳转 `pages/public-profile/public-profile?userId=xxx`

- [ ] **6.3** 修改 `pages/chat/chat`，点击对方头像跳转公开资料
  - 文件：`miniprogram/pages/chat/chat.js`、`chat.wxml`
  - 聊天页面中对方头像可点击，跳转公开资料页

- [ ] **6.4** 完善裁决结果站内消息文案
  - 在 `wdd-ticket` 的 submitArbitration 中，向双方分别推送个性化通知
  - 求助者文案：包含裁决结果、资金变动、信誉分变动、封禁信息
  - 帮助者文案：同上，按角色区分

- [ ] **6.5** 在 `pages/messages/messages.js` 中完善通知展示
  - 为 'arbitration_result' 增加专属图标和展示样式
  - 点击通知可跳转相关任务详情

---

## 回归测试清单

### 核心流程测试
- [ ] 完整举报流程：发布 → 接单 → 举报 → breaking → 客服裁决取消 → 求助者退款 → 帮助者信誉分-10
- [ ] 完整申诉流程：发布 → 接单 → 申诉 → 通知对方 → 对方补充 → 客服裁决部分完成50% → 双方不扣分 → 资金按比例结算
- [ ] 超时申诉流程：申诉 → 对方24小时未补充 → 发起方收到超时提醒 → 客服仅依据发起方材料裁决
- [ ] 封禁拦截测试：封禁用户进入发布页/大厅 → 弹窗拦截 → 显示解封时间
- [ ] 信誉分0分限制：扣至0分 → 发单/接单弹窗限制

### 边界情况测试
- [ ] 重复举报/申诉：已有举报的任务再次举报 → 按钮隐藏/返回错误
- [ ] breaking 状态发消息：聊天输入框隐藏，发送接口拒绝
- [ ] 客服裁决后资金计算精度：确认四舍五入正确
- [ ] 永久封禁日期：前端读取 9999-12-31 显示「永久封禁」
- [ ] 站内消息未读数：新增通知类型正确计入未读总数
