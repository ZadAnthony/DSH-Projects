# 项目定时任务

本模块拥有项目计划定义、管理来源和运行关联。Projects 的同一 Runtime 将管理界面、Remote 与工作会话工具接到该 owner，并提供用户主动“现在运行”。原生 Inbox 是唯一执行队列；正文、实际回合与成果仍保留在原会话。

原版 rc.2 的接入继续使用本模块的 `ScheduleRuntimeHost`，由插件私图提供实际目标与 Inbox；root 原生 Schedule 不持有或驱动 Project 目标。rc.2 未导出的生命周期数据辅助能力由 `stock/control/schedule-helpers.ts` 提供，只接受私图 domain／Context，不注册原生 ScheduleService。恢复仅推进选中游标到边界之后，保留原回执；永久删除只清理精确目标行，部分清理与 close 失败如实返回。请求时间上下文的块类型也由本模块拥有，不扩展原版 Session 的接口。

未接入真实 Host 电源来源时，默认 `automaticDispatch: not-connected`。手动运行不依赖恢复事实，也不启用自动计划。实际 Host 接入／状态由统一整合层投影；内部受控事实只验证自动接缝，不能证明实际 OS 恢复、完整自动定时或 M3。

## 管理与主动运行

- 用户管理当前项目；主会话管理本项目全部工作目标；执行会话只管理自己。身份由实际设置动作或 `ToolRunContext` 解析，不接受 JSON 自报角色。Bot、跨项目和来源不可用目标不接纳。
- `read/save/setEnabled/remove/runNow` 共用原 Store。项目设置挂载 `SchedulePanel`，列表提供现有任务详情和来源；overview 不增加运行按钮。
- 工作 scope 安装 `project_schedule_list`、`project_schedule_save_config`、`project_schedule_set_enabled`、`project_schedule_remove_config`、`project_schedule_run_now` 五个工具。真实工具调用 identity 由 Core 绑定，不允许模型指定重传身份。
- `project_schedule_save_config` 的 `input_json` 是结构化对象：新建包含 `sessionId/title/prompt/enabled/rule`，编辑另外要求现有 `id/expectedRevision` 并保持原目标；六类规则的字段与类型在实际工具 schema 中完整提供。编辑时，规则规范化后与已存规则相同就保留原 anchorAt；只改标题、正文或启停不重新计时。规范化后的规则真正改变时，按新规则在保存时重新计算锚点；要保留时间起点，复用 list 返回的 rule。`sessionId` 取 `list.targets[].id`，权限仍由 Core 和原 service 核实。保存后重新 list，以 `time.nextAt` 和规则时区说明真实下一次计划；保存不等于已运行。旧会话的同字段 JSON 字符串仅在同一执行入口解码后经过当前参数与原业务验证，新模型 schema 不提供字符串备选，原历史不改写。
- 手动请求在原目标排 `next-turn`，忙时等候，不 steer、不新建 Session、不等待目标整轮结束。停用或错过的一次性计划仍可明确手动运行；rule、anchor、enabled、enabledSince 及自动 attempt/missed 均不改变。
- 同一次点击/真实 tool call 保持 request identity。最终原 Store slot 内严格核对当前目标、调用者、修订和真实 native 请求；同请求已取消或结束仍不重投。下一次明确点击才生成新请求。
- 先验证完整来源、原消息身份及 RunLink，再同步 send。send 后的调用者取消不跳过原 owner 有限保存和 flush。两份保存分别报告；双存储失败不承诺跨进程 exactly-once。

## 保存与未开始项

`ProjectScheduleStore` 复用唯一原 serial。`changeCommitted` 在确认设置保存后，同 slot 同步消费待执行消息，再释放 slot；`readWith` 在冷读取同 slot 同步消费。consumer 不得重入 Store。

保存异常同 slot 只读回实际状态，区分确认新状态、确认旧状态与无法确认。不重试写，不在异常后修改 native，也不把 rename 后异常称为零效果。结果分别表示 configuration、pending 和 nativeSaved；`partial` 保留已发生事实，`required` 仅表示接缝未装配。

`pending.ts` 先完整验证精确 project/session/host、source、修订与选集，再同步在原位置 replace/remove。普通输入、其它计划及已 claimed 工作不受影响；中途 native mutation 失败报告已发生 ID 和 unconfirmed。

- automatic：停用、移除、旧规则或真实显式取消修订之前的未开始项取消；同规则内容编辑保留 message/occurrence/队列位置。已合法 pending 不因跨时钟段 UTC 重新资格审查；原 `manualCancelRevision` 保留兼容字段名，同时供 automatic 以 `definitionRevision` 判断旧项。规则改变、停用、移除和已 claimed 边界保持。
- manual：内容/规则编辑采用当前定义，保持 immutable requestId/requestedAt/requestedBy/acceptedRevision。显式 `setEnabled(false)`（包括 already false）与 save true→false 推进原定义 `manualCancelRevision`；false 下普通编辑和启用不清边界。缺定义取消尚未开始项。停用后的新明确请求可运行。
- 冷首次 claim：原 factory maintenance 包围 serial `agent/created`；有 schedule pending 才读该 Store，同步协调并 flush 后允许首次 claim。只有这次 pending 协调失败请求既有 factory 特定 rollback 保留混排 Inbox；正常 setup failure、Stop、dispose 和先发生的 owner close 保持原义。其它目标不全局禁用。

## 数据与来源

ScheduleStore 新写 v3，v1/v2 查看只在内存 normalize，不因 read 写盘；旧真实 v2 reader 拒绝 v3，不授权破坏式降级。LIFE-ALL 的有限生命周期身份由同一 ProjectStore v11 引入，完整永久删除沿该 owner 升至 v12，所有 writer 保留更高封套；ScheduleStore 保持 v3。移除定义保留 runs；历史详情不能重新 runNow。

`project-schedule` 是无 form 的系统 producer。manual 来源将本次 `requestedBy` 与定义 `managementSources` 分开；计划正文、tool ID 和自动提示不成为新用户决定。`isUserDecision` 仍只承认真实 user source。

`native.ts` 严格解析真实 source，按事件顺序保留每次 insertion 的生命周期。`currentScheduleObservations` 选择同 message 当前版本，旧 canceled 不遮蔽同 ID 替换后的 pending/claim；历史取消继续保留。model-only replacement 不产生新原文、claim 或实际活动。

`readRun` 沿同一 retained/sourceLifecycle/revision/pre-post/cut 读取真实持久 prefix，不消费 Query 合成 closer。RunLink 保存失败时从精确 strict native 补只读视图，查看不写关联、不唤醒、不重投。inserted、claimed、discarded 与实际 turn error 分开；正常 ended 不等于 achieved，没有业务/permission owner 的事实保持 unknown。

资格 unknown 的新 attempt 在发送前退出时为 admission `not-enqueued`／outcome `unknown`，reason 明示该次未调用 send；send 调用后未确认仍为 admission `unknown`。旧 unknown 及原已发送信息不翻写，status/taskOutcome unknown 不自动变为任务失败或全历史未执行。

## 自动接缝与生命周期

自动 occurrence 身份包括原规则、锚点和计划时刻，不包括标题、正文或修订。首次 await 前的易失 attempt 只禁止失败后的同项重试，不代表已开始准备。原生来源读取或 target operation 等待后，恢复期间首次发现的旧项直接跳过，不解析 Agent。

冷启动扫描已有明确 `enqueued` 的项时，只消费其自身计划时刻，不把整个启动前区间视为已经结算。首次缺少可核实旧来源的冷旧项仍保存原 `unknown` 观察，reason 说明从该计划时刻至本次内部就绪采样之间实际略过的旧候选及不补投；旧尝试结果保持未知，已有入队事实保留。此说明不声称范围内每个时槽均已确认未投递，也不把 `boundaryAt` 重新定义为区间记录字段。外部 Host-ready 观测不能代替内部 `connect()` 的实际就绪采样。

D17 的继续资格由真实 `prepare(target, start)` caller 在原 `resolveAgent` 调用处产生：`start(() => resolveAgent(...))` 调用原解析器一次，返回同一 Promise；前后同步取样均可靠、恢复 epoch／边界未改变，才记录进程内 `started`。原准备未失败时可跨后来休眠继续这一次；内容编辑用最终定义，停用、移除、改规则、重新启用边界、归档和 close 仍经最后实际检查。准备不是入队或执行，资格不持久化，不可由 map 占位、timer 已装或计划时刻在线代替。公共 caller 的接线由统一 Runtime 整合负责；未传 `start` 的 caller 不获得跨恢复继续资格。

处理原项后，下一候选越过可确认的真实恢复边界，其它休眠漏跑不从旧 plannedAt 连续补投；已合法 pending 沿原普通队列处理。resolve/load/save/flush 最终失败不重试，新进程 ready 后旧 once 不补发，recurring 保原 anchor 从边界后继续。ScheduleStore 保持 v3，未新增持久尝试或恢复字段。

真实电源事实使用 `provenance: darwin-kernel`、固定于当前已核段的 `baselineAt/baselineEpoch` 和同进程单调 `epoch`；旧 `controlled-fixture` 的 exact `recoveredAt` 仍单独保留。`connectHost` 只允许真实 appReady／Runtime ready 后连接，首次业务读取之后记录 automatic ready，真实 appReady 前不建业务基线，不能把启动前旧 wake 推成许可。raw／成组 epoch／时钟及恢复范围解释由 Darwin provider 拥有，本模块只按该事实逐 occurrence 分类。真实断裂保留旧段 unknown；provider 以两个独立完整 native 样本的当前一致区间在业务 read 启用新段。旧段不复活，准备资格若 epoch 早于 baselineEpoch 不得延续；缺失、epoch 倒退、同段窗口矛盾或不能核实的当前事实仍保持 unknown。

若只有 `recoveryWindow{lowerBound,upperBound}`：计划不晚于 lower 可确认在恢复前，晚于 upper 可确认在恢复后；中间保持 unknown。µs 样本序列化为 UTC ms 时 lower 向下、upper 向上封闭，upper 可比同样本 observedAt 的 floor 表示大 1ms；这不是一个精确恢复时刻或经验容差。正常同 epoch 的 baseline 后 future 不需要完整恢复 UTC。真实 kernel epoch 解释依据已核对的 Apple XNU 同 release family 源码假设，尚非当前 OS exact build 和所有真实休眠模式的实证。

未知范围只保存一次现有 unknown observation，并在 reason 说明范围；易失候选推进到范围后的下一计划，不把 upper 当恢复点、不声称每个 key 都有独立记录，也不标作已确定睡眠漏跑／准备失败。重复 hint、后来范围收窄、退出重开不会补投这些已放下的未知项，后续可判定 future 继续。每个 hint 会重新读取事实；`currentPowerFact()` 只投影最近已验证快照，读取状态不另做分类或创建 provider 基线。

原版完整恢复范围 reason 已有 upper；timing owner 集中严格兼容解码，仅接受完整格式、合法 UTC、同计划／规则／时槽、plannedAt 位于 (lower,upper] 的原事实，回拨后重开仍越过已放下范围。不从未知 reason 猜上界，不把 observedAt 当上界，不升 ScheduleStore v3。

前后两次取样不是 OS 原子操作。若原调用之间发生恢复或事实未知，开始资格为 `uncertain`，结果保持 unknown；这也意味着该窄区间里实际先开始的准备尚不能保证继续。真实 sleep/wake 与具体边界覆盖仍需独立成立，通知收件时间不能冒充恢复事实。最后 load 后的 current/source/facts/time→send 无 await 同样只证明 JS 同步边界。

同一 SourceDisposition registration 显式排除原 native 定时的精确 Project Store main/execution/Bot roots；普通 F/X 与其它 claimed 来源保持原规则，原 native catalog/history 不隐藏。标准 appReady 完成初始投影后，native owner 才驱动和装工具；祖先 UNLOADING 同步 cut/clearTimer，原 Agent/B 停止与有限操作 drain 并行，source 最后撤销，晚初始化不复活。

**旧 MGT 受限包历史范围**：当时定义或任意 automatic/manual runs 使“无定时删除”范围拒绝，未开放带定时 archive/delete、整项目删除或用户删除入口。该限制不代表当前完整 DEL 入口；当前永久删除沿 `deletion-all.ts` 和两个 Schedule Store 的 exact purge，统一整合证据由本轮总交回持有。HMR、单独卸载与真实睡眠模式不由该旧包证明。

## 验证入口

手动运行上方显示提交当时的接纳回执，分别保留当时入队、运行关联保存和原会话输入保存的确认程度，不将该回执解释成当前等待或处理状态。显式刷新后的当前状态只沿既有运行记录展示；读取失败撤下旧记录，但保留历史回执及原会话来源入口。刷新不重新发送请求，回合结束也不代表任务达成。

模块测试位于 `tests/features/schedule`：原时间/来源控制、`mgmt-owner-{store,pending,service,native}.test.ts`、组件/五工具/controller。组合自验为 `tests/sched-mgmt1-runtime.test.ts`，D17 在 `tests/sched-d17-runtime.test.ts`。D17 使用真实 Session/Inbox/JSONL/ProjectsRuntime owner 与确定性模型、受控电源来源；实际 OS 与自然模型效果不在该验证内。相邻 INT1、C3/source、OWN-F1、普通 Stop 只选受影响控制。

从项目根运行 `npm run test:host -- workspace/packages/projects/tests/sched-mgmt1-runtime.test.ts`；统一入口使用固定 RC.5 并为本轮生成独立 evidence，reopen worker 继承同一目录并核对子路径。也可用 `DSH_SCHEDULE_TEST_EVIDENCE` 指定新的绝对目录。其它 Host、源码组件、编译客户端和成品入口见[当前测试说明](../../../tests/README.md)。

旧 MGT 候选曾完成正常 native/Projects 生成、构建、打包、官方显式 offline 私有安装、当时的 GUI 和新 Host PID 自验；精确命令、原始失败、安装 byte identity 及未覆盖边界由原 HANDOFF/MGT 矩阵持有，不外推本轮新增功能的 GUI。当前统一包由总整合者正常再生、安装与取证，自验不裁 Pass，fresh integrated 核实由总开发安排。

归档保留原启停、锚点和取消修订，配置保存资格与工作接纳分别核实。归档设置页仍可保存，主动运行拒绝归档目标；实际最后恢复释放边界传给原 Runtime，只选未来计划。原 native child 计划继续由原 owner 持有 cursor 和真实未投递事实，不新增队列或删除接口。

## 概览与会话快捷入口

`ScheduleOverview` 复用原 `read` 快照，只显示所属会话、启停、规则、下次时间与当前可得的自动执行事实，并跳转同一 `SchedulePanel`；概览没有保存、启停或运行按钮。执行会话“更多”的定时入口将其实际会话标识带入项目设置的 `initialSessionId`，列表、运行关联和新建表单初始定位此目标。该值只是查看范围，后端仍按原真实用户/主会话/执行会话身份判定权限；执行工具不因此得到其它会话管理权。已归档目标保持归档，查看与保存不恢复工作。

配置保存先使用现存真实 Inbox；冷目标先只读原生日志，无待执行输入时不恢复 Agent。有真实 pending 的未归档冷目标以原生命周期驱动暂停进入真实 owner，沿同一设置保存 slot 修改并 flush，释放暂停不唤醒旧工作；该暂停只约束目标 root，不阻止已有自有子会话继续当前或已排队工作。归档且未连接的 pending、实际修改或 flush 未确认分别沿原 effects 如实交回，保存定义不冒充输入已取消。

## 主会话当前承载准入

`ScheduleRuntimeHost.withTargetAdmission` 在实际准备前按稳定工作会话定位current，并将固定目标及最终同步核准带回Runtime。自动时隙、手动请求和配置保存均持同一共享准入，直到原生插入、RunLink保存、原生日志flush及pending consumer释放；扫描或设置快照中的旧host不能用于准备后来已退役的入口。执行会话沿原准入语义，不迁移队列。

已保存的manual request优先沿全部真实carriers与原RunLink只读返回原host及当前可得事实，不为重复请求准备新current，也不重新投递。新时隙仍使用原schedule／rule／anchor／occurrence，已接纳pending／claimed继续归原host；内容编辑、显式取消及移除仍由原consumer精确处理，不能借接力重建或补跑。

`tests/features/schedule/continuity-admission.test.ts` 核Runtime源码调用、真实Store及原生Inbox的准备／保存准入、新current时隙、旧pending／claimed和跨段重复manual归属。测试中的current与准入provider是受控端口，不能替代P1真实发布／生命周期或正常默认JS安装验收；实际睡眠／唤醒与模型效果保持未验证。
