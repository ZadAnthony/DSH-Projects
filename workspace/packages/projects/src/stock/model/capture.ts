/** Per-call raw report receiver; no provider state or root Context is global. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ProjectUsageSample } from './schema.ts'
import type { LlmImageRequestPricing } from '@deepseek-ai/dsh-llm'

export interface ProjectCallIdentity {
  readonly dispatchId?: string
  readonly attemptId?: string
  readonly role: 'work' | 'memory' | 'manager'
  readonly turn?: number
  readonly step?: number
  readonly attempt?: number
}
const calls = new AsyncLocalStorage<{ agent: Agent; identity: ProjectCallIdentity }>()
const receivers = new AsyncLocalStorage<(sample: ProjectUsageSample) => void>()
const preparationPricing = new AsyncLocalStorage<(images: LlmImageRequestPricing) => void>()
/** Exact-model catalog lookup may change image capability before the prepared adapter returns. */
export function withProjectPreparedImagePricing<T>(receive: (images: LlmImageRequestPricing) => void, action: () => T): T { return preparationPricing.run(receive, action) }
export function captureProjectPreparedImagePricing(images: LlmImageRequestPricing): void { preparationPricing.getStore()?.(images) }
/** W3 holds this through actual stream iteration, not merely generator construction. */
export function withProjectCallIdentity<T>(agent: Agent, identity: ProjectCallIdentity, action: () => T): T {
  return calls.run({ agent, identity: Object.freeze({ ...identity }) }, action)
}
export function currentProjectCallIdentity() { return calls.getStore() }
export function withProjectUsageReceiver<T>(receiver: (sample: ProjectUsageSample) => void, action: () => T): T { return receivers.run(receiver, action) }
export function captureProjectUsage(sample: ProjectUsageSample): void { receivers.getStore()?.(structuredClone(sample)) }
/** The private SDK calls this before its own normalization can invent zeros. */
export function capturePiUsage(usage: { reported?: Record<string, number>; incomplete?: readonly string[] }, raw?: ProjectUsageSample['raw']): void {
  if (usage.reported === undefined) return
  const mapping = { input: 'inputTokens', output: 'outputTokens', totalTokens: 'totalTokens', cacheRead: 'cacheReadTokens', cacheWrite: 'cacheWriteTokens', reasoning: 'reasoningTokens' } as const
  const counters: ProjectUsageSample['counters'] = {}
  for (const [source, target] of Object.entries(mapping)) {
    const value = usage.reported[source]
    if (value !== undefined && Number.isSafeInteger(value) && value >= 0) counters[target] = value
  }
  if (Object.keys(counters).length === 0 && raw === undefined) return
  captureProjectUsage({ counters, incomplete: Object.entries(mapping).filter(([key]) => usage.incomplete?.includes(key)).map(([, key]) => key), reporter: 'provider', ...raw === undefined ? {} : { raw } })
}

import type { PreparedLlmCall } from '@deepseek-ai/dsh-llm'
const preparedFacts = new WeakMap<PreparedLlmCall, { generation: string; images?: LlmImageRequestPricing }>()
export function preparedProjectImagePricing(prepared: PreparedLlmCall): LlmImageRequestPricing | undefined { return preparedFacts.get(prepared)?.images }
export function preparedProjectConfigurationGeneration(prepared: PreparedLlmCall): string | undefined { return preparedFacts.get(prepared)?.generation }
export function bindProjectPreparedFacts(prepared: PreparedLlmCall, facts: { generation: string; images?: LlmImageRequestPricing }): void { preparedFacts.set(prepared, facts) }
