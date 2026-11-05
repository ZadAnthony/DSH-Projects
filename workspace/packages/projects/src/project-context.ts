/** 当前基础事实和各 owner 正文的运行投影，不持久保存另一份业务上下文。 */
import type { Delivery, Project, ProjectSession, ProjectSessionCarrier, ProjectSnapshot, ProjectWorkSessionRole } from './records-types.ts'
import type { ProjectDeliveryRecord, ProjectDetail, ProjectInvocationInput, ProjectRecord, ProjectSessionRecord } from './public-types.ts'
import type { OverviewContext } from './features/overview/contract.ts'
import { makeReplySessionLink, makeReplySessionMention } from './reply-session-links.ts'

/** Model-facing copyable references, projected from the same real logical record. */
export function projectSessionReplyReference(session: Pick<ProjectSessionRecord, 'id' | 'projectId' | 'title'>): { link: string; mention: string } {
  return { link: makeReplySessionLink(session.projectId, session.id), mention: makeReplySessionMention(session.projectId, session.id, session.title) }
}

/** The same committed snapshot decides both the identity body and its source status. */
export function projectIdentityAvailable(snapshot: ProjectSnapshot | undefined, session: ProjectSession): boolean {
  return identityBinding(snapshot, session) !== undefined
}

function identityBinding(snapshot: ProjectSnapshot | undefined, session: ProjectSession): { session: ProjectSession; status: 'current' | 'historical' | 'prepared' } | undefined {
  if (snapshot === undefined || snapshot.project.id !== session.projectId) return
  const member = snapshot.sessions.find(item => item.id === session.id && item.projectId === session.projectId && item.role === session.role)
  if (member === undefined) return
  if (member.hostSessionId === session.hostSessionId) return { session: member, status: 'current' }
  if (member.carriers?.some(carrier => carrier.hostSessionId === session.hostSessionId)) return { session: member, status: 'historical' }
  if (member.role !== 'main' || snapshot.project.mainSessionId !== member.id || snapshot.project.archived || member.archived
    || snapshot.project.sourceLifecycle !== undefined || member.sourceLifecycle.kind !== 'available') return
  const current = member.carriers?.find(carrier => carrier.isCurrent && carrier.hostSessionId === member.hostSessionId)
  if (current?.header === undefined || current.closed !== undefined || current.sourceLifecycle.kind !== 'available') return
  const header = current.header
  const prepared = member.mainPreparations?.some(row => row.state === 'unpublished' && row.retirement === undefined && row.sourceLifecycle === undefined
    && row.toHostSessionId === session.hostSessionId && row.toHeader?.id === session.hostSessionId
    && row.fromHeader.id === header.id && row.fromHeader.createdAt === header.createdAt && row.fromHeader.version === header.version)
  return prepared ? { session: member, status: 'prepared' } : undefined
}

/** Recorded source disposition is a directory fact, never a receipt that its body was read. */
function mainHistoryIdentity(snapshot: ProjectSnapshot, session: ProjectSession) {
  const sources: readonly ProjectSessionCarrier[] = session.carriers ?? [{ sequence: 1, hostSessionId: session.hostSessionId, isCurrent: true, sourceLifecycle: session.sourceLifecycle }]
  const carriers = sources
    .toSorted((a, b) => a.sequence - b.sequence).map(carrier => ({
      sequence: carrier.sequence, hostSessionId: carrier.hostSessionId, isCurrent: carrier.isCurrent,
      status: carrier.sourceLifecycle.kind,
      ...(carrier.header === undefined ? {} : { sessionCreatedAt: carrier.header.createdAt, formatVersion: carrier.header.version }),
      read: { tool: 'project_history', action: 'search', session_ids: [session.id], host_session_ids: [carrier.hostSessionId] },
    }))
  const current = carriers.find(carrier => carrier.isCurrent && carrier.hostSessionId === session.hostSessionId)
  const previousCarrier = current === undefined ? undefined : carriers.findLast(carrier => carrier.sequence < current.sequence)
  return { projectId: snapshot.project.id, mainSessionId: session.id, currentHostSessionId: session.hostSessionId,
    ...(previousCarrier === undefined ? {} : { previousCarrier }), carriers,
    read: { tool: 'project_history', action: 'search', session_ids: [session.id] },
    statusMeaning: 'Store记录的来源状态；available不表示正文已读取或本次已验证可读。读取失败、部分或删除以真实工具结果为准。' }
}

/** 字段由原 owner 逐项投影；不将聚合记录版本当作每个独立块的变化。 */
export function projectIdentityContext(
  snapshot: ProjectSnapshot | undefined, session: ProjectSession, projectFilesRoot: string,
): string {
  const binding = { projectId: session.projectId, sessionId: session.id, hostSessionId: session.hostSessionId, role: workSessionRole(session) }
  const identity = identityBinding(snapshot, session)
  if (snapshot === undefined || identity === undefined) return [
    'Projects项目身份当前不可读；真实会话绑定仍如下，不能把旧目录或旧项目背景冒充当前。',
    JSON.stringify({ producer: 'projects', binding, status: 'unreadable' }),
  ].join('\n')
  return [
    'Projects系统提供的真实项目归属、默认位置与协作对象；不是用户亲自输入，不产生新决定或授权。defaultWorkspace仅是之后新建会话的默认值，本会话实际cwd由本次运行配置分别提供；无外部工作区时实际cwd为projectFilesRoot。projectFilesRoot始终是项目自有文件区的位置，不保证当前沙箱可写，实际许可以DSH配置和工具结果为准。',
    JSON.stringify({ producer: 'projects', binding, bindingStatus: identity.status, project: {
      id: snapshot.project.id, name: snapshot.project.name, mainSessionId: snapshot.project.mainSessionId,
      ...(snapshot.project.workspace === undefined ? {} : { defaultWorkspace: snapshot.project.workspace.path }),
    }, projectFilesRoot,
    ...(identity.session.role === 'main' ? { mainHistory: mainHistoryIdentity(snapshot, identity.session) } : {}),
    sessions: snapshot.sessions.filter(isWorkSession)
      .filter(item => item.sourceLifecycle.kind === 'available').sort((a, b) => a.id.localeCompare(b.id))
      .map(item => ({ id: item.id, hostSessionId: item.hostSessionId, role: item.role, title: item.title, ...projectSessionReplyReference(item) })) }),
  ].join('\n')
}

/** 实际配置独立于本轮输入和项目读取；配置不授予逐次动作权限。 */
export function projectRuntimeConfigContext(runtimeConditions: Readonly<Record<string, unknown>>): string {
  return [
    'Projects系统提供的本次实际运行配置；工具配置不等于逐次执行能力或动作授权，未列出的运行状态未知。',
    JSON.stringify({ producer: 'projects', runtimeConditions }),
  ].join('\n')
}

/** 只投影真实归档和来源生命周期；不从这些字段推断实时运行或业务完成。 */
export function projectRuntimeLifecycleContext(snapshot: ProjectSnapshot | undefined): string {
  if (snapshot === undefined) return [
    'Projects归档及来源状态的项目owner当前不可读；这不表示项目为空或已停止，不沿用旧状态。',
    JSON.stringify({ producer: 'projects', status: 'unreadable' }),
  ].join('\n')
  return [
    'Projects系统提供的当前归档及来源生命周期；这些记录不表示实时运行状态或业务完成。',
    JSON.stringify({ producer: 'projects',
      project: { id: snapshot.project.id, archived: snapshot.project.archived,
        ...(snapshot.project.sourceLifecycle === undefined ? {} : { sourceLifecycle: snapshot.project.sourceLifecycle }) },
      sessions: snapshot.sessions.filter(isWorkSession).sort((a, b) => a.id.localeCompare(b.id))
        .map(item => ({ id: item.id, archived: item.archived, sourceLifecycle: item.sourceLifecycle })),
    }),
  ].join('\n')
}

/** 展示仍保完整canonical来源事实；不因正文可能重复而缩短失败信息。 */
export function projectInvocationInputsContext(snapshot: ProjectSnapshot | undefined, invocationInputs: readonly ProjectInvocationInput[]): string {
  if (snapshot === undefined) return [
    'Projects本轮输入定位的项目owner当前不可读；这不表示没有来信，不沿用旧来源。',
    JSON.stringify({ producer: 'projects', status: 'unreadable' }),
  ].join('\n')
  return [
    'Projects系统提供的本处理轮真实输入来源，不是用户新决定或新授权。通信结果按消息附带的 operation_ref 或 delivery_id 用 project_read 查询；旧运输观察不代表当前待办、已读或已回信，未列出不表示没有来信。送达、实际入模、回信、业务完成分别判断。',
    '普通user输入的timing仅含已记录的UTC事实：acceptedAt为该消息ID最初接纳时间，不代表每句话或后来编辑的决定时间；claimedAt为本次从Inbox领取并开始准备的时间，不代表消费消息已保存、请求已发出或模型已读／理解。缺失字段未知，不用现在回填；阶段及编辑原文可用project_history核对。',
    JSON.stringify({ producer: 'projects', invocationInputs }),
  ].join('\n')
}

/** 每个已保存看板区块单独供给；顺序是额外的目录说明，不重排普通历史。 */
export function projectOverviewContextParts(context: OverviewContext): readonly { key: string; text: string; status: 'available' | 'unreadable' }[] {
  const prefix = `overview:${context.projectId}:`
  if (context.status === 'unreadable') return [{ key: prefix + 'status', status: 'unreadable',
    text: `项目整体看板当前不可读：${context.message}。不能沿用旧目标或总结冒充当前；这不表示看板为空。` }]
  return [
    { key: prefix + 'order', status: 'available' as const, text: [
      'Projects当前看板区块目录；各区块提供保存正文、原有来源与更新时间，按真实来源、范围与明确变化理解。正文由主会话维护，属于总结，不代替原话或实时状态。来源链接不代表已经重读。移除看板区块不等于撤销用户目标。',
      JSON.stringify({ projectId: context.projectId, status: context.status,
        blockIds: context.document.blocks.map(block => block.id) }),
    ].join('\n') },
    ...context.document.blocks.map(block => ({ key: prefix + `block:${block.id}`, status: 'available' as const,
      text: JSON.stringify({ projectId: context.projectId, block }) })),
  ]
}

export function projectDetail(snapshot: ProjectSnapshot): ProjectDetail {
  return {
    project: projectRecord(snapshot.project),
    sessions: snapshot.sessions.filter(isWorkSession).filter(session => session.sourceLifecycle.kind === 'available'
      && !session.carriers?.some(carrier => carrier.sourceLifecycle.kind === 'deleting' || carrier.sourceLifecycle.kind === 'partial')).map(projectSessionRecord),
    deletionResults: snapshot.sessions.filter(isWorkSession).flatMap(session => (session.carriers ?? [{ hostSessionId: session.hostSessionId, sourceLifecycle: session.sourceLifecycle }])
      .flatMap(carrier => carrier.sourceLifecycle.kind === 'deleting' || carrier.sourceLifecycle.kind === 'partial'
        ? [{id:session.id,projectId:session.projectId,title:session.title,role:session.role,revision:session.revision,hostSessionId:carrier.hostSessionId,sourceLifecycle:carrier.sourceLifecycle,
          ...('lifecycleTimeBasis' in carrier && carrier.lifecycleTimeBasis === 'project-deletion' ? { lifecycleTimeBasis: 'project-deletion' as const } : {})}] : [])),
    unavailableSources: snapshot.sessions.flatMap(session => {
      const carriers = session.carriers ?? [{ hostSessionId: session.hostSessionId, sourceLifecycle: session.sourceLifecycle }]
      const inProgress = carriers.find(carrier => carrier.sourceLifecycle.kind === 'partial' || carrier.sourceLifecycle.kind === 'deleting')
      return carriers.flatMap(carrier => carrier.sourceLifecycle.kind === 'available' ? inProgress === undefined ? []
        : [{hostSessionId:carrier.hostSessionId,kind:'deleting' as const,sourceRevision:session.revision}]
        : [{hostSessionId:carrier.hostSessionId,kind:carrier.sourceLifecycle.kind,sourceRevision:session.revision}])
    }),
    deliveries: snapshot.deliveries.map(projectDeliveryRecord),
  }
}

export function projectRuntimeContext(
  snapshot: ProjectSnapshot | undefined,
  session: ProjectSession,
  invocationInputs: readonly ProjectInvocationInput[] = [],
  projectFilesRoot?: string,
  runtimeConditions?: Readonly<Record<string, unknown>>,
): string {
  const binding = { projectId: session.projectId, sessionId: session.id, hostSessionId: session.hostSessionId, role: workSessionRole(session) }
  const current = snapshot?.sessions.find(item => item.id === session.id && (item.hostSessionId === session.hostSessionId || item.carriers?.some(carrier => carrier.hostSessionId === session.hostSessionId)))
  if (snapshot === undefined || current === undefined) return [
    'Projects产品上下文：项目基础信息当前不可读；这不表示项目为空，不能沿用旧背景冒充当前。',
    JSON.stringify({ contextKind: 'project-core-snapshot', producer: 'projects', binding, status: 'unreadable', runtimeConditions }),
  ].join('\n')
  return [
    '以下是Projects系统提供的当前项目归属、运行条件与实际消息状态，不是用户亲自输入，也不产生新的用户决定或授权。具体经过按需查原聊天，文件读取原件。',
    '运行、送达、实际入模、回信和业务结果是不同事实。通信按 operation_ref 或 delivery_id 查询；旧运输观察不表示当前待办或实际回复。要求按真实来源、适用范围和真正明确的变化理解；适用范围不明时查原文。',
    JSON.stringify({
      contextKind: 'project-core-snapshot', producer: 'projects', binding, project: projectRecord(snapshot.project),
      session: projectSessionRecord(current), sessions: snapshot.sessions.filter(isWorkSession).filter(item => item.sourceLifecycle.kind === 'available').map(projectSessionRecord),
      ...(projectFilesRoot === undefined ? {} : { projectFilesRoot }),
      ...(runtimeConditions === undefined ? {} : { runtimeConditions }),
      invocationInputs,
    }),
  ].join('\n')
}

export function renderOverviewContext(context: OverviewContext): string {
  if (context.status === 'unreadable') return `项目整体看板当前不可读：${context.message}。未沿用旧的目标或总结。`
  return [
    '以下看板由Projects产品供给，正文由主会话维护，包含原有来源定位与更新时间；它是项目级总结，不代替原话或实时进度。',
    '看板中的来源链接不表示已经重读该来源。按真实来源、适用范围和明确变化理解；需要细节时查聊天、记忆正文或文件。',
    context.status === 'missing' ? '看板尚未建立；按当前交流工作，不从历史台账补成当前目标。' : JSON.stringify(context.document),
  ].join('\n')
}

export function projectRecord(project: Project): ProjectRecord {
  return {
    id: project.id,
    ...(project.sourceLifecycle===undefined?{}:{sourceLifecycle:structuredClone(project.sourceLifecycle)}), name: project.name,
    ...(project.workspace === undefined ? {} : { workspace: { path: project.workspace.path } }),
    ...(project.mainSessionId === undefined ? {} : { mainSessionId: project.mainSessionId }),
    archived: project.archived, revision: project.revision, createdAt: project.createdAt, updatedAt: project.updatedAt,
  }
}
export function projectSessionRecord(session: ProjectSession): ProjectSessionRecord {
  return { id: session.id, projectId: session.projectId, hostSessionId: session.hostSessionId, role: workSessionRole(session), title: session.title,
    archived: session.archived, revision: session.revision, createdAt: session.createdAt, updatedAt: session.updatedAt,
    ...(session.carriers === undefined ? {} : { carriers: session.carriers.map(carrier => ({ sequence: carrier.sequence,
      hostSessionId: carrier.hostSessionId, isCurrent: carrier.isCurrent, sourceKind: carrier.sourceLifecycle.kind,
      ...(carrier.lifecycleTimeBasis === undefined ? {} : { lifecycleTimeBasis: carrier.lifecycleTimeBasis }),
      ...(carrier.header === undefined ? {} : { sessionCreatedAt: carrier.header.createdAt }),
      ...(carrier.closed === undefined ? {} : { closed: { ...carrier.closed } }) })) }) }
}
function isWorkSession(session: ProjectSession): session is ProjectSession & { role: ProjectWorkSessionRole } {
  return session.role === 'main' || session.role === 'execution'
}
function workSessionRole(session: ProjectSession): ProjectWorkSessionRole {
  if (!isWorkSession(session)) throw new Error('Memory session has no project work-session projection')
  return session.role
}
export function projectDeliveryRecord(delivery: Delivery): ProjectDeliveryRecord {
  return {
    historical: true,
    id: delivery.id, intent: delivery.intent, senderSessionId: delivery.senderSessionId, targetSessionId: delivery.targetSessionId,
    sources: delivery.sources.map(source => ({ ...source })),
    ...(delivery.nativeMessageId === undefined ? {} : { nativeMessageId: delivery.nativeMessageId }),
    ...(delivery.continuesDeliveryId === undefined ? {} : { continuesDeliveryId: delivery.continuesDeliveryId }),
    dispatch: delivery.dispatch, processing: delivery.processing, createdAt: delivery.createdAt, updatedAt: delivery.updatedAt,
  }
}
