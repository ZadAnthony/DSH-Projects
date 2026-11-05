/** 公共接线只读取模块 owner；整体正文不复制到 Core 或其它载体。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { ProjectsCoreAccess } from './core-access.ts'
import type { LibraryService } from './library-service.ts'
import type { ProjectMemoryService } from './memory-service.ts'
import type { ProjectSession, ProjectWorkSessionRole } from './records-types.ts'
import { OverviewService, OverviewStore } from './features/overview/index.ts'
import type { OverviewAccess, OverviewCorePort, OverviewRequest, OverviewSourceRef, OverviewSourceView } from './features/overview/contract.ts'
import { ProjectSettingsService, dshSettingsModelPort } from './features/settings/index.ts'
import { ProjectUsageService, createNativeUsageReader } from './features/usage/index.ts'
import { ProjectUsageLineage, nativeUsageLineagePorts } from './features/usage/lineage.ts'
import type { UsageSourceBinding } from './features/usage/lineage.ts'
import { ProjectScheduleService } from './features/schedule/service.ts'
import type { ScheduleAccess, ScheduleRequest } from './features/schedule/contract.ts'
import type { ProjectScheduleRuntime } from './features/schedule/runtime.ts'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

class ScheduleSettingsCaller { constructor(readonly projectId: string, readonly changeId: string) {} }
class ScheduleToolCaller { constructor(readonly exec: ToolRunContext) {} }

export class ProjectFeatureModules {
  readonly settings: ProjectSettingsService
  readonly usage: ProjectUsageService
  readonly schedule: ProjectScheduleService
  private readonly overviewStore: OverviewStore
  private readonly usageListeners = new Map<string, Set<() => void>>()

  constructor(private readonly ctx: Context, private readonly core: ProjectsCoreAccess,
    private readonly library: LibraryService, private readonly memory: ProjectMemoryService, dataRoot: string,
    scheduleRuntime?: ProjectScheduleRuntime, scheduleClock?: () => string, sessionInstructionAdmission?: (request: {projectId:string;sessionId:string}) => (() => void) | undefined) {
    this.overviewStore = new OverviewStore(dataRoot)
    this.settings = new ProjectSettingsService({
      withMetadataWrite: (request, prepared, operation, action) => {
        const sessionId = 'sessionId' in request ? String(request.sessionId) : undefined
        if (operation === 'cleanup') {
          if (sessionId === undefined) throw new Error('删除设置缺少精确会话目标。')
          return core.withMetadataCleanup(request.projectId, { sessionId,
            ...('hostSessionId' in prepared ? { hostSessionId: String(prepared.hostSessionId) } : {}) }, scope => action(scope), request.signal)
        }
        return core.withMetadataWrite(request.projectId, fresh => {
          if (prepared.projectId !== request.projectId) throw new Error('设置准备属于其它项目。')
          if (request.metadataActor !== undefined) core.assertMetadataSession(fresh, {
            ...request.metadataActor, roles: ['main', 'execution'], activity: 'active' })
          if (sessionId !== undefined) {
            const target = fresh.sessions.find(row => row.id === sessionId)
            if (target === undefined && operation === 'discard') return
            core.assertMetadataTarget(fresh, sessionId)
            if (operation !== 'save' && 'hostSessionId' in prepared && target?.hostSessionId !== prepared.hostSessionId) {
              throw new Error('初始化或回滚的实际会话承载已变化。')
            }
          }
        }, scope => action(scope), request.signal)
      },
      resolveProject: async request => {
        const view = await core.forProject(request.projectId)
        return { projectId: view.project.id, projectDirectory: view.projectRoot }
      },
      resolveSession: async request => {
        const view = await core.forProject(request.projectId)
        const session = view.snapshot.sessions.find(item => item.id === request.sessionId)
        if (session === undefined || (session.role !== 'main' && session.role !== 'execution')
          || session.sourceLifecycle.kind !== 'available') throw new Error('指令目标会话不属于当前项目工作会话或已不可用。')
        return { projectId: view.project.id, projectDirectory: view.projectRoot,
          sessionId: session.id, hostSessionId: session.hostSessionId, role: session.role }
      },
    }, dshSettingsModelPort(ctx.sessionController), sessionInstructionAdmission)
    const usageLineage = new ProjectUsageLineage(nativeUsageLineagePorts(ctx))
    this.usage = new ProjectUsageService({
      resolveProject: async (projectId, sessionId, signal) => {
        signal?.throwIfAborted()
        const { snapshot } = await core.forProject(projectId)
        signal?.throwIfAborted()
        const bindings: UsageSourceBinding[] = snapshot.sessions.flatMap(session => [
          ...(session.carriers ?? [{ hostSessionId: session.hostSessionId, sourceLifecycle: session.sourceLifecycle, ownedLifecycle: session.ownedLifecycle, header: session.ownedLifecycle?.rootHeader }]).map(carrier => ({
            id: session.id, projectId: session.projectId, hostSessionId: carrier.hostSessionId, title: session.title, role: session.role,
            ...(carrier.header !== undefined ? { expectedHeader: carrier.header }
              : carrier.ownedLifecycle?.rootHeader === undefined ? {} : { expectedHeader: carrier.ownedLifecycle.rootHeader }),
            discoverChildren: session.role === 'main' || session.role === 'execution',
            ...carrier.ownedLifecycle === undefined ? {} : { retainedOwned: carrier.ownedLifecycle },
          })),
          ...(session.mainPreparations ?? []).filter(preparation => preparation.state !== 'committed').flatMap(preparation => [
            { id: session.id, projectId: session.projectId, title: session.title, role: session.role, hostSessionId: preparation.toHostSessionId },
            ...(preparation.sourceLifecycle !== undefined && preparation.sourceLifecycle.kind !== 'available'
              ? preparation.sourceLifecycle.ownedDeletion?.members ?? [] : []).map(member => ({
                id: session.id, projectId: session.projectId, title: session.title, role: session.role, hostSessionId: String(member.header.id), expectedHeader: member.header,
              })),
          ]),
        ])
        if (sessionId !== undefined && !bindings.some(binding => binding.id === sessionId)) throw new Error('该会话不属于当前项目。')
        const expanded = await usageLineage.expand(projectId, bindings, sessionId, signal)
        return { projectId: snapshot.project.id, ...expanded }
      }, readSession: createNativeUsageReader(ctx),
    })
    ctx.on('session/event', (session, event) => {
      for (const projectId of usageLineage.projectsForEvent(session.header, event.type)) this.notifyUsage(projectId)
    })
    this.schedule = new ProjectScheduleService({
      withMetadataWrite: (request, prepared, target, action) => this.core.withMetadataWrite(request.projectId, fresh => {
        if (prepared.projectId !== request.projectId) throw new Error('定时准备属于其它项目。')
        const actor = prepared.actor
        if (actor.kind === 'session') {
          if (actor.hostSessionId === undefined) throw new Error('定时调用缺少实际工作承载。')
          this.core.assertMetadataSession(fresh, { sessionId: actor.sessionId, hostSessionId: actor.hostSessionId,
            roles: ['main', 'execution'], activity: 'active' })
          if (actor.sessionId !== target.id && fresh.sessions.find(row => row.id === actor.sessionId)?.role !== 'main') throw new Error('执行会话不能维护其它会话定时。')
        }
        const current = this.core.assertMetadataTarget(fresh, target.id)
        if (current.hostSessionId !== target.hostSessionId) throw new Error('定时目标承载已变化，未对旧承载应用设置。')
      }, scope => action(scope), request.signal),
      captureBoundary: () => scheduleRuntime?.captureBoundary() ?? { at: scheduleClock?.() ?? new Date().toISOString() },
      configurationCommitted: (previous, current, boundary) => scheduleRuntime?.configurationCommitted(previous, current, boundary),
      automaticState: () => {
        const status = scheduleRuntime?.status
        if (!status?.hostConnected || status.closing) return { automaticDispatch: 'not-connected',
          automaticAvailability: { kind: 'unknown', reason: '自动定时连接尚未完成或正在关闭。' } }
        const fact = scheduleRuntime!.currentPowerFact()
        if (fact.kind === 'unknown') return { automaticDispatch: 'connected',
          automaticAvailability: { kind: 'unknown', observedAt: fact.observedAt, reason: fact.reason } }
        if (fact.provenance !== 'darwin-kernel') return { automaticDispatch: 'not-connected',
          automaticAvailability: { kind: 'unknown', reason: '尚未取得实际宿主的本机事实。' } }
        return { automaticDispatch: 'connected', automaticAvailability: {
          kind: fact.available ? 'available' : 'unavailable', observedAt: fact.observedAt,
        } }
      },
      resolve: request => this.scheduleAccess(request),
      withTargetOperation: (_request, access, target, operation) => {
        if (scheduleRuntime === undefined) throw new Error('项目定时管理入口尚未就绪。')
        return scheduleRuntime.withTargetOperation({ ...target, projectId: access.projectId, projectDirectory: access.projectDirectory }, operation)
      },
      preparePending: (_request, access, target) => {
        if (scheduleRuntime === undefined) throw new Error('项目定时管理入口尚未就绪。')
        return scheduleRuntime.preparePending({ ...target, projectId: access.projectId, projectDirectory: access.projectDirectory })
      },
      runNow: (request, access, input) => {
        if (scheduleRuntime === undefined) throw new Error('项目主动运行入口尚未就绪。')
        return scheduleRuntime.runNow(request, access, input)
      },
      prepareRunRead: async (request, access) => {
        if (scheduleRuntime === undefined) return { nativeLinks: [], readStatus: () => ({ status: 'unknown' }) }
        const reader = await scheduleRuntime.prepareRunRead(access)
        const current = await this.scheduleAccess(request)
        const identity = (value: ScheduleAccess) => JSON.stringify({ projectId: value.projectId, actor: value.actor,
          sessions: value.sessions.map(({ id, hostSessionId, carrierHostSessionIds, role }) => ({ id, hostSessionId, carrierHostSessionIds, role }))
            .sort((left, right) => left.id.localeCompare(right.id)) })
        if (identity(current) !== identity(access)) throw new Error('定时读取期间调用者或目标归属已变化，请重新读取。')
        return reader
      },
    }, scheduleClock, () => { void scheduleRuntime?.hint().catch(() => {}) })
  }

  /** Internal actual settings action; no Remote/JSON caller may claim this identity. */
  scheduleSettingsRequest(projectId: string, changeId: string): ScheduleRequest {
    return { projectId, caller: new ScheduleSettingsCaller(projectId, changeId) }
  }
  scheduleToolRequest(projectId: string, exec: ToolRunContext): ScheduleRequest {
    return { projectId, caller: new ScheduleToolCaller(exec) }
  }
  resolveScheduleAccess(request: ScheduleRequest): Promise<ScheduleAccess> { return this.scheduleAccess(request) }
  private async scheduleAccess(request: ScheduleRequest): Promise<ScheduleAccess> {
    const view = await this.core.forProject(request.projectId)
    const sessions = view.snapshot.sessions.filter(availableWorkSession).map(session => ({ id: session.id,
      hostSessionId: session.hostSessionId, carrierHostSessionIds: (session.carriers ?? [{hostSessionId:session.hostSessionId}]).map(carrier=>carrier.hostSessionId), role: session.role, title: session.title, archived: session.archived }))
    const base = { projectId: view.project.id, projectDirectory: view.projectRoot, projectArchived: view.project.archived, sessions }
    if (request.caller instanceof ScheduleSettingsCaller && request.caller.projectId === request.projectId) {
      await this.core.forSettingsUser(request.projectId)
      return { ...base, actor: { kind: 'user' }, managementSources: [{ kind: 'settings', changeId: request.caller.changeId }] }
    }
    if (request.caller instanceof ScheduleToolCaller) {
      const scope = await this.core.forTool(request.caller.exec, 'project_schedule')
      if (scope.project.id !== request.projectId || (scope.role !== 'main' && scope.role !== 'execution')) throw new Error('定时管理者必须是当前项目工作会话。')
      return { ...base, actor: { kind: 'session', sessionId: scope.session.id, hostSessionId: scope.hostSessionId },
        manualRequestId: `tool:${scope.hostSessionId}:${String(request.caller.exec.callId)}`,
        managementSources: [...scope.invocationSources.filter((source): source is Extract<typeof source, { kind: 'message' } | { kind: 'tool' } | { kind: 'native-event' }> => source.kind === 'message' || source.kind === 'tool' || source.kind === 'native-event'),
          { kind: 'tool', hostSessionId: scope.hostSessionId, toolCallId: String(request.caller.exec.callId) }] }
    }
    throw new Error('缺少真实定时管理调用上下文。')
  }

  overview(actor: OverviewAccess['actor'] = { kind: 'user' }): OverviewService {
    return new OverviewService({ store: this.overviewStore, core: this.overviewPort(actor) })
  }
  async overviewSource(request: OverviewRequest & { reference: OverviewSourceRef }): Promise<OverviewSourceView> {
    return this.overview().readSource(request)
  }
  private overviewPort(actor: OverviewAccess['actor']): OverviewCorePort {
    return {
      withMetadataWrite: (request, prepared, action) => this.core.withMetadataWrite(request.projectId, fresh => {
        if (prepared.actor.kind !== 'session' || prepared.actor.role !== 'main' || actor.kind !== 'session'
          || actor.sessionId !== prepared.actor.sessionId || actor.hostSessionId === undefined) throw new Error('看板保存缺少实际主会话承载。')
        this.core.assertMetadataSession(fresh, { sessionId: actor.sessionId, hostSessionId: actor.hostSessionId,
          roles: ['main'], activity: 'active' })
      }, scope => action(scope)),
      resolveAccess: async request => {
        const view = await this.core.forProject(request.projectId)
        if (actor.kind === 'user') return { projectId: view.project.id, actor: { kind: 'user' } }
        const session = view.snapshot.sessions.find(item => item.id === actor.sessionId)
        if (session === undefined || (session.role !== 'main' && session.role !== 'execution')) throw new Error('看板调用方不属于当前项目工作会话。')
        return { projectId: view.project.id, actor: { kind: 'session', sessionId: session.id, role: session.role,
          ...(actor.hostSessionId === undefined ? {} : { hostSessionId: actor.hostSessionId }) } }
      },
      readProjectFacts: async access => {
        const view = await this.core.forProject(access.projectId)
        return { status: 'available', readAt: new Date().toISOString(), value: {
          projectId: view.project.id, name: view.project.name, projectRoot: view.projectRoot,
          archived: view.project.archived,
          ...(view.configuredWorkspace === undefined ? {} : { workspace: view.configuredWorkspace }),
          sessions: view.snapshot.sessions.filter(availableWorkSession).map(session => ({ id: session.id, projectId: session.projectId,
            hostSessionId: session.hostSessionId, carrierHostSessionIds: (session.carriers ?? [{hostSessionId:session.hostSessionId}]).map(carrier=>carrier.hostSessionId), role: session.role, title: session.title, archived: session.archived })),
        } }
      },
      readRuntime: async access => {
        const { snapshot } = await this.core.forProject(access.projectId)
        // The registry contains only this process's loaded instances. Retained
        // sessions may stay cold until activation; absence is not a task result.
        const live = new Map(this.ctx.agents.list().map(agent => [String(agent.id), agent]))
        return { status: 'available', readAt: new Date().toISOString(), value: snapshot.sessions.filter(availableWorkSession).map(session => {
          const agent = live.get(session.hostSessionId)
          return { sessionId: session.id, state: agent === undefined ? 'unknown' as const
            : agent.status === 'running' ? 'running' as const : 'idle' as const,
            observedAt: new Date().toISOString(), ...(agent === undefined ? { reason: '当前进程没有加载此会话的活动实例；仅凭此信息无法判断任务结果。' } : {}) }
        }) }
      },
      readSource: (access, reference) => this.readOverviewSource(access, reference),
      finalizeSources: async (access, sources) => {
        const {snapshot} = await this.core.forProject(access.projectId)
        return sources.map(source => {
          const reference = source.reference
          const session = reference.kind === 'native'
            ? snapshot.sessions.find(item => item.hostSessionId === reference.source.hostSessionId || item.carriers?.some(carrier => carrier.hostSessionId === reference.source.hostSessionId))
            : reference.kind === 'session' ? snapshot.sessions.find(item => item.id === reference.id) : undefined
          if (reference.kind !== 'native' && reference.kind !== 'session') return source
          if (session?.sourceLifecycle.kind === 'available' && (session.role === 'main' || session.role === 'execution')) return source
          return {...source,status:'unavailable' as const,rows:[],message:session?.sourceLifecycle.kind === 'deleted'
            ? '来源会话已删除。' : '来源会话当前不可打开。'}
        })
      },
    }
  }

  private async readOverviewSource(access: OverviewAccess, reference: OverviewSourceRef): Promise<OverviewSourceView> {
    const readAt = new Date().toISOString()
    const unavailable = (message: string, status: 'missing' | 'unreadable' | 'unavailable' = 'unavailable'): OverviewSourceView =>
      ({ projectId: access.projectId, reference, label: '原始来源', status, readAt, rows: [], message })
    const base = { projectId: access.projectId, reference, readAt, status: 'available' as const }
    if (reference.kind === 'native') {
      const read = await this.core.readSource(access.projectId, reference.source)
      if (!read.readable) {
        const explanation = read.code === 'deleted' ? '来源会话已删除。'
          : read.code === 'not-found' ? '原始记录不存在或不在可读取范围。'
          : read.code === 'stale-source' ? '来源内容已变化，请从原入口重新打开。'
          : read.code === 'invalid-source' || read.code === 'ambiguous-source' ? '当前来源位置无法确认，请从原聊天重新打开。'
          : '原聊天当前不可读，可刷新看板后重试。'
        return { ...unavailable(explanation, 'unreadable'), ...(read.reason === undefined ? {} : { diagnostic: read.reason }) }
      }
      return { ...base, label: '原聊天', rows: (read.nativeItems ?? []).filter(item => item.isTarget).map(item => ({
        id: `${reference.source.hostSessionId}:${item.seq}`, title: item.sourceKind === 'project-delivery' ? 'Agent 转达' : '原始聊天',
        fields: [{ label: '时间', value: new Date(item.time).toISOString() }, { label: '内容', value: item.text }],
        links: [{ label: '查看原文与前后文', target: { kind: 'source', reference } }],
        ...(read.reason === undefined ? {} : { limitations: [read.reason] }),
      })) }
    }
    if (reference.kind === 'memory') {
      const memory = await this.memory.read({ projectId: access.projectId, actor: { kind: 'settings' } }, reference.topicId)
      if (memory === undefined) return unavailable('该共享记忆已撤回或不存在。', 'missing')
      return { ...base, label: '共享记忆', rows: [{ id: memory.id, title: memory.title,
        fields: [{ label: '当前正文', value: memory.body }], ownerUpdatedAt: memory.updatedAt, links: [] }] }
    }
    const view = await this.core.forProject(access.projectId)
    if (reference.kind === 'session') {
      const session = view.snapshot.sessions.find(item => item.id === reference.id)
      if (session === undefined) return unavailable('来源会话当前不可读；没有已删除的确证。', 'unreadable')
      if (session.role !== 'main' && session.role !== 'execution') return unavailable('该来源不是项目工作会话。')
      if (session.sourceLifecycle.kind !== 'available') return unavailable(session.sourceLifecycle.kind === 'deleted' ? '来源会话已删除。' : '来源会话删除未完成，原聊天不可打开。')
      return { ...base, label: '项目会话', rows: [{ id: session.id, title: session.title,
        fields: [{ label: '角色', value: session.role === 'main' ? '主会话' : '执行会话' }],
        links: [{ label: '打开会话', target: { kind: 'session', sessionId: session.id } }] }] }
    }
    // UI 使用项目真实会话的文件 scope，不伪造一个 main 工具调用。
    const sessionId = access.actor.kind === 'session' ? access.actor.sessionId : view.project.mainSessionId
    if (sessionId === undefined) return unavailable('项目没有可读取文件的会话。')
    const opened = await this.library.open({ projectId: access.projectId, sessionId, location: reference.location })
    if (opened.status === 'unavailable') {
      const explanation = { missing: '原文件缺失。', permissionDenied: '没有读取原文件的权限。', tooLarge: '原文件超过读取大小限制。', unsupported: '当前不支持读取该文件类型。', readFailed: '原文件当前位置读取失败，可刷新看板后重试。' }[opened.reason]
      return { ...unavailable(explanation, 'unreadable'), diagnostic: opened.message }
    }
    const location = opened.target.kind === 'url' ? opened.target.url : opened.target.path
    return { ...base, label: '实际文件入口', rows: [{ id: JSON.stringify(reference.location), title: opened.name,
      fields: [{ label: '位置', value: location }, { label: '本次读取', value: opened.status === 'url' ? '网页入口，未核查远端内容' : opened.status === 'file' ? `${opened.byteLength} 字节` : '当前目录' }],
      links: [{ label: '打开文件入口', target: { kind: 'source', reference } }] }] }
  }

  notifyUsage(projectId: string): void { for (const listener of this.usageListeners.get(projectId) ?? []) listener() }
  async *watchUsage(projectId: string, signal: AbortSignal): AsyncIterable<{ projectId: string; revision: number }> {
    signal.throwIfAborted()
    await this.core.forProject(projectId)
    let pending = true, revision = 0
    let wake: (() => void) | undefined
    const listener = () => { pending = true; wake?.() }
    const listeners = this.usageListeners.get(projectId) ?? new Set<() => void>()
    listeners.add(listener); this.usageListeners.set(projectId, listeners)
    const abort = () => { wake?.() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!signal.aborted) {
        if (pending) { pending = false; yield { projectId, revision: revision++ }; continue }
        await new Promise<void>(resolve => { wake = resolve }); wake = undefined
      }
    } finally {
      listeners.delete(listener)
      if (listeners.size === 0) this.usageListeners.delete(projectId)
      signal.removeEventListener('abort', abort)
    }
  }
}

function availableWorkSession(session: ProjectSession): session is ProjectSession & { readonly role: ProjectWorkSessionRole } {
  return session.sourceLifecycle.kind === 'available' && (session.role === 'main' || session.role === 'execution')
}
