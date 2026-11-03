/* MIT; adapted from DSH 41.3 token-meter/src/turn-usage.ts; original base 639ed015397290b3745d163aafe02ffee4aa3f84. Local Projects accounting only. */
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { AssistantMessage, TokenUsage } from '@deepseek-ai/dsh-llm/types'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import '../../stock/recording/events.ts'
export interface RequestUsageSample { readonly usage?: TokenUsage; readonly partialUsage?: Partial<TokenUsage>; readonly incompleteUsage?: readonly (keyof TokenUsage)[] }

/** One provider/model route that contributed a billed request attempt. */
export interface TurnTokenUsageRoute {
  readonly provider: string
  readonly model: string
}

/** Exact provider-reported token accounting for every attempt in one completed Turn. */
export interface TurnTokenUsage {
  /** Sum of uncached prompt input across all attempts. */
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  /** Exact aggregate prompt plus output total across all attempts. */
  readonly totalTokens: number
  /** Present only when every attempt reported the bucket. */
  readonly cacheReadTokens?: number
  /** Present only when every attempt reported the bucket. */
  readonly cacheWriteTokens?: number
  /** Output subset, present only when every attempt reported it. */
  readonly reasoningTokens?: number
  /** Present only when every billed attempt has provider/model attribution. */
  readonly routes?: readonly TurnTokenUsageRoute[]
}

export type TurnTokenUsageMetric = Exclude<keyof TurnTokenUsage, 'routes'>

/** Reported subtotals and remaining gaps from one durable Turn prefix. */
export interface TurnTokenUsageDisclosure {
  readonly reported: Readonly<Partial<Record<TurnTokenUsageMetric, number>>>
  /** A metric may be both reported and missing within the same Turn. */
  readonly missing: readonly TurnTokenUsageMetric[]
  /** A real turn/end and settled step lifecycle, independent of usage availability. */
  readonly ended: boolean
  /** Attribution stays conservative across every observed attempt. */
  readonly routes?: readonly TurnTokenUsageRoute[]
}

/** Counters and gaps in one actual auxiliary request's cumulative report. */
export interface RequestTokenUsageDisclosure {
  readonly reported: Readonly<Partial<Record<TurnTokenUsageMetric, number>>>
  readonly missing: readonly TurnTokenUsageMetric[]
  readonly routes?: readonly TurnTokenUsageRoute[]
}

interface NormalizedAttempt {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
  readonly route?: TurnTokenUsageRoute
  readonly incomplete: readonly (keyof TokenUsage)[]
}

interface UsageSample {
  readonly usage: Partial<TokenUsage>
  readonly incomplete: readonly (keyof TokenUsage)[]
}

type AttemptState =
  | { readonly kind: 'idle' }
  | {
    readonly kind: 'open'
    readonly turn: number
    readonly step: number
    readonly sample?: UsageSample
  }
  | {
    readonly kind: 'finishClosed'
    readonly turn: number
    readonly step: number
  }
  | {
    readonly kind: 'settled'
    readonly turn: number
    readonly step: number
    readonly by: 'message' | 'retry'
  }

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function safeSum(values: readonly number[]): number | undefined {
  let total = 0
  for (const value of values) {
    total += value
    if (!Number.isSafeInteger(total)) return undefined
  }
  return total
}

function messageRoute(message: AssistantMessage): TurnTokenUsageRoute | undefined {
  const { provider, model } = message.source
  return provider.length > 0 && model.length > 0 ? { provider, model } : undefined
}

function streamUsage(stream: SessionEvent<'assistant/message'>['data']['stream']): UsageSample | undefined {
  const chunk = lastAssistantStreamChunk(stream, 'usage') as RequestUsageSample | undefined
  const usage = chunk?.usage ?? chunk?.partialUsage
  return usage === undefined ? undefined : { usage, incomplete: chunk?.incompleteUsage ?? [] }
}

function normalizeUsage(sample: UsageSample, route?: TurnTokenUsageRoute, allowMissing = false): NormalizedAttempt | undefined {
  const { usage, incomplete } = sample
  const {
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens,
  } = usage
  if (!allowMissing && (!isCount(inputTokens) || !isCount(outputTokens) || incomplete.length > 0)) return undefined
  for (const value of [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens]) {
    if (value !== undefined && !isCount(value)) return undefined
  }
  if (incomplete.some(key => usage[key] === undefined)) return undefined
  if (reasoningTokens !== undefined && outputTokens !== undefined && reasoningTokens > outputTokens) return undefined

  const knownPrompt = safeSum([
    ...inputTokens === undefined ? [] : [inputTokens],
    ...cacheReadTokens === undefined ? [] : [cacheReadTokens],
    ...cacheWriteTokens === undefined ? [] : [cacheWriteTokens],
  ])
  let exactTotal: number | undefined
  if (totalTokens !== undefined) {
    const knownTotal = knownPrompt === undefined ? undefined : safeSum([knownPrompt, outputTokens ?? 0])
    if (knownTotal === undefined || totalTokens < knownTotal) return undefined
    if (inputTokens !== undefined && outputTokens !== undefined
      && cacheReadTokens !== undefined && cacheWriteTokens !== undefined && totalTokens !== knownTotal) return undefined
    exactTotal = totalTokens
  } else if (knownPrompt !== undefined && inputTokens !== undefined && outputTokens !== undefined
    && cacheReadTokens !== undefined && cacheWriteTokens !== undefined && incomplete.length === 0) {
    exactTotal = safeSum([knownPrompt, outputTokens])
  }
  if (!allowMissing && exactTotal === undefined) return undefined

  return {
    ...inputTokens === undefined ? {} : { inputTokens },
    ...outputTokens === undefined ? {} : { outputTokens },
    ...exactTotal === undefined ? {} : { totalTokens: exactTotal },
    ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
    ...cacheWriteTokens === undefined ? {} : { cacheWriteTokens },
    ...reasoningTokens === undefined ? {} : { reasoningTokens },
    ...route === undefined ? {} : { route },
    incomplete,
  }
}

function aggregateAttempts(attempts: readonly NormalizedAttempt[]): TurnTokenUsage | undefined {
  if (attempts.length === 0) return undefined
  const inputs = attempts.map(attempt => attempt.inputTokens)
  const outputs = attempts.map(attempt => attempt.outputTokens)
  const inputTokens = inputs.every(isCount) ? safeSum(inputs) : undefined
  const outputTokens = outputs.every(isCount) ? safeSum(outputs) : undefined
  const totals = attempts.map(attempt => attempt.totalTokens)
  const totalTokens = totals.every(isCount) ? safeSum(totals) : undefined
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) return undefined

  const cacheRead = attempts.map(attempt => attempt.cacheReadTokens)
  const cacheWrite = attempts.map(attempt => attempt.cacheWriteTokens)
  const reasoning = attempts.map(attempt => attempt.reasoningTokens)
  const cacheReadTokens = cacheRead.every(isCount) ? safeSum(cacheRead) : undefined
  const cacheWriteTokens = cacheWrite.every(isCount) ? safeSum(cacheWrite) : undefined
  const reasoningTokens = reasoning.every(isCount) ? safeSum(reasoning) : undefined
  // A present cache bucket is bounded by exact prompt, and reasoning is bounded
  // by output. Safe required aggregates therefore imply safe optional sums.

  let routes: readonly TurnTokenUsageRoute[] | undefined
  const attributed = attempts.map(attempt => attempt.route)
  if (attributed.every((route): route is TurnTokenUsageRoute => route !== undefined)) {
    const unique = new Map<string, TurnTokenUsageRoute>()
    for (const route of attributed) unique.set(`${route.provider}\0${route.model}`, route)
    routes = [...unique.values()]
  }

  return {
    uncachedInputTokens: inputTokens,
    outputTokens,
    totalTokens,
    ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
    ...cacheWriteTokens === undefined ? {} : { cacheWriteTokens },
    ...reasoningTokens === undefined ? {} : { reasoningTokens },
    ...routes === undefined ? {} : { routes },
  }
}

function sameAttempt(
  state: Exclude<AttemptState, { kind: 'idle' }>,
  turn: number,
  step: number,
): boolean {
  return state.turn === turn && state.step === step
}

/**
 * Fold one complete Turn's durable attempt lifecycle into exact token accounting.
 *
 * No attempt is inferred from a usage sample. Any missing lifecycle boundary,
 * incomplete attempt usage, unsafe count, or contradictory exact total makes
 * the whole disclosure unavailable.
 * @param events - Turn-local durable events from `turn/start` through `turn/end`.
 * @returns exact aggregate usage, or undefined when it cannot be proven.
 */
export function deriveTurnTokenUsage(events: readonly SessionEvent[]): TurnTokenUsage | undefined {
  const folded = foldTurnUsage(events, false)
  return folded === undefined || !folded.ended
    || !folded.attempts.every((attempt): attempt is NormalizedAttempt => attempt !== undefined)
    ? undefined : aggregateAttempts(folded.attempts)
}

const metricKeys: readonly TurnTokenUsageMetric[] = [
  'uncachedInputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens',
]

/**
 * Normalize one cumulative provider sample without inventing a Turn lifecycle.
 * @param samples - cumulative reports accepted by the original receiver, in stream order.
 * @param route - exact provider/model supplied to that request.
 * @returns complete accounting, or undefined when required counters are unknown or invalid.
 */
export function deriveRequestTokenUsage(samples: readonly RequestUsageSample[], route?: TurnTokenUsageRoute): TurnTokenUsage | undefined {
  const sample = samples.at(-1)
  if (sample === undefined) return undefined
  const usage = sample.usage ?? sample.partialUsage
  if (usage === undefined) return undefined
  const normalized = normalizeUsage({ usage, incomplete: sample.incompleteUsage ?? [] }, route)
  return normalized === undefined ? undefined : aggregateAttempts([normalized])
}

/**
 * Preserve reported counters independently of output acceptance and missing buckets.
 * @param samples - cumulative reports; absent later counters retain earlier subtotals with a gap.
 * @param route - exact provider/model supplied to that request.
 * @returns validated reported counters and gaps, or undefined when no valid counter was reported.
 */
export function deriveRequestTokenUsageDisclosure(samples: readonly RequestUsageSample[], route?: TurnTokenUsageRoute): RequestTokenUsageDisclosure | undefined {
  const reported: Partial<Record<TurnTokenUsageMetric, number>> = {}
  let missing: TurnTokenUsageMetric[] = [...metricKeys]
  let valid = false
  for (const sample of samples) {
    const usage = sample.usage ?? sample.partialUsage
    const normalized = usage === undefined ? undefined : normalizeUsage({ usage, incomplete: sample.incompleteUsage ?? [] }, route, true)
    missing = []
    for (const key of metricKeys) {
      const nativeKey = key === 'uncachedInputTokens' ? 'inputTokens' : key
      const value = normalized?.[nativeKey]
      if (value !== undefined) { reported[key] = value; valid = true }
      if (value === undefined || normalized?.incomplete.includes(nativeKey)) missing.push(key)
    }
  }
  return valid ? { reported, missing, ...(route === undefined ? {} : { routes: [route] }) } : undefined
}

/**
 * Disclose settled provider reports without requiring every attempt or the Turn to finish.
 * Missing/invalid reports and an open suffix remain gaps; no consumption is estimated.
 * @param events - Durable events beginning at a real turn/start, possibly an unfinished prefix.
 * @returns Reported subtotals plus per-metric gaps, or undefined for contradictory lifecycle evidence.
 */
export function deriveTurnTokenUsageDisclosure(events: readonly SessionEvent[]): TurnTokenUsageDisclosure | undefined {
  const folded = foldTurnUsage(events, true)
  if (folded === undefined) return undefined
  const reported: Partial<Record<TurnTokenUsageMetric, number>> = {}
  const missing: TurnTokenUsageMetric[] = []
  for (const key of metricKeys) {
    const values = folded.attempts.map(attempt => attempt?.[key === 'uncachedInputTokens' ? 'inputTokens' : key])
    const known = values.filter(isCount)
    const total = known.length === 0 ? undefined : safeSum(known)
    if (total !== undefined) reported[key] = total
    const nativeKey = key === 'uncachedInputTokens' ? 'inputTokens' : key
    if (!folded.ended || total === undefined || values.some(value => value === undefined)
      || folded.attempts.some(attempt => attempt?.incomplete.includes(nativeKey))) missing.push(key)
  }
  const attributed = folded.attempts.map(attempt => attempt?.route)
  const routes = folded.ended && attributed.length > 0 && attributed.every((route): route is TurnTokenUsageRoute => route !== undefined)
    ? [...new Map(attributed.map(route => [`${route.provider}\0${route.model}`, route])).values()] : undefined
  return { reported, missing, ended: folded.ended, ...routes === undefined ? {} : { routes } }
}

/** Both disclosures share the same attempt/retry identity and settlement rules. */
function foldTurnUsage(events: readonly SessionEvent[], allowMissingUsage: boolean): {
  readonly attempts: readonly (NormalizedAttempt | undefined)[]
  readonly ended: boolean
} | undefined {
  let state: AttemptState = { kind: 'idle' }
  const attempts: (NormalizedAttempt | undefined)[] = []
  let turn: number | undefined
  let sawEnd = false
  let invalid = false

  const closeOpen = (route?: TurnTokenUsageRoute): boolean => {
    if (state.kind !== 'open') return false
    const normalized = state.sample === undefined ? undefined : normalizeUsage(state.sample, route, allowMissingUsage)
    if (normalized === undefined && !allowMissingUsage) return false
    attempts.push(normalized)
    return true
  }

  for (const event of events) {
    if (invalid) break
    if (event.type === 'turn/start') {
      if (turn !== undefined || state.kind !== 'idle') invalid = true
      else turn = event.data.turn
      continue
    }
    if (turn === undefined) {
      invalid = true
      break
    }
    if (event.type === 'turn/end') {
      if (event.data.turn !== turn || state.kind !== 'idle' || sawEnd) invalid = true
      else sawEnd = true
      continue
    }
    if (sawEnd) {
      invalid = true
      break
    }
    if (event.type === 'step/start') {
      if (event.data.turn !== turn || state.kind !== 'idle') invalid = true
      else state = { kind: 'open', turn, step: event.data.step }
      continue
    }
    if (event.type === 'llm/retry-started') {
      if (event.data.turn !== turn
        || state.kind !== 'settled'
        || state.by !== 'retry'
        || !sameAttempt(state, event.data.turn, event.data.step)) invalid = true
      else state = { kind: 'open', turn, step: event.data.step }
      continue
    }
    if (event.type === 'projects/assistant-progress') {
      if (event.data.turn !== turn || state.kind !== 'open'
        || !sameAttempt(state, event.data.turn, event.data.step)) {
        invalid = true
        continue
      }
      const sample = streamUsage(event.data.stream)
      if (sample !== undefined) state = { ...state, sample }
      continue
    }
    if (event.type === 'assistant/attempt') {
      if (event.data.turn !== turn
        || state.kind !== 'open'
        || !sameAttempt(state, event.data.turn, event.data.step)) {
        invalid = true
        continue
      }
      const sample: UsageSample | undefined = streamUsage(event.data.stream) ?? state.sample
      state = { kind: 'open', turn, step: event.data.step, ...(sample === undefined ? {} : { sample }) }
      if (!closeOpen()) invalid = true
      else state = { kind: 'finishClosed', turn, step: event.data.step }
      continue
    }
    if (event.type === 'assistant/message') {
      if (event.data.turn !== turn
        || state.kind !== 'open'
        || !sameAttempt(state, event.data.turn, event.data.step)) {
        invalid = true
        continue
      }
      const sample = event.data.usage === undefined ? streamUsage(event.data.stream)
        : { usage: event.data.usage, incomplete: [] }
      if (sample !== undefined) state = { ...state, sample }
      if (!closeOpen(messageRoute(event.data.message))) invalid = true
      else state = { kind: 'settled', turn, step: event.data.step, by: 'message' }
      continue
    }
    if (event.type === 'llm/retry') {
      if (event.data.turn !== turn || state.kind === 'idle'
        || !sameAttempt(state, event.data.turn, event.data.step)) {
        invalid = true
        continue
      }
      if (state.kind === 'settled' || (state.kind === 'open' && !closeOpen())) invalid = true
      if (!invalid) state = { kind: 'settled', turn, step: event.data.step, by: 'retry' }
      continue
    }
    if (event.type === 'step/end') {
      if (event.data.turn !== turn || state.kind === 'idle'
        || !sameAttempt(state, event.data.turn, event.data.step)) {
        invalid = true
        continue
      }
      if (state.kind === 'open' && !closeOpen()) invalid = true
      if (!invalid) state = { kind: 'idle' }
    }
  }

  if (allowMissingUsage && !invalid && state.kind === 'open' && state.sample !== undefined) {
    attempts.push(normalizeUsage(state.sample, undefined, true))
  }
  return invalid || turn === undefined ? undefined : { attempts, ended: sawEnd && state.kind === 'idle' }
}
