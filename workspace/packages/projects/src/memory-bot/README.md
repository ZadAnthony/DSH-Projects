# Memory Bot批次与运行接缝

本模块拥有机械触发、显式请求队列、单项目单批、冻结范围与持久结算；`memory-bot-runtime.ts`桥接真实Agent、工具、JSONL日志和模型边界。记忆正文／索引仍只有Memory service/store写入口，归档／退出事实仍由Projects生命周期owner持有。

## 状态与范围

`memory/.bot-state.json` v2保留每host的processed cut。完整原生前缀重建已见输入、通信副本及同attempt流范围；不再保存另一份永久逐消息目录。`pendingBatches`仅持有未完成批次的精确source manifest和输入digest；`frozen`是首个未完成批的兼容指针。所有批都不保存可重放write命令或聊天正文。

普通活动通过`read-model.ts`检查可丢弃的Memory专用增量投影。`recordDirectory(fromSeq)`先等待已排队append的ACK，不fsync；只返回新增窄定位，Memory按类型选择相关canonical事件，逐个解码即释放。未变化的warm检查不读原文、不调用全内容`stat`或`withPrefix`，也不以Session快照构造另一份完整数组。cold首次由持久owner流扫建立一次窄目录，Memory只精读相关事件；目录/creation代际改变、来源缺失或processed回退使现有投影失效，不能在原冻结输入下偷偷换新版本。底层仍会作文件身份metadata检查；这不等于每次hash全历史，也不保证任意外部隐蔽改写零IO检测。

缓存不持有raw events、Session、完整请求／工具正文或完整已处理聊天；只保留未处理交流、每host最后稳定已处理上下文、仍可撤销的queued版本及active attempt基线，其余历史仅保留去重与完成轮身份事实。新required progress记录通过`decodeProjectRecord`取得semantic正文；source仍由该helper返回的canonical记录生成，绝不对hydrate后的伪旧事件mint。归档、删除准备、退出和冷恢复均清除该缓存。活动native Session自身仍可保留随历史增长的metadata和必要surface，本模块不宣称整Host常数内存。

候选达到阈值后，先捕获各carrier固定ACK cut，再以`confirmThrough`取得同journal/birth/owner的真实writer-fsync receipt；Session.seq只作目标，不能充当durable证明。投影仍核6完整轮／6,000 Unicode码点，冻结后停在该cut；失败重试只重用该cut，后到交流不能混入。成功processed更新在同cut原地标记并释放旧正文，最多精读每carrier最后一条稳定消息来还原完整上下文；然后下一活动才追后到suffix，不回扫历史。工具日志、隐藏推理、附件大正文、Bot自身和保存提示不计触发。progress通过每attempt的BlockAssembler增量组装，只保留可见正文与必要block骨架；权威block-end替换旧delta，superseded checkpoint正文立即释放。原生final没有attemptId时，后置`projects/assistant-settlement`将它关联回真实attempt，按原始chunk半开范围去重并释放assembler；不同attempt不按文字去重。

新普通批持久标记内部`projectionVersion: 2`。无字段的历史未完成批仍用原先未链接settlement的表示重建、校验coverage并提供原批输入，避免把算法升级误报为原文变化；内部兼容路径同样释放assembler和旧checkpoint正文。未知版本明确拒绝。此版本字段不进入模型包，旧coverage不会被静默改写。

显式批只处理接纳的原请求与必要上下文，不携带或结算全部普通pending。接纳时保存精确引用及其实际零邻居读取结果digest；执行前读取同引用核内容与范围，不能换成同messageId的当前版本。文件上下文改变而不能取得原内容时真实失败、保留未完成，不建立文件快照平台。

## 单批调度

- 空闲接纳显式请求后不等普通阈值，按接纳顺序冻结一次请求批。启动前持久标记attempted。
- 忙时新请求持久排队。当前批真实终止、结果保存并释放active后，只启动尚未尝试的新显式请求；不需要再次活动，不处理普通积压。
- failed／partial／interrupted范围保持在pendingBatches；其它新请求的结束不能自动重试它。下一次真实工作活动才可重读当前记忆并重新整理。失败普通批不阻塞独立新显式请求首次处理。
- no-change不写正文／索引，但仍持久结清本批处理范围。普通完成才推进其冻结cuts；显式完成只结清对应request。
- 实际write结果、结构化batch_result和原生终态共同决定完成。单笔saved之后发生冲突／partial／失败不能给整批成功提示；已生效写入仍在真实工具／原生日志中保留。

`upgradeMemoryBotState`是供离线迁移复用的纯结构转换。v1 processed与未完成事实保留，旧frozen标legacy；无原frozen的历史请求也保留成未完成显式批。转换不执行、完成或自动处理请求；首次真实活动按原前缀重建精确引用，存在版本歧义时保留失败而不猜当前内容。

## Runtime与Harness

普通新批与frozen重试使用窄目录、选择性exact读取及writer receipt，来源的Store membership/creation/lifecycle在读取前后、实际Memory request-prepare再次核对。真实run结束、结算前只复核同generation/cut仍可用；撤销则保留已生效write/outcome与frozen，不推进processed。`readSavedCuts`完整前缀接口只保留给旧显式请求的兼容重建，由同owner receipt与canonical range提供，不再将run seed对象与原journal直接比较，也不作为普通检查或批次入口。旧carrier不以当前host验证，也不接受Query合成终态。source经共用native codec及mint helper生成。

实际Bot请求提供五类内容说明、事情回忆规则和读书会示例、本批输入、当前索引和读取入口。正文按需读取，不默认提供全部主题正文。每个新attempt的request-prepare通过原生`historySeqs`只选择本批surface；旧批input／assistant／tool正文保留原日志，不自动进入新批请求，同批工具调用和结果配对保持。

基本工具为list/read/source/save/withdraw/batch_result。额外聊天查询／读取／正文续读由公共整合者通过`sourceTools:{names,install}`窄port安装，names同时用于最终Schema和执行guard；不安装工作会话全套工具。`project_memory_source`复用真实文件许可及来源reader。Bot无通信、shell通用执行、指令／看板／业务文件写入或调度能力。

`memory-source-model.ts`与公共`model-visible-content.ts`在模型边界去掉已证明逐字等价的来源正文别名；已知有序可见块可完整还原兼容text时，只保留其中一份完整表示，包含结构化工具、通信及附件事实。来源、说话者、时间、独立执行阶段、错误、partial和限制不删；未知结构或text含额外事实时保持原表示，内部source evidence、冻结digest、UI DTO和持久记录不变。转换在结果分页前完成，长来源仍由原工具完整续读。

同一显式批次内，只有完整context及其来源、版本、范围和证据严格相同时才共享一份`shared_context`，各request保留自己的关联；完整JSON的UTF-16长度更小且UTF-8字节不增加才采用。当前索引与工具list也使用公共模型表示：只有当前候选实际含同版完整keeper时才引用既有正文，缺页、版本变化或keeper退出后恢复完整供给，不建立跨批缓存。

文件来源沿原路径权限、归属及完整大小限制读取，再经`memory-file-source.ts`严格解码UTF-8。空文本、BOM、CRLF、emoji和可靠的未知扩展文本可读；非法UTF-8、明确二进制扩展/格式签名或二进制控制字符返回不可读及限制，不用替换字符冒充原文。图片、PDF与Office文件当前没有文本解析能力；失败来源不能成为成功记忆写入依据。

Memory专用自动压缩由`stock/request/memory-compaction.ts`经公共`bot-compaction.ts`接到真实Facade的memory角色。首次真实请求准备完成后才安装隔离的`ProjectsCompactionEngine`，沿原Basic压力／溢出恢复、摘要事务和surface replacement，不挂工作preset、不扩大工具。预算随真实prepared call的模型容量及实际输出预留更新，保留1/16比例、4096上限和原生近期保留／重试策略；最外层一次原生压缩固定其policy，在途配置更新于该操作结束后应用，不串用新route预算或重置overflow重试次数。摘要额外说明要求保留本批身份、请求ID和完整来源读取入口。新批隔离与批内压缩分别处理，压缩后请求取当前surface，不重新注入已替换的原始批次。纯冷恢复／关闭不为安装压缩解析模型；容量不可得或无合法预算时不虚构容量，原调用／错误仍如实返回。

## 生命周期

工作会话Stop和离开页面不取消已开始Bot。归档／退出／删除准备同步封口并abort，再由同一原生owner并行stop/drain；等待真实终态、flush、批次持久结算后才提交关闭。abort不是停止确认。取消归档、restore、打开页面与冷构造不发起整理；全局close后的owner不能resume。

## 局部证据

`tests/p3-memory-runtime.test.ts`使用预设模型响应边界，实际运行AgentLoop、工具、Memory service/store及JSONL持久化，核连续两批的provider options／request-dispatch、忙时显式接续、失败保留、无变化不改正文／索引、来源变更、真实save、CAS并发编辑及v1转换；projector用受控原事件核同attempt范围与同ID编辑。

执行需显式设置`P3_MEMORY_SCRATCH_ROOT`到新候选私有证据位置，使用固定本地Node、tsx loader和候选TS路径。实际日志保存在候选`.dev/p3-memory/evidence/`，首败保留。局部通过不替代完整Host接线、默认生成消费者、P5同版统一验收、外部提供方连通或模型效果验证。

## 增量与保留边界回归

`memory-incremental-projection.test.ts`覆盖逐prefix／processed游标、queued编辑、权威block-end、忽略raw payload、不变投影复用、跨carrier delivery去重、100checkpoint仅留当前正文、settlement释放assembler，以及100已处理轮只留必要上下文正文。`memory-incremental-owner.test.ts`覆盖低阈值无durable读取、候选变化后重算、失败冻结范围绕过probe、生命周期释放、版本重载／拒未知版本、旧coverage拒内容替换及串行tail只持完成态。

`stock-memory-runtime.test.ts`使用真实stock factory／Memory service／持久层与固定本地响应核live低阈值零read／flush、cold等大小且恢复旧mtime的原文编辑与缺失、真实recording的后置settlement，以及无版本失败旧批按原coverage和实际输入成功重试。这里只证明系统与Harness链路，未验证模型理解或采用效果，也不替代完整Host／UI容量验收。

## State并发提交

State的接纳、准备与结算沿同项目元数据短事务读latest后变换／CAS：追加请求保留另一端已接纳项，冻结在锁外准备但提交前核processed／request／pending基线，结算只消费实际batch及request IDs并保留后来请求。普通旧批表示、阈值、时机与失败批后续活动重试保持；不把锁持有到模型运行结束。post-publish unknown不能升级为批次完成，删除先提交后不能重建.bot-state。真实Runtime factory提供Core同scope授权，低层文件锁本身不授予业务权限。

数据路径重设计的定向补充覆盖：warm重复检查零canonical重读/全内容stat/flush、cold只bootstrap相关来源且changed generation失效、receipt冻结后失败重试不吞新suffix、processed原地推进后同ID编辑与attempt后缀、原canonical-v2 source digest、ACK与fsync之间撤销来源零模型派发。证据保存在候选外层`implementation-evidence/memory/`。当前普通批实际模型输入仍随必要本批正文大小增长；没有截断输入、改阈值、拆批或偷偷切新carrier。
