import { lstat, readdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions, InboxTarget, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import type { UserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, SessionPreparation, type Session, type SessionHeader, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectAgentFactory, ProjectFactoryLifecycle } from '../agent/factory.ts'
import { ProjectWriterLock } from '../persistence/files.ts'
import type { ProjectSessionPersistence, ProjectRunTransform } from '../persistence/index.ts'
import { transformProjectDispatchForRun } from '../request/records.ts'
import { transformProjectRawForRun } from '../recording/records.ts'
import type { ProjectStore } from '../../records.ts'
import type { ProjectControlPort, ProjectInputAdmission, ProjectSourceDispositionSnapshot } from '../project-ports.ts'
import { inboxProjectionDefinition } from '../agent/inbox.ts'
import { sameOwnedCreationHeader, type OwnedSubagentMember, type OwnedQuiescence, type OwnedRetirement, type OwnedRetirementOptions, type ProjectAbsentCarrierProof } from './identity.ts'
import type { StockCapabilityOwnership } from './capabilities.ts'

interface CarrierReadControl {
  drainForCarrier(id: SessionId): Promise<void>
  readonly attachments: { removeCarrier(id: SessionId): Promise<{ status: 'removed'; path: string }> }
}
// Control inspections and temporary Sessions consume the same explicit derived
// representation as the Agent factory. Canonical evidence remains in persistence.
const controlRunTransform: ProjectRunTransform = (event, original) => transformProjectRawForRun(transformProjectDispatchForRun(event, original), original)
export interface ProjectOwnedControlConfig {
  readonly store?: Pick<ProjectStore, 'resolveHostOwnership'>
  readonly persistence: ProjectSessionPersistence
  readonly read: CarrierReadControl
  readonly getFactory: () => ProjectAgentFactory | undefined
  readonly recordsRoot?: string
  readonly getAttachments?: () => CarrierReadControl['attachments'] | undefined
  readonly canSaveColdInput?: (id: SessionId) => boolean | Promise<boolean>
  readonly resumeOptions?: (id: SessionId) => AgentOptions | Promise<AgentOptions>
}
export interface ProjectInputDeliveryResult { insertion: 'inserted' | 'not-inserted' | 'unknown'; persistence: 'flushed' | 'failed' | 'not-started'; copyPersistence: 'flushed' | 'failed' | 'not-started'; wakeup: boolean | 'unknown'; error?: string }
interface Responsibility {
  readonly owner: Agent
  readonly kind: 'job' | 'subagent' | 'workflow' | 'process' | 'title' | 'model'
  readonly cancel: () => void | Promise<void>
  readonly done: Promise<unknown>
}
export interface ProjectResponsibilitySnapshot {
  readonly id: SessionId
  readonly generation: number
  readonly agent?: Agent
  readonly pending: readonly Promise<unknown>[]
  isCurrent(): boolean
  settled(): boolean
}
interface QuiescenceHooks {
  install(agent: Agent, rootId: SessionId): void
  capture(session: Session): void
  settle(agent: Agent): Promise<void>
  settleCold?(id: SessionId, selected: readonly MessageId[]): Promise<void>
  resolveRoot?(header: SessionHeader): Promise<Agent>
}

/** Real lifecycle ownership for this private graph; no root service is replaced. */
export class ProjectOwnedControl implements ProjectControlPort, ProjectFactoryLifecycle, StockCapabilityOwnership {
  private readonly preparedCreation = new AsyncLocalStorage<{ id: SessionId; active: boolean; projectId: string; sessionId: string; attemptId: string }>()
  private readonly admissions = new Set<ProjectInputAdmission>()
  private readonly dispositions = new Set<{ getSnapshot(): ProjectSourceDispositionSnapshot }>()
  private readonly cuts = new Map<SessionId, Set<object>>()
  private readonly archiveSaving = new Map<SessionId, Set<object>>()
  private readonly responsibilities = new Set<Responsibility>()
  private readonly generations = new Map<SessionId, number>()
  private readonly resolving = new Map<SessionId, Promise<{ agent: Agent } | { error: { message: string } }>>()
  private readonly retirementCuts = new Map<SessionId, Set<() => void>>()
  private readonly retirement = new WeakMap<Agent, Promise<{ status: 'stopped' | 'unconfirmed'; errors: readonly unknown[] }>>()
  private readonly inputOperations = new Map<SessionId, Set<Promise<unknown>>>()
  private readonly inputTails = new Map<SessionId, Promise<unknown>>()
  private closing = false
  constructor(private readonly ctx: Context, private readonly config: ProjectOwnedControlConfig) {
    ctx.on('session/event', (session) => { this.bump(session.id) })
    ctx.on('agent/created', ({ agent }) => { this.bump(agent.id) })
    ctx.on('agent/disposed', ({ agent }) => { this.bump(agent.id) })
  }
  private factory(): ProjectAgentFactory {
    const factory = this.config.getFactory()
    if (factory === undefined) throw new Error('Projects Agent factory is not ready')
    return factory
  }
  attachFactory(factory: ProjectAgentFactory): () => void { return factory.setLifecycle(this) }
  private bump(id: SessionId): void { this.generations.set(id, (this.generations.get(id) ?? 0) + 1) }
  private isSelected(agent: Agent, ids: ReadonlySet<SessionId>): boolean {
    return ids.has(agent.id) || [...ids].some(id => { const root = this.ctx.agents.get(id); return root !== undefined && this.ctx.agents.isOwnedBy(agent.id, root) })
  }
  private held(id: SessionId, agent?: Agent): boolean {
    return this.cuts.has(id) || agent !== undefined && [...this.cuts.keys()].some(root => { const parent = this.ctx.agents.get(root); return parent !== undefined && this.ctx.agents.isOwnedBy(agent.id, parent) })
  }
  private acquire(ids: readonly SessionId[]): () => void {
    const token = {}
    for (const id of ids) { const set = this.cuts.get(id) ?? new Set(); set.add(token); this.cuts.set(id, set); this.bump(id) }
    return () => { for (const id of ids) { const set = this.cuts.get(id); set?.delete(token); if (set?.size === 0) this.cuts.delete(id); this.bump(id) } }
  }
  async createPreparedAgent(request: { projectId: string; sessionId: string; attemptId: string; options: CreateAgentOptions }): Promise<AgentHandle> {
    if (this.closing || request.options.parentAgent !== undefined || this.held(request.options.sessionId)) throw new Error('Projects prepared root creation is closing or has an invalid parent')
    const ownership = await this.config.store?.resolveHostOwnership(request.options.sessionId)
    if (ownership?.kind !== 'preparation' || ownership.project.id !== request.projectId || ownership.session.id !== request.sessionId
      || ownership.preparation.attemptId !== request.attemptId || ownership.preparation.state !== 'unpublished' || ownership.preparation.toHeader !== undefined
      || ownership.session.role !== 'main' || ownership.session.hostSessionId !== ownership.preparation.fromHeader.id
      || ownership.project.archived || ownership.session.archived || ownership.preparation.sourceLifecycle !== undefined) throw new Error('Projects prepared creation requires the exact current Store reservation')
    const permit = { id: request.options.sessionId, active: true, projectId: request.projectId, sessionId: request.sessionId, attemptId: request.attemptId }
    try { return await this.preparedCreation.run(permit, () => this.ctx.agents.create(request.options)) }
    finally { permit.active = false }
  }
  async validateCreation(id: SessionId, header: SessionHeader, parent?: Agent, kind: 'create' | 'resume' = 'create'): Promise<void> {
    const permit = this.preparedCreation.getStore()
    if (permit === undefined) return
    if (!permit.active || permit.id !== id || kind !== 'create' || parent !== undefined) throw new Error('Projects prepared creation capability does not match this exact transaction')
    const ownership = await this.config.store?.resolveHostOwnership(id)
    if (ownership?.kind !== 'preparation' || ownership.project.id !== permit.projectId || ownership.session.id !== permit.sessionId
      || ownership.preparation.attemptId !== permit.attemptId || ownership.preparation.state !== 'unpublished'
      || ownership.preparation.sourceLifecycle !== undefined || ownership.project.archived || ownership.session.archived
      || ownership.session.hostSessionId !== ownership.preparation.fromHeader.id
      || ownership.preparation.toHeader !== undefined && !sameOwnedCreationHeader(ownership.preparation.toHeader, header)) throw new Error('Projects prepared reservation changed before actual publication')
  }
  assertCreation(id: SessionId, parent?: Agent, kind: 'create' | 'resume' = 'create'): void {
    const permit = this.preparedCreation.getStore()
    if (kind === 'create' && parent === undefined && permit?.active === true && permit.id === id) {
      if (this.closing || this.held(id) || [...this.dispositions].some(source => source.getSnapshot().unavailable.has(id))) throw new Error('Projects reserved creation was withdrawn before publication')
      return
    }
    if (parent !== undefined) {
      if (this.ctx.agents.get(parent.id) !== parent) throw new Error('Projects creation parent is no longer current')
      this.assertAdmitting(parent.id, parent)
    }
    this.assertAdmitting(id)
  }
  created(handle: AgentHandle): void { this.bump(handle.agent.id) }
  assertAdmitting(id: SessionId, agent?: Agent): void {
    if (this.closing || this.held(id, agent ?? this.ctx.agents.get(id))) throw new Error('Projects target is closing or retiring')
    if (agent !== undefined && this.ctx.agents.get(id) !== agent) throw new Error('Projects target Agent identity changed')
    for (const source of this.dispositions) {
      const snapshot = source.getSnapshot()
      if (snapshot.unavailable.has(id)) throw new Error('Projects source is unavailable')
      const execution = snapshot.execution?.get(id)
      if (execution !== undefined && execution.state !== 'active') throw new Error('Projects target is read-only or its state is unknown')
    }
    for (const admission of this.admissions) admission.assert(id, 'Projects work admission')
  }
  registerInputAdmission(admission: ProjectInputAdmission): () => void { this.admissions.add(admission); return () => this.admissions.delete(admission) }
  registerSourceDisposition(source: { getSnapshot(): ProjectSourceDispositionSnapshot; subscribe(listener: () => void): () => void }): () => void {
    this.dispositions.add(source)
    let previous = source.getSnapshot()
    const facts = (snapshot: ProjectSourceDispositionSnapshot, id: SessionId) => ({ claimed: snapshot.claimed.has(id), unavailable: snapshot.unavailable.get(id), execution: snapshot.execution?.get(id), userAddressable: snapshot.userAddressable?.has(id), nativeScheduleExcluded: snapshot.nativeScheduleExcluded?.has(id) })
    const stop = source.subscribe(() => {
      const current = source.getSnapshot()
      const ids = new Set([...previous.claimed, ...current.claimed, ...previous.unavailable.keys(), ...current.unavailable.keys()])
      for (const id of ids) if (!isDeepStrictEqual(facts(previous, id), facts(current, id))) this.bump(id)
      previous = current
    })
    return () => { stop(); this.dispositions.delete(source) }
  }
  track(responsibility: Responsibility): void {
    this.responsibilities.add(responsibility); this.bump(responsibility.owner.id)
    void responsibility.done.then(() => this.releaseResponsibility(responsibility), () => this.releaseResponsibility(responsibility))
  }
  private releaseResponsibility(value: Responsibility): void { this.responsibilities.delete(value); this.bump(value.owner.id) }
  captureResponsibilities(id: SessionId): ProjectResponsibilitySnapshot {
    const agent = this.ctx.agents.get(id), generation = this.generations.get(id) ?? 0
    const ids = new Set([id])
    const pending = [...this.responsibilities].filter(value => this.isSelected(value.owner, ids)).map(value => value.done)
    pending.push(...this.factory().pendingFor(ids), ...this.inputOperations.get(id) ?? [])
    const isCurrent = () => this.ctx.agents.get(id) === agent && (this.generations.get(id) ?? 0) === generation
    const settled = () => isCurrent() && (this.inputOperations.get(id)?.size ?? 0) === 0 && this.factory().pendingFor(ids).length === 0
      && ![...this.responsibilities].some(value => this.isSelected(value.owner, ids))
      && !this.factory().handles().some(({ handle }) => this.isSelected(handle.agent, ids) && (handle.agent !== agent || handle.agent.status !== 'idle' || (handle.agent.inbox.nextStep.length > 0 || handle.agent.inbox.nextTurn.length > 0)))
    return Object.freeze({ id, generation, ...(agent === undefined ? {} : { agent }), pending: Object.freeze(pending), isCurrent, settled })
  }
  assertResponsibilitiesSettled(snapshot: ProjectResponsibilitySnapshot): void {
    if (!snapshot.settled()) throw new Error('Previously admitted Projects work has not settled at the same carrier generation')
  }
  async captureSettled(id: SessionId): Promise<() => void> {
    const snapshot = this.captureResponsibilities(id)
    this.assertResponsibilitiesSettled(snapshot)
    if (snapshot.agent !== undefined && !await this.ctx.sessions.flush(snapshot.agent.session)) throw new Error('Projects carrier final flush is unconfirmed')
    this.assertResponsibilitiesSettled(snapshot)
    return () => this.assertResponsibilitiesSettled(snapshot)
  }
  async assertSettled(id: SessionId): Promise<void> { await this.captureSettled(id) }
  private input<T>(id: SessionId, run: () => Promise<T>): Promise<T> {
    const operation = (this.inputTails.get(id) ?? Promise.resolve()).then(run, run)
    this.inputTails.set(id, operation)
    const set = this.inputOperations.get(id) ?? new Set<Promise<unknown>>()
    set.add(operation); this.inputOperations.set(id, set); this.bump(id)
    const done = () => { set.delete(operation); if (!set.size) this.inputOperations.delete(id); if (this.inputTails.get(id) === operation) this.inputTails.delete(id); this.bump(id) }
    void operation.then(done, done)
    return operation
  }
  captureColdInbox(id: SessionId): Promise<readonly MessageId[]> {
    return this.input(id, async () => {
      const cold = await this.inspect(id)
      let inbox = inboxProjectionDefinition.init()
      for (const event of cold.events) inbox = inboxProjectionDefinition.apply(inbox, event)
      return [...inbox['next-step'], ...inbox['next-turn']].map(message => message.id)
    })
  }
  /** Share the original live writer or exact cold append transaction; never create an Agent. */
  private async openSessionWrite(id: SessionId, agent?: Agent, options: { signal?: AbortSignal; metadata?: boolean } = {}): Promise<{ session: Session; owner?: { readonly projectId: string; readonly logicalSessionId: string }; flush(): Promise<void>; close(): Promise<void> }> {
    if (agent !== undefined) {
      if (!options.metadata) return { session: agent.session,
        flush: async () => { if (!await this.ctx.sessions.flush(agent.session)) throw new Error('Projects input flush is unconfirmed') },
        close: async () => {} }
      const settled = Promise.withResolvers<void>()
      const release = agent.ctx.effect(() => () => settled.promise, 'projects.session-write')
      return { session: agent.session,
        flush: async () => { if (!await this.ctx.sessions.flush(agent.session)) throw new Error('Projects session flush is unconfirmed') },
        close: async () => { settled.resolve(); await release() } }
    }
    const saved = await this.config.persistence.openForRun(id, controlRunTransform, { signal: options.signal })
    const writer = saved.handle
    let preparation: SessionPreparation | undefined, detach: (() => void) | undefined
    const close = async () => { try { await writer.close() } finally { detach?.(); preparation?.[Symbol.dispose]() } }
    try {
      preparation = SessionPreparation.create(this.ctx.sessions.prepare(id, { seed: [...saved.events], meta: writer.header, inheritedEventCount: writer.inheritedEventCount, eventState: saved.eventState }))
      const session = preparation.session
      // Native SessionTitle validates an exact live Session. Publish only that
      // Session lifetime, with its paired disposal; no Agent, Inbox claim or wake.
      if (options.metadata) { detach = this.ctx.sessions.enter(session); this.ctx.sessions.announce(session) }
      let count = SessionLogOffset(saved.canonicalCount)
      return { session, owner: writer.owner, flush: async () => { const suffix = session.snapshotEvents(count); if (suffix.length) { await writer.append(suffix); count = session.seq }; await writer.flush() }, close }
    } catch (error) { await close(); throw error }
  }
  /** User metadata belongs to its persisted execution identity, independently of work admission. */
  editSessionMetadata<T>(target: { projectId: string; sessionId: string; hostSessionId: string }, run: (session: Session, flush: () => Promise<void>) => Promise<T>): Promise<T> {
    const id = SessionId(target.hostSessionId)
    return this.input(id, async () => {
      if (this.closing || this.held(id)) throw new Error('Projects metadata target is closing or retiring')
      const owner = await this.config.store?.resolveHostOwnership(id)
      if (owner?.kind !== 'current' || owner.project.id !== target.projectId || owner.session.id !== target.sessionId
        || owner.session.role !== 'execution' || owner.project.sourceLifecycle !== undefined || owner.carrier.sourceLifecycle.kind !== 'available') throw new Error('Projects metadata target is not the original available execution')
      if (this.closing || this.held(id) || [...this.dispositions].some(source => source.getSnapshot().unavailable.has(id))) throw new Error('Projects metadata target became unavailable')
      const writer = await this.openSessionWrite(id, this.ctx.agents.get(id), { metadata: true })
      try {
        if (writer.owner !== undefined && (writer.owner.projectId !== target.projectId || writer.owner.logicalSessionId !== target.sessionId)) throw new Error('Projects metadata journal owner changed')
        if (owner.carrier.header !== undefined && !sameOwnedCreationHeader(owner.carrier.header, writer.session.header)) throw new Error('Projects metadata carrier creation identity changed')
        return await run(writer.session, writer.flush)
      }
      finally { await writer.close() }
    })
  }
  deliverPreparedInput(id: SessionId, message: UserMessage, options: {
    target: InboxTarget; wakeup: boolean; signal?: AbortSignal
    prepare?: (session: Session) => void | Promise<void>
  }): Promise<ProjectInputDeliveryResult> {
    options.signal?.throwIfAborted()
    return this.input(id, async () => {
      let insertion: 'inserted' | 'not-inserted' | 'unknown' = 'not-inserted'
      let persistence: 'flushed' | 'failed' | 'not-started' = 'not-started'
      let copyPersistence: 'flushed' | 'failed' | 'not-started' = 'not-started'
      let waking: boolean | 'unknown' = false
      let wake: (() => void) | undefined
      let close: (() => Promise<void>) | undefined
      let result: ProjectInputDeliveryResult | undefined
      try {
        options.signal?.throwIfAborted()
        if (this.closing || [...this.dispositions].some(source => source.getSnapshot().unavailable.has(id))) throw new Error('Projects input target is unavailable')
        let agent = this.ctx.agents.get(id)
        const archiveSaving = this.archiveSaving.has(id)
        if (archiveSaving && agent !== undefined && (agent as Agent & { isAcceptingInput?(): boolean }).isAcceptingInput?.() === false) {
          const handle = this.factory().handle(id, agent)
          if (handle === undefined) throw new Error('Projects archive input has no real writer close owner')
          await handle.dispose(); agent = undefined
        }
        const cold = agent === undefined && (archiveSaving || await this.config.canSaveColdInput?.(id) === true)
        if (!cold && !archiveSaving) {
          this.assertAdmitting(id, agent)
          if (agent === undefined) { const resolved = await this.resolve(id); if ('error' in resolved) throw new Error(resolved.error.message); agent = resolved.agent }
        }
        const writer = await this.openSessionWrite(id, agent, { signal: options.signal })
        const { session, flush } = writer
        close = writer.close
        options.signal?.throwIfAborted()
        if (options.prepare !== undefined) {
          copyPersistence = 'failed'
          await options.prepare(session)
          await flush(); copyPersistence = 'flushed'
        }
        options.signal?.throwIfAborted()
        if ([...this.dispositions].some(source => source.getSnapshot().unavailable.has(id))) throw new Error('Projects input source became unavailable before admission')
        if (agent !== undefined && !archiveSaving) this.assertAdmitting(id, agent)
        else if (agent !== undefined && this.ctx.agents.get(id) !== agent) throw new Error('Projects archive input carrier identity changed')
        insertion = 'unknown'
        if (agent !== undefined) {
          if (options.wakeup && !archiveSaving) {
            const driver = agent as Agent & { sendWithDeferredWake(message: UserMessage, target: InboxTarget): () => void }
            if (typeof driver.sendWithDeferredWake !== 'function') throw new Error('Projects driver cannot defer the wake of durably admitted input')
            wake = driver.sendWithDeferredWake(message, options.target)
          } else agent.send(message, options.target, false)
        }
        else {
          let inbox = inboxProjectionDefinition.init()
          for (const event of session.snapshotEvents()) inbox = inboxProjectionDefinition.apply(inbox, event)
          if ([...inbox['next-step'], ...inbox['next-turn']].some(value => value.id === message.id)) throw new Error('Projects input message is already pending')
          session.append('agent/inbox/spliced', { target: options.target, start: inbox[options.target].length, removedCount: 0, inserted: [message] })
        }
        insertion = 'inserted'; persistence = 'failed'; await flush(); persistence = 'flushed'
        if (options.wakeup && agent !== undefined && !archiveSaving) {
          this.assertAdmitting(id, agent)
          if (wake === undefined) throw new Error('Projects admitted input has no deferred wake')
          waking = 'unknown'; wake(); waking = true
        }
        result = { insertion, persistence, copyPersistence, wakeup: waking }; return result
      } catch (error) { result = { insertion, persistence, copyPersistence, wakeup: waking, error: error instanceof Error ? error.message : String(error) }; return result }
      finally {
        try { await close?.() }
        catch (error) { const message = `Projects cold writer close is unconfirmed: ${error instanceof Error ? error.message : String(error)}`; if (result === undefined) throw error; result.error = result.error === undefined ? message : `${result.error}; ${message}` }
      }
    })
  }
  async inspect(id: SessionId): Promise<{ meta: SessionHeader; events: readonly SessionEvent[]; inheritedEventCount: number; owner?: { readonly projectId: string; readonly logicalSessionId: string } }> {
    const live = this.ctx.sessions.get(id)
    if (live !== undefined) return { meta: live.header, events: live.snapshotEvents(), inheritedEventCount: live.inheritedEventCount }
    // This port serves control/catalog/inbox inspection, never raw export or
    // source minting. A cold inspection must not rehydrate historical payloads.
    const read = await this.config.persistence.readForRun(id, controlRunTransform)
    const handle = read.handle
    try { return { meta: handle.header, events: read.events, inheritedEventCount: handle.inheritedEventCount, owner: handle.owner } }
    finally { await handle.close() }
  }
  resolve(id: SessionId): Promise<{ agent: Agent } | { error: { message: string } }> {
    const pending = this.resolving.get(id)
    if (pending !== undefined) return pending
    const operation = (async () => {
      const tokens: { release(): void }[] = []
      try {
        this.assertAdmitting(id)
        const live = this.ctx.agents.get(id)
        if (live !== undefined) return { agent: live }
        for (const admission of this.admissions) { const token = admission.accept(id, 'Projects resume'); if (token !== undefined) tokens.push(token) }
        const options = await this.config.resumeOptions?.(id)
        this.assertAdmitting(id)
        const handle = await this.ctx.agents.resume({ resumeSessionId: id, ...(options === undefined ? {} : { agentOptions: options }) })
        return { agent: handle.agent }
      } catch (error) { return { error: { message: error instanceof Error ? error.message : String(error) } } }
      finally { for (const token of tokens.reverse()) token.release() }
    })()
    this.resolving.set(id, operation)
    void operation.finally(() => { if (this.resolving.get(id) === operation) this.resolving.delete(id) })
    return operation
  }
  async inspectOwnedSessions(id: SessionId): Promise<readonly OwnedSubagentMember[]> {
    const members = new Map<SessionId, OwnedSubagentMember>()
    const visit = async (parentId: SessionId, visited: Set<SessionId>): Promise<void> => {
      if (visited.has(parentId)) throw new Error('Projects child catalog contains a cycle')
      visited.add(parentId)
      const parent = await this.inspect(parentId)
      const live = this.ctx.sessions.get(parentId)
      using preparation = live === undefined ? SessionPreparation.create(this.ctx.sessions.prepare(parentId, { seed: [...parent.events], meta: parent.meta, inheritedEventCount: SessionLogOffset(parent.inheritedEventCount), eventState: 'detached' })) : undefined
      const catalog = this.ctx.sessionProjections.snapshot(live ?? preparation!.session, ['subagentCatalog']).values.subagentCatalog
      if (catalog === undefined) {
        if (parent.events.some(event => event.type === 'subagent/catalog')) throw new Error('Projects child catalog projection is not installed')
        return
      }
      for (const child of catalog) {
        if (child.mode === 'external') throw new Error('PROJECT_SUBAGENT_MODE_UNSUPPORTED: external executions do not own a local Projects journal')
        if (child.mode === 'unknown') throw new Error('Projects child catalog mode is unsupported')
        const raw = await this.inspect(child.id)
        if (raw.meta.createdAt !== child.createdAt) throw new Error('Projects child catalog creation identity changed')
        const descriptor = foldSubagentDescriptor(raw.events.slice(raw.inheritedEventCount))
        if (descriptor === undefined || descriptor.mode !== child.mode) throw new Error('Projects child catalog disagrees with its own durable descriptor')
        members.set(child.id, { header: raw.meta, parentSessionId: parentId, mode: child.mode, provider: descriptor.provider })
        await visit(child.id, new Set(visited))
      }
    }
    await visit(id, new Set())
    const root = this.ctx.agents.get(id)
    if (root !== undefined) for (const entry of this.factory().handles()) {
      if (entry.parent === undefined || !this.isSelected(entry.handle.agent, new Set([id]))) continue
      const child = entry.handle.agent
      const existing = members.get(child.id)
      if (existing !== undefined && !sameOwnedCreationHeader(existing.header, child.session.header)) throw new Error('Projects live child creation identity changed')
      if (existing === undefined) {
        const identity = this.ctx.sessionProjections.snapshot(child.session, ['subagent']).values.subagent
        if (identity === undefined || identity === null) throw new Error('Projects owned child has no durable subagent descriptor')
        const descriptor = foldSubagentDescriptor(child.session.snapshotEvents(child.session.inheritedEventCount))
        if (descriptor === undefined || descriptor.mode !== identity.mode) throw new Error('Projects live child has no exact own descriptor')
        members.set(child.id, { header: child.session.header, parentSessionId: entry.parent.id, mode: identity.mode, provider: descriptor.provider })
      }
    }
    return [...members.values()]
  }
  private async stopResponsibilities(ids: ReadonlySet<SessionId>): Promise<void> {
    const selected = [...this.responsibilities].filter(value => this.isSelected(value.owner, ids))
    // Every owner receives cancellation before any branch is awaited.
    const cancels = selected.map(value => { try { return Promise.resolve(value.cancel()) } catch (error) { return Promise.reject(error) } })
    for (const { handle } of this.factory().handles()) if (this.isSelected(handle.agent, ids)) handle.agent.cancel({ kind: 'user' }, { keepInbox: true })
    const creates = this.factory().cancelCreations(ids)
    void creates.catch(() => {})
    const inputs = [...ids].flatMap(id => [...this.inputOperations.get(id) ?? []])
    const cancelled = await Promise.allSettled(cancels)
    const cancelErrors = cancelled.flatMap(value => value.status === 'rejected' ? [value.reason] : [])
    if (cancelErrors.length) throw new AggregateError(cancelErrors, 'Projects cancellation was rejected; real work remains owned')
    const results = await Promise.allSettled([...selected.map(value => value.done), creates, ...inputs])
    const errors = results.flatMap(value => value.status === 'rejected' ? [value.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Projects real owner stop is unconfirmed')
  }
  prepareOwnedQuiescence(roots: readonly { header: SessionHeader; members: readonly OwnedSubagentMember[] }[], hooks: QuiescenceHooks): OwnedQuiescence {
    const ids = new Set(roots.flatMap(root => [root.header.id, ...root.members.map(member => member.header.id)]))
    const releaseCut = this.acquire([...ids])
    const savingToken = {}
    for (const id of ids) { const tokens = this.archiveSaving.get(id) ?? new Set<object>(); tokens.add(savingToken); this.archiveSaving.set(id, tokens) }
    const release = () => { for (const id of ids) { const tokens = this.archiveSaving.get(id); tokens?.delete(savingToken); if (!tokens?.size) this.archiveSaving.delete(id) }; releaseCut() }
    const memberInboxes = new Map<SessionId, Promise<readonly MessageId[]>>()
    for (const root of roots) for (const member of root.members) {
      const live = this.ctx.agents.get(member.header.id)
      memberInboxes.set(member.header.id, live === undefined ? this.captureColdInbox(member.header.id) : Promise.resolve([...live.inbox.nextStep, ...live.inbox.nextTurn].map(message => message.id)))
    }
    let stopped: Promise<void> | undefined
    const stopKnown = () => { stopped ??= this.stopResponsibilities(ids); void stopped.catch(() => {}) }
    // Start in the next microtask so the caller can capture all synchronous cuts first.
    const drained = Promise.resolve().then(async () => {
      stopKnown(); await stopped
      const members = new Map(roots.flatMap(root => root.members.map(member => [member.header.id, member] as const)))
      for (const root of roots) for (const member of await this.inspectOwnedSessions(root.header.id)) { members.set(member.header.id, member); if (!memberInboxes.has(member.header.id)) memberInboxes.set(member.header.id, this.captureColdInbox(member.header.id)) }
      await Promise.all(memberInboxes.values())
      const belongsTo = (id: SessionId, member: OwnedSubagentMember): boolean => { let parent = member.parentSessionId; const seen = new Set<SessionId>(); while (parent !== id) { if (seen.has(parent)) return false; seen.add(parent); const next = members.get(parent); if (next === undefined) return false; parent = next.parentSessionId }; return true }
      for (const root of roots) {
        const rootAgent = this.ctx.agents.get(root.header.id)
        if (rootAgent !== undefined) {
          hooks.install(rootAgent, root.header.id); hooks.capture(rootAgent.session)
          await this.ctx.get('subagents')?.drainDescendants([rootAgent])
        }
        for (const member of [...members.values()].filter(member => belongsTo(root.header.id, member)).reverse()) {
          const agent = this.ctx.agents.get(member.header.id)
          if (agent === undefined) {
            const selected = await memberInboxes.get(member.header.id)!
            if (hooks.settleCold !== undefined) await hooks.settleCold(member.header.id, selected)
            else await this.settleColdInbox(member.header.id, false, selected)
            continue
          }
          hooks.install(agent, root.header.id); hooks.capture(agent.session)
          await hooks.settle(agent)
          const result = await this.retire(agent.id, { handle: this.factory().handle(agent.id, agent) })
          if (result.status !== 'stopped') throw new AggregateError(result.errors, 'Projects child close is unconfirmed')
        }
      }
      return [...members.values()]
    })
    return { drained, stopKnown, release, handoffRetirement: (id, options) => ids.has(id) ? this.prepareOwnedRetirement(id, options) : undefined }
  }
  prepareOwnedRetirement(id: SessionId, options: OwnedRetirementOptions): OwnedRetirement {
    const release = this.acquire([id])
    const stopping = this.stopResponsibilities(new Set([id]))
    const drained = (async () => {
      await stopping
      if (await this.config.persistence.stat(id) === undefined) return []
      const members = await this.inspectOwnedSessions(id)
      const root = this.ctx.agents.get(id)
      if (root !== undefined) await this.ctx.get('subagents')?.drainDescendants([root])
      for (const member of [...members].reverse()) {
        const handle = this.factory().handle(member.header.id)
        if (handle !== undefined) await options.retire(member.header.id, handle)
      }
      return members
    })()
    return { drained, release, commit: release }
  }
  settleColdInbox(id: SessionId, preserve: boolean, selected?: readonly MessageId[]): Promise<void> {
    return this.input(id, () => this.settleColdInboxOwned(id, preserve, selected))
  }
  private async settleColdInboxOwned(id: SessionId, preserve: boolean, selected?: readonly MessageId[]): Promise<void> {
    if (this.ctx.agents.get(id) !== undefined) throw new Error('Cold inbox settlement requires the live writer to be closed first')
    if (preserve) return
    const cold = await this.config.persistence.openForRun(id, controlRunTransform)
    const writer = cold.handle
    try {
      using preparation = SessionPreparation.create(this.ctx.sessions.prepare(id, { seed: [...cold.events], meta: writer.header, inheritedEventCount: writer.inheritedEventCount, eventState: cold.eventState }))
      let inbox = inboxProjectionDefinition.init()
      for (const event of cold.events) inbox = inboxProjectionDefinition.apply(inbox, event)
      const start = cold.canonicalCount
      for (const target of ['next-step', 'next-turn'] as const) for (let index = inbox[target].length - 1; index >= 0; index--) if (selected === undefined || selected.includes(inbox[target][index]!.id)) preparation.session.append('agent/inbox/spliced', { target, start: index, removedCount: 1, inserted: [] })
      await writer.append(preparation.session.snapshotEvents(SessionLogOffset(start)))
      await writer.flush()
    } finally { await writer.close() }
  }
  retire(id: SessionId, options?: { handle?: AgentHandle }): Promise<{ status: 'stopped' | 'unconfirmed'; errors: readonly unknown[] }> {
    const current = this.ctx.agents.get(id)
    if (options?.handle !== undefined && current !== undefined && current !== options.handle.agent) return Promise.resolve({ status: 'unconfirmed', errors: [new Error('Projects retirement handle is from a different live incarnation')] })
    const handle = options?.handle ?? this.factory().handle(id)
    const agent = handle?.agent ?? this.ctx.agents.get(id)
    if (agent !== undefined && agent.id !== id) return Promise.resolve({ status: 'unconfirmed', errors: [new Error('Projects retirement handle belongs to another Session')] })
    const previous = agent === undefined ? undefined : this.retirement.get(agent)
    if (previous !== undefined) return previous
    const release = this.acquire([id])
    const retirementCuts = this.retirementCuts.get(id) ?? new Set<() => void>(); retirementCuts.add(release); this.retirementCuts.set(id, retirementCuts)
    const operation = (async () => {
      const errors: unknown[] = []
      try { await this.stopResponsibilities(new Set([id])) } catch (error) { errors.push(error) }
      try {
        if (errors.length) return { status: 'unconfirmed' as const, errors }
        if (agent !== undefined && handle === undefined) throw new Error('Projects live Agent has no real owned handle')
        if (agent !== undefined) {
          const descendants = this.factory().handles().filter(entry => entry.handle.agent !== agent && this.ctx.agents.isOwnedBy(entry.handle.agent.id, agent))
          await this.ctx.get('subagents')?.drainDescendants([agent])
          const released = await Promise.allSettled(descendants.reverse().map(entry => entry.handle.dispose()))
          const failures = released.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
          if (failures.length) throw new AggregateError(failures, 'Projects descendant handles did not close')
        }
        await handle?.dispose()
      } catch (error) { errors.push(error) }
      if (errors.length === 0) { for (const cut of retirementCuts) cut(); this.retirementCuts.delete(id); return { status: 'stopped' as const, errors } }
      return { status: 'unconfirmed' as const, errors }
    })()
    if (agent !== undefined) {
      this.retirement.set(agent, operation)
      void operation.then(result => { if (result.status === 'unconfirmed' && this.retirement.get(agent) === operation) this.retirement.delete(agent) })
    }
    return operation
  }
  async closeOwned(roots: readonly { id: SessionId; epoch?: Agent }[], beforeRetire?: Promise<void>): Promise<void> {
    this.closing = true
    const ids = new Set(roots.map(root => root.id))
    // Cut native admission immediately, but keep the exact writers available
    // until the already accepted background owners finish their final facts.
    const ready = beforeRetire?.catch(() => undefined) ?? Promise.resolve()
    const results = await Promise.allSettled([this.stopResponsibilities(ids), ...(beforeRetire === undefined ? [] : [beforeRetire]), ...roots.map(async root => {
      if (root.epoch !== undefined && this.ctx.agents.get(root.id) !== undefined && this.ctx.agents.get(root.id) !== root.epoch) throw new Error('Projects shutdown root incarnation changed')
      const handle = this.factory().handle(root.id, root.epoch)
      await ready
      const result = await this.retire(root.id, { handle })
      if (result.status !== 'stopped') throw new AggregateError(result.errors, 'Projects root close is unconfirmed')
    })])
    const pending = [...this.responsibilities].filter(value => this.isSelected(value.owner, ids)).map(value => value.done)
    const settled = await Promise.allSettled(pending)
    const errors = [...results, ...settled].flatMap(value => value.status === 'rejected' ? [value.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Projects owned shutdown is partial')
  }
  async prepareAbsentCarrier(id: SessionId): Promise<ProjectAbsentCarrierProof> {
    const releaseCut = this.acquire([id])
    let lease: ProjectWriterLock | undefined
    try {
      await this.stopResponsibilities(new Set([id]))
      if (this.ctx.agents.get(id) !== undefined || this.factory().handle(id) !== undefined) throw new Error('Projects carrier still has a real live handle')
      lease = await ProjectWriterLock.acquire(this.config.persistence.dataRoot, id)
      if (await this.config.persistence.stat(id) !== undefined) throw new Error('Projects carrier materialized; absence is not confirmed')
      const ownership = await this.config.store?.resolveHostOwnership(id)
      if (ownership === undefined) throw new Error('Projects absent carrier has no exact Store ownership')
      if (ownership.kind === 'preparation' ? ownership.preparation.toHeader !== undefined : ownership.carrier.header !== undefined) throw new Error('Projects previously materialized source is missing its journal; cleanup scope is unknown')
      const directory = dirname(this.config.persistence.journalPath(id, { projectId: ownership.project.id, logicalSessionId: ownership.session.id }))
      try { const status = await lstat(directory); if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('Projects absent namespace is not an owned directory'); if ((await readdir(directory)).length) throw new Error('Projects absent journal still has unconfirmed owned artifacts') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      let active = true
      const assertCurrent = () => {
        if (!active || this.factory().handle(id) !== undefined || this.factory().pendingFor(new Set([id])).length) throw new Error('Projects absent-carrier proof is no longer held')
      }
      return { id, assertCurrent, release: async () => { if (!active) return; active = false; try { await lease!.close() } finally { releaseCut() } } }
    } catch (error) { try { await lease?.close() } finally { releaseCut() }; throw error }
  }
  deletionScope(): { dataRoot: string; control: ProjectOwnedControl; assertCurrent(): void } {
    return { dataRoot: this.config.recordsRoot ?? `${this.config.persistence.dataRoot}/projects`, control: this, assertCurrent: () => { this.factory() } }
  }
  async removeCarrier(id: SessionId): Promise<void> {
    // Source unavailability is committed by ProjectStore before this call.
    const unavailable = [...this.dispositions].some(source => source.getSnapshot().unavailable.has(id))
    if (!unavailable) throw new Error('Projects source must be unavailable before permanent carrier cleanup')
    while (this.inputOperations.get(id)?.size) await Promise.allSettled([...this.inputOperations.get(id)!])
    await this.config.read.drainForCarrier(id)
    if (await this.config.persistence.stat(id) === undefined) { await this.config.persistence.removeCarrier(id); return }
    await this.config.read.attachments.removeCarrier(id)
    await this.config.persistence.removeCarrier(id)
  }
}
