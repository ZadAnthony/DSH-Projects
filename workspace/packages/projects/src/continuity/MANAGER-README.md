# 会话管理Bot

`MainSessionManager`只拥有专用Harness、真实只读工具装配和单次判断结算。ProjectsRuntime负责每项目唯一隐藏Agent、明确经济档route、正常轮触发、超时和切换；Store、主历史、看板、记忆、原生Session与用量继续由原owner保存。

构造参数依次为`ctx`、`ProjectsCoreAccess`、`(projectId, mainSessionId) => MainManagerHistoryReader`、`MainManagerContextPorts`、`(window, capacity, signal) => MainContinuityHistory.fit(window, capacity, signal)`（保留构造兼容，manager不再调用此完整历史fitter）及`ProjectsRuntimePorts`。在真实`session-manager` Agent的setup中先调用`install(agent, membership)`并直接退出角色分支，不再安装工作或Memory Bot职责；dispose移除全部效果并取消当前评估。`evaluate({envelope, window: MainManagerInput, agent, signal})`返回严格`SessionManagerDecision`或带`code`的`SessionManagerEvaluationError`，不创建、切换、重试或发业务消息。

每次评估通过`stock/request/harness.ts`安装本评估唯一prepare回调，明确`role=manager`，使用原生输入的`startSeq`，只从实际`session/event`增量收集本次消息seq、消费输入数量、绑定turn起止、当前待执行调用及最后一条assistant内容。工具guard使用该次实际输入之后、同一turn的待执行调用事实；结算须取得真实插件`ProjectTurnSettled`，精确匹配本Agent、turn、起止seq、唯一消费输入的messageId/eventSeq及本次evaluation来源，并保持completed。真实`whenIdle`和管理器末次flush责任仍保留；本轮`agent/error`或缺少settled不能由后续flush成功改判，失败标记只在本次评估内保持。最终JSON校验不回扫Session历史或保留完整事件数组。取消后不再接纳该评估的新事实，结算释放后下一评估从空状态开始。后续请求只保留本次输入与同次补读。

完整中文4.8.3说明、四种交流情形及同工作checkpoint／压缩示例作为完整system安装，工作system与runtime context不进入Bot。`MAIN_SESSION_MANAGER_TOOLS`同一集合限定最终schema和执行守卫；仅`project_history`三种读动作及看板、记忆索引、指定正文读取。工具执行再次调用Core验证真实live Agent、initiator和open turn，再叠加本次evaluation身份、真实invocations port及主历史reader范围。无业务、通信、配置、记忆写入、Goal、创建、恢复或切换能力。

`MainContinuityHistory.managerInput`在真实持久cut内独立扫描轮边界，不调用完整`select`、`observeTurns`或`projectVisibleNativeEvents`。本轮只取实际消费的业务`user/message`（含steering，保留真实producer），最近三轮按真实completed且实际消费业务输入的turn选择；每轮只取最后一条未interrupted的`assistant/message`，投影其text/file/image。该消息没有对外正文则如实缺项，不拿更早进度补最终答复。历史literal、Bot、技术刷新、失败／未完整轮不计作正常业务轮。读完后再核来源归属、生命周期和revision；无法取得当前轮真实输入则本次失败。只有合法switch且现场仍有效、安全点确认后，Runtime才为新主Session调用原`history.select`，其三轮完整历史及发布事务不变。

`manager-input.ts`按已有native-event和visible-blocks正文协议生成精确code points片段、body digest、selected_range和只读入口。文本与文件／图片描述保持原顺序；同消息tool-call仅参与真实正文定位，不默认交付；reasoning不属于visible body。event/body采用与canonicalSourceJson一致的分块编码散列，避免为大单条记录生成巨型临时JSON，并分批让出事件循环、核取消；不投影累计保存版本。默认正文累计16,384 code points、每消息4,096、每消息最多16段；当前消费输入超过32条则失败，目录最多展示最近12个carrier并披露总数和目录是否完整，仍可按稳定main ID查询全部合法历史。信封连同元数据在整体序列化和入队前限制65,536 code points；这些是有限传输预算，不是模型8k／1k样本限额或通过线。

每次`projectCandidate`使用真实route的contextWindow、输出预留及完整请求meter，检查专用system、Schema、本次输入、已有补读和元数据。先尝试有界默认正文，不fit则缩小已准备片段并同步精确range与sources；最小合法表示仍不fit即失败。候选测量不登记来源。只有真实`projects/request-dispatch`内本次消息实际派发的片段进入evidence集合；准备入队的原范围、read入口、usage来源引用和未读正文不因此获准。

背景看板、记忆索引及记忆正文的原始owner结果，在本模块JSON克隆及通用pager的完整canonical编码、points数组、二次owner读和快照缓存之前，先以同一分块扫描限制65,536 code points准备体量；过大的背景值返回真实工具失败，不暗中生成无界快照、不累计未交付正文。通过准备预算的结果仍按既有分页和cursor续读，分页缓存仅保存已通过有限准备检查的对象。

同评估补读单次结果最多24,576 code points、累计65,536，最终累计候选再受有限传输和真实Token容量约束。超额作为真实工具失败回到同一循环；既有总体期限和原物理结算责任不改。重复正文以真实保留结果的精确source、range、text识别：相同search摘录不冒充完整read，相同正文页不再展开，仍保留原source与cursor供后续页。正文返回的`delivered_source`只覆盖本页实际范围，用作evidence；原`source`与cursor仍负责原选择集续读。

历史读取复用主范围reader和已有正文retention finalizer，合法、partial、拒绝及失败结果沿原生工具循环回流。只有实际派发输入以及最终保留的历史摘录／正文结果携带的source进入本次来源集合；看板和记忆中的引用链接不冒充已读原文。最终assistant可见文本仅允许一个JSON对象，实际turn须completed且flush确认后才解析，额外身份、未知字段、错型、非法动作、未提供来源及缺少switch必要字段均拒绝。

外层signal由Runtime配置总体期限。取消立即向协调者返回，原生Bot独立停止并结算其日志和全部实际usage；真正停稳前slot仍占用，不会把晚到结果混入下一评估，也不阻塞主业务或Goal的释放。用量按原生请求和隐藏成员归属聚合，本模块不另记账。

`tests/stock-continuity.test.ts`和`tests/stock-continuity-manager-reminder.test.ts`通过当前stock真实factory/driver、tools、Core、Store、持久journal与reader验证默认装配、冷恢复、cut、最终答复缺项、Unicode正文范围往返、真实candidate裁剪、证据拒绝、重复页及累计补读失败回流，以及三种过大背景值在JSON克隆／pager快照前拒绝、单次owner读取和有界背景分页续读；外部模型响应受控，不考模型判断。三carrier原历史选择及switch的独立接力回归仍沿`stock-continuity-relay.test.ts`。旧`continuity-manager.test.ts`依赖旧宿主测试helper，不能用其通过状态代表当前stock验证；本轮适用结果与环境差异记在交接证据。正常安装／桌面同版验证和模型实际效果不在本轮受测范围。
