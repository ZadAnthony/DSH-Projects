# 通信核心

## Stock 插件接入

新格式只写显式 required `projects/communication` 事件。`events.ts` 的 `installCommunicationEventSchemas` 由 Projects persistence 构造时安装，在任何 cold stat/open/read 前校验 prepared、received、outcome 的封闭 payload。完整正文始终保留在所属 carrier 的 journal，operation record 仅保留身份、digest、locator 和阶段。

`CommunicationServiceDependencies.invocations` 接受真实 `ProjectInvocationPort`；stock 的 `projectInvocationPort` 由刚写入的 root/PTC start 与原生 opaque token 绑定，重复 callId 不回扫最后一次记录。`CommunicationTranscript` 核对物理 Session、创建身份和 start seq，保存的 `$agent` 来源也使用精确 native-event。

发送先由 `attachment-copy.ts` 把各来源 holder 的真实 file/image 精确复制到 sender，再保存 prepared 并 flush。`NativeInputPort` 接受 `control.deliverPreparedInput`；先从已保存 sender 复制到 receiver 独立附件 namespace，再经同一输入 owner 的 prepare 回调保存并 flush received 完整 UserMessage，之后才接纳 Inbox、flush 接纳事实、按许可 wake。`recipientPersistence` 表示完整接收副本保存，`admissionPersistence` 表示 Inbox 保存；query 的 consumption 只取实际保存的 user/message，读取不推进这些阶段。副本保存成功不等于已经接纳、wake 或消费。

`request.ts` 继续采用同一 P2 算法，通过 `stock/request/harness.ts` 的实际候选、计量和 `projects/request-dispatch` 重建；已采用表示沿实际 dispatch 保留。附件读取用 record.holder 对应的独立 owner，原来源或 sender 删除不改读其它版本。

`tests/stock-communication.test.ts` 使用真实 stock factory、driver、Tools/PTC、输入 owner、journal 与附件 provider，固定响应核对完整双侧副本、实际 context-entry 请求、保存／接纳／消费顺序、重复 callId、PTC child start、保存失败、冷读不重发及源删除后的接收副本。当前证据只证明受测系统功能与 Harness 装配，模型理解和实际使用效果尚未验证。

本目录实现[R2通信设计](../../../../../docs/technical/DSH-Projects-通信开发设计.md)的通信核心。已接通 Agent 正文发送、精确回复、独立创建、多来源保真、正文分页、P2请求投影，以及取消/保存部分失败后的原操作查询。界面消费双方保存副本；本目录的程序测试不单独代表完整UI或同版成品验收，业务模型理解与实际采用效果留待后续调优。

- `service.ts` 是新操作的唯一执行 owner。同步登记同调用责任；已有操作先查原结果，不再次定位目标、读取来源或发送。新操作经真实许可后注册，固定快照及原生消息，再保存发件记录；`attempted` 持久提交后才进入一次原生发送。
- `records.ts` 只定义无正文 operation 及版本化 codec/repository。实际读写通过 `ProjectStore` 的既有串行队列和原子文件替换，使用 record v13 内独立 `communicationOperations` 集合。正文、完整参数不进入该集合；旧 Delivery 只读。
- `transcript.ts` 保存真实工具 occurrence 对应的 `prepared`/`outcome`，核对 holder 创建身份和 root/PTC start，读双方独立聊天副本。`readSnapshot(projectId, record, signal?)` 是来源与界面共用的完整快照入口；`readPreparedForInvocation` 按真实调用定位发件副本。
- `native-input.ts` 用同一个冻结 `UserMessage` 调用原生 Inbox。插入、接收保存、wakeup 请求分别表达；send 抛错不能一律归为未插入。它不建队列、重试机制或永久幂等索引。
- `query.ts` 只读合并 operation、原生日志和 sender outcome。live 内存存在只证明插入；持久读取可以补充已保存事实，查询不写回状态或补发。已确认保存事实不会因源/目标后来删除而降级。
- `contract.ts` 统一快照、part、来源、规范参数摘要与不可变 JSON 边界。参数摘要保留正文原字节；Agent 正文、用户原话和上下文分别保存。实际来源读取准入仍由来源 owner 负责。
- 来源不完整时，`failure.sourceFailures` 按原用户原话、上下文的分组和索引保留每条精确 locator 及已知缺项码，并随工具回执、发件 outcome 和冷查询返回。operation codec 仅接受这些封闭字段，不保存正文、完整参数或任意错误 details；同调用再次进入只读取已保存失败。
- 引用来源的真实 holder 责任持续到新发件副本完成 append、flush 和 sender record 更新后才释放；保存 part 使用其实际 record holder，不追锁已删除的 origin。删除先取得封口时，收齐其它已准入来源的逐项缺失后零投递退出；内部准备错误保留原失败，有限结算并释放只读责任，不阻塞来源正常删除。

runtime 当前公开只读实例 `communicationTranscript` 和 `communicationQuery`。查询接受 `{operationRef}` 或 `{deliveryId}` 之一；短回执不含快照正文。`CommunicationServiceDependencies.resolveSources` 由保真 reader 供给两组有序 part；`content.ts` 负责全文、多模态块和稳定目录/正文读取表示。

`packages/projects/tests/communication-core.test.ts` 使用真实 AgentLoop、工具执行、Inbox、JSONL 和生命周期 owner，模型为确定性替身。它覆盖一次发送/精确回复、sender flush 未确认、结果 metadata 写失败、真实取消与同调用 join/重入、创建不运行及旧字段拒绝。程序证据仅证明这些边界；真实模型采用、UI、完整故障矩阵和同版专项验收另取证。`records.test.ts` 保留旧封套、legacy 只读和生命周期原子写入回归。

## 35.3 保存的 Agent 正文来源

`saved-parts.ts` 统一已保存内容的目录、完整可见 blocks 身份和精确 `CommunicationSavedPartSource`。`$agent` 表示同次 snapshot 的完整 Agent 自写正文，可用作 `context_refs`；目录直接给系统 source，历史的 `communicationParts` 从同一目录派生。它仍是 assistant/真实发送会话的内容，不能成为 `user_message_refs` 的人类原话。

保存副本的 `origin` 指实际 native 载体：recipient 取同 ID 最早真实 Inbox/user 保存事件，sender-prepared 取已核的 root/PTC start；原作者另由 snapshot.sender 和 part.producer 保留。版本使用真实 holder 创建身份、准确保存 prefix cut 和完整 blocks digest，不依赖原 sender 继续存活。当前 holder 删除、载体不一致或引用失效仍按 P3 全条失败；导航复用既有同 ID claim/F3 复核，不重写冻结 origin。

`content_digest` 是目录中 canonical 可见 blocks 的身份，和 forward part.version.contentDigest 一致。`read_content` 保留 `$agent` 既有 canonical-json 字符串页流、range 与游标所绑定的实际序列化值；不把 blocks 身份混称为页流身份。该修复不改变 snapshot/source 格式、D25、容量阈值、持久服务或用户保存指令。

`communication-agent-part.test.ts` 通过真实 registered 读取和发送验证系统 `$agent` source、原用户答复加原问题、pending/claimed、本地来源导航、root/真实 nested PTC、冷读/发送、删原作者后的保留、重复 savedpart 链，以及错误引用与非人类 user refs 的零投递。模型是固定本地替身，不能代替新冻结成品的真实模型/UI验收；35.2的首错证据保留。

## 主会话承载接力

`CommunicationServiceDependencies.withTarget` 在解析稳定接收会话的当前承载之前取得共享准入，并持续到来源读取、发件快照保存、唯一原生投递、收件flush与operation／outcome结算。原生插入前再次核同一固定准入；不能把准备期间的投递改投后来current。重复operation直接读取原记录，保留原host／message与unknown，不重新解析或投递。

`replyHolders` 只提供同一稳定工作会话真实保留carriers的精确创建身份。回复资格使用现有Transcript核其中真实原收件；主会话当前承载可回复旧段来信，执行会话也可回复旧主段发送的来信。新回复再按原发送会话的稳定ID解析current，原sender、receivedAt及原快照不改；saved-part的origin／sourceChain或自有子会话不授予原收件资格。不可读或创建身份不匹配不能当作已收到。

`communication-continuity.test.ts` 是源码模块验证：受控准入与存储端口配合实际Transcript收件核对和NativeInputPort，覆盖双方向历史回复、来源与创建身份拒绝、准备／收件保存期间的准入、重复／unknown及最后插入前拒绝。这不代表共享Runtime发布、正常安装、界面或完整专项已通过；它们由同版整合及验收取证。
