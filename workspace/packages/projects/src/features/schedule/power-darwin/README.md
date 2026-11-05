# Darwin 电源事实候选

这是进程内 Node-API 8 原始事实读取与被动提示来源。没有 timer、任务队列、重试、launchd、assertion、睡眠回应或系统电源策略写入。D17 的同次准备延续由 Schedule Runtime 拥有，本模块不更改合法入队含义，也不沿用旧 WillSleep cut → ack。

本机实际验证环境为 Node 24.21.0 / N-API 10 / arm64 / macOS 15.7.4，SDK 26.2；使用 N-API 8 编译，当前产物最低 macOS 15.0。N-API 稳定接口并不等于已验证其它 Node、架构、系统版本或正式插件装包。

## 构建与使用

```sh
node packages/projects/src/features/schedule/power-darwin/build.mjs
# 测试构建额外导出真实失败读取探针；正式 adapter 拒绝加载此构建。
node packages/projects/src/features/schedule/power-darwin/build.mjs --test
node --test packages/projects/tests/features/schedule/power-darwin/native.test.mjs
```

入口从实际 Node 路径定位配套 headers；非该布局可显式给 `--node-include <headers>`。需要本机 Xcode Command Line Tools，使用系统 clang++，只链接系统 AppKit/Foundation/CoreFoundation。无 node-gyp 下载或第三方 native 库。`--out <path>` 可把产物写到交付目录；不能硬链接旧临时产物。根 `scripts/build-projects.mjs` 已在正常 macOS Host 构建中生成 `lib/power-darwin/power-darwin.node`，package 预检和 files 纳入该正式产物；Host 以安装包内绝对路径加载，首次业务读取仍等待真实 appReady。

```ts
const facts = createDarwinSchedulePowerFacts({
  bindingPath: '/absolute/package/path/power-darwin.node',
  subscribe: true,
  onHint(hint) { /* 只通知同一 Schedule Runtime 重新读取；不使用 receipt 当 recoveredAt。 */ },
})
const raw = facts.readRawSync()
// 真实 appReady 后才由 Schedule Runtime.connectHost 首次调用 readSync；
// Runtime 将自己的读取结束时刻与返回的当前段 baselineAt 绑定。
const fact = facts.readSync()
// Host 关闭：先关闭本模块的消费者，再释放本模块。
facts.dispose()
```

`subscribe` 默认 false。真实 `NSWorkspace.notificationCenter` 的 WillSleep/DidWake observer 放在本模块自己的 CFRunLoop 线程；回调经 TSFN 到 Node。只注册自己能移除的被动 observer，不调用 `IORegisterForSystemPower`、`IOAllowPowerChange` 或任何 assertion。关闭先停止生产、移除两个 observer、释放自己的 runloop source/线程，再释放 TSFN。已经排到 Node 的 packet 只回收；`dispose` 可重复。NSWorkspace 的 framework singleton 由系统框架持有，其内部进程资源随进程退出，并不由本模块私自销毁。

## 可消费事实与未证明部分

`readRawSync` 在同一 native 调用中顺序读取五个精确 OID：`kern.sleeptime`、`kern.waketime`、`kern.sleep_abs_time`、`kern.wake_abs_time`、`kern.boottime`。每个包含查询/实际读取的返回码、errno、长度、有效原始字节与本机解码；无效缓冲不填零值事实。前后保留 mach absolute/continuous tick 与 gettimeofday 原值、返回码、timebase 和实际布局。大整数均用十进制字符串；timeval 的 epoch 秒和微秒分别保留，不经 JS Number 丢精度。

整次采样前后另各读一次 `kern.sleep_abs_time`，与中间原值不相等就保留 raw 并返回 unknown。这些是顺序样本，不是原子快照；marker 相等也不代表函数返回后不会睡眠。`observedAt` 来自最后 gettimeofday，ISO 表示向下截到毫秒，原始微秒仍在 sample；通知 `receipt` 只指 native 收件时刻。不会用当前 wall 减 absolute 年龄来估算历史恢复 UTC，也不加残差容差。完整零 marker 组合是可读 fresh-boot 状态，可在合法首读建立该来源下的基线；混合零、过渡或矛盾数据不能供业务 known。

`readSync` 返回来源为 `darwin-kernel` 的事实：`known {observedAt,available:true,epoch,baselineEpoch,baselineAt,recoveryWindow?}`，或带原因的 unknown。构造器及初始 raw 诊断不建业务基线；**第一次业务 readSync 必须由真实 appReady 后的自动 Runtime.connectHost 调用**。该次合法 raw 的时刻成为当前段固定 `baselineAt`，本进程 `epoch` 从0起，严格保持非负safe integer。Runtime另以读取结束时刻及baselineAt处理启动边界；不反推 ready 前的旧 wake。

成组sleep/wake absolute epoch不变时给出该来源下的连续性；epoch变化时递增本进程epoch，并由最后旧epoch的真实wall样本至首个新epoch的真实wall样本形成 `recoveryWindow {lowerBound,upperBound}`。lower向下、upper向上取整到UTC毫秒；故upper可比当前observedAt的毫秒表示大1ms，这是明确的微秒量化封闭，不是实际wake在未来或经验容差。epoch不变时保留原窗口，读取失败或混变也不擦掉已有baseline/window。初始完整零状态不要求系统必须先睡过一次。

**来源假设**：采用已发布Apple XNU `43a90889846e00bfb5cf1d255cdc0a701a1e05a4` 的sleepKernel路径——每次进入该睡眠路径写sleep_abs，返回后写wake_abs。当前实际kernel为 `xnu-11417.140.69.708.3`，与该发布源码不是同一完整binary身份。因此known是此明确kernel来源合同下的运行事实，不能表述为所有睡眠模式已实测。通知安静及顺序mach偏移区间重叠本身不证明没有睡眠；若同epoch偏移区间反而不相交，则属于来源域矛盾并返回unknown。公开写入点见[Apple XNU sleep/wake源码](https://github.com/apple-oss-distributions/xnu/blob/43a90889846e00bfb5cf1d255cdc0a701a1e05a4/iokit/Kernel/IOPMrootDomain.cpp#L2891)。

calendar映射标记/timebase变化、absolute/continuous/wall倒序、同epoch的wake calendar或时钟域矛盾使旧排序失效并返回unknown。`kern.boottime`可随校时变化，不是稳定boot身份。两个独立完整native样本在当前ratio/calendar标记、kernel marker、tick/wall顺序及偏移区间上相容后，业务read可启用新的当前baseline；epoch递增，baselineEpoch取当前epoch，不复活旧段/旧准备/旧次数。同一raw双observe只算一个点，诊断本身不授予新基线。旧wake calendar处于新wall未来不证明当前raw损坏，但不能用于还原旧恢复UTC。普通读取错误和跨epoch混样只保留原状态等待新的真实样本。`continuity`返回的marker诊断不会代替事实owner。baseline建立后的额外raw诊断也进入同一事实解释，以免丢失诊断中实际看见的时钟域变化。

本模块只解释raw→epoch/baseline/window，不读取plannedAt、不分类或移动occurrence。`<=lower`、`>upper`、窗口内未知以及D17同promise延续均由唯一SCHED owner处理；上界不能冒充精确恢复UTC。合法队列和manual不由本模块改变。

字段失败、尺寸错误、解码不符、时钟倒序或未来边界均返回 `unknown` 并保留 raw 供诊断。加载错误、测试构建、关闭后的读取不会变成 known。原始 native 模块的 `subscribe('controlled', ...)` 仅用于真实线程交接；其 packet 明确为 `controlled-native-thread`，正式 TS adapter 只接 `nsworkspace`，不会把受控通知写成 OS 恢复事实。

实际窄测试包含真实读取与正常awake known、真实 ENOENT/短 buffer ENOMEM、受控 native → Node、晚 packet 关闭、回调异常、真实被动订阅/移除和正常进程退出。受控tracker序列另核baseline固定、epoch/window、混样保留和clock跳变；这些窗口是明确受控输入，不是实际系统恢复记录。没有产生或观察实际 sleep/wake，不能据注册或正常awake成功声明系统通知模式、恢复区间覆盖、D17或整个自动定时已经通过。正式Host组合和真实sleep模式仍需后续证据。
