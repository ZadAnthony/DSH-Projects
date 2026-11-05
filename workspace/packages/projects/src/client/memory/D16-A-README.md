# D16-A 当前记忆 owner

本模块落实产品方案 D16 的当前内容与供给边界，保留既有主题文件、索引、设置编辑、来源和最小撤回标记。它不是完整 Memory Bot、公共接线、真实模型效果或旧 D15 失败修复的证明。

## 接口与归属

- `MemoryProjectAccess.role` 由 `MemoryCorePort.resolveProject` 返回真实绑定。仅 `memory` 可调用自动 `save`；`withdraw` 只允许真实 settings 或 `memory`。缺省角色不能获得后台写权限。settings 继续使用原 `saveFromSettings`，不经过 Bot 审批。
- `installMemoryTools` 只注册 list/read/request，并要求 `requests: MemoryRequestPort`；`installMemoryBotTools` 注册 list/read/source/save/withdraw。没有旧写入口 fallback。只证明 Projects 自己的工具集合，不证明 Bot 原生工具、schedule 或其它插件能力已隔离。
- `requestChange` 重新读取原用户事件，核项目、可读性与真实人类 producer。不能把 `role=user` 或 `isUserDecision` 历史字段单独当作人类资格；目标同时须为唯一原用户项。旧消息和必要上下文只有经同一 reader 唯一解析到 `native-event` 才交给 request owner；不传模型 quote、聊天正文或整理候选。`accepted` 只说明请求被保留。队列、冻结、批次、持久位置、归档/退出和执行前再核原文由批处理/公共 owner 负责。身份和定位不证明原话的语义要求或主题已获采纳。
- 所有 type 的 `MemoryContext.provided` 恒为空，渲染器也不消费该字段。`entries` 是当前索引元信息；正文仍由 `read` 按需取得。scope 保留索引适用范围语义，不启用默认全文例外。
- `prepareMemoryIndexState` 是无 IO 的当前供给状态投影助手，输入取每次请求异步 `ProjectMemoryService.context()` 返回的当前快照，不传历史磁盘索引。公共 surface 始终渲染完整当前目录；助手不再计算无人消费的 full/delta/none 或 rebuild 结果。既有 state 字段及构造算法保持，旧 catalog 仍可读取。成功按需读取后由公共层调用 `markMemoryRead`，索引摘要不算读过正文。失效说明保留真实版本、范围、来源和已读事实，不带旧标题/摘要/正文。

## 公共层接入职责

request 依赖、可信 memory 角色与隐藏会话、正常活动、模型 route/用量、生命周期和输入框挂载归公共整合者；此模块不加旧写 fallback。局部 store/工具/组件测试不能代替这些实际接线的同版验证。

索引助手不修改 native 消息、压缩或历史。公共层须处理真实当前 surface、已读工具正文/context 的失效和自然重建；仅追加“忽略旧内容”不能证明旧 surface 已移除。供给状态只从最后一次实际 dispatch 恢复；未派发的 prepare 或 append 不提前承认已交付。

`memoryChangeNotice` 仅映射**单次完整 write**。调用者必须把更新输入的原 `id` 作为 `previousMemoryId`；不能省略而把更新误报新增。settings 的单次完整写可直接消费；Bot 多写批次必须先由批处理 owner 汇总。整批 partial/failed/nochange 时不能逐写立即发完整成功提示，即使其中已有一次 saved。此函数不拥有整批状态，也不发送消息或提示。

## 数据兼容与内容边界

来源统一使用共享 codec：`native-event` 保留项目／逻辑会话、实际承载、header、代际、事件、摘要和可选正文流／范围；已保存通信 part 沿通信 owner 的 holder／record／delivery／snapshot／part 合同校验。文件保持“当前文件”含义。序列化、工具 Schema、来源键、originSources、最小撤回标记与设置编辑使用同一表示，未知字段明确拒绝，不静默剥离。临时正文 cursor 不保存为记忆来源。

旧 type/nature、work scope 与 record 来源仍可解码；读取不迁移、不改写用户文件。旧 work 不进入当前供给，但可显式查看、选择现行范围编辑或撤回。设置只编辑其它字段时，现有 record／旧消息／精确事件／通信 part 全字段保留，即使原来源后来不可读；不能新增旧 record。手工无来源的保存由真实 settings 动作补上来源。旧消息／工具未指定版本，自动写入前必须由实际 reader 唯一固定为精确事件；存在多版且不可唯一指定时如实失败，不把当前正文冒充旧版。

继续保留 CAS、同次正文／索引及 partial：Bot 旧 revision 不覆盖用户已保存值，partial 不报完整成功。撤回标记只有身份／来源／撤回时间；可读且唯一的旧来源额外保留精确 alias，不改写旧定位。表示键包括正文范围；原事件身份另用于判断“新确认”：同一事件的其它页／范围不是新用户确认。同事件相交范围或整事件引用不能复活已撤回材料，不相交的独立范围和后来同消息 ID 的新事件版本不被连带撤回。已有独立主题的唯一可核 alias 不误判为新引入来源。旧标记若只有无法唯一定位的 legacy 来源，不能推定其与某版 exact 等价；这部分历史限制仍须明示，不能声称机械识别所有转述。

新 Bot 不保存 unverified。五类自动内容为持续约定／偏好、项目背景、已查证发现、重要选择的背景／理由／成立条件和事情回忆。`experience` 同时允许选择经验及事情概况、记录时点、成果／当前状态与原文接续入口，不新增强制事情类型或台账。无理由的选择不补造理由；用户填写自由，不因自动类别而清理。无变化不调用 save，不改正文／索引／时间；本批处理范围的结算归 BatchOwner。当前验收核系统执行及五类说明／Schema的真实装配，不验证模型理解、判断和采用效果。

## 验证范围

旧专属入口在 `packages/projects/tests/d16-a/`。本轮精确来源与存储回归入口为 `tests/memory-persistence-precise.test.ts`、`tests/memory-client.test.ts` 及 `tests/tsconfig.memory-persistence.json`，输出归本轮工作根 `persistence/evidence/`。真实注册工具、Markdown／index、设置用户编辑、CAS、正文写失败／索引 partial、最小撤回和新旧来源版本边界分别核对。首败和驱动配置错误保留；不能用局部通过宣布P5或完整MR已经通过。

真实文件 store/service、受控身份/原来源、本地 native ToolRuntime 注册和纯索引投影只能证明 A1–A5 的相应模块边界；不证明真实 AgentLoop 输入、完整 UI、隐藏 Bot 运行、语义效果、缓存或费用改善。公共 Host 旧默认正文断言需由单整合者同步，不能把本包 noEmit 当整包可构建。
