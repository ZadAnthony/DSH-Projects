import { isAbsolute } from 'node:path'
import {
  adoptSessionEvent,
  KNOWN_SESSION_EVENT_TYPES,
  SessionLogOffset,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import {
  assertContiguous,
  assertStoredId,
  assertVersion,
  SessionFormatUnsupportedError,
  SessionPersistenceCorruptionError,
  validateStoredEvents,
} from '@deepseek-ai/dsh-session-persistence'

export const PROJECT_JOURNAL_FORMAT = 'projects-session-journal/v1'
export const PROJECT_DATA_FORMAT = 'projects-data/v1'
export const STOCK_SESSION_VERSION = '0.2.1-rc.3'
export type SupportedStockSessionVersion = '0.2.0-rc.2' | typeof STOCK_SESSION_VERSION

/** Exact birth-version admission; the native v4 validator still owns every payload. */
export function isSupportedStockSessionVersion(value: unknown): value is SupportedStockSessionVersion {
  return value === '0.2.0-rc.2' || value === STOCK_SESSION_VERSION
}

/** Business membership is supplied by the Projects owner, never inferred from cwd. */
export interface ProjectSessionOwner {
  readonly projectId: string
  readonly logicalSessionId: string
}

export type ProjectEventValidator = (data: unknown) => void

export interface JournalHeader extends ProjectSessionOwner {
  readonly format: typeof PROJECT_JOURNAL_FORMAT
  readonly nativeVersion: SupportedStockSessionVersion
  readonly carrierId: SessionId
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
}

export interface DecodedJournal {
  readonly storage: JournalHeader
  readonly events: SessionEvent[]
  /** Only newline-terminated records count. The remainder is an uncommitted torn tail. */
  readonly committedBytes: number
  readonly sizeBytes: number
}

export interface JournalScan {
  readonly storage: JournalHeader
  readonly eventCount: number
  readonly committedBytes: number
  readonly sizeBytes: number
}

/** JSON-value equality, including property order, without serializing a whole prefix. */
export function sameJournalValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (Array.isArray(left) && left.length !== (right as unknown[]).length) return false
  const leftKeys = Object.keys(left), rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key, index) => key === rightKeys[index]
    && sameJournalValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
}

function record(value: unknown, subject: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${subject} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], subject: string): void {
  const allowed = new Set([...required, ...optional])
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.has(key))) {
    throw new TypeError(`${subject} has invalid fields`)
  }
}

function nonempty(value: unknown, subject: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${subject} must be a nonempty string`)
}

function integer(value: unknown, subject: string, nonnegative = true): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || (nonnegative && value < 0)) {
    throw new TypeError(`${subject} must be ${nonnegative ? 'a non-negative' : 'a'} safe integer`)
  }
}

export function validateOwner(value: unknown): asserts value is ProjectSessionOwner {
  const item = record(value, 'Project session owner')
  exactKeys(item, ['projectId', 'logicalSessionId'], [], 'Project session owner')
  nonempty(item.projectId, 'projectId')
  nonempty(item.logicalSessionId, 'logicalSessionId')
}

/** The stock logical header shape, without normalizing or fabricating any field. */
export function validateHeader(value: unknown, id: SessionId, journalPath?: string): asserts value is SessionHeader {
  const item = record(value, 'Session header')
  assertVersion(item as unknown as SessionHeader, journalPath === undefined ? undefined : { kind: PROJECT_JOURNAL_FORMAT, path: journalPath })
  exactKeys(item, ['version', 'id', 'createdAt', 'isSeeded'], ['cwd', 'parentSession', 'origin', 'delegationDepth', 'agentPreset'], 'Session header')
  nonempty(item.id, 'Session header id')
  assertStoredId(id, item as unknown as SessionHeader)
  integer(item.createdAt, 'Session header createdAt')
  if (typeof item.isSeeded !== 'boolean') throw new TypeError('Session header isSeeded must be boolean')
  if (item.cwd !== undefined && (typeof item.cwd !== 'string' || !isAbsolute(item.cwd))) throw new TypeError('Session header cwd must be absolute')
  if (item.parentSession !== undefined && typeof item.parentSession !== 'string') throw new TypeError('Session header parentSession must be a string')
  if (item.origin !== undefined && item.origin !== 'subagent') throw new TypeError('Session header origin must be subagent')
  if (item.delegationDepth !== undefined) integer(item.delegationDepth, 'Session header delegationDepth')
  if (item.agentPreset !== undefined && typeof item.agentPreset !== 'string') throw new TypeError('Session header agentPreset must be a string')
}

export function validateInherited(header: SessionHeader, cut: unknown): asserts cut is SessionLogOffset {
  integer(cut, 'inheritedEventCount')
  if (!header.isSeeded && cut !== 0) throw new TypeError('unseeded session inheritedEventCount must be 0')
}

/** Session's envelope validation is kept at the storage boundary as well as at replay. */
function validateEnvelope(value: unknown): asserts value is SessionEvent {
  const item = record(value, 'Session event')
  exactKeys(item, ['type', 'seq', 'time', 'data'], ['surfaceOp', 'sourceEventSeqs', 'ignorable'], 'Session event')
  nonempty(item.type, 'Session event type')
  integer(item.seq, 'Session event seq')
  integer(item.time, 'Session event time', false)
  if (item.data === undefined || (item.ignorable !== undefined && item.ignorable !== true)) throw new TypeError('Session event envelope is invalid')
}

export function validateEvents(
  header: SessionHeader,
  events: SessionEvent[],
  schemas: ReadonlyMap<string, ProjectEventValidator>,
  journalPath: string,
  cursor = 0,
): SessionEvent[] {
  const location = { kind: PROJECT_JOURNAL_FORMAT, path: journalPath }
  assertContiguous(header.id, events, cursor)
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!
    try {
      validateEnvelope(event)
      const validator = schemas.get(event.type)
      if (validator !== undefined) {
        if (event.ignorable !== undefined) throw new TypeError(`registered Projects event ${event.type} must remain required`)
        validator(event.data)
        events[index] = adoptSessionEvent(event)
      } else {
        // The unmodified public validator owns native vocabulary and native payload semantics.
        // In particular, a required unknown event is still refused here.
        validateStoredEvents(header, [event], location)
      }
    } catch (error) {
      if (error instanceof SessionFormatUnsupportedError || error instanceof SessionPersistenceCorruptionError) throw error
      throw new SessionPersistenceCorruptionError(`session "${header.id}" event at seq ${String(event?.seq)} failed validation`, { cause: error })
    }
  }
  return events
}

export function validateProjectSchemaType(type: string): void {
  if (!type.startsWith('projects/') || type.length === 'projects/'.length || KNOWN_SESSION_EVENT_TYPES.has(type)) {
    throw new TypeError('Project schemas must name a distinct projects/ event')
  }
}

/** A one-record-at-a-time decoder; only an incomplete physical row is buffered. */
export class ProjectJournalScanner {
  private storage?: JournalHeader
  private eventCount = 0
  private committedBytes = 0
  private sizeBytes = 0
  private fragments: Buffer[] = []
  private fragmentBytes = 0
  private finished = false

  constructor(
    private readonly expectedId: SessionId,
    private readonly schemas: ReadonlyMap<string, ProjectEventValidator>,
    private readonly journalPath: string,
    private readonly onEvent?: (event: SessionEvent, row: { byteStart: number; byteEnd: number; raw: Buffer }) => void,
  ) {}
  get header(): JournalHeader | undefined { return this.storage }

  write(chunk: Buffer): void {
    if (this.finished) throw new Error('Projects journal scanner is finished')
    const chunkStart = this.sizeBytes
    this.sizeBytes += chunk.length
    let start = 0
    for (let end = chunk.indexOf(0x0a); end !== -1; end = chunk.indexOf(0x0a, start)) {
      let line = chunk.subarray(start, end)
      if (this.fragmentBytes > 0) {
        this.fragments.push(line)
        line = Buffer.concat(this.fragments, this.fragmentBytes + line.length)
        this.fragments = []
        this.fragmentBytes = 0
      }
      this.consume(line, this.committedBytes, chunkStart + end + 1)
      this.committedBytes = chunkStart + end + 1
      start = end + 1
    }
    // The caller may reuse its I/O buffer after write returns.
    if (start < chunk.length) {
      const fragment = Buffer.from(chunk.subarray(start))
      this.fragments.push(fragment)
      this.fragmentBytes += fragment.length
    }
  }

  finish(): JournalScan {
    this.finished = true
    this.fragments = []
    this.fragmentBytes = 0
    if (this.storage === undefined) throw new SessionPersistenceCorruptionError(`journal header is incomplete: ${this.journalPath}`, { cause: new Error('missing header newline') })
    return { storage: this.storage, eventCount: this.eventCount, committedBytes: this.committedBytes, sizeBytes: this.sizeBytes }
  }

  private consume(line: Buffer, byteStart: number, byteEnd: number): void {
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(line)
      const value = JSON.parse(text) as unknown
      if (this.storage === undefined) {
        this.storage = this.parseHeader(value)
      } else {
        const [event] = validateEvents(this.storage.header, [value as SessionEvent], this.schemas, this.journalPath, this.eventCount)
        this.onEvent?.(event!, { byteStart, byteEnd, raw: line })
        this.eventCount += 1
      }
    } catch (error) {
      if (error instanceof SessionFormatUnsupportedError || error instanceof SessionPersistenceCorruptionError) throw error
      throw new SessionPersistenceCorruptionError(`invalid Projects journal: ${this.journalPath}`, { cause: error })
    }
  }

  private parseHeader(value: unknown): JournalHeader {
    const item = record(value, 'Journal header')
    if (item.format !== PROJECT_JOURNAL_FORMAT || !isSupportedStockSessionVersion(item.nativeVersion)) {
      throw new SessionFormatUnsupportedError(`unsupported Projects journal format or stock version (raw log: ${this.journalPath})`, { kind: PROJECT_JOURNAL_FORMAT, path: this.journalPath })
    }
    exactKeys(item, ['format', 'nativeVersion', 'projectId', 'logicalSessionId', 'carrierId', 'header', 'inheritedEventCount'], [], 'Journal header')
    validateOwner({ projectId: item.projectId, logicalSessionId: item.logicalSessionId })
    if (item.carrierId !== this.expectedId) throw new TypeError('Journal carrier identity mismatch')
    validateHeader(item.header, this.expectedId, this.journalPath)
    validateInherited(item.header, item.inheritedEventCount)
    return item as unknown as JournalHeader
  }
}

/** Compatibility decoder; production I/O feeds the same scanner in bounded chunks. */
export function decodeJournal(raw: Buffer, expectedId: SessionId, schemas: ReadonlyMap<string, ProjectEventValidator>, journalPath: string): DecodedJournal {
  const events: SessionEvent[] = []
  const scanner = new ProjectJournalScanner(expectedId, schemas, journalPath, event => { events.push(event) })
  scanner.write(raw)
  const result = scanner.finish()
  return { storage: result.storage, events, committedBytes: result.committedBytes, sizeBytes: result.sizeBytes }
}

/** Injective UTF-16 path escaping: SessionId is a branded string, not a safe path. */
export function pathSegment(raw: string): string {
  nonempty(raw, 'Path identity')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let encoded = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const character = String.fromCharCode(code)
    encoded += /^[A-Za-z0-9._-]$/.test(character) ? character : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return encoded
}
