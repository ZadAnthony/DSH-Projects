import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { sameOwnedCreationHeader } from '../../stock/control/identity.ts'
import type { ProjectDirectoryObservation } from '../../stock/read/index.ts'
import type { ProjectRecordLocator } from '../../stock/persistence/types.ts'
import { deriveProjectModelUsage } from './model-fold.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type {} from '@deepseek-ai/dsh-session-title-llm'
import { deriveTurnTokenUsage, deriveTurnTokenUsageDisclosure, deriveRequestTokenUsage, deriveRequestTokenUsageDisclosure } from './fold.ts'
import type { TurnTokenUsage, TurnTokenUsageDisclosure } from './fold.ts'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { AsyncLocalStorage } from 'node:async_hooks'
import { waitForUsageConsumer } from './cancellation.ts'
import { foldSubagentDescriptor, type SubagentCatalogEntry } from '@deepseek-ai/dsh-subagent'
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm/assistant-stream'

interface NativeSourceObservation {
  readonly header: SessionHeader
  readonly usage: NativeUsageRead
  readonly inherited: number
  readonly eventCount: number
  readonly children: readonly SubagentCatalogEntry[]
  readonly descriptorFact: { readonly count: number; readonly value?: Pick<NonNullable<ReturnType<typeof foldSubagentDescriptor>>, 'mode' | 'label' | 'provider'> }
  readonly revalidate: () => Promise<void>
}
interface ObservationEntry {
  readonly epoch: number
  readonly promise: Promise<NativeSourceObservation>
  readonly abort: AbortController
  consumers: number
  settled: boolean
}
const observationScope = new AsyncLocalStorage<WeakMap<Context, Map<string, ObservationEntry>>>()
const observers = new WeakMap<Context, { readonly epochs: Map<string, number>; readonly inflight: Map<string, ObservationEntry> }>()

/** Share narrow facts only for the lifetime of one query, including its lineage pass. */
export function withNativeUsageObservation<T>(action: () => Promise<T>): Promise<T> {
  return observationScope.run(new WeakMap(), action)
}

/** Internal same-source observation shared by the two native adapters. No body survives this fold. */
export async function readNativeUsageObservation(ctx: Context, id: string, now: () => number = Date.now, signal?: AbortSignal): Promise<NativeSourceObservation> {
  signal?.throwIfAborted()
  let observer = observers.get(ctx)
  if (observer === undefined) {
    observer = { epochs: new Map(), inflight: new Map() }
    const epochs = observer.epochs
    ctx.on('session/event', session => { const id = String(session.id); if (epochs.has(id)) epochs.set(id, epochs.get(id)! + 1) })
    const owned = observer
    ctx.effect(() => () => { owned.epochs.clear(); owned.inflight.clear() }, 'projects.usageDirectoryFacts')
    observers.set(ctx, observer)
  }
  const epoch = observer.epochs.get(id) ?? 0
  observer.epochs.set(id, epoch)
  const scope = observationScope.getStore()
  let local = scope?.get(ctx)
  if (scope !== undefined && local === undefined) { local = new Map(); scope.set(ctx, local) }
  let entry = local?.get(id)
  if (entry?.epoch !== epoch || entry.abort.signal.aborted) entry = observer.inflight.get(id)
  if (entry?.epoch !== epoch || entry.abort.signal.aborted) {
    const abort = new AbortController()
    const promise = (async () => {
      const result = await ctx.projectsRead.withDirectory(SessionId(id), async observation => {
        abort.signal.throwIfAborted()
        const { directory, cut } = observation
        if (String(directory.header.id) !== id || cut.journalIdentity !== directory.journalIdentity
          || cut.nextSeq !== directory.nextSeq || directory.records.length !== cut.nextSeq) throw new Error('PROJECT_USAGE_DIRECTORY_CUT_MISMATCH')
        const next = await foldUsageDirectory(observation)
        const usage: NativeUsageRead = next.turns === null ? { kind: 'unavailable', hostSessionId: id, observedAt: now(), reason: 'invalid-log' }
          : { kind: 'readable', hostSessionId: id, source: ctx.get('sessions')?.get(SessionId(id)) === undefined ? 'prepared' : 'live', observedAt: now(),
            lastEventAt: directory.records.at(-1)?.time ?? null, cursor: cut.nextSeq - 1,
            excludedInheritedEvents: Number(directory.inheritedEventCount), turns: next.turns, projection: null }
        return { header: directory.header, usage, inherited: Number(directory.inheritedEventCount), eventCount: cut.nextSeq,
          children: next.children, descriptorFact: next.descriptorFact, revalidate: observation.revalidate }
      }, { signal: abort.signal })
      abort.signal.throwIfAborted()
      return result
    })()
    entry = { epoch, promise, abort, consumers: 0, settled: false }
    observer.inflight.set(id, entry)
    const owned = entry, inflight = observer.inflight
    const done = () => { owned.settled = true; if (inflight.get(id) === owned) inflight.delete(id) }
    void promise.then(done, done)
  }
  local?.set(id, entry)
  const owned = entry
  owned.consumers += 1
  try {
    const result = await waitForUsageConsumer(owned.promise, signal)
    signal?.throwIfAborted()
    await result.revalidate()
    signal?.throwIfAborted()
    return result
  } finally {
    owned.consumers -= 1
    if (owned.consumers === 0 && !owned.settled) {
      // Only abandon this narrow consumer of ProjectsRead. Its shared source
      // owner still settles already-started I/O for other read responsibilities.
      owned.abort.abort()
      if (observer.inflight.get(id) === owned) observer.inflight.delete(id)
    }
  }
}

const counterKeys = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const
function select(data: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter(key => data[key] !== undefined).map(key => [key, data[key]]))
}
function counters(value: unknown): unknown {
  return value === undefined ? undefined : select(value as Record<string, unknown>, counterKeys)
}
/** Keep exactly the last cumulative usage sample used by the existing native fold. */
function usageStream(event: SessionEvent<'assistant/message'> | SessionEvent<'assistant/attempt'> | SessionEvent<'projects/assistant-progress'>): unknown[] {
  const sample = lastAssistantStreamChunk(event.data.stream, 'usage') as { usage?: unknown; partialUsage?: unknown; incompleteUsage?: readonly string[] } | undefined
  if (sample === undefined) return []
  return [{ type: 'chunk', time: event.time, chunk: { type: 'usage',
    ...sample.usage === undefined ? {} : { usage: counters(sample.usage) },
    ...sample.partialUsage === undefined ? {} : { partialUsage: counters(sample.partialUsage) },
    ...sample.incompleteUsage === undefined ? {} : { incompleteUsage: [...sample.incompleteUsage] } } }]
}
function narrowUsageEvent(event: SessionEvent): SessionEvent {
  const data = event.data as unknown as Record<string, unknown>
  let narrow: Record<string, unknown> = {}
  if (event.type === 'assistant/message' || event.type === 'assistant/attempt' || event.type === 'projects/assistant-progress') {
    narrow = { ...select(data, ['turn', 'step']), stream: usageStream(event) }
    if (event.type === 'assistant/message') narrow = { ...narrow, ...data.usage === undefined ? {} : { usage: counters(data.usage) },
      message: { source: select(event.data.message.source as unknown as Record<string, unknown>, ['provider', 'model']) } }
  } else if (event.type === 'projects/model-request-start') {
    narrow = select(data, ['requestId', 'attemptId', 'purpose', 'provider', 'model', 'turn', 'step', 'compactionId', 'sourceEventSeq'])
  } else if (event.type === 'projects/model-request-usage') {
    narrow = { ...select(data, ['requestId', 'attemptId', 'ordinal']), sample: {
      counters: counters(event.data.sample.counters), incomplete: [...event.data.sample.incomplete], reporter: event.data.sample.reporter } }
  } else if (event.type === 'projects/model-request-end') narrow = select(data, ['requestId', 'attemptId', 'outcome'])
  else if (event.type === 'compaction/summary') narrow = { ...select(data, ['compactionId', 'provider', 'model']), ...data.usage === undefined ? {} : { usage: counters(data.usage) } }
  else if (event.type === 'session/title-llm-request') narrow = { route: { ...event.data.route } }
  return { seq: event.seq, time: event.time, type: event.type, data: narrow } as SessionEvent
}
const readUsageTypes = new Set(['assistant/message', 'assistant/attempt', 'projects/assistant-progress', 'compaction/summary', 'session/title-llm-request'])
function metadataEvent(row: ProjectRecordLocator): SessionEvent {
  const data = select(row.facts, ['turn', 'step', 'compactionId'])
  // Validated native compaction envelopes have number|null turns; directory facts omit null.
  if ((row.type === 'compaction/start' || row.type === 'compaction/end') && data.turn === undefined) data.turn = null
  return { seq: row.seq, time: row.time, type: row.type, data } as SessionEvent
}
/** Append only new narrow facts; repeat queries do no event/body I/O or re-fold. */
async function foldUsageDirectory(observation: ProjectDirectoryObservation) {
  const { directory, readEvent } = observation
  const inherited = Number(directory.inheritedEventCount)
  const events: SessionEvent[] = []
  const children: SubagentCatalogEntry[] = []
  let descriptorFact: NativeSourceObservation['descriptorFact'] = { count: 0 }
  for (let seq = events.length; seq < directory.nextSeq; seq++) {
    const row = directory.records[seq]
    if (row === undefined || row.seq !== seq || !Number.isSafeInteger(row.time) || row.time < 0) throw new Error('PROJECT_USAGE_DIRECTORY_INVALID')
    const model = row.type.startsWith('projects/model-request-')
    const needsBody = model || seq >= inherited && (readUsageTypes.has(row.type) || row.type === 'subagent/catalog' || row.type === 'subagent/descriptor')
    let event = metadataEvent(row)
    if (needsBody) {
      const original = await readEvent(seq)
      if (original === undefined || original.seq !== seq || original.type !== row.type || original.time !== row.time) throw new Error('PROJECT_USAGE_RECORD_MISMATCH')
      event = narrowUsageEvent(original)
      if (seq >= inherited && original.type === 'subagent/catalog') {
        const data = original.data
        children.push({ id: data.childId, createdAt: data.childCreatedAt, mode: data.mode, ...data.label === undefined ? {} : { label: data.label } } as SubagentCatalogEntry)
      } else if (seq >= inherited && original.type === 'subagent/descriptor') {
        let value = descriptorFact.value
        if (descriptorFact.count === 0) {
          try { const descriptor = foldSubagentDescriptor([original]); if (descriptor !== undefined) value = { mode: descriptor.mode, label: descriptor.label, provider: descriptor.provider } }
          catch { /* Invalid description does not erase independently reported usage. */ }
        }
        descriptorFact = { count: descriptorFact.count + 1, ...value === undefined ? {} : { value } }
      }
    }
    events.push(event)
  }
  return { turns: deriveNativeUsageTurns(events, inherited), children, descriptorFact }
}

export interface NativeUsageTurn {
  /** 旧调用的缺省值为会话轮次；压缩独立计量，不能并入工作模型。 */
  readonly kind?: 'turn' | 'compaction' | 'title'
  readonly requestSeq?: number
  readonly compactionId?: string
  readonly turn: number | null
  readonly route?: { readonly provider: string; readonly model: string }
  readonly startedAt: number
  readonly endedAt: number | null
  readonly usage: TurnTokenUsage | null
  /** 已报小计与缺报共存；usage继续保留原精确轮次合同。 */
  readonly reportedUsage?: Pick<TurnTokenUsageDisclosure, 'reported' | 'missing' | 'routes'> & { readonly ended?: boolean }
  readonly reason?: 'incomplete-turn' | 'usage-unavailable' | 'inherited-boundary'
}

export type NativeUsageRead = {
  readonly kind: 'readable'
  readonly hostSessionId: string
  readonly source: 'live' | 'prepared'
  readonly observedAt: number
  readonly lastEventAt: number | null
  readonly cursor: number
  readonly excludedInheritedEvents: number
  readonly turns: readonly NativeUsageTurn[]
  readonly projection: TokenUsageProjection | null
} | {
  readonly kind: 'unavailable'
  readonly hostSessionId: string
  readonly observedAt: number
  readonly reason: 'not-found' | 'unreadable' | 'invalid-log'
}

/** 独立适配：只 observe 精确会话并释放 lease，不 resolve/wake Agent。 */
export function createNativeUsageReader(ctx: Context, now: () => number = Date.now) {
  return async (hostSessionId: string, expected?: SessionHeader, signal?: AbortSignal): Promise<NativeUsageRead> => {
    signal?.throwIfAborted()
    try {
      const projectRead = ctx.get('projectsRead')
      if (projectRead !== undefined) {
        const observation = await readNativeUsageObservation(ctx, hostSessionId, now, signal)
        if (expected !== undefined && !sameOwnedCreationHeader(observation.header, expected)) return { kind: 'unavailable', hostSessionId, observedAt: now(), reason: 'invalid-log' }
        return observation.usage
      }
      using observation = await ctx.sessionQuery.observeSession(SessionId(hostSessionId), { projectionMode: 'all', signal })
      signal?.throwIfAborted()
      if (String(observation.header.id) !== hostSessionId || (expected !== undefined && !sameOwnedCreationHeader(observation.header, expected))) {
        return { kind: 'unavailable', hostSessionId, observedAt: now(), reason: 'invalid-log' }
      }
      // prepared observation 没有标出内存补齐的边界。原生只读句柄返回真实存储前缀，
      // 不能用 turn/end 的类型、时间或 reason 猜哪条是合成事件。
      let events = observation.events
      let inherited = observation.inheritedEventCount
      if (observation.source === 'prepared') {
        const persistence = ctx.get('sessionPersistence')
        if (persistence === undefined) return { kind: 'unavailable', hostSessionId, observedAt: now(), reason: 'unreadable' }
        const handle = await persistence.open(SessionId(hostSessionId), 'read', { signal })
        try {
          if (String(handle.header.id) !== hostSessionId || (expected !== undefined && !sameOwnedCreationHeader(handle.header, expected))) return { kind: 'unavailable', hostSessionId, observedAt: now(), reason: 'invalid-log' }
          events = (await handle.read(0, undefined, { signal })).events
          signal?.throwIfAborted()
          inherited = handle.inheritedEventCount
        } finally { await handle.close() }
      }
      const turns = deriveNativeUsageTurns(events, inherited)
      if (turns === null) return { kind: 'unavailable', hostSessionId, observedAt: now(), reason: 'invalid-log' }
      // 冷读原始前缀与 prepared 投影可能不是同一时刻；不混接两次读取的累计。
      const projection = observation.source === 'live' ? observation.projections?.values.tokenUsage : undefined
      return {
        kind: 'readable', hostSessionId, source: observation.source, observedAt: now(),
        lastEventAt: events.at(-1)?.time ?? null, cursor: events.length - 1,
        excludedInheritedEvents: inherited,
        turns, projection: projection === undefined ? null : { ...projection },
      }
    } catch (error: unknown) {
      signal?.throwIfAborted()
      // 不将底层错误正文带到浏览器，避免把文件位置或提供方响应当作展示内容。
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      return { kind: 'unavailable', hostSessionId, observedAt: now(),
        reason: code === 'SESSION_QUERY_SESSION_NOT_FOUND' ? 'not-found' : 'unreadable' }
    }
  }
}

/** 分轮后复用 DSH 的 attempt/retry fold；辅助压缩另取其唯一 summary 报告。 */
export function deriveNativeUsageTurns(events: readonly SessionEvent[], inherited: number): NativeUsageTurn[] | null {
  if (!Number.isSafeInteger(inherited) || inherited < 0 || inherited > events.length) return null
  if (events.some((event, index) => event.seq !== index || !Number.isSafeInteger(event.time) || event.time < 0)) return null
  const turns: NativeUsageTurn[] = []
  let current: SessionEvent[] = []
  let partialInherited = false
  const finish = (ended: boolean): void => {
    if (current.length === 0) return
    const start = current[0]!
    const noAttempt = current[0]!.type === 'turn/start' && current.at(-1)!.type === 'turn/end'
      && current[0]!.data.turn === (current.at(-1)!.data as { turn: number }).turn
      && !current.some(event => event.type.startsWith('step/') || event.type.startsWith('assistant/') || event.type.startsWith('llm/retry'))
    const usage = ended && !partialInherited ? (!noAttempt ? deriveTurnTokenUsage(current) ?? null : {
      uncachedInputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0,
      cacheWriteTokens: 0, reasoningTokens: 0, routes: [],
    }) : null
    const reportedUsage = partialInherited || noAttempt ? undefined : deriveTurnTokenUsageDisclosure(current)
    turns.push({
      ...(reportedUsage === undefined ? {} : { reportedUsage }),
      turn: 'turn' in start.data ? Number(start.data.turn) : -1,
      startedAt: start.time, endedAt: ended ? current.at(-1)!.time : null, usage,
      ...(usage !== null ? {} : { reason: partialInherited ? 'inherited-boundary' as const
        : ended ? 'usage-unavailable' as const : 'incomplete-turn' as const }),
    })
    current = []; partialInherited = false
  }
  for (const event of events.slice(inherited)) {
    if (event.type === 'turn/start') { finish(false); current = [event]; continue }
    if (current.length === 0) {
      if (event.type === 'step/start' || event.type === 'assistant/message' || event.type === 'assistant/attempt') {
        current = [event]; partialInherited = inherited > 0
      }
      continue
    }
    current.push(event)
    if (event.type === 'turn/end') finish(true)
  }
  finish(false)
  const project = deriveProjectModelUsage(events, inherited)
  if (project === null) return null
  const auxiliary = deriveAuxiliaryUsage(events, inherited, project.compactions, project.titles)
  if (auxiliary === null) return null
  return [...turns.filter(turn => turn.turn === null || !project.turns.has(turn.turn)), ...auxiliary, ...project.rows]
}

/** Stock successful summaries remain readable; new gateway attempts replace the matching legacy source. */
function deriveAuxiliaryUsage(events: readonly SessionEvent[], inherited: number, capturedCompactions: ReadonlySet<string>, capturedTitles: ReadonlySet<number>): NativeUsageTurn[] | null {
  type Compaction = { start?: SessionEvent<'compaction/start'>; summary?: SessionEvent<'compaction/summary'>; end?: SessionEvent<'compaction/end'> }
  const compactions = new Map<string, Compaction>()
  for (const event of events) {
    if (event.type !== 'compaction/start' && event.type !== 'compaction/summary' && event.type !== 'compaction/end') continue
    const id = event.data.compactionId, compaction = compactions.get(id) ?? {}
    if (event.type === 'compaction/start') compaction.start ??= event
    else if (event.type === 'compaction/end') compaction.end ??= event
    else {
      if (compaction.summary !== undefined) return null
      compaction.summary = event
    }
    compactions.set(id, compaction)
  }
  const rows: NativeUsageTurn[] = []
  const emitted = new Set<string>()
  for (const event of events.slice(inherited)) {
    if (event.type === 'compaction/start' || event.type === 'compaction/summary' || event.type === 'compaction/end') {
      const id = event.data.compactionId
      if (capturedCompactions.has(id) || emitted.has(id)) continue
      const { start, summary, end } = compactions.get(id)!
      // Reported summaries own their row and report time, even without a successful end.
      // An inherited summary stays excluded when only its end belongs to this suffix.
      if (summary !== undefined && event !== summary) continue
      emitted.add(id)
      const partialInherited = start !== undefined && start.seq < inherited
      const route = summary?.data.provider && summary.data.model ? { provider: summary.data.provider, model: summary.data.model } : undefined
      const samples = summary?.data.usage === undefined ? [] : [{ usage: summary.data.usage }]
      const usage = partialInherited ? null : deriveRequestTokenUsage(samples, route) ?? null
      const reportedUsage = partialInherited ? undefined : deriveRequestTokenUsageDisclosure(samples, route)
      rows.push({ kind: 'compaction', compactionId: id, turn: start === undefined ? end?.data.turn ?? null : start.data.turn,
        startedAt: start?.time ?? event.time, endedAt: summary?.time ?? end?.time ?? null, usage,
        ...route === undefined ? {} : { route }, ...reportedUsage === undefined ? {} : { reportedUsage },
        ...usage !== null ? {} : { reason: partialInherited ? 'inherited-boundary' : end !== undefined || summary !== undefined ? 'usage-unavailable' : 'incomplete-turn' } })
    } else if (event.type === 'session/title-llm-request' && !capturedTitles.has(event.seq)) {
      rows.push({ kind: 'title', requestSeq: event.seq, turn: null, startedAt: event.time, endedAt: null,
        route: event.data.route, usage: null, reason: 'usage-unavailable' })
    }
  }
  return rows
}
