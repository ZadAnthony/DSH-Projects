# 设置：执行默认、项目补充与单会话补充指令

本包沿同一设置 owner 提供三项配置，并提供 Projects 工作会话的模型选择初始化。项目和会话指令只保存用户具体要求与分工；通用职责、边界和工作标准由[统一Agent指令设计](../../../../../../docs/product/DSH-Projects-Agent指令设计.md)中的内置系统提示词提供，清空补充不删除内置基础。执行默认、项目指令、单会话指令、独立组件和删除cut均已接入当前Runtime、stock Host及完整Client。本包没有模型生成、全局配置写入、已有明确会话选择覆盖、消息发送、停止或重启能力；不从共享 Memory、Bot 或聊天复制指令。

## 入口与归属

- Host：`index.ts`；浏览器：`client.ts`。浏览器入口不导入 Node 持久化模块。
- `settings/execution-defaults.json`：项目内、只用于之后新建执行会话的模型选择。`selection: null` 表示沿既有 DSH 默认；缺文件时返回 revision 0/null，不保存一份宿主默认。
- `settings/project-instructions.json`：用户显式编辑的一份项目指令，适用于本项目主会话和全部执行会话；含项目归属、正文、修订与更新时间。缺文件返回 revision 0/空正文，非空白输入保留原文字，空白保存会覆盖为空正文。
- `sessions/<项目会话id>/settings/instructions.json`：该会话完整当前补充指令，只含具体要求、分工及局部约定。保留输入正文，空白输入按清空处理。缺文件读取返回 revision 0/空正文；新建未提供补充时默认空白，明确提供instructions时原样初始化，已有任何 revision（含显式空正文）不覆盖。清空不保存历史副本，不回填或拼接通用职责。
- 每项保存带读取时的 `expectedRevision`，返回 `saved/value`、`conflict/current`；模型目录不可用或选择不支持返回 `unavailable/message`。指令归属、文件读取/保存错误拒绝 Promise，不报告保存成功；组件也处理公共 actions 返回的 `unavailable/message`。
- 核心记录、系统绑定身份与权限、项目整体看板、共享 Memory、DSH 全局默认均不由本包写入或复制。会话模型只在原生 `model/selection` 初始化，后续选择和实际采用继续由 DSH 持有。主／执行通用基础职责由内置系统提示词装配，不保存在本包；项目及会话指令只保存显式补充。用户可填写任何内容，正文不能改变真实身份或扩大工具许可。

## 稳定接口

```ts
const settings = new ProjectSettingsService(corePort, modelsPort)
await settings.readExecutionDefaults({ projectId })
await settings.saveExecutionDefaults({ projectId }, selectionOrNull, expectedRevision)
const plan = await settings.prepareNewExecution({ projectId })

await settings.readProjectInstructions({ projectId })
await settings.saveProjectInstructions({ projectId }, text, expectedRevision)
const shared = await settings.prepareProjectInstructions({ projectId })
shared.get()      // 本项目共享正文的独立副本，不含 sessionId
shared.render()   // 完整项目指令原文，不读取 Memory 正文
await shared.refresh() // 重新核实原项目访问并读取当前文件

await settings.readSessionInstructions({ projectId, sessionId })
await settings.saveSessionInstructions({ projectId, sessionId }, text, expectedRevision)
await settings.initializeSessionInstructions({ projectId, sessionId }, initialText)
// initialized/existing + value；只对缺文件初始化，不是每轮请求的默认值提供器。
const prepared = await settings.prepareSessionInstructions({ projectId, sessionId })
prepared.get()     // 同步、返回独立副本
prepared.render()  // 同步、完整单会话指令原文
await prepared.refresh()
```

`get().value` 是含归属、revision、updatedAt 及完整原文的独立 DTO；`render()` 对可读值只返回原文，清空返回空字符串，不附加竞争职责、不摘要、不解释或插值。`{{variable}}` 等文字须由 system section 的 `interpolate:false` 原样送入模型；集成层不能再将其作为模板渲染。不可读仍由 available/message 与渲染错误事实区分，不把失败当作空值。

初始化不新增文件类型或迁移状态。新主／执行会话未提供补充时使用空正文；创建调用明确提供的`instructions`逐字保存，不拼接M／E通用职责，不从会话名称或聊天推测任务。具体工作及临时要求通过消息传递，不自动写为长期补充。复用已有会话保持保存值；首次scope安装仍可为缺文件初始化空补充，冷关闭后复用scope时沿既有规则延至首次真实请求。普通请求只读取当前正文，不写入通用职责；已有revision及显式清空始终保留。

新创建caller通过`prepareSessionInstructionsCreation`取得精确初始化结果及本次`discardUncreated()`能力。该能力保留初始化时核实的access、store和原值；caller只有真实确认原生会话从未物化后才能消费。它在删除封口后仍可撤销自己未改的初始值及空目录，不重新解析普通设置访问，也不开放读取或保存入口。`existing`、后来保存或值／revision不匹配均保留；I/O失败拒绝且撤下旧上下文，只有精确撤销成功后创建owner才能移除binding。普通`initializeSessionInstructions`仍只对缺文件初始化，不是每轮请求的默认值提供器。

新创建使用严格初始化入口，读取或初始保存失败不能报创建完整成功，沿既有创建失败／回滚语义。现存会话请求中的读取失败由prepare/read owner如实表达，不写默认、不修改损坏来源或回用旧正文；真实归属、生命周期cut、取消及保存失败仍按各自既有合同处理。当前调试期旧会话与补充正文按用户授权由交付侧清空，本包不新增旧职责识别、抽取或迁移流程。

`SettingsCorePort` 只解析实际可访问项目根、准确会话归属及原生 hostSessionId，不开放整份 ProjectStore。它必须由真实设置/会话访问入口提供；不能让模型自报归属成为权限依据。

## 项目指令的接线与生命周期

`readProjectInstructions`、`saveProjectInstructions` 和 `prepareProjectInstructions` 只接受项目 request；真实主/执行会话的成员核实由原 Runtime 安装入口完成。各会话共同取得本项目当前一份配置，单会话 API 仍只提供自己的正文。保存/冲突会更新本 service 的所有该项目已准备投影；同一文件在另一个 service 保存后，须正常重新 prepare/refresh 才读取新值。

每次独立模型请求准备都应 await `prepareProjectInstructions({ projectId })`，并在实际 system section 中采用该次完整原文；工具续步、既有重试、压缩恢复同样适用。同步 `render()` 只显示最近读取/保存的投影；只在会话安装时读取不能证明后续输入已取得当前值。文件读取失败时 prepare 返回 `available: false` 的提供器；项目访问失败拒绝 Promise；两者均撤下该项目旧正文。普通 read/refresh/save 的错误原样拒绝，不能把失败保存显示成成功，也不能在请求准备的 catch 中复用旧段。项目切换、Memory、其它项目与单会话正文互不覆盖；在途已组装请求不追溯改写。

`prepareProjectInstructionsDeletion(projectId)` 扩展原 instruction 操作 owner，项目 target 使用 `[projectId]`，单会话 target 使用 `[projectId, sessionId]`，不会相撞。它只管理本模块正文和责任，不解除 Host 关闭、Runtime 项目 cut 或其它会话 cut，不新增持久状态。

总整合者的唯一调用顺序：

1. 新 Host read/save 继续包在原 `runtime.acceptProjectOperation(projectId, run)`。原 Runtime 关闭先停止接纳，再等待其真实已接纳操作；不能用新模块绕开或替代该 owner。
2. 全项目删除同步准备原 Runtime 项目 cut 与 `settings.prepareProjectInstructionsDeletion(projectId)`，再发出既有真实停止。项目指令 cut 覆盖首个 resolveProject await 之前已经接纳的 read/save/prepare/refresh；它返回后不再接纳该项目的新指令操作。
3. 原组合等待必须包含该 cut 的 `drained`。排空保留真实在途失败；失败且持久来源尚未提交时只 release，沿原删除结果报告未开始清理。不能吞掉失败进入物理删除。
4. 沿原 ProjectStore 来源不可用提交/confirm 时点 commit；从此永久撤下该项目指令投影。已提交后的 partial 保持不可用，后来的 cut.release 不能恢复先前 commit。commit/release 每份 cut 只能选一次。
5. `drained` 成功且原来源提交后，由既有 whole-project namespace owner 清除物理配置。不通过新的 project resolve/open 去清理已经不可用的来源，不另造第二份删除进度或恢复机制。

归档仍由原产品合同决定是否允许设置；本模块不增加归档状态、后台刷新或重试。冷进程的项目已不可用时，SettingsCorePort 必须拒绝解析，不能为了写设置重新打开项目。

Host 内部单会话删除调用 `prepareSessionInstructionsDeletion(projectId, sessionId)`：返回前同步关闭该目标的新 read/save/prepare/refresh，`drained` 等待此前接纳的真实 service 操作结束。Store 开始删除前可 `release()` 保留原投影并恢复接纳；开始删除后 `commit()` 永久撤下该目标的内存正文，返回 `remove()` 清理 owner。每份 cut 只能 commit/release 一次，已有 commit 不会被后续 cut 的 release 撤销。其它会话继续沿原目录写链读写。

`remove()` 等待 cut 排空，只 unlink 精确的 `sessions/<项目会话id>/settings/instructions.json`，返回 `removed/already-absent`，不跟随文件或目录 symlink，不递归清理目录。失败原样拒绝且不恢复内存正文。显式 partial 续做可重新取得 cut；冷续做只解析项目根，不重新开放已不可用的 session access。持久的来源不可用状态仍由 ProjectStore/调用方负责，此 service 不新增状态文件或后台重试。

`SettingsModelPort.modelCatalog()` 消费原生 `ModelCatalog`，可用 `dshSettingsModelPort(ctx.sessionController)` 绑定真实只读方法。可选模型及推理值完全来自此次目录；省略推理值沿模型自身默认，不从其它模型继承。目录失败、提供者局部失败、模型消失或推理选项消失都明确反馈，保留已保存值；不会自动换模型。清除项目默认不依赖目录成功。

正常 stock 绑定中，Pi 型号的继承描述来自原宿主适配器实际依赖的 SDK 公开模型目录，随原配置一起捕获为纯数据快照；目录、推理选项与私有请求准备消费同一描述。只供给用户已配置的 route，不启用其它供应商，也不修改用户模型配置。私有 SDK 仍负责已有供应商工厂、认证与原始用量采集；新增型号可沿已有工厂运行，新增供应商或新协议仍须对应适配，不能据描述符存在宣称任意 SDK 版本均兼容。`settingsCatalog` 与聊天的 `uiModelCatalog` 统一从私有 UI owner 读取，不访问普通会话控制器。

## 新建工作会话消费

`prepareNewExecution()` 每次从项目原配置读取，返回 `inherit`、`configured` 或 `unavailable`。它不返回/修改已有会话。

```ts
const configuration = (role === 'execution' ? dshNewExecutionConfiguration(plan) : undefined)
  ?? dshNewProjectSessionConfiguration(ctx.agentDefaultModel.currentSelection())
// main / inherit -> 在真正新建时采用当时原生默认，保存为该会话自己的原生选择。
// unavailable -> throw：如实显示所选默认不可用，不静默改用另一个模型。
// configured -> agentOptions + initialSelection + initializeInSetup。

await ctx.agents.create({
  // 其它创建字段由核心拥有。
  agentOptions: configuration.agentOptions,
  setup: async (agentCtx, agent) => {
    await configuration.initializeInSetup(agentCtx, agent)
    // 然后执行原有 preset、原生 model-selection 安装和项目能力组合。
  },
})
```

初始选择必须在新建 factory setup 中、宿主读取 pending selection 之前写入原生 `model/selection`，且在用户首次输入前完成正常持久化。`initializeInSetup` 只接受尚无事件的新会话；禁止把它用于恢复/已有会话或每次新输入。本模块只返回创建配置，实际 `ctx.agents.create`、归属绑定、持久化 flush、失败处理及 preset 组合仍由核心拥有。

**不能调用普通宿主的 `SessionController.selectModel()` 实现项目默认或初始化。** 初始化须沿当前Projects创建配置和自身模型选择owner，只写目标会话；已有会话之后显式切换继续沿Projects的准确承载入口和同一模型目录。旧rc.2的全局默认副作用查证保留在[模块历史](../../../../../../docs/archive/2026-10-26-current-docs-closeout/MODULE-HISTORY.md#领域模块历史自验)，不把其源码路径当作当前接缝。

## 旧空工作会话的冷启动接手

`initializeExistingProjectModelSelections(ctx, sessionIds, selection)` 只接受 Runtime 从真实归属选出的来源可用 Projects 主/执行会话。Runtime 在启动接手时捕获一份当前原生默认，在生命周期来源安装、对外使用及 Host ready 之前完成调用；包括归档来源，排除 Memory Bot、terminal 及普通 DSH 会话。这里不读取项目新执行默认，也不声称还原旧记录从未保存的创建时模型。

原生日志已有任意 `model/selection` 或 `request/header` 时不改。无两者的冷日志先通过原生 read handle 筛选，再取得原 single-writer write handle 重读；用原生 `snapshotSessionEvent` 校验唯一 `model/selection`，序号取当前完整合法前缀的结束位置，再 append/flush/close。不构造恢复 Session 或附加恢复标记、不创建/恢复 Agent、不发消息或唤醒。已有 event 提供自然幂等，不另存迁移标记。

函数返回 `ReadonlyMap<SessionId, Error>`，只包含当轮逐来源真实失败，不能忽略返回值当作全体已固定。缺失、损坏、已有 writer、append/flush/close 失败及缺选择的 live 来源只阻止该来源，后续健康来源继续；原 Error 保持，非 Error 以 cause 保留原值。失败不会假报完成、抢占 writer、覆盖来源或自动重试。若 append 已发生但持久化确认失败，结果仍为该次未确认，不把读到 event 改称本次成功。

Runtime 唯一持有该次失败结果，既有来源执行能力、驱动和 scope 安装读取同一事实；对失败来源投影 unknown/readOnly 并如实显示未固定及原因，不从变化后的默认值悄悄运行。原聊天可读性仍由原生读取 owner 决定，失败不伪装删除或改写 Store `sourceLifecycle`，其他项目及独立工作继续。错误信息可从同结果派生到当前界面，不另建配置或持久状态；archive/restore 不清除这一初始化事实，恢复机会沿下一次自然初始化。

符合条件的日志会增加一个原生 event，序号、文件修改时间与查询修订相应改变；Project 记录、项目默认及指令不变。若存储是更旧的物理 Session generation，write-open 可能按 DSH 已有迁移合同发布 successor 并保留旧 generation；模块不自改格式。当前只在新私有旧格式 fixture 验证，真实用户迁移与日常接入仍需既有部署授权。

## 单会话上下文与组件

核心在每次独立模型请求准备时 await `prepareSessionInstructions()` 或显式 `refresh()`，再将本次 `render()` 完整原文用非插值 system section 供给。同一 `ProjectSettingsService` 实例的保存/清空会更新该会话已准备的运行投影；不会影响其它会话。读取失败撤下旧投影并说明限制，不冒充空正文。外部直接改文件没有后台监听；下次请求准备重新读取。该投影不持久化，不把同步 render 冒充磁盘刷新。

归属与修订由 DTO 提供，正文完整进入 system；来源、范围和明确变化统一由 Projects 系统使用说明解释，不固定某个载体高于另一个。清空只移除该用户补充块，不沿用旧正文；内置共同说明与角色基础职责继续按真实身份装配。不强制停止/重启/发消息，已组装/已发出的请求不被追溯改写。模型实际理解和采用留待后续调优，不作为当前系统／Harness验收条件。

独立组件：

- `ExecutionDefaultsSettings({ projectId, actions })`：目录、项目新执行默认、真实推理选项、不可用反馈及沿 DSH 默认。
- `SessionInstructionsSettings({ projectId, sessionId, sessionTitle, actions })`：精确会话补充指令的查看、编辑、清空保存，说明默认空白及清空不删除内置基础。
- `ProjectInstructionsSettings({ projectId, actions })`：普通文字编辑项目共同指令，明确主/执行范围及与选中会话指令的区别，显示保存、冲突、未保存、读取错误和清空反馈。组件不导入 Host/Store；浏览器入口导出 `ProjectInstructionsActions` 与 props。
- 对应 actions 只委托上方 service 方法。项目/会话切换后重新读取；不挂公共设置外壳，不额外配置模型权限、工作区、主会话模型或用量。

## 验证入口与历史依据

领域测试位于`tests/features/settings/`，覆盖保存／清空／CAS、隔离、生命周期cut、模型目录及组件。当前正常构建与工具解析见[项目空间入口](../../../../../../docs/technical/DSH-Projects-项目空间与版本入口.md#development-commands)。

2026-10-15的rc.2源码调查、旧命令、局部自验及当时DEL-V1首败见[模块历史](../../../../../../docs/archive/2026-10-26-current-docs-closeout/MODULE-HISTORY.md#领域模块历史自验)。原结果不改判，也不作为当前未完成接线清单。当前同版安装结果由[发行记录](../../../../../../source/releases/44-latest/README.md)拥有；本次文档整理未重跑验证。

## 公共接线

项目设置“背景与记忆”同时挂载独立的 `ProjectInstructionsSettings` 与原 Memory 设置；项目指令不会从记忆、Bot 或聊天自动复制。Host 的 `projectInstructionsRead/Save` 与原配置入口一样由 `acceptProjectOperation` 持有真实操作，浏览器通过正常生成的 Remote 与 `projectInstructionsActions` 调用。

Runtime 只在已核实的本项目主/执行 scope 安装独立项目指令段。首次安装与每次独立请求准备重读当前 owner；项目与单会话指令分别以完整 system 原文供给，不再放入 user context。访问错误显示当前不可读，不回用旧正文。单会话指令保持自己的目标与段。

项目指令 cut 并入原全项目删除的 wait/commit/release；原 namespace owner 清理唯一配置文件。单执行会话删除保留项目指令。关闭仍排空原已接纳保存责任，不增加第二关闭状态。模块文件／DOM自验不单独证明最终Host组合与界面验收；当前结果沿发行记录读取，模型遵循效果留待后续调优。
