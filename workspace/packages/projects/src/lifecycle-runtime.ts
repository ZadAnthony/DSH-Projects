import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { scheduleDomain } from '@deepseek-ai/dsh-schedule'
import { prepareSourceScheduleRestore } from './stock/control/schedule-helpers.ts'
import { withProjectsScheduleDomain } from './stock/native-storage.ts'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import { sameOwnedCreationHeader, type OwnedSubagentMember, type OwnedQuiescence, type OwnedRetirementOptions } from './stock/control/identity.ts'
import type { ProjectControlPort } from './stock/project-ports.ts'
import type { ProjectSourceExecutionDisposition as SessionSourceExecutionDisposition } from './stock/project-ports.ts'
import { ProjectStore } from './records.ts'
import type { LifecycleStoreCommit } from './records.ts'
import type { ProjectMembership, ProjectSession, ProjectSessionRosterEntry, ProjectSnapshot, SessionOwnedLifecycle } from './records-types.ts'
import type { ScheduleClockBoundary } from './features/schedule/power-facts.ts'
import { captureArchiveInbox, settleArchiveInbox, type ArchiveInboxSnapshot } from './lifecycle-inbox.ts'
import { assertExecutionLifecycleTarget } from './lifecycle-service.ts'
import { LifecycleOperationError } from './lifecycle-types.ts'
import type { ExecutionLifecycleRequest, LifecycleChangeResult, LifecycleTarget, ProjectLifecycleActionRequest, ProjectLifecycleChangeResult, ProjectLifecycleSessionOutcome } from './lifecycle-types.ts'

export class LifecycleStoppedPersistenceError extends Error {}
interface RootInspection { readonly session: ProjectSession; readonly header: SessionHeader; readonly members: readonly OwnedSubagentMember[] }
interface RestoreResponsibility { readonly projectId: string; readonly whole: boolean; roots: readonly RootInspection[]; quiescence?: OwnedQuiescence; committed?: LifecycleStoreCommit; releaseNative?: () => void }
interface InputCut { readonly rootId: string; readonly header: SessionHeader; readonly preserve: boolean; readonly configuration?: true; restore?: RestoreResponsibility; inbox?: ArchiveInboxSnapshot }
interface LifecyclePorts {
  readonly nativeStorageDataRoot: string
  changed(): void
  canDrive?(id: string): boolean
  rootFor(id: string): string | undefined
  resolveRoot?(header: SessionHeader): Promise<Agent>
  modelInitializationFailed?(id: string): boolean
  drain(ids: readonly string[]): Promise<void>
  now(): string
  captureBoundary?(): ScheduleClockBoundary
  hint(): Promise<void>
}

/** 原Store持久事实、原native真实关闭与原target operation的同一有限动作编排。 */
export class ProjectExecutionLifecycle {
  private readonly deletingTargets=new Set<string>()
  private closing = false
  private readonly cuts = new Map<string, InputCut>()
  private readonly projectCuts = new Set<string>()
  private readonly operations = new Map<string, Promise<unknown>>()
  private readonly installed = new WeakSet<Agent>()
  private readonly cold = new Map<string, { members: readonly OwnedSubagentMember[] } | { unknown: string }>()
  private readonly projectRestoredAt = new Map<string, ScheduleClockBoundary>()
  private readonly sessionRestoredAt = new Map<string, ScheduleClockBoundary>()
  private readonly rootlessRestores = new Map<string, RestoreResponsibility>()

  constructor(private readonly ctx: Context, private readonly store: ProjectStore,
    private readonly current: (hostSessionId: string) => ProjectMembership | undefined,
    private readonly publish: (snapshot: ProjectSnapshot) => void,
    private readonly background?: { suspend(projectId: string): Promise<unknown>; resume(projectId: string): void },
    private readonly ports?: LifecyclePorts, private readonly control?: ProjectControlPort) {}

  /** 原initialize内严格只读，不写旧Store，不制造已停证明，不等appReady。 */
  async initializeSources(snapshots: readonly ProjectSnapshot[]): Promise<void> {
    for (const snapshot of snapshots) for (const logical of snapshot.sessions) for (const session of carrierSessions(logical)) {
      if (session.sourceLifecycle.kind !== 'available' || session.ownedLifecycle !== undefined
        || (!snapshot.project.archived && !session.archived)) continue
      try { this.cold.set(session.hostSessionId, { members: await this.native().inspectOwnedSessions(SessionId(session.hostSessionId)) }) }
      catch (error) { this.cold.set(session.hostSessionId, { unknown: errorMessage(error) }) }
    }
  }

  sourceEntries(session: ProjectSession, projectArchived: boolean): readonly [SessionId, SessionSourceExecutionDisposition][] {
    const rootId = SessionId(session.hostSessionId)
    const cold = this.cold.get(rootId)
    const cut=this.cuts.get(rootId)
    const memberState = this.ports?.modelInitializationFailed?.(rootId) === true || cold !== undefined && 'unknown' in cold ? 'unknown' as const
      : this.closing || this.projectCuts.has(session.projectId) || (cut!==undefined&&!cut.configuration) || this.deletingTargets.has(rootId) || projectArchived || session.archived ? 'readonly' as const : 'active' as const
    const state=memberState==='active'&&cut?.configuration?'readonly' as const:memberState
    const releasedAt = latest(this.projectRestoredAt.get(session.projectId)?.at, this.sessionRestoredAt.get(rootId)?.at)
    const root: SessionSourceExecutionDisposition = state === 'unknown' ? { state, rootSessionId: rootId }
      : { state, rootSessionId: rootId, ...(cut?.configuration&&memberState==='active'?{scope:'session' as const}:{}), ...(releasedAt === undefined ? {} : { releasedAt }) }
    const result: [SessionId, SessionSourceExecutionDisposition][] = [[rootId, root]]
    const members = session.ownedLifecycle?.members ?? (cold !== undefined && 'members' in cold ? cold.members : [])
    for (const member of members) result.push([SessionId(member.header.id), memberState === 'unknown'
      ? { state:memberState, rootSessionId: rootId } : { state:memberState, rootSessionId: rootId, member: { ...member, parentSessionId: SessionId(member.parentSessionId) }, ...(releasedAt === undefined ? {} : { releasedAt }) }])
    for (const [id, cut] of this.cuts) if (cut.rootId === rootId && id !== rootId && !result.some(([key]) => key === id)) {
      result.push([SessionId(id), { state: 'readonly', rootSessionId: rootId }])
    }
    return result
  }

  install(agent: Agent, prepared = false): void {
    if (this.installed.has(agent)) return
    if (!prepared && this.current(agent.id) === undefined) throw new Error('Projects 会话归属尚未可读。')
    const driver = agent as Agent & { setDrivingPolicy?(policy: () => boolean): () => void }
    if (driver.setDrivingPolicy === undefined) throw new Error('当前会话 driver 不提供生命周期驱动策略。')
    const release = driver.setDrivingPolicy(() => this.canDrive(agent.id))
    this.installed.add(agent)
    agent.ctx.effect(() => release, 'projects.lifecycle-driving')
  }
  canDrive(id: string): boolean {
    const root = this.current(id) ?? this.current(this.cuts.get(id)?.rootId ?? this.ports?.rootFor(id) ?? id)
    return !this.closing && this.ports?.canDrive?.(id) !== false && root !== undefined && this.ports?.modelInitializationFailed?.(root.session.hostSessionId) !== true && !this.cuts.has(id) && (this.cuts.get(root.session.hostSessionId)===undefined || this.cuts.get(root.session.hostSessionId)?.configuration===true)
      && !this.deletingTargets.has(root.session.hostSessionId) && !this.projectCuts.has(root.project.id) && !root.project.archived && !root.session.archived
  }
  isCloseOnly(id: string): boolean { return this.cuts.has(id) }
  canBindProject(projectId: string): boolean { return !this.closing && !this.projectCuts.has(projectId) }
  closeAdmission(): void { this.closing = true; this.ports?.changed() }
  /** Join accepted original lifecycle slots; shutdown never starts or releases another action. */
  async settleAccepted(): Promise<void> {
    const results = await Promise.allSettled([...this.operations.values()])
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, '项目生命周期已接纳动作结算未确认。')
  }

  pendingRestores(projectId: string): readonly ({ scope: 'project' } | { scope: 'session'; sessionId: string })[] {
    if (this.closing) return []
    return this.restoreResponsibilities().filter(action => action.committed !== undefined)
      .filter(action => action.projectId === projectId).map(action => action.whole ? { scope: 'project' as const }
        : { scope: 'session' as const, sessionId: action.roots[0]!.session.id })
  }
  private heldRestore(projectId: string, whole: boolean, sessionId?: string): RestoreResponsibility | undefined {
    return this.restoreResponsibilities().find(action => action.committed !== undefined && action.projectId === projectId
      && action.whole === whole && (whole || action.roots[0]?.session.id === sessionId))
  }
  private restoreResponsibilities(): RestoreResponsibility[] {
    return [...new Set([...this.cuts.values()].flatMap(cut => cut.restore === undefined ? [] : [cut.restore])
      .concat([...this.rootlessRestores.values()]))]
  }
  restoredAt(projectId: string, id: string): { projectRestoredAt?: string; sessionRestoredAt?: string;
    projectRestoredBaselineEpoch?: number; sessionRestoredBaselineEpoch?: number } {
    const project = this.projectRestoredAt.get(projectId), session = this.sessionRestoredAt.get(id)
    return { projectRestoredAt: project?.at, sessionRestoredAt: session?.at,
      projectRestoredBaselineEpoch: project?.baselineEpoch, sessionRestoredBaselineEpoch: session?.baselineEpoch }
  }

  /** 同一动作/creation的第一次真实同步Session发布，绝不在agent-created或第二epoch重抓。 */
  captureSession(session: Session): void {
    // API cold resume可先进入registry，原同步Session发布先安装同一root策略；
    // 较早的异步agent-created失败/rollback也必须保留cut后的合法输入。
    const root = this.current(session.id)
    const agent = root === undefined ? undefined : this.ctx.agents.get(session.id)
    if (agent !== undefined) this.install(agent)
    const cut = this.cuts.get(session.id)
    if (cut === undefined || cut.inbox !== undefined) return
    if (!sameOwnedCreationHeader(cut.header, session.header)) throw new Error('归档发布的创建身份发生变化。')
    const state = this.ctx.sessionProjections.stateOf(session, 'inbox')
    if (state === undefined) throw new Error('真实初始Inbox投影不可读。')
    cut.inbox = { hostSessionId: session.id, messageIds: cut.preserve ? [] : [...state['next-step'], ...state['next-turn']].map(message => message.id) }
  }

  change(request: ExecutionLifecycleRequest, action: 'archive' | 'restore'): Promise<LifecycleChangeResult> {
    return this.enqueue(request.projectId, async () => {
      const before = await this.store.getSnapshot(request.projectId)
      const session = before.sessions.find(row => row.id === request.sessionId && row.sourceLifecycle.kind === 'available')
      if (session === undefined) throw new Error('目标会话来源已不可用或不属于当前项目。')
      if (session.role !== 'main' && session.role !== 'execution') throw new Error('后台记忆只随项目整体生命周期处理。')
      const target = this.target(before, session)
      assertExecutionLifecycleTarget(request, target)
      if (action === 'restore' && before.project.archived) throw new Error('请先恢复整个项目。')
      const pending = this.heldRestore(request.projectId, false, session.id)
      if (pending === undefined && this.pendingRestores(request.projectId).length) throw new Error('请先沿原入口完成尚未释放的恢复动作。')
      if (pending !== undefined && action !== 'restore') throw new Error('请先沿原入口完成本次恢复。')
      if (pending !== undefined) {
        const resumed = await this.continueRestore(before, pending)
        if (resumed.kind === 'failed') throw new LifecycleOperationError('restore-host', new Error(resumed.message), false)
        return { kind: 'restored', target: this.target(resumed.snapshot, resumed.snapshot.sessions.find(row => row.id === session.id)!) }
      }
      if (session.archived === (action === 'archive')) return { kind: 'unchanged', target }
      const result = action === 'archive' ? await this.archive(before, carrierSessions(session), false) : await this.restore(before, carrierSessions(session), false)
      if (result.kind === 'failed') throw new LifecycleOperationError(action === 'archive' ? 'archive-host' : 'restore-host', new Error(result.message), result.sessions.find(row => row.sessionId === session.id)?.quiescence === 'settled')
      const actual = result.snapshot.sessions.find(row => row.id === session.id)!
      return { kind: result.kind, target: this.target(result.snapshot, actual) }
    })
  }
  changeProject(request: ProjectLifecycleActionRequest): Promise<ProjectLifecycleChangeResult> {
    return this.enqueue(request.projectId, async () => {
      const snapshot = await this.store.getSnapshot(request.projectId)
      const pending = this.heldRestore(request.projectId, true)
      if (pending === undefined && this.pendingRestores(request.projectId).length) throw new Error('请先沿原入口完成尚未释放的恢复动作。')
      if (pending !== undefined && request.action !== 'restore') throw new Error('请先沿原入口完成本次恢复。')
      if (pending !== undefined) return this.continueRestore(snapshot, pending)
      if (snapshot.project.archived === (request.action === 'archive')) return this.result(snapshot, 'unchanged', 'complete', [], '记录未变化；本次没有重新停止或重放工作。')
      const roots = (await this.store.listProjectLifecycleTargets(request.projectId)).flatMap(carrierSessions)
      return request.action === 'archive' ? this.archive(snapshot, roots, true) : this.restore(snapshot, roots.filter(row => !row.archived), true)
    })
  }
  /**
   * Hold only a cold configuration root before its factory can claim the Inbox; owned members keep their current driving state.
   * @param header - exact creation identity from the original non-activating reader.
   * @returns this caller's release; it removes only this cut and never wakes old input.
   */
  prepareScheduleConfiguration(header: SessionHeader): { release(): void } {
    const id=String(header.id)
    if(this.closing||this.cuts.has(id)||this.deletingTargets.has(id))throw new Error('原目标已有生命周期动作，不能另建设置准备。')
    const cut:InputCut={rootId:id,header,preserve:true,configuration:true}
    this.cuts.set(id,cut)
    try{this.ports?.changed()}catch(error){this.cuts.delete(id);throw error}
    return {release:()=>{if(this.cuts.get(id)!==cut)return;this.cuts.delete(id);this.ports?.changed()}}
  }

  /** 永久删除接管仍在同FIFO；只移交所选root，不发布active或恢复B。 */
  prepareDeletion(projectId:string,hostIds:readonly string[],whole:boolean) {
    const heldProject=this.projectCuts.has(projectId)
    const selected=new Set(hostIds)
    for(const id of selected)this.deletingTargets.add(id)
    if(whole)this.projectCuts.add(projectId)
    const own=new Set<string>()
    for(const id of selected)if(!this.cuts.has(id)) {
      const row=this.current(id)?.session
      const header=row?.ownedLifecycle?.rootHeader
      // 临时driver/source cut不制造持久创建事实；原native负责真实header。
      if(header!==undefined){this.cuts.set(id,{rootId:id,header,preserve:true});own.add(id)}
    }
    let consumed=false
    try{this.ports?.changed()}catch(error){for(const id of selected)this.deletingTargets.delete(id);for(const id of own)this.cuts.delete(id);if(whole&&!heldProject)this.projectCuts.delete(projectId);throw error}
    return {
      handoff:(id:string,options:OwnedRetirementOptions)=>{
        const action=this.cuts.get(id)?.restore
        return action?.quiescence?.handoffRetirement(SessionId(id),options)
      },
      commit:()=>{
        if(consumed)return;consumed=true
        const actions=this.restoreResponsibilities()
        for(const action of actions){
          if(action.projectId!==projectId)continue
          action.roots=action.roots.filter(root=>!whole&&!selected.has(root.header.id))
          for(const [id,cut]of this.cuts)if(cut.restore===action&&(whole||selected.has(cut.rootId)))this.cuts.delete(id)
          if(action.roots.length===0){action.releaseNative?.();action.releaseNative=undefined;action.quiescence=undefined;if(this.rootlessRestores.get(projectId)===action)this.rootlessRestores.delete(projectId);if(action.whole)this.projectCuts.delete(projectId)}
        }
        for(const id of selected)this.deletingTargets.delete(id)
        for(const id of own)this.cuts.delete(id)
        if(whole)this.projectCuts.delete(projectId)
        this.ports?.changed()
      },
      release:()=>{if(consumed)return;consumed=true;for(const id of selected)this.deletingTargets.delete(id);for(const id of own)this.cuts.delete(id);if(whole&&!heldProject)this.projectCuts.delete(projectId);this.ports?.changed()},
    }
  }

  runProjectLifecycle<T>(projectId: string, run: () => Promise<T>): Promise<T> { return this.enqueue(projectId, run) }
  private enqueue<T>(projectId: string, run: () => Promise<T>): Promise<T> {
    const operation = (this.operations.get(projectId) ?? Promise.resolve()).then(run, run)
    this.operations.set(projectId, operation)
    void operation.finally(() => { if (this.operations.get(projectId) === operation) this.operations.delete(projectId) }).catch(() => {})
    return operation
  }
  private native() {
    const owner = this.control
    if (owner === undefined) throw new Error('Projects自有会话owner尚未接通，不能假设子树为空。')
    return owner
  }
  private async inspect(session: ProjectSession): Promise<RootInspection> {
    const [root, members] = await Promise.all([this.native().inspect(SessionId(session.hostSessionId)), this.native().inspectOwnedSessions(SessionId(session.hostSessionId))])
    if (String(root.meta.id) !== session.hostSessionId) throw new Error('原根会话创建身份不一致。')
    if (session.ownedLifecycle !== undefined && !sameOwnedCreationHeader(session.ownedLifecycle.rootHeader, root.meta)) throw new Error('原根会话创建身份已变化。')
    return { session, header: root.meta, members }
  }
  private async archive(snapshot: ProjectSnapshot, sessions: readonly ProjectSession[], whole: boolean): Promise<ProjectLifecycleChangeResult> {
    let roots: readonly RootInspection[]
    try {
      roots = await Promise.all(sessions.map(session => this.inspect(session)))
      for (const root of roots) if (root.session.archived && root.session.ownedLifecycle === undefined) throw new Error('已有独立归档会话缺少旧切点确认；本次未将其新消息重归旧输入。')
      const current = await this.read(snapshot.project.id)
      if (!sameRoster(snapshot.sessions, current.sessions)) throw new Error('归档准备期间会话归属或独立归档状态变化。')
    } catch (error) { return this.result(await this.read(snapshot.project.id), 'failed', 'prepare-archive-targets', [], `归档准备未完成，尚未停止：${errorMessage(error)}`) }
    const active = roots.filter(root => !root.session.archived)
    const outcomes: ProjectLifecycleSessionOutcome[] = []
    let held = false
    let stop: Awaited<ReturnType<typeof this.stop>> | undefined
    try {
      stop = await this.stop(snapshot.project.id, active, whole, false)
      for (const root of active) outcomes.push({ sessionId: root.session.id, role: root.session.role, quiescence: 'settled' })
      const all = roots.map(root => ({ sessionId: root.session.id, carrierHostSessionId: root.header.id, ownedLifecycle: root.session.archived ? root.session.ownedLifecycle!
        : { contract: 'archive-v1' as const, rootHeader: root.header, members: stop!.members.filter(member => belongsTo(root.header.id, member, stop!.members)) } satisfies SessionOwnedLifecycle }))
      if (whole) {
        const saved = await this.store.setProjectArchived(snapshot.project.id, true, lifecycleRosterOf(snapshot.sessions), all)
        if (saved.kind === 'conflict') throw new Error('归档保存冲突；已发生的停止未回滚。')
      } else {
        const saved = await this.store.commitExecutionArchive({ projectId: snapshot.project.id, sessionId: sessions[0]!.id,
          expectedRevision: sessions[0]!.revision, carrierLifecycles: all.map(proof => ({ hostSessionId: proof.carrierHostSessionId, ownedLifecycle: proof.ownedLifecycle })) })
        if (saved.kind !== 'updated') throw new Error('归档保存冲突；已发生的停止未回滚。')
      }
      for (const root of roots) this.cold.delete(root.header.id)
      const actual = await this.read(snapshot.project.id)
      stop.release(); stop = undefined; this.release(snapshot.project.id, roots, whole)
      return this.result(actual, 'archived', 'complete', outcomes, '已归档；所属工作已停止，内容与后到消息保留。')
    } catch (error) {
      let actual: ProjectSnapshot
      try { actual = await this.read(snapshot.project.id) } catch { held = true; throw error }
      const stage = outcomes.length ? 'save-project-archive' as const : 'stop-current-work' as const
      stop?.release(); stop = undefined; this.release(snapshot.project.id, roots, whole)
      if (whole && !actual.project.archived) this.background?.resume(snapshot.project.id)
      return this.result(actual, 'failed', stage, outcomes,
        `归档未完成；已发生的停止不会自动回滚：${errorMessage(error)}`)
    } finally { if (!held) { stop?.release(); this.release(snapshot.project.id, roots, whole); if (whole && !this.current(roots[0]?.session.hostSessionId ?? '')?.project.archived) this.background?.resume(snapshot.project.id) } }
  }

  /** 全组cut先发布；全部已知真handle先收到取消，再等待有限接纳及真实close。 */
  private async stop(projectId: string, roots: readonly RootInspection[], whole: boolean, preserve: boolean) {
    if (whole) this.projectCuts.add(projectId)
    for (const root of roots) {
      this.cuts.set(root.header.id, { rootId: root.header.id, header: root.header, preserve })
      for (const member of root.members) this.cuts.set(member.header.id, { rootId: root.header.id, header: member.header, preserve })
    }
    for (const id of this.cuts.keys()) {
      const session = this.ctx.sessions.get(SessionId(id))
      if (session !== undefined) this.captureSession(session)
    }
    this.ports?.changed()
    const coldCuts = new Map(roots.filter(root => this.ctx.agents.get(root.header.id) === undefined)
      .map(root => [root.header.id, this.native().captureColdInbox(root.header.id)] as const))
    const native = this.native().prepareOwnedQuiescence(roots.map(root => ({ header: root.header, members: root.members })), {
      install: (agent, rootId) => {
        if (!this.cuts.has(agent.id)) this.cuts.set(agent.id, { rootId, header: agent.session.header, preserve })
        this.ports?.changed()
      },
      capture: session => this.captureSession(session),
      settle: agent => this.settle(agent),
      settleCold: (id, selected) => this.native().settleColdInbox(id, preserve, selected),
    })
    try {
      const ids = roots.flatMap(root => [root.header.id, ...root.members.map(member => member.header.id)])
      const admissions = this.ports?.drain(ids) ?? Promise.resolve()
      const background = whole ? this.background?.suspend(projectId) ?? Promise.resolve() : Promise.resolve()
      for (const id of ids) this.ctx.agents.get(SessionId(id))?.cancel({ kind: 'user' }, { keepInbox: true })
      native.stopKnown()
      const results = await Promise.allSettled([native.drained, admissions, background])
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, '所属工作关闭或保存未确认。')
      const members = (results[0] as PromiseFulfilledResult<readonly OwnedSubagentMember[]>).value
      for (const root of roots) {
        const agent = this.ctx.agents.get(root.header.id)
        if (agent !== undefined) {
          this.captureSession(agent.session)
          await this.settle(agent)
          const actual = await this.native().retire(root.header.id)
          if (actual.status !== 'stopped') throw new AggregateError(actual.errors, 'Project根会话关闭未确认。')
        } else await this.native().settleColdInbox(root.header.id, preserve, await coldCuts.get(root.header.id))
      }
      return { members, native, release: () => native.release() }
    } catch (error: unknown) {
      try { native.release() }
      catch (cleanup: unknown) { throw new AggregateError([error, cleanup], '所属工作责任交回未完成。') }
      throw error
    }
  }

  private async settle(agent: Agent): Promise<void> {
    const cut = this.cuts.get(agent.id)
    if (cut?.inbox === undefined) throw new Error(`会话 ${agent.id} 没有本动作首次Session交接，未猜测旧输入。`)
    await settleArchiveInbox(agent, cut.inbox)
    await this.flush(agent)
  }
  private async prepareNativeRestore(ids: readonly string[]): Promise<void> {
    const boundary = this.ports?.now() ?? new Date().toISOString()
    await this.withNativeDomain(domain => prepareSourceScheduleRestore(domain, ids.map(SessionId), boundary))
  }
  private async withNativeDomain(run: (domain: Domain<typeof scheduleDomain>) => Promise<void>): Promise<void> {
    const nativeRoot = this.ports?.nativeStorageDataRoot
    if (nativeRoot === undefined) throw new Error('原生存储根尚未由实际图owner提供。')
    await withProjectsScheduleDomain(this.ctx, nativeRoot, async domain => {
      for (const [id, task] of domain.table('tasks').entries()) if (id !== task.record.id) throw new Error('原生计划身份不一致。')
      await run(domain)
    })
  }

  private async restore(snapshot: ProjectSnapshot, sessions: readonly ProjectSession[], whole: boolean): Promise<ProjectLifecycleChangeResult> {
    let roots: readonly RootInspection[] | undefined
    let temporary: Awaited<ReturnType<typeof this.stop>> | undefined
    let releaseConfirmed = false
    let action: RestoreResponsibility | undefined
    try {
      if (this.closing) throw new Error('Host正在退出，不能释放归档工作。')
      roots = await Promise.all(sessions.map(session => this.inspect(session)))
      // 旧正常格式只在原Inbox实际无未分类输入时可证明；缺切点不猜、不清晚消息。
      for (const root of roots) if (root.session.ownedLifecycle === undefined) {
        for (const id of [root.header.id, ...root.members.map(member => member.header.id)]) {
          const pending = await this.native().captureColdInbox(SessionId(id))
          if (pending.length) throw new Error('旧归档缺少可还原的输入切点；保留所有未分类消息和归档状态，本次恢复未完成。')
        }
      }
      action = { projectId: snapshot.project.id, whole, roots }
      if (whole && roots.length === 0) this.rootlessRestores.set(snapshot.project.id, action)
      if (whole) this.projectCuts.add(snapshot.project.id)
      for (const root of roots) {
        this.cuts.set(root.header.id, { rootId: root.header.id, header: root.header, preserve: true, restore: action })
        for (const member of root.members) this.cuts.set(member.header.id, { rootId: root.header.id, header: member.header, preserve: true, restore: action })
      }
      this.ports?.changed()
      const legacy = roots.filter(root => root.session.ownedLifecycle === undefined)
      if (legacy.length) {
        temporary = await this.stop(snapshot.project.id, legacy, whole, true)
        for (const cut of this.cuts.values()) if (roots.some(root => root.header.id === cut.rootId)) cut.restore = action
      }
      action.quiescence = temporary?.native
      action.releaseNative = temporary?.release
      const ids = roots.flatMap(root => [root.header.id, ...root.members.map(member => member.header.id)])
      await this.prepareNativeRestore(ids)
      const proofs = roots.map(root => ({ sessionId: root.session.id, carrierHostSessionId: root.header.id, ownedLifecycle: root.session.ownedLifecycle
        ?? { contract: 'archive-v1' as const, rootHeader: root.header,
          members: (temporary?.members ?? root.members).filter(member => belongsTo(root.header.id, member, temporary?.members ?? root.members)) } }))
      if (whole) {
        const saved = await this.store.setProjectArchived(snapshot.project.id, false, lifecycleRosterOf(snapshot.sessions), legacy.length ? proofs : undefined, committed => { action!.committed = committed })
        if (saved.kind !== 'updated') throw new Error('恢复保存未确认。')
      } else {
        let expectedRevision = sessions[0]!.revision
        if (legacy.length) {
          const confirmed = await this.store.commitExecutionArchive({ projectId: snapshot.project.id,
            sessionId: sessions[0]!.id, expectedRevision, carrierLifecycles: proofs.map(proof => ({ hostSessionId: proof.carrierHostSessionId, ownedLifecycle: proof.ownedLifecycle })) })
          if (confirmed.kind !== 'updated') throw new Error('旧状态真实停止结果保存未确认。')
          expectedRevision = confirmed.session.revision
        }
        const saved = await this.store.updateSession(snapshot.project.id, sessions[0]!.id, { archived: false }, { expectedRevision }, committed => { action!.committed = committed })
        if (saved.kind !== 'updated') throw new Error('恢复保存冲突。')
      }
      const actual = await this.store.getSnapshot(snapshot.project.id)
      const result = this.finishRestore(actual, action)
      releaseConfirmed = true
      return result
    } catch (error) {
      const actual = await this.store.getSnapshot(snapshot.project.id)
      return this.result(actual, 'failed', 'prepare-project-restore', [], `恢复未完成；内容与未分类消息保留：${errorMessage(error)}`)
    } finally {
      // 失败时若owner仍归档可解除本动作持有；已变active但未确认release必须保持精确cut。
      if (!releaseConfirmed && roots !== undefined && action?.committed === undefined) {
        if (whole && roots.length === 0) {
          if (this.rootlessRestores.get(snapshot.project.id) === action) this.rootlessRestores.delete(snapshot.project.id)
          this.release(snapshot.project.id, roots, whole)
        } else {
          const current = this.current(roots[0]?.header.id ?? '')
          if ((whole && current?.project.archived) || (!whole && current?.session.archived)) {
            temporary?.release(); this.release(snapshot.project.id, roots, whole)
          }
        }
      }
    }
  }
  private async continueRestore(snapshot: ProjectSnapshot, action: RestoreResponsibility): Promise<ProjectLifecycleChangeResult> {
    try {
      if (this.closing) throw new Error('Host正在退出，不能继续恢复。')
      const receipt = action.committed!.snapshot
      if (snapshot.project.archived || snapshot.project.sourceLifecycle !== undefined
        || action.roots.length === 0 && !sameRoster(snapshot.sessions, receipt.sessions) || action.roots.some(root => {
        const saved = receipt.sessions.find(row => row.id === root.session.id)
        const current = snapshot.sessions.find(row => row.id === root.session.id)
        return saved === undefined || current === undefined || current.sourceLifecycle.kind !== 'available' || current.archived
          || current.hostSessionId !== saved.hostSessionId || !isDeepStrictEqual(current.ownedLifecycle, saved.ownedLifecycle)
      })) throw new Error('本次恢复提交的精确目标已变化；未释放原切点。')
      // 只确认原提交尚未完成的source交接，不再停止、清Inbox、保存或准备计划。
      const confirmed = await action.committed!.confirmSource()
      return this.finishRestore(confirmed, action)
    } catch (error) {
      return this.result(snapshot, 'failed', 'prepare-project-restore', [], `恢复未完成；请沿原入口继续本次恢复：${errorMessage(error)}`)
    }
  }
  private finishRestore(snapshot: ProjectSnapshot, action: RestoreResponsibility): ProjectLifecycleChangeResult {
    if (this.closing) throw new Error('Host正在退出，不能释放归档工作。')
    const { projectId, roots, whole } = action
    const rootless = this.rootlessRestores.get(projectId) === action
    const held = [...this.cuts].filter(([, cut]) => cut.restore === action)
    const oldProjectTime = this.projectRestoredAt.get(projectId)
    const oldSessionTime = whole ? undefined : this.sessionRestoredAt.get(roots[0]!.header.id)
    const oldCold = roots.map(root => [root.header.id, this.cold.get(root.header.id)] as const)
    for (const root of roots) this.cold.delete(root.header.id)
    const boundary = this.ports?.captureBoundary?.() ?? { at: this.ports?.now() ?? new Date().toISOString() }
    if (whole) this.projectRestoredAt.set(projectId, boundary)
    else this.sessionRestoredAt.set(roots[0]!.header.id, boundary)
    for (const [id] of held) this.cuts.delete(id)
    if (rootless) this.rootlessRestores.delete(projectId)
    if (whole) this.projectCuts.delete(projectId)
    try { this.publish(snapshot) }
    catch (error) {
      for (const [id, cut] of held) this.cuts.set(id, cut)
      if (rootless) this.rootlessRestores.set(projectId, action)
      if (whole) this.projectCuts.add(projectId)
      for (const [id, value] of oldCold) if (value !== undefined) this.cold.set(id, value)
      if (oldProjectTime === undefined) this.projectRestoredAt.delete(projectId); else this.projectRestoredAt.set(projectId, oldProjectTime)
      if (!whole) {
        if (oldSessionTime === undefined) this.sessionRestoredAt.delete(roots[0]!.header.id); else this.sessionRestoredAt.set(roots[0]!.header.id, oldSessionTime)
      }
      // 同步撤回未确认的release投影，原驾驶cut在任一异步消费者运行前恢复。
      try { this.ports?.changed() } catch (rollback) { this.ctx.logger.warn(`projects: restore source remains unconfirmed: ${errorMessage(rollback)}`) }
      throw error
    }
    action.releaseNative?.(); action.releaseNative = undefined
    if (whole) this.background?.resume(projectId)
    void this.ports?.hint().catch(error => this.ctx.logger.warn(`projects: future schedule hint failed: ${errorMessage(error)}`))
    return this.result(snapshot, 'restored', 'complete', [], '已恢复；没有发送消息或自动重放旧工作，仅等待未来计划。')
  }
  private release(projectId: string, roots: readonly RootInspection[], whole: boolean): void {
    const ids = new Set<string>(roots.map(root => root.header.id))
    for (const [id, cut] of this.cuts) if (ids.has(cut.rootId)) this.cuts.delete(id)
    if (whole) this.projectCuts.delete(projectId)
    this.ports?.changed()
  }
  private async read(id: string): Promise<ProjectSnapshot> { const snapshot = await this.store.getSnapshot(id); this.publish(snapshot); return snapshot }
  private target(snapshot: ProjectSnapshot, session: ProjectSession): LifecycleTarget {
    if (session.role !== 'main' && session.role !== 'execution') throw new Error('后台会话不能独立处理。')
    return { project: { id: snapshot.project.id, archived: snapshot.project.archived }, session: { id: session.id, projectId: session.projectId,
      hostSessionId: session.hostSessionId, role: session.role, archived: session.archived }, scheduledTaskCount: 0 }
  }
  private result(snapshot: ProjectSnapshot, kind: ProjectLifecycleChangeResult['kind'], stage: ProjectLifecycleChangeResult['stage'],
    outcomes: readonly ProjectLifecycleSessionOutcome[], message: string): ProjectLifecycleChangeResult {
    return { kind, stage, snapshot, sessions: snapshot.sessions.map(session => outcomes.find(row => row.sessionId === session.id)
      ?? { sessionId: session.id, role: session.role, quiescence: session.archived ? 'already-session-archived' : 'not-checked' }),
      admissionHeld: snapshot.project.archived || this.projectCuts.has(snapshot.project.id) || snapshot.sessions.some(row => this.cuts.has(row.hostSessionId)), message }
  }
  private async flush(agent: Agent): Promise<void> {
    if (!await this.ctx.sessions.flush(agent.session)) throw new LifecycleStoppedPersistenceError('原生会话保存未确认。')
  }
}
function rosterOf(sessions: readonly ProjectSession[]): readonly ProjectSessionRosterEntry[] { return sessions.flatMap(session => (session.carriers ?? [{hostSessionId:session.hostSessionId}]).map(carrier => ({id:session.id,hostSessionId:carrier.hostSessionId,role:session.role,archived:session.archived}))) }
/** Store CAS selects logical sessions with any available carrier; retain their complete carrier identities. */
function lifecycleRosterOf(sessions: readonly ProjectSession[]): readonly ProjectSessionRosterEntry[] {
  return rosterOf(sessions.filter(session => (session.carriers ?? [session]).some(carrier => carrier.sourceLifecycle.kind === 'available')))
}
function sameRoster(a: readonly ProjectSession[], b: readonly ProjectSession[]): boolean { return isDeepStrictEqual(rosterOf(a), rosterOf(b)) }
function belongsTo(root: string, member: OwnedSubagentMember, members: readonly OwnedSubagentMember[]): boolean {
  let parent = String(member.parentSessionId)
  const visited = new Set<string>()
  while (parent !== root) { if (visited.has(parent)) return false; visited.add(parent); const next = members.find(row => row.header.id === parent); if (next === undefined) return false; parent = next.parentSessionId }
  return true
}
function latest(a?: string, b?: string): string | undefined { return a === undefined ? b : b === undefined ? a : Date.parse(a) >= Date.parse(b) ? a : b }
function errorMessage(error: unknown): string { return error instanceof AggregateError ? `${error.message}: ${error.errors.map(errorMessage).join('; ')}` : error instanceof Error ? error.message : String(error) }

function carrierSessions(session: ProjectSession): ProjectSession[] {
  return (session.carriers ?? [{ hostSessionId: session.hostSessionId, sourceLifecycle: session.sourceLifecycle, ownedLifecycle: session.ownedLifecycle }])
    .filter(carrier => carrier.sourceLifecycle.kind === 'available')
    .map(carrier => ({ ...session, carriers: undefined, hostSessionId: carrier.hostSessionId, sourceLifecycle: carrier.sourceLifecycle, ownedLifecycle: carrier.ownedLifecycle }))
}
