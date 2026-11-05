# 聊天记录与共享记忆公共接线

本模块将记录、稳定来源与记忆 owner 接到实际 Projects Agent。系统功能与 Harness 的局部源图验证见 `tests/memory-chat-integration.test.ts`；这里不宣称正常安装物料或模型理解效果已经通过。

- `Host.Config.originalRecording` 显式解析 `streamCheckpointBytes=4096`、`streamCheckpointIntervalMs=1000`，经 Runtime 的真实绑定在该 Session 上启用一次原生记录，随原 Agent scope 释放。这是保存策略，不是模型触发阈值。未绑定普通 DSH 会话不启用；真正 owned child 由原生 `parentAgent` 创建接缝继承同策略，父子身份不改成接力段。
- `ProjectStore.carriers` 是承载关系 owner。派发和新配置目标仍解析 current；Core 工具、原文、晚到事实与工作区能力核对实际旧 host。目录 source disposition、归档、删除与用量读取全部自有段；归档提交完整 roster 和每段真实停止证明，删除进度按 `(logicalSessionId, hostSessionId)` 保存，全部段完成才表示逻辑删除完成。界面继续原来的来源和删除结果入口。
- `installProjectHistoryTools` 是工作与 Memory Bot 共用的只读注册入口。search/read/read_content 共用来源 Schema、reader、Unicode 页预算和真实 retention finalizer。Bot 只取得这个读取工具与其限定记忆工具；不安装工作通信、会话创建、定时、shell 或业务写工具。
- Core → Memory 端口保留完整稳定 source、原 producer、目标及邻近原文、版本/范围与 partial。保存通信 part 仍从其原 holder/snapshot 读取；真实原用户身份不由副本角色猜测。用户设置改其它字段后来源仍由 Memory 唯一 owner 序列化保存。
- 请求 preparation 在每次独立请求取得当前索引及必要失效信息。历史原文/正文页的供给证据分别保留 source、事件摘要与 body range；它们不恢复撤回主题的当前效力。
- 失效说明已取得的former revision/scope作为同一组观察保留。真实新owner变化仍更新该组；历史读取只补实际已读及来源事实，不在文件未变时把说明退回更早版本／范围。状态仍由实际派发供给恢复，没有新增持久字段或读取台账。
- 当前索引准备每次核对目录、撤回、磁盘索引及所有主题的当前文件；owner可复用同一文件身份／版本已验证的无正文元数据，每次仍实际打开文件核可读性并核对前后fd／path。冷读、变化及显式选中主题完整实读，所选正文不缓存。元数据最多128项／合计1MiB，单项超过64KiB走普通读取；既有弱ContextSlot持有store，GC或淘汰后正常冷读。默认完整读取及写入合同不变。长结果首次二次核对和每页当前owner调用不变；Schema保留完整分页协议，每页只重复必要的解码、原参续读、同页重试、重开与partial说明，页容量、版本、来源及撤回规则保持。
- 定时读取跨段原生事实，未来到点解析 current，已准备或已入队的 occurrence 保留原 host。管理配置组合各段原 pending owner，以便修改/取消仍到达 S1；不会把旧次复制到 S2。
- Usage 逐真实 host 读取原生 disclosure，再按同一逻辑会话提供筛选；每段来源和缺报保留，未知不折算为零。

局部组合使用真实 Agent/Session、Tools、request dispatch 和 JSONL owner，只固定外部模型响应。记录策略/旧源、多 carrier 生命周期、partial 删除续接、工作与 Bot 三动作以及定时 before/prepared/pending 切换均有受控程序检查；统一生成、正常安装和最终同版验收由 P5 负责。

设置中的“查看来源”通过 Host `memorySource` 接收结构化 `ProjectMemorySourceView`，保留有限原文、partial、限制与每个真实 bodySource。既有设置页用 `memorySourceContent` 调同一 reader 继续正文页；分页带原稳定来源/版本和真实 Unicode 范围，临时cursor失效可从稳定来源重新打开。删源后再次读取失败会清除先前正文页，不拿已显示的副本冒充重新取得原文。正式 UI 优先结构化路径；旧 string 回调仅兼容旧调用者，不参与正式来源展示。Typert协议由统一构建正常生成。
