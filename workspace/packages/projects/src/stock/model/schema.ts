/** Model accounting belongs to the same exact carrier journal as its request. */
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectSchemaPersistence } from '../request/dispatch.ts'

export const usageMetrics = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const
export type ProjectUsageMetric = typeof usageMetrics[number]
export interface ProjectUsageSample {
  readonly counters: Partial<Record<ProjectUsageMetric, number>>
  readonly incomplete: readonly ProjectUsageMetric[]
  readonly reporter: 'provider' | 'host-normalized'
  /** Numeric fields exactly present in the transport usage object, including fields that cannot safely become an uncached subtotal. */
  readonly raw?: { readonly protocol: string; readonly values: Readonly<Record<string, number>> }
}
export interface ProjectModelIdentity {
  readonly requestId: string
  readonly attemptId: string
  readonly projectId: string
  readonly logicalSessionId: string
  readonly carrierId: string
  readonly carrierCreatedAt: number
  readonly role: 'work' | 'memory' | 'manager'
  readonly purpose: 'conversation' | 'session-title' | 'compaction'
  readonly provider: string
  readonly model: string
  readonly configurationGeneration: string
  readonly turn?: number
  readonly step?: number
  readonly dispatchSeq?: SessionSeq
  readonly compactionId?: string
  readonly sourceEventSeq?: SessionSeq
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'projects/model-request-start': ProjectModelIdentity
    'projects/model-request-usage': { readonly requestId: string; readonly attemptId: string; readonly ordinal: number; readonly sample: ProjectUsageSample }
    'projects/model-request-end': { readonly requestId: string; readonly attemptId: string; readonly outcome: 'completed' | 'failed' | 'cancelled' | 'consumer-closed' }
  }
}
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Model journal event must be an object')
  const data = value as Record<string, unknown>
  if (required.some(key => !Object.hasOwn(data, key)) || Object.keys(data).some(key => !required.includes(key) && !optional.includes(key))) throw new TypeError('Model journal event has invalid fields')
  return data
}
const text = (value: unknown) => typeof value === 'string' && value.length > 0
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0
const validators: Record<`projects/${string}`, (value: unknown) => void> = {
  'projects/model-request-start': value => {
    const data = object(value, ['requestId', 'attemptId', 'projectId', 'logicalSessionId', 'carrierId', 'carrierCreatedAt', 'role', 'purpose', 'provider', 'model', 'configurationGeneration'], ['turn', 'step', 'dispatchSeq', 'compactionId', 'sourceEventSeq'])
    if (['requestId', 'attemptId', 'projectId', 'logicalSessionId', 'carrierId', 'provider', 'model', 'configurationGeneration'].some(key => !text(data[key])) || !count(data.carrierCreatedAt)
      || !['work', 'memory', 'manager'].includes(String(data.role)) || !['conversation', 'session-title', 'compaction'].includes(String(data.purpose))
      || ['turn', 'step', 'dispatchSeq', 'sourceEventSeq'].some(key => data[key] !== undefined && !count(data[key]))) throw new TypeError('Invalid model request identity')
    if (data.compactionId !== undefined && !text(data.compactionId)) throw new TypeError('Invalid compaction identity')
  },
  'projects/model-request-usage': value => {
    const data = object(value, ['requestId', 'attemptId', 'ordinal', 'sample'])
    if (!text(data.requestId) || !text(data.attemptId) || !count(data.ordinal)) throw new TypeError('Invalid model usage identity')
    const sample = object(data.sample, ['counters', 'incomplete', 'reporter'], ['raw'])
    const counters = object(sample.counters, [], usageMetrics)
    if (!['provider', 'host-normalized'].includes(String(sample.reporter)) || Object.values(counters).some(value => !count(value))
      || !Array.isArray(sample.incomplete) || sample.incomplete.some(key => !usageMetrics.includes(key)) || new Set(sample.incomplete).size !== sample.incomplete.length) throw new TypeError('Invalid provider usage sample')
    if (sample.raw !== undefined) {
      const raw = object(sample.raw, ['protocol', 'values'])
      if (!text(raw.protocol) || raw.values === null || typeof raw.values !== 'object' || Array.isArray(raw.values)
        || Object.entries(raw.values).some(([key, value]) => !text(key) || !count(value))) throw new TypeError('Invalid raw provider usage report')
    }
  },
  'projects/model-request-end': value => {
    const data = object(value, ['requestId', 'attemptId', 'outcome'])
    if (!text(data.requestId) || !text(data.attemptId) || !['completed', 'failed', 'cancelled', 'consumer-closed'].includes(String(data.outcome))) throw new TypeError('Invalid model request settlement')
  },
}
export function installProjectModelSchemas(persistence: ProjectSchemaPersistence): void {
  for (const [type, validate] of Object.entries(validators)) persistence.registerProjectEventSchema(type as `projects/${string}`, validate)
}
