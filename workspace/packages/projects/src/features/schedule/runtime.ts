import { durableMutationDetails } from '../../metadata-errors.ts'
import type { RootWriteScope } from '../../metadata-files.ts'
import type { ScheduleState } from './validation.ts'
import type { ProjectSchedule, ScheduleRunLink, ScheduleRunObservation, ScheduleRunView, ScheduleRunReader, ScheduleSession, ScheduleAccess, ScheduleRequest, RunNowScheduleInput, ManualRunAdmissionResult, ScheduleMetadataFailure, SchedulePendingConsumer, ScheduleDecisionInput, ScheduleDecision } from './contract.ts'
import { ProjectScheduleStore } from './store.ts'
import { decideSchedule, instant, nextScheduleTime, savedUnknownRangeUpper, qualificationUnknownReason } from './timing.ts'
import { scheduleOccurrenceId, scheduleRuleIdentity, manualScheduleOccurrenceId, parseScheduleMessageSource, currentScheduleObservations } from './native.ts'
import { runLinkSchema } from './validation.ts'
import { renderSchedulePrompt } from './pending.ts'
import { scheduleRunTiming } from './request-context.ts'
import type { ProjectScheduleMessageSource, ScheduleNativeObservation } from './native.ts'
import { unknownSchedulePowerFacts } from './power-facts.ts'
import type { SchedulePowerFacts, SchedulePowerFact, DarwinSchedulePowerFact, ScheduleClockBoundary } from './power-facts.ts'

export interface ScheduleRuntimeTarget extends ScheduleSession { projectId: string; projectDirectory: string }
export interface SchedulePreparedTarget {
  observations(): readonly ScheduleNativeObservation[]
  send(source: ProjectScheduleMessageSource, prompt: string): string
  flush(): Promise<boolean>
  prepareInput?(source: ProjectScheduleMessageSource, prompt: string): { messageId: string; send(): void }
  pending?: SchedulePendingConsumer
}
/** Invoke the original resolver once and return that exact promise; only the real caller supplies this seam. */
export type SchedulePreparationStart = <T>(operation: () => Promise<T>) => Promise<T>
export interface ScheduleRuntimeHost {
  projects(): Promise<readonly { projectId: string; projectDirectory: string }[]>
  targets(projectId: string): Promise<readonly ScheduleRuntimeTarget[]>
  native(target: ScheduleRuntimeTarget): Promise<readonly ScheduleNativeObservation[]>
  prepare(target: ScheduleRuntimeTarget, start?: SchedulePreparationStart): Promise<SchedulePreparedTarget>
  prepareConfiguration?(target: ScheduleRuntimeTarget): Promise<SchedulePendingConsumer>
  current(target: ScheduleRuntimeTarget): { projectArchived: boolean; sessionArchived: boolean; projectRestoredAt?: string; sessionRestoredAt?: string;
    projectRestoredBaselineEpoch?: number; sessionRestoredBaselineEpoch?: number }
  /** Resolve the stable target under the shared main admission owner, through native and run-link saves. */
  withTargetAdmission<T>(target: ScheduleRuntimeTarget, operation: string,
    run: (actualTarget: ScheduleRuntimeTarget, assertCurrent: () => void) => Promise<T>): Promise<T>
  /** active 核当前可接纳目标；settlement 允许结算已接纳/失败尝试，均使用 fresh Core。 */
  withMetadataWrite<T>(target: ScheduleRuntimeTarget, activity: 'active' | 'settlement',
    action: (scope: RootWriteScope) => Promise<T>, signal?: AbortSignal, authorization?: ScheduleAccess): Promise<T>
  access?(request: ScheduleRequest): Promise<ScheduleAccess>
}
/** Internal dependency injection only; Config/Remote/browser/model cannot supply these values. */
export interface ScheduleRuntimeDependencies {
  powerFacts: SchedulePowerFacts
  clock?: () => string
  timer?: { set(callback: () => void, delay: number): unknown; clear(handle: unknown): void }
}
export type ControlledScheduleDependencies = ScheduleRuntimeDependencies
export interface ScheduleAttemptFact {
  key: string; projectId: string; sessionId: string; plannedAt: string
  phase: 'preparing' | 'settled'; persisted: boolean; nativeInserted: boolean
  messageId?: string; observation?: ScheduleRunObservation; error?: string; metadata?: ScheduleMetadataFailure
  /** 真正准备调用经过前后有效取样才成立；attempt map 的占位不授予此资格。 */
  preparation?: NonNullable<ScheduleDecisionInput['preparation']>
  /** 已如实记录unknown范围后的易失候选推进；不是恢复点、漏跑结论或持久重试票据。 */
  advanceAfter?: string
}

/** Recheck unreadable catalog/configuration sources; never a retry of an attempted occurrence. */
const FAILED_SCAN_RECHECK_MS = 1_000

/** Coordinates only admission and observation. Native Inbox remains the only execution queue. */
export class ProjectScheduleRuntime {
  private facts = unknownSchedulePowerFacts()
  private clock: () => string = () => new Date().toISOString()
  private timer: ControlledScheduleDependencies['timer']
  private timerHandle: unknown
  private readyAt?: string
  private readyBaselineEpoch?: number
  private readonly activationBoundaries = new Map<string, ScheduleClockBoundary & { projectId: string }>()
  private closing = false
  private hostReady = false
  private running?: Promise<void>
  private requested = false
  private readonly attempted = new Map<string, ScheduleAttemptFact>()
  private readonly candidates = new Map<string, string | undefined>()
  private connection?: 'controlled' | 'host'
  private latestPower?: SchedulePowerFact
  private lastNativePower?: DarwinSchedulePowerFact
  private readonly diagnostics = new Map<string, string>()

  constructor(private readonly host: ScheduleRuntimeHost) {}

  markHostReady(): void { if (!this.closing) this.hostReady = true }
  withTargetOperation<T>(target: ScheduleRuntimeTarget, operation: () => Promise<T>): Promise<T> {
    if (this.closing || !this.hostReady) return Promise.reject(new Error('项目服务尚未就绪或正在退出。'))
    return this.host.withTargetAdmission(target, 'schedule-configuration', async (_actualTarget, assertCurrent) => {
      assertCurrent()
      return operation()
    })
  }
  prepareWorkTarget(target: ScheduleRuntimeTarget): Promise<SchedulePreparedTarget> { return this.host.prepare(target) }
  async preparePending(target: ScheduleRuntimeTarget): Promise<SchedulePendingConsumer> {
    if (this.closing || !this.hostReady) throw new Error('项目服务尚未就绪或正在退出。')
    if (this.host.prepareConfiguration !== undefined) return this.host.prepareConfiguration(target)
    const prepared = await this.host.prepare(target)
    if (prepared.pending === undefined) throw new Error('原会话待执行修改尚未接通。')
    return prepared.pending
  }

  /** 用户主动请求只借用原目标有限操作与普通 Inbox，不接触自动时隙和恢复事实。 */
  async runNow(request: ScheduleRequest, access: ScheduleAccess, input: RunNowScheduleInput): Promise<ManualRunAdmissionResult> {
    const requestId = access.manualRequestId ?? input.requestId
    const base: ManualRunAdmissionResult = { kind: 'rejected', projectId: access.projectId,
      scheduleId: input.scheduleId, requestId, admission: 'not-enqueued', runLinkSaved: 'not-applicable',
      nativeSaved: 'not-applicable', taskOutcome: 'unknown' }
    if (!this.hostReady || this.closing) return { ...base, error: '项目服务尚未就绪或正在退出。' }
    request.signal?.throwIfAborted()
    const store = new ProjectScheduleStore(access.projectId, access.projectDirectory)
    let definition: ProjectSchedule | undefined
    try { definition = (await store.read()).schedules.find(item => item.id === input.scheduleId) }
    catch (error) { return { ...base, kind: 'unknown', error: `计划读取未确认：${describe(error)}` } }
    if (definition === undefined || definition.revision !== input.expectedRevision) return { ...base, kind: 'conflict', current: definition }
    const session = access.sessions.find(item => item.id === definition.sessionId)
    const actor = access.actor
    if (session === undefined || (actor.kind === 'session' && access.sessions.find(item => item.id === actor.sessionId)?.role !== 'main'
      && actor.sessionId !== session.id)) return { ...base, error: '本次调用不能运行该计划目标。' }
    const target: ScheduleRuntimeTarget = { ...session, projectId: access.projectId, projectDirectory: access.projectDirectory }
    let sendInvoked = false, sendConfirmed = false
    let lastResult: ManualRunAdmissionResult = base
    try {
      return await this.host.withTargetAdmission(target, `schedule-manual:${input.scheduleId}:${requestId}`, async (target, assertCurrent) => {
        assertCurrent()
        request.signal?.throwIfAborted()
        const key = manualScheduleOccurrenceId(definition!, requestId)
        // 严格读取同一稳定会话的全部真实承载；旧请求不为查询而准备新current。
        const observations = await this.host.native(target)
        const native = currentScheduleObservations(observations)
        const latestAccess = this.host.access === undefined ? access : await this.host.access(request)
        if (latestAccess.projectId !== access.projectId || JSON.stringify(latestAccess.actor) !== JSON.stringify(access.actor)
          || (latestAccess.manualRequestId ?? requestId) !== requestId) throw new Error('运行调用身份已变化。')
        request.signal?.throwIfAborted()
        const retained = native.find(row => row.source.trigger === 'manual' && row.source.projectId === target.projectId
          && row.source.sessionId === target.id && row.source.scheduleId === definition!.id
          && row.source.occurrenceId === key && row.source.requestId === requestId)
        const stored = (await store.read()).runs.find(item => item.id === key)
        if (retained !== undefined || stored !== undefined) {
          const link = stored ?? this.nativeLink(retained!)
          const originalHost = retained?.hostSessionId ?? link.refs.find(ref => ref.kind === 'message' || ref.kind === 'turn' || ref.kind === 'tool')?.hostSessionId
          return { ...base, kind: 'existing', sessionId: target.id, ...(originalHost === undefined ? {} : { hostSessionId: originalHost }),
            requestedAt: retained?.source.plannedAt ?? link.plannedAt, admission: retained === undefined ? link.observation?.admission ?? 'unknown' : 'enqueued',
            link, runLinkSaved: stored === undefined ? 'unconfirmed' : 'confirmed', nativeSaved: 'unconfirmed',
            ...(retained === undefined ? { status: 'unknown' } : { native: this.nativeView(retained, observations), status: this.rowStatus(retained) }) }
        }
        assertCurrent()
        const prepared = await this.host.prepare(target)
        let result = { ...base, sessionId: target.id, hostSessionId: target.hostSessionId }
        let inserted = false
        try {
          await this.change(target, 'active', store, state => {
            request.signal?.throwIfAborted()
            assertCurrent()
            const current = this.host.current(target)
            if (this.closing || current.projectArchived || current.sessionArchived) throw new Error('原目标已停止接纳新的工作。')
            if (!latestAccess.sessions.some(item => item.id === target.id && item.hostSessionId === target.hostSessionId)) throw new Error('原目标归属已变化。')
            const live = state.schedules.find(item => item.id === input.scheduleId)
            if (live === undefined || live.sessionId !== target.id || live.revision !== input.expectedRevision) {
              result = { ...result, kind: 'conflict', current: live }; return
            }
            const preparedObservations = prepared.observations()
            const existing = currentScheduleObservations(preparedObservations).find(row => row.source.trigger === 'manual'
              && row.source.projectId === target.projectId && row.source.sessionId === target.id
              && row.source.scheduleId === live.id && row.source.occurrenceId === key && row.source.requestId === requestId)
            if (existing !== undefined) {
              const link = state.runs.find(item => item.id === key) ?? this.nativeLink(existing)
              result = { ...result, kind: 'existing', requestedAt: existing.source.plannedAt, admission: 'enqueued',
                link, runLinkSaved: state.runs.some(item => item.id === key) ? 'confirmed' : 'unconfirmed',
                nativeSaved: 'unconfirmed', native: this.nativeView(existing, preparedObservations), status: this.rowStatus(existing) }
              return
            }
            // 已保留关联而原生事实缺失时不把缺失解释为重发许可。
            const previous = state.runs.find(item => item.id === key)
            if (previous !== undefined) { result = { ...result, kind: 'existing', link: previous,
              admission: previous.observation?.admission ?? 'unknown', runLinkSaved: 'confirmed', status: 'unknown' }; return }
            const requestedAt = new Date().toISOString()
            const source = parseScheduleMessageSource({ kind: 'project-schedule', projectId: target.projectId, sessionId: target.id,
              scheduleId: live.id, occurrenceId: key, trigger: 'manual', plannedAt: requestedAt, requestedAt, requestId,
              acceptedRevision: live.revision, definitionRevision: live.revision, ruleIdentity: scheduleRuleIdentity(live),
              managementSources: live.updatedBy.sources, requestedBy: latestAccess.actor.kind === 'user'
                ? { kind: 'user', sources: [...latestAccess.managementSources] }
                : { kind: 'session', sessionId: latestAccess.actor.sessionId, sources: [...latestAccess.managementSources] } })
            if (prepared.prepareInput === undefined) throw new Error('原会话主动运行入口未接通。')
            const message = prepared.prepareInput(source, renderSchedulePrompt(live, 'manual'))
            const link = runLinkSchema.parse({ id: key, projectId: target.projectId, sessionId: target.id, scheduleId: live.id,
              plannedAt: requestedAt, observedAt: requestedAt, trigger: 'manual', refs: [{ kind: 'message', hostSessionId: target.hostSessionId, messageId: message.messageId }],
              observation: { occurrenceId: key, ruleIdentity: source.ruleIdentity, definitionRevision: live.revision,
                admission: 'enqueued', outcome: 'enqueued', reason: '本次主动运行已进入原会话普通队列。', admittedAt: requestedAt } }) as ScheduleRunLink
            result = { ...result, requestedAt, runLinkSaved: 'unconfirmed', nativeSaved: 'unconfirmed' }
            assertCurrent()
            try { sendInvoked = true; message.send(); inserted = sendConfirmed = true }
            catch (error) {
              const actual = currentScheduleObservations(prepared.observations()).find(row => row.source.occurrenceId === key)
              inserted = actual?.inserted === true
              sendConfirmed ||= inserted
              result = { ...result, kind: 'unknown', admission: inserted ? 'enqueued' : 'unknown', error: `本次入队未确认：${describe(error)}` }
              if (!inserted) return
            }
            result = { ...result, link, kind: result.kind === 'unknown' ? 'unknown' : 'accepted', admission: 'enqueued', status: 'queued' }
            state.runs.push(link)
          }, latestAccess, request.signal)
          if (inserted) result.runLinkSaved = 'confirmed'
        } catch (error) {
          result = { ...result, kind: inserted || sendInvoked ? 'unknown' : 'rejected', admission: inserted ? 'enqueued' : sendInvoked ? 'unknown' : 'not-enqueued',
            error: `本次运行关联未确认：${describe(error)}`,
            ...(durableMutationDetails(error) === undefined ? {} : { metadata: durableMutationDetails(error) }) }
        }
        // 已send以后不再受等待者signal支配；原target operation一直涵盖两份有限保存。
        if (inserted || result.kind === 'existing' && result.admission === 'enqueued') {
          try { result.nativeSaved = await prepared.flush() ? 'confirmed' : 'unconfirmed' }
          catch (error) { result.nativeSaved = 'unconfirmed'; result.error = [result.error, `原会话保存未确认：${describe(error)}`].filter(Boolean).join('；') }
        }
        lastResult = result
        return result
      })
    } catch (error) { return { ...lastResult, kind: sendInvoked ? 'unknown' : lastResult.kind,
      admission: sendConfirmed ? 'enqueued' : sendInvoked ? 'unknown' : lastResult.admission, error: describe(error),
      ...(durableMutationDetails(error) === undefined ? {} : { metadata: durableMutationDetails(error) }) } }
  }

  async prepareRunRead(access: ScheduleAccess): Promise<ScheduleRunReader> {
    const actor = access.actor
    const targets = access.sessions.filter(session => actor.kind === 'user'
      || access.sessions.find(item => item.id === actor.sessionId)?.role === 'main' || actor.sessionId === session.id)
    const links: ScheduleRunLink[] = []
    const snapshots = new Map<string, Map<string, ScheduleNativeObservation[]>>()
    for (const target of targets) {
      const rows = structuredClone(await this.host.native({ ...target,
        projectId: access.projectId, projectDirectory: access.projectDirectory }))
      const byMessage = new Map<string, ScheduleNativeObservation[]>()
      for (const row of rows) {
        const key = JSON.stringify([row.hostSessionId, row.messageId])
        const versions = byMessage.get(key) ?? []
        versions.push(row); byMessage.set(key, versions)
      }
      snapshots.set(target.id, byMessage)
      for (const row of currentScheduleObservations(rows)) {
        if (row.source.projectId === access.projectId && row.source.sessionId === target.id) links.push(this.nativeLink(row))
      }
    }
    return { nativeLinks: links, readStatus: link => {
      if (link.projectId !== access.projectId || !snapshots.has(link.sessionId)) throw new Error('运行来源不是当前可管理工作会话。')
      return this.readRunSnapshot(snapshots.get(link.sessionId)!, link)
    } }
  }
  private nativeLink(row: ScheduleNativeObservation): ScheduleRunLink {
    return runLinkSchema.parse({ id: row.source.occurrenceId, projectId: row.source.projectId, sessionId: row.source.sessionId,
      scheduleId: row.source.scheduleId, trigger: row.source.trigger, plannedAt: row.source.plannedAt,
      observedAt: new Date(row.insertedAt ?? Date.parse(row.source.plannedAt)).toISOString(),
      refs: [{ kind: 'message', hostSessionId: row.hostSessionId, messageId: row.messageId }], observation: {
        occurrenceId: row.source.occurrenceId, ruleIdentity: row.source.ruleIdentity, definitionRevision: row.source.definitionRevision,
        admission: 'enqueued', outcome: 'enqueued', reason: '从原会话真实持久来源读取；未补写运行关联。' } }) as ScheduleRunLink
  }
  private nativeView(row: ScheduleNativeObservation, observations: readonly ScheduleNativeObservation[]) { return { messageId: row.messageId, inserted: row.inserted, claimed: row.claimed,
    discarded: row.discarded, ...(row.turn === undefined ? {} : { turn: row.turn }), ...(row.end === undefined ? {} : { end: row.end }),
    ...(row.error === undefined ? {} : { error: row.error }), timing: scheduleRunTiming(row, observations) } }
  private rowStatus(row: ScheduleNativeObservation): ScheduleRunView['status'] {
    return row.end === 'error' ? 'execution-failed' : row.discarded || row.end !== undefined ? 'unknown' : row.claimed ? 'processing' : row.inserted ? 'queued' : 'unknown'
  }

  /** The single installed Runtime is connected by a private fixture, never by product configuration. */
  async connectControlled(dependencies: ControlledScheduleDependencies): Promise<void> { return this.connect(dependencies, 'controlled') }
  /** Call only after the real Host appReady/Runtime initialization; first read creates the provider baseline. */
  async connectHost(dependencies: ScheduleRuntimeDependencies): Promise<void> {
    if (!this.hostReady) throw new Error('真实Host尚未就绪，不能建立电源基线。')
    return this.connect(dependencies, 'host')
  }
  currentPowerFact(): SchedulePowerFact {
    return structuredClone(this.latestPower ?? { kind: 'unknown', reason: '自动定时电源事实尚未读取。' })
  }
  private async connect(dependencies: ScheduleRuntimeDependencies, connection: 'controlled' | 'host'): Promise<void> {
    if (this.readyAt !== undefined || this.closing) throw new Error('定时接入已初始化或正在退出。')
    this.connection = connection
    this.facts = dependencies.powerFacts
    this.clock = dependencies.clock ?? (() => new Date().toISOString())
    this.timer = dependencies.timer ?? {
      set: (callback, delay) => { const handle = setTimeout(callback, delay); handle.unref(); return handle },
      clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }
    // 到点时由attempt核Store与原生来源。丢弃结果的全局预读不能成为所有项目的连接前提。
    // 第一次业务事实读取严格晚于真实appReady；不把ready前旧wake回推成许可。
    if (this.closing) throw new Error('Host退出期间不再建立自动定时基线。')
    const baseline = this.readPower()
    this.readyAt = baseline.now
    this.readyBaselineEpoch = baseline.power.kind === 'known' && baseline.power.provenance === 'darwin-kernel' ? baseline.power.baselineEpoch : undefined
    await this.hint()
  }

  get status(): { automaticDispatch: 'not-connected' | 'connected'; controlled: boolean; hostConnected: boolean; readyAt?: string; closing: boolean } {
    return { automaticDispatch: this.readyAt !== undefined && this.connection === 'host' && !this.closing ? 'connected' : 'not-connected', controlled: this.readyAt !== undefined && this.connection === 'controlled', hostConnected: this.readyAt !== undefined && this.connection === 'host',
      ...(this.readyAt === undefined ? {} : { readyAt: this.readyAt }), closing: this.closing }
  }
  observations(): { attempts: ScheduleAttemptFact[]; diagnostics: Array<{ projectId: string; reason: string }> } {
    return structuredClone({ attempts: [...this.attempted.values()], diagnostics: [...this.diagnostics].map(([projectId, reason]) => ({ projectId, reason })) })
  }
  currentTime(): string { return this.now() }
  captureBoundary(): ScheduleClockBoundary {
    const { power, now } = this.readPower()
    return { at: now, ...(power.kind === 'known' && power.provenance === 'darwin-kernel' ? { baselineEpoch: power.baselineEpoch } : {}) }
  }
  configurationCommitted(previous: ProjectSchedule | undefined, current: ProjectSchedule | undefined, boundary: ScheduleClockBoundary): void {
    if (current !== undefined && current.enabled && (previous === undefined || !previous.enabled
      || scheduleRuleIdentity(previous) !== scheduleRuleIdentity(current))) {
      this.activationBoundaries.set(`${current.id}:${scheduleRuleIdentity(current)}`, { ...boundary, projectId: current.projectId })
    }
  }

  /** A hint carries no power fact and cannot turn on the default product path. */
  hint(): Promise<void> {
    if (this.readyAt === undefined || this.closing) return Promise.resolve()
    this.requested = true
    if (this.running !== undefined) return this.running
    this.clearTimer()
    let scanFailed = false
    this.running = (async () => {
      do { this.requested = false; scanFailed = await this.drive() } while (this.requested && !this.closing)
    })().finally(() => { this.running = undefined; if (!this.closing) this.arm(scanFailed) })
    return this.running
  }
  /** Synchronous cut, immediately followed by the original Agent/B stopping work in the owner. */
  closeAdmission(): Promise<void> {
    this.closing = true; this.clearTimer()
    return this.running ?? Promise.resolve()
  }
  disposeFacts(): void { this.facts.dispose() }

  private readRunSnapshot(byMessage: ReadonlyMap<string, readonly ScheduleNativeObservation[]>, link: ScheduleRunLink): Omit<ScheduleRunView, 'link'> {
    const rows = link.refs.flatMap(ref => ref.kind === 'message' ? byMessage.get(JSON.stringify([ref.hostSessionId, ref.messageId])) ?? [] : [])
    const row = rows.find(item => item.current && item.source.trigger === link.trigger && item.source.projectId === link.projectId && item.source.sessionId === link.sessionId
      && item.source.scheduleId === link.scheduleId && item.source.plannedAt === link.plannedAt
      && (link.observation === undefined || item.source.occurrenceId === link.observation.occurrenceId)
      && link.refs.some(ref => ref.kind === 'message' && ref.messageId === item.messageId && ref.hostSessionId === item.hostSessionId))
    if (row === undefined) return { status: 'unknown', taskOutcome: 'unknown', note: link.observation?.reason ?? '真实运行来源尚未确认。' }
    const native = this.nativeView(row, rows)
    if (row.end === 'error') return { status: 'execution-failed', native, taskOutcome: 'unknown', note: row.error ?? '原生回合发生错误。' }
    if (row.discarded) return { status: 'unknown', native, taskOutcome: 'unknown', note: '原生待执行输入已取消，未据此重跑。' }
    if (row.end !== undefined) return { status: 'unknown', native, taskOutcome: 'unknown', note: row.end === 'completed'
      ? '回合已结束；任务是否达成须查看原会话。' : `原生回合已结束：${row.end}。` }
    if (row.claimed) return { status: 'processing', native, taskOutcome: 'unknown' }
    return { status: row.inserted ? 'queued' : 'unknown', native, taskOutcome: 'unknown' }
  }

  private async drive(): Promise<boolean> {
    // 每个hint重新取事实；即便尚无到期项，状态也不能滞留在上次已知样本。
    this.readPower()
    const active = new Set<string>()
    let scanFailed = false
    let projects: Awaited<ReturnType<ScheduleRuntimeHost['projects']>>
    try { projects = await this.host.projects() }
    catch (error) { this.diagnostics.set('host', describe(error)); return true }
    for (const project of projects) {
      if (this.closing) return scanFailed
      try {
        const store = new ProjectScheduleStore(project.projectId, project.projectDirectory)
        const state = await store.read()
        const targets = await this.host.targets(project.projectId)
        // 只有已确认定义/历史均清除且真实来源没有未开始项，才释放本项目易失防重事实。
        if (state.schedules.length === 0 && state.runs.length === 0
          && ([...this.attempted.values()].some(fact => fact.projectId === project.projectId)
            || [...this.activationBoundaries.values()].some(boundary => boundary.projectId === project.projectId))) {
          let pending = false
          for (const target of targets) {
            const rows = await this.host.native(target)
            pending ||= currentScheduleObservations(rows).some(row => row.pending !== undefined || row.inserted && !row.claimed && !row.discarded)
          }
          if (!pending) {
            await store.readWith(latest => {
              if (latest.schedules.length !== 0 || latest.runs.length !== 0) return
              for (const [key, fact] of this.attempted) if (fact.projectId === project.projectId && fact.phase === 'settled') this.attempted.delete(key)
              for (const [key, boundary] of this.activationBoundaries) if (boundary.projectId === project.projectId) this.activationBoundaries.delete(key)
            })
          }
        }
        for (const schedule of state.schedules) {
          if (this.closing) return scanFailed
          if (!schedule.enabled) continue
          const target = targets.find(item => item.id === schedule.sessionId)
          if (target === undefined) { this.diagnostics.set(project.projectId, '计划目标不是当前可用的原项目工作会话。'); continue }
          let current: ReturnType<ScheduleRuntimeHost['current']>
          try { current = this.host.current(target) } catch { continue }
          if (current.projectArchived || current.sessionArchived) continue
          const ruleKey = `${schedule.id}:${scheduleRuleIdentity(schedule)}`
          active.add(ruleKey)
          let plannedAt = this.candidates.has(ruleKey) ? this.candidates.get(ruleKey) : schedule.anchorAt
          while (plannedAt !== undefined && instant(plannedAt) <= instant(this.now()) && !this.closing) {
            const key = scheduleOccurrenceId(schedule, plannedAt)
            const stored = state.runs.find(item => item.id === key || item.observation?.occurrenceId === key)
            if (!this.attempted.has(key) && stored === undefined) {
              // 仅占住本次尝试，避免失败或晚通知重试；不代表原会话准备已开始。
              const fact: ScheduleAttemptFact = { key, projectId: schedule.projectId, sessionId: schedule.sessionId,
                plannedAt, phase: 'preparing', persisted: false, nativeInserted: false }
              this.attempted.set(key, fact)
              try {
                await this.host.withTargetAdmission(target, `schedule-automatic:${key}`, (actualTarget, assertCurrent) =>
                  this.attempt(store, schedule, actualTarget, fact, assertCurrent))
              }
              catch (error) { fact.error = describe(error); fact.phase = 'settled' }
            }
            const observed = this.attempted.get(key)?.observation ?? stored?.observation
            // 已确认入队只证明本槽；不能把后续未观察的旧候选一并当成已结算。
            const recordedCutoff = observed?.outcome === 'enqueued' ? plannedAt : observed?.boundaryAt ?? plannedAt
            const advanceAfter = this.attempted.get(key)?.advanceAfter
            const link = stored ?? (observed === undefined ? undefined : this.link(schedule, target, this.attempted.get(key)!))
            const savedUpper = link === undefined ? undefined : savedUnknownRangeUpper(link, schedule, scheduleRuleIdentity(schedule), key, plannedAt)
            const cutoffBase = new Date(Math.max(...[plannedAt, recordedCutoff, advanceAfter, savedUpper]
              .filter((value): value is string => value !== undefined).map(instant))).toISOString()
            // 先结算原准备，再越过真实恢复期间其它漏跑；不从原 plannedAt 连续补投。
            const { power } = this.readPower()
            const recoveryFloor = power.kind !== 'known' ? undefined : power.provenance === 'darwin-kernel'
              ? power.recoveryWindow?.lowerBound : power.recoveredAt
            const cutoff = recoveryFloor !== undefined && instant(recoveryFloor) > instant(cutoffBase) ? recoveryFloor : cutoffBase
            plannedAt = nextScheduleTime(schedule, cutoff).nextAt
            this.candidates.set(ruleKey, plannedAt)
          }
          if (!this.candidates.has(ruleKey)) this.candidates.set(ruleKey, plannedAt)
        }
      } catch (error) { scanFailed = true; this.diagnostics.set(project.projectId, describe(error)) }
    }
    for (const key of this.candidates.keys()) if (!active.has(key)) this.candidates.delete(key)
    return scanFailed
  }

  private async attempt(store: ProjectScheduleStore, schedule: ProjectSchedule, target: ScheduleRuntimeTarget, fact: ScheduleAttemptFact,
    assertCurrent: () => void): Promise<void> {
    assertCurrent()
    const observation = (outcome: ScheduleRunObservation['outcome'], reason: string,
      admission: ScheduleRunObservation['admission'] = 'not-enqueued'): ScheduleRunObservation => ({
      occurrenceId: fact.key, ruleIdentity: scheduleRuleIdentity(schedule), definitionRevision: schedule.revision, admission, outcome, reason,
    })
    let native: readonly ScheduleNativeObservation[]
    try { native = await this.host.native(target) }
    catch (error) { fact.observation = observation('admission-unknown', `原生来源不可核实：${describe(error)}`, 'unknown'); await this.recordFailure(store, target, schedule, fact); return }
    const prior = native.find(item => item.source.occurrenceId === fact.key && item.source.projectId === schedule.projectId && item.source.sessionId === schedule.sessionId)
    if (prior !== undefined) {
      fact.nativeInserted = prior.inserted; fact.messageId = prior.messageId
      fact.observation = observation('enqueued', '原生日志已保留该次输入；不重新投递。', 'enqueued')
      await this.recordFailure(store, target, schedule, fact); return
    }
    const initial = this.decide(schedule, target, fact)
    const readyBoundary = initial.power.kind === 'known' && initial.power.provenance === 'darwin-kernel'
      && initial.power.baselineEpoch !== this.readyBaselineEpoch ? initial.power.baselineAt : this.readyAt!
    if (instant(fact.plannedAt) <= instant(readyBoundary)) {
      // A previous process may have failed before both native insertion and run persistence.
      fact.observation = { ...observation('unknown', `计划时刻 ${fact.plannedAt} 未发现可核实的旧运行来源；本次略过从该时刻至实际许可边界 ${readyBoundary} 的旧候选，不补投，旧尝试结果保持未知；该边界不代表OS实际唤醒。`, 'unknown'), boundaryAt: readyBoundary }
      await this.recordFailure(store, target, schedule, fact); return
    }
    const applyDecision = (decision: ScheduleDecision): void => {
      if (decision.kind === 'skip') fact.observation = { ...observation('missed-before-boundary', decision.reason), boundaryAt: decision.boundaryAt }
      else if (decision.kind === 'unknown') {
        fact.observation = observation('unknown', qualificationUnknownReason(decision.reason), 'not-enqueued')
        fact.advanceAfter = decision.unresolvedUntil
      }
      else fact.observation = observation('suppressed', decision.kind === 'suppressed' ? decision.reason : '计划尚未到期。')
    }
    // native 读取/target operation 等待都不算准备；醒后首次到达此处的旧项直接跳过。
    if (initial.decision.kind !== 'ready') { applyDecision(initial.decision); await this.recordFailure(store, target, schedule, fact); return }
    let invoked = false
    const start: SchedulePreparationStart = operation => {
      if (invoked) throw new Error('同次准备不能重新调用原解析器。')
      invoked = true
      if (this.closing) throw new Error('Host正在退出，原准备未开始。')
      const before = this.decide(schedule, target, fact)
      if (before.decision.kind !== 'ready') throw new PreparationNotStarted(before.decision)
      // 资格落在真实 caller 的原 resolver 调用；返回原 promise，不重开、不替换。
      const pending = operation()
      let after: ReturnType<ProjectScheduleRuntime['decide']>
      try { after = this.decide(schedule, target, fact) } catch {
        fact.preparation = { kind: 'uncertain', reason: '原准备调用后的目标事实未确认。' }; return pending
      }
      if (before.power.kind === 'known' && after.power.kind === 'known' && after.decision.kind === 'ready'
        && this.sameEpoch(before.power, after.power)) {
        fact.preparation = { kind: 'started', startedAt: before.now,
          ...(before.power.provenance === 'darwin-kernel' ? { epoch: before.power.epoch, baselineAt: before.power.baselineAt }
            : before.power.recoveredAt === undefined ? {} : { recoveredAt: before.power.recoveredAt }) }
      } else fact.preparation = { kind: 'uncertain', reason: '原准备调用跨过恢复或事实不明的采样边界，不能确认开始资格。' }
      // 两次读取之间若发生恢复或事实不明，不能猜原调用在哪一侧；最后仍按当前事实裁决。
      return pending
    }
    let prepared: SchedulePreparedTarget
    try { assertCurrent(); prepared = await this.host.prepare(target, start) }
    catch (error) {
      if (error instanceof PreparationNotStarted) applyDecision(error.decision)
      else fact.observation = observation('not-started', `原会话准备失败：${describe(error)}`)
      await this.recordFailure(store, target, schedule, fact); return
    }
    let recorded = false
    try {
      // Store owns the last await/load and one serial transaction. Everything through send is synchronous.
      await this.change(target, 'active', store, state => {
        assertCurrent()
        const stored = state.runs.find(item => item.id === fact.key || item.observation?.occurrenceId === fact.key)
        if (stored !== undefined) {
          fact.observation = stored.observation ?? observation('unknown', '该次运行关联已保留，不重复投递。', 'unknown')
          recorded = true
          return
        }
        const live = state.schedules.find(item => item.id === schedule.id)
        if (this.closing) fact.observation = observation('not-started', 'Host正在退出，未投递。')
        else {
          const current = this.host.current(target)
          if (live === undefined || live.sessionId !== schedule.sessionId || scheduleRuleIdentity(live) !== scheduleRuleIdentity(schedule)) {
            fact.observation = observation('not-started', '计划已移除或规则已改变，未投递。')
          } else {
            const existing = prepared.observations().find(item => item.source.occurrenceId === fact.key
              && item.source.projectId === schedule.projectId && item.source.sessionId === schedule.sessionId)
            if (existing !== undefined) {
              fact.nativeInserted = existing.inserted; fact.messageId = existing.messageId
              fact.observation = observation('enqueued', '原生已接纳，不重复或清除合法输入。', 'enqueued')
            } else {
              const { decision, now, power } = this.decide(live, target, fact, current)
              if (decision.kind === 'ready') {
                const source: ProjectScheduleMessageSource = { kind: 'project-schedule', projectId: live.projectId, sessionId: live.sessionId,
                  scheduleId: live.id, occurrenceId: fact.key, plannedAt: fact.plannedAt, definitionRevision: live.revision,
                  ruleIdentity: scheduleRuleIdentity(live), trigger: 'automatic', triggeredAt: now, managementSources: live.updatedBy.sources }
                try {
                  assertCurrent()
                  fact.messageId = prepared.send(source, `定时任务「${live.title}」\n\n${live.prompt}\n\n沿原会话当前要求与许可处理；若上轮操作结果未明，先核对，不盲目重复。`)
                  fact.nativeInserted = true
                  fact.observation = { ...observation('enqueued', '已同步进入原会话普通队列。', 'enqueued'), definitionRevision: live.revision,
                    admittedAt: now, ...(power.kind === 'known' && power.provenance === 'controlled-fixture' ? { provenance: 'controlled-fixture' as const } : {}) }
                } catch (error) {
                  const inserted = prepared.observations().find(item => item.source.occurrenceId === fact.key)
                  fact.messageId = inserted?.messageId; fact.nativeInserted = inserted?.inserted === true
                  fact.observation = observation('admission-unknown', `原生send未确认：${describe(error)}`, inserted?.inserted ? 'enqueued' : 'unknown')
                }
              } else applyDecision(decision)
            }
          }
        }
        if (fact.observation !== undefined) { state.runs.push(this.link(schedule, target, fact)); recorded = true }
      })
      fact.persisted = recorded
    } catch (error) {
      fact.error = `运行记录未持久化：${describe(error)}`
      fact.metadata = durableMutationDetails(error)
      fact.observation ??= observation('admission-unknown', '最终设置读取或提交未确认，未再次尝试。', 'unknown')
    }
    if (fact.nativeInserted) {
      try { if (!await prepared.flush()) fact.error = [fact.error, '原生日志保存未确认。'].filter(Boolean).join('；') }
      catch (error) { fact.error = [fact.error, `原生日志保存失败：${describe(error)}`].filter(Boolean).join('；') }
    }
    fact.phase = 'settled'
  }
  private async recordFailure(store: ProjectScheduleStore, target: ScheduleRuntimeTarget, schedule: ProjectSchedule, fact: ScheduleAttemptFact): Promise<void> {
    try {
      await this.change(target, 'settlement', store, state => {
        this.host.current(target)
        if (!state.runs.some(item => item.id === fact.key)) state.runs.push(this.link(schedule, target, fact))
      })
      fact.persisted = true
    } catch (error) { fact.error = `运行记录未持久化：${describe(error)}`; fact.metadata = durableMutationDetails(error) }
    fact.phase = 'settled'
  }
  private change<T>(target: ScheduleRuntimeTarget, activity: 'active' | 'settlement', store: ProjectScheduleStore,
    operation: (state: ScheduleState) => T, authorization?: ScheduleAccess, signal?: AbortSignal): Promise<T> {
    return this.host.withMetadataWrite(target, activity, scope => store.changeWithin(scope, operation), signal, authorization)
  }
  private link(schedule: ProjectSchedule, target: ScheduleRuntimeTarget, fact: ScheduleAttemptFact): ScheduleRunLink {
    return { id: fact.key, projectId: schedule.projectId, sessionId: schedule.sessionId, scheduleId: schedule.id,
      plannedAt: fact.plannedAt, observedAt: this.now(), trigger: 'automatic',
      refs: fact.messageId === undefined ? [] : [{ kind: 'message', hostSessionId: target.hostSessionId, messageId: fact.messageId }],
      ...(fact.observation === undefined ? {} : { observation: fact.observation }) }
  }
  private sameEpoch(before: Exclude<SchedulePowerFact, { kind: 'unknown' }>, after: Exclude<SchedulePowerFact, { kind: 'unknown' }>): boolean {
    return before.provenance === 'darwin-kernel' ? after.provenance === 'darwin-kernel' && before.epoch === after.epoch
      && before.baselineEpoch === after.baselineEpoch && before.baselineAt === after.baselineAt
      : after.provenance === 'controlled-fixture' && before.recoveredAt === after.recoveredAt
  }
  private readPower(): { power: SchedulePowerFact; now: string } {
    let power: SchedulePowerFact
    try { power = this.facts.readSync() }
    catch (error) { power = { kind: 'unknown', reason: `恢复事实读取失败：${describe(error)}` } }
    const now = this.now()
    if (power.kind === 'known') {
      try {
        if (typeof power.available !== 'boolean' || instant(power.observedAt) > instant(now)) throw new Error('clock')
        if (power.provenance === 'controlled-fixture') {
          if (this.lastNativePower !== undefined || power.recoveredAt !== undefined && instant(power.recoveredAt) > instant(power.observedAt)) throw new Error('source/recovery')
        } else if (power.provenance === 'darwin-kernel') {
          if (!Number.isSafeInteger(power.epoch) || power.epoch < 0 || !Number.isSafeInteger(power.baselineEpoch)
            || power.baselineEpoch < 0 || power.baselineEpoch > power.epoch || instant(power.baselineAt) > instant(power.observedAt)) throw new Error('epoch/baseline')
          const window = power.recoveryWindow
          // window上界是µs观测向上封闭到ms；不是允许未来恢复事实的经验容差。
          if (window !== undefined && (instant(window.lowerBound) < instant(power.baselineAt)
            || instant(window.lowerBound) > instant(window.upperBound) || instant(window.upperBound) > instant(power.observedAt) + 1)) throw new Error('window')
          const previous = this.lastNativePower
          if (previous !== undefined) {
            if (power.baselineEpoch === previous.baselineEpoch) {
              if (power.baselineAt !== previous.baselineAt || power.epoch < previous.epoch
                || instant(power.observedAt) < instant(previous.observedAt)
                || power.epoch === previous.epoch && (window?.lowerBound !== previous.recoveryWindow?.lowerBound || window?.upperBound !== previous.recoveryWindow?.upperBound)
                || power.epoch > previous.epoch && (window === undefined || instant(window.lowerBound) < instant(previous.observedAt))) throw new Error('epoch continuity')
            } else if (power.baselineEpoch <= previous.epoch || power.epoch <= previous.epoch) throw new Error('baseline continuity')
          }
          this.lastNativePower = structuredClone(power)
        } else throw new Error('source')
      } catch { power = { kind: 'unknown', reason: '恢复事实来源、epoch、范围或时钟不一致；旧基线未重置。' } }
    }
    this.latestPower = structuredClone(power)
    return { power, now }
  }
  private decide(schedule: ProjectSchedule, target: ScheduleRuntimeTarget, fact: ScheduleAttemptFact,
    current = this.host.current(target)): { decision: ScheduleDecision; power: SchedulePowerFact; now: string } {
    const { power, now } = this.readPower()
    const native = power.kind === 'known' && power.provenance === 'darwin-kernel' ? power : undefined
    const activation = this.activationBoundaries.get(`${schedule.id}:${scheduleRuleIdentity(schedule)}`)
    const comparable = (epoch: number | undefined): boolean => native === undefined || epoch === native.baselineEpoch
      || epoch === undefined && native.baselineEpoch === 0
    const decision = decideSchedule({ schedule, plannedAt: fact.plannedAt, now, ...current,
      ...(native === undefined ? {} : { enabledAt: activation?.baselineEpoch === native.baselineEpoch ? activation.at : native.baselineAt }),
      availability: power.kind === 'unknown' ? power : { ...power,
        hostStartedAt: native !== undefined && !comparable(this.readyBaselineEpoch) ? native.baselineAt : this.readyAt!,
        projectRestoredAt: comparable(current.projectRestoredBaselineEpoch) ? current.projectRestoredAt : undefined,
        sessionRestoredAt: comparable(current.sessionRestoredBaselineEpoch) ? current.sessionRestoredAt : undefined },
      admission: { kind: 'not-enqueued' }, ...(fact.preparation === undefined ? {} : { preparation: fact.preparation }) })
    return { decision, power, now }
  }
  private now(): string { const value = this.clock(); instant(value); return value }
  private clearTimer(): void { if (this.timerHandle !== undefined) this.timer?.clear(this.timerHandle); this.timerHandle = undefined }
  private arm(scanFailed: boolean): void {
    this.clearTimer()
    const future = [...this.candidates.values()].filter((value): value is string => value !== undefined)
    if ((!scanFailed && future.length === 0) || this.timer === undefined) return
    const now = instant(this.now()), delays = future.map(value => instant(value) - now)
    // 失败扫描的旧过期candidate不能形成0ms循环；已知未来义务仍可比重查等待更早。
    const delay = scanFailed ? Math.min(FAILED_SCAN_RECHECK_MS, ...delays.filter(value => value > 0))
      : Math.max(0, Math.min(...delays))
    this.timerHandle = this.timer.set(() => { this.timerHandle = undefined; void this.hint().catch(error => { this.diagnostics.set('host', describe(error)) }) }, Math.min(delay, 2_147_483_647))
  }
}
function describe(error: unknown): string { return typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error) }

class PreparationNotStarted extends Error {
  constructor(readonly decision: ScheduleDecision) { super('原准备调用之前已失去自动接纳条件。') }
}
