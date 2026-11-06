# USE-1 项目用量

当前模块沿公共 Host 的只读 `usage` 与 `watchUsage` 接到项目设置的独立用量页；数据、缺失与计费含义仍由同一服务持有。主／执行会话可追溯原生子工作的新增量归入原逻辑会话，fork继承历史不重计；子来源不创建Project会话，也不获得新的模型或操作权限。

## 用户得到什么

- 按当前项目精确绑定的承载及其可追溯子来源、模型、日期和请求来源查看已报告 token；包含原生标题和辅助压缩请求。逻辑会话筛选同时汇集该会话的子工作，明细保留真实native身份。
- 总量、未缓存输入、输出、缓存读写、思考分类分别展示；思考已经包含于输出，不能再相加。
- 明示统计范围、读取时间、可得记录的时间范围、不可读会话、缺失轮次、缺报辅助记录及无法归属单个模型的用量。未知不当零。
- 没有可信价格或完整计费规则，费用固定为“未知”；不生成金额估算或账单。
- 项目用量页按需查询和刷新，不保存第二份累计。

## 稳定入口

| 入口 | 导出 | 用途 |
| --- | --- | --- |
| `index.ts` | `ProjectUsageService`, `ProjectUsagePorts`, `ProjectUsageScope` | Host 即时只读汇总 |
| `index.ts` | `createNativeUsageReader`, `deriveNativeUsageTurns`, `NativeUsageRead`, `NativeUsageTurn` | 原生只读适配和窄自验 |
| `client.ts` | `UsagePanel`, `UsagePanelProps`, `formatUsageMetric` | 浏览器组件；无 Host 运行时依赖 |
| `contract.ts`，亦经上述入口导出类型 | `ProjectUsageQuery`, `ProjectUsageResult`, `ProjectUsageActions`, `UsageSession`, `UsageMetrics` 等 | JSON 请求与结果，无日志、正文、文件路径或费用凭据 |

浏览器只能引用 `client.ts` / `contract.ts`，不得从 Host 的 `index.ts` 导入运行时。

## 原生事实与统计规则

当前实现由本目录`native.ts`、`model-fold.ts`、`fold.ts`、`service.ts`和`lineage.ts`共同承担。`fold.ts`保留从41.3采用的attempt／retry归约语义；stock模型请求由`stock/model/runtime.ts`写入`projects/model-request-start/usage/end`，`model-fold.ts`按真实request／attempt归约，保留缺报与raw报告身份。旧定制宿主TokenMeter及辅助压缩源码是算法和历史事件的来源，不是当前Projects增强API的安装位置。

1. 当前stock图中的`createNativeUsageReader(ctx)`通过`readNativeUsageObservation`调用`projectsRead.withPrefix`，核准确header后只消费真实持久前缀，返回`projection: null`。同一query的lineage与计量复用已归约的窄事实；重叠query共享尚未结算的同源观察，新的session事件使旧观察失效。观察复用仍核原授权，完成后不长期缓存正文或统计结果。兼容未安装该port的调用者时，才沿`ctx.sessionQuery.observeSession(..., { projectionMode: 'all' })`读取；prepared observation再通过`ctx.sessionPersistence.open(id, 'read') / handle.read(0)`取真实前缀，并释放观察lease和句柄。结束时刻、cursor和继承边界不取Query补齐终态，不通过类型、reason或碰巧相同的时间猜合成事件。查询不调用`resolveAgent`、`create`、`resume`、模型或原生写接口。
2. 去掉`inheritedEventCount`指示的继承前缀后，`native.ts`用本地`fold.ts`的`deriveTurnTokenUsage`及`deriveTurnTokenUsageDisclosure`读取兼容助手记录；前者保持完整精确合同，后者让已报分类小计和缺报并存。当前`projects/model-request-*`由`model-fold.ts`按request／attempt及purpose归约，并替代同轮或同辅助请求的兼容行，避免双计。归约保留最终消息／stream替换、重试、精确总量、可选分类及实际模型归属，不用简单事件加法。`NativeUsageRead.turns`同时容纳压缩和标题辅助行；原生压缩通过`compactionId`连接start／summary／end；当前技术优化候选补齐无Projects模型报告时的归属、缺报、继承边界及重复summary处理，具体候选验证边界见下节。完整、partial与显式零分别保存；当前Projects同请求重复报告不相加，后续缺报仍保留先前已报小计。
3. 原生 `inputTokens` 是未缓存输入，缓存读写与它互斥；`reasoningTokens` 属于输出子集。汇总直接使用原生精确 `totalTokens`，不把总量、子分类与思考再次相加。缺失的可选分类保留未知；`UsageMetric.reported`仅求实际已报告分类的小计，包括未完整轮次中的可得部分；`unknownTurns`可与该小计同时存在。同一轮可同时计入有已报用量与仍有缺报的轮数，页面明确两者可重叠。`unknownTurns` 只表示该分类不可得的助手轮次；`unknownAuxiliaryRequests` 单独表示该分类不可得的辅助请求记录，不据记录数推断收费。`unknownSources` 表示整个来源不可读或未绑定，不能由此推算轮次或辅助请求数。没有已报告分类且有缺失时为未知，已有小计显示“部分”。完整可读空会话可以显示零，但不能据此把其它不可读来源变零。
4. 原生 session `tokenUsage` 累计会把缺报缓存归零，也缺少模型/时间拆分，因此**不拿四分类之和当精确总量**。live 观察只把其中必需的未缓存输入/输出放在累计参考中，明确其**仅含原生助手累计、含继承历史、不含辅助请求**，未筛选且不参与上方合计。冷会话真实前缀与 prepared 投影来自两次读取，无法在公开接口上证明同一观察时刻，因此不提供该累计参考（`projection` / `nativeReported` 为 null），不混用新旧快照。冷会话原始记录仍正常计量。
5. 多模型轮次或没有完整 retry 模型归属的轮次只进入“模型未能拆分”一次，不复制到每个模型。选择具体模型时，这部分用量仍是归属缺口，不会变成所选模型的零。辅助压缩与标题请求使用各自实际请求的 provider/model，不能归给父轮工作模型；summary 缺报 usage 时，其已记录路由仍可用于筛选，已知属于其它模型的缺报记录不污染当前筛选。结果的 `sources` 区分“会话轮次（含重试）”与“辅助压缩请求（原生记录）”；各组及 coverage 的 `reportedAuxiliaryRequests`、`missingAuxiliaryRequests` 与助手轮次分别计数。
6. 时间筛选按**完整助手轮次结束时刻**或**辅助 summary 用量报告时刻**使用 `[from, to)`，每日分组为 **UTC**。助手跨日期轮次整体归到结束日期，不伪称单次工作请求的时间精度；真实已结束但无 usage 的轮次保留在该日期，全缺失日期显示未知。辅助请求包括标题、turn 内压缩及 idle 手动压缩；summary 已落盘后即使压缩提交失败、缺 end 或父轮未闭合，也保留其已报告用量和报告时间。没有 summary 的失败压缩按真实 end 时间列未知；没有真实结束或报告时间则列“结束时间未知”。原有助手开口轮次仍未知，不凭 stream 补齐结束。无法归属模型的缺口单列“模型未能拆分”。来源整体缺失时，其未知模型/日期占位不创建虚假的轮次；各已有模型/日期小计亦标来源不全，该不确定性不表示在各组重复分配消耗。表单输入/读取更新时间按浏览器本地时区显示。
7. 原始日志只在 Host 读取，浏览器只收到聚合结果。没有 usage 事件库、账单库、后台扫描、会话写入或遥测写入。每次查询顺序消费选中会话的小事实；同源在途读取复用，冷读使用open的已验证快照，live仍授权后flush再读真实持久范围。每个来源是各自的精确快照，跨会话不声称原子同时刻；独立的下一次查询仍会重新读取，不宣称跨查询零扫描。

### 历史基线限制与当前技术优化候选

2026-10-26的共享读取修复未修改归约规则。实际当前persistence／ProjectsRead验证发现：在缺少`projects/model-request-*`的native-only压缩来源中，所属turn可能落为null、无summary失败可能漏unknown辅助行、跨继承start的summary可能仍计入、同compaction重复summary可能重复计量。这些是原基线当时已有的兼容缺口，可能影响对应来源的归属、覆盖或总量；未核真实资料发生频率，不能推断无用户影响。下述候选补齐本节第6项及相关归约，46.1安装版仍保留其原受测边界。

46.1共享读取修复时，原完整组合有7个与当时HEAD相同的红项，其中3项使用已移除的原生事件词汇，另4项对应上述真实兼容缺口；不能全部归为旧测试噪音。原Projects报告、retry／继承和共享读取的受测范围及逐项归因见[开发交回](../../../../../../.dev/local-context-fix-20261026/reads/HANDOFF.md)，历史结果不改判。

2026-10-26技术优化候选`0.1.0-preview.49-tech.1`已在本owner实现四类缺口修复；原失败断言保持，新增实际persistence→ProjectsRead→usage reader／service固定事件验证。定向自验、严格类型检查与正常插件构建已通过；完整受影响组合仍如实保留3个旧事件词汇fixture失败，不能声明全部usage全绿。最终接收与独立复核范围由[当前技术优化安排](../../../../../../docs/technical/DSH-Projects-开发计划与验收清单.md#technical-optimization-20261026)及[本轮证据](../../../../../../.dev/technical-optimization-20261026/usage/)读取。该候选尚未安装，不产生费用估算、后台调度或模型效果结论。

失败或未被采用不会成为剔除已报告消耗的理由。原生标题和摘要接收器在接纳报告时独立保存用量；内容拒绝、取消或后续提交失败均保留已报部分。没有留下报告的真实辅助请求只表示用量未知，不能按零或按调用次数推断成本。其它没有记录的辅助调用、未绑定来源及提供方账单也不在本模块可证明的完整范围内。缺少可信价格和计费规则时，金额始终为 unknown。

## 原始接线合同（接口说明，当前已接入）

### 1. Store根与正向创建来源

`ProjectFeatureModules`复用`core.forProject(projectId)`的当前Store快照，保留全部既有carriers及管理／准备来源。主／执行根使用原Store carrier.header（或已保存ownedLifecycle.rootHeader）的准确创建身份，经`ProjectUsageLineage`向现有usage owner提供派生source binding；不改变Store中的逻辑会话或role。

正向子来源要求父自身的`subagent/catalog`发布childId＋childCreatedAt、匹配的child创建header及一致的直接parent，并先通过现有`SessionQuery`读取策略。原生catalog projection按`inheritedEventCount`排除继承catalog，因此fork不会取得父早先child的归属。`parentSession`不单独证明创建归属，`origin`仅为展示；mode/provider/label/descriptor是可缺失的描述信息。catalog v1的unknown mode或缺少自有descriptor保留可得量，不套用删除／续跑资格；provider未知就省略。不会直接读FS绕过拒绝。

每条可证来源都保留真实hostSessionId、createdAt、root、direct parent、depth及可得描述，sessionId仍是原逻辑会话。quantity仍由原生ordinary/aux fold处理，只消费own suffix；相同native来源只计一次。模型／时间筛选沿原usage owner，子工作另列`subagent`、`subagent-compaction`、`subagent-title`请求来源组。

不可读、冲突或缺少根原创建身份只让相应后代分支范围未知，可读兄弟和直接根已报量继续保留。Legacy根没有exact header不把已有直接量丢弃。停止／归档后，Store已有原生owned receipt保留正向身份；不建立新账本、不恢复或重跑业务。冷读先Query，再读既有persistence只读原始prefix并关闭句柄，统计不会wake、flush或发起模型。

隐藏memory及session-manager、既有管理／准备来源继续按原绑定覆盖；本次只从main/execution根展开child，不扫描全宿主或扩展其它产品来源。

### 2. Host / Remote 查询

当前stock `ProjectsController`的只读`@Remote('usage')`接收`ProjectUsageQuery`，按现有设置访问权限验证后调用`usage.query(query)`。Host结果类型为`ProjectUsageResult`。沿用Typert生成协议，不手写另一套codec。

浏览器 `ProjectUsageActions.query` 映射到该方法。对象为当前项目；传入单个会话时服务会再次确认其项目归属。打开用量页不需要 Agent 活跃。

### 3. 刷新通知

面板已有手动刷新。Runtime监听`session/event`中的`turn/end`、`projects/model-request-usage`、`session/title-llm-request`、`compaction/summary`和`compaction/end`，按精确会话归属通知`watchUsage`，再令面板的`actions.subscribe(projectId, refresh)`重查。辅助事件只刷新用量，不执行turn/end的输入清理。回调不携带或维护第二份累计，不resolve／wake会话。usage owner额外缓存已核root／child的创建身份以路由child报告、turn结束及新catalog通知；catalog通知可令界面重查新创建child。父回合已结束仍可收到child新已接纳量。不同逻辑会话筛选保留同项目其它已核child索引，model／time不缩小身份索引；Store创建身份变化才失效。该缓存不保存计量值。

`ProjectsController.watch`的项目记录变化与`watchUsage`的用量刷新各沿自身入口。未接subscribe的调用者按打开／筛选／手动刷新读取，并显示实际更新时间。旧B4／27候选的静态核对只保留历史受测范围，当前安装结论从发行记录读取。

### 4. UI 挂载与构建输入

- 设置窗口“用量”页挂 `UsagePanel({ projectId, actions })`；组件不创建窗口或修改导航。
- 聊天页面沿用DSH原生用量、上下文和轮次状态，不再额外挂Projects用量摘要或为摘要读取／订阅项目统计。
- Host 把本模块 Host 入口与合同纳入相应类型输入；Client 引用 `client.ts` 后纳入 Client 输入。不要把 `native.ts` 放进浏览器。
- 当前44.3声明匹配原版`0.2.1-rc.3`的peer；事件类型和公开组件沿原版包使用，Projects增强计量由上述本地owner承担，不要求原版导出旧定制API。正常构建生成公共协议，插件不修改DSH源码。
- 模块测试、正常打包安装和完整Host／Client流程各保留准确范围，不用历史某次执行包的“未安装”推断当前状态。

## 验证入口与历史依据

领域回归位于`tests/features/usage/`；当前stock模型、记录与Host测试核模型报告归属及实际接线。正常工具和构建从[项目空间入口](../../../../../../docs/technical/DSH-Projects-项目空间与版本入口.md#development-commands)进入。

USE-1、USE-R1与B4当时的测试数、U1–U3修复、28-token反例、旧命令、首败及未覆盖范围见[模块历史](../../../../../../docs/archive/2026-10-26-current-docs-closeout/MODULE-HISTORY.md#领域模块历史自验)。它们保留各自版本事实；当前完整安装结论见[发行记录](../../../../../../source/releases/44-latest/README.md)。本次文档整理未重跑验证；真实费用、性能收益与模型效果没有据此得到验证。

## 部分轮次的披露

`NativeUsageTurn.usage`仍是原生完整轮次精确值；新增`reportedUsage`是同一原生attempt fold派生的只读小计和分类缺报。聚合优先消费后者，各可选分类分别保留已报值，不能因另一请求缺少该分类而抹掉已知部分。缺报不计零，也不借会话累计参考补齐。

未结束轮次保留`endedAt: null`，放在结束时间未知分组，不将prepared合成结束当作真实结束；其模型也继续保持无法精确归属。其它轮次仍按真实结束时间筛选。缺失attempt路由、混合模型及继承边界继续沿原合同保守归属，不新增逐请求/业务意图摊账、请求、持久记录或费用估算。原生辅助摘要保持独立来源与计量，不并入工作模型轮次。

## 主会话接力与管理来源

用量绑定由 runtime 提供稳定主会话的全部实际 carriers、管理 Bot 和已归属的准备来源；准备物不成为工作入口。`session-manager` 的轮次（含补读、重试）和辅助压缩分别在请求来源分组标识，保留真实模型、失败、取消、晚到与缺报。独立用量页保留该逻辑会话全部 carrier 的来源明细与项目汇总，仍不保存累计或估算费用；未知来源与明确零分别披露。
