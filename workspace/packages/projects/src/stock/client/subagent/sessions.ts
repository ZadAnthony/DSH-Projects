/** One fixed physical child. It is not inserted into ProjectStore's logical membership. */
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf, createSessionControlStream, SESSION_SEARCH_RESULT_LIMIT,
  type ISessions, type SessionBinding, type SessionReference, type SessionRetainInfo, type SessionRetainOptions,
  type SessionTarget, type SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import { Session } from '../native/session.ts'
import { ProjectReadSession, projectReadOnlyError } from '../read/sessions.ts'
import type { ProjectRemoteShim } from '../remote-shim.ts'
import { ProjectSubagentCapture, sameSubagentAddress } from './transport.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { sidebarChat: unknown }
}

class FixedChildSession extends Session {
  constructor(id: SessionId, remote: ProjectRemoteShim, private readonly capture: ProjectSubagentCapture) {
    super(id, remote, { address: capture.address })
  }
  override beginSubmission: Session['beginSubmission'] = input => { this.capture.assertWritable(); return super.beginSubmission(input) }
  override prompt: Session['prompt'] = (...args) => { this.capture.assertWritable(); return super.prompt(...args) }
}
interface Generation {
  readonly native: Session
  readonly scope: ReturnType<typeof createScope>
  readonly binding: SessionBinding
  readonly ready: Promise<void>
  readonly sources: Map<SessionRetainOptions['source'], number>
  readonly stopProjections: () => void
  releaseInteractions?: () => void
  references: number
  ended: boolean
}
const ZERO: SessionRetainInfo = Object.freeze({ referenceCount: 0, retainedBy: {} })
const rejected = async (operation: string) => ({ ok: false as const, error: projectReadOnlyError(operation) })

export class ProjectSubagentSessions implements ISessions {
  readonly searchResultLimit = SESSION_SEARCH_RESULT_LIMIT
  readonly list: ReturnType<typeof createSnapshotStore<SessionListState>>
  readonly controlError = createSnapshotStore<string | undefined>(undefined)
  private readonly retainStore = createSnapshotStore<SessionRetainInfo>(ZERO)
  private record: Generation | undefined
  private readonly pending = new Set<Promise<void>>()
  private readonly control: ReturnType<typeof createSessionControlStream> | undefined
  private readonly stops: (() => void)[] = []
  private parentAvailable: boolean | undefined
  private disposed = false
  constructor(readonly ctx: Context, readonly remote: ProjectRemoteShim, readonly capture: ProjectSubagentCapture, cwd?: string) {
    const id = capture.address.childSessionId
    this.list = createSnapshotStore<SessionListState>({ ids: [id], phase: 'ready', projectionsBySession: {}, byId: {
      [id]: { id, displayTitle: capture.childSource.sessionTitle ?? id, parentId: capture.address.parentSessionId,
        origin: 'subagent', running: false, blank: false, updatedAt: capture.childSource.sessionCreatedAt,
        retainedBy: {}, ...(cwd === undefined ? {} : { cwd }) },
    } })
    ctx.provide('sessions', this)
    if (!capture.readOnly) {
      this.stops.push(remote.$on('api-session/status', (changed, running) => {
        if (changed !== id) return
        this.record?.native.handleRunning(running)
        const current = this.list.getSnapshot(), row = current.byId[id]!
        this.list.set({ ...current, byId: { ...current.byId, [id]: { ...row, running } } })
      }), remote.$on('api-session/error', (changed, message) => {
        if (changed === id) this.record?.native.handleAgentError(message)
      }), remote.subscribeCatalog(items => {
        this.parentAvailable = items.some(item => item.sessionId === capture.address.parentSessionId && item.agentAvailable)
        this.record?.native.handleSubagentParentAvailable(this.parentAvailable)
      }))
      this.control = createSessionControlStream(remote, { accept: frame => {
        const projections = this.record?.native.projections
        if (projections === undefined) return
        if (frame.type === 'baseline') {
          const baseline = frame.value.projections[id]
          if (baseline !== undefined) projections.seed({ ...baseline, asOfSeq: baseline.asOfSeq === -1 ? -1 : SessionSeq(baseline.asOfSeq) })
        } else if (frame.sessionId === id) projections.apply(frame.key, frame.value, SessionSeq(frame.seq))
      }, failed: error => this.controlError.set(String(error)) })
    }
  }
  start(): void { this.control?.start() }
  reconnect(): void { this.control?.restart(); this.control?.start(); void this.record?.native.resync() }
  retain(target: SessionTarget, options: SessionRetainOptions): SessionReference {
    if (this.disposed) throw new Error('PROJECT_SUBAGENT_DOMAIN_ENDED')
    options.signal?.throwIfAborted()
    if (typeof target === 'string' ? target !== this.capture.address.childSessionId : !sameSubagentAddress(target, this.capture.address)) throw new Error('PROJECT_SUBAGENT_FOREIGN_SESSION')
    const id = this.capture.address.childSessionId
    if (this.record === undefined) {
      const scope = createScope(this.ctx, id)
      const native = this.capture.readOnly ? new ProjectReadSession(id, this.remote, { address: this.capture.address })
        : new FixedChildSession(id, this.remote, this.capture)
      if (this.parentAvailable !== undefined) native.handleSubagentParentAvailable(this.parentAvailable)
      native.bindScope(scope.ctx); native.handleBlank(false)
      const binding: SessionBinding = { sessionId: id, session: native, ctx: scope.ctx, eventSource: native.eventSource }
      const stopProjections = native.projections.subscribeAny(() => {
        if (this.record?.binding !== binding) return
        const current = this.list.getSnapshot(), row = current.byId[id]!, values = native.projections.values()
        this.list.set({ ...current, byId: { ...current.byId, [id]: { ...row, projectionValues: values } },
          projectionsBySession: { ...current.projectionsBySession, [id]: { values, state: 'ready', error: null } } })
      })
      this.record = { native, scope, binding, ready: native.open(), sources: new Map(), stopProjections, references: 0, ended: false }
      if (!this.capture.readOnly) this.record.releaseInteractions = this.remote.retainInteractions(id)
    }
    const owned = this.record
    owned.references++; owned.sources.set(options.source, (owned.sources.get(options.source) ?? 0) + 1); this.publish(owned)
    let released = false, rejectReady: ((error: unknown) => void) | undefined
    const ready = new Promise<SessionBinding>((resolve, reject) => {
      rejectReady = reject
      void owned.ready.then(() => {
        if (released || owned.ended) reject(new DOMException('Child reference released', 'AbortError'))
        else if (owned.native.getSnapshot().openState === 'error') reject(owned.native.getSnapshot().openError)
        else resolve(owned.binding)
      }, reject)
    })
    const release = () => {
      if (released) return; released = true; options.signal?.removeEventListener('abort', release)
      rejectReady?.(new DOMException('Child reference released', 'AbortError'))
      owned.references--; const count = (owned.sources.get(options.source) ?? 0) - 1
      if (count <= 0) owned.sources.delete(options.source); else owned.sources.set(options.source, count)
      this.publish(owned)
      if (owned.references !== 0 || owned.ended) return
      owned.ended = true; if (this.record === owned) this.record = undefined
      const task = this.disposeRecord(owned); this.pending.add(task)
      void task.then(() => this.pending.delete(task), () => this.pending.delete(task))
    }
    options.signal?.addEventListener('abort', release, { once: true }); if (options.signal?.aborted) release()
    void ready.catch(() => {})
    return { sessionId: id, get binding() { if (released || owned.ended) throw new Error('PROJECT_SUBAGENT_REFERENCE_ENDED'); return owned.binding }, ready, release, [Symbol.dispose]: release }
  }
  async using<T>(target: SessionTarget, options: SessionRetainOptions, operation: (reference: SessionReference) => T | Promise<T>): Promise<T> {
    const reference = this.retain(target, options); try { await reference.ready; return await operation(reference) } finally { reference.release() }
  }
  private publish(record: Generation): void {
    const retainedBy = Object.fromEntries(record.sources)
    this.retainStore.set({ referenceCount: record.references, retainedBy })
    const current = this.list.getSnapshot(), id = record.binding.sessionId
    this.list.set({ ...current, byId: { ...current.byId, [id]: { ...current.byId[id]!, retainedBy } } })
  }
  retainInfo: ISessions['retainInfo'] = id => id === this.capture.address.childSessionId ? this.retainStore : createSnapshotStore(ZERO)
  subagentAddress: ISessions['subagentAddress'] = id => id === this.capture.address.childSessionId ? this.capture.address : undefined
  create: ISessions['create'] = async () => { throw projectReadOnlyError('child.sessions.create') }
  fork: ISessions['fork'] = async () => { throw projectReadOnlyError('child.sessions.fork') }
  search: ISessions['search'] = () => rejected('child.sessions.search')
  refresh: ISessions['refresh'] = async () => {}
  refreshProjections: ISessions['refreshProjections'] = async () => {}
  binding: ISessions['binding'] = id => this.record?.binding.sessionId === id ? this.record.binding : undefined
  scope: ISessions['scope'] = id => this.binding(id)?.ctx
  scopeOf: ISessions['scopeOf'] = context => {
    const id = scopeOf(context), binding = this.record?.binding
    const filter = (context as Context & { readonly [Context.filter]?: unknown })[Context.filter]
    return binding !== undefined && id === binding.sessionId && context.root === this.ctx.root && typeof filter === 'function'
      && filter === (binding.ctx as Context & { readonly [Context.filter]?: unknown })[Context.filter] ? id : undefined
  }
  sessionOf: ISessions['sessionOf'] = context => this.scopeOf(context) === this.record?.binding.sessionId ? this.record?.native : undefined
  private async disposeRecord(record: Generation): Promise<void> {
    record.releaseInteractions?.(); record.stopProjections(); record.native.unbindScope(); await record.native.dispose(); await record.scope.fiber.dispose()
  }
  async dispose(): Promise<void> {
    if (this.disposed) return; this.disposed = true
    for (const stop of this.stops) stop(); await this.control?.dispose()
    const active = this.record; this.record = undefined; if (active !== undefined) active.ended = true
    await Promise.allSettled([...(active === undefined ? [] : [this.disposeRecord(active)]), ...this.pending]); this.retainStore.set(ZERO)
  }
}
