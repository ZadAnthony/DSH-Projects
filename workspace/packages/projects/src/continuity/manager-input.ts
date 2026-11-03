/** The manager's bounded input is selected before any visible-history projection. */
import { createHash } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { NativeEventSource } from '../source-reference-types.ts'
import { readContinuitySource, type ContinuityDirectory } from './directory-view.ts'
import type { ProjectRecordLocator } from '../stock/persistence/types.ts'
import type { MainContinuityHistoryOptions, MainHistoryDirectory } from './history-types.ts'
import type { SettledTurnKey } from './types.ts'
import { isMainBusinessInput } from './business-input.ts'

/** Manager reads retain only selected originals; shared full-history views stay independent. */
type Prefix = ContinuityDirectory & { readonly events: Map<number, SessionEvent>; readonly canonicalEvents: Map<number, SessionEvent> }
type Input = SessionEvent<'user/message'>
type Reply = SessionEvent<'assistant/message'>
interface Turn { readonly start: number; readonly end: number; readonly inputs: readonly number[]; readonly reply?: number }
export interface ManagerExcerpt {
  readonly source: NativeEventSource
  readonly encoding: 'canonical-json-fragment'
  readonly text: string
  readonly range: { readonly unit: 'unicode-code-points'; readonly start: number; readonly end: number; readonly total: number }
  readonly selected_range: { readonly start: number; readonly end: number }
}
export interface ManagerMessage {
  readonly eventSeq: number
  readonly time: number
  readonly producer: Readonly<Record<string, string | number | boolean>>
  /** The entry itself is not a body receipt. */
  readonly read: { readonly action: 'read_content'; readonly source: NativeEventSource }
  readonly content: readonly ManagerExcerpt[]
  readonly complete: boolean
  readonly limitations: readonly string[]
}
export interface MainManagerInput {
  readonly requestedTurns: 3
  readonly currentInputs: readonly ManagerMessage[]
  readonly replies: readonly { readonly key: SettledTurnKey; readonly reply?: ManagerMessage; readonly status: 'available' | 'no-outward-reply'; readonly complete: boolean }[]
  readonly directory: MainHistoryDirectory
  readonly carrierCount: number
  readonly directoryComplete: boolean
  readonly selectionComplete: boolean
  readonly complete: boolean
  readonly limitations: readonly string[]
}

// These are transport/resource budgets, independent of the model's actual token capacity.
export const MANAGER_INPUT_POINTS = 65_536
const BODY_POINTS = 16_384, RECORD_POINTS = 4096, MAX_INPUTS = 32, MAX_BLOCKS = 16, DIRECTORY_CARRIERS = 12

/** Read only turn boundaries, actual consumed inputs and the last settled reply in each selected turn. */
export async function selectMainManagerInput(options: MainContinuityHistoryOptions, directory: MainHistoryDirectory,
  through: SettledTurnKey, signal?: AbortSignal): Promise<MainManagerInput> {
  const target = directory.carriers.find(carrier => carrier.hostSessionId === through.hostSessionId)
  if (target === undefined) throw new Error('Manager cut is outside this stable main.')
  const limitations: string[] = [], selected: Array<{ prefix: Prefix; turn: Turn }> = []
  let currentInputs: readonly ManagerMessage[] | undefined, remaining = BODY_POINTS, selectionComplete = true
  for (const carrier of directory.carriers.toReversed()) {
    if (carrier.sequence > target.sequence) continue
    signal?.throwIfAborted()
    if (carrier.status !== 'available') { selectionComplete = false; limitations.push(`${carrier.hostSessionId}: ${carrier.status}`); continue }
    const native = await readContinuitySource(options.core, directory.projectId, carrier.hostSessionId, signal)
    signal?.throwIfAborted()
    if (!native.readable || native.sessionId !== directory.mainSessionId || carrier.header !== undefined &&
      (carrier.header.createdAt !== native.sessionCreatedAt || carrier.header.version !== native.formatVersion)) {
      selectionComplete = false; limitations.push(`${carrier.hostSessionId}: durable source unavailable or creation identity changed`); continue
    }
    const prefix = managerPrefix(native, signal)
    let end = prefix.endSeq
    if (carrier.hostSessionId === through.hostSessionId) {
      const start = prefix.directory.records[through.turnStartSeq], last = prefix.directory.records[through.turnEndSeq]
      if (prefix.sessionCreatedAt !== through.sessionCreatedAt || start?.type !== 'turn/start' || last?.type !== 'turn/end'
        || start.facts.turn !== last.facts.turn || last.facts.reasonKind !== 'completed') throw new Error('Manager cut is not an exact normally completed durable turn.')
      end = through.turnEndSeq
    }
    const turns = completedTurns(prefix, end, signal)
    const current = carrier.hostSessionId === through.hostSessionId ? turns.find(turn => turn.start === through.turnStartSeq && turn.end === through.turnEndSeq) : undefined
    if (carrier.hostSessionId === through.hostSessionId && current === undefined) throw new Error('Manager cut has no real consumed business input.')
    if (current !== undefined) {
      if (current.inputs.length > MAX_INPUTS) throw new Error('Manager minimum input exceeds the finite consumed-input manifest budget.')
      const inputs: ManagerMessage[] = []
      await loadManagerPositions(prefix, current.inputs, signal)
      for (const seq of current.inputs) { const event = prefix.events.get(seq) as Input; const result = await projectMessage(prefix, event, Math.min(RECORD_POINTS, remaining), signal); remaining -= bodyPoints(result); inputs.push(result) }
      currentInputs = inputs
    }
    for (const turn of turns.toReversed()) { selected.unshift({ prefix, turn }); if (selected.length === 3) break }
    const live = await options.core.readSessionSource(carrier.hostSessionId)
    signal?.throwIfAborted()
    if (live?.projectId !== directory.projectId || live.id !== directory.mainSessionId || live.role !== 'main'
      || live.sourceLifecycle.kind !== 'available' || live.revision !== prefix.sourceRevision) throw new Error('Manager source ownership or revision changed while selecting input.')
    if (selected.length === 3) break
  }
  if (currentInputs === undefined) throw new Error('Manager current consumed inputs are unavailable at the durable cut.')
  for (const prefix of new Set(selected.map(value => value.prefix))) {
    const live = await options.core.readSessionSource(prefix.hostSessionId)
    signal?.throwIfAborted()
    if (live?.projectId !== directory.projectId || live.id !== directory.mainSessionId || live.role !== 'main'
      || live.sourceLifecycle.kind !== 'available' || live.revision !== prefix.sourceRevision) throw new Error('Manager source changed before bounded input delivery.')
  }
  const replies: MainManagerInput['replies'][number][] = []
  for (const { prefix, turn } of selected) {
    const key = { hostSessionId: prefix.hostSessionId, sessionCreatedAt: prefix.sessionCreatedAt, turnStartSeq: turn.start, turnEndSeq: turn.end }
    if (turn.reply !== undefined) await loadManagerPositions(prefix, [turn.reply], signal)
    const reply = turn.reply === undefined ? undefined : await projectMessage(prefix, prefix.events.get(turn.reply) as Reply, Math.min(RECORD_POINTS, remaining), signal)
    if (reply !== undefined) remaining -= bodyPoints(reply)
    replies.push({ key, ...(reply === undefined ? {} : { reply }), status: reply === undefined || reply.content.length === 0 ? 'no-outward-reply' as const : 'available' as const,
      complete: reply?.complete ?? false })
  }
  for (const prefix of new Set(selected.map(value => value.prefix))) await prefix.revalidate()
  if (replies.length < 3) limitations.push(`Only ${replies.length} completed normal turn(s) are available; requested 3.`)
  limitations.push('This is a partial historical window. Entries and unshown body ranges are not delivered evidence.')
  const carriers = directory.carriers.slice(-DIRECTORY_CARRIERS).map(({ header: _header, ...entry }) => entry)
  const result: MainManagerInput = { requestedTurns: 3, currentInputs, replies,
    directory: { ...directory, carriers, previousCarrier: directory.previousCarrier === undefined ? undefined : carriers.find(carrier => carrier.hostSessionId === directory.previousCarrier!.hostSessionId), limitations: directory.limitations.slice(0, DIRECTORY_CARRIERS) },
    carrierCount: directory.carriers.length, directoryComplete: carriers.length === directory.carriers.length,
    selectionComplete, complete: selectionComplete && currentInputs.every(input => input.complete) && replies.every(reply => reply.complete), limitations }
  assertManagerJsonBudget(result, MANAGER_INPUT_POINTS)
  return result
}

function managerPrefix(source: ContinuityDirectory, signal?: AbortSignal): Prefix {
  // Keep the whole captured directory's gap rejection, including records after a fixed cut.
  // The owner already validates contiguous journals; no per-record query shapes or index are needed.
  for (let seq = 0; seq <= source.endSeq; seq++) {
    signal?.throwIfAborted()
    if (source.directory.records[seq]?.seq !== seq) throw new Error('CONTINUITY_DIRECTORY_GAP')
  }
  return { ...source, events: new Map(), canonicalEvents: new Map() }
}

async function loadManagerPositions(prefix: Prefix, seqs: Iterable<number>, signal?: AbortSignal): Promise<void> {
  for (const seq of new Set(seqs)) {
    signal?.throwIfAborted()
    if (seq < 0 || seq > prefix.endSeq || prefix.events.has(seq)) continue
    const decoded = await prefix.readDecodedEvent(seq)
    if (decoded === undefined) throw new Error('CONTINUITY_SELECTED_RECORD_UNAVAILABLE')
    if (decoded.canonical.seq !== seq || decoded.semantic.seq !== seq) throw new Error('CONTINUITY_SELECTED_RECORD_POSITION_MISMATCH')
    prefix.canonicalEvents.set(seq, decoded.canonical)
    prefix.events.set(seq, decoded.semantic)
  }
}

function completedTurns(prefix: Prefix, through: number, signal?: AbortSignal): Turn[] {
  const turns: Turn[] = []
  let start: ProjectRecordLocator | undefined, inputs: number[] = [], reply: number | undefined
  // Preserve forward reset/first-matching-end semantics, including failed and reused turn ids.
  for (let index = prefix.inheritedEventCount; index <= through; index++) {
    signal?.throwIfAborted()
    const event = prefix.directory.records[index]!
    const facts = event.facts, append = facts.surfaceOp === undefined || facts.surfaceOp === 'append'
    if (event.type === 'turn/start') { start = event; inputs = []; reply = undefined }
    else if (start !== undefined && event.type === 'user/message' && isMainBusinessInput(String(facts.sourceKind ?? 'user')) && append) inputs.push(event.seq)
    else if (start !== undefined && event.type === 'assistant/message' && facts.turn === start.facts.turn && facts.interrupted !== true && append) reply = event.seq
    else if (start !== undefined && event.type === 'turn/end' && facts.turn === start.facts.turn) {
      if (facts.reasonKind === 'completed' && inputs.length > 0) {
        turns.push({ start: start.seq, end: event.seq, inputs, ...(reply === undefined ? {} : { reply }) })
        if (turns.length > 3) turns.shift()
      }
      start = undefined; inputs = []; reply = undefined
    }
  }
  return turns
}

async function projectMessage(prefix: Prefix, event: Input | Reply, budget: number, signal?: AbortSignal): Promise<ManagerMessage> {
  const message = event.type === 'user/message' ? event.data : event.data.message
  // Hash in chunks: neither a giant event nor its body is copied into a giant JSON string.
  const native: NativeEventSource = { kind: 'native-event', version: 1, projectId: prefix.projectId, sessionId: prefix.sessionId,
    hostSessionId: prefix.hostSessionId, sessionCreatedAt: prefix.sessionCreatedAt, eventSpace: { kind: 'canonical', formatVersion: prefix.formatVersion },
    eventSeq: event.seq, eventType: event.type, eventDigest: await digest(prefix.canonicalEvents?.get(event.seq) ?? event, signal), messageId: String(message.id) }
  const blocks: Record<string, unknown>[] = [], limitations: string[] = []
  for (const block of message.content) {
    signal?.throwIfAborted()
    if (block.type === 'reasoning') continue
    if (block.type === 'text') blocks.push({ type: 'text', text: block.text })
    else if (block.type === 'tool-call') blocks.push({ type: 'quoted-tool-call', toolCallId: block.id, name: block.name, arguments: block.arguments })
    else if (block.type === 'file' || block.type === 'image') {
      const keys = block.type === 'image' ? ['attachmentId', 'mediaType', 'bytes', 'width', 'height', 'name', 'originalDimensions'] : ['attachmentId', 'name', 'bytes']
      if (typeof block.attachment?.attachmentId !== 'string' || Object.keys(block.attachment).some(key => !keys.includes(key))
        || Object.keys(block).some(key => !['type', 'attachment', ...(block.type === 'image' ? ['offloaded'] : [])].includes(key))) limitations.push('Unsupported outward attachment descriptor; use the exact source entry.')
      else blocks.push(block as unknown as Record<string, unknown>)
    } else limitations.push('Unsupported outward block; use the exact source entry.')
  }
  const hash = createHash('sha256'), excerpts: Array<{ start: number; end: number; text: string; selectedEnd: number }> = []
  let position = 0, remaining = budget, chunks = 0
  const feed = (chunk: string) => { hash.update(chunk); position += points(chunk) }
  feed('[')
  for (const [index, block] of blocks.entries()) {
    if (index !== 0) feed(',')
    const start = position, allowed = block.type !== 'quoted-tool-call' && excerpts.length < MAX_BLOCKS
    let text = '', kept = 0
    for (const chunk of canonicalChunks(block)) {
      signal?.throwIfAborted(); feed(chunk)
      if (++chunks % 64 === 0) await cooperate(signal)
      if (allowed && kept < remaining) { const part = takePoints(chunk, remaining - kept); text += part; kept += points(part) }
    }
    if (allowed) { excerpts.push({ start, end: start + kept, text, selectedEnd: position }); remaining -= kept }
  }
  feed(']')
  const source: NativeEventSource = { ...native, body: { stream: 'visible-blocks', codec: 'canonical-json/v1', digest: 'sha256:' + hash.digest('hex') } }
  const content = excerpts.filter(excerpt => excerpt.text.length > 0).map(excerpt => ({ encoding: 'canonical-json-fragment' as const, text: excerpt.text,
    source: { ...source, body: { ...source.body!, range: { unit: 'unicode-code-points' as const, start: excerpt.start, end: excerpt.end } } },
    range: { unit: 'unicode-code-points' as const, start: excerpt.start, end: excerpt.end, total: position }, selected_range: { start: excerpt.start, end: excerpt.selectedEnd } }))
  const complete = limitations.length === 0 && blocks.filter(block => block.type !== 'quoted-tool-call').length === excerpts.length && excerpts.every(excerpt => excerpt.end === excerpt.selectedEnd)
  if (!complete) limitations.push('Outward content is partial; read the exact native body entry for unshown ranges.')
  if (content.length === 0) limitations.push('No outward text/file/image body was supplied for this message; earlier assistant progress is not substituted.')
  const producer: Record<string, string | number | boolean> = { kind: event.type === 'assistant/message' ? 'model' : message.source.kind }
  for (const [key, value] of Object.entries(message.source)) if (key !== 'kind' && ['projectId', 'sessionId', 'senderSessionId', 'targetSessionId', 'deliveryId', 'hostSessionId', 'scheduleId', 'occurrenceId', 'plannedAt', 'trigger', 'provider', 'model', 'agentId', 'name', 'requestId', 'settlementId', 'questionId', 'invocationId'].includes(key)
    && (typeof value === 'string' && value.length <= 512 || typeof value === 'number' || typeof value === 'boolean')) producer[key] = value
  return { eventSeq: event.seq, time: event.time, producer, read: { action: 'read_content', source }, content, complete, limitations }
}

/** Reduce already bounded content while retaining exact selected and unread ranges. */
export function fitManagerInput(input: MainManagerInput, budget: number): MainManagerInput {
  let remaining = budget
  const message = (original: ManagerMessage): ManagerMessage => {
    const content = original.content.flatMap(excerpt => {
      const text = takePoints(excerpt.text, remaining), count = points(text); remaining -= count
      if (count === 0) return []
      const end = excerpt.range.start + count
      return [{ ...excerpt, text, range: { ...excerpt.range, end }, source: { ...excerpt.source, body: { ...excerpt.source.body!, range: { unit: 'unicode-code-points' as const, start: excerpt.range.start, end } } } }]
    })
    const complete = original.complete && content.length === original.content.length && content.every((part, index) => part.text === original.content[index]!.text)
    return { ...original, content, complete, limitations: complete ? original.limitations : [...original.limitations, 'Actual request capacity reduced outward body delivery; the exact source entry remains available.'] }
  }
  const currentInputs = input.currentInputs.map(message), replies = input.replies.map(turn => {
    const reply = turn.reply === undefined ? undefined : message(turn.reply)
    return { ...turn, ...(reply === undefined ? {} : { reply }), complete: turn.complete && (reply?.complete ?? false) }
  })
  return { ...input, currentInputs, replies, complete: input.complete && currentInputs.every(input => input.complete) && replies.every(reply => reply.complete) }
}
export function managerInputSources(input: MainManagerInput): NativeEventSource[] { return [...input.currentInputs, ...input.replies.flatMap(turn => turn.reply === undefined ? [] : [turn.reply])].flatMap(message => message.content.map(part => part.source)) }
function bodyPoints(message: ManagerMessage): number { return message.content.reduce((sum, part) => sum + points(part.text), 0) }

/** Check metadata/transport size before enqueue or serializing a whole result. */
export function assertManagerJsonBudget(value: unknown, maximum: number): void {
  let count = 0
  for (const chunk of canonicalChunks(value)) { count += points(chunk); if (count > maximum) throw new Error('Manager input/read metadata exceeds the finite transport budget.') }
}
function points(value: string): number { let size = 0; for (const _point of value) size++; return size }
function takePoints(value: string, maximum: number): string { let size = 0, end = 0; for (const point of value) { if (size++ >= maximum) break; end += point.length }; return value.slice(0, end) }
async function digest(value: unknown, signal?: AbortSignal): Promise<string> { const hash = createHash('sha256'); let chunks = 0; for (const chunk of canonicalChunks(value)) { signal?.throwIfAborted(); hash.update(chunk); if (++chunks % 64 === 0) await cooperate(signal) }; return 'sha256:' + hash.digest('hex') }
async function cooperate(signal?: AbortSignal): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); signal?.throwIfAborted() }
/** Same ordering/encoding as canonicalSourceJson, with bounded temporary strings. */
function* canonicalChunks(value: unknown): Generator<string> {
  if (typeof value === 'string') {
    yield '"'
    for (let start = 0; start < value.length;) { let end = Math.min(value.length, start + 1024); if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--; yield JSON.stringify(value.slice(start, end)).slice(1, -1); start = end }
    yield '"'; return
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') { yield JSON.stringify(value); return }
  if (Array.isArray(value)) { yield '['; for (const [index, entry] of value.entries()) { if (index !== 0) yield ','; yield* canonicalChunks(entry) }; yield ']'; return }
  if (typeof value !== 'object' || value === null) throw new Error('Manager source must be lossless JSON.')
  yield '{'
  const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  for (const [index, [key, entry]] of entries.entries()) { if (index !== 0) yield ','; yield JSON.stringify(key); yield ':'; yield* canonicalChunks(entry) }
  yield '}'
}
