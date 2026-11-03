import { Context } from '@deepseek-ai/cordis'
import {
  SessionId,
  SessionLogOffset,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  materializeAppendBatch,
  materializeCreateHeader,
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionFormatUnsupportedError,
  SessionHandleClosedError,
  SessionOwnershipLostError,
  SessionPersistence,
  SessionPersistenceCorruptionError,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  SessionReadOnlyError,
} from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionAccess,
  SessionHandle,
  SessionHandleAppendOptions,
  SessionHandleFlushOptions,
  SessionHandleReadOptions,
  SessionHandleReadResult,
  SessionPersistenceCreateOptions,
  SessionPersistenceListOptions,
  SessionPersistenceOpenOptions,
  SessionPersistenceSnapshot,
  SessionPersistenceStatOptions,
} from '@deepseek-ai/dsh-session-persistence'
import { link, open, readFile, readdir, rm, stat, unlink } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  ProjectJournalScanner,
  pathSegment,
  PROJECT_DATA_FORMAT,
  PROJECT_JOURNAL_FORMAT,
  STOCK_SESSION_VERSION,
  isSupportedStockSessionVersion,
  validateEvents,
  validateHeader,
  validateInherited,
  validateOwner,
  validateProjectSchemaType,
  sameJournalValue,
} from './codec.ts'
import type { JournalScan, JournalHeader, ProjectEventValidator, ProjectSessionOwner } from './codec.ts'
import { durableMkdir, hasCode, ProjectWriterLock, syncDirectory, writeAll } from './files.ts'
import { installProjectDriverSchemas } from '../request/dispatch.ts'
import { installProjectRecordingSchemas } from '../recording/events.ts'
import { installCommunicationEventSchemas } from '../../communication/events.ts'
import { installProjectModelSchemas } from '../model/schema.ts'
import { installContinuityEventSchemas } from '../../continuity/events.ts'
import { recordLocator, rowDigest } from './directory.ts'
import { ProjectPayloadStore } from './payload.ts'
import { nativeSourceDigest } from '../../native-source-host.ts'
import type { CommittedRange, ProjectLegacyRecordReference, ProjectPayloadRef, ProjectPayloadReference, ProjectRangeOptions, ProjectRecordDirectory, ProjectRecordLocator, ProjectRunTransform, ProjectRunVisitorOptions, ProjectWriterRoute } from './types.ts'
export type { CommittedRange, ProjectLegacyRecordReference, ProjectPayloadRef, ProjectPayloadReference, ProjectRangeOptions, ProjectRecordDirectory, ProjectRecordLocator, ProjectRunTransform } from './types.ts'

export type { ProjectEventValidator, ProjectSessionOwner } from './codec.ts'
export { PROJECT_DATA_FORMAT, PROJECT_JOURNAL_FORMAT, STOCK_SESSION_VERSION } from './codec.ts'
export { sameJournalValue } from './codec.ts'

export interface ProjectSessionPersistenceConfig { readonly dataRoot: string; readonly maxPendingPayloadBytes?: number }

const DATA_HEADER = Object.freeze({ format: PROJECT_DATA_FORMAT, journalFormat: PROJECT_JOURNAL_FORMAT, nativeVersion: STOCK_SESSION_VERSION })
const JOURNAL_FILENAME = 'journal.v1.jsonl'
// Kept on this one open operation, never on a long-lived SessionHandle.
const captureReadSnapshot = Symbol('Projects read snapshot')
type SnapshotOpenOptions = SessionPersistenceOpenOptions & { [captureReadSnapshot]?: (events: readonly SessionEvent[]) => void }
type RunOpenOptions = SnapshotOpenOptions & { transform?: ProjectRunTransform; through?: CommittedRange }
interface DirectoryState {
  readonly path: string; readonly storage: JournalHeader; readonly identity: string; readonly fileIdentity: string
  records: ProjectRecordLocator[]; byteEnd: number; sizeBytes: number; revision: number; stamp: string
  snapshot?: WeakRef<readonly ProjectRecordLocator[]>
}

function fileIdentity(value: { dev: bigint; ino: bigint; birthtimeNs: bigint }): string { return `${value.dev}:${value.ino}:${value.birthtimeNs}` }
function fileStamp(value: { size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string { return `${value.size}:${value.mtimeNs}:${value.ctimeNs}` }
function assertPayloadHolder(storage: JournalHeader, event: SessionEvent): void {
  const payload = (event.data as unknown as Record<string, unknown>)?.payload as ProjectPayloadRef | undefined
  if (payload?.kind !== 'projects-payload' && payload?.kind !== 'projects-legacy-record') return
  const owner = payload.owner
  if (owner?.projectId !== storage.projectId || owner.logicalSessionId !== storage.logicalSessionId || owner.carrierId !== storage.carrierId || owner.createdAt !== storage.header.createdAt) throw new SessionPersistenceCorruptionError('Projects payload reference does not belong to its canonical journal holder', { cause: new Error('PROJECT_PAYLOAD_HOLDER_MISMATCH') })
  if (payload.kind === 'projects-legacy-record') throw new SessionPersistenceCorruptionError('A derived legacy reference is not a canonical journal record', { cause: new Error('PROJECT_CANONICAL_JOURNAL_HAS_DERIVED_REFERENCE') })
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function identityFromSegment(value: string): string {
  const identity = value.replace(/~([0-9A-F]{4})/g, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
  if (pathSegment(identity) !== value) throw new TypeError(`invalid encoded identity directory ${value}`)
  return identity
}

/**
 * Projects' append-only storage owner. It reuses the stock public SessionHandle contract;
 * it never resolves a live Session or constructs/resumes an Agent. The driver owns
 * the one ordered append route and registers its exact Projects schemas before open.
 */
export class ProjectSessionPersistence extends SessionPersistence {
  override readonly name = 'projects-session-persistence'
  readonly dataRoot: string
  private readonly schemas = new Map<string, ProjectEventValidator>()
  private readonly owners = new Map<string, ProjectSessionOwner>()
  private readonly writers = new Map<string, ProjectSessionHandle | null>()
  private readonly handles = new Set<ProjectSessionHandle>()
  private readonly opening = new Map<Promise<unknown>, ReadonlySet<SessionId>>()
  private readonly revisionScope = randomUUID()
  private initialization?: Promise<void>
  private closing?: Promise<void>
  private readonly removed = new Set<SessionId>()
  private readonly directoryStates = new Map<SessionId, DirectoryState>()
  private readonly directoryLoading = new Map<SessionId, Promise<DirectoryState>>()
  private readonly routes = new Map<SessionId, ProjectWriterRoute>()
  private readonly confirmedCuts = new Map<SessionId, CommittedRange>()
  private readonly issuedRanges = new WeakSet<object>()
  private readonly reads = new Map<SessionId, Set<Promise<void>>>()
  private readonly payloads: ProjectPayloadStore

  constructor(ctx: Context, config: ProjectSessionPersistenceConfig) {
    super(ctx)
    if (typeof config.dataRoot !== 'string' || config.dataRoot.length === 0) throw new TypeError('Projects dataRoot is required')
    this.dataRoot = resolve(config.dataRoot)
    const maximum = config.maxPendingPayloadBytes ?? 64 * 1024 * 1024
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new TypeError('invalid maxPendingPayloadBytes')
    this.payloads = new ProjectPayloadStore(maximum)
    // The complete explicit vocabulary exists before any cold stat/open/read,
    // independently of whether an Agent factory has been installed yet.
    installProjectDriverSchemas(this)
    installProjectRecordingSchemas(this)
    installCommunicationEventSchemas(this)
    installProjectModelSchemas(this)
    installContinuityEventSchemas(this)
    ctx.effect(() => () => this.close())
  }

  /** Initialize the data format before other Projects owners create their directories. */
  async initialize(): Promise<void> {
    this.assertOpen()
    await this.ensureFormat(true)
  }

  registerProjectEventSchema(type: `projects/${string}`, validator: ProjectEventValidator): void {
    this.assertOpen()
    validateProjectSchemaType(type)
    if (typeof validator !== 'function') throw new TypeError('Project event validator must be a function')
    if (this.schemas.get(type) === validator) return
    if (this.schemas.has(type)) throw new Error(`Project event schema already registered: ${type}`)
    this.schemas.set(type, validator)
  }

  registerSessionOwner(id: SessionId, owner: ProjectSessionOwner): void {
    this.assertOpen()
    pathSegment(id)
    validateOwner(owner)
    this.assertSameOwner(id, owner)
    this.owners.set(id, freeze(structuredClone(owner)))
  }

  /** Resolve durable membership without opening a writer or activating an Agent. */
  async resolveOwner(id: SessionId): Promise<ProjectSessionOwner | undefined> {
    this.assertOpen()
    if (this.removed.has(id)) return undefined
    await this.ensureFormat(false)
    const path = this.directoryStates.get(id)?.path ?? (this.owners.has(id) ? this.journalPath(id, this.owners.get(id)!) : await this.findPath(id))
    if (path === undefined) return undefined
    try { const directory = await this.ensureDirectory(id, path); return structuredClone(this.rememberOwner(id, directory.storage)) }
    catch (error) { if (hasCode(error, 'ENOENT')) return undefined; throw error }
  }

  /** Exact live routing is registered by the factory, never inferred from a same-id Session. */
  registerWriterRoute(route: ProjectWriterRoute): () => void {
    this.assertOpen(); this.assertCarrierOpen(route.session.id)
    if (this.routes.has(route.session.id)) throw new SessionAlreadyOwnedError(route.session.id)
    this.routes.set(route.session.id, route)
    return () => { if (this.routes.get(route.session.id) === route) this.routes.delete(route.session.id) }
  }

  stagePayload(id: SessionId, input: { codec: string; value: unknown; capture?: (value: unknown) => void }): ProjectPayloadReference {
    this.assertOpen(); this.assertCarrierOpen(id)
    const writer = this.writers.get(id)
    if (writer === undefined || writer === null) throw new Error('PROJECT_PAYLOAD_REQUIRES_ACTIVE_WRITER')
    writer.assertStaging()
    return this.payloads.stage({ ...writer.owner, carrierId: id, createdAt: writer.header.createdAt }, { codec: input.codec, value: input.value, capture: input.capture })
  }

  /** Verified native inheritance owns independent payload copies; provenance points only one hop back. */
  copyInheritedSeed(childId: SessionId, parentId: SessionId, seed: readonly SessionEvent[], transform: ProjectRunTransform, options: { signal?: AbortSignal } = {}): Promise<readonly SessionEvent[]> {
    return this.trackOpening([childId, parentId], () => this.copyInheritedSeedOwned(childId, parentId, seed, transform, options))
  }
  private async copyInheritedSeedOwned(childId: SessionId, parentId: SessionId, seed: readonly SessionEvent[], transform: ProjectRunTransform, options: { signal?: AbortSignal }): Promise<readonly SessionEvent[]> {
    this.assertOpen(); this.assertCarrierOpen(childId); options.signal?.throwIfAborted()
    const child = this.writers.get(childId)
    if (child === undefined || child === null || !child.header.isSeeded || child.header.parentSession !== parentId || child.inheritedEventCount !== seed.length) throw new Error('PROJECT_INHERITED_SOURCE_NOT_CONFIRMED')
    child.assertStaging()
    const source = await this.recordDirectory(parentId, options)
    if (source.owner.projectId !== child.owner.projectId || source.nextSeq < seed.length) throw new Error('PROJECT_INHERITED_SOURCE_NOT_CONFIRMED')
    const cut = await this.confirmThrough(parentId, seed.length, options)
    const sourceDirectory = this.directoryStates.get(parentId)!
    const owner = { ...child.owner, carrierId: childId, createdAt: child.header.createdAt }
    const copied: SessionEvent[] = []
    for (const event of seed) {
      options.signal?.throwIfAborted(); child.assertStaging(); this.assertCarrierOpen(parentId)
      const row = source.records[event.seq]
      if (row === undefined || event.seq !== copied.length || event.seq >= cut.nextSeq) throw new Error('PROJECT_INHERITED_PREFIX_MISMATCH')
      const data = event.data as unknown as Record<string, unknown>
      const prior = data.payload as ProjectPayloadRef | undefined
      if (data.representation === 'legacy-derived' && prior?.kind === 'projects-legacy-record') {
        if (prior.owner.carrierId !== parentId || prior.seq !== event.seq || prior.eventDigest !== row.eventDigest || prior.type !== row.type || prior.time !== row.time) throw new Error('PROJECT_INHERITED_PREFIX_MISMATCH')
      } else if (nativeSourceDigest(event) !== row.eventDigest) throw new Error('PROJECT_INHERITED_PREFIX_MISMATCH')
      const run = transform(event, this.legacyReference(sourceDirectory.storage, row))
      const runData = run.data as unknown as Record<string, unknown>
      const reference = runData.payload as ProjectPayloadRef | undefined
      if (reference === undefined) { copied.push(run); continue }
      if (!['projects-payload', 'projects-legacy-record'].includes(reference.kind) || reference.owner.carrierId !== parentId || reference.owner.createdAt !== source.header.createdAt) throw new Error('PROJECT_INHERITED_SOURCE_NOT_CONFIRMED')
      const value = await this.readPayload(parentId, reference, options)
      const payload = this.payloads.stage(owner, { codec: reference.codec.replace(/\/v1$/, '/v2'), value,
        inheritedFrom: { carrierId: parentId, createdAt: source.header.createdAt, seq: Number(event.seq), eventDigest: row.eventDigest,
          ...(reference.kind === 'projects-payload' ? { payloadDigest: reference.digest } : {}) } })
      await child.assertOwned()
      await this.payloads.publish(dirname(child.journalPath), payload, owner)
      await child.assertOwned()
      const rebound = { ...run, data: { ...runData, representation: 'recorded', payload } } as SessionEvent
      this.validateBatch(child.header, [rebound], child.journalPath, Number(event.seq))
      copied.push(rebound)
    }
    this.assertCarrierOpen(parentId); child.assertStaging()
    return copied
  }

  async readPayload(id: SessionId, ref: ProjectPayloadRef, options: { signal?: AbortSignal } = {}): Promise<unknown> {
    this.assertOpen(); this.assertCarrierOpen(id); options.signal?.throwIfAborted()
    const release = this.beginRead(id)
    try {
    const directory = await this.ensureDirectory(id)
    const owner = { projectId: directory.storage.projectId, logicalSessionId: directory.storage.logicalSessionId, carrierId: id, createdAt: directory.storage.header.createdAt }
    if (ref.owner?.carrierId !== id || ref.owner.createdAt !== owner.createdAt || ref.owner.projectId !== owner.projectId || ref.owner.logicalSessionId !== owner.logicalSessionId) throw new Error('PROJECT_PAYLOAD_OWNER_OR_REFERENCE_MISMATCH')
    if (ref.kind === 'projects-payload') { const value = await this.payloads.read(dirname(directory.path), ref, owner, options.signal); this.assertCarrierOpen(id); return value }
    const row = directory.records[ref.seq]
    if (ref.kind !== 'projects-legacy-record' || ref.version !== 1 || row === undefined || row.type !== ref.type || row.time !== ref.time
      || row.byteStart !== ref.byteStart || row.byteEnd !== ref.byteEnd || row.rawLineDigest !== ref.rawLineDigest || row.eventDigest !== ref.eventDigest) throw new Error('PROJECT_LEGACY_PAYLOAD_REFERENCE_MISMATCH')
    return (await this.readCanonicalEvent(id, ref.seq, options))!.data
    } finally { release() }
  }

  async recordDirectory(id: SessionId, options: { signal?: AbortSignal; fromSeq?: number } = {}): Promise<ProjectRecordDirectory> {
    options.signal?.throwIfAborted(); this.assertOpen(); this.assertCarrierOpen(id)
    const route = this.routes.get(id)
    if (route !== undefined) await route.acknowledgeThrough(Number(route.session.seq), options.signal)
    const directory = await this.ensureDirectory(id, undefined, options.signal)
    const from = options.fromSeq ?? 0
    if (!Number.isSafeInteger(from) || from < 0 || from > directory.records.length) throw new TypeError('invalid directory fromSeq')
    let records = from === 0 ? directory.snapshot?.deref() : undefined
    if (records === undefined) {
      records = Object.freeze(directory.records.slice(from))
      // Concurrent consumers share the immutable cut. The authority must not
      // keep an extra full pointer array alive after its last consumer leaves.
      if (from === 0) directory.snapshot = new WeakRef(records)
    }
    return Object.freeze({ header: directory.storage.header, owner: Object.freeze({ projectId: directory.storage.projectId, logicalSessionId: directory.storage.logicalSessionId }),
      inheritedEventCount: directory.storage.inheritedEventCount, journalIdentity: directory.identity, revision: this.directoryRevision(directory),
      nextSeq: directory.records.length, byteEnd: directory.byteEnd, records })
  }

  async confirmThrough(id: SessionId, targetNext: number, options: { session?: import('@deepseek-ai/dsh-session').Session; signal?: AbortSignal } = {}): Promise<CommittedRange> {
    this.assertOpen(); this.assertCarrierOpen(id); options.signal?.throwIfAborted()
    if (!Number.isSafeInteger(targetNext) || targetNext < 0) throw new TypeError('invalid confirmation target')
    const route = this.routes.get(id)
    if (route !== undefined) {
      if (options.session !== undefined && route.session !== options.session) throw new SessionOwnershipLostError(id)
      return route.confirmThrough(targetNext, options.signal)
    }
    if (options.session !== undefined) throw new Error('PROJECT_SOURCE_HAS_NO_EXACT_WRITER_ROUTE')
    const active = this.writers.get(id)
    if (active === null) throw new SessionAlreadyOwnedError(id)
    if (active !== undefined) { await active.flush({ signal: options.signal }); return active.committedRange(targetNext) }
    const directory = await this.ensureDirectory(id, undefined, options.signal)
    const prior = this.confirmedCuts.get(id)
    if (prior?.journalIdentity === directory.identity && prior.nextSeq >= targetNext) return this.rangeFor(directory, targetNext, prior.epoch, 'writer-fsync')
    const opened = await this.open(id, 'write', options) as ProjectSessionHandle
    try { await opened.flush({ signal: options.signal }); return opened.committedRange(targetNext) }
    finally { await opened.close() }
  }

  async openForRun(id: SessionId, transform: ProjectRunTransform, options: SessionPersistenceOpenOptions = {}): Promise<{ handle: ProjectSessionHandle; events: readonly SessionEvent[]; eventState: 'detached'; canonicalCount: number }> {
    return this.openRunView(id, 'write', transform, options)
  }
  /** Read-only derived seed. No write lease, tail repair, Agent, or resume marker is produced here. */
  readForRun(id: SessionId, transform: ProjectRunTransform, options: ProjectRunVisitorOptions): Promise<{ handle: ProjectSessionHandle; eventState: 'detached'; canonicalCount: number }>
  readForRun(id: SessionId, transform: ProjectRunTransform, options?: ProjectRangeOptions): Promise<{ handle: ProjectSessionHandle; events: readonly SessionEvent[]; eventState: 'detached'; canonicalCount: number }>
  async readForRun(id: SessionId, transform: ProjectRunTransform, options: ProjectRangeOptions | ProjectRunVisitorOptions = {}): Promise<{ handle: ProjectSessionHandle; events?: readonly SessionEvent[]; eventState: 'detached'; canonicalCount: number }> {
    if (options.through !== undefined) {
      const directory = await this.ensureDirectory(id, undefined, options.signal)
      if (!this.issuedRanges.has(options.through) || options.through.header.id !== id || options.through.journalIdentity !== directory.identity) throw new Error('PROJECT_COMMITTED_RANGE_MISMATCH')
    }
    if ('visit' in options) return this.trackOpening([id], () => this.visitRunView(id, transform, options))
    return this.openRunView(id, 'read', transform, options)
  }
  private async visitRunView(id: SessionId, transform: ProjectRunTransform, options: ProjectRunVisitorOptions): Promise<{ handle: ProjectSessionHandle; eventState: 'detached'; canonicalCount: number }> {
    this.assertOpen(); this.assertCarrierOpen(id); options.signal?.throwIfAborted()
    const directory = await this.ensureDirectory(id, undefined, options.signal), through = options.through
    if (typeof options.visit !== 'function' || !this.issuedRanges.has(through) || through.header.id !== id || through.journalIdentity !== directory.identity
      || through.header.createdAt !== directory.storage.header.createdAt || through.owner.projectId !== directory.storage.projectId
      || through.owner.logicalSessionId !== directory.storage.logicalSessionId || through.nextSeq > directory.records.length) throw new Error('PROJECT_COMMITTED_RANGE_MISMATCH')
    // Keep the strict full-prefix scan, including legacy bytes and schemas, but
    // reuse its admitted locators instead of retaining another directory/seed.
    let visitorFailure: { error: unknown } | undefined
    const decoded = await this.scanAt(directory.path, id, { signal: options.signal, throughBytes: through.byteEnd, onEvent: (event, row, storage) => {
      options.signal?.throwIfAborted()
      const locator = directory.records[event.seq]
      if (locator === undefined || event.seq >= through.nextSeq || locator.byteStart !== row.byteStart || locator.byteEnd !== row.byteEnd || locator.rawLineDigest !== rowDigest(row.raw)) {
        const error = new SessionPersistenceCorruptionError('Projects strict run read observed changed admitted bytes', { cause: new Error('record digest mismatch') })
        this.invalidate(id, error); throw error
      }
      const run = transform(event, this.legacyReference(storage, locator))
      if (run.seq !== event.seq || run.time !== event.time) throw new Error('PROJECT_RUN_VIEW_CHANGED_EVENT_IDENTITY')
      this.validateBatch(storage.header, [run], directory.path, Number(event.seq))
      try { options.visit(run) } catch (error) { visitorFailure = { error }; throw error }
    } }).catch(error => {
      options.signal?.throwIfAborted()
      if (visitorFailure !== undefined) throw visitorFailure.error
      throw error
    })
    const status = await stat(directory.path, { bigint: true })
    options.signal?.throwIfAborted(); this.assertCarrierOpen(id)
    if (decoded.eventCount !== through.nextSeq || decoded.fileIdentity !== directory.fileIdentity || fileIdentity(status) !== directory.fileIdentity
      || Number(status.size) < through.byteEnd || !sameJournalValue(decoded.storage, directory.storage)) {
      const error = new SessionOwnershipLostError(id); this.invalidate(id, error); throw error
    }
    const handle = new ProjectSessionHandle(this, decoded.storage, 'read', directory.path, decoded.eventCount)
    this.install(handle)
    return { handle, eventState: 'detached', canonicalCount: decoded.eventCount }
  }
  private async openRunView(id: SessionId, access: SessionAccess, transform: ProjectRunTransform, options: SessionPersistenceOpenOptions & { through?: CommittedRange }): Promise<{ handle: ProjectSessionHandle; events: readonly SessionEvent[]; eventState: 'detached'; canonicalCount: number }> {
    let events: readonly SessionEvent[] | undefined
    const handle = await this.open(id, access, { ...options, transform, [captureReadSnapshot]: value => { events = value } } as RunOpenOptions) as ProjectSessionHandle
    if (events === undefined) { await handle.close(); throw new Error('PROJECT_RUN_SEED_UNAVAILABLE') }
    return { handle, events, eventState: 'detached', canonicalCount: events.length }
  }

  async readCanonicalEvent(id: SessionId, seq: number, options: ProjectRangeOptions = {}): Promise<SessionEvent | undefined> {
    for await (const event of this.readCanonicalRange(id, seq, seq + 1, options)) return event
    return undefined
  }

  async *readCanonicalRange(id: SessionId, fromSeq: number, toSeqExclusive: number, options: ProjectRangeOptions = {}): AsyncIterable<SessionEvent> {
    this.assertOpen(); this.assertCarrierOpen(id); options.signal?.throwIfAborted()
    const release = this.beginRead(id)
    try {
    const directory = await this.ensureDirectory(id, undefined, options.signal)
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 0 || !Number.isSafeInteger(toSeqExclusive) || toSeqExclusive < fromSeq) throw new TypeError('invalid canonical range')
    const through = options.through
    if (through !== undefined && (!this.issuedRanges.has(through) || through.journalIdentity !== directory.identity || through.header.createdAt !== directory.storage.header.createdAt
      || through.owner.projectId !== directory.storage.projectId || through.owner.logicalSessionId !== directory.storage.logicalSessionId
      || toSeqExclusive > through.nextSeq)) throw new Error('PROJECT_COMMITTED_RANGE_MISMATCH')
    const end = Math.min(toSeqExclusive, directory.records.length)
    const file = await open(directory.path, 'r')
    try {
      await this.assertDirectoryFile(directory, file)
      for (let seq = fromSeq; seq < end; seq++) {
        options.signal?.throwIfAborted(); this.assertCarrierOpen(id)
        const row = directory.records[seq]!
        const raw = Buffer.allocUnsafe(row.byteEnd - row.byteStart)
        let offset = 0
        while (offset < raw.length) { const part = await file.read(raw, offset, raw.length - offset, row.byteStart + offset); if (!part.bytesRead) throw new Error('PROJECT_RECORD_RANGE_TRUNCATED'); offset += part.bytesRead }
        if (raw.at(-1) !== 0x0a || rowDigest(raw.subarray(0, -1)) !== row.rawLineDigest) {
          const error = new SessionPersistenceCorruptionError('Projects record bytes changed', { cause: new Error('record digest mismatch') })
          this.invalidate(id, error); throw error
        }
        const event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(0, -1))) as SessionEvent
        this.validateBatch(directory.storage.header, [event], directory.path, seq)
        assertPayloadHolder(directory.storage, event)
        await this.assertDirectoryFile(directory, file)
        this.assertCarrierOpen(id)
        yield event
      }
      await this.assertDirectoryFile(directory, file)
      this.assertCarrierOpen(id)
    } finally { await file.close() }
    } finally { release() }
  }

  journalPath(id: SessionId, owner: ProjectSessionOwner): string {
    validateOwner(owner)
    return join(this.dataRoot, 'projects', pathSegment(owner.projectId), 'sessions', pathSegment(id), JOURNAL_FILENAME)
  }

  create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    return this.trackOpening([header.id], () => this.createOwned(header, options))
  }

  private async createOwned(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    this.assertOpen()
    this.assertCarrierOpen(header.id)
    options?.signal?.throwIfAborted()
    const snapshot = materializeCreateHeader(header)
    validateHeader(snapshot, snapshot.id)
    if (snapshot.isSeeded && options?.inheritedEventCount === undefined) throw new TypeError('seeded session requires inheritedEventCount')
    const inheritedEventCount = SessionLogOffset(options?.inheritedEventCount ?? 0)
    validateInherited(snapshot, inheritedEventCount)
    const owner = this.owners.get(snapshot.id)
    if (owner === undefined) throw new Error(`Project owner must be registered before creating session "${snapshot.id}"`)
    await this.ensureFormat(true)
    options?.signal?.throwIfAborted()
    if (this.writers.has(snapshot.id) || await this.findPath(snapshot.id) !== undefined) throw new SessionAlreadyExistsError(snapshot.id)
    this.claim(snapshot.id)
    let lock: ProjectWriterLock | undefined
    let file: FileHandle | undefined
    try {
      lock = await ProjectWriterLock.acquire(this.dataRoot, snapshot.id)
      options?.signal?.throwIfAborted()
      if (await this.findPath(snapshot.id) !== undefined) throw new SessionAlreadyExistsError(snapshot.id)
      const journalPath = this.journalPath(snapshot.id, owner)
      const storage: JournalHeader = { format: PROJECT_JOURNAL_FORMAT, nativeVersion: STOCK_SESSION_VERSION, ...owner, carrierId: snapshot.id, header: snapshot, inheritedEventCount }
      file = await this.publishHeader(journalPath, storage)
      const status = await file.stat({ bigint: true })
      this.directoryStates.set(snapshot.id, { path: journalPath, storage: freeze(storage), identity: randomUUID(), fileIdentity: fileIdentity(status), stamp: fileStamp(status),
        records: [], byteEnd: Number(status.size), sizeBytes: Number(status.size), revision: 0 })
      const handle = new ProjectSessionHandle(this, storage, 'write', journalPath, 0, file, lock)
      this.install(handle)
      return handle
    } catch (error) {
      const failures: unknown[] = [error]
      try { await file?.close() } catch (closeError) { failures.push(closeError) }
      try { await lock?.close() } catch (closeError) { failures.push(closeError) }
      this.writers.delete(snapshot.id)
      if (failures.length > 1) throw new AggregateError(failures, `session "${snapshot.id}" create and resource release failed`)
      throw error
    }
  }

  open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    return this.trackOpening([id], () => this.openOwned(id, access, options))
  }

  /** Projects-only seam: reuse the validated prefix decoded by this read open. */
  async openReadSnapshot(id: SessionId, options?: SessionPersistenceOpenOptions): Promise<{ handle: ProjectSessionHandle; events: readonly SessionEvent[] }> {
    let events: readonly SessionEvent[] | undefined
    const snapshotOptions: SnapshotOpenOptions = { ...options, [captureReadSnapshot]: value => { events = value } }
    const handle = await this.open(id, 'read', snapshotOptions)
    if (!(handle instanceof ProjectSessionHandle) || events === undefined) {
      await handle.close()
      throw new Error('Projects read snapshot was not supplied by its persistence owner')
    }
    return { handle, events }
  }

  /** Validate the journal and observe its identity/count without retaining its body. */
  async openReadIdentity(id: SessionId, options?: SessionPersistenceOpenOptions): Promise<ProjectSessionHandle> {
    const handle = await this.open(id, 'read', options)
    if (!(handle instanceof ProjectSessionHandle)) {
      await handle.close()
      throw new Error('Projects identity read was not supplied by its persistence owner')
    }
    return handle
  }

  private async openOwned(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    this.assertOpen()
    this.assertCarrierOpen(id)
    if (access !== 'read' && access !== 'write') throw new TypeError('Session access must be read or write')
    pathSegment(id)
    options?.signal?.throwIfAborted()
    await this.ensureFormat(false)
    if (await this.findPath(id) === undefined) throw new SessionPersistenceNotFoundError(id)
    if (access === 'write') this.claim(id)
    let lock: ProjectWriterLock | undefined
    let file: FileHandle | undefined
    try {
      if (access === 'write') lock = await ProjectWriterLock.acquire(this.dataRoot, id)
      options?.signal?.throwIfAborted()
      const path = await this.findPath(id)
      if (path === undefined) throw new SessionPersistenceNotFoundError(id)
      const capture = (options as RunOpenOptions | undefined)?.[captureReadSnapshot]
      const transform = (options as RunOpenOptions | undefined)?.transform
      const through = (options as RunOpenOptions | undefined)?.through
      const events: SessionEvent[] | undefined = capture === undefined ? undefined : []
      let records: ProjectRecordLocator[] = []
      const cached = capture === undefined && access === 'write' ? await this.ensureDirectory(id, path, options?.signal) : undefined
      const decoded = cached === undefined ? await this.scanAt(path, id, { ...(options?.signal === undefined ? {} : { signal: options.signal }), ...(through === undefined ? {} : { throughBytes: through.byteEnd }), onEvent: (event, row, storage) => {
        const locator = recordLocator(event, row.byteStart, row.byteEnd, row.raw)
        records.push(locator)
        if (events !== undefined) {
          const run = transform === undefined ? event : transform(event, this.legacyReference(storage, locator))
          if (run.seq !== event.seq || run.time !== event.time) throw new Error('PROJECT_RUN_VIEW_CHANGED_EVENT_IDENTITY')
          if (transform !== undefined) this.validateBatch(storage.header, [run], path, Number(event.seq))
          events.push(run)
        }
      } }) : { storage: cached.storage, eventCount: cached.records.length, committedBytes: cached.byteEnd, sizeBytes: cached.sizeBytes, fileIdentity: cached.fileIdentity, stamp: cached.stamp }
      if (through !== undefined && decoded.eventCount !== through.nextSeq) throw new Error('PROJECT_COMMITTED_RANGE_MISMATCH')
      if (cached !== undefined) records = cached.records
      this.rememberOwner(id, decoded.storage)
      if (access === 'write') {
        file = await open(path, 'a+')
        // Only the claimed writer repairs a partial physical tail. Readers ignore it.
        if (decoded.committedBytes !== decoded.sizeBytes) await file.truncate(decoded.committedBytes)
        await file.sync()
      }
      const status = file === undefined ? await stat(path, { bigint: true }) : await file.stat({ bigint: true })
      if (fileIdentity(status) !== decoded.fileIdentity) throw new SessionOwnershipLostError(id)
      const previous = this.directoryStates.get(id)
      const currentWriter = this.writers.get(id)
      if (access === 'read' && previous !== undefined && (through !== undefined || currentWriter !== undefined && currentWriter !== null)) {
        if (!sameJournalValue(previous.storage, decoded.storage)) {
          const error = new SessionPersistenceCorruptionError('Projects strict read observed changed creation identity', { cause: new Error('stored identity changed') }); this.invalidate(id, error); throw error
        }
        // A strict read concurrent with append may observe an older finite prefix.
        // It must never overwrite/regress the writer's authoritative directory.
        for (const row of records) if (previous.records[row.seq] !== undefined && previous.records[row.seq]!.rawLineDigest !== row.rawLineDigest) {
          const error = new SessionPersistenceCorruptionError('Projects strict read observed a changed writer-owned prefix', { cause: new Error('record digest mismatch') }); this.invalidate(id, error); throw error
        }
      } else this.directoryStates.set(id, { path, storage: freeze(decoded.storage), identity: previous?.fileIdentity === decoded.fileIdentity && previous.stamp === decoded.stamp ? previous.identity : randomUUID(), fileIdentity: decoded.fileIdentity,
        stamp: fileStamp(status), records, byteEnd: decoded.committedBytes, sizeBytes: access === 'write' ? decoded.committedBytes : decoded.sizeBytes, revision: (previous?.revision ?? 0) + 1 })
      const handle = new ProjectSessionHandle(this, decoded.storage, access, path, decoded.eventCount, file, lock)
      if (access === 'write') await this.reclaimPayloads(handle)
      this.install(handle)
      if (events !== undefined) capture!(events)
      return handle
    } catch (error) {
      const failures: unknown[] = [error]
      try { await file?.close() } catch (closeError) { failures.push(closeError) }
      try { await lock?.close() } catch (closeError) { failures.push(closeError) }
      if (access === 'write') this.writers.delete(id)
      if (failures.length > 1) throw new AggregateError(failures, `session "${id}" open and resource release failed`)
      throw error
    }
  }

  async flush(): Promise<void> {
    this.assertOpen()
    const active = [...this.handles].filter(handle => handle.access === 'write')
    const settled = await Promise.allSettled(active.map(handle => handle.flushOrJoinClose()))
    const errors = settled.flatMap((result, index) => result.status === 'rejected'
      ? [new Error(`session "${active[index]!.id}" flush failed`, { cause: result.reason })] : [])
    if (errors.length > 0) throw new AggregateError(errors, 'Projects persistence flush failed')
  }

  async stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined> {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    await this.ensureFormat(false)
    const path = await this.findPath(id)
    if (path === undefined) return undefined
    return this.collectionSnapshotAt(path, id, options?.signal)
  }

  async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    await this.ensureFormat(false)
    const paths = await this.allPaths()
    const seen = new Set<string>()
    const snapshots: SessionPersistenceSnapshot[] = []
    for (const { id, path } of paths) {
      options?.signal?.throwIfAborted()
      if (this.removed.has(id)) continue
      if (seen.has(id)) throw new SessionPersistenceCorruptionError(`duplicate Projects carrier identity "${id}"`, { cause: new Error('multiple journals') })
      seen.add(id)
      const snapshot = await this.collectionSnapshotAt(path, id, options?.signal)
      if (snapshot !== undefined) snapshots.push(snapshot)
    }
    return snapshots.filter(snapshot => !this.removed.has(snapshot.header.id))
  }

  /** The lifecycle owner has published source-unavailable and drained short reads first. */
  async removeCarrier(id: SessionId): Promise<{ readonly status: 'removed'; readonly path?: string }> {
    this.assertOpen()
    this.removed.add(id)
    const loading = this.directoryLoading.get(id)
    if (loading !== undefined) await Promise.allSettled([loading])
    await Promise.allSettled([...(this.reads.get(id) ?? [])])
    // 切点前已接纳且涉及本承载的动作仍须完成；继承复制登记父子两端。
    await Promise.allSettled([...this.opening].flatMap(([operation, carriers]) => carriers.has(id) ? [operation] : []))
    const route = this.routes.get(id)
    const routed = route === undefined ? [] : await Promise.allSettled([route.acknowledgeThrough(Number(route.session.seq))])
    const handles = [...this.handles].filter(handle => handle.id === id)
    const settled = await Promise.allSettled(handles.map(handle => handle.close()))
    const errors = [...routed, ...settled].flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, `Projects carrier "${id}" close before removal failed`)
    // A create accepted before the cut may have materialized while we waited.
    // Discover its actual result only after that operation and handle settled.
    const path = await this.findPath(id)
    this.owners.delete(id)
    this.directoryStates.delete(id); this.routes.delete(id); this.confirmedCuts.delete(id); this.payloads.discard(id)
    if (path === undefined) return { status: 'removed' }
    const carrierPath = dirname(path)
    await rm(carrierPath, { recursive: true, force: true })
    await syncDirectory(dirname(carrierPath))
    return { status: 'removed', path: carrierPath }
  }

  private assertCarrierOpen(id: SessionId): void {
    if (this.removed.has(id)) throw new SessionPersistenceNotFoundError(id)
  }

  /** The graph's teardown joins already accepted handle operations and always releases locks. */
  close(): Promise<void> {
    return this.closing ??= (async () => {
      // Already accepted opens either install before closure or release their actual resources.
      await Promise.allSettled([...this.opening.keys()])
      await Promise.allSettled([...this.directoryLoading.values()])
      while (this.reads.size) await Promise.allSettled([...this.reads.values()].flatMap(values => [...values]))
      const routed = await Promise.allSettled([...this.routes.values()].map(route => route.acknowledgeThrough(Number(route.session.seq))))
      const settled = await Promise.allSettled([...this.handles].map(handle => handle.close()))
      for (const id of this.directoryStates.keys()) this.payloads.discard(id)
      this.directoryStates.clear(); this.routes.clear(); this.confirmedCuts.clear()
      const errors = [...routed, ...settled].flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length > 0) throw new AggregateError(errors, 'Projects persistence close failed')
    })()
  }

  /** @internal Handle operations preserve one route; callers use the public seam above. */
  validateBatch(header: SessionHeader, events: SessionEvent[], path: string, cursor: number): SessionEvent[] {
    return validateEvents(header, events, this.schemas, path, cursor)
  }

  /** @internal A handle retains its own immutable creation identity across fresh reads. */
  async readJournal(path: string, id: SessionId, onEvent: (event: SessionEvent, row: { byteStart: number; byteEnd: number; raw: Buffer }) => void, signal?: AbortSignal): Promise<JournalScan> {
    return this.scanAt(path, id, { onEvent, ...(signal === undefined ? {} : { signal }) })
  }

  /** @internal */
  release(handle: ProjectSessionHandle): void {
    this.handles.delete(handle)
    if (this.writers.get(handle.id) === handle) this.writers.delete(handle.id)
    if (handle.access === 'write') this.payloads.discard(handle.id)
  }

  private legacyReference(storage: JournalHeader, row: ProjectRecordLocator): ProjectLegacyRecordReference {
    return Object.freeze({ kind: 'projects-legacy-record', version: 1, codec: 'projects-record/v1',
      owner: Object.freeze({ projectId: storage.projectId, logicalSessionId: storage.logicalSessionId, carrierId: storage.carrierId, createdAt: storage.header.createdAt }),
      seq: row.seq, type: row.type, time: row.time, byteStart: row.byteStart, byteEnd: row.byteEnd, rawLineDigest: row.rawLineDigest, eventDigest: row.eventDigest })
  }
  private directoryRevision(directory: DirectoryState): string { return `${this.revisionScope}:${directory.identity}:${directory.records.length}:${directory.byteEnd}` }
  private invalidate(id: SessionId, error: unknown): void {
    this.confirmedCuts.delete(id)
    const writer = this.writers.get(id)
    if (writer !== undefined && writer !== null) writer.invalidate(error)
    this.routes.get(id)?.fail(error)
  }
  private beginRead(id: SessionId): () => void {
    const done = Promise.withResolvers<void>()
    let reads = this.reads.get(id)
    if (reads === undefined) { reads = new Set(); this.reads.set(id, reads) }
    reads.add(done.promise)
    return () => { reads!.delete(done.promise); if (!reads!.size) this.reads.delete(id); done.resolve() }
  }
  private ensureDirectory(id: SessionId, requestedPath?: string, signal?: AbortSignal): Promise<DirectoryState> {
    signal?.throwIfAborted()
    let operation = this.directoryLoading.get(id)
    if (operation === undefined) {
      // The provider owns this shared scan until completion. A cancelled waiter
      // must neither abort another caller nor release close/removal's read duty.
      operation = this.loadDirectory(id, requestedPath)
      this.directoryLoading.set(id, operation)
      const done = () => { if (this.directoryLoading.get(id) === operation) this.directoryLoading.delete(id) }
      void operation.then(done, done)
    }
    if (signal === undefined) return operation
    return new Promise<DirectoryState>((resolve, reject) => {
      const aborted = () => reject(signal.reason)
      signal.addEventListener('abort', aborted, { once: true })
      void operation.then(value => { signal.removeEventListener('abort', aborted); resolve(value) }, error => { signal.removeEventListener('abort', aborted); reject(error) })
    })
  }
  private async loadDirectory(id: SessionId, requestedPath?: string): Promise<DirectoryState> {
    this.assertOpen(); this.assertCarrierOpen(id)
    const known = this.directoryStates.get(id)
    // 只比较本次 stat 开始前已接纳的前缀；等待 I/O 时 writer 可以确认更大的前缀。
    const byteEnd = known?.byteEnd ?? 0
    const path = requestedPath ?? known?.path ?? (this.owners.has(id) ? this.journalPath(id, this.owners.get(id)!) : await this.findPath(id))
    if (path === undefined) throw new SessionPersistenceNotFoundError(id)
    const status = await stat(path, { bigint: true })
    const active = this.writers.get(id)
    if (known !== undefined && known.fileIdentity === fileIdentity(status)) {
      if (active !== undefined && active !== null || known.stamp === fileStamp(status)) {
        if (Number(status.size) < byteEnd) { const error = new SessionPersistenceCorruptionError('Projects journal confirmed prefix shrank', { cause: new Error('size regression') }); this.invalidate(id, error); throw error }
        return known
      }
    } else if (active !== undefined && active !== null) { const error = new SessionOwnershipLostError(id); this.invalidate(id, error); throw error }
    const records: ProjectRecordLocator[] = []
    const decoded = await this.scanAt(path, id, { onEvent: (event, row) => { records.push(recordLocator(event, row.byteStart, row.byteEnd, row.raw)) } })
    this.rememberOwner(id, decoded.storage)
    const directory: DirectoryState = { path, storage: freeze(decoded.storage), identity: randomUUID(), fileIdentity: decoded.fileIdentity,
      stamp: decoded.stamp, records, byteEnd: decoded.committedBytes, sizeBytes: decoded.sizeBytes, revision: (known?.revision ?? 0) + 1 }
    this.directoryStates.set(id, directory)
    return directory
  }
  private async assertDirectoryFile(directory: DirectoryState, file: FileHandle): Promise<void> {
    const byteEnd = directory.byteEnd
    const [held, current] = await Promise.all([file.stat({ bigint: true }), stat(directory.path, { bigint: true })])
    if (fileIdentity(held) !== directory.fileIdentity || fileIdentity(current) !== directory.fileIdentity || Number(held.size) < byteEnd) {
      const error = new SessionOwnershipLostError(directory.storage.carrierId); this.invalidate(directory.storage.carrierId, error); throw error
    }
  }
  /** @internal Same-owner payloads are made durable before their referring event. */
  async publishEventPayload(handle: ProjectSessionHandle, event: SessionEvent): Promise<void> {
    const payload = (event.data as unknown as Record<string, unknown>)?.payload
    if (payload === undefined) return
    const ref = payload as ProjectPayloadReference
    if (ref.kind === 'projects-payload') await this.payloads.publish(dirname(handle.journalPath), ref, { ...handle.owner, carrierId: handle.id, createdAt: handle.header.createdAt })
    else if (ref.kind === 'projects-legacy-record') throw new Error('PROJECT_DERIVED_LEGACY_RECORD_CANNOT_BE_APPENDED')
  }
  /** @internal Failed batches release unpublished payload intentions, not canonical references. */
  abandonEventPayloads(handle: ProjectSessionHandle, events: readonly SessionEvent[]): void {
    for (const event of events) {
      const ref = (event.data as unknown as Record<string, unknown>)?.payload as ProjectPayloadReference | undefined
      if (ref?.kind === 'projects-payload' && ref.owner.carrierId === handle.id) this.payloads.abandon(ref)
    }
  }
  /** @internal Boundary-only GC; uncertainty is resolved from actual rows once, without advancing receipts. */
  async reclaimPayloads(handle: ProjectSessionHandle): Promise<number> {
    await handle.assertOwnedForCleanup()
    await this.payloads.drain(handle.id)
    const directory = this.directoryStates.get(handle.id)
    if (directory === undefined) throw new Error('PROJECT_PAYLOAD_RECLAIM_DIRECTORY_MISSING')
    const status = await stat(handle.journalPath, { bigint: true })
    if (fileIdentity(status) !== directory.fileIdentity || Number(status.size) < directory.byteEnd) throw new SessionOwnershipLostError(handle.id)
    const referenced = new Set<string>()
    if (Number(status.size) === directory.byteEnd && fileStamp(status) === directory.stamp) {
      for (const record of directory.records) if (typeof record.facts.payloadId === 'string') referenced.add(record.facts.payloadId)
    } else {
      const actual = await this.scanAt(handle.journalPath, handle.id, { onEvent: event => {
        const ref = (event.data as unknown as Record<string, unknown>)?.payload as ProjectPayloadReference | undefined
        if (ref?.kind === 'projects-payload') referenced.add(ref.id)
      } })
      if (actual.fileIdentity !== directory.fileIdentity || !sameJournalValue(actual.storage, directory.storage)) throw new SessionOwnershipLostError(handle.id)
    }
    return this.payloads.reclaim(dirname(handle.journalPath), handle.id, referenced, () => handle.assertOwnedForCleanup())
  }
  /** @internal Called only after an append batch has actually completed. */
  acknowledge(handle: ProjectSessionHandle, rows: readonly ProjectRecordLocator[], events: readonly SessionEvent[], sizeBytes: number, stamp: string): void {
    const directory = this.directoryStates.get(handle.id)
    if (directory === undefined || rows[0]?.seq !== directory.records.length) throw new Error('PROJECT_DIRECTORY_ACK_GAP')
    for (const row of rows) directory.records.push(row)
    directory.snapshot = undefined
    directory.byteEnd = rows.at(-1)?.byteEnd ?? directory.byteEnd; directory.sizeBytes = sizeBytes; directory.stamp = stamp; directory.revision++
    for (const event of events) { const payload = (event.data as unknown as Record<string, unknown>)?.payload as ProjectPayloadReference | undefined; if (payload?.kind === 'projects-payload') this.payloads.acknowledged(payload) }
  }

  /** @internal A cut records a completed fsync, not perpetual external byte integrity. */
  rangeFor(directory: DirectoryState, nextSeq: number, epoch: string, proof: CommittedRange['proof']): CommittedRange {
    if (!Number.isSafeInteger(nextSeq) || nextSeq < 0 || nextSeq > directory.records.length) throw new Error('PROJECT_CONFIRMATION_OUTSIDE_STORED_PREFIX')
    const byteEnd = nextSeq === 0 ? directory.records[0]?.byteStart ?? directory.byteEnd : directory.records[nextSeq - 1]!.byteEnd
    const range = Object.freeze({ header: directory.storage.header, owner: Object.freeze({ projectId: directory.storage.projectId, logicalSessionId: directory.storage.logicalSessionId }), inheritedEventCount: directory.storage.inheritedEventCount,
      journalIdentity: directory.identity, epoch, nextSeq, byteEnd, commitId: `${directory.identity}:${nextSeq}:${byteEnd}`, revision: this.directoryRevision(directory), proof })
    this.issuedRanges.add(range)
    return range
  }
  /** @internal */
  confirmed(handle: ProjectSessionHandle, nextSeq: number): CommittedRange {
    const directory = this.directoryStates.get(handle.id)
    if (directory === undefined || this.writers.get(handle.id) !== handle) throw new SessionOwnershipLostError(handle.id)
    return this.rangeFor(directory, nextSeq, handle.epoch, 'writer-fsync')
  }
  /** @internal Exact byte cursor of the once-validated base, not a new scan. */
  initialByteEnd(id: SessionId): number { const value = this.directoryStates.get(id); if (value === undefined) throw new Error('PROJECT_DIRECTORY_BASE_MISSING'); return value.byteEnd }
  /** @internal */
  publishConfirmed(handle: ProjectSessionHandle): void {
    const range = handle.committedRange()
    this.confirmedCuts.set(handle.id, range)
  }

  private assertOpen(): void { if (this.closing !== undefined) throw new Error('Projects persistence is closing') }

  private trackOpening<T>(carrierIds: readonly SessionId[], operation: () => Promise<T>): Promise<T> {
    try { this.assertOpen() } catch (error) { return Promise.reject(error) }
    const carriers = new Set(carrierIds)
    const promise = operation()
    this.opening.set(promise, carriers)
    void promise.then(() => this.opening.delete(promise), () => this.opening.delete(promise))
    return promise
  }

  private claim(id: SessionId): void {
    this.assertOpen()
    if (this.writers.has(id)) throw new SessionAlreadyOwnedError(id)
    this.writers.set(id, null)
  }

  private install(handle: ProjectSessionHandle): void {
    this.assertOpen()
    this.handles.add(handle)
    if (handle.access === 'write') this.writers.set(handle.id, handle)
  }

  private assertSameOwner(id: string, owner: ProjectSessionOwner): void {
    const known = this.owners.get(id)
    if (known !== undefined && (known.projectId !== owner.projectId || known.logicalSessionId !== owner.logicalSessionId)) {
      throw new Error(`session "${id}" Project membership mismatch`)
    }
  }

  private rememberOwner(id: SessionId, owner: ProjectSessionOwner): ProjectSessionOwner {
    const value = { projectId: owner.projectId, logicalSessionId: owner.logicalSessionId }
    this.assertSameOwner(id, value)
    this.owners.set(id, freeze(value))
    return value
  }

  private async scanAt(path: string, id: SessionId, options: { signal?: AbortSignal; throughBytes?: number; onEvent?: (event: SessionEvent, row: { byteStart: number; byteEnd: number; raw: Buffer }, storage: JournalHeader) => void; onBytes?: (chunk: Buffer) => void } = {}): Promise<JournalScan & { fileIdentity: string; stamp: string }> {
    options.signal?.throwIfAborted()
    const release = this.beginRead(id)
    let file: FileHandle
    try { file = await open(path, 'r') } catch (error) { release(); throw error }
    try {
      // A finite byte cut admits a valid concurrent prefix, never chases an active writer.
      const initial = await file.stat({ bigint: true })
      const size = options.throughBytes ?? Number(initial.size)
      if (BigInt(size) > initial.size) throw new Error('PROJECT_COMMITTED_RANGE_TRUNCATED')
      if (!Number.isSafeInteger(size)) throw new SessionPersistenceCorruptionError(`journal size is outside the supported range: ${path}`, { cause: new Error('unsafe byte count') })
      let storage: JournalHeader | undefined
      const scanner = new ProjectJournalScanner(id, this.schemas, path, (event, row) => {
        storage ??= scanner.header
        assertPayloadHolder(storage!, event)
        options.onEvent?.(event, row, storage!)
      })
      const buffer = Buffer.allocUnsafe(64 * 1024)
      let position = 0
      while (position < size) {
        options.signal?.throwIfAborted()
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - position), position)
        if (bytesRead === 0) throw new SessionPersistenceCorruptionError(`journal shrank during read: ${path}`, { cause: new Error('unexpected end of file') })
        const chunk = buffer.subarray(0, bytesRead)
        options.onBytes?.(chunk)
        scanner.write(chunk)
        position += bytesRead
      }
      options.signal?.throwIfAborted()
      const decoded = scanner.finish()
      if (this.journalPath(id, { projectId: decoded.storage.projectId, logicalSessionId: decoded.storage.logicalSessionId }) !== path) throw new SessionPersistenceCorruptionError(`journal Project path does not match owner: ${path}`, { cause: new Error('owner path mismatch') })
      return { ...decoded, fileIdentity: fileIdentity(initial), stamp: fileStamp(initial) }
    } finally { try { await file.close() } finally { release() } }
  }

  private async snapshotAt(path: string, id: SessionId, signal?: AbortSignal): Promise<SessionPersistenceSnapshot | undefined> {
    signal?.throwIfAborted()
    const hash = createHash('sha256')
    const known = this.directoryStates.get(id), writer = this.writers.get(id)
    const records: ProjectRecordLocator[] = []
    const decoded = await this.scanAt(path, id, { ...(signal === undefined ? {} : { signal }), onBytes: chunk => { hash.update(chunk) },
      onEvent: (event, row) => {
        if (known !== undefined && writer !== undefined && writer !== null) {
          const expected = known.records[event.seq]
          if (expected !== undefined && expected.rawLineDigest !== rowDigest(row.raw)) { const error = new SessionPersistenceCorruptionError('Projects strict stat observed changed writer-owned bytes', { cause: new Error('record digest mismatch') }); this.invalidate(id, error); throw error }
        }
        if (writer === undefined) records.push(recordLocator(event, row.byteStart, row.byteEnd, row.raw))
      } })
    signal?.throwIfAborted()
    if (known !== undefined && writer !== undefined && writer !== null && !sameJournalValue(known.storage, decoded.storage)) { const error = new SessionPersistenceCorruptionError('Projects strict stat observed changed creation identity', { cause: new Error('stored identity changed') }); this.invalidate(id, error); throw error }
    if (this.removed.has(id)) return undefined
    this.rememberOwner(id, decoded.storage)
    // The mandatory full-SHA inventory already validated these bytes. Fill the
    // existing cold directory; never regress a writer or a newer admission that
    // appeared while this finite scan was pending. Later use still checks the
    // current file identity/stamp through loadDirectory.
    if (writer === undefined && this.writers.get(id) === undefined && this.directoryStates.get(id) === known) {
      this.directoryStates.set(id, { path, storage: freeze(decoded.storage),
        identity: known?.fileIdentity === decoded.fileIdentity && known.stamp === decoded.stamp ? known.identity : randomUUID(),
        fileIdentity: decoded.fileIdentity, stamp: decoded.stamp, records, byteEnd: decoded.committedBytes,
        sizeBytes: decoded.sizeBytes, revision: (known?.revision ?? 0) + 1 })
    }
    return { header: freeze(decoded.storage.header), eventCount: decoded.eventCount, sizeBytes: decoded.sizeBytes,
      revision: SessionPersistenceRevision(`${this.revisionScope}:${id}:${hash.digest('hex')}`) }
  }

  /** A published path may leave this collection while its finite snapshot is pending. */
  private async collectionSnapshotAt(path: string, id: SessionId, signal?: AbortSignal): Promise<SessionPersistenceSnapshot | undefined> {
    signal?.throwIfAborted()
    if (this.removed.has(id)) return undefined
    const release = this.beginRead(id)
    try {
      const snapshot = await this.snapshotAt(path, id, signal)
      signal?.throwIfAborted()
      return this.removed.has(id) ? undefined : snapshot
    } catch (error) {
      signal?.throwIfAborted()
      if (!hasCode(error, 'ENOENT')) throw error
      if (this.removed.has(id)) return undefined
      // A missing journal inside a retained directory is still a read failure.
      // Only an actual directory departure also covers a different deletion owner.
      try { await stat(dirname(path)) } catch (directoryError) {
        signal?.throwIfAborted()
        if (hasCode(directoryError, 'ENOENT')) return undefined
        throw directoryError
      }
      signal?.throwIfAborted()
      throw error
    } finally { release() }
  }

  private async directories(path: string): Promise<string[]> {
    try { return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name) }
    catch (error) { if (hasCode(error, 'ENOENT')) return []; throw error }
  }

  private async allPaths(): Promise<{ id: SessionId; path: string }[]> {
    const results: { id: SessionId; path: string }[] = []
    const projects = join(this.dataRoot, 'projects')
    for (const project of await this.directories(projects)) {
      const sessions = join(projects, project, 'sessions')
      for (const carrier of await this.directories(sessions)) {
        const path = join(sessions, carrier, JOURNAL_FILENAME)
        try { await stat(path) } catch (error) { if (hasCode(error, 'ENOENT')) continue; throw error }
        results.push({ id: SessionId(identityFromSegment(carrier)), path })
      }
    }
    return results
  }

  private async findPath(id: SessionId): Promise<string | undefined> {
    pathSegment(id)
    const paths = (await this.allPaths()).filter(item => item.id === id)
    if (paths.length > 1) throw new SessionPersistenceCorruptionError(`duplicate Projects carrier identity "${id}"`, { cause: new Error('multiple journals') })
    return paths[0]?.path
  }

  private async ensureFormat(create: boolean): Promise<void> {
    if (this.initialization !== undefined) return this.initialization
    if (!create) return this.checkFormat(false)
    const operation = this.checkFormat(true)
    this.initialization = operation
    try { await operation } catch (error) { this.initialization = undefined; throw error }
  }

  private async checkFormat(create: boolean): Promise<void> {
    const formatPath = join(this.dataRoot, 'FORMAT.json')
    const check = async (): Promise<boolean> => {
      let raw: string
      try { raw = await readFile(formatPath, 'utf8') } catch (error) { if (hasCode(error, 'ENOENT')) return false; throw error }
      let item: unknown
      try { item = JSON.parse(raw) } catch (error) { throw new SessionPersistenceCorruptionError(`invalid Projects data format: ${formatPath}`, { cause: error }) }
      if (item === null || typeof item !== 'object' || Array.isArray(item)
        || Object.keys(item).sort().join(',') !== Object.keys(DATA_HEADER).sort().join(',')
        || (item as Record<string, unknown>).format !== PROJECT_DATA_FORMAT
        || (item as Record<string, unknown>).journalFormat !== PROJECT_JOURNAL_FORMAT
        || !isSupportedStockSessionVersion((item as Record<string, unknown>).nativeVersion)) {
        throw new SessionFormatUnsupportedError(`Projects dataRoot has unsupported FORMAT.json: ${formatPath}`)
      }
      return true
    }
    if (await check()) return
    let entries: string[]
    try { entries = await readdir(this.dataRoot) } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; entries = [] }
    if (entries.some(entry => !entry.startsWith('.projects-format-'))) {
      throw new SessionFormatUnsupportedError(`Projects dataRoot is nonempty without FORMAT.json; choose a new directory or explicitly migrate: ${this.dataRoot}`)
    }
    if (!create) return
    await durableMkdir(this.dataRoot)
    const temporary = join(this.dataRoot, `.projects-format-${randomUUID()}`)
    const file = await open(temporary, 'wx', 0o600)
    try { await writeAll(file, Buffer.from(`${JSON.stringify(DATA_HEADER)}\n`)); await file.sync() } finally { await file.close() }
    try { await link(temporary, formatPath) } catch (error) { if (!hasCode(error, 'EEXIST')) throw error } finally { await unlink(temporary) }
    await syncDirectory(this.dataRoot)
    if (!await check()) throw new Error('Projects data format publication disappeared')
  }

  private async publishHeader(path: string, storage: JournalHeader): Promise<FileHandle> {
    const directory = dirname(path)
    await durableMkdir(directory)
    const temporary = join(directory, `.journal-${randomUUID()}`)
    let staging: FileHandle | undefined
    try {
      staging = await open(temporary, 'wx', 0o600)
      await writeAll(staging, Buffer.from(`${JSON.stringify(storage)}\n`))
      await staging.sync()
      await staging.close()
      staging = undefined
      try { await link(temporary, path) } catch (error) { if (hasCode(error, 'EEXIST')) throw new SessionAlreadyExistsError(storage.header.id); throw error }
      await unlink(temporary)
      await syncDirectory(directory)
      return await open(path, 'a+')
    } catch (error) {
      await staging?.close()
      await unlink(temporary).catch(cleanup => { if (!hasCode(cleanup, 'ENOENT')) throw cleanup })
      throw error
    }
  }
}

/** A single-writer channel with acknowledged-prefix and durable-prefix state. */
export class ProjectSessionHandle implements SessionHandle {
  readonly epoch = randomUUID()
  readonly id: SessionId
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly owner: ProjectSessionOwner
  private chain: Promise<unknown> = Promise.resolve()
  private closing?: Promise<void>
  private failure: unknown
  private cursor: number
  private observedLength: number
  private durableLength: number
  private byteEnd: number
  private durableByteEnd?: number
  private durableStamp?: string
  private readonly nativeVersion: JournalHeader['nativeVersion']

  constructor(
    private readonly provider: ProjectSessionPersistence,
    storage: JournalHeader,
    readonly access: SessionAccess,
    readonly journalPath: string,
    eventCount: number,
    private readonly file?: FileHandle,
    private readonly lock?: ProjectWriterLock,
  ) {
    this.id = storage.header.id
    this.header = freeze(structuredClone(storage.header))
    this.inheritedEventCount = storage.inheritedEventCount
    this.owner = freeze({ projectId: storage.projectId, logicalSessionId: storage.logicalSessionId })
    this.nativeVersion = storage.nativeVersion
    this.cursor = eventCount
    this.observedLength = eventCount
    this.durableLength = eventCount
    this.byteEnd = this.provider.initialByteEnd(this.id)
  }

  /** Last real fsync prefix; read handles do not claim a durability barrier. */
  get durableEventCount(): SessionLogOffset | undefined { return this.access === 'write' ? SessionLogOffset(this.durableLength) : undefined }
  invalidate(error: unknown): void { this.failure ??= error }
  async assertOwned(): Promise<void> { this.assertStaging(); await this.assertWriter() }
  /** Cleanup joins a failed/closing writer, but still requires its actual lease and fixed file. */
  async assertOwnedForCleanup(): Promise<void> { if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'payload cleanup'); await this.assertWriter() }
  assertStaging(): void { this.assertOpen('stagePayload'); this.assertHealthy(); if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'stagePayload') }
  committedRange(targetNext = this.durableLength): CommittedRange {
    if (this.access !== 'write' || targetNext > this.durableLength) throw new Error('PROJECT_DURABILITY_UNCONFIRMED')
    return this.provider.confirmed(this, targetNext)
  }

  async read(offset = 0, length = Number.MAX_SAFE_INTEGER, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult> {
    this.assertOpen('read')
    return this.enqueue(async () => {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('read offset must be a non-negative safe integer')
      if (!Number.isSafeInteger(length) || length < 0) throw new TypeError('read length must be a non-negative safe integer')
      options?.signal?.throwIfAborted()
      const events: SessionEvent[] = []
      await this.scanCurrent(event => { if (event.seq >= offset && event.seq - offset < length) events.push(event) }, options)
      return { eventState: 'detached', events }
    })
  }

  /** Verify real committed bytes against an immutable live prefix, sharing only equal events. */
  async readSharedPrefix(prefix: readonly SessionEvent[], options?: SessionHandleReadOptions): Promise<{ readonly events: readonly SessionEvent[]; readonly reusedEventCount: number }> {
    this.assertOpen('read')
    // This seam accepts shared values. Freeze them before queueing so later mutation
    // cannot turn a verified event into different body text during another await.
    freeze(prefix)
    return this.enqueue(async () => {
      const canonical: SessionEvent[] = []
      let reusedEventCount = 0
      let changed = false
      const current = await this.scanCurrent((event, row) => {
        if (event.seq < prefix.length) {
          const live = prefix[event.seq]!
          if (sameJournalValue(event, live)) { canonical.push(live); reusedEventCount++ }
          else {
            const data = live.data as unknown as Record<string, unknown>, original = data.payload as ProjectLegacyRecordReference | undefined
            if (data.version !== 2 || data.representation !== 'legacy-derived' || original?.kind !== 'projects-legacy-record' || live.type !== `${event.type}-v2` || live.seq !== event.seq || live.time !== event.time || original.owner.carrierId !== this.id
              || original.owner.createdAt !== this.header.createdAt || original.owner.projectId !== this.owner.projectId || original.owner.logicalSessionId !== this.owner.logicalSessionId
              || original.seq !== event.seq || original.type !== event.type || original.time !== event.time || original.eventDigest !== nativeSourceDigest(event)
              || original.byteStart !== row.byteStart || original.byteEnd !== row.byteEnd || original.rawLineDigest !== rowDigest(row.raw)) throw new SessionPersistenceCorruptionError(`session "${this.id}" persisted event at seq ${event.seq} differs from the live prefix`, { cause: new Error('live prefix mismatch') })
            canonical.push(freeze(event)); changed = true
          }
        } else { canonical.push(freeze(event)); changed = true }
      }, options)
      if (current.eventCount < prefix.length) throw new SessionPersistenceCorruptionError(`session "${this.id}" stored prefix is shorter than the flushed live prefix`, { cause: new Error('missing live prefix') })
      return { events: changed ? Object.freeze(canonical) : prefix, reusedEventCount }
    })
  }

  private async scanCurrent(onEvent: (event: SessionEvent, row: { byteStart: number; byteEnd: number; raw: Buffer }) => void, options?: SessionHandleReadOptions): Promise<JournalScan> {
    options?.signal?.throwIfAborted()
    const current = await this.provider.readJournal(this.journalPath, this.id, onEvent, options?.signal)
    if (!sameJournalValue(current.storage.header, this.header) || current.storage.nativeVersion !== this.nativeVersion
      || current.storage.inheritedEventCount !== this.inheritedEventCount
      || current.storage.projectId !== this.owner.projectId || current.storage.logicalSessionId !== this.owner.logicalSessionId) {
      throw new SessionPersistenceCorruptionError(`session "${this.id}" creation identity changed while handle is open`, { cause: new Error('stored identity changed') })
    }
    if (current.eventCount < this.observedLength) throw new SessionPersistenceCorruptionError(`session "${this.id}" stored prefix shrank`, { cause: new Error('non-monotonic read') })
    this.observedLength = current.eventCount
    return current
  }

  async append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
    this.assertOpen('append')
    if (this.access !== 'write') return Promise.reject(new SessionReadOnlyError(this.id, 'append'))
    // Snapshot before queueing: the caller cannot mutate a waiting batch into unchecked bytes.
    const batch = materializeAppendBatch(events) as SessionEvent[]
    return this.enqueue(async () => {
      options?.signal?.throwIfAborted()
      this.assertHealthy()
      this.provider.validateBatch(this.header, batch, this.journalPath, this.cursor)
      if (batch.length === 0) return
      try {
        await this.assertWriter()
        // The detached batch is the acknowledged input. Serialize only one row
        // at a time instead of also retaining whole-batch strings and a buffer.
        const rows: ProjectRecordLocator[] = []
        let byteEnd = this.byteEnd
        for (const event of batch) {
          await this.provider.publishEventPayload(this, event)
          await this.assertWriter()
          const raw = Buffer.from(`${JSON.stringify(event)}\n`)
          await writeAll(this.file!, raw)
          rows.push(recordLocator(event, byteEnd, byteEnd + raw.length, raw.subarray(0, -1)))
          byteEnd += raw.length
        }
        const status = await this.file!.stat({ bigint: true })
        if (Number(status.size) !== byteEnd) throw new SessionOwnershipLostError(this.id)
        this.cursor += batch.length
        this.byteEnd = byteEnd
        this.observedLength = this.cursor
        this.provider.acknowledge(this, rows, freeze(batch), byteEnd, fileStamp(status))
      } catch (error) { this.provider.abandonEventPayloads(this, batch); this.failure = error; throw error }
    })
  }

  async flush(options?: SessionHandleFlushOptions): Promise<void> {
    this.assertOpen('flush')
    if (this.access !== 'write') return Promise.reject(new SessionReadOnlyError(this.id, 'flush'))
    return this.enqueue(async () => { options?.signal?.throwIfAborted(); await this.barrier() })
  }

  /** @internal Service flush joins a concurrently closing writer. */
  flushOrJoinClose(): Promise<void> { return this.closing ?? this.flush() }

  close(): Promise<void> {
    return this.closing ??= this.enqueue(async () => {
      const errors: unknown[] = []
      if (this.access === 'write') {
        try { await this.barrier() } catch (error) { errors.push(error) }
        try { await this.provider.reclaimPayloads(this) } catch (error) { errors.push(error) }
      }
      try { await this.file?.close() } catch (error) { errors.push(error) }
      try { await this.lock?.close() } catch (error) { errors.push(error) }
      this.provider.release(this)
      if (errors.length > 1) throw new AggregateError(errors, `session "${this.id}" close failed`)
      if (errors.length === 1) throw errors[0]
    })
  }

  [Symbol.asyncDispose](): Promise<void> { return this.close() }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation)
    // The serialization tail tracks completion only. Forwarding a successful
    // read value here would retain that event body for the handle's lifetime.
    this.chain = next.then(() => {}, () => {})
    return next
  }

  private assertOpen(operation: string): void { if (this.closing !== undefined) throw new SessionHandleClosedError(this.id, operation) }
  private assertHealthy(): void { if (this.failure !== undefined) throw this.failure }

  private async assertWriter(): Promise<BigIntStats> {
    if (this.file === undefined || this.lock === undefined) throw new SessionReadOnlyError(this.id, 'write')
    // Read confirmations may check this lease outside the append queue. Prove
    // the prefix accepted at entry, not a later ACK after these stats sampled.
    const byteEnd = this.byteEnd
    await this.lock.assertOwned()
    const current = await stat(this.journalPath, { bigint: true })
    const held = await this.file.stat({ bigint: true })
    if (current.ino !== held.ino || current.dev !== held.dev) throw new SessionOwnershipLostError(this.id)
    if (Number(held.size) < byteEnd) throw new SessionPersistenceCorruptionError('Projects journal stored prefix shrank', { cause: new Error('writer byte cursor regression') })
    return held
  }

  private async barrier(): Promise<void> {
    try {
      const held = await this.assertWriter()
      const stamp = fileStamp(held)
      // Only a completed barrier supplies this proof. Event count alone misses
      // a fresh header and physical bytes left by an unacknowledged append.
      if (this.durableByteEnd !== this.byteEnd || this.durableStamp !== stamp) {
        await this.file!.sync()
        this.durableByteEnd = this.byteEnd
        this.durableStamp = stamp
      }
      this.durableLength = this.cursor
    } catch (error) { this.failure ??= error; throw error }
    this.assertHealthy()
    this.provider.publishConfirmed(this)
  }
}

export default ProjectSessionPersistence
