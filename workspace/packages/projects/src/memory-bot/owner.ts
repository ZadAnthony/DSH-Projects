import { randomUUID } from 'node:crypto'
import { mintNativeProjectSource, nativeSourceDigest } from '../native-source-host.ts'
import { validateCurrentSource } from '../memory-store.ts'
import type { MemoryExplicitRequest, MemoryRequestContextSource, MemoryRequestPort, MemoryRequestResult } from '../memory-request.ts'
import { MEMORY_BATCH_CHARACTERS, MEMORY_BATCH_TURNS, cutLocator, memoryCoverage, projectPendingMemory } from './projection.ts'
import { assertMemoryBotState, MemoryBotStateConflictError, mutateMemoryBotState, readMemoryBotState } from './state.ts'
import type {
  FrozenMemoryBatch, MemoryBatchCheck, MemoryBatchInput, MemoryBatchRunResult, MemoryBatchSettlement,
  MemoryBotActivity, MemoryBotCorePort, MemoryBotProject, MemoryBotState, SavedWorkCut,
} from './types.ts'

type DeletionCut = { committed: boolean }
type Handle = { tail: Promise<unknown>; closed: boolean; deletionCuts: Set<DeletionCut>; completion?: Promise<MemoryBatchSettlement>; active?: { controller: AbortController; completion: Promise<MemoryBatchSettlement> } }

/** 删除准备只拥有本次关闭；已提交责任不会被普通resume解除。 */
export interface MemoryBatchDeletionPreparation {
  readonly drained: Promise<MemoryBatchSettlement | undefined>
  commit(): void
  release(): Promise<{ readonly kind: 'released' } | { readonly kind: 'held'; readonly reason: 'committed' | 'unconfirmed' | 'already-closed' }>
}

/** 只拥有机械队列和单批边界；Agent、模型、用量和项目生命周期仍归core。 */
export class ProjectMemoryBatchOwner implements MemoryRequestPort {
  private readonly handles = new Map<string, Handle>()
  private closing = false
  constructor(private readonly core: MemoryBotCorePort) {}

  async activity(projectId: string, activity: MemoryBotActivity): Promise<MemoryBatchCheck> {
    if (!isRealActivity(activity)) return { kind: 'skipped', reason: 'unsupported-activity' }
    return this.check(projectId)
  }

  async accept(request: MemoryExplicitRequest, signal?: AbortSignal): Promise<MemoryRequestResult> {
    const handle = this.handle(request.projectId)
    try {
      let checkNow = false
      const result = await this.serial(handle, async (): Promise<MemoryRequestResult> => {
        signal?.throwIfAborted()
        const project = await this.resolve(request.projectId)
        if (this.isClosed(handle)) return { kind: 'unavailable', message: '后台正在关闭，未接收记忆请求。' }
        if (project.archived) { this.core.discardProbe?.(request.projectId); return { kind: 'unavailable', message: '项目已归档，未接收记忆请求。' } }
        const normalized = normalizeRequest(request)
        const frozen = await this.freezeRequest(project, normalized, signal ?? new AbortController().signal)
        signal?.throwIfAborted()
        const requestId = randomUUID()
        // 写入一旦完成，回应accepted；之后不再把工作会话signal传给Bot。
        await this.writeState(project, 'accept', state => {
          if (this.isClosed(handle)) throw new Error('后台正在关闭，未接收记忆请求。')
          state.requests.push({ ...normalized, ...frozen, requestId })
        }, signal)
        checkNow = handle.active === undefined
        return { kind: 'accepted', requestId }
      })
      if (result.kind === 'accepted' && checkNow) await this.check(request.projectId, 'new-explicit')
      return result
    } catch (error) { return { kind: 'failed', message: errorText(error) } }
  }

  /** open/restore仅重建状态；不会读日志、调用模型或补跑。 */
  async restore(projectId: string): Promise<MemoryBotState> {
    this.core.discardProbe?.(projectId)
    const handle = this.handle(projectId)
    return this.serial(handle, async () => {
      const project = await this.resolve(projectId)
      this.core.discardProbe?.(projectId)
      return readMemoryBotState(project.projectDirectory, projectId)
    })
  }

  /** 只等待现有批次，不形成活动，也不启动后续批次。 */
  async whenIdle(projectId: string): Promise<MemoryBatchSettlement | undefined> {
    const handle = this.handle(projectId)
    let result: MemoryBatchSettlement | undefined
    for (;;) {
      await handle.tail
      const completion = handle.completion
      if (completion === undefined) return result
      result = await completion
      await handle.tail
      if (handle.completion === completion && handle.active === undefined) return result
    }
  }

  /** core明确解除当前cut之后调用；此操作本身不触发处理。 */
  resume(projectId: string): void { if (!this.closing) this.handle(projectId).closed = false }

  /** 在现有handle上保留本次删除责任；准备、释放本身都不触发批次。 */
  prepareDeletion(projectId: string): MemoryBatchDeletionPreparation {
    this.core.discardProbe?.(projectId)
    const handle = this.handle(projectId)
    const cut: DeletionCut = { committed: false }
    handle.deletionCuts.add(cut)
    handle.active?.controller.abort()
    const drained = (async () => {
      await handle.tail
      handle.active?.controller.abort()
      this.core.discardProbe?.(projectId)
      return handle.completion
    })()
    void drained.catch((_error: unknown) => { /* 拒绝由删除调用方消费，不丢失关闭责任。 */ })
    let released = false
    let releasing: ReturnType<MemoryBatchDeletionPreparation['release']> | undefined
    return {
      drained,
      commit: () => {
        if (released) throw new Error('记忆删除准备已经释放。')
        cut.committed = true
      },
      release: () => releasing ??= (async () => {
        try { await drained } catch (_error: unknown) { return { kind: 'held' as const, reason: 'unconfirmed' as const } }
        if (cut.committed) return { kind: 'held' as const, reason: 'committed' as const }
        released = true
        handle.deletionCuts.delete(cut)
        return this.isClosed(handle) ? { kind: 'held' as const, reason: 'already-closed' as const } : { kind: 'released' as const }
      })(),
    }
  }

  /** 调用即closed/abort；core须立即并行stop/drain，再共同等待settlement/flush后提交归档/退出。 */
  async suspend(projectId: string, _reason: 'archive' | 'exit'): Promise<MemoryBatchSettlement | undefined> {
    this.core.discardProbe?.(projectId)
    const handle = this.handle(projectId)
    handle.closed = true
    handle.active?.controller.abort()
    await handle.tail
    handle.active?.controller.abort()
    this.core.discardProbe?.(projectId)
    return handle.completion
  }

  /** 所有项目原批次结算后，统一交回退出失败。 */
  async close(): Promise<void> {
    this.closing = true
    const settled = await Promise.allSettled([...this.handles.keys()].map(projectId => this.suspend(projectId, 'exit')))
    const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) throw new AggregateError(failures, '记忆后台退出结算未确认。')
  }

  private async check(projectId: string, mode: 'activity' | 'new-explicit' = 'activity'): Promise<MemoryBatchCheck> {
    const handle = this.handle(projectId)
    return this.serial(handle, async (): Promise<MemoryBatchCheck> => {
      try {
        if (this.isClosed(handle)) return { kind: 'skipped', reason: 'closed' }
        if (handle.active !== undefined) return { kind: 'skipped', reason: 'busy' }
        const project = await this.resolve(projectId)
        if (project.archived) { this.core.discardProbe?.(projectId); return { kind: 'skipped', reason: 'archived' } }
        const state = await readMemoryBotState(project.projectDirectory, projectId)
        const expectedState = structuredClone(state)
        const freshRequests = state.requests.filter(request => !request.attempted)
        let frozen: FrozenMemoryBatch | undefined
        let pending: MemoryBatchInput['pending'] = { visibleCharacters: 0, completeTurns: 0, messages: [] }
        const batches = state.pendingBatches ??= []
        if (freshRequests.length > 0) {
          frozen = { batchId: randomUUID(), kind: 'explicit', cuts: [], requestIds: freshRequests.map(request => request.requestId),
            coverage: { sources: freshRequests.flatMap(request => [request.source, ...request.contextSources]), digest: nativeSourceDigest(freshRequests.map(request => [request.frozenOriginal, request.frozenContext])) } }
          for (const request of freshRequests) request.attempted = true
          batches.push(frozen)
        } else if (mode === 'activity') frozen = batches[0]
        if (frozen?.kind === 'explicit' && frozen.legacy) {
          const cuts = await this.core.readSavedCuts(project, frozen.cuts.length === 0 ? undefined : frozen.cuts)
          for (const request of state.requests.filter(request => frozen!.requestIds.includes(request.requestId))) {
            const exact = legacyRequestAtCut(projectId, request, cuts)
            Object.assign(request, exact, await this.freezeRequest(project, exact, new AbortController().signal))
          }
          const requests = state.requests.filter(request => frozen!.requestIds.includes(request.requestId))
          frozen.coverage = { sources: requests.flatMap(request => [request.source, ...request.contextSources]), digest: nativeSourceDigest(requests.map(request => [request.frozenOriginal, request.frozenContext])) }
          delete frozen.legacy
        }
        if (frozen?.kind !== 'explicit') {
          if (mode === 'new-explicit' && frozen === undefined) return { kind: 'skipped', reason: 'below-threshold' }
          if (frozen === undefined && this.core.probePendingMemory !== undefined) {
            const candidate = await this.core.probePendingMemory(project, state.processed)
            if (candidate.completeTurns < MEMORY_BATCH_TURNS && candidate.visibleCharacters < MEMORY_BATCH_CHARACTERS) return { kind: 'skipped', reason: 'below-threshold' }
          }
          // A candidate is never a durable cut. Recompute from exact saved input,
          // including retries whose old frozen range is below the current threshold.
          const saved = this.core.readPendingMemory === undefined ? undefined : await this.core.readPendingMemory(project, state.processed, frozen?.cuts, frozen === undefined ? 2 : frozen.projectionVersion ?? 1)
          const cuts = saved === undefined ? await this.core.readSavedCuts(project, frozen?.cuts) : saved.cuts
          if (frozen !== undefined) assertFrozenCuts(frozen, cuts)
          pending = saved?.pending ?? projectPendingMemory(projectId, cuts as readonly SavedWorkCut[], state.processed, frozen === undefined ? 2 : frozen.projectionVersion ?? 1)
          const coverage = memoryCoverage(pending)
          if (frozen === undefined) {
            if (pending.completeTurns < MEMORY_BATCH_TURNS && pending.visibleCharacters < MEMORY_BATCH_CHARACTERS) return { kind: 'skipped', reason: 'below-threshold' }
            frozen = { batchId: randomUUID(), kind: 'ordinary', projectionVersion: 2, cuts: cuts.filter(cut => !('role' in cut) || cut.role !== 'memory').map(cutLocator), requestIds: [], coverage }
            batches.push(frozen)
          } else if (frozen.coverage !== undefined && frozen.coverage.digest !== coverage.digest) throw new Error('冻结交流的实际内容或范围已变化，未替换原批输入。')
          else frozen.coverage = coverage
          if (frozen.legacy) {
            for (const request of state.requests.filter(request => frozen!.requestIds.includes(request.requestId))) {
              if (request.frozenOriginal === undefined) {
                const exact = legacyRequestAtCut(projectId, request, await this.core.readSavedCuts(project, frozen.cuts))
                Object.assign(request, exact, await this.freezeRequest(project, exact, new AbortController().signal))
              }
            }
            delete frozen.legacy
          }
        }
        state.frozen = batches[0]
        await this.writeState(project, 'prepare', latest => {
          if (this.isClosed(handle)) throw new Error('后台正在关闭，未提交新记忆批次。')
          assertMemoryBotState(expectedState, latest)
          Object.assign(latest, state)
          if (state.frozen === undefined) delete latest.frozen
        })
        if (this.isClosed(handle)) return { kind: 'skipped', reason: 'closed' }
        if (frozen === undefined) throw new Error('未能确定本批冻结范围。')
        const selected = frozen
        // Keep the narrow projector paused at this frozen cut. A successful
        // processed update can compact it before reading only the new suffix.
        const controller = new AbortController()
        // completion内部先yield，active在任何异步读取/runner调用前即已登记。
        const completion = Promise.resolve().then(async () => {
          let settlement: MemoryBatchSettlement
          try {
            controller.signal.throwIfAborted()
            const requests: MemoryBatchInput['requests'][number][] = []
            for (const request of state.requests.filter(request => selected.requestIds.includes(request.requestId))) {
              if (request.frozenOriginal === undefined || request.frozenContext === undefined) throw new Error('旧请求缺少可确定的冻结内容，未改用当前版本。')
              const original = await this.readFrozenSource(project, request.frozenOriginal, controller.signal)
              if (original.projectId !== projectId || !original.readable || !original.isUserDecision) throw new Error('明确请求的原用户消息当前不可读或不属于该项目。')
              const context: MemoryBatchInput['requests'][number]['context'][number][] = []
              for (const frozenSource of request.frozenContext) {
                const source = frozenSource.source
                const value = await this.readFrozenSource(project, frozenSource, controller.signal)
                if (value.projectId !== projectId || !value.readable) throw new Error('明确请求必要前文当前不可读或不属于该项目。')
                context.push({ source, value })
              }
              requests.push({ request, original, context })
            }
            controller.signal.throwIfAborted()
            const outcome = await this.core.runFrozenBatch(project, { frozen: selected, pending, requests }, controller.signal)
            try {
              await this.core.validateFrozenSources?.(project, selected.cuts, controller.signal)
              settlement = settleOutcome(selected, outcome, requests.map(item => item.request.requestId))
            } catch (error) {
              // Keep already effective writes visible, but do not advance a
              // frozen range whose source was revoked while the run settled.
              const failed = { ...outcome, processing: outcome.writes.length > 0 ? 'partial' as const : 'failed' as const, completedRequestIds: [] }
              settlement = { ...settleOutcome(selected, failed, requests.map(item => item.request.requestId)),
                ...(controller.signal.aborted ? { status: 'interrupted' as const } : {}), error: errorText(error) }
            }
          } catch (error) {
            settlement = { batchId: selected.batchId, status: controller.signal.aborted ? 'interrupted' : 'failed', changes: [], error: errorText(error) }
          }
          await this.serial(handle, async () => {
            // busy期间accept可能追加请求，必须重读，不能用启动前state覆盖。
            const processed = await this.writeState(project, 'settlement', latest => {
              const retained = latest.pendingBatches?.find(batch => batch.batchId === selected.batchId)
              if (retained === undefined) throw new MemoryBotStateConflictError()
              assertMemoryBotState(selected, retained)
              const completed = new Set(settlement.outcome?.completedRequestIds.filter(id => selected.requestIds.includes(id)) ?? [])
              latest.requests = latest.requests.filter(request => !completed.has(request.requestId))
              latest.lastResult = {
                batchId: selected.batchId, status: settlement.status, nativeReason: settlement.outcome?.nativeReason ?? settlement.status,
                writes: settlement.outcome?.writes.map(({ result }) => writeFact(result)) ?? [], completedRequestIds: [...completed],
              }
              if (settlement.status === 'completed') {
                const processed = new Map(latest.processed.map(cut => [cut.hostSessionId, cut]))
                if (selected.kind !== 'explicit') for (const cut of selected.cuts) {
                  if ((processed.get(cut.hostSessionId)?.endSeq ?? -1) > cut.endSeq) throw new MemoryBotStateConflictError()
                  processed.set(cut.hostSessionId, cutLocator(cut))
                }
                latest.processed = [...processed.values()]
                latest.pendingBatches = latest.pendingBatches!.filter(batch => batch.batchId !== selected.batchId)
              }
              latest.frozen = latest.pendingBatches?.[0]
              if (latest.frozen === undefined) delete latest.frozen
              return settlement.status === 'completed' && selected.kind !== 'explicit' ? latest.processed.map(cutLocator) : undefined
            })
            if (processed !== undefined) {
              try { await this.core.advanceProcessed?.(projectId, processed) }
              catch {
                // Persistence already confirmed the business result. A failed
                // disposable fold is rebuilt later instead of failing settlement.
                try { this.core.discardProbe?.(projectId) } catch { /* Cache cleanup cannot revoke a committed result. */ }
              }
            }
          })
          if (handle.active?.controller === controller) delete handle.active
          this.core.settled?.(projectId, settlement)
          // Only never-attempted accepted requests continue. Failed ranges and ordinary backlog stay cold.
          void this.check(projectId, 'new-explicit')
          return settlement
        }).finally(() => { if (handle.active?.controller === controller) delete handle.active })
        // 持久失败仍由completion拒绝表达，不能假报已停止/已保存；防止未订阅调用的未处理拒绝。
        void completion.catch(() => undefined)
        handle.completion = completion
        handle.active = { controller, completion }
        return { kind: 'started', batchId: selected.batchId, completion }
      } catch (error) { this.core.discardProbe?.(projectId); return { kind: 'failed', message: errorText(error) } }
    })
  }

  private writeState<T>(project: MemoryBotProject, purpose: 'accept' | 'prepare' | 'settlement', transform: (latest: MemoryBotState) => T, signal?: AbortSignal): Promise<T> {
    return this.core.withStateWrite === undefined ? mutateMemoryBotState(project.projectDirectory, project.projectId, transform, signal)
      : this.core.withStateWrite(project, purpose, transform, signal)
  }

  private async freezeRequest(project: MemoryBotProject, request: MemoryExplicitRequest, signal: AbortSignal) {
    const freeze = async (source: MemoryRequestContextSource, original = false) => {
      const pinned = this.core.pinSource === undefined ? { source, value: await this.core.readSource(project, source, signal) }
        : await this.core.pinSource(project, source, signal)
      if (pinned.value.projectId !== project.projectId || !pinned.value.readable) throw new Error(pinned.value.reason ?? '请求原文或必要上下文不可读。')
      if (original && !pinned.value.isUserDecision) throw new Error('明确记忆请求必须来自原用户消息。')
      return { source: pinned.source, digest: nativeSourceDigest(pinned.value) }
    }
    const frozenOriginal = await freeze(request.source, true)
    const frozenContext = []
    for (const source of request.contextSources) frozenContext.push(await freeze(source))
    return { source: frozenOriginal.source as MemoryExplicitRequest['source'], contextSources: frozenContext.map(item => item.source), frozenOriginal, frozenContext }
  }

  private async readFrozenSource(project: MemoryBotProject, frozen: NonNullable<import('./types.ts').QueuedMemoryRequest['frozenOriginal']>, signal: AbortSignal) {
    const value = await this.core.readSource(project, frozen.source, signal)
    if (nativeSourceDigest(value) !== frozen.digest) throw new Error('冻结来源的版本、内容或范围已变化，保留原请求未完成。')
    return value
  }

  private async resolve(projectId: string): Promise<MemoryBotProject> {
    const project = await this.core.resolveProject(projectId)
    if (project.projectId !== projectId) throw new Error('core返回了另一项目的归属。')
    return project
  }

  private isClosed(handle: Handle): boolean { return handle.closed || this.closing || handle.deletionCuts.size > 0 }

  private handle(projectId: string): Handle {
    let handle = this.handles.get(projectId)
    if (handle === undefined) { handle = { tail: Promise.resolve(), closed: false, deletionCuts: new Set() }; this.handles.set(projectId, handle) }
    return handle
  }

  private serial<T>(handle: Handle, operation: () => Promise<T>): Promise<T> {
    const result = handle.tail.then(operation)
    handle.tail = result.then(() => undefined, () => undefined)
    return result
  }
}

function isRealActivity(activity: MemoryBotActivity): boolean {
  return activity.kind === 'work-start' || activity.kind === 'visible-progress' || activity.kind === 'natural-end'
    || (activity.kind === 'tool-completed' && activity.canceled !== true)
}

function assertFrozenCuts(frozen: FrozenMemoryBatch, cuts: readonly import('./types.ts').MemoryBotCut[]): void {
  const work = cuts.filter(cut => !('role' in cut) || cut.role !== 'memory')
  if (work.length !== frozen.cuts.length || frozen.cuts.some(expected => !work.some(cut => cut.sessionId === expected.sessionId
    && cut.hostSessionId === expected.hostSessionId && cut.endSeq === expected.endSeq))) throw new Error('core没有返回冻结的原始日志cut。')
}

function normalizeRequest(request: MemoryExplicitRequest): MemoryExplicitRequest {
  if (!['remember', 'correct', 'withdraw'].includes(request.operation) || typeof request.projectId !== 'string' || request.projectId.length === 0) throw new Error('记忆请求格式不可读。')
  const source = normalizeSource(request.source)
  if (source.kind !== 'message' && source.kind !== 'native-event') throw new Error('明确请求需要原用户消息定位。')
  if (request.memoryId !== undefined && (typeof request.memoryId !== 'string' || request.memoryId.length === 0)) throw new Error('记忆主题ID不可读。')
  return { projectId: request.projectId, operation: request.operation, source,
    ...(request.memoryId === undefined ? {} : { memoryId: request.memoryId }), contextSources: request.contextSources.map(normalizeSource) }
}

function normalizeSource(source: MemoryRequestContextSource): MemoryRequestContextSource {
  const value = validateCurrentSource(source)
  if (value.kind === 'settings') throw new Error('请求不能自报设置来源。')
  return value
}

function settleOutcome(frozen: FrozenMemoryBatch, outcome: MemoryBatchRunResult, requestIds: readonly string[]): MemoryBatchSettlement {
  const incompleteWrite = outcome.writes.some(({ result }) => result.kind !== 'saved' && result.kind !== 'withdrawn')
  const complete = outcome.nativeReason === 'completed' && outcome.processing === 'complete' && !incompleteWrite
    && requestIds.every(id => outcome.completedRequestIds.includes(id))
  const interrupted = outcome.nativeReason === 'aborted' || outcome.nativeReason === 'interrupted'
  const status: MemoryBatchSettlement['status'] = complete ? 'completed' : interrupted ? 'interrupted'
    : outcome.processing === 'partial' || outcome.writes.some(({ result }) => result.kind === 'saved' || result.kind === 'withdrawn' || result.kind === 'partial') ? 'partial' : 'failed'
  return { batchId: frozen.batchId, status, outcome, changes: complete ? outcome.writes.flatMap(({ result, previousMemoryId }) => {
    if (result.kind === 'saved') return [{ kind: previousMemoryId === undefined ? 'added' as const : 'updated' as const, memoryId: result.memory.id }]
    if (result.kind === 'withdrawn') return [{ kind: 'updated' as const, memoryId: result.id }]
    return []
  }) : [] }
}

function writeFact(result: MemoryBatchRunResult['writes'][number]['result']): NonNullable<MemoryBotState['lastResult']>['writes'][number] {
  if (result.kind === 'saved') return { kind: result.kind, id: result.memory.id, revision: result.memory.revision }
  if ('id' in result) return { kind: result.kind, id: result.id }
  return { kind: result.kind }
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : '记忆批处理失败。' }

function legacyRequestAtCut(projectId: string, request: import('./types.ts').QueuedMemoryRequest, cuts: readonly SavedWorkCut[]): MemoryExplicitRequest {
  const locate = (source: MemoryRequestContextSource): MemoryRequestContextSource[] => {
    if (source.kind === 'native-event') return [source]
    if (source.kind === 'file' || source.kind === 'communication-part') throw new Error('旧批上下文没有冻结版本，保留未完成而不采用当前内容。')
    const cut = cuts.find(cut => cut.hostSessionId === source.hostSessionId)
    if (cut === undefined) throw new Error('旧请求来源不在原冻结前缀。')
    const matches = cut.events.filter(event => source.kind === 'message'
      ? event.type === 'user/message' && String(event.data.id) === source.messageId || event.type === 'assistant/message' && String(event.data.message.id) === source.messageId
      : event.type === 'tool/call' && String(event.data.callId) === source.toolCallId || event.type === 'tool/result' && String(event.data.message.toolCallId) === source.toolCallId)
    if (matches.length === 0 || source.kind === 'message' && matches.length !== 1) throw new Error('旧定位无法确定原事件版本，保留未完成。')
    if (cut.sessionCreatedAt === undefined) return [source]
    return matches.map(event => mintNativeProjectSource({ projectId, sessionId: cut.sessionId, hostSessionId: cut.hostSessionId, sessionCreatedAt: cut.sessionCreatedAt!, formatVersion: 4 }, event, event,
      source.kind === 'message' ? { messageId: source.messageId } : { toolCallId: source.toolCallId }))
  }
  return { ...request, source: locate(request.source)[0] as MemoryExplicitRequest['source'], contextSources: request.contextSources.flatMap(locate) }
}
