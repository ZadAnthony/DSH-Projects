# D15 项目整体看板

当前看板已通过Runtime接到Core、stock Host、完整Client和每次独立请求准备。本文维护同一领域owner、接口与供给合同；D15-O1当时的模块自验不单独证明完整成品或模型已采用当前背景。

## 内容和唯一保存处

项目根的 overview.json（schemaVersion 2）唯一保存项目整体目标/范围、规划、阶段进展、重要问题与相关入口。只有真实项目主会话可维护；用户与执行会话只读。内容沿用普通文字、列表、字符串表格和有序区块，没有逐项要求、任务、成果、认可或核对台账，也没有另一份 goal 字段。

每个区块可带可选字符串 `summary`，由同一真实主会话维护，供人先扫读；`content`仍保存同块完整说明，两者使用同一信息与来源。主会话应把重要待决、约束和未知写进概况，不把它们只留在展开全文里；没有硬字数、固定业务栏目或语义分类器。存储只核字段类型，不验证业务概括效果，也不增加Bot、模型请求或另一份台账。旧v2区块没有`summary`时仍原样读取，不写盘迁移、不截断正文或自动摘要；后续旧writer不带该字段替换区块时，也不会残留旧概况。UI据有无有效概况展示，并始终保留完整正文与系统来源限制。

这是v2内的可选字段扩展。新版读取器兼容无`summary`的旧v2文件；旧二进制的严格读取器会拒绝包含该新字段的文件，不能称为旧版无损向后读取。降回旧版前需由获得授权的维护方处理该差额，本模块不自动删除新字段。

缺文件返回空 blocks 和简单占位，不落盘、不补模板、不请求模型；损坏或错误版本如实报错，不当作空白覆盖。旧 views/overview.json 与 Project.goal 不读取、不迁移、不回退。移除区块不删除原聊天/文件/Memory，不代表撤销用户目标。

同一 runtime 必须共用一个 OverviewStore。沿用串行读改写及临时文件原子替换；不创建项目目录，项目存在与生命周期写范围由 Core 保证。put 仅替换或追加对应区块；remove 移除指定区块；reorder 要求每个现有 ID 一次且保留内容更新时间。时间和更新者由服务端真实身份赋值，模型不能提供。保存不发送消息、不唤醒会话、不读来源正文；需要协调时由会话明确发消息。

D25：同一真实 writer 提交严格相同的完整区块输入时，保留原区块及内容更新时间；任一概况、正文、来源或 writer 不同均正常更新。不做自然语言等价判断。

## 公共接口

Host 从 index.ts 导入：

- OverviewStore(dataRoot)：read、readState、update，仅处理该 overview.json；不要向浏览器暴露 update。
- OverviewService({store, core, now?})：read、readSource、readContext、putBlock、removeBlock、reorderBlocks。
- installOverviewTools(agent, {resolveCall}, installationRole)：主会话安装四工具，执行会话只安装读取，返回释放函数；Runtime传真实角色，resolveCall与Service仍在实际调用时核对本项目与角色。
- contract.ts 的窄类型经 index.ts 导出，不依赖 ProjectDetail 或整份 LibraryEntry。

浏览器从 client.ts 导入 OverviewPanel/OverviewBoard 与类型；不引入 Node 存储。OverviewClientActions 只有 read；onNavigate 只有查看来源或会话的含义，不附带任何执行/批准/修复动作。保留项目切换 epoch 和项目归属检查，迟到 A 结果/错误不能污染 B。

### OverviewCorePort

| 方法 | 合同 |
| --- | --- |
| resolveAccess({projectId}) | 核实真实用户/会话及项目归属，返回 OverviewAccess。会话身份含实际 sessionId 和 main/execution；不能信任工具参数中的 role |
| readProjectFacts(access) | 返回 OverviewOwnerRead 的窄事实：projectId、name、projectRoot、workspace?、archived、sessions。session 含 id/projectId/hostSessionId/role/title/archived；workspace 与设置使用同一真实值。这里没有总体正文 |
| readSource(access, reference) | 按精确定位核本项目授权、读取当前原文/原件入口，返回含 projectId、原 reference、可用性、readAt、rows/真实来源时间及限制的 OverviewSourceView。未知删除原因不能伪造已删除 |
| readRuntime?(access) | 返回现有 live running/idle/unknown、sessionId、observedAt/reason；不能从聊天或业务进度推断 |

允许来源只有：

- native：{kind:'native', source:NativeProjectSource}，直接 type-import source-reader 的 message/tool 定位。
- Library：{kind:'library', location:LibraryFileLocation}，直接 type-import library-contract 的 {kind:'project-file',relativePath} 或 {kind:'reference',entryId}。
- 项目会话：{kind:'session',id:ProjectSessionId}，不把原生 hostSessionId 当作项目 ID。
- Memory：{kind:'memory',topicId}，读取既有同一正文，不复制规则。

来源不保存快照，内容正文也不回写 overview。每次显式 read 重新读取来源，同一次 read 仅复用同一精确定位的读取。来源失败保留已存整体说明，丢弃失败响应附带的不可用 rows，不拿上次值补齐；跨项目或定位错配也不展示原内容。项目/运行事实同样拒绝错绑归属。没有来源时明确显示，不能据摘要声称读过原话。

原文、文件、Memory、会话来源的授权/展示投影/精确定位和真实删除原因由 Core/L0/Memory owner 提供。模块没有全局会话搜索或文件读取兜底，也不为用户只读伪造 main 写身份。普通 missing 标签不推断已删除；只有 owner 的实际原因可以说明删除。

### readContext({projectId})

遵循同一真实项目访问校验，只重新读取当前 overview.json：

- available：返回同一 document、projectId、readAt。
- missing：返回空 schemaVersion 2 document 与真实 missing，不伪造更新时间。
- unreadable：只返回实际错误消息、projectId、readAt，不带旧 document。
- 授权/项目归属失败仍拒绝，不伪装正文缺失。

`document.blocks`原样包含可选`summary`与完整`content`。模型读取结果的同次来源复用与请求上下文的逐块JSON供给保留这些字段，不用概况替代模型可读的完整正文。

它不调用 readProjectFacts/readSource/readRuntime，不展开聊天/文件或复制 Memory 正文，也不是持久上下文缓存。Runtime通过`project-request-context.ts`注册到插件`stock/request/harness.ts`的`onProjectRequestPrepare`，每次独立请求重新读取此接口，将当前总体正文、真实身份/运行条件及指令来源作为带 Projects 来源的 user 补充上下文提供；完整项目/会话指令分别进入不插值的 system section，记忆仍为全部索引自动、正文按需。正常请求、工具续步、既有重试及压缩恢复共用该准备入口；不能只在 Agent 创建时读取或继续使用旧 Project.goal/业务账快照。当前可识别块被替换，读取失败撤下旧值并说明缺项；已准备调用不追溯改写，保存本身不唤醒或广播。

### 工具与公开导航

四工具保持 project_overview_read / project_overview_put_block / project_overview_remove_block / project_overview_reorder。主会话取得全部四项；执行会话的实际注册、模型Schema和PTC SDK只提供project_overview_read，写入端角色校验继续保留。工具描述改为维护当前整体内容；put 的 block_json 严格解析 id/title/可选summary/content/sources，不接收更新时间、角色或旧台账来源。summary保留字符串原值；text/list/table 和空内容/空来源都允许，不加富文本或语义分类器。

公共 overviewRead 调用绑定为 user 的 service.read；overviewSource 复用 service.readSource({projectId,reference})。OverviewView包含documentStatus、project、runtime，已沿公共DTO／Remote／Host／controller／Panel接通。Library 导航使用 location，原文用 native locator，会话映射经同一 Core。

## 验证入口与范围

领域测试位于`tests/features/overview/`，覆盖Store保存／隔离、授权、当前context、来源失败、四工具及界面；完整请求装配由Runtime及stock请求测试核对。当前工具与正常构建见[项目空间入口](../../../../../../docs/technical/DSH-Projects-项目空间与版本入口.md#development-commands)。

D15-O1的窄适配器、DOM、旧命令和当时未覆盖范围见[模块历史](../../../../../../docs/archive/2026-10-26-current-docs-closeout/MODULE-HISTORY.md#领域模块历史自验)。D14台账退役不改判旧证据。完整安装历史见[发行记录](../../../../../../source/releases/44-latest/README.md)。

2026-11-03可选概况差额的[本轮证据](../../../../../../.dev/human-experience-20261103/board/contract/evidence/)包含领域16项与现有来源结果表示5项通过：旧v2无概况读取不改字节和mtime；新概况原值保存、更新、幂等、非法类型与写权限；固定本地响应驱动真实Facade工具、当前请求上下文与DeepSeek序列化。未运行正常构建安装或UI，本轮整合另核这些接缝。系统功能与Harness实现已在上述受测范围通过本阶段验收，模型理解和实际使用效果尚未验证。
