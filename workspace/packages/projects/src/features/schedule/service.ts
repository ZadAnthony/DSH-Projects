import type { RootWriteScope } from '../../metadata-files.ts'
import { randomUUID } from 'node:crypto'
import { ScheduleInputError } from '@deepseek-ai/dsh-schedule'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ManualRunAdmissionResult, RunNowScheduleInput, ProjectSchedule, SaveScheduleInput, ScheduleAccess, ScheduleCorePort, ScheduleManager, ScheduleRequest,
  ScheduleRunLink, ScheduleRunView, ScheduleSession, ScheduleSnapshot, ScheduleWriteResult, SchedulePendingEffect, SchedulePendingConsumer, ScheduleWriteEffects,
} from './contract.ts'
import { ProjectScheduleStore } from './store.ts'
import type { ScheduleClockBoundary } from './power-facts.ts'
import { createScheduleAnchor, instant, nextScheduleTime, normalizeScheduleRule, validateScheduleText } from './timing.ts'
import { runLinkSchema, runNowInputSchema, saveInputSchema, sourceSchema, type ScheduleState } from './validation.ts'
import { SCHEDULE_INPUT_NAMESPACE, isScheduleInputCode, scheduleInputPath, type ScheduleInputField, type ScheduleInputIssue } from './input-errors.ts'

export class ProjectScheduleService {
  constructor(private readonly core: ScheduleCorePort, private readonly clock: () => string = () => new Date().toISOString(),
    private readonly onChanged: (projectId: string) => void = () => {}) {}

  async read(request: ScheduleRequest): Promise<ScheduleSnapshot> {
    const access = await this.access(request)
    const state = await this.store(access).read(); const targets = this.targets(access)
    const own = new Set(targets.map(target => target.id)); const now = this.now()
    const links = new Map(state.runs.filter(link => own.has(link.sessionId)).map(link => [link.id, link]))
    const reader = await this.core.prepareRunRead?.(request, access)
    if (reader !== undefined) {
      // 原文优先保留；只读 native 补视图失败不能被当成空历史。
      for (const raw of reader.nativeLinks) {
        const link = runLinkSchema.parse(raw) as ScheduleRunLink
        if (link.projectId !== access.projectId || !own.has(link.sessionId)) throw new Error('原生定时来源超出可管理目标。')
        const target = this.target(access, link.sessionId)
        for (const ref of link.refs) if ('hostSessionId' in ref && ref.hostSessionId !== target.hostSessionId && !target.carrierHostSessionIds?.includes(ref.hostSessionId)) {
          throw new Error('原生定时来源与目标原会话不一致。')
        }
        if (!links.has(link.id)) links.set(link.id, link)
      }
    }
    const runs: ScheduleRunView[] = [...links.values()].map(link => {
      try {
        const value = reader?.readStatus(structuredClone(link))
        return { link, status: value?.status ?? 'unknown', ...(value?.note === undefined ? {} : { note: value.note }),
          ...(value?.native === undefined ? {} : { native: value.native }), ...(value?.taskOutcome === undefined ? {} : { taskOutcome: value.taskOutcome }) }
      } catch (error) { return { link, status: 'unknown' as const, note: error instanceof Error ? error.message : '运行来源不可读。' } }
    })
    return structuredClone({ projectId: access.projectId, projectArchived: access.projectArchived,
      targets, schedules: state.schedules.filter(item => own.has(item.sessionId)).map(schedule => ({ schedule, time: nextScheduleTime(schedule, now) })),
      runs, ...(this.core.automaticState?.() ?? { automaticDispatch: 'not-connected' as const }) })
  }

  async save(request: ScheduleRequest, raw: SaveScheduleInput): Promise<ScheduleWriteResult> {
    const input = saveInputSchema.parse(raw) as SaveScheduleInput
    const access = await this.access(request); const target = this.target(access, input.sessionId)
    const manager = this.manager(access)
    return this.write(request, access, target, (state, mutationAt) => {
      const existing = input.id === undefined ? undefined : state.schedules.find(item => item.id === input.id)
      if (input.id !== undefined) {
        if (existing !== undefined) this.target(access, existing.sessionId)
        if (existing === undefined || existing.revision !== input.expectedRevision) return { kind: 'conflict' as const, ...(existing === undefined ? {} : { current: existing }) }
        if (existing.sessionId !== input.sessionId) throw new Error('计划保持所属原会话；本入口不迁移计划归属。')
      } else if (input.expectedRevision !== undefined) throw new Error('新计划不带旧修订号。')
      const now = mutationAt
      validateInput('title', () => validateScheduleText(input.title, input.prompt))
      const field = ruleInputField(input.rule)
      const rule = validateInput(field, () => normalizeScheduleRule(input.rule))
      const sameRule = existing !== undefined && JSON.stringify(normalizeScheduleRule(existing.rule)) === JSON.stringify(rule)
      const timing = sameRule ? { rule, anchorAt: existing.anchorAt }
        : validateInput(field, () => createScheduleAnchor(rule, now, input.title, input.prompt))
      const schedule: ProjectSchedule = {
        id: existing?.id ?? randomUUID(), projectId: access.projectId, sessionId: input.sessionId,
        title: input.title, prompt: input.prompt, ...timing, enabled: input.enabled,
        revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? now, updatedAt: now,
        createdBy: existing?.createdBy ?? manager, updatedBy: manager,
        ...(existing?.enabled === true && !input.enabled ? { manualCancelRevision: existing.revision + 1 }
          : existing?.manualCancelRevision === undefined ? {} : { manualCancelRevision: existing.manualCancelRevision }),
        ...((input.enabled && existing?.enabled !== true) ? { enabledSince: now }
          : existing?.enabledSince === undefined ? {} : { enabledSince: existing.enabledSince }),
      }
      if (existing === undefined) state.schedules.push(schedule)
      else state.schedules[state.schedules.indexOf(existing)] = schedule
      return { kind: 'saved' as const, schedule, pendingInputIntegration: 'required' as const }
    })
  }

  async setEnabled(request: ScheduleRequest, id: string, enabled: boolean, expectedRevision: number): Promise<ScheduleWriteResult> {
    if (typeof enabled !== 'boolean') throw new Error('启停必须为真实布尔值。')
    const access = await this.access(request); const manager = this.manager(access)
    const initial = (await this.store(access).read()).schedules.find(item => item.id === id)
    if (initial === undefined) return { kind: 'conflict' }
    const target = this.target(access, initial.sessionId)
    return this.write(request, access, target, (state, mutationAt) => {
      const current = state.schedules.find(item => item.id === id)
      if (current !== undefined) this.target(access, current.sessionId)
      if (current === undefined || current.revision !== expectedRevision) return { kind: 'conflict' as const, ...(current === undefined ? {} : { current }) }
      const now = mutationAt
      const schedule = { ...current, enabled, revision: current.revision + 1, updatedAt: now, updatedBy: manager,
        ...(!enabled ? { manualCancelRevision: current.revision + 1 } : {}),
        ...(enabled && !current.enabled ? { enabledSince: now } : {}) }
      state.schedules[state.schedules.indexOf(current)] = schedule
      return { kind: 'saved' as const, schedule, pendingInputIntegration: 'required' as const }
    })
  }

  async remove(request: ScheduleRequest, id: string, expectedRevision: number): Promise<ScheduleWriteResult> {
    const access = await this.access(request); this.manager(access)
    const initial = (await this.store(access).read()).schedules.find(item => item.id === id)
    if (initial === undefined) return { kind: 'conflict' }
    const target = this.target(access, initial.sessionId)
    return this.write(request, access, target, (state, mutationAt) => {
      const current = state.schedules.find(item => item.id === id)
      if (current !== undefined) this.target(access, current.sessionId)
      if (current === undefined || current.revision !== expectedRevision) return { kind: 'conflict' as const, ...(current === undefined ? {} : { current }) }
      state.schedules.splice(state.schedules.indexOf(current), 1)
      return { kind: 'removed' as const, id, historyRetained: true as const, pendingInputIntegration: 'required' as const }
    })
  }

  async runNow(request: ScheduleRequest, raw: RunNowScheduleInput): Promise<ManualRunAdmissionResult> {
    const input = runNowInputSchema.parse(raw) as RunNowScheduleInput
    const access = await this.access(request)
    this.manager(access)
    if (this.core.runNow === undefined) return { kind: 'rejected', projectId: request.projectId,
      scheduleId: input.scheduleId, requestId: input.requestId, admission: 'not-enqueued',
      runLinkSaved: 'not-applicable', nativeSaved: 'not-applicable', taskOutcome: 'unknown', error: '主动运行尚未接入。' }
    // 不发送 automatic hint；真正目标与最终修订由同一个 Runtime 复核。
    return this.core.runNow(request, access, input)
  }

  /** Host 可信观察入口，配置工具/组件不能制造或写入“已执行”状态。 */
  async recordRunLink(request: ScheduleRequest, candidate: ScheduleRunLink): Promise<ScheduleRunLink> {
    const access = await this.access(request)
    if (this.core.verifyRunLink === undefined) throw new Error('真实运行来源核实尚未接入。')
    const link = runLinkSchema.parse(await this.core.verifyRunLink(request, structuredClone(candidate))) as ScheduleRunLink
    if (link.projectId !== access.projectId) throw new Error('运行关联属于其它项目。')
    const target = this.target(access, link.sessionId)
    for (const ref of link.refs) if ('hostSessionId' in ref && ref.hostSessionId !== target.hostSessionId && !target.carrierHostSessionIds?.includes(ref.hostSessionId)) throw new Error('运行原生来源与目标会话不符。')
    const store = this.store(access)
    const change = (state: ScheduleState): ScheduleRunLink => {
      const plan = state.schedules.find(item => item.id === link.scheduleId)
      if (plan !== undefined && plan.sessionId !== link.sessionId) throw new Error('运行关联与计划会话不符。')
      const existing = state.runs.find(item => item.id === link.id)
      if (existing === undefined) state.runs.push(link)
      else {
        if (existing.scheduleId !== link.scheduleId || existing.sessionId !== link.sessionId || existing.plannedAt !== link.plannedAt || existing.trigger !== link.trigger) throw new Error('已有运行关联不能被改成另一项运行。')
        const refs = new Map([...existing.refs, ...link.refs].map(ref => [JSON.stringify(ref), ref]))
        state.runs[state.runs.indexOf(existing)] = { ...existing, refs: [...refs.values()] }
      }
      return state.runs.find(item => item.id === link.id)!
    }
    return this.core.withMetadataWrite(request, access, target, scope => store.changeWithin(scope, change, request.signal))
  }

  private async write(
    request: ScheduleRequest, access: ScheduleAccess, target: ScheduleSession,
    operation: (state: ScheduleState, mutationAt: string) => Exclude<ScheduleWriteResult, { kind: 'failed' }>,
  ): Promise<ScheduleWriteResult> {
    const action = async (): Promise<ScheduleWriteResult> => {
      let boundary: ScheduleClockBoundary | undefined
      let previous: ProjectSchedule | undefined
      let pending: SchedulePendingConsumer | undefined
      try { pending = await this.core.preparePending?.(request, access, target) }
      catch (error) {
        const message = describe(error)
        return { kind: 'failed', error: message, pendingInputIntegration: 'partial',
          effects: { configuration: 'unchanged', pending: emptyEffect('unchanged'), nativeSaved: 'not-applicable', error: message } }
      }
      try {
        const store = this.store(access)
        const commit = (scope: RootWriteScope) => {
          const operationWithPending = (state: ScheduleState) => {
            pending?.assertCurrent()
            boundary = this.core.captureBoundary?.() ?? { at: this.now() }
            const before = new Map(state.schedules.map(item => [item.id, item]))
            const result = operation(state, boundary.at)
            if (result.kind === 'saved') previous = before.get(result.schedule.id)
            return result
          }
          const consume = (state: ScheduleState, result: ReturnType<typeof operationWithPending>) => {
            if (result.kind === 'conflict') return emptyEffect('unchanged')
            pending?.assertCurrent()
            return pending?.apply(state) ?? emptyEffect('not-connected')
          }
          return store.changeCommittedWithin(scope, operationWithPending, consume, request.signal)
        }
        const committed = await this.core.withMetadataWrite(request, access, target, scope => commit(scope))
        const result = committed.result
        if (result.kind === 'conflict') return result
        let nativeSaved: ScheduleWriteEffects['nativeSaved'] = 'not-applicable'
        let error = committed.error
        if (pending !== undefined && (committed.pending.kind === 'applied' || committed.pending.kind === 'unconfirmed')) {
          try {
            nativeSaved = await pending.flush() ? 'confirmed' : 'unconfirmed'
            if (nativeSaved === 'unconfirmed') error = joinError(error, '待执行输入保存未确认。')
          } catch (failure) { nativeSaved = 'unconfirmed'; error = joinError(error, describe(failure)) }
        }
        const effects: ScheduleWriteEffects = { configuration: committed.configuration, pending: committed.pending,
          nativeSaved, ...(error === undefined ? {} : { error }),
          ...(committed.metadata === undefined ? {} : { metadata: committed.metadata }) }
        if (committed.error !== undefined && committed.configuration !== 'confirmed') {
          return { kind: 'failed', error: committed.error, pendingInputIntegration: 'partial', effects }
        }
        if (committed.configuration === 'confirmed') {
          if (result.kind === 'saved') this.core.configurationCommitted?.(previous, result.schedule, boundary!)
          this.onChanged(request.projectId)
        }
        if (pending === undefined && error === undefined) return result
        const integration = error !== undefined || committed.pending.kind === 'unconfirmed' || nativeSaved === 'unconfirmed'
          ? 'partial' as const : committed.pending.kind === 'not-connected' ? 'required' as const : 'applied' as const
        return { ...result, pendingInputIntegration: integration, effects }
      } finally { pending?.release?.() }
    }
    return this.core.withTargetOperation === undefined ? action()
      : this.core.withTargetOperation(request, access, target, action)
  }
  private async access(request: ScheduleRequest): Promise<ScheduleAccess> {
    request.signal?.throwIfAborted(); const value = await this.core.resolve(request); request.signal?.throwIfAborted()
    if (value.projectId !== request.projectId || !value.projectDirectory || new Set(value.sessions.map(item => item.id)).size !== value.sessions.length) throw new Error('定时访问的项目或会话归属不一致。')
    const actor = value.actor
    if (actor.kind !== 'user' && !value.sessions.some(item => item.id === actor.sessionId)) throw new Error('实际调用会话不属于此项目。')
    return value
  }
  private targets(access: ScheduleAccess): ScheduleSession[] {
    const actor = access.actor
    if (actor.kind === 'user') return [...access.sessions]
    const caller = access.sessions.find(item => item.id === actor.sessionId)!
    return caller.role === 'main' ? [...access.sessions] : [caller]
  }
  private target(access: ScheduleAccess, id: string): ScheduleSession {
    const target = this.targets(access).find(item => item.id === id)
    if (target === undefined) throw new Error('只能管理当前项目及当前调用者有权管理的会话定时。')
    return target
  }
  private manager(access: ScheduleAccess): ScheduleManager {
    if (access.managementSources.length === 0) throw new Error('本次管理操作缺少真实来源。')
    const sources = access.managementSources.map(source => sourceSchema.parse(source))
    return access.actor.kind === 'user' ? { kind: 'user', sources } : { kind: 'session', sessionId: access.actor.sessionId, sources }
  }
  private now(): string { const now = this.clock(); instant(now); return now }
  private store(access: ScheduleAccess): ProjectScheduleStore { return new ProjectScheduleStore(access.projectId, access.projectDirectory) }
}

/** 该调用只包住输入解析/锚点计算；保存和pending处理均不在此catch内。 */
function validateInput<T>(field: ScheduleInputField, parse: () => T): T {
  try { return parse() }
  catch (error) {
    if (!(error instanceof ScheduleInputError) || !isScheduleInputCode(error.code)) throw error
    const issue: ScheduleInputIssue = { namespace: SCHEDULE_INPUT_NAMESPACE,
      path: scheduleInputPath(error.code === 'invalid_time_zone' ? 'timeZone' : field), code: error.code }
    throw new RemoteError('gateway/bad-request', error.message, { issues: [issue] })
  }
}

function ruleInputField(rule: SaveScheduleInput['rule']): ScheduleInputField {
  switch (rule.kind) {
    case 'cron': return 'expression'
    case 'at': return 'date'
    case 'daily': return 'time'
    case 'weekly': return 'weekdays'
    case 'after': return 'afterSeconds'
    case 'every': return 'everySeconds'
  }
}

function describe(error: unknown): string { return typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error) }
function emptyEffect(kind: SchedulePendingEffect['kind']): SchedulePendingEffect { return { kind, updatedMessageIds: [], removedMessageIds: [] } }
function joinError(first: string | undefined, next: string): string { return first === undefined ? next : first + '；' + next }
