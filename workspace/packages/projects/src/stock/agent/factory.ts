import type { Context } from '@deepseek-ai/cordis'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentFactory, AgentHandle, AgentOptions, AgentSetup, CreateAgentOptions, ResumeAgentOptions, Agent, TurnBoundaryProjection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import { interruptedTurnClosers, SessionPreparation, SessionLogOffset, SessionSeq, type Session, type SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { createProjectRecordingPort, projectRecordingPolicy } from '../recording/index.ts'
import { inboxProjectionDefinition } from './inbox.ts'
import { userInputTimingProjectionDefinition } from '../../input-timing.ts'
import { ProjectAgent } from './driver.ts'
import { installProjectDriverSchemas, type ProjectDriverPersistence, type ProjectRequestHooks, type ProjectSchemaPersistence } from '../request/dispatch.ts'
import { transformProjectDispatchForRun, initializeProjectRequestProjection, applyProjectRequestProjection, disposeProjectRequestProjection } from '../request/records.ts'
import { transformProjectRawForRun } from '../recording/records.ts'
import { ProjectSessionPersistence, ProjectSessionHandle } from '../persistence/index.ts'
import type { CommittedRange, ProjectPayloadRef, ProjectPayloadReference, ProjectWriterRoute } from '../persistence/types.ts'

export interface ProjectFactoryLifecycle {
  assertCreation(id: SessionId, parent?: Agent, kind?: 'create' | 'resume'): void
  validateCreation?(id: SessionId, header: import('@deepseek-ai/dsh-session').SessionHeader, parent?: Agent, kind?: 'create' | 'resume'): Promise<void>
  created?(handle: AgentHandle, parent?: Agent): void
}
export type ProjectAgentSetup = (ctx: Context, agent: Agent, parent?: Agent) => ReturnType<AgentSetup>
export interface ProjectAgentFactoryOptions {
  resolveOwner?(id: SessionId, parent?: Agent): { projectId: string; logicalSessionId: string } | Promise<{ projectId: string; logicalSessionId: string }>
  lifecycle?: ProjectFactoryLifecycle
  setupBase?: ProjectAgentSetup
  request?: ProjectRequestHooks
  maxParallelToolCalls?: number
}
interface OwnedPersistence extends SessionPersistence, ProjectSchemaPersistence {
  registerSessionOwner(id: SessionId, owner: { projectId: string; logicalSessionId: string }): void
  resolveOwner(id: SessionId): Promise<{ projectId: string; logicalSessionId: string } | undefined>
}
const turnBoundaryProjectionDefinition = {
  key: 'turnBoundary', stateVersion: 2,
  stateSchema: z.object({
    openTurnStartSeq: z.number().int().nonnegative().transform(SessionSeq).nullable(),
    lastStepStartSeq: z.number().int().nonnegative().transform(SessionSeq).nullable(),
    lastStepBoundary: z.object({ kind: z.enum(['start', 'end']), seq: z.number().int().nonnegative().transform(SessionSeq) }).nullable(),
    lastTurn: z.number().int().nonnegative(),
  }),
  init: () => ({ openTurnStartSeq: null, lastStepStartSeq: null, lastStepBoundary: null, lastTurn: 0 }),
  apply: (state, event) => {
    switch (event.type) {
      case 'turn/start': return { ...state, openTurnStartSeq: event.seq, lastTurn: event.data.turn }
      case 'turn/end': return { ...state, openTurnStartSeq: null }
      case 'step/start': return { ...state, lastStepStartSeq: event.seq, lastStepBoundary: { kind: 'start', seq: event.seq } }
      case 'step/end': return { ...state, lastStepBoundary: { kind: 'end', seq: event.seq } }
      default: return state
    }
  },
} satisfies ProjectionDefinition<'turnBoundary', TurnBoundaryProjection>

async function abortable<T>(job: PromiseLike<T> | T, signal: AbortSignal, abandoned?: (value: T) => void | PromiseLike<void>): Promise<T> {
  const pending = Promise.resolve(job)
  const settleCancelledOwnership = async (reason: unknown): Promise<void> => {
    if (abandoned === undefined) return
    let value: T
    try {
      // A sent create/open may publish after cancellation. Its caller retains
      // that original operation until the actual returned handle is closed;
      // only non-owning reads/setup waits may retire at the abort race.
      value = await pending
    } catch (settlementError) {
      if (settlementError === reason) return
      throw new AggregateError([reason, settlementError], 'Cancelled Project persistence operation did not settle cleanly', { cause: reason })
    }
    // Once ownership was returned, every release rejection is a cleanup
    // failure, even when it happens to reuse the operation's abort reason.
    try { await abandoned(value) }
    catch (settlementError) {
      throw new AggregateError([reason, settlementError], 'Cancelled Project persistence operation did not settle cleanly', { cause: reason })
    }
  }
  if (signal.aborted) {
    await settleCancelledOwnership(signal.reason)
    throw signal.reason
  }
  const cancelled = Promise.withResolvers<never>()
  const onAbort = () => cancelled.reject(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  try { return await Promise.race([pending, cancelled.promise]) }
  catch (error) {
    if (signal.aborted) await settleCancelledOwnership(error)
    throw error
  } finally { signal.removeEventListener('abort', onAbort) }
}

/** One writer per exact Session; all native and Projects events use the same append chain. */
export class ProjectWritePath implements ProjectDriverPersistence, ProjectWriterRoute {
  private tail: Promise<void> = Promise.resolve()
  private readonly acknowledgements = new Map<number, Promise<void>>()
  private readonly readConfirmation = new AsyncLocalStorage<{ active: boolean; targetNext: number; signal?: AbortSignal }>()
  private readonly confirmations = new Set<Promise<void>>()
  private failed: unknown
  private storedCount: number
  private ackNext: number
  private detach: (() => void) | undefined
  private detachFlush: (() => void) | undefined
  private detachRoute: (() => void) | undefined
  private closing: Promise<void> | undefined
  private accepting = true
  private bootstrapped = false
  constructor(private readonly ctx: Context, readonly session: Session, private readonly handle: SessionHandle, count: number, private readonly stop: () => void) { this.storedCount = count; this.ackNext = count }
  assertHealthy(): void { if (this.failed !== undefined) throw this.failed }
  fail(error: unknown): void { this.failed ??= error instanceof Error ? error : new Error('Project journal recording failed', { cause: error }); this.stop() }
  private enqueue(events: readonly import('@deepseek-ai/dsh-session').SessionEvent[]): void {
    if (events.length === 0) return
    try {
      this.assertHealthy()
      for (let index = 0; index < events.length; index++) {
        if (events[index]!.seq !== this.storedCount + index) throw new Error('PROJECT_WRITER_RECEIVED_SEQUENCE_GAP')
        applyProjectRequestProjection(this.session, events[index]!)
      }
    } catch (error) { this.fail(error); throw error }
    this.storedCount += events.length
    const next = this.storedCount
    this.tail = this.tail.then(async () => { this.assertHealthy(); await this.handle.append(events); this.ackNext = next }).catch(error => {
      this.failed ??= error
      this.stop()
      throw error
    })
    this.acknowledgements.set(next, this.tail)
    void this.tail.then(() => this.acknowledgements.delete(next), () => this.acknowledgements.delete(next))
    void this.tail.catch(() => {})
  }
  async attach(): Promise<void> {
    this.captureBootstrap()
    await this.flush()
    this.detach = this.ctx.on('session/event', (subject, event) => {
      if (subject !== this.session) return
      if (!this.accepting) { const error = new Error('Project journal writer is closing'); this.fail(error); throw error }
      this.assertHealthy()
      this.enqueue([event])
    })
    this.detachFlush = this.ctx.on('session/flush', subject => {
      if (subject !== this.session) return
      const selected = this.readConfirmation.getStore()
      if (selected?.active) return this.flushSelected(selected.targetNext, selected.signal)
      return this.closing ?? this.flush()
    })
    if (!(this.ctx.sessionPersistence instanceof ProjectSessionPersistence)) throw new Error('Projects exact writer requires its persistence owner')
    this.detachRoute = this.ctx.sessionPersistence.registerWriterRoute(this)
  }
  private captureBootstrap(): void {
    if (this.bootstrapped) return
    const suffix = this.session.snapshotEvents(SessionLogOffset(this.storedCount))
    this.enqueue(suffix)
    this.bootstrapped = true
  }
  async acknowledgeThrough(targetNext: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted(); this.assertHealthy()
    if (!Number.isSafeInteger(targetNext) || targetNext < 0 || targetNext > this.storedCount || this.storedCount !== Number(this.session.seq)) {
      const error = new Error('PROJECT_WRITER_RECEIVED_CUT_UNCONFIRMED'); this.fail(error); throw error
    }
    if (this.ackNext >= targetNext) return
    // Only a batch covering this cut is required. Later queued batches remain
    // owned by the writer, but are not dependencies of an older observation.
    let required: Promise<void> | undefined
    for (const [next, pending] of this.acknowledgements) if (next >= targetNext) { required = pending; break }
    // The writer already owns this append chain. A read waiting for its ACK
    // owns no storage operation yet; cancellation retires only that waiter.
    if (required !== undefined) await (signal === undefined ? required : abortable(required, signal))
    this.assertHealthy(); signal?.throwIfAborted()
    if (this.ackNext < targetNext) { const error = new Error('PROJECT_WRITER_ACK_CUT_UNCONFIRMED'); this.fail(error); throw error }
  }
  async confirmThrough(targetNext: number, signal?: AbortSignal): Promise<CommittedRange> {
    signal?.throwIfAborted()
    if (this.closing !== undefined) {
      await this.acknowledgeThrough(targetNext, signal)
      // 退役仍归原writer；读者只取消自己的等待，不取消实际关闭。
      await (signal === undefined ? this.closing : abortable(this.closing, signal))
      this.assertHealthy(); signal?.throwIfAborted()
      // 同一持久化owner在关闭交接后确认原有限cut，不再检查已释放的live lease。
      return (this.ctx.sessionPersistence as ProjectSessionPersistence).confirmThrough(this.session.id, targetNext, signal === undefined ? undefined : { signal })
    }
    const completed = Promise.withResolvers<void>()
    this.confirmations.add(completed.promise)
    const selected = { active: true, targetNext, ...(signal === undefined ? {} : { signal }) }
    try { return await this.readConfirmation.run(selected, async () => {
      // All native hooks still settle. Only this exact writer's own listener
      // uses the read's fixed cut; ordinary checkpoint/close flushes stay full.
      if (!await this.ctx.sessions.flush(this.session)) throw new Error('PROJECT_SOURCE_DURABILITY_UNCONFIRMED')
      this.assertHealthy(); signal?.throwIfAborted()
      if (!(this.handle instanceof ProjectSessionHandle)) throw new Error('PROJECT_WRITER_RECEIPT_OWNER_MISMATCH')
      return this.handle.committedRange(targetNext)
    }) } finally { selected.active = false; this.confirmations.delete(completed.promise); completed.resolve() }
  }
  private async flushSelected(targetNext: number, signal?: AbortSignal): Promise<void> {
    await this.acknowledgeThrough(targetNext, signal)
    if (!(this.handle instanceof ProjectSessionHandle)) throw new Error('PROJECT_WRITER_RECEIPT_OWNER_MISMATCH')
    // The handle serializes this barrier after actual started I/O. A queued
    // caller cancellation may skip an unstarted barrier, never its running I/O.
    try {
      // attach() completed the initial header barrier before publishing this
      // route. Reusing its durable prefix still proves the exact live lease.
      if (Number(this.handle.durableEventCount) >= targetNext) await this.handle.assertOwned()
      else await this.handle.flush(signal === undefined ? undefined : { signal })
    }
    catch (error) {
      if (!signal?.aborted || error !== signal.reason) { this.failed ??= error; this.stop() }
      throw error
    }
    signal?.throwIfAborted()
  }
  stagePayload(id: SessionId, input: { codec: string; value: unknown; capture?: (value: unknown) => void }): ProjectPayloadReference {
    if (id !== this.session.id) throw new Error('PROJECT_PAYLOAD_FOREIGN_WRITER')
    this.assertHealthy()
    return (this.ctx.sessionPersistence as ProjectSessionPersistence).stagePayload(id, input)
  }
  readPayload(id: SessionId, ref: ProjectPayloadRef, options?: { signal?: AbortSignal }): Promise<unknown> {
    if (id !== this.session.id) return Promise.reject(new Error('PROJECT_PAYLOAD_FOREIGN_WRITER'))
    return (this.ctx.sessionPersistence as ProjectSessionPersistence).readPayload(id, ref, options)
  }
  async flush(): Promise<void> {
    await this.acknowledgeThrough(Number(this.session.seq))
    try { await this.handle.flush() }
    catch (error) { this.failed ??= error; this.stop(); throw error }
  }
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    const completed = Promise.withResolvers<void>()
    this.closing = completed.promise
    void (async () => {
      const failures: unknown[] = []
      // Cancelled unpublished setup still owns its real, finite suffix. It must
      // join that suffix through the same append route before releasing storage.
      try { this.captureBootstrap() } catch (error) { failures.push(error) }
      this.accepting = false
      // 已接纳的真实lease确认须先结清；后来的读只等待本次关闭交接。
      await Promise.all(this.confirmations)
      try { await this.flush() } catch (error) { failures.push(error) }
      try { await this.handle.close() } catch (error) { failures.push(error) }
      this.detach?.(); this.detachFlush?.(); this.detachRoute?.()
      if (failures.length) throw new AggregateError(failures, 'Project journal close failed')
    })().then(completed.resolve, completed.reject)
    return this.closing
  }
}

/** Public AgentFactory implemented entirely inside the private Projects graph. */
export class ProjectAgentFactory implements AgentFactory {
  private readonly active = new Set<AgentHandle>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly creating = new Map<Promise<unknown>, { id: SessionId; parent?: Agent; abort: AbortController; signal: AbortSignal }>()
  private readonly parents = new Map<AgentHandle, Agent | undefined>()
  private lifecycle: ProjectFactoryLifecycle | undefined
  private readonly shutdown = new AbortController()
  private closing: Promise<void> | undefined
  private readonly unregister: () => void
  private readonly persistence: OwnedPersistence
  constructor(private readonly ctx: Context, private readonly options: ProjectAgentFactoryOptions = {}) {
    if (!Number.isSafeInteger(options.maxParallelToolCalls ?? 4) || (options.maxParallelToolCalls ?? 4) < 1) throw new Error('invalid Project maxParallelToolCalls')
    this.lifecycle = options.lifecycle
    this.persistence = ctx.sessionPersistence as OwnedPersistence
    if (!this.persistence?.registerProjectEventSchema) throw new Error('Projects requires its own SessionPersistence')
    installProjectDriverSchemas(this.persistence)
    ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
    ctx.sessionProjections.register(inboxProjectionDefinition)
    ctx.sessionProjections.register(userInputTimingProjectionDefinition)
    this.unregister = ctx.agents.setFactory(this)
    ctx.effect(() => () => this.close(), 'projects.agentFactory')
    ctx.systemPrompt.variable('provider', context => context.agent?.options.provider)
    ctx.systemPrompt.variable('model', context => context.agent?.options.model)
    ctx.systemPrompt.variable('cwd', context => context.agent?.session.header.cwd)
  }
  setLifecycle(owner: ProjectFactoryLifecycle): () => void {
    if (this.lifecycle !== undefined) throw new Error('Projects factory lifecycle owner is already installed')
    this.lifecycle = owner
    return () => { if (this.lifecycle === owner) this.lifecycle = undefined }
  }
  handles(): readonly { handle: AgentHandle; parent?: Agent }[] { return [...this.active].map(handle => ({ handle, parent: this.parents.get(handle) })) }
  handle(id: SessionId, epoch?: Agent): AgentHandle | undefined { return [...this.active].find(handle => handle.agent.id === id && (epoch === undefined || handle.agent === epoch)) }
  pendingFor(ids: ReadonlySet<SessionId>): readonly Promise<unknown>[] {
    return [...this.creating].filter(([, value]) => ids.has(value.id) || value.parent !== undefined && (ids.has(value.parent.id) || [...ids].some(id => { const root = this.ctx.agents.get(id); return root !== undefined && this.ctx.agents.isOwnedBy(value.parent!.id, root) }))).map(([pending]) => pending)
  }
  cancelCreations(ids: ReadonlySet<SessionId>): Promise<void> {
    const pending = this.pendingFor(ids).map(operation => ({ operation, creation: this.creating.get(operation) }))
    for (const { creation } of pending) creation?.abort.abort(new Error('Selected Project creation is closing'))
    return Promise.allSettled(pending.map(value => value.operation)).then(results => {
      const failures = results.flatMap((result, index) => result.status === 'rejected'
        && !(pending[index]!.creation?.signal.aborted && result.reason === pending[index]!.creation!.signal.reason) ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'Selected Project creation close is unconfirmed')
    })
  }
  private creation<T>(owner: Context, id: SessionId, parent: Agent | undefined, kind: 'create' | 'resume', callerSignal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.lifecycle?.assertCreation(id, parent, kind)
    const abort = new AbortController()
    const ownerAbort = new AbortController()
    const unfollow = owner.effect(() => () => ownerAbort.abort(new Error(`Project ${kind} owner disposed`)))
    const signal = AbortSignal.any([this.shutdown.signal, ownerAbort.signal, abort.signal, ...callerSignal ? [callerSignal] : []])
    const operation = this.track((async () => {
      try { return await run(signal) }
      finally { await unfollow() }
    })())
    this.creating.set(operation, { id, parent, abort, signal })
    void operation.then(() => this.creating.delete(operation), () => this.creating.delete(operation))
    return operation
  }
  private track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation)
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation))
    return operation
  }
  private assertActive(owner: Context): void { owner.fiber.assertActive(); this.shutdown.signal.throwIfAborted() }
  createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    this.assertActive(ownerCtx)
    return this.creation(ownerCtx, options.sessionId, options.parentAgent, 'create', options.signal, signal => this.createOwned(ownerCtx, options, signal))
  }
  private async createOwned(ownerCtx: Context, options: CreateAgentOptions, signal: AbortSignal): Promise<AgentHandle> {
    this.assertParent(options.parentAgent)
    using preparation = SessionPreparation.create(this.ctx.sessions.prepare(options.sessionId, {
      ...options.seed === undefined ? {} : { seed: options.seed },
      ...options.meta === undefined ? {} : { meta: options.meta },
      ...options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount },
    }))
    let stored: SessionHandle | undefined
    try {
      signal.throwIfAborted()
      if (this.options.resolveOwner) this.persistence.registerSessionOwner(options.sessionId, await abortable(this.options.resolveOwner(options.sessionId, options.parentAgent), signal))
      stored = await abortable(this.persistence.create(preparation.session.header, { inheritedEventCount: preparation.session.inheritedEventCount, signal }), signal, handle => handle.close())
      await this.assertProjectOwner(options.sessionId, options.parentAgent, signal)
      if (options.seed !== undefined && options.seed.length > 0 && preparation.session.header.isSeeded) {
        const parentId = preparation.session.header.parentSession
        if (parentId === undefined || options.parentAgent !== undefined && options.parentAgent.id !== parentId) throw new Error('PROJECT_INHERITED_SOURCE_NOT_CONFIRMED')
        const rebound = await (this.persistence as ProjectSessionPersistence).copyInheritedSeed(options.sessionId, parentId, options.seed,
          (event, original) => transformProjectRawForRun(transformProjectDispatchForRun(event, original), original), { signal })
        using copied = SessionPreparation.create(this.ctx.sessions.prepare(options.sessionId, { seed: [...rebound], meta: preparation.session.header, inheritedEventCount: preparation.session.inheritedEventCount, eventState: 'detached' }))
        return await this.setupAndPublish(ownerCtx, copied.session, stored, 0, options.agentOptions ?? {}, options.setup, signal, 'startup', options.parentAgent, rebound)
      }
      return await this.setupAndPublish(ownerCtx, preparation.session, stored, 0, options.agentOptions ?? {}, options.setup, signal, 'startup', options.parentAgent, options.seed ?? [])
    } catch (error) { try { await stored?.close() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Project creation and journal release were not fully confirmed', { cause: error }) }; throw error }
  }
  resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    this.assertActive(ownerCtx)
    return this.creation(ownerCtx, options.resumeSessionId, options.parentAgent, 'resume', options.signal, signal => this.resumeOwned(ownerCtx, options, signal))
  }
  private async resumeOwned(ownerCtx: Context, options: ResumeAgentOptions, signal: AbortSignal): Promise<AgentHandle> {
    this.assertParent(options.parentAgent)
    let stored: SessionHandle | undefined
    try {
      signal.throwIfAborted()
      const resumed = await abortable((this.persistence as ProjectSessionPersistence).openForRun(options.resumeSessionId,
        (event, original) => transformProjectRawForRun(transformProjectDispatchForRun(event, original), original), { signal }), signal, value => value.handle.close())
      stored = resumed.handle
      await this.assertProjectOwner(options.resumeSessionId, options.parentAgent, signal)
      const cold = resumed
      const closers = interruptedTurnClosers(cold.events)
      if (closers.length) await stored.append(closers)
      using preparation = SessionPreparation.create(this.ctx.sessions.prepare(options.resumeSessionId, {
        seed: [...cold.events, ...closers], meta: structuredClone(stored.header),
        inheritedEventCount: stored.inheritedEventCount, eventState: cold.eventState,
      }))
      return await this.setupAndPublish(ownerCtx, preparation.session, stored, cold.events.length + closers.length, options.agentOptions ?? {}, options.setup, signal, 'resume', options.parentAgent, [...cold.events, ...closers])
    } catch (error) { try { await stored?.close() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Project creation and journal release were not fully confirmed', { cause: error }) }; throw error }
  }
  private assertParent(parent: Agent | undefined): void {
    if (parent !== undefined && this.ctx.agents.get(parent.id) !== parent) throw new Error('Project parent must belong to the same runtime graph')
  }
  private async assertProjectOwner(id: SessionId, parent: Agent | undefined, signal: AbortSignal): Promise<void> {
    const owner = await abortable(this.persistence.resolveOwner(id), signal)
    if (!owner) throw new Error(`Project session "${id}" has no registered membership`)
    if (parent === undefined) return
    this.assertParent(parent)
    const parentOwner = await abortable(this.persistence.resolveOwner(parent.id), signal)
    if (!parentOwner || parentOwner.projectId !== owner.projectId) throw new Error('Project parent belongs to a different project')
  }
  private restoredModelOptions(session: Session, options: AgentOptions): AgentOptions {
    // A caller-owned route is one pair; never splice a half override into an
    // unrelated retained route or substitute the profile's current default.
    if (options.provider !== undefined || options.model !== undefined) return options
    const selection = this.ctx.sessionProjections.stateOf(session, 'modelSelection')
    if (selection === undefined) return options
    const header = session.requestHeader(), selected = selection.pending ?? header?.config
    if (!selected?.provider || !selected.model) return options
    const retainedEffort = selection.pending !== null ? selection.pending.reasoningEffort
      : header?.adapterDefaults?.reasoningEffort === true ? undefined : selected.reasoningEffort
    const effort = options.reasoningEffort ?? retainedEffort
    return { ...options, provider: selected.provider, model: selected.model,
      ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }) }
  }
  private async setupAndPublish(owner: Context, session: Session, stored: SessionHandle, storedCount: number, options: AgentOptions, setup: AgentSetup | undefined, signal: AbortSignal, source: 'startup' | 'resume', parent?: Agent, seed: readonly import('@deepseek-ai/dsh-session').SessionEvent[] = []): Promise<AgentHandle> {
    this.assertActive(owner)
    signal.throwIfAborted()
    if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) throw new Error('invalid Project maxTokens')
    initializeProjectRequestProjection(session, seed)
    // Read the restored Session only after its request projection is ready.
    const agentOptions = source === 'resume' ? this.restoredModelOptions(session, options) : options
    const detachProjection = this.ctx.on('session/event', (subject, event) => { if (subject === session) applyProjectRequestProjection(session, event) })
    let agent!: ProjectAgent
    const writer = new ProjectWritePath(this.ctx, session, stored, storedCount, () => agent?.haltPersistence())
    const dependencies = this.ctx.inject(['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'systemPrompt', 'llm', 'tools'], runtimeCtx => {
      agent = new ProjectAgent(runtimeCtx, session.id, agentOptions, session, writer, this.options.request, this.options.maxParallelToolCalls ?? 4)
    })
    try { await abortable(dependencies.await(), signal) }
    catch (error) { const cleanup = await Promise.allSettled([dependencies.dispose(), writer.close()]); detachProjection(); disposeProjectRequestProjection(session); const errors = cleanup.flatMap(value => value.status === 'rejected' ? [value.reason] : []); if (errors.length) throw new AggregateError([error, ...errors], 'Project driver setup and close failed', { cause: error }); throw error }
    let detachAgent: (() => void) | undefined
    let detachSession: (() => void) | undefined
    let disposing: Promise<void> | undefined
    let unfollowOwner: (() => void | Promise<void>) | undefined
    let publishing: Promise<void> = Promise.resolve()
    const handle: AgentHandle = { agent, dispose: () => disposing ??= (async () => {
      agent.retire({ keepInbox: true })
      await publishing
      const failures: unknown[] = []
      try { await agent.whenIdle() } catch (error) { failures.push(error) }
      // Scope cleanup may append final owned facts. Drain it while the exact
      // Session writer and registry identity are still live.
      try { await agent.scope.dispose() } catch (error) { failures.push(error) }
      try { await writer.close() } catch (error) { failures.push(error) }
      detachAgent?.(); detachSession?.()
      try { await dependencies.dispose() } catch (error) { failures.push(error) }
      detachProjection(); disposeProjectRequestProjection(session)
      this.active.delete(handle)
      this.parents.delete(handle)
      if (failures.length) throw new AggregateError(failures, 'Project agent disposal failed')
    })() }
    this.active.add(handle)
    this.parents.set(handle, parent)
    unfollowOwner = owner.effect(() => () => handle.dispose(), `projects.agent(${session.id})`)
    try {
      await agent.runMaintenance(async () => {
        const recordingPolicy = parent === undefined ? undefined : projectRecordingPolicy(parent)
        if (recordingPolicy !== undefined) createProjectRecordingPort().install(agent, recordingPolicy)
        const baseCommit = await abortable(this.options.setupBase?.(agent.ctx, agent, parent), signal, () => {})
        const commit = await abortable(setup?.(agent.ctx, agent), signal, () => {})
        signal.throwIfAborted(); this.assertActive(owner)
        baseCommit?.commit()
        commit?.commit()
        await writer.attach()
        await this.lifecycle?.validateCreation?.(session.id, session.header, parent, source === 'startup' ? 'create' : 'resume')
        signal.throwIfAborted()
        const publication = Promise.withResolvers<void>()
        publishing = publication.promise
        try {
          this.lifecycle?.assertCreation(session.id, parent, source === 'startup' ? 'create' : 'resume')
          detachSession = agent.ctx.sessions.enter(session)
          detachAgent = this.ctx.agents.enter(agent, parent)
          agent.ctx.sessions.announce(session)
          await this.ctx.agents.announce(agent, source, signal)
          signal.throwIfAborted()
        } finally { publication.resolve() }
      })
      const owned: AgentHandle = { agent, dispose: async () => { await handle.dispose(); await unfollowOwner?.() } }
      this.lifecycle?.created?.(owned, parent)
      return owned
    } catch (error) { const cleanup = await Promise.allSettled([handle.dispose()]); try { await unfollowOwner?.() } catch (failure) { cleanup.push({ status: 'rejected', reason: failure }) }; const failures = cleanup.flatMap(value => value.status === 'rejected' ? [value.reason] : []); if (failures.length) throw new AggregateError([error, ...failures], 'Project publication rollback close is unconfirmed', { cause: error }); throw error }
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.shutdown.abort(new Error('Project factory is closing'))
      this.unregister()
      for (const handle of this.active) handle.agent.cancel({ kind: 'disposed' }, { keepInbox: true })
      const operations = [...this.pending].map(operation => ({ operation, signal: this.creating.get(operation)?.signal }))
      const pending = await Promise.allSettled(operations.map(value => value.operation))
      // Equality confirms the operation unwound with its cancellation itself;
      // a failed late-handle release remains a distinct AggregateError.
      const failures = pending.flatMap((result, index) => result.status === 'rejected'
        && !(operations[index]!.signal?.aborted && result.reason === operations[index]!.signal!.reason) ? [result.reason] : [])
      // Child scope cleanup may still notify its parent. Its writer stays live
      // until every actual descendant handle has finished its own close barrier.
      while (this.active.size) {
        const active = [...this.active]
        const leaves = active.filter(handle => !active.some(child => this.parents.get(child) === handle.agent))
        if (!leaves.length) { failures.push(new Error('Projects live ownership contains a cycle')); break }
        const closed = await Promise.allSettled(leaves.map(handle => handle.dispose()))
        failures.push(...closed.flatMap(result => result.status === 'rejected' ? [result.reason] : []))
      }
      if (failures.length) throw new AggregateError(failures, 'Project factory close failed')
    })()
  }
}
export function installProjectAgentFactory(ctx: Context, options?: ProjectAgentFactoryOptions): ProjectAgentFactory { return new ProjectAgentFactory(ctx, options) }
