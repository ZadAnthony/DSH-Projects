# 本地完整生命周期

ProjectStore 的归档位是唯一持久归档事实。archive-v1 只由原操作在原生正向成员的真实停止、旧输入退出及保存/关闭确认后，与归档位同一次 CAS 保存；active 后保留有限创建身份，供冷只读及原 native schedule 解释，不表示当前仍已停止。

单 execution 与整项目复用一个 project FIFO。原 native catalog/header/creation/descriptor strict 读取决定成员，普通 API fork 及其树不扩选。全组先发布可解除 cut，再向 roots 发停止、向需关闭的 child 真 handle 发关闭，最后共同等待 callback、创建/rollback、PTC、target 保存、flush/close。整项目的 Memory B 先 suspend/abort，与 Agent 停止并行结算。

归档不先读取Projects定时配置；该文件失败只由定时入口如实报告，不阻止原工作被取消和归档。当前cut、真实owner排空、归档保存及定时发送前的准入检查保持，恢复仍不唤醒旧工作或补投旧槽。

warm 在 cut 捕获当时 Inbox IDs；cold/创建中从第一次同步 Session 发布交接实际初始 Inbox，同 creation 后续 epoch 不重抓。可信 close-only 工厂仅清本次旧 ID，不提交任务或启动观察器；晚消息保留。Query/History/Client 的冷历史不创建 Agent。恢复只在真实最后释放点产生未来计划边界，不发消息、不唤醒、不再清晚消息。

旧正常格式缺少切点时先严格读取；能够证明无未分类输入的状态可由原 owner 真实关闭并保存有限身份后恢复。确实存在未分类输入时，内容、消息与归档状态保持，恢复明确未完成。纯查看不迁移或补确认。未知仅约束对应来源；native 合法旧 child 行若没有完整前置投影，仍由原 resolve 能力决定，真实拒绝不写为已投递或已执行。

整 Host 关闭沿原 owner 的不可逆 native retirement 与 Agent/B/已接纳保存并行结算；SourceDisposition 到这些真实结果之后才释放。不将此写成独立卸载或 HMR 承诺。永久删除、真实电源及模型效果不属于本片。


整项目永久删除由 `ProjectSourceDeletion` 在同一项目 FIFO 中接管全部真实 carrier、Memory、session-manager 和未提交 preparation root，再清理各自原生 owned 子树、附件、query/cache、原日志、定时及项目目录。准备物以内部 `DeletionRoot` 表达，不创建业务会话，也不重复删除 committed preparation 已成为的 carrier。独立 Library 引用和外部工作区原件保留。

先对全部 roots 发出真实停止与 API／上传退出，等待在途创建和已接纳保存完成，再核对物理 header 和有限附件范围；停止／来源不明则保留归属和原数据。即使 preparation 已 native close，也必须重新取得物理删除 owner 的完成事实。首次接管后中断持久化 partial 和实际进度，后续显式继续复用原分组；不循环清理、不重开工作 Agent，也不以 close 成功代替删除完成。

target／instruction drain创建时即由既有结算promise观察，不在晚阶段重新订阅或重复等待。取消真实工作仍立即进行；整项目的原main writer在continuity已接纳结算落盘后才retire。准备物按Store精确reservation及实际持久project／logical owner核对，已有创建header也须一致；不要求早期未完成创建的root已经写出history-import，也不凭同字符串ID删除无关journal。

归档名称保存使用control原有串行队列与Session writer事务，不通过工作Agent准入。live与cold沿同一写事务保存原生标题并交回writer；不新建Agent、认领或唤醒排队输入，身份校验、Store CAS、原生标题规范化和真实错误保持。

本轮 source fixture 覆盖真实 Store、Session 创建／flush、JSONL、SessionQuery、附件、cache、native retirement、终态冷读、真实文件权限和 ENOTDIR 失败。模型请求使用本地可控适配器；传输外壳沿既有测试夹具，正常安装及最终默认产物的组合验收另由统一交付执行。
