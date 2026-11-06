/** Product copy for the current Projects client surface. Each key owns one Chinese/English pair. */
import { PROJECT_HISTORY_SESSION_LINK_COPY, PROJECT_HISTORY_PARTIAL_PREVIEW_COPY } from '../project-history-types.ts';
// Namespace paths share their prefixes. An empty child key is the namespace's own copy.
// Identical labels share exact pairs; each namespace keeps its own key.
const cancelCopy = ["取消","Cancel"] as const;
const viewSourceCopy = ["查看来源","View source"] as const;
const archiveConfirmationTitleCopy = ["归档「{name}」？","Archive “{name}”?"] as const;
const discardChangesCopy = ["放弃修改并继续","Discard and continue"] as const;
const openOriginalLocationCopy = ["在原位置打开","Open original location"] as const;
const unsavedChangesTitleCopy = ["还有未保存的修改","Unsaved changes"] as const;
const ownedProjectFilesCopy = ["项目自有文件","Owned project files"] as const;
const confirmedAbsentCopy = ["已确认不存在","Confirmed absent"] as const;
const workspacePathCopy = ["工作区路径","Workspace path"] as const;
const projectSettingsCopy = ["项目设置","Project settings"] as const;
const backToSessionsCopy = ["返回会话","Back to sessions"] as const;
const searchProjectsCopy = ["搜索项目","Search projects"] as const;
const createProjectCopy = ["创建项目","Create project"] as const;
const projectInstructionsCopy = ["项目说明与要求","Project description and requirements"] as const;
const cancelEditingCopy = ["取消编辑","Cancel editing"] as const;
const projectFilesCopy = ["项目文件","Project files"] as const;
const mainSessionCopy = ["主会话","Main session"] as const;
const editingCopy = ["正在编辑","Editing"] as const;
const archivedCopy = ["已归档","Archived"] as const;
const referencesCopy = ["引用","References"] as const;
const unsavedCopy = ["未保存","Unsaved"] as const;
const retryCopy = ["重试","Retry"] as const;
const nameCopy = ["名称","Name"] as const;
const typeCopy = ["类型","Type"] as const;
const saveCopy = ["保存","Save"] as const;
const allCopy = ["全部","All"] as const;

const catalog = {
  "replySessionLinks": {
    "unavailable": ["暂时无法打开该会话，请稍后再试。", "This conversation could not be opened. Try again later."]
  },
  "experience": {
    "dateLocale": ["zh-CN","en-US"],
  },
  "ui.select": {
    "current": ["当前选择：{values}", "Current selection: {values}"],
    "empty": ["未选择", "None selected"],
    "currentChoice": ["已选中，当前选项。", "Selected, current choice."],
    "select": ["未选中，激活后选择。", "Not selected, activate to select."],
    "add": ["未选中，激活后添加。", "Not selected, activate to add."],
    "remove": ["已选中，激活后移除。", "Selected, activate to remove."],
    "unavailable": ["不可用。", "Unavailable."],
    "selectedUnavailable": ["已选中，不可用。", "Selected, unavailable."]
  },
  "whole.stock": {
    "reading": {
      "loading": ["正在读取会话…", "Loading conversation…"],
      "failed": ["无法读取会话", "Could not read conversation"]
    },
    "plan": {
      "close": ["关闭计划预览", "Close plan preview"],
      "loading": ["正在读取计划…", "Loading plan…"],
      "unavailable": ["无法读取计划", "Plan unavailable"],
      "reviewUnavailable": ["临时审阅文档已不可用。", "The temporary review document is unavailable."],
      "retry": retryCopy,
      "copy": ["复制", "Copy"],
      "copied": ["已复制", "Copied"],
      "code": ["代码", "Code"],
      "wrap": ["自动换行", "Wrap"],
      "unwrap": ["取消换行", "Unwrap"],
      "footnotes": ["脚注", "Footnotes"]
    }
  },
  "wholeRead": {
    "submission": {
      "failed": ["提交结果尚未确认", "Submission result unconfirmed"],
      "recovery": ["刚才的回答或审批可能已收到，请先核对当前会话中的最新状态。系统不会自动重复提交。", "Your answer or approval may have been received. Check the latest state in this conversation before submitting again. It will not be resent automatically."],
      "retained": ["刚才提交的内容已保留，以下内容供你核对。", "Your submitted content has been kept below for you to check."],
      "approval": ["刚才选择的审批决定", "Approval decision you selected"],
      "outcome": {
        "allowed-once": ["仅允许这一次", "Allow once"],
        "rejected": ["拒绝", "Reject"],
        "cancelled": ["取消", "Cancel"],
        "unavailable": ["未取得可用决定", "No decision available"]
      }
    },
    "navigation": {
      "failed": ["未能打开该内容", "Could not open this content"],
      "recovery": ["本次打开未完成。请返回原入口再试；仍无法打开时，可刷新项目面板。", "Opening this content did not complete. Try its original entry again, or refresh the Projects panel if it still cannot open."],
      "dismiss": ["关闭提示", "Dismiss notice"]
    },
    "projectUpdates": {
      "title": ["项目状态更新已中断", "Project status updates stopped"],
      "previous": ["当前显示上次读取的项目状态，可能已过期。", "Showing the last project state read; it may be out of date."],
      "recovery": ["返回项目列表后重新打开，可恢复状态更新；不会自动重放或续跑任务。", "Return to the project list and reopen this project to restore updates. Tasks will not be replayed or resumed automatically."],
      "settingsRecovery": ["这些设置可能已过期。请先处理未保存的修改，再关闭设置，返回项目列表重新打开项目。", "These settings may be out of date. Finish any unsaved edits, close settings, then return to the project list and reopen the project."],
      "details": ["查看中断详情", "View interruption details"]
    },
    "ready": {
      "label": ["项目运行提示", "Projects runtime notices"],
      "viewFailure": ["项目界面挂载失败", "The Projects view could not be mounted"],
      "viewRecovery": ["请先保留未保存的输入，再重新打开项目面板；仍无法打开时，可重新加载应用。", "Keep any unsaved input before reopening the Projects panel. If it still cannot open, reload the app."],
      "interactionFailure": ["项目交互曾发生错误", "A Projects interaction reported an error"],
      "controlFailure": ["会话状态控制流失败", "The session-state control stream failed"],
      "configurationFailure": ["配置更新有错误记录", "A configuration update reported an error"],
      "configurationWarnings": ["项目配置提示", "Projects configuration notices"],
      "multipleFailures": ["项目运行中有错误记录", "Projects has reported runtime errors"],
      "details": ["查看来源与完整详情（{count}）", "View sources and full details ({count})"],
      "detailsRegion": ["运行提示原始详情", "Original runtime notice details"],
      "scope": ["历史运行提示可能与当前页面无关；是否恢复，以对应对象的最新结果为准。","Retained runtime notices may not concern this page. Check the relevant object's latest result for recovery status."]
    },
    "library": {
      "retained": ["显示 {at} 读取的目录与引用；当前内容未确认。","Showing directories and references read at {at}; current contents are unconfirmed."],
      "retainedAfterWrite": ["本页引用更新已确认；其余为 {at} 读取的内容，当前状态未确认。","Reference updates on this page are confirmed. Other contents were read at {at}; their current state is unconfirmed."],
      "countUnconfirmed": ["当前数量尚未确认", "Current count unconfirmed"],
      "writeScopeMismatch": ["引用保存返回了其他项目的数据，当前保存结果尚未确认。", "The reference save returned another project's data; this save result is unconfirmed."]
    },
    "usage": {
      "retained": ["仍显示当前筛选范围上次读取的用量（{at}）；当前用量尚未确认。", "Still showing usage last read at {at} for the applied filters; current usage is unconfirmed."],
      "scopeMismatch": ["用量返回范围不符合当前筛选。", "The returned usage scope does not match the applied filters."]
    },
    "schedule": {
      "retained": ["显示 {at} 读取的计划与运行历史；当前状态未确认。","Showing schedules and run history read at {at}; current state is unconfirmed."],
      "retainedAfterWrite": ["本页计划更新已确认；其余计划与运行历史读取于 {at}，当前状态未确认。","Schedule updates on this page are confirmed. Other schedules and run history were read at {at}; their current state is unconfirmed."],
      "timeUnconfirmed": ["下次计划时间尚未重新读取确认", "Next planned time has not been reread and confirmed"]
    },
    "recorded": {
      "select": ["请选择一份会话记录", "Select a recorded conversation"]
    },
    "defaults": {
      "failed": ["无法读取新建默认模型", "Could not load new-session defaults"]
    },
    "initialization": {
      "loading": ["正在加载项目…", "Loading Projects…"],
      "failed": ["无法初始化项目", "Could not initialize Projects"],
      "recovery": ["请重新加载应用后打开项目。切换面板不会重新初始化。", "Reload the app, then open Projects. Switching panels does not restart initialization."]
    },
    "image": {
      "loading": ["正在读取来源图片…", "Loading source image…"],
      "failed": ["未能读取来源图片", "Could not load source image"]
    }
  },
  "list": {
    "search": {
      "label": searchProjectsCopy,
      "placeholder": searchProjectsCopy,
      "clear": ["清空搜索", "Clear search"],
      "empty": {
        "title": ["没有匹配的项目", "No matching projects"],
        "description": ["试试其他项目名称，或切换筛选。", "Try another project name or filter."]
      }
    },
    "archived": {
      "tag": archivedCopy,
      "empty": {
        "title": ["没有已归档的项目", "No archived projects"],
        "description": ["归档的项目会显示在这里", "Archived projects will appear here"]
      }
    },
    "deletion": {
      "pending": ["删除尚未完成，打开查看结果并继续", "Deletion incomplete; open results to continue"]
    },
    "title": ["项目", "Projects"],
    "description": ["组织会话、记忆与资料", "Organize conversations, memory and materials"],
    "loading": ["正在读取项目…", "Loading projects…"],
    "empty": {
      "title": ["还没有项目", "No projects yet"],
      "description": ["创建项目后，可以直接在主会话里开始交流。", "Create a project to start talking in its main session."]
    },
    "open": ["打开项目 {name}", "Open project {name}"],
    "filter": {
      "label": ["项目筛选", "Project filter"],
      "active": ["活跃", "Active"],
      "archived": archivedCopy
    },
    "error": ["无法加载项目", "Could not load projects"],
    "retry": retryCopy
  },
  "create": {
    "unconfirmed": ["项目创建结果尚未确认，请先查看项目列表，避免重复创建。","Project creation is unconfirmed. Check the project list before creating again."],
    "errorDetails": ["错误详情","Error details"],
    "workspace": {
      "error": {
        "absoluteRequired": ["请填写工作区的绝对目录路径。","Enter an absolute folder path for the workspace."],
        "notFound": ["此工作区路径不存在，请核对后修改。","This workspace path does not exist. Check and correct it."],
        "notDirectory": ["此路径不是目录，请选择或填写文件夹路径。","This path is not a folder. Choose or enter a folder path."],
        "unreadable": ["无法读取此工作区路径，请检查访问权限或改用其他路径。","Could not read this workspace path. Check access permissions or use another path."],
      },
      "choose": {
        "": ["选择目录", "Choose folder"],
        "error": ["无法打开目录选择，请重试或手动填写路径。", "Could not open the folder picker. Try again or enter a path."]
      },
      "choosing": ["正在选择…", "Choosing…"],
      "label": ["工作区（选填）", "Workspace (optional)"],
      "placeholder": ["/path/to/workspace", "/path/to/workspace"],
      "note": ["主会话将在此目录工作。", "The main conversation will work in this folder."]
    },
    "discard": {
      "title": ["放弃创建项目？", "Discard this project draft?"],
      "description": ["已填写的名称、项目说明与要求和工作区将被清空。", "The name, project description and requirements, and workspace you entered will be cleared."],
      "keep": ["继续编辑", "Keep editing"],
      "submit": ["放弃草稿", "Discard draft"]
    },
    "open": ["创建项目", "New project"],
    "title": createProjectCopy,
    "name": {
      "label": nameCopy,
      "placeholder": ["例如：产品首版", "For example: First product release"]
    },
    "instructions": {
      "label": ["项目说明与要求（选填）", "Project description and requirements (optional)"],
      "placeholder": ["介绍项目用途、目标，以及需要持续遵守的要求。", "Describe the project’s purpose, goals, and requirements to follow throughout."],
      "note": ["供主会话与执行会话共同参考，之后可在设置中修改。", "Shared with main and execution conversations. You can edit this later in settings."]
    },
    "submit": createProjectCopy,
    "cancel": cancelCopy,
    "error": ["项目创建失败，尚未打开。","Project creation failed; the project was not opened."],
    "mainUnavailable": ["项目已创建，主会话可读性未确认；请稍后从项目列表打开。","Project created; main conversation readability is unconfirmed. Open it from the project list later."],
    "partialWarning": ["项目已创建并打开；部分后续操作未完成：{value}","Project created and opened; later operations are incomplete: {value}"]
  },
  "project": {
    "conversations": {
      "label": ["项目会话", "Project conversations"]
    },
    "conversation": {
      "main": ["主会话", "Main conversation"],
      "execution": ["执行会话", "Execution conversation"]
    },
    "overview": {
      "panelTitle": ["项目概览", "Project overview"],
      "back": ["返回会话", "Back to conversation"],
      "title": ["会话", "Sessions"],
      "open": ["打开概览", "Open overview"],
      "close": ["关闭概览", "Close overview"],
      "resize": ["调整项目概览宽度", "Resize project overview"],
      "width": ["{width} 像素", "{width} pixels"],
      "widthOptions": ["调整概览宽度", "Adjust overview width"],
      "narrower": ["收窄", "Narrower"],
      "wider": ["加宽", "Wider"],
      "defaultWidth": ["恢复默认", "Restore default width"],
      "action": ["概览", "Overview"]
    },
    "settings": {
      "open": projectSettingsCopy
    },
    "archive": {
      "confirm": {
        "title": archiveConfirmationTitleCopy,
        "description": ["归档会停止项目及所属会话的当前工作，并将聊天设为只读；恢复后不会自动续跑。", "Archiving stops current work in this project and its conversations and makes chats read-only. Restoring does not resume past work automatically."]
      }
    },
    "handoff": {
      "error": ["主会话已更换承接者，但未提交输入尚未完整交接；原输入仍保留，请保持当前页面。", "The main conversation changed, but the unsent input has not finished transferring. The original input is retained; keep this page open."]
    },
    "deletion": {
      "title": ["项目永久删除结果", "Project permanent deletion results"],
      "deleting": ["项目删除处理中，尚未确认全部完成。", "Project deletion is in progress; completion is not confirmed."],
      "partial": ["项目删除部分完成，不可恢复已删除内容。", "Project deletion is partial. Removed content cannot be recovered."],
      "deleted": ["项目已永久删除。", "Project permanently deleted."],
      "readonly": ["此处仅显示实际清理结果，不能继续项目工作或恢复已删除聊天。未确认项不代表已删除。", "Only actual cleanup results are shown. Project work and deleted chats cannot be resumed. Unconfirmed items are not treated as removed."],
      "files": ownedProjectFilesCopy,
      "continue": ["继续删除整个项目", "Continue deleting entire project"]
    },
    "back": ["返回项目列表", "Back to projects"],
    "actions": {
      "label": ["项目操作", "Project actions"]
    },
    "more": ["更多", "More"],
    "rename": ["重命名项目", "Rename project"],
    "lifecycle": {
      "scope": ["归档、恢复或删除作用于整个项目及所属会话；主会话不能单独移除。", "Archive, restore and delete affect the whole project and its sessions. The main conversation cannot be removed separately."]
    },
    "navigation": {
      "open": ["展开普通会话与全局导航", "Expand regular conversations and global navigation"]
    },
    "library": {
      "back": ["返回资料", "Back to materials"],
      "title": ["资料", "Files"],
      "sessionUnavailable": ["当前没有可用于读取资料的项目会话。", "No Project session is currently available to read files."],
      "openOriginal": openOriginalLocationCopy
    },
    "board": {
      "back": ["返回看板", "Back to board"]
    },
    "schedule": {
      "back": ["返回定时", "Back to schedules"]
    },
    "main": {
      "label": mainSessionCopy
    },
    "workspace": {
      "label": ["工作区", "Workspace"],
      "empty": ["未关联工作区。", "No workspace linked."]
    },
    "history": {
      "previous": ["上一批","Previous batch"],
      "nextBatch": ["下一批","Next batch"],
      "firstBatch": ["返回首批","Back to first batch"],
      "batchNumber": ["第 {page} 批","Batch {page}"],
      "retainedSnapshot": ["本次读取未成功，下方仍为此前读取的第 {page} 批。","This read did not succeed. Showing the previously read batch {page}."],
      "title": ["聊天记录", "Chat history"],
      "searchAction": ["搜索", "Search"],
      "recent": ["最近消息", "Recent messages"],
      "results": ["搜索结果", "Search results"],
      "newestFirst": ["由新到旧", "Newest first"],
      "dateFilter": ["按时间筛选", "Filter by date"],
      "contextTitle": ["聊天上下文", "Chat context"],
      "contextActions": ["聊天记录操作", "Chat history actions"],
      "backToSearch": ["返回搜索", "Back to search"],
      "backToMessage": ["返回消息", "Back to message"],
      "viewAttachments": ["在原会话查看附件", "View attachments in the original conversation"],
      "enterSession": ["进入会话", "Enter conversation"],
      "enterFailed": ["暂时无法进入这个会话，请重试。", "This conversation could not be opened. Try again."],
      "readingContext": ["正在读取这条消息与前后文…", "Reading this message and its context…"],
      "contextUnavailable": ["这段聊天暂时无法读取。", "This chat context is currently unavailable."],
      "contextMissing": ["没有找到这条聊天消息。", "This chat message was not found."],
      "readonlyContext": ["只读聊天上下文", "Read-only chat context"],
      "selectedMessage": ["本条消息", "Selected message"],
      "savedFragmentLabel": ["保存的回复片段", "Saved reply fragment"],
      "toolDetails": ["这段对话的工具过程（{count}）", "Tools used in this context ({count})"],
      "readingRange": ["本次读取范围", "About this reading range"],
      "readMoreText": ["继续读取这条消息", "Read more of this message"],
      "readingMore": ["正在读取后续内容…", "Reading more…"],
      "moreUnavailable": ["后续内容暂时无法读取，已读取的范围仍保留。", "More text could not be read. The previously read range is retained."],
      "communicationRoute": ["{from} → {to}", "{from} → {to}"],
      "communicationSaved": ["已保存的发出消息", "Saved outgoing message"],
      "communicationReceived": ["本会话已收到的消息", "Message received by this conversation"],
      "communicationNote": ["会话附言", "Session note"],
      "communicationForwarded": ["转交的原话（{speaker}）", "Forwarded original words ({speaker})"],
      "communicationIdentityUnknown": ["原发言方未记录。", "The original speaker was not recorded."],
      "keyword": {
        "": ["关键词", "Keywords"],
        "placeholder": ["搜索聊天内容", "Search chat content"]
      },
      "fromTime": ["开始时间（本地时区）", "From (local time)"],
      "toTime": ["结束时间（本地时区）", "To (local time)"],
      "invalidTimeRange": ["结束时间须晚于开始时间。", "The end time must be later than the start time."],
      "invalidLocalTime": ["请输入有效的本地日期和时间。", "Enter a valid local date and time."],
      "session": ["会话", "Session"],
      "allSessions": ["全部项目会话", "All Project sessions"],
      "speaker": {
        "": ["发言者", "Speaker"],
        "user": ["用户", "User"],
        "assistant": ["助手", "Assistant"],
        "project-delivery": ["会话间消息", "Inter-session message"],
        "tool": ["工具", "Tool"],
        "unknown": ["未分类可见事件", "Unclassified visible event"],
        "system": ["系统通知", "System notice"]
      },
      "allSpeakers": ["全部发言者", "All speakers"],
      "phaseAccepted": ["已接纳", "Accepted"],
      "phaseEdited": ["队列记录更新", "Queue record updated"],
      "phaseConsumed": ["已进入会话处理", "Entered conversation processing"],
      "phaseClaimed": ["已出队", "Dequeued"],
      "phaseCanceled": ["已撤销", "Canceled"],
      "phaseOther": ["{phase}", "{phase}"],
      "earlierVersionMatch": ["编辑前的内容", "Content before editing"],
      "lastRecorded": ["最后记录：{time}", "Last recorded: {time}"],
      "showVersions": ["版本记录（{count}）", "Version history ({count})"],
      "hideVersions": ["收起版本记录", "Hide version history"],
      "versions": ["消息版本", "Message versions"],
      "versionMatches": ["命中本次查询", "Matches this search"],
      "sessionLink": PROJECT_HISTORY_SESSION_LINK_COPY,
      "partialPreview": PROJECT_HISTORY_PARTIAL_PREVIEW_COPY,
      "savedReplyFragment": ["这是保存时的回复片段，仅展示截至当时已保存的内容；后续内容未知。", "This saved reply fragment shows only the content recorded at that time. Later content is unknown."],
      "recordDetails": ["记录详情与前后文", "Record details and context"],
      "surroundingRecords": ["相邻记录", "Surrounding records"],
      "incompleteReference": ["会话引用未完整保存", "Session reference was not fully saved"],
      "originalRecord": ["原始记录", "Original record"],
      "imageAlternative": ["图片（原文无替代文字）", "Image (no alternative text in the original)"],
      "openVersion": ["查看此版本原文，{time}", "View this version at {time}"],
      "nextVersions": ["继续读取版本记录", "Load more version records"],
      "sender": ["来自 {value}", "from {value}"],
      "search": ["查询聊天记录", "Search chat history"],
      "searching": ["正在查找聊天记录…", "Searching Project chats…"],
      "empty": ["当前查询范围没有可显示的聊天记录。", "No displayable chat was found in this query range."],
      "error": ["聊天记录当前无法读取。", "Project chat history is currently unavailable."],
      "next": ["继续读取", "Load more"],
      "partial": ["本次只返回部分可读范围。", "Only part of the readable range was returned."],
      "openSource": ["查看原位置与前后文", "View original context"],
      "limitations": ["查询限制：{value}", "Query limitation: {value}"]
    },
    "memory": {
      "editSettings": ["打开背景与记忆设置", "Open background and memory settings"],
      "added": ["已新增项目记忆", "Project memory added"],
      "updated": ["已更新项目记忆", "Project memory updated"]
    },
    "sources": {
      "title": ["来源", "Source"],
      "back": backToSessionsCopy,
      "open": viewSourceCopy,
      "loading": ["正在读取来源…", "Loading source…"],
      "error": ["部分来源暂时无法读取。", "Some sources could not be read right now."],
      "empty": ["没有可显示的来源。", "There are no sources to show."],
      "unresolved": ["这条来源已无法从原会话记录中找到。", "This source can no longer be found in the original conversation record."],
      "emptyNative": ["这条来源没有可显示的文本。", "This source has no displayable text."],
      "role": {
        "input": ["会话输入", "Conversation input"],
        "assistant": ["会话回复", "Conversation reply"],
        "tool": ["工具记录", "Tool record"],
        "system": ["系统记录", "System record"],
        "delivery": ["项目消息", "Project message"]
      },
      "target": ["这条来源", "This source"],
      "context": ["相邻上下文", "Nearby context"],
      "deleting": ["来源会话删除处理中。", "Source conversation deletion is in progress."],
      "partial": ["来源会话删除部分完成，原聊天不可读取。", "Source deletion is partial; the conversation cannot be read."],
      "deleted": ["来源会话已删除。", "The source conversation was deleted."]
    },
    "error": ["无法打开项目。请返回列表后重试。", "Could not open the project. Return to the list and try again."],
    "loading": ["正在打开项目会话…", "Opening project sessions…"]
  },
  "settings": {
    "window": {
      "title": projectSettingsCopy,
      "closeLabel": ["关闭项目设置", "Close project settings"]
    },
    "nav": {
      "general": ["常规", "General"],
      "memory": ["背景与记忆", "Context & memory"],
      "execution": ["执行环境", "Execution environment"],
      "usage": ["用量", "Usage"]
    },
    "close": ["关闭", "Close"],
    "sectionSave": {
      "note": ["各项分别保存", "Save each section separately"]
    }
  },
  "tool": {
    "card": {
      "fact": {
        "withdrawalSaved": ["撤回标记保存", "Withdrawal marker saved"],
        "confirmed": ["已确认", "Confirmed"],
        "bodySaved": ["正文保存", "Body saved"],
        "bodyRemoved": ["正文移除", "Body removed"],
        "indexSaved": ["索引保存", "Index saved"],
        "stopRequest": ["停止请求", "Stop request"]
      },
      "target": {
        "projectFiles": projectFilesCopy,
        "references": referencesCopy,
        "project": ["项目指令", "Project instructions"],
        "session": ["会话 {id}", "Session {id}"]
      },
      "returned": ["调用已返回", "Call returned"],
      "result": {
        "read": ["读取已返回", "Read returned"],
        "saved": ["已保存", "Saved"],
        "partial": ["部分完成", "Partially completed"],
        "failed": ["操作失败", "Operation failed"],
        "conflict": ["保存冲突", "Save conflict"],
        "unavailable": ["不可用", "Unavailable"],
        "unknown": ["未确认", "Unconfirmed"],
        "stopped": ["已停止", "Stopped"],
        "noCurrentRun": ["没有当前运行", "No current run"],
        "withdrawn": ["已撤回", "Withdrawn"],
        "incomplete": ["未全部完成", "Not fully completed"]
      },
      "resultCount": ["{state}：{count}", "{state}: {count}"],
      "request": {
        "sent": ["已发出", "Sent"],
        "notSent": ["未发出", "Not sent"]
      },
      "title": ["{name}", "{name}"],
      "preparing": ["正在准备…", "Preparing…"],
      "running": ["正在执行…", "Running…"],
      "completed": ["已完成", "Completed"],
      "failed": ["执行失败", "Failed"],
      "input": ["查看输入", "View input"],
      "output": ["查看返回内容", "View returned content"],
      "emptyInput": ["这个调用没有可显示的输入。", "This call has no displayable input."],
      "emptyOutput": ["没有返回内容", "No content returned"],
      "emptyError": ["这个调用没有返回错误正文。", "This call returned no error body."],
      "errorCode": ["错误代码：{value}", "Error code: {value}"],
      "openMain": ["打开主会话", "Open main session"],
      "openExecution": ["打开执行会话", "Open execution session"],
      "opening": ["正在打开…", "Opening…"],
      "openError": ["无法打开相应的项目内容。请稍后重试。", "Could not open the related project content. Try again shortly."]
    }
  },
  "sessions": {
    "all": ["全部执行会话", "All execution sessions"],
    "switch": {
      "current": ["当前执行会话：{name}，切换会话", "Current execution session: {name}, switch session"],
      "selected": ["（当前会话）", " (Current session)"],
      "archived": ["{name}（已归档，只读）", "{name} (Archived, read-only)"]
    },
    "archive": {
      "confirm": {
        "title": archiveConfirmationTitleCopy,
        "description": ["归档会停止该执行会话的当前工作，并将聊天设为只读；恢复后不会自动续跑。", "Archiving stops current work in this execution conversation and makes its chat read-only. Restoring does not resume past work automatically."]
      }
    },
    "deletion": {
      "continue": ["继续删除该执行会话", "Continue deleting this execution conversation"],
      "title": ["删除处理结果", "Deletion results"],
      "deleting": ["删除处理中", "Deletion in progress"],
      "partial": ["删除部分完成", "Deletion partially completed"],
      "unconfirmed": ["尚未确认完成", "Completion not confirmed"],
      "stage": {
        "projection-cache": ["聊天显示缓存", "Conversation display cache"],
        "project-schedules": ["项目会话定时设置与运行记录", "Project conversation schedules and run records"],
        "native-schedules": ["原生会话定时记录", "Native conversation schedule records"],
        "project-files": ownedProjectFilesCopy,
        "file-attachments": ["会话自有文件附件", "Conversation file attachments"],
        "image-attachments": ["会话自有图片附件", "Conversation image attachments"],
        "session-log": ["原聊天日志", "Original conversation log"],
        "query-index": ["聊天查询索引", "Conversation query index"],
        "session-instructions": ["单会话指令", "Session instructions"],
        "final-project-record": ["来源状态收尾", "Source state finalization"]
      },
      "progress": {
        "file-completed": ["应删项已移除，共享文件已保留", "Owned entries removed; shared files retained"],
        "image-completed": ["图片附件处理结果已确认", "Image attachment results confirmed"],
        "cleared": ["已清除", "Cleared"],
        "removed": ["已删除", "Removed"],
        "already-absent": confirmedAbsentCopy,
        "not-present": ["已确认无索引", "Confirmed no index"],
        "not-applicable": ["无独立配置，无需清理", "No separate configuration to clean"]
      },
      "image-kind": {
        "image-object": ["图片原件", "Original image"],
        "image-variant": ["图片缓存", "Image cache"],
        "legacy-image-variant": ["兼容图片缓存", "Legacy image cache"]
      },
      "image-outcome": {
        "pending": ["待处理", "Pending"],
        "deleted": ["已删除", "Deleted"],
        "missing": confirmedAbsentCopy,
        "retained-shared": ["其它会话仍使用，已保留", "Retained for another conversation"],
        "failed": ["处理失败", "Failed"],
        "unknown": ["实际结果尚未确认", "Actual result not confirmed"]
      },
      "owned": {
        "title": ["自有子会话清理结果", "Owned child conversation cleanup"],
        "member": ["子会话 {value}", "Child conversation {value}"]
      },
      "certainty": {
        "failed": ["该步骤失败，后续未完成步骤未继续。", "This step failed; later incomplete steps did not continue."],
        "known-partial": ["该步骤只完成部分清理。", "This step completed only part of its cleanup."],
        "unknown": ["该步骤实际完成范围尚未确认。", "The completed scope of this step is not yet confirmed."]
      },
      "knownRemoved": ["已确认清除：{value} 项", "Confirmed removed: {value} artifacts"],
      "knownRemaining": ["已确认剩余：{value} 项", "Confirmed remaining: {value} artifacts"]
    },
    "new": {
      "startAnother": ["另建一个会话","Start another session"],
      "anotherWarning": ["上次创建结果未确认，另建可能产生重复会话。","The previous creation result is unconfirmed. Creating another session may make a duplicate."],
      "failure": ["创建未完成","Creation did not complete"],
      "failureHelp": ["暂时无法创建会话。填写内容已保留，请稍后再试。", "The session could not be created right now. Your input has been kept. Try again later."],
      "partial": ["创建未完整完成，部分内容可能已保存。请先核对现有会话，避免重复创建。","Creation did not fully complete. Some content may have been saved. Check the existing session before creating again."],
      "checked": ["已核对到会话「{name}」。","Found session “{name}”."],
      "unresolved": ["尚未确认可打开的会话；这不表示没有创建。","An openable session has not been confirmed. This does not mean no session was created."],
      "inputRetained": ["你的名称输入已保留。","Your title has been kept."],
      "recheck": ["重新核对创建结果","Check creation result again"],
      "checking": ["正在核对创建结果…","Checking creation result…"],
      "viewList": ["查看会话列表","View session list"],
      "openExisting": ["打开已核对的会话","Open confirmed session"],
      "details": ["创建结果详情","Creation details"],
      "readFailure": ["未能核对创建结果，请稍后重试。", "The creation result could not be checked. Try again later."],
      "location": {
        "": ["新会话工作位置", "New session location"],
        "default": ["使用项目当前默认", "Use current project default"],
        "project": ["使用项目内部工作位置", "Use project internal location"],
        "other": ["指定其它工作区", "Choose another workspace"],
        "path": ["本会话工作区路径", "Session workspace path"],
        "note": ["创建空会话不会启动模型；新文件归属仍按项目文件规则处理。", "Creating an empty session does not start a model. File ownership follows the project file rules."]
      },
      "": ["新建执行会话", "New execution session"],
      "label": ["会话名称", "Session name"],
      "placeholder": ["例如：资料整理", "For example: Research notes"],
      "submit": ["创建","Create"],
      "cancel": cancelCopy,
      "error": ["无法新建执行会话。请稍后重试。", "Could not create the execution session. Try again shortly."]
    },
    "title": ["执行会话", "Execution sessions"],
    "description": ["打开后，主会话会保留在中间区域。", "The main session remains in the center while one execution session is open."],
    "empty": ["还没有执行会话", "No execution conversations yet"],
    "open": ["打开执行会话 {name}", "Open execution session {name}"],
    "chat": {
      "back": backToSessionsCopy,
      "return": ["返回执行会话 {name}", "Back to execution conversation {name}"],
      "label": ["执行会话：{name}", "Execution session: {name}"]
    },
    "unavailable": ["这条执行会话当前不可用。", "This execution session is currently unavailable."]
  },
  "archive": {
    "confirm": {
      "submit": ["确认归档", "Confirm archive"]
    }
  },
  "communication": {
    "noPreparedRecord": ["暂无完整发件记录；投递结果请核对原操作。","No complete sender record is readable. Check the original operation for delivery status."],
    "toolReceipt": ["查看调用记录", "View call record"],
    "sent": ["发消息", "Send message"],
    "received": ["收到项目消息", "Project message received"],
    "toolStopped": ["工具已停止；投递结果以保存记录为准。","Tool stopped; check the saved record for delivery status."],
    "sourceUnavailable": ["原入口不可用", "Original entry unavailable"],
    "sourceReadError": ["无法核对来源入口。", "The source entry could not be verified."],
    "attachmentUnavailable": ["附件当前不可读取。", "Attachment is currently unavailable."],
    "loadingAttachment": ["正在读取附件…", "Loading attachment…"],
    "openFile": ["打开文件 {name}", "Open file {name}"],
    "openImage": ["打开原图", "Open original image"],
    "image": ["图片", "Image"],
    "quotedCall": ["原工具调用：{name}", "Original tool call: {name}"],
    "quotedError": ["原工具错误结果", "Original tool error result"],
    "quotedResult": ["原工具结果", "Original tool result"],
    "source": ["回查来源", "View source"],
    "from": ["来自 {name}", "From {name}"],
    "to": ["发送至 {name}", "To {name}"],
    "replyTo": ["查看回复的原通信", "View the original communication"],
    "agentMessage": ["Agent正文", "Agent message"],
    "userMessages": ["用户原话", "Original user messages"],
    "context": ["相关上下文（{count}）", "Related context ({count})"],
    "id": ["消息 {id}", "Message {id}"],
    "expand": ["展开完整发送内容", "Expand complete sent content"],
    "readError": ["保存记录读取失败。", "The saved record could not be read."],
    "unsupported": ["不支持此通信格式；无法展示完整记录。", "This communication format is unsupported."],
    "unavailable": ["该保存记录当前不可读取。", "This saved record is currently unavailable."],
    "preparing": ["正在准备发件记录 · 投递未确认","Preparing sender record · Delivery unconfirmed"],
    "loading": ["正在读取保存的通信…", "Loading saved communication…"],
    "senderSave": ["发件保存：{value}", "Sender persistence: {value}"],
    "recipientSave": ["收件保存：{value}", "Recipient persistence: {value}"],
    "result": {
      "delivered": ["已送达；读取、理解与完成未确认。","Delivered; reading, understanding, and completion are unconfirmed."],
      "not-delivered": ["未送达。", "Not delivered."],
      "unknown": ["投递结果未知，请核对原操作；不会自动重发。", "Delivery is unknown. Check the original operation; no automatic resend occurs."],
      "preparation-interrupted": ["准备已中断，尚未确认投递。", "Preparation was interrupted; delivery is not confirmed."]
    },
    "insertion": {
      "not-attempted": ["尚未尝试插入目标。", "Target insertion has not been attempted."],
      "not-inserted": ["已确认未插入目标。", "Confirmed not inserted in the target."],
      "inserted": ["已插入目标会话。", "Inserted in the target conversation."],
      "unknown": ["目标插入结果未知。", "Target insertion is unknown."]
    },
    "persistence": {
      "not-started": ["尚未开始", "Not started"],
      "flushed": ["已确认保存", "Saved"],
      "unavailable": ["保存不可用", "Unavailable"],
      "failed": ["保存失败", "Failed"],
      "unknown": ["保存未确认", "Unconfirmed"]
    },
    "wakeup": {
      "not-requested": ["未请求启动目标。", "Target startup was not requested."],
      "requested": ["已请求目标按原生队列继续。", "The target was requested to continue through its native queue."],
      "unknown": ["启动请求结果未知。", "The startup request is unconfirmed."]
    },
    "speaker": {
      "user": ["用户原话", "Original user message"],
      "assistant": ["Agent原文", "Original Agent message"],
      "project-delivery": ["项目通信原文", "Original project message"],
      "system": ["系统可见原文", "Visible system message"],
      "tool": ["工具原文", "Original tool record"],
      "unknown": ["原说话者未知", "Unknown original speaker"]
    }
  },
  "panel": ["Projects", "Projects"],
  "deletion": {
    "confirm": {
      "title": ["永久删除「{name}」？", "Permanently delete “{name}”?"],
      "irreversible": ["删除后不可恢复。", "Deletion cannot be undone."],
      "projectScope": ["将停止整个项目的主会话、全部执行会话、隐藏记忆会话及其自有子会话；删除这些会话的聊天、原生接续数据、自有附件、所属定时设置与运行记录，以及项目共享记忆、整体看板、Library关联、配置和项目自有文件。", "Stops the main, all execution, hidden memory and owned child conversations. Deletes their chats, native continuation data, owned attachments, schedules and run records, plus project Memory, overview, Library links, settings and owned project files."],
      "projectRetained": ["外部工作区与引用原件、其它项目，以及已投递给其它会话的消息保留。外部资料只解除本项目关联。", "External workspaces, referenced originals, other projects and messages already delivered to other conversations are retained. External material is only unlinked from this project."],
      "executionScope": ["将停止并删除本执行会话及其自有子会话的聊天、原生接续数据、会话指令与配置、自有附件、所属定时设置及运行记录。", "Stops and deletes this execution conversation and its owned children: chats, native continuation data, instructions, settings, owned attachments, schedules and run records."],
      "executionRetained": ["其它会话、项目共享记忆、整体看板、Library关联、独立项目文件、外部工作区原件及已投递给其它会话的消息保留。不会仅因文件由本会话生成就删除它。", "Other conversations, project Memory, overview, Library links, independent project files, external originals and delivered messages are retained. Files are not deleted merely because this conversation created them."],
      "failure": ["停止未确认时不开始清理；清理部分完成会显示实际结果，只有再次明确点击才继续，不会自动重试。", "Cleanup starts only after stopping is confirmed. Partial cleanup shows actual results and continues only on an explicit click; it is never retried automatically."],
      "submit": ["永久删除", "Permanently delete"]
    },
    "cancel": cancelCopy,
    "refresh": ["刷新删除结果", "Refresh deletion results"],
    "main": {
      "options": ["主会话更多", "Main conversation options"]
    },
    "processing": ["正在确认停止、保存与实际删除结果…", "Confirming stop, save and actual deletion results…"],
    "error": ["尚未确认删除完成，请查看当前结果；不会自动重试。", "Deletion is not confirmed complete. Check the current results; no automatic retry will occur."],
    "project": {
      "open": ["删除项目", "Delete project"]
    },
    "execution": {
      "open": ["删除执行会话", "Delete execution conversation"]
    }
  },
  "icon": {
    "label": ["打开 Projects", "Open Projects"]
  },
  "p3": {
    "cards": {
      "communication": {
        "admissionSave": ["收件队列保存：{value}", "Inbox admission: {value}"],
        "completionUnconfirmed": ["任务完成：未确认", "Task completion: unconfirmed"],
        "persistenceIssue": ["保存存在异常", "Persistence needs attention"],
        "readingUnconfirmed": ["目标读取：未确认", "Target reading: unconfirmed"],
        "result": {
          "delivered": ["已送达", "Delivered"],
          "not-delivered": ["未送达", "Not delivered"],
          "preparation-interrupted": ["准备已中断", "Preparation interrupted"],
          "unknown": ["投递未确认", "Delivery unconfirmed"]
        },
        "route": ["{from} → {to}", "{from} → {to}"]
      },
      "copied": ["已复制", "Copied"],
      "copy": ["复制", "Copy"],
      "footnotes": ["脚注", "Footnotes"],
      "memory": {
        "details": ["查看详情", "View details"]
      },
      "notice": {
        "dismiss": ["收起记忆提示", "Dismiss memory notice"]
      },
      "rawContent": ["查看原文", "View raw content"]
    },
    "history": {
      "archiveReadonly": ["已归档 · 只读", "Archived · Read-only"],
      "board": {
        "tab": ["看板", "Overview"]
      },
      "bodyRange": ["第 {start}–{end} 字 / 共 {total} 字。","Characters {start}–{end} of {total}."],
      "deletion": {
        "summary": ["删除后不可恢复。将删除本项目会话、记忆和项目自有数据；外部工作区与引用原件保留。", "Deletion cannot be undone. This project’s conversations, Memory and owned data will be deleted. External workspaces and referenced originals will be kept."]
      },
      "draftKept": ["保留原会话草稿", "Original conversation draft is kept"],
      "emptyHint": ["试试放宽查询条件。", "Try broadening your search."],
      "error": ["无法读取聊天记录，请重试。", "Unable to read chat history. Try again."],
      "executionArchiveDetails": ["该执行会话的聊天只读；恢复不会自动续跑。", "This execution conversation is read-only. Restoring does not resume its work automatically."],
      "executionRestoreDetails": ["该执行会话的聊天暂为只读。请从会话操作继续恢复。", "This execution conversation is read-only for now. Continue restoring from its actions menu."],
      "feedbackConversation": ["回{name}反馈", "Return to {name} with feedback"],
      "libraryList": ["资料列表", "File list"],
      "openOriginal": ["打开原会话位置", "Open in original conversation"],
      "openResult": ["查看{session}中{role}的记录，{time}", "View the {role} record in {session}, {time}"],
      "originalConversation": ["原会话", "the original conversation"],
      "projectArchiveDetails": ["全部项目聊天只读，设置仍可编辑；恢复项目不会自动续跑旧工作。", "All project chats are read-only. Settings can still be edited. Restoring the project does not resume past work automatically."],
      "projectRestoreDetails": ["全部项目聊天暂为只读。请从项目“更多”继续恢复。", "All project chats are read-only for now. Continue restoring from the project’s More menu."],
      "projectRestoreFirst": ["请先恢复整个项目。", "Restore the whole project first."],
      "projectRestoreRequired": ["项目恢复未完成，请先继续恢复项目。", "Project restore is incomplete. Continue restoring the project first."],
      "reset": ["重置", "Reset"],
      "restoreReadonly": ["恢复未完成，暂时只读", "Restore incomplete · Read-only for now"],
      "returnBoard": ["回到项目看板", "Return to project overview"],
      "returnConversation": ["返回{name}", "Return to {name}"],
      "schedule": {
        "close": ["关闭定时任务", "Close schedules"],
        "discard": ["有尚未保存的定时修改。放弃修改并关闭？", "There are unsaved schedule changes. Discard them and close?"],
        "tab": ["定时", "Schedules"],
        "title": ["定时任务", "Schedules"]
      },
      "sessions": {
        "emptyHint": ["新建后首次消息才会运行。", "A new conversation starts running when its first message is sent."],
        "instructions": ["会话指令", "Conversation instructions"],
        "menu": ["{name}的会话操作", "Actions for {name}"],
        "open": ["打开会话", "Open conversation"]
      },
      "sidebar": ["项目侧栏", "Project overview tabs"],
      "sources": {
        "error": ["部分来源无法读取，请重试。", "Some sources could not be read. Try again."]
      }
    },
    "library": {
      "chooseFile": ["选择文件","Choose file"],
      "chooseDirectory": ["选择文件夹","Choose folder"],
      "chooseFailed": ["未能选择，请重试或手动输入路径。","Could not choose. Try again or enter the path manually."],
      "readingView": ["阅读","Read"],
      "rawView": ["原文","Source"],
      "viewMode": ["显示方式","Display mode"],
      "markdownCopy": ["复制","Copy"],
      "markdownCopied": ["已复制","Copied"],
      "markdownCode": ["代码","Code"],
      "markdownWrap": ["自动换行","Wrap lines"],
      "markdownUnwrap": ["取消自动换行","Unwrap lines"],
      "markdownFootnotes": ["脚注","Footnotes"],
      "returnConversation": ["返回会话","Back to conversation"],
      "feedback": ["反馈","Give feedback"],
      "actionFailed": ["操作未完成", "Operation did not complete"],
      "add": ["添加引用", "Add reference"],
      "addExternal": ["添加外部引用", "Add external reference"],
      "back": ["返回资料列表", "Back to library"],
      "bytes": ["{bytes} 字节", "{bytes} bytes"],
      "changedBetweenReads": ["文件已变化；当前段落为本次读取，其余段落需重读。","The file changed. This page is from the current read; reread other pages."],
      "clearSearch": ["清除查找", "Clear search"],
      "conversationNotRead": ["尚未取得文件正文。", "File content is not available yet."],
      "conversationOrigin": ["打开入口：{session}；不表示作者或完成状态。","Opened from {session}; this does not identify authorship or completion."],
      "conversationReadFailed": ["未能读取这份文件", "Could not read this file"],
      "conversationReadFailedHelp": ["未取得正文；文件位置来自原会话。","No content was read. The file location comes from the original conversation."],
      "count": ["{count} 项", "{count} items"],
      "description": ["说明", "Description"],
      "descriptionPlaceholder": ["需要时用于辨认这份材料", "An optional description to identify this item"],
      "directory": ["项目文件目录", "Project file directory"],
      "directoryFailed": ["项目目录读取失败", "Could not read the project directory"],
      "directoryTruncated": ["仅显示部分目录，已达宿主限制。","Partial directory listing; the Host limit was reached."],
      "download": ["下载本次读取内容", "Download this read"],
      "downloadHelp": ["可下载本次读取的文件内容。","Download the file content from this read."],
      "empty": ["当前目录没有文件", "No files in the current directory"],
      "emptyDirectoryRead": ["本次读取的目录没有条目。", "The directory returned no entries in this read."],
      "emptyHelp": ["添加文件或引用外部目录", "Add files or reference an external directory"],
      "emptyPartial": ["已读取的范围内没有资料。", "No items in the sources that were read."],
      "endOfFile": [" · 已读取至文件末尾。", " · Reached the end of the file."],
      "explicitReference": ["显式引用", "Explicit reference"],
      "failedReadHelp": ["本次未取得正文；名称与位置来自目录。","No content was read. The name and location come from the directory."],
      "failure": {
        "missing": ["原文件缺失", "Original file missing"],
        "permissionDenied": ["没有读取权限", "Read permission denied"],
        "readFailed": ["原位置读取失败", "Could not read the original location"],
        "tooLarge": ["超过宿主读取限制", "Exceeds Host read limit"],
        "unsupported": ["原位置类型不支持", "Unsupported location type"]
      },
      "fileDetails": ["{mediaType} · {bytes} 字节", "{mediaType} · {bytes} bytes"],
      "filePages": ["文件分段阅读", "File page navigation"],
      "filter": {
        "": ["资料归属筛选", "Filter library ownership"],
        "all": allCopy,
        "project": projectFilesCopy,
        "reference": referencesCopy
      },
      "help": ["资料查找说明", "Library search help"],
      "kind": {
        "": typeCopy,
        "directory": ["文件夹", "Folder"],
        "file": ["文件", "File"],
        "url": ["网页链接", "Web link"]
      },
      "lineRange": ["第 {from}–{to} 行", "Lines {from}–{to}"],
      "listFailed": ["资料读取失败", "Could not read the library"],
      "loading": ["正在读取目录与引用…", "Reading directories and references…"],
      "location": ["实际位置", "Location"],
      "mainSession": mainSessionCopy,
      "name": nameCopy,
      "namePlaceholder": ["资料怎样称呼", "Name for this item"],
      "nativeTextPage": ["本次为原生文本段落读取", "This read is a native text page"],
      "nextPage": ["下一段", "Next page"],
      "noMatches": ["没有匹配的资料", "No matching items"],
      "noPreview": ["此格式不提供正文预览", "Content preview is unavailable for this format"],
      "noReadableContent": ["未取得可供阅读的内容。", "No readable content was obtained."],
      "noSource": ["此引用未附原聊天定位。", "This reference has no original chat locator."],
      "noTextLines": ["本段没有文本行", "No text lines in this page"],
      "notRead": ["尚未取得这份资料的读取结果。", "No read result is available for this item yet."],
      "openOriginal": openOriginalLocationCopy,
      "openWeb": ["打开原网页", "Open original web page"],
      "openedFrom": ["从{session}打开", "Opened from {session}"],
      "originalChat": ["原聊天：", "Original chat:"],
      "originalFailed": ["原位置未能打开", "Could not open the original location"],
      "otherType": ["其它类型", "Other type"],
      "ownership": {
        "external": ["外部引用", "External reference"],
        "project": ["项目位置引用", "Project location reference"],
        "workspace": ["工作区引用", "Workspace reference"]
      },
      "pageSnapshotHelp": ["各段分别读取，可能来自不同时刻。","Pages are read separately and may be from different times."],
      "parentDirectory": ["上一级", "Parent directory"],
      "partialCount": ["{count} 项 · 部分未读取", "{count} items · Some sources were not read"],
      "partialPage": [" · 分段读取，以上不是完整文件。", " · Read in pages; this is not the complete file."],
      "pathPlaceholder": ["绝对路径或相对当前会话的路径","Absolute path or path relative to the current session"],
      "pendingRead": ["本次读取尚未完成。", "This read is still in progress."],
      "previousPage": ["上一段", "Previous page"],
      "processing": ["处理中…", "Processing…"],
      "projectDirectory": ["项目目录", "Project directory"],
      "projectFile": ["项目文件", "Project file"],
      "projectOwnership": ["位于项目自有目录，按项目文件管理。", "This item is in the project directory and is managed as a project file."],
      "rawText": ["文件原始文本", "Original file text"],
      "readAtSuffix": ["读取", "read"],
      "readBeginning": ["从头读取", "Read from beginning"],
      "readDetails": ["位置与读取详情", "Location and read details"],
      "readFailed": ["未能读取这份资料", "Could not read this item"],
      "readFailedStatus": ["读取失败", "Read failed"],
      "readNamed": ["阅读 {name}", "Read {name}"],
      "readVersion": ["本次读取版本：", "Read version:"],
      "reading": ["正在读取实际位置…", "Reading the original location…"],
      "readingFile": ["正在读取实际文件…", "Reading the actual file…"],
      "referenceHelp": ["仅保存引用；移除引用不删除原件。","Only a reference is saved. Removing it keeps the original."],
      "referenceHelpLabel": ["引用保存说明", "About saving references"],
      "referenceKind": ["引用类型", "Reference type"],
      "referenceLocationUnknown": ["显式引用位置尚未取得", "The reference location is not available yet"],
      "referenceOwnership": ["保留原件归属。移除引用不删除原文件。", "The original keeps its ownership. Removing the reference does not delete the original file."],
      "referenceRemoved": ["引用已移除，原文件保留。", "Reference removed. The original file is kept."],
      "referenceSaved": ["引用已保存。", "Reference saved."],
      "referenceSources": ["引用来源", "Reference sources"],
      "referencesFailed": ["引用目录读取失败", "Could not read the reference directory"],
      "refresh": ["刷新当前目录与引用", "Refresh current directory and references"],
      "registeredReferences": ["＋已登记引用", "+ Registered references"],
      "remove": ["移除引用", "Remove reference"],
      "removeNamed": ["移除引用 {name}", "Remove reference {name}"],
      "reread": ["重读", "Read again"],
      "rereadFile": ["重新读取当前文件", "Reread current file"],
      "rereadPage": ["重新读取当前文件段落", "Reread current file page"],
      "retry": ["重试读取", "Retry reading"],
      "returnForFeedback": ["回原会话继续交流", "Continue in original session"],
      "search": ["查找当前目录与引用", "Search current directory and references"],
      "searchHelp": ["查找当前目录和引用的名称、说明或位置，不搜索正文。","Search names, descriptions, or locations in the current directory and registered references, excluding file contents."],
      "searchPlaceholder": ["名称、引用说明或位置", "Name, reference description, or location"],
      "session": ["会话：", "Session:"],
      "sourcesHelp": ["仅记录引用添加，不确认作者、负责会话或内容。","These record how the reference was added, without confirming its author, responsible conversation, or content."],
      "sourcesHelpLabel": ["引用来源说明", "About reference sources"],
      "sourcesTitle": ["添加引用的依据", "Sources for adding this reference"],
      "title": ["资料", "Library"],
      "totalBytes": ["文件总大小 {bytes} 字节", "Total file size: {bytes} bytes"],
      "totalBytesUnknown": ["文件总字节数未报告", "Total file bytes not reported"],
      "urlDetails": ["仅保存网址；未读取网页或核实可访问性。","Only the URL is saved; page content and accessibility were not checked."],
      "urlPlaceholder": ["https://…", "https://…"],
      "viewSource": viewSourceCopy,
      "webNotRead": ["未读取网页内容，可访问性未核实。","Page content has not been read; accessibility is unverified."],
      "webReference": ["网页引用", "Web reference"]
    },
    "memory": {
      "add": ["添加记忆", "Add memory"],
      "readIssues": ["部分记忆信息尚未确认，可刷新后核对。", "Some memory information is unconfirmed. Refresh to check the current state."],
      "indexUnsynchronized": ["记忆索引尚未同步；当前列表来自可读取的记忆正文。", "The memory index is not synchronized. The current list comes from readable memory content."],
      "writeFailed": ["本次记忆修改未完成，请核对当前内容后再试。", "This memory change did not complete. Check the current content before trying again."],
      "writeResultUnconfirmed": ["未能确认本次记忆修改的结果，请核对当前内容后再决定是否重试。", "The result of this memory change could not be confirmed. Check the current content before deciding whether to try again."],
      "all": allCopy,
      "back": ["返回记忆列表", "Back to memory list"],
      "body": ["正文", "Content"],
      "bodyLabel": ["记忆正文", "Memory content"],
      "cancel": cancelCopy,
      "cancelAdd": ["取消新增", "Cancel adding"],
      "cancelEdit": cancelEditingCopy,
      "count": [" · {count} 份", " · {count}"],
      "current": ["当前记忆", "Current memory"],
      "detailEmpty": ["项目的长期背景", "Long-term project context"],
      "detailEmptyDescription": ["从列表选择记忆，或添加一份。", "Choose a memory from the list, or add one."],
      "directory": ["项目说明与要求、共享记忆", "Project description and requirements, and shared memory"],
      "edit": ["编辑与纠正", "Edit and correct"],
      "editTitle": ["纠正：{title}", "Correct: {title}"],
      "editing": editingCopy,
      "empty": ["还没有共享记忆", "No shared memory yet"],
      "emptyDescription": ["在会话里说“记住…”或手动添加", "Say “remember…” in a conversation, or add one manually"],
      "error": {
        "bodyProject": ["记忆正文不属于当前项目。", "The memory content does not belong to this project."],
        "listProject": ["记忆列表不属于当前项目。", "The memory list does not belong to this project."],
        "saveProject": ["保存结果不属于当前项目。", "The save result does not belong to this project."],
        "sourceProject": ["来源不属于当前项目。", "The source does not belong to this project."]
      },
      "help": ["共享记忆的提供与纠正规则", "How shared memories are supplied and corrected"],
      "helpDescription": ["类型只用于组织，不限制手动填写。记忆索引自动提供，正文由工作模型按需读取；项目说明与要求、单会话指令完整提供，分别保存。", "Types organize content and do not restrict manual entries. The memory index is supplied automatically; the working model reads content as needed. Project description and requirements and individual conversation instructions are supplied in full and saved separately."],
      "label": ["背景与记忆", "Background and memory"],
      "legacyTargets": [" 原范围：{targets}", " Original scope: {targets}"],
      "listError": ["记忆列表暂未取得", "The memory list could not be loaded"],
      "loadingBody": ["正在读取已保存正文…", "Reading saved content…"],
      "loadingList": ["正在读取记忆…", "Reading memories…"],
      "more": ["更多信息：类型与内容性质", "More: type and content status"],
      "nature": {
        "": ["内容性质", "Content status"],
        "confirmed": ["用户已确认", "User confirmed"],
        "unverified": ["待验证判断", "Unverified judgment"],
        "verified": ["已查证", "Verified"]
      },
      "noMatches": ["没有匹配的记忆", "No matching memories"],
      "noMatchesDescription": ["试试其他关键词或类型", "Try another search or type"],
      "paths": ["文件或目录路径（每行一个）", "File or directory paths (one per line)"],
      "processing": ["进行中", "In progress"],
      "refresh": ["刷新共享记忆列表", "Refresh shared memory list"],
      "reload": ["重新读取当前正文", "Reload current content"],
      "removed": ["该记忆已撤回或不存在。", "This memory was withdrawn or no longer exists."],
      "requirements": projectInstructionsCopy,
      "requirementsDescription": ["主会话与执行会话共用","Shared by main and execution conversations"],
      "resume": ["返回：{title}", "Return to {title}"],
      "resumeDraft": ["继续编辑：{title}", "Continue editing {title}"],
      "retry": retryCopy,
      "revision": [" · 修订 {revision}", " · Revision {revision}"],
      "save": saveCopy,
      "saveDescription": ["保存只修改这份记忆；正文与摘要一起保存，原来源保留定位。", "Saving changes only this memory. Content and summary are saved together, and original source locators are retained."],
      "savedBody": ["已保存记忆正文", "Saved memory content"],
      "scope": {
        "": ["适用范围", "Scope"],
        "file": ["指定文件", "Selected files"],
        "fileOrDirectory": ["指定文件或目录", "Selected files or directories"],
        "project": ["全项目", "Entire project"],
        "session": ["指定会话", "Selected conversations"],
        "topic": ["指定事项", "Selected topics"],
        "work": ["旧工作范围（已退出当前适用）", "Legacy work scope (no longer applicable)"]
      },
      "scopeValue": ["适用范围：{scope}", "Scope: {scope}"],
      "search": ["搜索记忆", "Search memory"],
      "settingsUser": ["用户在设置中修改", "Edited by the user in settings"],
      "shared": ["共享记忆", "Shared memory"],
      "source": {
        "action": viewSourceCopy,
        "body": ["正文 {number}", "Content {number}"],
        "content": ["来源内容与可用性", "Source content and availability"],
        "continue": ["继续读取{label}", "Continue reading {label}"],
        "current": ["当前保存的来源", "Saved sources"],
        "description": ["来源用于核对当前正文的依据。设置修改记录可以被后续修订保留，并不代表最后一次修改者。", "Sources help verify the basis of the current content. Settings change records may be retained by later revisions and do not identify the last editor."],
        "empty": ["当前没有保存的来源定位。", "No source locators are saved."],
        "end": ["本页已到正文末尾。", "This page reaches the end of the content."],
        "evidence": ["来源证据与正文续读", "Source evidence and continued content"],
        "kind": {
          "communication-part": ["已保存的通信内容", "Saved communication content"],
          "file": ["资料来源", "Material source"],
          "message": ["旧消息定位", "Legacy message locator"],
          "native-event": ["原会话事件", "Original conversation event"],
          "record": ["历史业务来源", "Historical business source"],
          "settings": ["设置中的明确修改", "Explicit settings edit"],
          "tool": ["旧工具定位", "Legacy tool locator"]
        },
        "label": ["记忆来源", "Memory sources"],
        "locator": {
          "communication": ["已保存通信 · {hostSessionId} / {deliveryId} / {partId}（版本 {version}）", "Saved communication · {hostSessionId} / {deliveryId} / {partId} (version {version})"],
          "file": ["资料 · {path}{locator}", "Material · {path}{locator}"],
          "message": ["旧消息定位（未指定事件版本） · {hostSessionId} / {messageId}", "Legacy message locator (event version unspecified) · {hostSessionId} / {messageId}"],
          "native": ["原会话事件 · {sessionId} / {hostSessionId} · {eventType} #{eventSeq}{body}", "Original conversation event · {sessionId} / {hostSessionId} · {eventType} #{eventSeq}{body}"],
          "record": ["历史业务来源（已退出） · {recordKind} / {recordId}（旧修订 {revision}，仅可按真实原生定位查原话）", "Historical business source (retired) · {recordKind} / {recordId} (legacy revision {revision}; original text requires its actual native locator)"],
          "settings": ["设置中的明确修改记录 · {changeId}（可能由后续修订保留）", "Explicit settings change record · {changeId} (may be retained by later revisions)"],
          "tool": ["旧工具定位（未指定事件版本） · {hostSessionId} / {toolCallId}", "Legacy tool locator (event version unspecified) · {hostSessionId} / {toolCallId}"]
        },
        "metadata": ["最近更新与保存位置", "Last update and saved location"],
        "more": ["正文仍有后续内容。", "More content remains."],
        "pageContent": ["{label}逐页内容", "{label} paged content"],
        "partial": ["当前显示有限原文，未显示部分不代表缺失或已经读完。可按下方稳定来源继续读取正文。", "Only limited original content is shown. Unshown content is not necessarily missing or fully read. Continue reading from the stable source below."],
        "previous": ["此前依据 · {count} 项", "Earlier sources · {count}"],
        "previousAction": ["查看此前来源", "View earlier source"],
        "previousDescription": ["这些是已保留且不在当前来源中的定位，不是逐版历史正文，也不代表新的用户决定。", "These retained locators are no longer in the current sources. They are not historical versions of the content or new user decisions."],
        "range": ["本页范围 {start}–{end} / {total}（Unicode码点）；", "Page range {start}–{end} / {total} (Unicode code points); "],
        "readBody": ["从稳定来源读取{label}", "Read {label} from the stable source"],
        "retryDescription": ["可从稳定来源重新取得允许的页面；来源失效时不能恢复旧正文。", "Retry the permitted page from the stable source. Old content cannot be restored if the source is unavailable."],
        "unreadable": ["原始来源当前不可读。", "The original source is currently unreadable."]
      },
      "summary": ["摘要", "Summary"],
      "summaryDescription": ["会话先看到标题与摘要。纠正正文时请一并核对摘要。", "Conversations see the title and summary first. Check the summary when correcting the content."],
      "summaryDetails": ["摘要与分类", "Summary and classification"],
      "summaryLabel": ["记忆摘要", "Memory summary"],
      "targets": ["选择适用对象", "Choose targets"],
      "targetsRequired": ["请至少选择一个适用会话。", "Select at least one conversation."],
      "targetsUnavailable": ["适用对象尚未接入，请在会话中指定局部范围。", "Targets are not connected yet. Specify a local scope in a conversation."],
      "title": ["标题", "Title"],
      "titleLabel": ["记忆标题", "Memory title"],
      "topics": ["具体事项（每行一个）", "Topics (one per line)"],
      "type": {
        "": typeCopy,
        "background": ["相关背景", "Related background"],
        "experience": ["选择经验与事情回忆", "Decision experience and recollections"],
        "fact": ["事实与发现", "Facts and findings"],
        "preference": ["项目内偏好", "Project preferences"],
        "rule": ["持续规则", "Ongoing rules"]
      },
      "typeFilter": ["记忆内容类型", "Memory content type"],
      "unsaved": {
        "": unsavedCopy,
        "description": ["还有未保存的修改。放弃这些修改并继续？", "You have unsaved changes. Discard them and continue?"],
        "discard": discardChangesCopy,
        "title": unsavedChangesTitleCopy
      },
      "updated": ["更新于 ", "Updated "],
      "updatedBy": ["最后更新者：{actor}", "Last updated by: {actor}"],
      "withdraw": ["撤回这份记忆", "Withdraw this memory"],
      "withdrawDescription": ["撤回后不再提供旧内容，原聊天和来源文件仍保留。", "After withdrawal, the old content is no longer supplied. Original conversations and source files remain."],
      "writeUnconfirmed": ["保存结果未确认", "Save result unconfirmed"]
    },
    "overview": {
      "blockUpdated": ["更新于", "Updated"],
      "contents": ["看板内容", "Board contents"],
      "summary": ["概况", "Overview"],
      "fullContentSources": ["完整内容与来源", "Full content and sources"],
      "legacyContent": ["暂无概况，以下为完整内容。","No overview yet; full content follows."],
      "sourceCount": ["{count} 处依据", "{count} sources"],
      "sourceIssues": ["来源状态与限制", "Source status and limitations"],
      "bodyHeading": ["完整内容", "Full content"],
      "sourcesHeading": ["依据与原件", "Sources and originals"],
      "runtimeUnknown": ["部分会话运行状态未知", "Some session runtime states are unknown"],
      "runtimeUnknownReason": ["尚未取得运行状态", "Runtime state has not been observed"],
      "collapse": ["收起", "Collapse"],
      "expandItems": ["展开全部 {count} 项", "Show all {count} items"],
      "expandRows": ["展开全部 {count} 行", "Show all {count} rows"],
      "empty": ["看板还是空的", "The board is still empty"],
      "emptyHelp": ["在主会话说说目标，它会自动整理", "Tell the main session about your goal so it can organize the board"],
      "emptyNoStart": ["查看与刷新不会启动任务。", "Viewing or refreshing does not start a task."],
      "entry": ["条目", "Entry"],
      "loading": ["正在读取看板与来源…", "Reading the board and sources…"],
      "navigationUnavailable": ["{label}（查看入口未接入）", "{label} (view entry not connected)"],
      "noContentSource": ["暂无内容与来源。", "No content or sources yet."],
      "noSource": ["未附来源，可到原聊天或文件核对。","No source attached. Check the original chat or file."],
      "noSourceRows": ["当前可读来源未提供条目。", "This readable source returned no entries."],
      "originalDetails": ["原记录与限制", "Original record and limitations"],
      "originalTime": ["原记录时间：", "Original record time:"],
      "projectUnavailable": ["项目基本信息当前不可读", "Project information is currently unreadable"],
      "readFailed": ["看板读取失败", "Could not read the board"],
      "readRecovery": ["未取得本次看板内容，请刷新后重试。", "The current board content was not obtained. Refresh to try again."],
      "factsRecovery": ["未取得当前项目的信息，可刷新看板重试。", "Current project information was not obtained. Refresh the board to try again."],
      "runtimeRecovery": ["当前无法确认会话是否正在运行，可刷新看板重试。", "Whether sessions are running is currently unconfirmed. Refresh the board to try again."],
      "readHelp": ["读取于 {time}。各来源分别读取，可能来自不同时刻；看板调整请在主会话讨论。","Read at {time}. Sources are read separately and may be from different times. Discuss board changes in the main conversation."],
      "readHelpLabel": ["看板读取说明", "About reading the board"],
      "readOnly": ["主会话维护 · 只读", "Maintained by main session · Read only"],
      "refresh": ["刷新看板", "Refresh board"],
      "refreshingPrevious": ["正在刷新；暂时显示 {time} 读取的内容。", "Refreshing; showing content read at {time}."],
      "refreshFailedPrevious": ["刷新未完成；以下仍为 {time} 读取的内容。", "Refresh did not complete; the content below was read at {time}."],
      "runtimeUnavailable": ["运行来源不可用", "Runtime source unavailable"],
      "sourceDetails": ["来源内容与读取详情", "Source content and read details"],
      "sourceLabel": ["依据：{label}", "Source: {label}"],
      "sourceNotRead": ["未取得来源内容", "Source content was not obtained"],
      "sourceReadAt": ["来源读取于", "Source read at"],
      "sourceStatus": {
        "missing": ["来源缺失或当前不可用", "Source missing or currently unavailable"],
        "unavailable": ["来源未接入或不可用", "Source not connected or unavailable"],
        "unreadable": ["来源不可读", "Source unreadable"]
      },
      "title": ["项目看板", "Project board"],
      "updated": ["看板更新于", "Board updated"],
      "wrongProject": ["返回的看板不属于当前项目", "The returned board does not belong to the current project"]
    },
    "schedule": {
      "cancel": cancelCopy,
      "disable": ["停用“{title}”的未来触发", "Disable future triggers for “{title}”"],
      "edit": ["编辑安排", "Edit schedule"],
      "enable": ["启用“{title}”的未来触发", "Enable future triggers for “{title}”"],
      "history": ["运行历史", "Run history"],
      "manage": ["查看计划", "View schedule"],
      "more": ["“{title}”的更多操作", "More actions for “{title}”"],
      "observedAt": ["记录时间：", "Recorded at: "],
      "plannedAt": ["计划时间：", "Planned time: "],
      "manualRequestedAt": ["手动请求时间：", "Manual request time: "],
      "processingStartedAt": ["开始处理时间：", "Processing started at: "],
      "readOnly": ["在定时管理中修改启停设置。", "Change enabled status in schedule management."],
      "remove": ["移除设置", "Remove settings"],
      "run": ["现在运行", "Run now"],
      "save": saveCopy,
      "saving": ["正在保存…", "Saving…"],
      "targetUnavailable": ["所属会话当前不可用", "Target session is unavailable"]
    },
    "settings": {
      "cancel": cancelCopy,
      "draft": {
        "cancel": cancelEditingCopy,
        "description": ["还有未保存的修改。放弃这些修改并继续？", "Discard unsaved changes and continue?"],
        "discard": discardChangesCopy,
        "editing": editingCopy,
        "title": unsavedChangesTitleCopy,
        "unsaved": unsavedCopy
      },
      "execution": {
        "back": ["返回该会话的聊天与模型入口", "Return to this conversation and model control"],
        "description": ["位置与指令", "Location and instructions"],
        "loading": ["正在读取所选会话实际位置…", "Loading the selected conversation location…"],
        "location": ["这个已创建会话的实际工作位置", "Actual location of this existing conversation"],
        "scope": ["下面的位置、模型入口和持续指令都属于所选会话。", "The location, model control and persistent instructions below belong to the selected conversation."],
        "select": ["正在查看哪个会话", "Conversation to view"],
        "selectLabel": ["会话指令目标", "Conversation instruction target"],
        "title": ["指定执行会话", "Selected execution conversation"],
        "unavailable": ["会话不可用", "Conversation unavailable"],
        "unreadable": ["当前不可读", "Currently unreadable"],
        "viewOnly": ["切换上方对象只查看，不切换工作位置。", "Changing the selection only changes this view, not the working location."]
      },
      "general": {
        "description": ["模型与默认工作区", "Model and default workspace"]
      },
      "locations": {
        "default": ["以后新建会话的默认位置", "Default location for new conversations"],
        "description": ["默认位置在“常规”中维护。修改默认不会移动现有文件或切换已有会话；如需在其它位置工作，可在新建会话时选择位置。", "Manage the default in General. Changing it does not move files or change existing conversations. Choose another location when creating a conversation to work elsewhere."],
        "owned": ["项目自有目录", "Owned project directory"],
        "title": ["项目目录与新建默认（对照）", "Project directory and new conversation default"]
      },
      "main": {
        "current": ["当前对象", "Current selection"],
        "description": ["「{name}」的主会话，与聊天输入区使用同一份模型配置。", "The main conversation for “{name}” uses the same model configuration as the chat input."],
        "environment": ["查看主会话位置与指令", "View main conversation location and instructions"],
        "openModel": ["进入主会话模型入口", "Open main conversation model control"],
        "title": ["当前主会话", "Current main conversation"]
      },
      "memory": {
        "description": ["项目说明与要求、共享记忆", "Project description and requirements, and shared memory"]
      },
      "model": {
        "help": {
          "description": ["选择时也会更新 DSH 默认模型；已创建的项目主会话和执行会话各自保留选择。新执行会话优先使用项目的新建默认，未设置时使用创建当时的 DSH 默认模型。", "Selection also updates the DSH default model. Existing main and execution conversations keep their own selections. New execution conversations use the project default, or the DSH default at creation when none is set."],
          "title": ["当前会话与新建默认", "Current conversation and new conversation defaults"]
        },
        "unknown": ["模型未知，尚未就绪。", "Model unknown; not ready."]
      },
      "name": {
        "description": ["在项目列表与主会话中辨认这个项目。", "Identify this project in the list and main conversation."],
        "edit": ["编辑项目名称", "Edit project name"],
        "label": ["项目名称", "Project name"],
        "save": ["保存项目名称", "Save project name"]
      },
      "overview": {
        "help": {
          "description": ["整体目标、规划、进展和重要问题由主会话维护在项目看板。这里不保存另一份目标。", "The main conversation maintains goals, plans, progress and key issues on the project board. This page does not save a second set of goals."],
          "title": ["项目整体说明在哪里维护？", "Where is the project overview maintained?"]
        }
      },
      "requirements": {
        "open": ["查看项目说明与要求", "View project description and requirements"],
        "related": ["同时使用项目说明与要求，二者分别保存。", "Project description and requirements also apply. Save each separately."]
      },
      "saving": ["保存中…", "Saving…"],
      "usage": {
        "description": ["Token 用量与范围", "Token usage and scope"]
      },
      "workspace": {
        "description": ["只影响之后新建会话；已有会话与文件保留原位置。", "Applies to new conversations only. Existing conversations and files stay in place."],
        "edit": ["编辑默认工作区", "Edit default workspace"],
        "internal": ["项目内部工作位置", "Internal project location"],
        "path": workspacePathCopy,
        "pathLabel": ["默认工作区路径", "Default workspace path"],
        "placeholder": ["留空使用项目内部工作位置", "Leave blank to use the internal project location"],
        "save": ["保存默认工作区", "Save default workspace"],
        "title": ["默认工作区", "Default workspace"]
      }
    },
    "usage": {
      "allMetrics": ["全部用量指标", "All usage metrics"],
      "breakdown": ["已报告用量来源占比", "Reported usage by source"],
      "description": ["仅汇总已报告用量。","Totals include reported usage only."],
      "empty": ["暂无已采集用量", "No collected usage yet"],
      "metric": {
        "cacheReadTokens": ["缓存读取", "Cache reads"],
        "outputTokens": ["输出", "Output"],
        "totalTokens": ["总 Token", "Total tokens"]
      },
      "partial": ["部分已报告","Partially reported"],
      "role": {
        "execution": ["执行会话", "Execution"],
        "main": ["主会话", "Main"],
        "memory": ["Memory", "Memory"],
        "session-manager": ["管理", "Management"]
      },
      "share": {
        "partial": ["已报告部分占比", "Share of reported usage only"],
        "reported": ["已报告用量占比", "Share of reported usage"],
        "unattributed": ["来源未完全对应，暂无占比。","Source totals do not match; shares are unavailable."],
        "unavailable": ["总量未知，暂无占比。","Total unknown; shares are unavailable."],
        "zero": ["总量为 0，暂无占比。","Total is 0; shares are unavailable."]
      },
      "summary": ["当前范围已采集用量", "Collected usage in the current scope"],
      "title": ["用量摘要", "Usage summary"],
      "uncollected": ["未采集", "Not collected"]
    }
  },
  "p5": {
    "mainWelcome": {
      "description": ["这里是项目主会话，用来讨论目标、安排执行会话和汇总进展。", "This is your project’s main conversation. Discuss goals, coordinate execution conversations, and bring progress together here."]
    },
    "model": {
      "settingsOperationFailed": ["模型配置操作未完成，请重新读取并核对当前选择。", "The model settings operation did not complete. Reload and check the current selection."],
      "disconnected": ["连接已断开，模型配置暂不可修改。","Disconnected. Model settings cannot be changed right now."],
      "loadingMainSettings": ["正在读取主会话模型配置…","Loading main session model settings…"],
      "mainModel": ["主会话模型","Main session model"],
      "settingsNotLoaded": ["尚未加载模型配置","Model settings have not loaded yet"],
      "reasoningEffort": ["思考强度","Reasoning effort"],
      "mainReasoningEffort": ["主会话思考强度","Main session reasoning effort"],
      "providerDefault": ["提供方默认","Provider default"],
      "reasoningEffortPrefix": ["思考强度：","Reasoning effort: "],
      "loadingDirectory": ["正在读取模型目录…","Loading model directory…"],
      "savingSettings": ["模型配置正在保存…","Saving model settings…"],
      "savedModelUnavailable": ["已保存的模型当前不可用，请从可用目录选择。","The saved model is currently unavailable. Choose one from the available models."],
      "retrySettings": ["重试读取模型配置","Retry loading model settings"],
      "mainSettingsUnreadable": ["主会话模型配置当前不可读取。","The main session model settings cannot be read right now."],
      "originalSelectionUnavailable": ["原会话没有已确认的模型选择。","The original conversation has no confirmed model selection."],
      "readOnlySelection": ["{provider} / {model} · 只读","{provider} / {model} · Read-only"]
    },
    "common": {
      "currentlyUnavailable": ["（当前不可用）"," (currently unavailable)"],
      "hide": ["收起","Hide"],
      "temporarilyUnreadableSuffix": [" · 暂时无法读取"," · Cannot read right now"],
      "rename": ["改名","Rename"],
      "refresh": ["刷新","Refresh"],
      "unknown": ["未知","Unknown"],
      "punctuationTemplate1": ["（{value}）"," ({value})"],
      "colon": ["：",": "],
      "punctuationTemplate2": ["{value}：{value1}","{value}: {value1}"],
      "listSeparator": ["、",", "],
      "punctuationTemplate3": ["）。",")."],
      "period": ["。","."],
      "closeParenthesis": ["）",")"],
      "semicolon": ["；","; "],
      "punctuationTemplate4": ["{value}（{value1}{value2}）","{value} ({value1}{value2})"],
      "punctuationTemplate5": ["Cron：{value}（{value1}）","Cron: {value} ({value1})"],
      "punctuationTemplate6": ["{value}{value1}。{value2}","{value} {value1}. {value2}"],
      "sentenceBoundary": [""," "]
    },
    "settings": {
      "simple": {
        "recheck": ["重新核对","Check saved value"],
        "rechecking": ["正在核对…","Checking…"],
        "recheckFailed": ["暂时无法核对已保存内容，请稍后重试核对。","Couldn't check the saved value. Try checking again later."],
        "basics": ["基础信息","Basic information"],
        "models": ["模型","Models"],
        "mainModel": ["主会话","Main session"],
        "mainModelScope": ["当前主会话使用的模型","Model used by the current main session"],
        "executionModel": ["新执行会话","New execution sessions"],
        "executionModelScope": ["仅用于新执行会话","Applies to new execution sessions"],
        "workspaceHelp": ["留空使用项目目录；仅用于新会话。","Leave blank to use the project directory. Applies to new conversations."],
        "autosave": ["修改后自动保存","Changes save automatically"],
        "saved": ["已保存","Saved"],
        "retry": ["重试保存","Retry save"],
        "location": ["实际工作位置","Working directory"],
        "locationHelp": ["只读；修改默认工作区不会迁移已有会话。","Read only. Changing the default workspace does not move existing conversations."],
        "workspaceSubmittedSaved": ["上次提交已保存；当前修改未保存。","Previous submission saved; current changes are unsaved."],
      },
      "navigation": {
        "busy": ["当前设置正在读取或保存，请稍候再切换或关闭。","Settings are being loaded or saved. Please wait before switching or closing."]
      },
      "workspace": {
        "checked": ["当前已保存工作区：{value}；输入内容仍未保存。","Saved workspace: {value}. Your current input is still unsaved."],
        "saved": ["默认工作区已保存；只供之后新建会话采用。本次没有启动了解或工作，已有会话与文件保留原位置。","Default workspace saved for conversations created from now on. This did not start any exploration or work. Existing conversations and files remain in their original locations."],
        "conflict": ["项目已被其它窗口修改。当前默认工作区：{value}；你的输入已保留，请核对后重新保存。","Another window has modified this project. Current default workspace: {value}. Your input has been kept. Please review it and save again."],
        "saveUnconfirmed": ["默认工作区保存结果未确认，内容可能已更新；你的输入已保留，请刷新核对。","The default workspace save result is unconfirmed; it may have been updated. Your input has been kept. Refresh to check."],
        "saveFailed": ["默认工作区保存失败，未报告成功。","Failed to save the default workspace. Success was not reported."]
      },
      "name": {
        "checked": ["当前已保存名称：{value}；输入内容仍未保存。","Saved name: {value}. Your current input is still unsaved."],
        "required": ["项目名称不能为空。","Project name cannot be empty."],
        "saved": ["项目名称已保存。","Project name saved."],
        "submittedSaved": ["提交的项目名称已保存；之后输入的名称仍未保存。","The submitted project name was saved. Changes entered afterward are still unsaved."],
        "conflict": ["项目已被其它窗口修改。当前名称：「{value}」；你的输入已保留，请核对后重新保存。","Another window has modified this project. Current name: “{value}”. Your input has been kept. Please review it and save again."],
        "saveUnconfirmed": ["项目名称保存结果未确认，内容可能已更新；你的输入已保留，请刷新核对。","The project name save result is unconfirmed; it may have been updated. Your input has been kept. Refresh to check."],
        "saveFailed": ["项目名称保存失败，未报告成功。","Failed to save the project name. Success was not reported."]
      },
      "location": {
        "wrongConversation": ["工作位置不属于当前会话。","The working location does not belong to the current conversation."],
        "unreadable": ["实际工作位置当前无法读取。","The actual working location cannot be read right now."]
      },
      "execution": {
        "defaultsWrongProject": ["默认配置不属于当前项目。","The default configuration does not belong to the current project."],
        "modelUnavailable": ["所选模型当前不在可用目录中；已保存配置保留。", "The selected model is not currently available. The saved configuration is retained."],
        "reasoningUnavailable": ["所选思考强度当前不受该模型支持；已保存配置保留。", "The selected reasoning effort is not supported by this model. The saved configuration is retained."],
        "saveUnavailable": ["所选模型或思考强度当前不可用，未替换已保存配置。", "The selected model or reasoning effort is currently unavailable. The saved configuration was not replaced."],
        "saveFailed": ["本次保存未完成，当前选择已保留。请先刷新核对已保存配置。", "This save did not complete. Your selection is retained. Refresh and check the saved configuration first."],
        "inheritDsh": ["沿用 DSH 默认","Use DSH defaults"],
        "resultWrongProject": ["返回配置不属于当前项目。","The returned configuration does not belong to the current project."],
        "saved": ["已保存新执行会话默认；之后新建时采用，已有会话继续使用各自配置。","Defaults for new execution conversations saved. They apply to conversations created from now on. Existing conversations keep their own configurations."],
        "submittedSaved": ["提交的默认配置已保存；之后的选择仍未保存。","The submitted default configuration was saved. Selections made afterward are still unsaved."],
        "conflict": ["默认配置已被修改；当前已保存值在下方，你的选择已保留，请核对后重新保存。","The default configuration has changed. The current saved values are shown below. Your selections have been kept. Please review them and save again."],
        "title": ["新执行会话默认模型","Default model for new execution conversations"],
        "scope": ["只作用于本项目之后新建的执行会话；已有会话保留各自配置。","Applies only to execution conversations created in this project from now on. Existing conversations keep their own configurations."],
        "edit": ["编辑新建默认模型","Edit default model for new conversations"],
        "inheritHelp": ["未设置时沿用 DSH 的既有默认；保存和刷新不会启动模型。","When unset, the existing DSH defaults apply. Saving and refreshing do not start a model."],
        "catalogUnavailable": ["模型目录当前不可用","Model catalog is currently unavailable"],
        "savedUnavailable": ["已保存默认当前不可用","Saved defaults are currently unavailable"],
        "savedLabel": ["当前已保存的新建默认","Currently saved defaults for new conversations"],
        "loading": ["正在读取新建默认…","Loading defaults for new conversations…"],
        "modelField": ["模型","Model"],
        "modelLabel": ["默认模型","Default model"],
        "reasoning": ["思考强度","Reasoning effort"],
        "inheritModel": ["沿模型自身默认","Use model defaults"],
        "unsupportedSuffix": ["（当前不支持）"," (currently unsupported)"],
        "save": ["保存执行默认","Save execution defaults"],
        "refresh": ["刷新模型目录与配置","Refresh model catalog and configuration"]
      },
      "savedRevisionPrefix": ["当前已保存（修订","Currently saved (revision "],
      "instructions": {
        "readUnavailable": ["暂时无法读取{value}指令，请稍后重新读取。", "Could not load {value} instructions right now. Try reloading them later."],
        "saveUnconfirmed": ["本次{value}指令保存结果尚未确认，当前输入已保留。请重新读取并核对已保存内容。", "The result of saving {value} instructions is unconfirmed. Your input is retained. Reload and check the saved content."],
        "timing": ["之后准备的请求会带上已保存要求；已经发出的请求不改写。","Requests prepared from now on will include the saved requirements. Requests already sent will not be rewritten."],
        "wrongScope": ["指令不属于当前项目或会话。","The instructions do not belong to the current project or conversation."],
        "readFailed": ["{value}指令读取失败：","Failed to load {value} instructions: "],
        "notSaved": ["未保存{value}指令：","{value} instructions were not saved: "],
        "conflict": ["{value}指令已被修改；当前已保存正文在下方，你的输入已保留，请核对后重新保存。","{value} instructions have changed. The current saved text is shown below. Your input has been kept. Please review it and save again."],
        "clearedPrefix": ["已清空","Cleared"],
        "conversationPersistent": ["本会话持续指令","persistent instructions for this conversation"],
        "submittedSaved": ["提交的{value}指令已保存；之后输入的正文仍未保存。","The submitted {value} instructions were saved. Text entered afterward is still unsaved."],
        "conversationTitle": ["会话指令","Conversation instructions"],
        "conversationLabel": ["单会话持续指令","Instructions for a single conversation"],
        "projectDescription": ["介绍项目用途、目标，以及主会话与执行会话共同遵守的要求。","Describe the project’s purpose, goals, and requirements shared by its main and execution conversations."],
        "conversationDescription": ["补充「{value}」的具体分工和要求。","Add specific responsibilities and requirements for “{value}”."],
        "editShared": ["编辑项目说明与要求","Edit project description and requirements"],
        "editConversation": ["编辑会话指令","Edit conversation instructions"],
        "savedLabel": ["当前已保存的{value}指令","Currently saved {value} instructions"],
        "projectEmpty": ["当前没有保存项目说明与要求。","No project description and requirements are currently saved."],
        "conversationEmpty": ["这个会话当前没有保存单独指令。","No separate instructions are currently saved for this conversation."],
        "textNotLoaded": ["当前正文尚未取得。","The current text has not been retrieved yet."],
        "projectField": projectInstructionsCopy,
        "conversationField": ["本会话指令","Instructions for this conversation"],
        "saveProject": ["保存项目说明与要求","Save project description and requirements"],
        "saveConversation": ["保存会话指令","Save conversation instructions"],
        "clearSave": ["清空并保存","Clear and save"],
        "reloadProject": ["重新读取项目说明与要求","Reload project description and requirements"],
        "reloadConversation": ["重新读取会话指令","Reload conversation instructions"],
        "scopeTitle": ["作用范围与生效方式","Scope and when changes apply"],
        "scopeHelp": ["项目要求与所选会话指令共同生效。内置职责、边界和工作标准不能覆盖；清空仅移除用户补充，不改变会话身份或工具许可。","Project requirements and the selected conversation’s instructions apply together. Built-in responsibilities, boundaries and standards cannot be overridden. Clearing removes only your additions; conversation identity and tool permissions are unchanged."],
        "noModelStart": ["保存、替换和清空不会启动模型或发送消息。","Saving, replacing, and clearing do not start a model or send messages. "]
      },
      "metadataUnconfirmed": ["保存结果未确认，内容可能已更新；当前输入已保留，请刷新核实后再决定是否保存。","Save result unconfirmed; the content may have changed. Your input is retained. Refresh and verify before deciding whether to save again."]
    },
    "panel": {
      "sourceOpenFailed": ["暂时无法打开这条来源，请稍后重试。", "This source could not be opened right now. Try again later."],
      "returnConversationFailed": ["暂时无法返回原会话。当前阅读内容仍保留，请稍后重试。", "The original conversation could not be reopened right now. Your current reading is still available. Try again later."],
      "connectingConversation": ["正在接入项目会话…","Connecting the project session…"],
      "conversationConnectionUnavailable": ["当前无法接入项目会话","The project conversation is unavailable"],
      "conversationConnectionRecovery": ["此处暂时无法输入。请保留未发送的内容，再返回项目列表重新打开；这不会自动重放或续跑任务。","Input is unavailable here. Keep any unsent content, then return to the project list and reopen the project. Tasks will not be replayed or resumed automatically."],
      "errorDetails": ["查看完整错误详情","View full error details"],
      "conversationConnectionFailed": ["项目会话接入失败：{value}","Could not connect the project session: {value}"],
      "lifecycleResults": ["项目生命周期实际结果","Actual project lifecycle results"],
      "lifecycleOperationPrefix": ["本次处理：","This operation: "],
      "lifecycleCheckSchedules": ["检查定时设置","Check schedule settings"],
      "lifecycleConfirmSessionScope": ["确认会话范围","Confirm session scope"],
      "lifecycleStopWork": ["停止当前工作","Stop current work"],
      "lifecycleRecheckSchedules": ["再次检查定时设置","Check schedule settings again"],
      "lifecycleSaveArchive": ["保存归档状态","Save archive state"],
      "lifecyclePrepareRestore": ["准备恢复项目","Prepare to restore the project"],
      "lifecycleSaveRestore": ["保存恢复状态","Save restore state"],
      "lifecycleWorkStoppedSaved": ["当前工作已停止并保存","Current work has stopped and been saved"],
      "lifecycleNoRunningSession": ["当前没有运行中的会话","No session is currently running"],
      "lifecyclePreviouslyArchived": ["此前已单独归档","Previously archived separately"],
      "lifecycleStopUnconfirmed": ["当前停止结果未确认","The current stop result is unconfirmed"],
      "lifecycleNotStopped": ["本次没有停止该会话","This session was not stopped in this operation"],
      "executionNameRequired": ["执行会话名称不能为空。","The execution session name cannot be empty."],
      "nameSaveUnconfirmed": ["名称保存结果未确认，请核对后再操作。","The name save result is unconfirmed. Verify it before continuing."],
      "stateUnreadableCompletionUnconfirmed": ["当前状态不可读，尚未确认处理完成。","The current state cannot be read; completion is unconfirmed."],
      "projectStateUnreadableCompletionUnconfirmed": ["当前项目状态不可读，尚未确认处理完成。","The current project state cannot be read; completion is unconfirmed."],
      "originalSessionUnavailable": ["原会话当前不可用；文件仍可阅读。","The original session is currently unavailable; the file can still be read."],
      "readingContextEnded": ["原会话阅读上下文已结束，请从原会话重新打开文件。","The original session’s reading context has ended. Reopen the file from that session."],
      "checkingSource": ["正在核对来源","Checking the source"],
      "aboutReadFile": ["关于刚才阅读的文件","About the file just read"],
      "hideReadingHint": ["收起此会话阅读线索","Hide this session’s reading hint"],
      "referencedFile": ["引用文件","Referenced file"],
      "projectDeletionResults": ["项目删除结果","Project deletion results"],
      "renameExecutionSession": ["执行会话改名","Rename execution session"],
      "cancelRename": ["取消改名","Cancel rename"],
      "executionSessionName": ["执行会话名称","Execution session name"],
      "saveSessionName": ["保存会话名称","Save session name"],
      "continueProjectRestore": ["继续恢复项目","Continue restoring project"],
      "restoreProject": ["恢复项目","Restore project"],
      "archiveProject": ["归档项目","Archive project"],
      "mainModelUnknownReadOnly": ["主会话模型未知，尚未就绪；当前聊天只读。","The main session model is unknown and not ready; this chat is read-only."],
      "sessionActions": ["会话操作","Session actions"],
      "continueExecutionRestore": ["继续恢复执行会话","Continue restoring execution session"],
      "restoreExecution": ["恢复执行会话","Restore execution session"],
      "archiveExecution": ["归档执行会话","Archive execution session"],
      "executionModelUnknownReadOnly": ["执行会话模型未知，尚未就绪；当前聊天只读。","The execution session model is unknown and not ready; this chat is read-only."],
      "processingExecution": ["正在处理该执行会话，请等待实际结果…","Processing this execution session. Please wait for the actual result…"],
      "legacyDeletionTimestamp": ["保留时间来自旧整项目删除边界；这一段的实际删除时间未知。","The retained timestamp comes from the legacy whole-project deletion boundary; the actual deletion time of this segment is unknown."],
      "originalPanelLeft": ["原项目面板已离开。","The original project panel is no longer active."]
    },
    "schedule": {
      "oneTimeDelayDurationSummary": ["延后一次：{amount} {unit}（{timeZone}）","One-time delay: {amount} {unit} ({timeZone})"],
      "fixedIntervalDurationSummary": ["固定间隔：每 {amount} {unit}（{timeZone}）","Fixed interval: every {amount} {unit} ({timeZone})"],
      "delayAmount": ["延迟时长","Delay"],
      "intervalAmount": ["重复间隔","Interval"],
      "durationUnit": ["单位","Unit"],
      "durationSeconds": ["秒","Seconds"],
      "durationMinutes": ["分钟","Minutes"],
      "durationHours": ["小时","Hours"],
      "durationDays": ["天","Days"],
      "returnedProjectMismatch": ["返回的计划不属于当前项目。","The returned schedule does not belong to the current project."],
      "invalidCron": ["Cron表达式的字段或取值无效。请使用五段表达式：分、时、日、月、星期；可用数字、*、范围、步长和逗号列表。", "The Cron fields or values are invalid. Use five fields: minute, hour, day of month, month, and day of week; numbers, *, ranges, steps, and comma-separated lists are supported."],
      "invalidTimeZone": ["请输入UTC或有效的IANA时区，例如Asia/Taipei。", "Enter UTC or a valid IANA time zone, such as Asia/Taipei."],
      "invalidDateTime": ["请输入所选时区内实际存在的日期和时间。", "Enter a date and time that exists in the selected time zone."],
      "futureDateRequired": ["日期和时间必须晚于当前时间。", "The date and time must be later than the current time."],
      "noNextTime": ["该规则没有可表示的下次执行时间，请调整日期或规则。", "This rule has no representable next execution time. Adjust the date or rule."],
      "minimumInterval": ["固定间隔至少为60秒。", "The fixed interval must be at least 60 seconds."],
      "invalidTitle": ["请输入有效的计划标题，最多120个字符。", "Enter a valid schedule title, up to 120 characters."],
      "invalidRule": ["执行规则无效，请检查此处的输入。", "The execution rule is invalid. Check this input."],
      "operationUnconfirmedPrefix": ["操作结果未确认：","Operation result unconfirmed: "],
      "verifySettingsSuffix": ["。请刷新设置并打开原会话核实。",". Refresh the settings and open the original session to verify."],
      "settingsSaved": ["设置已保存。","Settings saved."],
      "submittingRun": ["正在提交本次运行请求…","Submitting this run request…"],
      "returnedRequestMismatch": ["返回的运行结果不属于本次请求","The returned run result does not belong to this request"],
      "changedBeforeRun": ["计划已变化，请查看刷新后的内容，再决定是否运行。","The schedule has changed. Review the refreshed content before deciding whether to run it."],
      "runUnconfirmedPrefix": ["本次运行结果未确认：","This run's result is unconfirmed: "],
      "checkBeforeRetrySuffix": ["。请先打开原会话查看，避免重复发起。",". Open the original session first to avoid submitting it again."],
      "editCancelled": ["已取消本次编辑，原安排未修改。","Editing cancelled. The original schedule is unchanged."],
      "settings": ["计划设置","Schedule settings"],
      "arrangements": ["定时安排","Schedules"],
      "originalSessionExplanation": ["计划唤醒原会话；具体交流与成果仍在原会话中。","Schedules wake the original session; conversations and results remain in that session."],
      "refresh": ["刷新计划","Refresh schedules"],
      "loading": ["正在读取计划…","Loading schedules…"],
      "readFailed": ["计划读取失败：{value}。","Failed to load schedules: {value}."],
      "draftRetained": ["未保存草稿仍保留，请重新读取后继续。","Your unsaved draft is retained. Reload to continue."],
      "settingsReceipt": ["设置操作回执","Settings operation receipt"],
      "notFullyConfirmed": ["未完全确认","Not fully confirmed"],
      "projectSchedules": ["项目定时计划","Project schedules"],
      "add": ["新增计划","Add schedule"],
      "savedEnabledPrefix": ["设置已保存（计划已","Settings saved (schedule "],
      "enabledFragment": ["启用","enabled"],
      "disabledFragment": ["停用","disabled"],
      "noManageableTarget": ["当前没有可管理的会话目标，不能创建计划。","There are currently no manageable session targets, so a schedule cannot be created."],
      "details": ["计划详情","Schedule details"],
      "removed": ["已移除的计划","Removed schedule"],
      "select": ["选择一条计划","Select a schedule"],
      "belongsToPrefix": ["所属：","Belongs to: "],
      "removedExplanation": ["计划设置已移除，不再按旧设置触发；原会话的运行记录保留。","Schedule settings removed; they no longer trigger. Run records remain with the original conversation."],
      "futureArrangements": ["以后安排","Future schedule"],
      "disableEffects": ["停用仅调整尚未开始的对应输入，结果见操作回执；已开始的本轮请在原会话停止。","Disabling adjusts only corresponding inputs that have not started; see the operation receipt. Use Stop in the original conversation for an active turn."],
      "taskContent": ["任务内容","Task content"],
      "sourcesAndUpdates": ["设置来源与更新时间","Settings sources and update times"],
      "createdAtPrefix": ["创建于","Created at "],
      "updatedAtFragment": ["；最近更新于","; last updated at "],
      "revisionFragment": ["；修订","; revision "],
      "lastEnabledPrefix": ["最近启用设置：","Settings last enabled at: "],
      "notStartedSuffix": ["；不代表已开始运行。","; this does not mean a run has started."],
      "creationSources": ["创建时的来源","Sources at creation"],
      "updateSources": ["最近更新的来源","Sources of the latest update"],
      "removeEffects": ["移除只删除定时设置，原会话及既有运行记录保留。","Removing only deletes the schedule settings. The original session and existing run records are retained."],
      "selectOrAdd": ["从左侧选择一条计划，或新增计划。","Select a schedule on the left, or add one."],
      "edit": ["编辑计划","Edit schedule"],
      "unsavedChanges": ["这条计划有尚未保存的修改","This schedule has unsaved changes"],
      "unsavedNavigationDescription": ["可继续编辑，或放弃这次草稿后查看其它内容。","Continue editing, or discard this draft to view other content."],
      "discardAndContinue": ["放弃草稿并继续","Discard draft and continue"],
      "projectMismatch": ["计划不属于当前项目","The schedule does not belong to the current project"],
      "unavailablePrefix": ["定时任务当前无法读取：","Scheduled tasks cannot currently be loaded: "],
      "overview": ["定时任务概览","Scheduled task overview"],
      "refreshArrangements": ["刷新定时安排","Refresh schedules"],
      "session": ["所属会话","Session"],
      "scheduledTaskSession": ["定时任务所属会话","Scheduled task's session"],
      "allSessions": ["全部会话","All sessions"],
      "automaticStatus": ["自动执行状态","Automatic execution status"],
      "requirements": ["运行条件","Run requirements"],
      "requirementsDescription": ["自动执行需本机唤醒，DSH、本地服务、模型和工具可用，项目与目标会话未归档；启用不保证运行成功。","Automatic runs need an awake computer, available DSH, local service, model, and tools, and an unarchived project and target conversation. Enabling does not guarantee success."],
      "retryPolicy": ["错过不补跑，失败不自动重试；准备未结束的同一次触发沿原记录继续，不新建运行。","Missed runs are not made up; failures are not retried automatically. An unfinished trigger continues preparation under its original record without creating a new run."],
      "archivedProjectEffects": ["项目已归档，仍可编辑、保存和启停计划；“现在运行”不可用，恢复后仅触发未来计划，不补跑。","Project archived. Schedules remain editable and can be saved, enabled, or disabled. Run now is unavailable. After restoration, only future schedules can trigger; missed runs are not made up."],
      "noRunsShort": ["尚无运行记录","No run records yet"],
      "noSchedules": ["这个会话尚无定时计划。","This session has no schedules yet."],
      "removedHistoryPrefix": ["已移除设置的运行历史（","Run history for removed settings ("],
      "originalSessionUnavailable": ["原会话当前不可用","The original session is currently unavailable"],
      "archivedTriggerEffects": ["归档期间不触发，启停设置保留；恢复后仅触发未来计划。","No triggers while archived; enabled/disabled settings are retained. Only future schedules can trigger after restoration."],
      "sessionTriggerUnconfirmed": ["所属会话当前不可用，不能确认未来触发。","The associated session is currently unavailable; future triggers cannot be confirmed."],
      "futureTriggersDisabled": ["未来触发已停用。","Future triggers are disabled."],
      "nextRun": ["下次计划","Next scheduled run"],
      "timeNotReturned": ["时间未返回","Time not returned"],
      "oneTimeExpiredShort": ["单次时刻已过；不自动补跑","The one-time scheduled time has passed; no automatic catch-up run"],
      "noFutureTimesShort": ["已无后续时间","No future times remain"],
      "nextRunPreview": ["下次计划（预览）","Next scheduled run (preview)"],
      "nextTimeNotReturned": ["服务未返回下次未来时间。","The service did not return the next future time."],
      "oneTimeExpired": ["单次计划已过期，不自动补跑；是否运行请查看记录。","One-time schedule expired; no automatic catch-up run. Check the run records to see whether it ran."],
      "noFutureTimes": ["这条计划已无后续时间。","This schedule has no future times remaining."],
      "enabled": ["已启用","Enabled"],
      "disabled": ["已停用","Disabled"],
      "noSourceLocation": ["未提供来源定位。","No source location was provided."],
      "viewRunSource": ["查看本次运行来源","View this run's source"],
      "viewSourceNumber": ["查看{value} {value1}","View {value} {value1}"],
      "inputMessage": ["输入消息","input message"],
      "toolCall": ["工具调用","tool call"],
      "openOriginalSession": ["打开原会话","Open original session"],
      "noDirectRunSource": ["无可直接定位的消息或工具来源，请查看原会话。","No directly locatable message or tool source; open the original conversation."],
      "admissionReceipt": ["本次请求接纳回执","Request admission receipt"],
      "admissionReceiptDescription": ["提交时的接纳与保存结果；当前进度见运行记录。","Admission and save results at submission time. See run records for current progress."],
      "runLinkSavedPrefix": ["提交时运行关联的保存：","Run link saved at submission: "],
      "sessionInputSavedFragment": ["；原会话输入的保存：","; original session input saved: "],
      "requestTimePrefix": ["请求时间：","Request time: "],
      "taskOutcomeUnconfirmed": ["任务结果未确认；请到原会话查看过程与成果。","Task outcome unconfirmed; check progress and results in the original conversation."],
      "manualRun": ["手动运行","Manual run"],
      "automaticSchedule": ["自动计划","Automatic schedule"],
      "runLinksAndStatus": ["运行关联与状态","Run links and status"],
      "noRuns": ["尚无运行记录。","No run records yet."],
      "runHistoryExplanation": ["排队、处理中或本轮结束不等于任务达成；移除计划仍保留运行记录。","Queued, processing, or turn ended does not confirm task success. Run records remain after schedule removal."],
      "unstartedInputCancelled": ["尚未开始的输入已取消","Input that had not started was cancelled"],
      "turnEnded": ["本轮已结束；任务结果请查看原会话","This turn has ended; check the original session for the task outcome"],
      "originalTargetUnavailable": ["原目标当前不可用","The original target is currently unavailable"],
      "targetAndSaveExplanation": ["目标来自当前可管理会话。保存不会立即调用模型。","Targets come from the sessions you can currently manage. Saving does not immediately call the model."],
      "sessionPrefix": ["所属会话：","Session: "],
      "sessionUnchangedSuffix": ["。编辑不会更换所属会话。",". Editing does not change the associated session."],
      "name": ["计划名称","Schedule name"],
      "taskForOriginalSession": ["送给原会话的任务内容","Task content to send to the original session"],
      "enableFutureTriggers": ["启用未来触发","Enable future triggers"],
      "editEffects": ["只调整尚未开始的对应输入；已开始的本轮请在原会话停止。","Edits adjust only corresponding inputs that have not started. Use Stop in the original conversation for an active turn."],
      "rules": ["计划规则","Schedule rules"],
      "executionRules": ["执行规则","Execution rules"],
      "ruleType": ["规则类型","Rule type"],
      "specificDateTime": ["指定日期和时间","Specific date and time"],
      "oneTimeDelay": ["延后一次","One-time delay"],
      "fixedInterval": ["固定间隔","Fixed interval"],
      "daily": ["每天","Daily"],
      "weekly": ["每周","Weekly"],
      "cronExpression": ["Cron 表达式","Cron expression"],
      "date": ["日期","Date"],
      "delaySeconds": ["延后秒数","Delay in seconds"],
      "intervalSeconds": ["间隔秒数","Interval in seconds"],
      "weekdays": ["星期","Days of the week"],
      "timeZone": ["时区","Time zone"],
      "timeZoneExample": ["例如 Asia/Taipei","For example, Asia/Taipei"],
      "timeZoneExplanation": ["时间按填写的时区计算。","Times are calculated in the time zone you enter."],
      "timeInputHelp": ["时间填写说明","Time input help"],
      "timeInputExplanation": ["时间会按 HH:mm:ss 保存；已有的 1–3 位毫秒会保留。日期和时间只按输入文本传递，不会在浏览器转换成 UTC。","Times are saved as HH:mm:ss; existing 1–3 fractional-second digits are preserved. Dates and times are passed as entered text and are not converted to UTC in the browser."],
      "time": ["时间","Time"],
      "titleRequired": ["请输入计划标题。","Enter a schedule title."],
      "promptRequired": ["请输入提示词。","Enter a prompt."],
      "timeZoneRequired": ["请输入时区。","Enter a time zone."],
      "dateRequired": ["请输入日期。","Enter a date."],
      "weekdayRequired": ["每周计划至少选择一天。","Select at least one day for a weekly schedule."],
      "cronRequired": ["请输入 Cron 表达式。","Enter a Cron expression."],
      "timeFormatRequired": ["时间请使用 HH:mm、HH:mm:ss 或 HH:mm:ss.fff。","Use HH:mm, HH:mm:ss, or HH:mm:ss.fff for the time."],
      "timeOutOfRange": ["时间不在有效范围内。","The time is outside the valid range."],
      "positiveIntegerRequired": ["{value}必须是正整数。","{value} must be a positive integer."],
      "notConnected": ["尚未接入","Not connected yet"],
      "availableAtLastCheck": ["最近检查可用","Available at the last check"],
      "unavailableAtLastCheck": ["最近检查本机不可用","Unavailable on this computer at the last check"],
      "localAvailabilityUnconfirmed": ["本机可用性尚未确认","Availability on this computer is not yet confirmed"],
      "connected": ["已接通","Connected"],
      "checkedAt": ["检查时间 {value}","Checked at {value}"],
      "removedHistoryRetained": ["设置已移除，运行历史仍保留。","Settings removed. Run history is retained."],
      "settingsUnchanged": ["设置未更改。","Settings unchanged."],
      "saveUnconfirmed": ["设置是否保存尚未确认。","Whether the settings were saved is not yet confirmed."],
      "pendingContentUpdated": ["尚未开始的运行内容已更新","Content for runs that have not started has been updated"],
      "pendingRunCancelled": ["对应待执行运行已取消","The corresponding pending run has been cancelled"],
      "pendingInputsChecked": ["待执行输入已按当前设置核对。","Pending inputs have been checked against the current settings."],
      "noPendingAdjustments": ["没有需要调整的待执行输入。","No pending inputs need adjustment."],
      "pendingAdjustmentsUnconfirmed": ["待执行输入的调整未完全确认，请打开原会话核实。","Adjustments to pending inputs are not fully confirmed. Open the original session to verify."],
      "pendingInputsProcessed": ["待执行输入已按当前设置处理。","Pending inputs have been processed according to the current settings."],
      "pendingAdjustmentNotConnected": ["待执行输入调整尚未接通，不能确认排队内容已更新或取消。","Pending input adjustment is not connected yet. It cannot be confirmed whether queued content has been updated or cancelled."],
      "pendingChangesSaveUnconfirmed": ["待执行修改的保存尚未确认。","Saving changes to pending inputs is not yet confirmed."],
      "operationIncompletePrefix": ["操作未全部完成：","The operation was not fully completed: "],
      "activeWorkUnaffected": ["此操作不会停止已开始的工作；自动执行状态见最近检查。","This operation does not stop active work. See the latest check for automatic execution status."],
      "changedAtSubmission": ["提交时计划已变化，本次未按旧内容运行。","The schedule had changed at submission time. This request did not run with the old content."],
      "enqueueConfirmedAtSubmission": ["提交时已确认本次请求入队。","This request was confirmed queued at submission time."],
      "notEnqueuedAtSubmission": ["提交时本次请求未入队。","This request was not queued at submission time."],
      "enqueueUnconfirmedAtSubmission": ["提交时本次请求是否入队尚未确认；请先查看原会话，避免重复发起。","Whether this request was queued at submission time is not yet confirmed. Check the original session first to avoid submitting it again."],
      "existingRequest": ["这是同一请求已有的运行记录，没有再次发起。","This is an existing run record for the same request. No new run was initiated."],
      "submissionNotePrefix": ["提交时说明：","Note at submission time: "],
      "unconfirmed": ["尚未确认","Not yet confirmed"],
      "saveNotRequired": ["本次无需保存","No save required for this request"],
      "changedOrMissing": ["计划已变化或不存在，请刷新后再试。","The schedule has changed or no longer exists. Refresh and try again."],
      "updatedElsewhere": ["计划已在其他位置更新，请刷新后再编辑。","The schedule was updated elsewhere. Refresh before editing again."],
      "archivedFragment": ["，已归档",", archived"],
      "specificDateTimeSummary": ["指定日期和时间：{value} {value1}（{value2}）","Specific date and time: {value} {value1} ({value2})"],
      "oneTimeDelaySummary": ["延后一次：{value} 秒（{value1}）","One-time delay: {value} seconds ({value1})"],
      "fixedIntervalSummary": ["固定间隔：每 {value} 秒（{value1}）","Fixed interval: every {value} seconds ({value1})"],
      "dailySummary": ["每天 {value}（{value1}）","Daily at {value} ({value1})"],
      "weeklySummary": ["每周 {value} {value1}（{value2}）","Weekly on {value} at {value1} ({value2})"],
      "originalEvent": ["原始事件 {value} · {value1}","Original event {value} · {value1}"],
      "originalMessage": ["原聊天消息","Original chat message"],
      "originalToolCall": ["原会话工具调用","Original session tool call"],
      "settingsChange": ["项目设置中的修改","Change in project settings"],
      "historicalProjectRecord": ["历史项目记录","Historical project record"],
      "statusUnknown": ["未知，无法判断任务是否达成","Unknown; task success cannot be determined"],
      "statusQueued": ["已排队，不代表任务达成","Queued; this does not confirm task success"],
      "statusProcessing": ["处理中，不代表任务达成","Processing; this does not confirm task success"],
      "statusWaitingPermission": ["等待权限，结果未确认","Waiting for permission; outcome unconfirmed"],
      "statusDeliveryFailed": ["送达失败，不能据此判断任务结果","Delivery failed; the task outcome cannot be determined from this"],
      "statusNotAchieved": ["未达成","Not achieved"],
      "statusAchieved": ["已达成（结果以关联来源为准）","Achieved (see linked sources for the result)"],
      "monday": ["周一","Mon"],
      "tuesday": ["周二","Tue"],
      "wednesday": ["周三","Wed"],
      "thursday": ["周四","Thu"],
      "friday": ["周五","Fri"],
      "saturday": ["周六","Sat"],
      "sunday": ["周日","Sun"]
    },
    "usage": {
      "costNotProvided": ["费用未提供","Cost not provided"],
      "incompleteReports": ["仅含已报告部分；缺报用量未知。","Reported usage only; missing usage is unknown."],
      "projectMismatch": ["返回的用量不属于当前项目。","The returned usage does not belong to this project."],
      "readUnavailable": ["用量暂时无法读取，请刷新重试。未读取的数据不会按零展示。","Usage cannot be read right now. Refresh to retry. Unread data will not be shown as zero."],
      "invalidTimeRange": ["请选择有效时间范围，结束时间须晚于开始时间。","Choose a valid time range. The end must be later than the start."],
      "projectUsage": ["项目用量","Project usage"],
      "model": ["模型","Model"],
      "allModels": ["全部模型","All models"],
      "modelBreakdownUnavailable": ["模型未能拆分","Model breakdown unavailable"],
      "startLocalTime": ["开始（本地时间）","Start (local time)"],
      "startTime": ["开始时间","Start time"],
      "endExclusive": ["结束（不包含）","End (exclusive)"],
      "endTime": ["结束时间","End time"],
      "applyFilters": ["应用筛选","Apply filters"],
      "refresh": ["刷新用量","Refresh usage"],
      "loadingNative": ["正在读取原生用量…","Loading native usage…"],
      "scopeAndReporting": ["统计范围与报告状态","Scope and reporting status"],
      "unknown": ["用量未知","Usage unknown"],
      "partiallyAvailable": ["部分用量可得","Some usage available"],
      "reported": ["已报告用量","Reported usage"],
      "scopePrefix": ["当前范围：","Current scope: "],
      "selectedSession": ["所选会话","Selected session"],
      "projectSources": ["整个项目","Entire project"],
      "selectedModel": ["所选模型","Selected model"],
      "rangeTo": ["至"," to "],
      "endExclusiveSuffix": ["（不含结束时刻）"," (end exclusive)"],
      "readCountPrefix": ["已读取","Read "],
      "nativeSourcesReportedTurns": ["个原生来源； 有已报告用量"," native sources; usage reported for "],
      "reportedTurnsMissingTurns": ["轮；仍有缺报"," turns; reports still missing for "],
      "missingTurnsMissingSources": ["轮（可重叠）； 缺失来源"," turns (may overlap); missing sources: "],
      "unknownTurnCountSuffix": ["个（轮次数未知）。"," (turn count unknown)."],
      "auxiliaryAvailablePrefix": ["辅助压缩记录：用量可得","Auxiliary compaction records: usage available for "],
      "auxiliaryMissingFragment": ["次； 缺报"," requests; missing reports for "],
      "auxiliaryUnknownConsumptionSuffix": ["次（是否产生消耗未知）。"," requests (whether usage occurred is unknown)."],
      "observedTimePrefix": ["已观察的轮次结束或辅助请求报告时间：","Observed turn end or auxiliary request reporting times: "],
      "noAttributableEndTime": ["暂无可归属的结束时间","No attributable end time available"],
      "timeRange": ["{value} 至 {value1}","{value} to {value1}"],
      "costUnknown": ["费用：未知。","Cost: unknown."],
      "bySessionSource": ["按会话","By conversation"],
      "byRequestSource": ["按请求来源","By request source"],
      "byModel": ["按模型","By model"],
      "byUtcDate": ["按日期（UTC）","By date (UTC)"],
      "scopeAndMissingSources": ["统计范围与缺失来源","Scope and missing sources"],
      "availableRecordsCaveat": ["本次未发现不可读会话或缺失轮次；这仅表示当前记录可得，不证明提供方报告覆盖账户的所有消耗。","No unreadable sessions or missing turns were found in this query. This only means the current records are available; it does not prove that provider reports cover all account usage."],
      "partialReportingExplanation": ["分类显示“部分”时，仅汇总已报告该分类的请求；同一轮的已报小计和缺报同时保留；“未知”不等于零。来源不全时，各模型和日期也不能视为完整统计；未知模型或结束时间单列，不分摊。思考属于输出的一部分。","When a category shows “partial,” only requests that reported that category are totaled. Reported subtotals and missing reports from the same turn are both retained; “unknown” does not mean zero. With incomplete sources, model and date totals are also incomplete. Unknown models or end times are listed separately, without allocation. Reasoning is part of output."],
      "sourceReferenceSuffix": ["：来源与累计参考",": sources and cumulative reference"],
      "sourcePrefix": ["来源：","Source: "],
      "currentSessionSnapshot": ["当前会话只读快照","Read-only snapshot of the current session"],
      "historicalSessionSnapshot": ["历史会话只读快照","Read-only snapshot of a historical session"],
      "unreadable": ["不可读取","Cannot be read"],
      "readAtFragment": ["； 读取时间：","; read at: "],
      "latestEventFragment": ["；最新事件：","; latest event: "],
      "unknownOrNoRecord": ["未知或暂无记录","Unknown or no record yet"],
      "excludedCountPrefix": ["。 已排除",". Excluded "],
      "inheritedRecordsSuffix": ["条继承记录。"," inherited records."],
      "childNativeIdentityPrefix": ["子Agent原生身份：","Subagent native identity: "],
      "directParentSourceFragment": ["；直接父来源：","; direct parent source: "],
      "rootCarrierFragment": ["；根承载：","; root carrier: "],
      "createdAtFragment": ["；创建时间：","; created at: "],
      "childAttributionSuffix": ["。此来源归入原逻辑会话，不是新增Project会话。",". This source belongs to the original logical session; it is not an additional Project session."],
      "nativeCumulativeUncachedPrefix": ["原生整个会话累计参考：已记录未缓存输入","Native whole-session cumulative reference: recorded uncached input "],
      "nativeCumulativeOutputFragment": ["， 已记录输出",", recorded output "],
      "nativeCumulativeCaveat": ["。 此参考只含原生助手累计（包括继承历史），不含辅助压缩，未按模型或时间筛选，不加入上述合计。 原生累计不保留缓存缺报与零的区别，因此不据此展示缓存总量或费用。",". This reference includes only native assistant cumulative totals (including inherited history), excludes auxiliary compaction, is not filtered by model or time, and is not added to the totals above. Native cumulative totals do not distinguish missing cache reports from zero, so they are not used to display cache totals or costs."],
      "totalTokens": ["Token 合计","Total tokens"],
      "uncachedInput": ["未缓存输入","Uncached input"],
      "cacheWrite": ["缓存写入","Cache write"],
      "reasoningIncludedInOutput": ["思考（已含于输出）","Reasoning (included in output)"],
      "groupDetails": ["{value}用量明细","{value} usage details"],
      "partialSuffix": ["（部分）"," (partial)"],
      "unbounded": ["不限","Unbounded"],
      "column": {
        "sessionSource": ["会话来源","Conversation source"],
        "requestSource": ["请求来源","Request source"],
        "utcDate": ["日期（UTC）","Date (UTC)"]
      }
    },
    "memory": {
      "savedOutcome": ["正文与索引已同步保存；是否已通知其它会话或被采用，需另行核实。","The body and index have been saved in sync. Whether other sessions were notified or adopted it must be verified separately."],
      "withdrawnOutcome": ["已撤回共享记忆，正文和索引摘要已移除。原聊天和来源文件仍保留。","Shared memory has been withdrawn; its body and index summary were removed. The original chat and source files are retained."],
      "saveFailed": ["未保存成功：{value}","Save unsuccessful: {value}"],
      "partialSave": ["只完成部分保存，不能视为全部成功。","Only part of the save completed; this is not a complete success."],
      "bodyOutcome": ["正文{value}。","Body: {value}."],
      "withdrawalBodyOutcome": ["旧内容已从记忆读取中排除；磁盘正文{value}。","Old content is excluded from memory reads; body on disk: {value}."],
      "notDeleted": ["未删除","Not deleted"],
      "indexOutcome": ["索引{value}。","Index: {value}."],
      "synced": ["已同步","Synced"],
      "notSynced": ["未同步","Not synced"],
      "saveUnconfirmed": ["共享记忆保存结果未确认；内容可能已更新，请保留草稿并重新读取当前内容核对，勿直接重做。","The shared memory save result is unconfirmed; content may have changed. Keep your draft and read the current content again to verify it before retrying."],
      "bodySaveConfirmed": ["正文已确认保存。","The body is confirmed saved."],
      "withdrawalSaveConfirmed": ["撤回标记已确认保存，旧内容已从记忆读取中排除。","The withdrawal marker is confirmed saved; old content is excluded from memory reads."],
      "bodyDeletionConfirmed": ["正文已确认删除。","The body is confirmed deleted."],
      "indexSyncConfirmed": ["索引已确认同步。","The index is confirmed synced."]
    },
    "reading": {
      "originalReadOnly": ["原会话 · 只读","Original conversation · Read-only"],
      "recordedAria": ["原会话记录","Recorded conversation"],
      "subagentAria": ["子会话","Subagent conversation"],
      "continuable": ["可继续","Continuable"],
      "oneShot": ["单次","One-shot"],
      "unknownMode": ["模式未知","Unknown mode"],
      "closeOriginal": ["关闭原会话","Close original conversation"],
      "closeChild": ["关闭子会话","Close child conversation"],
      "originalIdentityUnconfirmed": ["原会话身份尚未确认，不能打开只读聊天。","Original conversation identity is unconfirmed; read-only chat cannot be opened."],
      "sourceIdentityInvalid": ["来源会话身份已失效。","The source conversation identity is no longer valid."]
    },
    "configuration": {
      "refreshFailed": ["配置刷新失败","Configuration refresh failed"],
      "previousConfigurationKept": ["{error} · 继续使用上一份已生效配置。","{error} · Continuing with the previously active configuration."]
    }
  },
  "whole.memory": {
    "bodyError": ["无法读取这份记忆", "Could not read this memory"],
    "retryBody": ["重试读取这份记忆", "Retry reading this memory"],
    "previousBody": ["仍显示上次读取的正文；当前保存内容尚未确认。", "Showing the previously read content; the currently saved content is unconfirmed."],
    "previousList": ["仍显示上次读取的列表；当前列表可能已变化。", "Showing the previously read list; the current list may have changed."],
    "sourceError": ["无法读取此来源", "Could not read this source"],
    "retrySource": ["重试读取此来源", "Retry reading this source"],
    "loadingSource": ["正在读取来源…", "Reading source…"],
    "loadingSourceBody": ["正在读取{label}…", "Reading {label}…"],
    "retrySourceBody": ["重试读取{label}", "Retry reading {label}"]
  },
  "whole.panel": {
    "projectMenu": ["项目「{name}」的操作", "Actions for project {name}"],
    "projectNameRequired": ["请输入项目名称。", "Enter a project name."],
    "projectListPrevious": ["项目列表未能刷新；仍保留此前已读取的结果，当前列表可能已变化。", "The project list could not be refreshed. Previously read results are retained; the current list may have changed."]
  }
} as const;

type Pair = readonly [string, string];
type Catalog = { readonly [key: string]: Pair | Catalog };
type Join<Prefix extends string, Key extends string> = Prefix extends '' ? Key : Key extends '' ? Prefix : `${Prefix}.${Key}`;
type Entry<Data extends Catalog, Language extends 0 | 1, Prefix extends string = ''> = {
  [Key in keyof Data & string]: Data[Key] extends Pair
    ? { key: Join<Prefix, Key>; value: Data[Key][Language] }
    : Data[Key] extends Catalog ? Entry<Data[Key], Language, Join<Prefix, Key>> : never
}[keyof Data & string];
type Dictionary<Language extends 0 | 1> = { readonly [Item in Entry<typeof catalog, Language> as Item['key']]: Item['value'] };
function isPair(value: Pair | Catalog): value is Pair { return Array.isArray(value); }
function dictionaries(): { zh: Dictionary<0>; en: Dictionary<1> } {
  const zh: Record<string, string> = {};
  const en: Record<string, string> = {};
  const visit = (entries: Catalog, prefix: string): void => {
    for (const [key, value] of Object.entries(entries)) {
      const name = prefix === '' ? key : key === '' ? prefix : `${prefix}.${key}`;
      if (isPair(value)) { zh[name] = value[0]; en[name] = value[1]; }
      else visit(value, name);
    }
  };
  visit(catalog, '');
  return { zh: zh as Dictionary<0>, en: en as Dictionary<1> };
}
export const { zh, en } = dictionaries();
export type ProjectsKey = keyof typeof en;
