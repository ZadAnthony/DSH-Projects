/** Fold the gateway's one-owner cumulative reports; assistant output is never billed twice. */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { NativeUsageTurn } from './native.ts'
import { deriveRequestTokenUsage, deriveRequestTokenUsageDisclosure, type RequestUsageSample, type TurnTokenUsage, type TurnTokenUsageDisclosure, type TurnTokenUsageMetric } from './fold.ts'
import type { ProjectModelIdentity, ProjectUsageSample } from '../../stock/model/schema.ts'
import '../../stock/model/schema.ts'

interface Attempt { start: SessionEvent<'projects/model-request-start'>; samples: ProjectUsageSample[]; end?: SessionEvent<'projects/model-request-end'>; ordinal: number }
const metrics: readonly TurnTokenUsageMetric[] = ['uncachedInputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
function sample(value: ProjectUsageSample): RequestUsageSample { return { partialUsage: value.counters, incompleteUsage: value.incomplete } }
export function deriveProjectModelUsage(events: readonly SessionEvent[], inherited: number): { rows: NativeUsageTurn[]; turns: ReadonlySet<number>; compactions: ReadonlySet<string>; titles: ReadonlySet<number> } | null {
  const requests = new Map<string, Attempt>()
  const turnStarts = new Map<number, SessionEvent<'turn/start'>>()
  const turnEnds = new Map<number, SessionEvent<'turn/end'>>()
  for (const event of events) {
    if (event.type === 'turn/start') turnStarts.set(event.data.turn, event)
    else if (event.type === 'turn/end') turnEnds.set(event.data.turn, event)
    else if (event.type === 'projects/model-request-start') {
      if (requests.has(event.data.attemptId)) return null
      requests.set(event.data.attemptId, { start: event, samples: [], ordinal: 0 })
    } else if (event.type === 'projects/model-request-usage' || event.type === 'projects/model-request-end') {
      const request = requests.get(event.data.attemptId)
      if (request === undefined || request.start.data.requestId !== event.data.requestId || request.end !== undefined) return null
      if (event.type === 'projects/model-request-usage') {
        if (event.data.ordinal !== request.ordinal++) return null
        request.samples.push(event.data.sample)
      } else request.end = event
    }
  }
  const grouped = new Map<string, Attempt[]>()
  const turns = new Set<number>(), compactions = new Set<string>(), titles = new Set<number>()
  for (const request of requests.values()) {
    if (request.start.seq < inherited) continue
    const identity = request.start.data
    if (identity.purpose === 'conversation' && identity.turn !== undefined) turns.add(identity.turn)
    if (identity.compactionId !== undefined) compactions.add(identity.compactionId)
    if (identity.purpose === 'session-title' && identity.sourceEventSeq !== undefined) titles.add(identity.sourceEventSeq)
    const key = identity.purpose === 'conversation' && identity.turn !== undefined ? `turn:${identity.turn}` : request.start.data.attemptId
    const entries = grouped.get(key) ?? []; entries.push(request); grouped.set(key, entries)
  }
  const rows: NativeUsageTurn[] = []
  for (const attempts of grouped.values()) {
    const first = attempts[0]!, identity: ProjectModelIdentity = first.start.data
    // A provider request can settle before tools and the enclosing Turn finish.
    // Standalone requests without a Turn identity retain their request lifecycle.
    const conversationTurn = identity.purpose === 'conversation' ? identity.turn : undefined
    const candidateEnd = conversationTurn === undefined ? undefined : turnEnds.get(conversationTurn)
    const turnEnd = candidateEnd !== undefined && candidateEnd.seq > first.start.seq ? candidateEnd : undefined
    const disclosures = attempts.map(attempt => deriveRequestTokenUsageDisclosure(attempt.samples.map(sample), { provider: attempt.start.data.provider, model: attempt.start.data.model }))
    const reported: Partial<Record<TurnTokenUsageMetric, number>> = {}, missing: TurnTokenUsageMetric[] = []
    const settled = attempts.every(attempt => attempt.end !== undefined)
    const ended = settled && (conversationTurn === undefined || turnEnd !== undefined)
    for (const key of metrics) {
      const values = disclosures.map(disclosure => disclosure?.reported[key])
      const known = values.filter((value): value is number => value !== undefined)
      const total = known.reduce((sum, value) => sum + value, 0)
      if (known.length > 0 && Number.isSafeInteger(total)) reported[key] = total
      if (!ended || known.length !== attempts.length || !Number.isSafeInteger(total) || disclosures.some(disclosure => disclosure?.missing.includes(key))) missing.push(key)
    }
    const routes = [...new Map(attempts.map(attempt => [`${attempt.start.data.provider}\0${attempt.start.data.model}`, { provider: attempt.start.data.provider, model: attempt.start.data.model }])).values()]
    const exact = attempts.map(attempt => deriveRequestTokenUsage(attempt.samples.map(sample), { provider: attempt.start.data.provider, model: attempt.start.data.model }))
    let usage: TurnTokenUsage | null = null
    if (ended && exact.every((value): value is TurnTokenUsage => value !== undefined)
      && reported.uncachedInputTokens !== undefined && reported.outputTokens !== undefined && reported.totalTokens !== undefined) {
      usage = { uncachedInputTokens: reported.uncachedInputTokens, outputTokens: reported.outputTokens, totalTokens: reported.totalTokens, routes,
        ...reported.cacheReadTokens === undefined || missing.includes('cacheReadTokens') ? {} : { cacheReadTokens: reported.cacheReadTokens },
        ...reported.cacheWriteTokens === undefined || missing.includes('cacheWriteTokens') ? {} : { cacheWriteTokens: reported.cacheWriteTokens },
        ...reported.reasoningTokens === undefined || missing.includes('reasoningTokens') ? {} : { reasoningTokens: reported.reasoningTokens } }
    }
    const last = attempts.map(attempt => attempt.end).filter((event): event is SessionEvent<'projects/model-request-end'> => event !== undefined).at(-1)
    const endedAt = conversationTurn === undefined ? settled ? last!.time : null : turnEnd?.time ?? null
    const disclosure: TurnTokenUsageDisclosure = { reported, missing, ended, routes }
    rows.push({ kind: identity.purpose === 'session-title' ? 'title' : identity.purpose === 'compaction' ? 'compaction' : 'turn',
      requestSeq: first.start.seq, ...(identity.compactionId === undefined ? {} : { compactionId: identity.compactionId }), turn: identity.turn ?? null,
      startedAt: (conversationTurn === undefined ? undefined : turnStarts.get(conversationTurn)?.time) ?? first.start.time,
      endedAt, usage, reportedUsage: disclosure,
      ...routes.length === 1 ? { route: routes[0]! } : {},
      ...usage !== null ? {} : { reason: endedAt === null ? 'incomplete-turn' : 'usage-unavailable' } })
  }
  return { rows, turns, compactions, titles }
}
