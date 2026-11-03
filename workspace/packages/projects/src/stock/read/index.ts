/** Projects reads use their own provider; no Agent activation or root query service. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectStore } from '../../records.ts'
import type { MainCarrierPreparation, ProjectSessionSource } from '../../records-types.ts'
import type { ProjectSessionSourceReader } from '../../source-reader.ts'
import type { ProjectSourceDispositionSnapshot } from '../project-ports.ts'
import { ProjectSessionPersistence, type ProjectSessionOwner } from '../persistence/index.ts'
import { CarrierAttachmentOwner } from './attachments.ts'
import { isDeepStrictEqual } from 'node:util'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { ProjectPayloadRef, ProjectRecordDirectory, CommittedRange } from '../persistence/types.ts'

export { CarrierAttachmentOwner, type ExactAttachment } from './attachments.ts'

export interface ProjectReadPrefix {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
  readonly inheritedEventCount: number
  readonly owner: ProjectSessionOwner
  readonly source: 'live' | 'prepared'
  readonly sourceRevision: number
  /** Recheck this observation's authorization without retaining or rereading its body. */
  readonly revalidate: () => Promise<void>
}
export interface ProjectReadOptions { readonly signal?: AbortSignal; readonly fromSeq?: number }
export interface ProjectDirectoryObservation {
  readonly directory: ProjectRecordDirectory
  readonly cut: CommittedRange
  readonly sourceRevision: number
  readonly revalidate: () => Promise<void>
  /** Extend this captured cut's read lease to a later selected payload operation. */
  readonly withOperation: <T>(action: () => Promise<T>) => Promise<T>
  readonly readEvent: (seq: number) => Promise<SessionEvent | undefined>
  readonly readRange: (from: number, to: number) => AsyncIterable<SessionEvent>
}
export type ProjectAttachmentCopy = { readonly source: SessionId } & ({ readonly kind: 'image'; readonly ref: ImageAttachmentRef } | { readonly kind: 'file'; readonly ref: FileAttachmentRef })

interface AttachmentCopyHints {
  readonly refs: (ImageAttachmentRef | FileAttachmentRef)[]
  readonly seqs: Map<string, number>
  journalIdentity?: string
}

export interface ProjectReadPort {
  readonly attachments: CarrierAttachmentOwner
  withPrefix<T>(id: SessionId, action: (prefix: ProjectReadPrefix) => T | Promise<T>, options?: ProjectReadOptions): Promise<T>
  /** Ordinary scoped reads use metadata and exact selected records, never an implicit full body. */
  withDirectory<T>(id: SessionId, action: (observation: ProjectDirectoryObservation) => T | Promise<T>, options?: ProjectReadOptions): Promise<T>
  page(id: SessionId, request?: ProjectReadOptions & { readonly offset?: number; readonly limit?: number }): Promise<{ readonly header: SessionHeader; readonly events: readonly SessionEvent[]; readonly nextOffset?: number; readonly inheritedEventCount: number }>
  search(id: SessionId, request: ProjectReadOptions & { readonly text: string; readonly afterSeq?: number; readonly limit?: number }): Promise<{ readonly header: SessionHeader; readonly matches: readonly SessionEvent[]; readonly nextAfterSeq?: number }>
  readAttachment(id: SessionId, request: ProjectReadOptions & ({ readonly kind: 'image'; readonly ref: ImageAttachmentRef } | { readonly kind: 'file'; readonly ref: FileAttachmentRef })): Promise<{ readonly ref: ImageAttachmentRef | FileAttachmentRef; readonly data: Uint8Array }>
  /** Validate recorded source membership and own exact transfer through target persistence. */
  copyAttachment(source: SessionId, target: SessionId, request: ProjectReadOptions & { readonly beforeSave?: () => void } & ({ readonly kind: 'image'; readonly ref: ImageAttachmentRef } | { readonly kind: 'file'; readonly ref: FileAttachmentRef })): Promise<ImageAttachmentRef | FileAttachmentRef>
  /** Ordered copies share only selected record-position hints within this call. */
  copyAttachments(requests: readonly ProjectAttachmentCopy[], target: SessionId, options?: ProjectReadOptions): Promise<void>
  publishDisposition(snapshot: ProjectSourceDispositionSnapshot): void
  drainForCarrier(id: SessionId): Promise<void>
  close(): Promise<void>
}
export interface ProjectsReadConfig {
  readonly persistence: ProjectSessionPersistence
  readonly store?: Pick<ProjectStore, 'findSessionSourceByHostSessionId'> & Partial<Pick<ProjectStore, 'resolveHostOwnership'>>
  readonly readSessionSource?: ProjectSessionSourceReader
}

declare module '@deepseek-ai/cordis' { interface Context { projectsRead: ProjectReadPort } }

interface ReadAuthorization {
  readonly owner: ProjectSessionOwner
  readonly rootId: SessionId
  readonly source?: ProjectSessionSource
  /** A private preparation has no ordinary retained-source membership. */
  readonly preparation?: { readonly record: MainCarrierPreparation; readonly owner: ProjectSessionOwner }
}

function bounded(value: number, max: number, subject: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new TypeError(`${subject} is outside its allowed range`)
  return value
}

class ProjectsReadService extends Service implements ProjectReadPort {
  readonly attachments: CarrierAttachmentOwner
  private readonly pending = new Map<SessionId, Set<Promise<unknown>>>()
  private readonly reading = new Map<SessionId, Promise<ProjectReadPrefix>>()
  private disposition?: ProjectSourceDispositionSnapshot
  private closing?: Promise<void>
  private readonly readSessionSource?: (id: string, owner: ProjectSessionOwner) => Promise<ProjectSessionSource | undefined>

  constructor(ctx: Context, private readonly config: ProjectsReadConfig) {
    super(ctx, 'projectsRead')
    this.attachments = new CarrierAttachmentOwner(config.persistence)
    this.readSessionSource = config.readSessionSource === undefined
      ? config.store === undefined ? undefined : (id, owner) => config.store!.findSessionSourceByHostSessionId(id, owner)
      : (id, owner) => config.readSessionSource!(id, owner.projectId)
    // A new event may arrive after a shared read has selected its durable cut.
    // A later consumer must then start another read, even while the old one closes.
    ctx.on('session/event', session => { this.reading.delete(session.id) })
    ctx.effect(() => () => this.close(), 'projects.read')
  }

  publishDisposition(snapshot: ProjectSourceDispositionSnapshot): void {
    if (this.disposition !== undefined && snapshot.generation < this.disposition.generation) throw new Error('PROJECT_SOURCE_DISPOSITION_STALE')
    this.disposition = { ...snapshot, claimed: new Set(snapshot.claimed), unavailable: new Map(snapshot.unavailable),
      ...(snapshot.userAddressable === undefined ? {} : { userAddressable: new Set(snapshot.userAddressable) }),
      ...(snapshot.execution === undefined ? {} : { execution: new Map(snapshot.execution) }) }
  }

  withPrefix<T>(id: SessionId, action: (prefix: ProjectReadPrefix) => T | Promise<T>, options: ProjectReadOptions = {}): Promise<T> {
    this.assertNotUnavailable(id)
    options.signal?.throwIfAborted()
    let shared = this.reading.get(id)
    if (shared === undefined) {
      shared = this.read(id)
      this.reading.set(id, shared)
      this.track(id, shared)
      const done = () => { if (this.reading.get(id) === shared) this.reading.delete(id) }
      void shared.then(done, done)
    }
    const operation = this.consume(shared, action, options)
    this.track(id, operation)
    return operation
  }

  withDirectory<T>(id: SessionId, action: (observation: ProjectDirectoryObservation) => T | Promise<T>, options: ProjectReadOptions = {}): Promise<T> {
    this.assertNotUnavailable(id)
    options.signal?.throwIfAborted()
    const operation = (async () => {
      const directory = await this.config.persistence.recordDirectory(id, options)
      const authorization = await this.authorize(id, directory.header, directory.owner, options)
      const validate = this.observationValidation(id, authorization)
      // Only work joined to this observation's active operation shares its
      // authorization boundary. Captured async contexts become cold on exit.
      const operations = new AsyncLocalStorage<{ active: boolean }>()
      const assertCurrent = () => {
        options.signal?.throwIfAborted()
        this.assertAvailable(id, authorization.rootId)
      }
      const revalidate = async () => {
        assertCurrent()
        // Explicit consumers include attachment publication. A requested fresh
        // check is never deferred to the enclosing read operation's end.
        await validate()
        assertCurrent()
      }
      await revalidate()
      // Capture the acknowledged boundary before waiting for its writer barrier.
      // Later appends do not silently enlarge this read's selected range.
      const sessions = this.ctx.get('sessions')
      const live = sessions?.get(id)
      if (live !== undefined && (!isDeepStrictEqual(live.header, directory.header) || live.inheritedEventCount !== directory.inheritedEventCount)) throw new Error('PROJECT_SOURCE_CREATION_IDENTITY_MISMATCH')
      const cut = await this.config.persistence.confirmThrough(id, directory.nextSeq, {
        ...(live === undefined ? {} : { session: live }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      if (cut.journalIdentity !== directory.journalIdentity || !isDeepStrictEqual(cut.header, directory.header)
        || cut.owner.projectId !== directory.owner.projectId || cut.owner.logicalSessionId !== directory.owner.logicalSessionId) throw new Error('PROJECT_SOURCE_CHANGED_DURING_CONFIRMATION')
      await revalidate()
      const rangeOptions = { through: cut, ...(options.signal === undefined ? {} : { signal: options.signal }) }
      const withOperation = <U>(work: () => Promise<U>): Promise<U> => {
        assertCurrent()
        const inherited = operations.getStore()
        const pending = (async () => {
          if (inherited?.active) {
            const result = await work()
            assertCurrent()
            // Unjoined work cannot publish under an operation which has ended.
            if (!inherited.active) await validate()
            assertCurrent()
            return result
          }
          await validate()
          assertCurrent()
          const scope = { active: true }
          try {
            const result = await operations.run(scope, work)
            assertCurrent()
            await validate()
            assertCurrent()
            return result
          } finally { scope.active = false }
        })()
        this.track(id, pending)
        return pending
      }
      const service = this
      const observation: ProjectDirectoryObservation = {
        directory, cut, sourceRevision: authorization.source?.revision ?? 0, revalidate, withOperation,
        readEvent: seq => withOperation(() => this.config.persistence.readCanonicalEvent(id, seq, rangeOptions)),
        async *readRange(from, to) {
          service.assertNotUnavailable(id)
          options.signal?.throwIfAborted()
          const drained = Promise.withResolvers<void>()
          service.track(id, drained.promise)
          try {
            await revalidate()
            for await (const event of service.config.persistence.readCanonicalRange(id, from, to, rangeOptions)) {
              assertCurrent()
              yield event
            }
            await revalidate()
          } finally { drained.resolve() }
        },
      }
      const result = await withOperation(() => Promise.resolve(action(observation)))
      options.signal?.throwIfAborted()
      await revalidate()
      options.signal?.throwIfAborted()
      return result
    })()
    this.track(id, operation)
    return operation
  }

  private track(id: SessionId, operation: Promise<unknown>): void {
    let tasks = this.pending.get(id)
    if (tasks === undefined) { tasks = new Set(); this.pending.set(id, tasks) }
    tasks.add(operation)
    const done = () => { tasks!.delete(operation); if (!tasks!.size) this.pending.delete(id) }
    void operation.then(done, done)
  }

  private async consume<T>(shared: Promise<ProjectReadPrefix>, action: (prefix: ProjectReadPrefix) => T | Promise<T>, options: ProjectReadOptions): Promise<T> {
    try {
      const prefix = await waitForConsumer(shared, options.signal)
      options.signal?.throwIfAborted()
      await prefix.revalidate()
      options.signal?.throwIfAborted()
      // Once admitted, an action can own attachment I/O. Drain must join it too.
      const result = await action(prefix)
      options.signal?.throwIfAborted()
      await prefix.revalidate()
      options.signal?.throwIfAborted()
      return result
    } catch (error) {
      options.signal?.throwIfAborted()
      throw error
    }
  }

  private async read(id: SessionId): Promise<ProjectReadPrefix> {
    // A live graph already owns its body. Its first scan only establishes durable
    // identity; the post-barrier scan verifies and reuses that graph record by record.
    const sessions = this.ctx.get('sessions')
    const initiallyLive = sessions?.get(id)
    const opened = initiallyLive === undefined ? await this.config.persistence.openReadSnapshot(id)
      : { handle: await this.config.persistence.openReadIdentity(id), events: undefined }
    const { handle } = opened
    let events = opened.events
    let authorization!: ReadAuthorization
    let result!: ProjectReadPrefix
    try {
      const owner = handle.owner
      authorization = await this.authorize(id, handle.header, owner, {})
      const before = authorization.source
      this.assertAvailable(id, authorization.rootId)
      // Only this private graph's live Session may request its own durability
      // barrier. Opening a cold handle never calls resolve/create/activate.
      const live = sessions?.get(id)
      if (live !== undefined) {
        events = undefined
        if (!isDeepStrictEqual(live.header, handle.header) || live.inheritedEventCount !== handle.inheritedEventCount) throw new Error('PROJECT_SOURCE_CREATION_IDENTITY_MISMATCH')
        // Capture before the barrier: listeners may append during flush, and an
        // event arriving after that barrier must not be claimed as already durable.
        const livePrefix = live.snapshotEvents()
        if (!await sessions!.flush(live)) throw new Error('PROJECT_SOURCE_DURABILITY_UNCONFIRMED')
        events = (await handle.readSharedPrefix(livePrefix)).events
      }
      // The live Session may have disappeared while its identity was authorized.
      if (events === undefined) events = (await handle.read(0)).events
      const revalidate = this.observationValidation(id, authorization)
      result = { header: handle.header, events, owner, inheritedEventCount: Number(handle.inheritedEventCount), source: live === undefined ? 'prepared' : 'live', sourceRevision: before?.revision ?? 0, revalidate }
    } finally { await handle.close() }
    // Resource close is asynchronous too. Keep the short-read responsibility
    // through it, and perform the final publication cut after its completion.
    await result.revalidate()
    return result
  }

  private observationValidation(id: SessionId, authorization: ReadAuthorization): () => Promise<void> {
    // Capture only identity and Store facts, not the event prefix or its handle.
    const { rootId, source: before, owner } = authorization
    return async () => {
      if (authorization.preparation !== undefined) {
        // Re-prove the exact reservation and its still-current origin, including
        // the real target creation header. Publication/abandonment cannot reuse
        // an observation admitted while this root was private.
        let current: ReadAuthorization
        try { current = await this.authorize(id, authorization.preparation.record.toHeader!, authorization.preparation.owner, {}) }
        catch { throw new Error('PROJECT_SOURCE_CHANGED_DURING_READ') }
        if (!isDeepStrictEqual(current.preparation, authorization.preparation) || current.source?.revision !== before?.revision
          || current.source?.projectId !== before?.projectId || current.source?.id !== before?.id) throw new Error('PROJECT_SOURCE_CHANGED_DURING_READ')
        this.assertAvailable(id, rootId)
        return
      }
      const after = await this.readSessionSource?.(rootId, owner)
      if (this.readSessionSource !== undefined && (after === undefined || after.sourceLifecycle.kind !== 'available' || after.projectDeletion === true || before === undefined
        || after.projectId !== before.projectId || after.id !== before.id || after.revision !== before.revision)) throw new Error('PROJECT_SOURCE_CHANGED_DURING_READ')
      this.assertAvailable(id, rootId)
    }
  }

  private async authorize(id: SessionId, header: SessionHeader, owner: ProjectSessionOwner, options: ProjectReadOptions): Promise<ReadAuthorization> {
    if (this.readSessionSource === undefined) return { rootId: id, owner }
    const validate = (source: ProjectSessionSource | undefined, actualHeader: SessionHeader): ProjectSessionSource => {
      if (source === undefined || source.sourceLifecycle.kind !== 'available' || source.projectDeletion === true) throw new Error('PROJECT_SOURCE_UNAVAILABLE')
      if (source.projectId !== owner.projectId || source.id !== owner.logicalSessionId) throw new Error('PROJECT_SOURCE_IDENTITY_MISMATCH')
      const savedHeader = source.header ?? source.ownedLifecycle?.rootHeader
      if (savedHeader !== undefined && !isDeepStrictEqual(savedHeader, actualHeader)) throw new Error('PROJECT_SOURCE_CREATION_IDENTITY_MISMATCH')
      return source
    }
    const direct = await this.readSessionSource(id, owner)
    if (direct !== undefined) return { rootId: id, source: validate(direct, header), owner }
    const ownership = await this.config.store?.resolveHostOwnership?.(id, owner)
    if (ownership?.kind === 'preparation') {
      const { project, session, preparation } = ownership
      if (project.id !== owner.projectId || session.projectId !== owner.projectId || session.id !== owner.logicalSessionId
        || session.role !== 'main' || project.mainSessionId !== session.id) throw new Error('PROJECT_SOURCE_IDENTITY_MISMATCH')
      const current = session.carriers?.find(carrier => carrier.isCurrent)
      if (project.sourceLifecycle !== undefined || project.archived || session.archived || session.sourceLifecycle.kind !== 'available'
        || preparation.state !== 'unpublished' || preparation.retirement !== undefined || preparation.sourceLifecycle !== undefined
        || current === undefined || current.closed !== undefined || current.sourceLifecycle.kind !== 'available') throw new Error('PROJECT_SOURCE_UNAVAILABLE')
      if (preparation.toHostSessionId !== id || preparation.toHeader === undefined || header.parentSession !== undefined
        || !isDeepStrictEqual(preparation.toHeader, header) || current.hostSessionId !== session.hostSessionId || current.header === undefined
        || !isDeepStrictEqual(preparation.fromHeader, current.header)) throw new Error('PROJECT_SOURCE_CREATION_IDENTITY_MISMATCH')
      const source = validate(await this.readSessionSource(current.hostSessionId, owner), current.header)
      if (source.revision !== session.revision) throw new Error('PROJECT_SOURCE_CHANGED_DURING_READ')
      return { rootId: id, source, owner, preparation: { record: preparation, owner } }
    }
    const published = this.disposition?.execution?.get(id)
    if (published?.member !== undefined) {
      if (!isDeepStrictEqual(published.member.header, header) || published.member.parentSessionId !== header.parentSession) throw new Error('PROJECT_CHILD_CREATION_IDENTITY_MISMATCH')
      const root = await this.config.persistence.recordDirectory(published.rootSessionId, { signal: options.signal })
      if (root.owner.projectId !== owner.projectId || root.owner.logicalSessionId !== owner.logicalSessionId) throw new Error('PROJECT_CHILD_OWNER_MISMATCH')
      return { rootId: published.rootSessionId, source: validate(await this.readSessionSource(published.rootSessionId, owner), root.header), owner }
    }
    // Active descendants need not have an archived Store roster yet. Prove
    // their actual chain from each parent's own durable native catalog, never
    // from a matching owner string or an Agent registry guess.
    let child = header
    const seen = new Set<string>([id])
    while (typeof child.parentSession === 'string') {
      const parentId = child.parentSession as SessionId
      if (seen.has(parentId)) throw new Error('PROJECT_CHILD_LINEAGE_CYCLE')
      seen.add(parentId)
      this.assertNotUnavailable(parentId)
      options.signal?.throwIfAborted()
      const parent = await this.config.persistence.recordDirectory(parentId, { signal: options.signal })
      if (parent.owner.projectId !== owner.projectId || parent.owner.logicalSessionId !== owner.logicalSessionId) throw new Error('PROJECT_CHILD_OWNER_MISMATCH')
      const sessions = this.ctx.get('sessions'), live = sessions?.get(parentId)
      if (live !== undefined && (!isDeepStrictEqual(live.header, parent.header) || live.inheritedEventCount !== parent.inheritedEventCount)) throw new Error('PROJECT_PARENT_DURABILITY_UNCONFIRMED')
      const through = await this.config.persistence.confirmThrough(parentId, parent.nextSeq, {
        ...(live === undefined ? {} : { session: live }), ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      const positions = parent.records.filter(record => record.type === 'subagent/catalog' && record.seq >= parent.inheritedEventCount
        && record.seq < through.nextSeq && record.facts.childId === child.id)
      if (!positions.length) throw new Error('PROJECT_CHILD_CATALOG_IDENTITY_MISMATCH')
      for (const position of positions) {
        // Only the parent's actual catalog occurrence is necessary for admission.
        const event = await this.config.persistence.readCanonicalEvent(parentId, position.seq, { through, ...(options.signal === undefined ? {} : { signal: options.signal }) })
        const data = event?.data as unknown as Record<string, unknown> | undefined
        if (event === undefined || String(event.type) !== 'subagent/catalog' || data?.childId !== child.id || data.childCreatedAt !== child.createdAt) throw new Error('PROJECT_CHILD_CATALOG_IDENTITY_MISMATCH')
      }
      const source = await this.readSessionSource(parentId, owner)
      if (source !== undefined) return { rootId: parentId, source: validate(source, parent.header), owner }
      child = parent.header
    }
    throw new Error('PROJECT_CHILD_HAS_NO_RETAINED_ROOT')
  }

  page(id: SessionId, request: ProjectReadOptions & { offset?: number; limit?: number } = {}) {
    const offset = bounded(request.offset ?? 0, Number.MAX_SAFE_INTEGER, 'offset')
    const limit = bounded(request.limit ?? 100, 1000, 'limit')
    return this.withDirectory(id, async observation => {
      const { directory, cut } = observation
      const events: SessionEvent[] = []
      const from = Math.min(offset, cut.nextSeq), to = Math.min(offset + limit, cut.nextSeq)
      if (from < to) for await (const event of observation.readRange(from, to)) events.push(event)
      return { header: directory.header, inheritedEventCount: Number(directory.inheritedEventCount), events,
        ...(offset + limit < cut.nextSeq ? { nextOffset: offset + limit } : {}) }
    }, { signal: request.signal })
  }

  search(id: SessionId, request: ProjectReadOptions & { text: string; afterSeq?: number; limit?: number }) {
    if (typeof request.text !== 'string' || request.text.length === 0) throw new TypeError('search text is required')
    const after = request.afterSeq === undefined ? -1 : bounded(request.afterSeq, Number.MAX_SAFE_INTEGER, 'afterSeq')
    const limit = bounded(request.limit ?? 30, 100, 'limit')
    return this.withDirectory(id, async observation => {
      const matches: SessionEvent[] = []
      let hasMore = false
      // This explicit global search keeps canonical event.data semantics. It may
      // scan every selected record, but retains only the requested match window.
      if (limit > 0) for await (const event of observation.readRange(Math.min(after + 1, observation.cut.nextSeq), observation.cut.nextSeq)) {
        if (!JSON.stringify(event.data).includes(request.text)) continue
        if (matches.length === limit) { hasMore = true; break }
        matches.push(event)
      }
      return { header: observation.directory.header, matches, ...(hasMore ? { nextAfterSeq: Number(matches.at(-1)!.seq) } : {}) }
    }, { signal: request.signal })
  }

  readAttachment(id: SessionId, request: ProjectReadOptions & ({ kind: 'image'; ref: ImageAttachmentRef } | { kind: 'file'; ref: FileAttachmentRef })) {
    const ref = structuredClone(request.ref)
    return this.withDirectory(id, async observation => {
      await this.requireRecordedAttachment(id, observation, ref, request.signal)
      return this.attachments.track(id, async () => {
        const backend = await this.attachments.forCarrier(id)
        if (request.kind === 'image') return backend.readImage(ref as ImageAttachmentRef, request.signal)
        const chunks: Uint8Array[] = []
        for await (const chunk of backend.readFileStream(ref as FileAttachmentRef, request.signal)) chunks.push(chunk)
        return { ref, data: new Uint8Array(Buffer.concat(chunks)) }
      })
    }, { signal: request.signal })
  }

  async copyAttachments(requests: readonly ProjectAttachmentCopy[], target: SessionId, options: ProjectReadOptions = {}): Promise<void> {
    const copies = structuredClone(requests)
    const hints = new Map<SessionId, AttachmentCopyHints>()
    for (const copy of copies) {
      let source = hints.get(copy.source)
      if (source === undefined) { source = { refs: [], seqs: new Map() }; hints.set(copy.source, source) }
      source.refs.push(copy.ref)
    }
    for (const copy of copies) {
      options.signal?.throwIfAborted()
      const source = hints.get(copy.source)!
      source.refs.shift()
      await this.copyAttachment(copy.source, target, { ...copy, signal: options.signal }, source)
    }
  }

  copyAttachment(source: SessionId, target: SessionId, request: ProjectReadOptions & { readonly beforeSave?: () => void } & ({ kind: 'image'; ref: ImageAttachmentRef } | { kind: 'file'; ref: FileAttachmentRef }), hints?: AttachmentCopyHints) {
    // Authorization spans the actual native read, target save and final source
    // check. A consumer never receives an attachment stream that outlives it.
    request.signal?.throwIfAborted()
    const exact = structuredClone(request.ref)
    return this.attachments.track(source, this.attachments.track(target, () => this.withDirectory(source, async observation => {
      await this.requireRecordedAttachment(source, observation, exact, request.signal, hints)
      const targetOwner = await this.config.persistence.resolveOwner(target)
      if (targetOwner === undefined || targetOwner.projectId !== observation.directory.owner.projectId) throw new Error('PROJECT_ATTACHMENT_TARGET_OWNER_MISMATCH')
      request.signal?.throwIfAborted()
      return this.attachments.copyExact(source, target, request.kind === 'image'
        ? { kind: 'image', ref: exact as ImageAttachmentRef }
        : { kind: 'file', ref: exact as FileAttachmentRef }, request.signal, async () => {
          await observation.revalidate()
          request.signal?.throwIfAborted()
          request.beforeSave?.()
        })
    }, { signal: request.signal })))
  }

  /** Every copy re-reads its selected canonical record and payload; hints grant no admission. */
  private async requireRecordedAttachment(id: SessionId, observation: ProjectDirectoryObservation, ref: ImageAttachmentRef | FileAttachmentRef, signal?: AbortSignal, hints?: AttachmentCopyHints): Promise<void> {
    if (hints !== undefined && hints.journalIdentity !== observation.cut.journalIdentity) {
      hints.seqs.clear(); hints.journalIdentity = observation.cut.journalIdentity
    }
    const contains = (value: unknown, seq: number, remember: boolean): boolean => {
      if (!containsRecordedAttachment(value, ref)) return false
      if (hints === undefined || !remember || hints.refs.length === 0) return true
      // Only the record that already proved this copy may locate later refs.
      // Unrelated scan rows never match every selected attachment again.
      const visit = (value: unknown): void => {
        if (value === null || typeof value !== 'object') return
        const record = value as Record<string, unknown>
        if (record.attachmentId !== undefined) for (const candidate of hints.refs) {
          if (!matchesRecordedAttachment(record, candidate)) continue
          const candidateKey = JSON.stringify(candidate)
          hints.seqs.set(candidateKey, seq)
        }
        for (const child of Object.values(record)) visit(child)
      }
      visit(value)
      return true
    }
    const recorded = async (event: SessionEvent, remember = true): Promise<boolean> => {
      signal?.throwIfAborted()
      if (contains(event.data, Number(event.seq), remember)) return true
      const payload = (event.data as unknown as { payload?: ProjectPayloadRef }).payload
      return payload?.kind === 'projects-payload' && await observation.withOperation(async () =>
        contains(await this.config.persistence.readPayload(id, payload, { signal }), Number(event.seq), remember))
    }
    const hint = hints?.seqs.get(JSON.stringify(ref))
    if (hint !== undefined && hint < observation.cut.nextSeq) {
      const event = await observation.readEvent(hint)
      if (event !== undefined && await recorded(event, false)) return
    }
    // A missing or no-longer-matching hint uses the original ordered full scan.
    for await (const event of observation.readRange(0, observation.cut.nextSeq)) {
      if (await recorded(event)) return
    }
    throw new Error('PROJECT_ATTACHMENT_NOT_RECORDED')
  }

  async drainForCarrier(id: SessionId): Promise<void> {
    while (this.pending.get(id)?.size) await Promise.allSettled([...this.pending.get(id)!])
    await this.attachments.drainForCarrier(id)
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      while (this.pending.size) await Promise.allSettled([...this.pending.values()].flatMap(tasks => [...tasks]))
      await this.attachments.close()
    })()
  }

  private assertNotUnavailable(id: SessionId): void {
    if (this.closing !== undefined) throw new Error('PROJECT_READ_CLOSED')
    if (this.disposition?.unavailable.has(id)) throw new Error('PROJECT_SOURCE_UNAVAILABLE')
  }

  private assertAvailable(id: SessionId, rootId: SessionId): void {
    this.assertNotUnavailable(id)
    this.assertNotUnavailable(rootId)
    if (this.disposition !== undefined && !this.disposition.claimed.has(rootId)) throw new Error('PROJECT_SOURCE_UNAVAILABLE')
  }
}

function waitForConsumer<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    signal.addEventListener('abort', aborted, { once: true })
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

/** Exact recorded-reference membership; no persistent or per-carrier cache. */
export function containsRecordedAttachment(value: unknown, ref: ImageAttachmentRef | FileAttachmentRef): boolean {
  if (Array.isArray(value)) return value.some(item => containsRecordedAttachment(item, ref))
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (matchesRecordedAttachment(record, ref)) return true
  return Object.values(record).some(item => containsRecordedAttachment(item, ref))
}

function matchesRecordedAttachment(record: Record<string, unknown>, ref: ImageAttachmentRef | FileAttachmentRef): boolean {
  return record.attachmentId === ref.attachmentId && Object.entries(ref).every(([key, expected]) => JSON.stringify(record[key]) === JSON.stringify(expected))
}

export function installProjectsReadPort(ctx: Context, config: ProjectsReadConfig): ProjectReadPort {
  if (ctx.get('projectsRead') !== undefined) throw new Error('Projects read owner already installed')
  return new ProjectsReadService(ctx, config)
}
