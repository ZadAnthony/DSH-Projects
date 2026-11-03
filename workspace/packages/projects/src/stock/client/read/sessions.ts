/** Read-only ISessions owner. It never obtains or promotes a Host Agent. */
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf, SESSION_SEARCH_RESULT_LIMIT, type ISessions, type SessionBinding,
  type SessionReference, type SessionRetainOptions, type SessionRetainInfo, type SessionTarget,
  type SessionListState, type SessionFace, type SessionRemote } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { RemoteStream, type RemoteHostFacts, type RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { Session } from '../native/session.ts'
import type { SessionRemotes } from '../remote-shim.ts'
import type { ProjectUiProjectionsRequest } from '../../ui-host/types.ts'
import { assertProjectFileBinding, sameProjectFileBinding, type ProjectFileBinding } from './file-reader.ts'

export interface ProjectReadRemotePort {
  readonly uiFollowReadonly: SessionRemote['follow']
  uiProjections(request: ProjectUiProjectionsRequest, signal?: AbortSignal): ReturnType<SessionRemote['projections']>
  readonly uiPage: SessionRemote['page']
  readonly uiAttachment: SessionRemote['attachment']
}
export function projectReadOnlyError(operation: string): RemoteError<'gateway/internal'> {
  return new RemoteError('gateway/internal', `PROJECT_READ_ONLY: ${operation} is unavailable in a history reader`, { reason: 'PROJECT_READ_ONLY', operation })
}
const denied = async (operation: string): Promise<never> => { throw projectReadOnlyError(operation) }
const rejected = async (operation: string) => ({ ok: false as const, error: projectReadOnlyError(operation) })

class ProjectReadRemote implements SessionRemotes {
  readonly session: SessionRemote
  readonly commands: SessionRemotes['commands'] = { execute: () => rejected('command'), list: () => rejected('command.list') }
  readonly subagents: SessionRemotes['subagents'] = { prompt: () => rejected('subagent.prompt'), interruptByParent: () => rejected('subagent.interrupt') }
  constructor(port: ProjectReadRemotePort, exact: ProjectFileBinding,
    private readonly connection: Pick<ConnectionHandle, 'generation'>, readonly $host: RemoteHostFacts) {
    this.session = {
      follow: (request, signal) => {
        if (request.address.kind !== 'session' || request.address.sessionId !== exact.hostSessionId) throw projectReadOnlyError('foreign follow')
        const source = port.uiFollowReadonly(request, signal)
        return { send: item => source.send(item), end: () => source.end(), dispose: () => source.dispose(),
          async *[Symbol.asyncIterator]() {
            try {
              for await (const frame of source) {
                if (frame.type === 'snapshot' && (frame.header.id !== exact.hostSessionId || frame.header.createdAt !== exact.sessionCreatedAt)) {
                  throw new RemoteError('gateway/internal', 'PROJECT_SOURCE_STALE: original carrier header no longer matches', { reason: 'PROJECT_SOURCE_STALE' })
                }
                yield frame
              }
            } finally { source.dispose() }
          },
        }
      },
      page: (request, signal) => {
        if (request.address.kind !== 'session' || request.address.sessionId !== exact.hostSessionId) throw projectReadOnlyError('foreign page')
        return port.uiPage(request, signal)
      },
      attachment: request => {
        if (request.sessionId !== exact.hostSessionId) throw projectReadOnlyError('foreign attachment')
        return port.uiAttachment(request)
      },
      control: () => { throw projectReadOnlyError('control') },
      prompt: () => rejected('prompt'), cancel: () => rejected('cancel'), updateQueue: () => rejected('updateQueue'),
      modelCatalog: () => rejected('modelCatalog'), selectModel: () => rejected('selectModel'),
      rename: () => rejected('rename'), fork: () => rejected('fork'),
      list: () => rejected('list'), create: () => rejected('create'),
      projections: (request, signal) => {
        if (request.sessionId !== exact.hostSessionId) throw projectReadOnlyError('foreign projections')
        return port.uiProjections({ sessionId: request.sessionId, expectedCreatedAt: exact.sessionCreatedAt }, signal)
      },
      search: () => rejected('search'), initializeDefaultModel: () => rejected('initializeDefaultModel'),
      canOpenWorkspacePath: () => rejected('canOpenWorkspacePath'), openWorkspacePath: () => rejected('openWorkspacePath'),
      workspacePathApplications: () => rejected('workspacePathApplications'),
    }
  }
  $stream<Item>(options: RemoteStreamOptions<Item>): RemoteStream<Item> { return new RemoteStream(this.connection, options) }
  dispose(): void {}
}

/** Mutators fail before the native Session can modify optimistic local state. */
export class ProjectReadSession extends Session {
  override beginSubmission: SessionFace['beginSubmission'] = () => { throw projectReadOnlyError('beginSubmission') }
  override prompt: SessionFace['prompt'] = () => rejected('prompt')
  override cancel: SessionFace['cancel'] = () => rejected('cancel')
  override updateQueue: SessionFace['updateQueue'] = () => rejected('updateQueue')
  override rename: SessionFace['rename'] = () => rejected('rename')
  override command: SessionFace['command'] = () => rejected('command')
}

interface Record {
  readonly exact: ProjectFileBinding
  readonly scope: ReturnType<typeof createScope>
  readonly remote: ProjectReadRemote
  readonly native: ProjectReadSession
  readonly binding: SessionBinding
  readonly ready: Promise<void>
  readonly stopProjections: () => void
  readonly sources: Map<SessionRetainOptions['source'], number>
  references: number
  ended: boolean
}
const ZERO: SessionRetainInfo = Object.freeze({ referenceCount: 0, retainedBy: {} })

export class ProjectReadSessions implements ISessions {
  readonly list = createSnapshotStore<SessionListState>({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} })
  readonly searchResultLimit = SESSION_SEARCH_RESULT_LIMIT
  private readonly addresses = new Map<SessionId, ProjectFileBinding>()
  private readonly records = new Map<SessionId, Record>()
  private readonly retains = new Map<SessionId, ReturnType<typeof createSnapshotStore<SessionRetainInfo>>>()
  private readonly pending = new Set<Promise<void>>()
  private readonly projectionReads = new Map<SessionId, AbortController>()
  private disposed = false
  constructor(readonly ctx: Context, readonly port: ProjectReadRemotePort,
    readonly connection: Pick<ConnectionHandle, 'generation'>, readonly host: RemoteHostFacts) { ctx.provide('sessions', this) }

  adopt(exact: ProjectFileBinding, cwd?: string): void {
    assertProjectFileBinding(exact)
    const id = SessionId(exact.hostSessionId)
    const old = this.addresses.get(id)
    if (old !== undefined && !sameProjectFileBinding(old, exact)) throw new Error('PROJECT_SOURCE_STALE: a physical id cannot be rebound to another source')
    this.addresses.set(id, Object.freeze({ ...exact }))
    const current = this.list.getSnapshot()
    this.list.set({ ...current, ids: [...this.addresses.keys()], byId: { ...current.byId, [id]: {
      id, displayTitle: exact.sessionTitle ?? exact.sessionId, title: exact.sessionTitle ?? exact.sessionId,
      running: false, blank: false, updatedAt: exact.sessionCreatedAt, retainedBy: this.retainInfo(id).getSnapshot().retainedBy,
      ...(cwd === undefined ? {} : { cwd }),
    } } })
  }
  address(id: string): ProjectFileBinding | undefined { return this.addresses.get(SessionId(id)) }
  private publishProjectionValues(id: SessionId, values: ReturnType<ProjectReadSession['projections']['values']>): void {
    const current = this.list.getSnapshot(), row = current.byId[id]
    this.list.set({ ...current,
      byId: row === undefined ? current.byId : { ...current.byId, [id]: { ...row, projectionValues: values } },
      projectionsBySession: { ...current.projectionsBySession, [id]: { values, state: 'ready', error: null } },
    })
  }
  /** Exact read adapter for native read-only resource consumers such as Plan previews. */
  remoteFor(id: SessionId): SessionRemotes {
    const exact = this.addresses.get(id)
    if (exact === undefined) throw new Error('PROJECT_SOURCE_INVALID: native resource is not an adopted Project carrier')
    return this.records.get(id)?.remote ?? new ProjectReadRemote(this.port, exact, this.connection, this.host)
  }

  retain(target: SessionTarget, options: SessionRetainOptions): SessionReference {
    if (this.disposed) throw new Error('Project Reader is disposed')
    options.signal?.throwIfAborted()
    if (typeof target !== 'string') throw projectReadOnlyError('addressed subagent')
    const exact = this.addresses.get(target)
    if (exact === undefined) throw new Error('PROJECT_SOURCE_INVALID: Reader requires an exact carrier address')
    let record = this.records.get(target)
    if (record === undefined) {
      const scope = createScope(this.ctx, target)
      const remote = new ProjectReadRemote(this.port, exact, this.connection, this.host)
      const native = new ProjectReadSession(target, remote)
      native.bindScope(scope.ctx); native.handleBlank(false)
      const stopProjections = native.projections.subscribeAny(() => {
        this.publishProjectionValues(target, native.projections.values())
      })
      const binding: SessionBinding = { sessionId: target, session: native, ctx: scope.ctx, eventSource: native.eventSource }
      record = { exact, scope, remote, native, binding, ready: native.open(), stopProjections, sources: new Map(), references: 0, ended: false }
      this.records.set(target, record)
    }
    const owned = record
    owned.references++; owned.sources.set(options.source, (owned.sources.get(options.source) ?? 0) + 1)
    this.publish(target, owned)
    let released = false
    let rejectReady: ((reason: unknown) => void) | undefined
    const ready = new Promise<SessionBinding>((resolve, reject) => {
      rejectReady = reject
      void owned.ready.then(() => {
        if (released || owned.ended) reject(new DOMException('Project Reader released', 'AbortError'))
        else if (owned.native.getSnapshot().openState === 'error') reject(owned.native.getSnapshot().openError)
        else resolve(owned.binding)
      }, reject)
    })
    const release = (): void => {
      if (released) return; released = true
      options.signal?.removeEventListener('abort', release)
      rejectReady?.(new DOMException('Project Reader released', 'AbortError'))
      owned.references--; const count = (owned.sources.get(options.source) ?? 0) - 1
      if (count <= 0) owned.sources.delete(options.source); else owned.sources.set(options.source, count)
      this.publish(target, owned)
      if (owned.references !== 0 || owned.ended) return
      owned.ended = true; this.records.delete(target)
      const done = this.disposeRecord(owned); this.pending.add(done)
      void done.then(() => { this.pending.delete(done) }, () => { this.pending.delete(done) })
    }
    options.signal?.addEventListener('abort', release, { once: true })
    if (options.signal?.aborted) release()
    void ready.catch(() => {})
    return { sessionId: target, get binding() { if (released || owned.ended) throw new Error('Project Reader reference expired'); return owned.binding }, ready, release, [Symbol.dispose]: release }
  }
  async using<T>(target: SessionTarget, options: SessionRetainOptions, operation: (ref: SessionReference) => T | Promise<T>): Promise<T> {
    const ref = this.retain(target, options); try { await ref.ready; return await operation(ref) } finally { ref.release() }
  }
  retainInfo(id: SessionId) {
    let store = this.retains.get(id)
    if (store === undefined) { store = createSnapshotStore(ZERO); this.retains.set(id, store) }
    return store
  }
  private publish(id: SessionId, record: Record): void {
    const info = { referenceCount: record.references, retainedBy: Object.fromEntries(record.sources) }
    this.retainInfo(id).set(info)
    const current = this.list.getSnapshot(), row = current.byId[id]
    if (row !== undefined) this.list.set({ ...current, byId: { ...current.byId, [id]: { ...row, retainedBy: info.retainedBy } } })
  }
  create: ISessions['create'] = () => denied('sessions.create')
  fork: ISessions['fork'] = () => denied('sessions.fork')
  search: ISessions['search'] = () => rejected('sessions.search')
  refresh: ISessions['refresh'] = async () => {}
  refreshProjections: ISessions['refreshProjections'] = async id => {
    if (this.disposed) return
    this.projectionReads.get(id)?.abort()
    const abort = new AbortController(); this.projectionReads.set(id, abort)
    try {
      const result = await this.remoteFor(id).session.projections({ sessionId: id }, abort.signal)
      abort.signal.throwIfAborted()
      if (!result.ok) throw result.error
      const baseline = result.value
      if (baseline === null || baseline.kind !== 'sequenced') throw new Error('PROJECT_SOURCE_UNAVAILABLE: the native read returned no exact projection baseline')
      const record = this.records.get(id)
      if (record !== undefined) {
        record.native.projections.seed({ ...baseline, asOfSeq: baseline.asOfSeq === -1 ? -1 : SessionSeq(baseline.asOfSeq) })
        this.publishProjectionValues(id, record.native.projections.values())
      } else this.publishProjectionValues(id, baseline.values)
    } catch (error) {
      if (abort.signal.aborted || this.disposed) return
      const current = this.list.getSnapshot(), previous = current.projectionsBySession[id]
      const failure = new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {})
      this.list.set({ ...current, projectionsBySession: { ...current.projectionsBySession,
        [id]: { values: previous?.values ?? {}, state: 'error', error: failure } } })
    } finally { abort.abort(); if (this.projectionReads.get(id) === abort) this.projectionReads.delete(id) }
  }
  subagentAddress: ISessions['subagentAddress'] = () => undefined
  binding: ISessions['binding'] = id => this.records.get(id)?.binding
  scope: ISessions['scope'] = id => this.records.get(id)?.binding.ctx
  scopeOf: ISessions['scopeOf'] = context => {
    const id = scopeOf(context)
    if (id === undefined || context.root !== this.ctx.root) return undefined
    const binding = this.records.get(id)?.binding
    const filter = (context as Context & { readonly [Context.filter]?: unknown })[Context.filter]
    return binding !== undefined && typeof filter === 'function'
      && filter === (binding.ctx as Context & { readonly [Context.filter]?: unknown })[Context.filter] ? id : undefined
  }
  sessionOf: ISessions['sessionOf'] = context => { const id = this.scopeOf(context); return id === undefined ? undefined : this.records.get(id)?.native }
  async reconnect(): Promise<void> { await Promise.all([...this.records.values()].map(record => record.native.resync())) }
  private async disposeRecord(record: Record): Promise<void> {
    record.stopProjections(); record.native.unbindScope(); await record.native.dispose(); record.remote.dispose(); await record.scope.fiber.dispose()
  }
  async dispose(): Promise<void> {
    if (this.disposed) return; this.disposed = true
    for (const abort of this.projectionReads.values()) abort.abort()
    this.projectionReads.clear()
    const records = [...this.records.values()]; this.records.clear()
    for (const record of records) record.ended = true
    await Promise.allSettled([...records.map(record => this.disposeRecord(record)), ...this.pending])
    for (const store of this.retains.values()) store.set(ZERO)
  }
}
