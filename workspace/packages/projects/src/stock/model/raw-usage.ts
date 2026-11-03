/** Private SDK transport taps. Never infer a missing provider field from SDK zero defaults. */
import { capturePiUsage } from './capture.ts'
import type { ProjectUsageSample } from './schema.ts'

type PiReported = Partial<Record<'input' | 'output' | 'totalTokens' | 'cacheRead' | 'cacheWrite' | 'reasoning', number>>
interface UsageOwner { reported?: PiReported; incomplete?: string[] }
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
function numericFields(value: unknown, prefix = '', depth = 0): [string, number][] {
  if (depth > 4 || value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return count(child) ? [[path, child] as [string, number]] : numericFields(child, path, depth + 1)
  })
}
function report(owner: UsageOwner, reported: PiReported, protocol: string, raw: unknown, incomplete: string[] = []): void {
  const wire = rawProviderUsage(protocol, raw)
  owner.reported = reported; owner.incomplete = incomplete
  capturePiUsage(owner, wire)
}
export function rawProviderUsage(protocol: string, raw: unknown): NonNullable<ProjectUsageSample['raw']> { return { protocol, values: Object.fromEntries(numericFields(raw)) } }
export function capturePiWireUsage(owner: UsageOwner, protocol: string, raw: unknown): void { capturePiUsage(owner, rawProviderUsage(protocol, raw)) }
export function reportGoogleUsage(owner: UsageOwner, raw: Record<string, unknown>): void {
  const values: PiReported = {}, incomplete: string[] = []
  const prompt = raw.promptTokenCount, cached = raw.cachedContentTokenCount, output = raw.candidatesTokenCount, thinking = raw.thoughtsTokenCount
  if (count(prompt) && count(cached) && cached <= prompt) values.input = prompt - cached
  if (count(cached)) values.cacheRead = cached
  if (count(output)) {
    values.output = output + (count(thinking) ? thinking : 0)
    if (!count(thinking)) incomplete.push('output')
  }
  if (count(thinking)) values.reasoning = thinking
  if (count(raw.totalTokenCount)) values.totalTokens = raw.totalTokenCount
  report(owner, values, 'google-usage-metadata', raw, incomplete)
}
export function reportBedrockUsage(owner: UsageOwner, raw: Record<string, unknown>): void {
  const values: PiReported = {}
  const fields = { inputTokens: 'input', outputTokens: 'output', totalTokens: 'totalTokens', cacheReadInputTokens: 'cacheRead', cacheWriteInputTokens: 'cacheWrite' } as const
  for (const [key, target] of Object.entries(fields)) if (count(raw[key])) values[target] = raw[key]
  report(owner, values, 'bedrock-converse-metadata', raw)
}
export function reportMistralUsage(owner: UsageOwner, raw: Record<string, unknown>): void {
  const values: PiReported = {}, nested = raw as Record<string, any>
  const prompt = raw.prompt_tokens
  const cached = nested.promptTokensDetails?.cachedTokens ?? nested.prompt_tokens_details?.cached_tokens
    ?? nested.promptTokenDetails?.cachedTokens ?? nested.prompt_token_details?.cached_tokens ?? raw.numCachedTokens ?? raw.num_cached_tokens
  if (count(prompt) && count(cached) && cached <= prompt) values.input = prompt - cached
  if (count(cached)) values.cacheRead = cached
  if (count(raw.completion_tokens)) values.output = raw.completion_tokens
  if (count(raw.total_tokens)) values.totalTokens = raw.total_tokens
  report(owner, values, 'mistral-conversations-usage', raw)
}
export function reportPiMessagesUsage(owner: UsageOwner, raw: Record<string, unknown>): void {
  const values: PiReported = {}
  const source = raw.reported !== null && typeof raw.reported === 'object' ? raw.reported as Record<string, unknown> : raw
  for (const key of ['input', 'output', 'totalTokens', 'cacheRead', 'cacheWrite', 'reasoning'] as const) if (count(source[key])) values[key] = source[key]
  const incomplete = Array.isArray(raw.incomplete) ? raw.incomplete.filter((key): key is string => typeof key === 'string' && key in values) : []
  report(owner, values, 'pi-messages-usage', raw, incomplete)
}
