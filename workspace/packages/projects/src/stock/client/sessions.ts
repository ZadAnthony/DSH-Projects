/** Projects-owned ISessions. It mints native scopes only for real carrier identities. */
import { Context } from '@deepseek-ai/cordis'
import {
  createScope, scopeOf, createSessionControlStream, SESSION_SEARCH_RESULT_LIMIT,
  type ISessions, type SessionBinding, type SessionReference, type SessionRetainInfo,
  type SessionRetainOptions, type SessionTarget, type SessionListState,
} from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionControlFrame, SessionSummary as NativeSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import type { CarrierAddress } from './draft/types.ts'
import { sameCarrier } from './draft/types.ts'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { ProjectDetail } from '../../public-types.ts'
import { Session } from './native/session.ts'
import { ProjectionValueStore } from './native/projection-store.ts'
import { ProjectRemoteShim, unsupportedProjectClientOperation } from './remote-shim.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { projectsPanel: unknown }
}

interface Generation {
  readonly binding: SessionBinding
  readonly native: Session
  readonly scope: ReturnType<typeof createScope>
  readonly ready: Promise<void>
  releaseInteractions?: (() => void) | undefined
  readonly sources: Map<SessionRetainOptions['source'], number>
  references: number
  ended: boolean
}

export interface ProjectSessionLifecycle {
  readonly onBinding?: (binding: SessionBinding) => (() => void) | undefined
  readonly onCarrierInvalidated?: (address: CarrierAddress, permanent: boolean) => void
}

const ZERO: SessionRetainInfo = Object.freeze({ referenceCount: 0, retainedBy: {} })

export class ProjectSessions implements ISessions {
  readonly list = createSnapshotStore<SessionListState>({ ids: [], byId: {}, phase: 'pending', projectionsBySession: {} })
  readonly searchResultLimit = SESSION_SEARCH_RESULT_LIMIT
  private readonly generations = new Map<SessionId, Generation>()
  private readonly retains = new Map<SessionId, SnapshotStore<SessionRetainInfo>>()
  private readonly projectionStores = new Map<SessionId, ProjectionValueStore>()
  private readonly pendingDisposals = new Set<Promise<void>>()
  private disposed = false
  private readonly carrierAddresses = new Map<SessionId, CarrierAddress>()
  private readonly logicalCarriers = new Map<string, CarrierAddress>()
  private readonly carrierWriteAccess = new Map<SessionId, boolean>()
  private readonly subagentAddresses = new Map<SessionId, SubagentAddress>()
  private readonly agentAvailable = new Map<SessionId, boolean>()
  private control: ReturnType<typeof createSessionControlStream>
  private controlTerminal = false
  private controlReplacement: Promise<void> | undefined
  private readonly stopStatus: () => void
  private readonly stopAgentError: () => void
  private readonly stopCatalog: () => void

  constructor(private readonly ctx: Context, readonly remote: ProjectRemoteShim, private readonly lifecycle: ProjectSessionLifecycle = {}) {
    ctx.provide('sessions', this)
    this.stopStatus = remote.$on('api-session/status', (id, running) => {
      this.generations.get(id)?.native.handleRunning(running)
      const current = this.list.getSnapshot()
      const row = current.byId[id]
      if (row !== undefined) this.list.set({ ...current, byId: { ...current.byId, [id]: { ...row, running } } })
    })
    this.stopAgentError = remote.$on('api-session/error', (id, message) => { this.generations.get(id)?.native.handleAgentError(message) })
    this.stopCatalog = remote.subscribeCatalog(items => { this.adoptCatalog(items) })
    this.control = this.createControl()
  }

  readonly controlError = createSnapshotStore<string | undefined>(undefined)

  private createControl(): ReturnType<typeof createSessionControlStream> {
    const control = createSessionControlStream(this.remote, {
      accept: frame => { if (!this.disposed && this.control === control) this.acceptControl(frame) },
      failed: error => {
        if (this.disposed || this.control !== control) return
        this.controlTerminal = true
        this.controlError.set(error instanceof Error ? error.message : String(error))
      },
    })
    return control
  }

  start(): void {
    if (this.disposed || this.controlTerminal || this.controlReplacement !== undefined) return
    this.control.start()
  }

  /** Reopen streams under the actual next Host generation. */
  reconnect(): void {
    if (this.disposed) return
    for (const store of this.projectionStores.values()) store.clear()
    if (this.controlTerminal) {
      if (this.controlReplacement === undefined) {
        // 原生 logical stream 的终态不可重启；先等旧 consumer 退役，再创建新 owner。
        this.controlReplacement = this.control.dispose().then(() => {
          if (this.disposed) return
          this.control = this.createControl()
          this.controlTerminal = false
          this.control.start()
        }).catch(error => {
          this.controlTerminal = true
          this.controlError.set(error instanceof Error ? error.message : String(error))
        }).finally(() => { this.controlReplacement = undefined })
      }
    } else {
      this.control.restart()
      this.control.start()
    }
    for (const record of this.generations.values()) void record.native.resync()
  }

  private projections(id: SessionId): ProjectionValueStore {
    let value = this.projectionStores.get(id)
    if (value === undefined) {
      value = new ProjectionValueStore()
      this.projectionStores.set(id, value)
      value.subscribeAny(() => { this.publishProjections(id) })
    }
    return value
  }

  private publishProjections(id: SessionId): void {
    const current = this.list.getSnapshot()
    const store = this.projectionStores.get(id)
    if (store === undefined) return
    const row = current.byId[id]
    const title = store.get('title') as { text?: string } | undefined
    this.list.set({ ...current,
      byId: row === undefined ? current.byId : { ...current.byId, [id]: {
        ...row, projectionValues: store.values(), ...(title?.text === undefined ? {} : { title: title.text, displayTitle: title.text }),
      } },
      projectionsBySession: { ...current.projectionsBySession, [id]: { values: store.values(), state: 'ready', error: null } },
    })
  }

  private acceptControl(frame: SessionControlFrame): void {
    if (frame.type === 'baseline') {
      for (const [id, value] of Object.entries(frame.value.projections)) {
        this.projections(SessionId(id)).seed({ ...value, asOfSeq: value.asOfSeq === -1 ? -1 : SessionSeq(value.asOfSeq) })
      }
      this.controlError.set(undefined)
      return
    }
    this.projections(frame.sessionId).apply(frame.key, frame.value, SessionSeq(frame.seq))
  }

  adoptCatalog(items: readonly NativeSummary[]): void {
    const before = this.list.getSnapshot()
    const byId: SessionListState['byId'] = {}
    for (const item of items) {
      this.agentAvailable.set(item.sessionId, item.agentAvailable)
      const previous = before.byId[item.sessionId]
      const retainedBy = this.retainInfo(item.sessionId).getSnapshot().retainedBy
      byId[item.sessionId] = {
        id: item.sessionId, displayTitle: previous?.displayTitle ?? item.sessionId,
        ...(previous?.title === undefined ? {} : { title: previous.title }),
        ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
        ...(item.parentSessionId === undefined ? {} : { parentId: item.parentSessionId }),
        ...(item.origin === undefined ? {} : { origin: item.origin }),
        running: item.running, blank: item.blank, updatedAt: item.updatedAt, retainedBy,
        ...(previous?.projectionValues === undefined ? {} : { projectionValues: previous.projectionValues }),
      }
      const active = this.generations.get(item.sessionId)?.native
      active?.handleRunning(item.running)
      active?.handleBlank(item.blank)
      if (item.projections !== undefined) {
        const store = this.projections(item.sessionId)
        if (item.projections.kind === 'cached') store.applyCached(item.projections.values)
        else store.seed({ ...item.projections, asOfSeq: item.projections.asOfSeq === -1 ? -1 : SessionSeq(item.projections.asOfSeq) })
      }
    }
    // Retained generations stay addressable, but a removed carrier is never silently remapped.
    for (const [id, record] of this.generations) {
      if (byId[id] !== undefined) continue
      // Native catalog publication can lag the Projects detail that installed a
      // replacement carrier. Its absence cannot revoke that exact current
      // carrier proof: handleRemoved is permanent for this Session generation.
      const carrier = this.carrierAddresses.get(id)
      if (carrier === undefined || !this.isCurrent(carrier)) record.native.handleRemoved()
      if (before.byId[id] !== undefined) byId[id] = before.byId[id]
    }
    this.list.set({ ...this.list.getSnapshot(), ids: items.map(item => item.sessionId), byId, phase: 'ready' })
  }

  /** Detail provides the exact physical carrier; a logical session id is never used as a native id. */
  adoptDetail(detail: ProjectDetail): void {
    const before = this.list.getSnapshot()
    const byId = { ...before.byId }
    const ids = new Set(before.ids)
    const presentLogical = new Set(detail.sessions.map(session => JSON.stringify([detail.project.id, session.id])))
    for (const [key, address] of this.logicalCarriers) {
      if (address.projectId !== detail.project.id) continue
      if (!presentLogical.has(key) || detail.unavailableSources.some(source => source.hostSessionId === address.hostSessionId)) {
        this.logicalCarriers.delete(key)
        this.carrierWriteAccess.set(SessionId(address.hostSessionId), false)
        const unavailable = detail.unavailableSources.find(source => source.hostSessionId === address.hostSessionId)
        this.lifecycle.onCarrierInvalidated?.(address, unavailable?.kind === 'deleted' || detail.project.sourceLifecycle?.kind === 'deleted')
      }
    }
    for (const logical of detail.sessions) {
      // Cold historical pages may open a real descendant without ever having held
      // that root carrier live. Preserve its Store-confirmed epoch as read proof.
      for (const historical of logical.carriers ?? []) {
        if (historical.sourceKind !== 'available' || historical.sessionCreatedAt === undefined
          || detail.unavailableSources.some(source => source.hostSessionId === historical.hostSessionId)) continue
        const id = SessionId(historical.hostSessionId)
        this.carrierAddresses.set(id, Object.freeze({ projectId: detail.project.id, logicalSessionId: logical.id,
          hostSessionId: historical.hostSessionId, sessionCreatedAt: historical.sessionCreatedAt, carrierEpoch: historical.sequence }))
        if (!historical.isCurrent || historical.hostSessionId !== logical.hostSessionId) this.carrierWriteAccess.set(id, false)
      }
      const carrier = logical.carriers?.find(row => row.isCurrent && row.hostSessionId === logical.hostSessionId)
      if (carrier?.sessionCreatedAt !== undefined && carrier.sourceKind === 'available'
        && !detail.unavailableSources.some(row => row.hostSessionId === logical.hostSessionId)) {
        const address: CarrierAddress = Object.freeze({ projectId: detail.project.id, logicalSessionId: logical.id,
          hostSessionId: logical.hostSessionId, sessionCreatedAt: carrier.sessionCreatedAt, carrierEpoch: carrier.sequence })
        const key = JSON.stringify([address.projectId, address.logicalSessionId])
        const previous = this.logicalCarriers.get(key)
        if (previous !== undefined && !sameCarrier(previous, address)) {
          this.carrierWriteAccess.set(SessionId(previous.hostSessionId), false)
          this.lifecycle.onCarrierInvalidated?.(previous, false)
        }
        this.carrierAddresses.set(SessionId(address.hostSessionId), address)
        this.logicalCarriers.set(key, address)
        const writable = !detail.project.archived && !logical.archived
        if (previous !== undefined && sameCarrier(previous, address) && this.carrierWriteAccess.get(SessionId(address.hostSessionId)) === true && !writable) {
          this.lifecycle.onCarrierInvalidated?.(previous, false)
        }
        this.carrierWriteAccess.set(SessionId(address.hostSessionId), writable)
      }
      if (logical.hostSessionId === '') throw new Error('Projects detail omitted a real carrier identity')
      const id = SessionId(logical.hostSessionId)
      const old = byId[id]
      const title = logical.title || detail.project.name
      byId[id] = {
        id, title, displayTitle: title, running: old?.running ?? false,
        blank: old?.blank ?? true, updatedAt: Date.parse(detail.project.updatedAt),
        ...(detail.project.workspace === undefined ? {} : { cwd: detail.project.workspace.path }),
        retainedBy: this.retainInfo(id).getSnapshot().retainedBy,
        ...(old?.projectionValues === undefined ? {} : { projectionValues: old.projectionValues }),
      }
      ids.add(id)
    }
    this.list.set({ ...before, ids: [...ids], byId, phase: 'ready' })
  }

  retain(target: SessionTarget, options: SessionRetainOptions): SessionReference {
    if (this.disposed) throw new Error('Projects client domain is disposed')
    options.signal?.throwIfAborted()
    const addressed = typeof target === 'string' ? this.subagentAddresses.get(target) : target
    const id = typeof target === 'string' ? target : target.childSessionId
    if (addressed !== undefined) {
      this.subagentAddresses.set(id, Object.freeze({ ...addressed }))
      const current = this.list.getSnapshot()
      if (current.byId[id] === undefined) this.list.set({ ...current, byId: { ...current.byId,
        [id]: { id, displayTitle: id, parentId: addressed.parentSessionId, origin: 'subagent', running: false, blank: false,
          retainedBy: this.retainInfo(id).getSnapshot().retainedBy, updatedAt: 0 } } })
    }
    if (this.list.getSnapshot().byId[id] === undefined) throw new Error(`Projects carrier is not known: ${id}`)
    if (this.list.getSnapshot().byId[id]?.origin === 'subagent' && addressed === undefined) {
      throw new Error('Project child requires its exact native direct-parent address')
    }
    let record = this.generations.get(id)
    if (record === undefined) {
      const scope = createScope(this.ctx, id)
      const native = new Session(id, this.remote, { ...(addressed === undefined ? {} : { address: addressed,
        parentAvailable: this.agentAvailable.get(addressed.parentSessionId) }), projections: this.projections(id), onEngaged: () => {
        const current = this.list.getSnapshot()
        const row = current.byId[id]
        if (row !== undefined) this.list.set({ ...current, byId: { ...current.byId, [id]: { ...row, blank: false } } })
      } })
      native.bindScope(scope.ctx)
      const binding: SessionBinding = { sessionId: id, session: native, ctx: scope.ctx, eventSource: native.eventSource }
      record = { binding, native, scope, ready: native.open(), sources: new Map(), references: 0, ended: false }
      this.generations.set(id, record)
      record.releaseInteractions = this.lifecycle.onBinding?.(binding)
      const row = this.list.getSnapshot().byId[id]
      native.handleRunning(row?.running ?? false)
      native.handleBlank(row?.blank ?? true)
    }
    const owned = record
    owned.references++
    owned.sources.set(options.source, (owned.sources.get(options.source) ?? 0) + 1)
    this.publishRetains(id, owned)
    let released = false
    let aborted = false
    let rejectReady: ((error: unknown) => void) | undefined
    const ready = new Promise<SessionBinding>((resolve, reject) => {
      rejectReady = reject
      void owned.ready.then(() => {
        if (released || owned.ended) reject(new DOMException('Projects session reference released', 'AbortError'))
        else resolve(owned.binding)
      }, reject)
    })
    const release = (): void => {
      if (released) return
      released = true
      options.signal?.removeEventListener('abort', abort)
      rejectReady?.(new DOMException('Projects session reference released', 'AbortError'))
      owned.references--
      const next = (owned.sources.get(options.source) ?? 0) - 1
      if (next <= 0) owned.sources.delete(options.source)
      else owned.sources.set(options.source, next)
      this.publishRetains(id, owned)
      if (owned.references !== 0 || owned.ended) return
      owned.ended = true
      if (this.generations.get(id) === owned) this.generations.delete(id)
      const done = this.disposeGeneration(owned)
      this.pendingDisposals.add(done)
      void done.then(() => { this.pendingDisposals.delete(done) }, () => { this.pendingDisposals.delete(done) })
    }
    const abort = (): void => { aborted = true; release() }
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted && !aborted) abort()
    // A release is allowed before the owner starts awaiting readiness.
    void ready.catch(() => {})
    return {
      sessionId: id,
      get binding() { if (released || owned.ended) throw new Error('Projects session reference is no longer active'); return owned.binding },
      ready, release, [Symbol.dispose]: release,
    }
  }

  async using<T>(target: SessionTarget, options: SessionRetainOptions, operation: (reference: SessionReference) => T | Promise<T>): Promise<T> {
    const reference = this.retain(target, options)
    try { await reference.ready; return await operation(reference) } finally { reference.release() }
  }

  retainInfo(id: SessionId): SnapshotStore<SessionRetainInfo> {
    let value = this.retains.get(id)
    if (value === undefined) { value = createSnapshotStore(ZERO); this.retains.set(id, value) }
    return value
  }

  private publishRetains(id: SessionId, record: Generation): void {
    const info: SessionRetainInfo = { referenceCount: record.references, retainedBy: Object.fromEntries(record.sources) }
    this.retainInfo(id).set(info)
    const current = this.list.getSnapshot()
    const row = current.byId[id]
    if (row !== undefined) this.list.set({ ...current, byId: { ...current.byId, [id]: { ...row, retainedBy: info.retainedBy } } })
  }

  async refresh(): Promise<void> {
    const result = await this.remote.projects.list()
    if (!result.ok) throw result.error
    for (const project of result.value) {
      const value = await this.remote.projects.get({ projectId: project.id })
      if (!value.ok) throw value.error
      this.adoptDetail(value.value)
    }
    const current = this.list.getSnapshot()
    this.list.set({ ...current, phase: 'ready' })
  }

  async refreshProjections(sessionId: SessionId): Promise<void> {
    const result = await this.remote.session.projections({ sessionId })
    if (!result.ok) throw result.error
    if (result.value === null) return
    if (result.value.kind === 'migration-required') { this.projections(sessionId).applyCached(result.value.values); return }
    this.projections(sessionId).seed({ ...result.value, asOfSeq: result.value.asOfSeq === -1 ? -1 : SessionSeq(result.value.asOfSeq) })
  }

  create: ISessions['create'] = async () => unsupportedProjectClientOperation('sessions.create: create a Project session instead')
  subagentAddress: ISessions['subagentAddress'] = id => this.subagentAddresses.get(id)
  search: ISessions['search'] = async (query, signal) => {
    const result = await this.remote.session.search({ query }, signal)
    if (!result.ok) return result
    return { ok: true, value: { items: [...result.value.items], hasMore: result.value.hasMore } }
  }
  fork: ISessions['fork'] = async () => unsupportedProjectClientOperation('Projects conversations do not expose branches')

  /** Exact Store-confirmed physical address, never synthesized from a logical id. */
  carrierAddress(id: SessionId): CarrierAddress {
    const address = this.carrierAddresses.get(id)
    if (address === undefined) throw new Error(`PROJECT_CARRIER_UNCONFIRMED: ${id}`)
    return address
  }

  resolveCarrier(binding: SessionBinding): CarrierAddress {
    if (this.generations.get(binding.sessionId)?.binding !== binding) throw new Error('PROJECT_CARRIER_GENERATION_ENDED')
    return this.carrierAddress(binding.sessionId)
  }

  isCurrent(address: CarrierAddress): boolean {
    if (this.disposed || this.carrierWriteAccess.get(SessionId(address.hostSessionId)) !== true) return false
    const current = this.logicalCarriers.get(JSON.stringify([address.projectId, address.logicalSessionId]))
    return current !== undefined && sameCarrier(current, address)
  }

  /** Exact backend-resolved child/other address, installed only after its owner returns it. */
  adoptCarrierAddress(address: CarrierAddress, writable = false): void {
    if (!address.projectId || !address.logicalSessionId || !address.hostSessionId || !Number.isFinite(address.sessionCreatedAt)
      || !Number.isSafeInteger(address.carrierEpoch) || address.carrierEpoch < 0) throw new Error('PROJECT_CARRIER_INVALID_ADDRESS')
    this.carrierAddresses.set(SessionId(address.hostSessionId), Object.freeze({ ...address }))
    this.carrierWriteAccess.set(SessionId(address.hostSessionId), writable)
    if (writable) this.logicalCarriers.set(JSON.stringify([address.projectId, address.logicalSessionId]), Object.freeze({ ...address }))
  }

  scope: ISessions['scope'] = id => this.generations.get(id)?.binding.ctx
  scopeOf: ISessions['scopeOf'] = context => {
    const id = scopeOf(context)
    if (id === undefined || context.root !== this.ctx.root) return undefined
    const binding = this.generations.get(id)?.binding
    // Service trackers can derive a caller proxy; the public scope filter preserves exact generation.
    const filter = (context as Context & { readonly [Context.filter]?: unknown })[Context.filter]
    return binding !== undefined && typeof filter === 'function' && filter === (binding.ctx as Context & { readonly [Context.filter]?: unknown })[Context.filter] ? id : undefined
  }
  sessionOf: ISessions['sessionOf'] = context => {
    const id = this.scopeOf(context)
    return id === undefined ? undefined : this.generations.get(id)?.native
  }
  binding: ISessions['binding'] = id => this.generations.get(id)?.binding

  private async disposeGeneration(record: Generation): Promise<void> {
    record.releaseInteractions?.()
    record.native.unbindScope()
    await record.native.dispose()
    await record.scope.fiber.dispose()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.stopStatus(); this.stopAgentError(); this.stopCatalog()
    await this.controlReplacement
    await this.control.dispose()
    const active = [...this.generations.values()]
    this.generations.clear()
    for (const record of active) record.ended = true
    await Promise.allSettled([...active.map(record => this.disposeGeneration(record)), ...this.pendingDisposals])
    for (const store of this.retains.values()) store.set(ZERO)
  }
}
