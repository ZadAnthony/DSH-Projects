# Library 文件区（D15-L1）

沿现行产品的文件区要求及[采用的领域设计](../../../../../../docs/technical/DSH-Projects-首版技术方案.md)维护。模块拥有实际项目文件浏览、显式外部引用与当前原件预览，不保存 Result、核对、Recognition、Work 或文件提交对象。反馈/返工在真实聊天里继续。

当前模块已接入 Projects Runtime、stock Host/Remote、文件区界面及来源导航。`runtime.ts`构造同一`LibraryService`并安装四项工作工具，`stock/host.ts`提供公共操作，stock完整Client复用现有产品组件。本文维护领域合同；局部测试不单独代表完整安装验收或模型采用效果。

## 四动作与 DTO

`library-contract.ts` 导出：

- `LibraryFileLocation = {kind:'project-file', relativePath:string} | {kind:'reference', entryId:string, relativePath?:string}`。引用省略relativePath时仍指原入口；UI目录阅读的子项位置是该引用根内的相对路径，不是新持久引用。
- `LibraryListRequest`：项目/会话 ID，`directory?` 为项目文件根内相对目录，默认根；`LibraryListing` 包含 `projectFiles` 和 `references`，分别表达成功/真实失败。
- `LibraryAddRequest`：名称、实际 target、可选说明及原生来源；没有 purpose/workId/resultId。
- `LibraryOpenRequest`：项目/会话 ID 与 `location`。项目文件不要求先有 entryId。
- `LibraryEntryRequest`：仅用于按 entryId 解除显式引用。
- `LibraryEntry`：必要位置/归属/首次添加者/真实 native 来源/时间；旧间接来源只投影 `sourceLimitations`，不复制旧关联或原文摘要。
- `LibraryOpenResult`：`location/name/target` 与当前 file/directory/url/unavailable。没有旧 `entry` 包装；项目文件不为预览生成引用记录。原件读取 hash 仅描述当次字节。

`LibraryService({store,core,files,now?})` 提供：

```ts
list(request: LibraryListRequest, signal?: AbortSignal): Promise<LibraryListing>
add(request: LibraryAddRequest): Promise<LibraryEntry>
open(request: LibraryOpenRequest, signal?: AbortSignal): Promise<LibraryOpenResult>
remove(request: LibraryEntryRequest): Promise<void>
prepareProjectDeletion(projectId: string): LibraryProjectDeletion
```

目录按当前层读取，没有 watcher、后台扫描或逐文件账。list 两部分读取独立失败；目录失败不能伪装为空，引用目录失败不遮住可读项目文件。只读 list/open 不创建/改写引用索引。文件更新后重新读取原位置；缺失或权限错误不回旧正文。URL 仅返回原地址与 `notChecked`。

## 核心接缝

来源复用 `source-reader.ts` 的 `NativeProjectSource`，只接受 message/tool，不再从宽 `ProjectSourceRef` 引入旧业务对象。

`LibraryCorePort` 只剩：

- `resolveScope({projectId,sessionId}) → LibraryScope`：真实成员绑定；提供 `projectRoot/projectFilesRoot/workingDirectory/workspaceRoot?` 和 Host 会话 ID。
- `verifySources(scope,nativeSources)`：核实实际来源；这只是引用添加来源，不是用户认可，也不证明文件由该会话创建。读取既有文件不要求重新验证历史来源可读。

`LibraryNativeFiles`：

- `readBytes({hostSessionId,path,signal?}) → {data,absolutePath}`：仍适配真实 native 文件读取。
- `listDirectory({hostSessionId,path,signal?}) → {entries,truncated}`：显式目录引用沿宿主工作区目录限制，不绕过被拒绝的外部目录。
- `listProjectDirectory({scope,relativePath,signal?}) → {absolutePath,entries,truncated}`：核心限定可信项目根、使用 DSH 执行世界 fs 目录能力；即使 Session 绑定工程，也列项目自有文件区。Library 不使用 node:fs 读取原件兜底，不改 cwd。

项目 root 的 `relativePath` 是空字符串；子目录用 `/` 分隔，拒绝绝对定位和 `..`。模块不持久化项目文件类型；open 非根项目位置先走 native 字节读取，只有宿主返回 `workspace-file/not-regular-file` 才走项目目录 port。其它错误不另找副本或其它文件。取消下传，在异步 scope/引用读取后及返回内容前再次核对。

目录引用的UI子项沿同一open入口：先核本项目entry与目录target，再把合法相对位置接在引用根，使用原host字节/目录能力及权限。文件或URL引用不接受子项；不改cwd、不扩权限、不复制文件或写入子项引用。Reader可打开文件/子目录及返回上一级；位置身份包含entryId和relativePath，取消或迟到的另一子项内容不得覆盖当前读取。模型工具仍保持entry_id/project_relative_path原Schema，不因UI浏览增加模型参数。

## 引用索引与历史兼容

`LibraryStore(dataRoot)` 每 runtime 一实例，唯一持有 `<dataRoot>/<projectId>/library/references.json`；同一项目继续串行写与原子替换，不同项目的引用队列互不等待。旧 v1 和新中性条目可混用；认识 v1/v2，未知版本失败，不猜格式。

私有解码保留封套、条目和 target/source 内的扩展；当前 DTO 只投影文件字段及真实 native locator。旧 purpose/workId/resultId/record-only source 不驱动状态、验证或上下文。含间接来源明确显示限制，不把它改成 native 用户原话。

读取不重写。合法 upsert 保持同位置入口 ID、首次添加者/时间、未触及条目、更新条目旧扩展/旧关联及来源原值；只更新请求拥有的文件元数据并补实际来源。新条目无退休字段，已有目录版本保持，新目录用 v2。remove 只按明确 entryId 移除该入口，永不删原件；不迁移旧项目或触及 record.json。

## 整项目永久删除接缝

原项目删除事务同步取得 `prepareProjectDeletion(projectId)`，只切断该项目的新 add/remove；其它项目继续。Service 在首次归属/source await 前登记每个 add/remove，`drained` 等待切点前全部已接纳调用，包括真实来源读取、引用队列、临时文件写入、rename 和必要清理。任一调用失败，原调用与 drained 均保留失败，不能据此开始永久清理。

原删除控制器先确认所属工作停止与所有数据 owner 排空，再提交原 ProjectStore 的永久 source 失效，确认后调用 `commit()`。尚未提交且停止/保存失败时调用 `release()`，恢复本动作临时限制；source 提交已发生或确认未知时不得释放。重复 prepare 返回当前同一准备结果；commit 后 release 不恢复接纳，旧 release 也不能解除后来动作。`commit()` 不能取消已经发往 OS 的 rename，正常调用顺序必须先确认 drained 成功。

这里只持有该动作的内存 cut，不新建持久删除台账或删除控制器。已永久提交的 service 会拒绝 scope，晚完成的 scope/source 和排队写在保存前核对永久失效；新进程由原 ProjectStore/source 经过 `LibraryCorePort.resolveScope` 拒绝不可用项目/会话。原 source 投影必须在对外提供 Library 前初始化。引用目录的实际删除仍由原项目删除 owner 执行。

Library 路径链接不取得附件所有权或保活权。所属 owner 合法删除原件后，存活项目的引用及来源保留，打开如实 missing；外部原件不会由本模块删除。不扫描其它项目，不建立 Library→附件 holder 桥。

## 模型工具与界面

`installLibraryTools(agent,{service,resolveRequest,sourceForCall})` 只注册四项：

- `project_library_list({directory?})`：直接返回目录与引用，不读 Outcomes。
- `project_library_add({name,kind,location,description?})`：只保存入口和真实工具来源。
- `project_library_open({project_relative_path? ,entry_id?})`：恰好一个定位；空 project_relative_path 打开项目根。文本返回当前解码正文，二进制不把 base64 放入模型上下文。
- `project_library_remove({entry_id})`：只解除引用。

`project_record_result/project_record_recognition` 及结果/认可 UI 已从本模块退出。普通文件生成/修改沿普通 DSH 工具和聊天；不要求先收录才能继续。

`LibraryPanel` props 是 projectId/sessionId/actions，以及可选回调：

- `onOpenSource(source: NativeProjectSource): void`：普通引用的真实来源；标明是“引用来源”，不是文件创建或已核对。
- `onOpenOriginal(target: LibraryTarget): Promise<void>`：核心接宿主原位置打开/定位；未提供时不显示按钮。

Panel 包含当前目录/根与上一级、显式引用、当前预览和来源限制。无来源项目文件只显示路径，不造作者。按项目/会话 key 隔离首次 DOM commit；目录/list/open 请求代次和取消使迟到返回不覆盖当前页；重读前清旧正文，失败不显示上次内容。相同项目位置另有显式引用时，移除引用仍保留目录中的实际文件。

## 验证入口与范围

领域测试为`tests/library.test.ts`、`library-tools.test.ts`、`library-panel.test.ts`，分别检查文件／索引、工具及界面。当前开发工具与正常构建从[项目空间入口](../../../../../../docs/technical/DSH-Projects-项目空间与版本入口.md#development-commands)读取，不沿旧定制宿主命令选择依赖。

D15-L1当时的临时fixture、DOM、窄类型检查和未覆盖范围见[模块历史](../../../../../../docs/archive/2026-10-26-current-docs-closeout/MODULE-HISTORY.md#领域模块历史自验)。原“尚待公共接入”不再描述当前版本；当前同版安装结论见[发行记录](../../../../../../source/releases/44-latest/README.md)。本次文档整理未重跑验证，模型理解和实际使用效果尚未验证。
