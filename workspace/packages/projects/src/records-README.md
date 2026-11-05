# Projects 稳定会话与承载关系

`ProjectSession.id` 是稳定逻辑会话 ID。v14 起的 `sessions[].carriers[]` 是承载关系、逐段来源状态和原 native child 归属的唯一持久真相；不再保存 session 层的 `hostSessionId/sourceLifecycle/ownedLifecycle`。

Store 返回的 `ProjectSession` 为旧调用者保留这三个字段，全部派生自唯一 `isCurrent` 段。公开类型的 `carriers` 可选仅用于兼容旧 DTO 构造者；所有 Store 读取结果都会填充。它不是业务模块直接修改关系的入口。`ProjectCarrierMembership.projectSessionId` 恒等于 `session.id`；其中 `session.hostSessionId` 是当前指定入口，`carrier.hostSessionId` 是本条真实承载段，二者不能混用。

- 新建用 `bindSession`；预分配时可缺 header，真实创建后调用 `confirmSessionCarrierHeader` 保存 owner 返回的 root header。`bindSessionCarrier` 在同一串行更新中检查全库 host/owned-child 唯一性、保留原段并追加新 current。原生 child 的 parent/mode/provider 仍在 owned 关系中，不能绑定成接力段。
- `findOperationalMembershipByHostSessionId` 和派发目标只认当前、来源可用、未确认结束的段。归档等暂时运行资格仍由原生命周期 owner 裁决。旧 host 的晚到结果、来源、历史、Bot、用量与既有定时 occurrence/pending 使用 retained/真实 carrier 归属，不能再经当前入口判断。
- `listProjectCarriers` 返回该项目全部真实段；`listSessionCarriers` 返回单逻辑会话段；`findCarrierByHostSessionId` 反查原段。`listRetainedSessionSources` 按段展开，保留逻辑 id，并提供 `projectSessionId/carrierSequence/isCurrentCarrier/header?`。所有读取都不创建 Agent、不重放工具或改定时事实。
- `resolveCurrentCarrier` 只解析当前入口，来源不可用或明确 closed 时无结果。`closeSessionCarrier` 只记录 owner 已确认的承载结束/退役，不能用于普通 Stop 或临时归档。换段不自动 close 旧段，也不表示旧调用已经结束。
- 单段删除兼容原输入；多段 begin/record/complete 必须传 `carrierHostSessionId`（或 `hostSessionId` 输入别名，两者不一致会拒绝）。每次只推进指定原段，逻辑 revision 共用 CAS。旧段失败不会覆盖其它段事实；只有全部段 deleted 才清逻辑展示信息，整项目 terminal 也必须等全部段及其它 owner 完成。
- `commitExecutionArchive` 多段使用完整 `carrierLifecycles` 一次提交；项目归档证明按 `sessionId + carrierHostSessionId` 定位。roster 可以是逻辑会话加完整 `carrierHostSessionIds`，或同逻辑 id 按真实 host 平铺的完整列表。整项目删除同样接受完整逻辑关系及逐段方案，或完整平铺方案；不完整范围会拒绝。

旧 v1–13 在读取时仅于内存表示为第一段，保留 id/host/归档/sourceLifecycle/owned 事实。没有真实 host header 或绑定时点时保持未知，不使用项目创建时间补造。`upgradeCarrierRelations(projectId)` 是显式离线副本升级入口；当前新建使用 v15；旧记录追加关系至少使用 v14，加入接力准备关系使用 v15。升级保留未知非关系字段、旧 Delivery 和通信事实，不改原生日志、聊天或记忆正文。旧 terminal 若缺逐段删除时间，读取和显式升级均标 `lifecycleTimeBasis: "project-deletion"`：其继承时间仅为整项目删除边界，逐段实际时间仍未知；不会新增发生时间。新 v14 的逐段准确事实不填此历史标记。旧格式元信息兼容更新仍保留其原封套；升级后不得降回旧版本。v14 必须由新版 reader 读取，旧 reader 会明确拒绝其版本。

本模块测试只覆盖 Store 合同与隔离文件读写。实际宿主、请求、历史读取、Bot、定时、用量、归档及删除的组合接入由对应 owner 进一步验证；这里的局部通过不代表完整专项或模型效果通过。

## v15 接力准备和真实删除

`mainPreparations` 由同一个 ProjectStore 保存 attempt、原 carrier 的真实 header、预留新 host、真实创建后才取得的 `toHeader` 以及 `unpublished / committed / abandoned`。预留、确认、放弃、发布均共用父逻辑会话 revision；调用者只消费自己成功写入返回的 revision。发布还在真实临时文件写入后、原子 rename 前再次检查活动许可。项目或当前来源进入删除／部分状态时，新的预留和发布均拒绝。

准备物是独立内部归属，不是 carrier、普通工作会话或 owned child。`resolveHostOwnership` 始终保留未提交准备物，包括已确认 native close 的对象；`retirement: confirmed` 不表示日志、附件、query、cache 和 usage 来源已经移除。全库 host 唯一性同时检查准备物及其真实冻结子树，不能把已关过的准备物重绑到其它项目。提交的 preparation 必须精确对应同一 main 的真实 carrier，不会重复形成物理删除目标。

整项目删除的 `beginProjectSourceDeletion` 单次接收完整 carrier roster 和独立 `preparations` roster；真实 owner 核对 header、子树及附件范围后才原子接管。各 preparation 的 `sourceLifecycle` 与原 carrier 一样保存实际清理进度，使用 `recordMainPreparationSourceDeletion`／`completeMainPreparationSourceDeletion` 单调推进。缺 `toHeader` 时，仅当真实 JSONL 中存在同 attempt 的 `context/history-import` owner 标记，才可取回创建身份并与 begin 同次保存；仅 host ID 相同不足以证明创建归属。未知或不一致不编造 header，不开始新清理。首次 begin 以前未核实的结果沿既有入口返回 stopped-before-cleanup；begin 以后失败保存 partial／unknown，只由用户显式继续。

v15 terminal 完整保留必要的 preparation 身份、真实 deleted 状态及 session-manager，全部 carrier、未提交准备物及项目文件 owner 完成后才生成。不会降回 v14 丢掉准备关系。旧 v14 terminal 继续可读；v14 中出现 v15 专属字段或 role 会明确拒绝。冷读取不创建 Agent、不启动模型或自动续清。

## 跨进程元数据提交

ProjectStore的全部mutation在`recordsRoot/.metadata.lock`的真实OS事务中读取、校验并提交；全库host唯一性检查与写入不再仅靠单实例Promise串行。普通read不取该锁。`withMetadataWrite`用本owner parser取得同事务fresh snapshot，再由可信Core调用方核身份／当前归属及生命周期，领域Within不能重入取锁。源发布失败保留磁盘已发生事实，目录sync未确认不能回报updated。`cancelPendingWrites`结束未进入action的锁等待，已进入动作仍真实结算。

普通读取仍每次fresh stat `record.json`，并按原全库目录遍历核host/owned身份唯一性；没有改用Runtime成员投影代替当前磁盘权限事实。同一文件的dev/ino、mode、size及纳秒mtime/ctime/birthtime均不变时，可复用该Store已完整解析、校验并冻结的record；公开DTO仍按原合同复制，后续写入创建新封套。新inode或stamp变化会重新读取校验，因此另一个Store或进程提交的归档、换段、来源删除会在下一读生效。缺失、权限错误或损坏不复用旧结果，不保存负结果或TTL。

首次读取只在实际fd读前/读后与最终path身份stamp一致时保留解析结果；合法原子rename或移除若发生在读中，仍返回这次真实打开文件取得并通过原parser的快照，但不把它挂到新path的stamp，下一读重新检查。变化不会触发缓存专用拒绝门或自动重试。此复用省去相同record的重复JSON/通信codec解析及冻结；每次stat、目录读取、全库唯一性检查和调用方原fresh资格检查仍执行，不能称为无I/O授权。

项目编辑通过完整UI／Remote链携读取时revision，冲突保留输入，缺版本的旧编辑payload不能冒充新版本提交。完整职责与其它owner接缝见[元数据技术合同](../../../../docs/technical/DSH-Projects-原版DSH兼容技术方案.md#project-metadata-transactions)；实际候选范围由项目验收状态持有。
