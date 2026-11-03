/** Strict model-output parsing and actual delivered-source collection. */
import { createHash } from 'node:crypto'
import { decodeNativeProjectSource, nativeProjectSourceKey } from '../native-source.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SourceRef } from '../records-types.ts'
import type { SessionManagerDecision } from './types.ts'
import { visibleSourceItemText } from '../model-visible-content.ts'

/** Failures have no switch side effects; the coordinator records their actual category. */
export class SessionManagerEvaluationError extends Error {
  constructor(readonly code: 'invalid-output' | 'failed' | 'cancelled' | 'busy' | 'unavailable', message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SessionManagerEvaluationError'
  }
}

/** Parse only the final assistant JSON against sources actually supplied in this evaluation.
 * @param text - Complete final assistant text, without protocol wrapping.
 * @param sources - Exact original references supplied in input or delivered read results.
 * @returns A valid decision; malformed or invented values throw invalid-output.
 */
export function parseSessionManagerDecision(text: string, sources: readonly SourceRef[]): SessionManagerDecision {
  try {
    const value: unknown = JSON.parse(text)
    if (!object(value) || Object.keys(value).length !== 4
      || !['decision', 'reason', 'continuation', 'evidence'].every(key => Object.hasOwn(value, key))) throw new Error('仅接受四个声明字段。')
    if (value.decision !== 'keep' && value.decision !== 'switch') throw new Error('decision非法。')
    if (typeof value.reason !== 'string') throw new Error('reason须为字符串。')
    if (value.continuation !== null && value.continuation !== 'same_work' && value.continuation !== 'other_work') throw new Error('continuation非法。')
    if (!Array.isArray(value.evidence)) throw new Error('evidence须为数组。')
    const actual = new Set(sources.map(nativeProjectSourceKey))
    const evidence = value.evidence.map(entry => {
      const source = decodeNativeProjectSource(entry)
      if (!actual.has(nativeProjectSourceKey(source))) throw new Error('evidence未在本次实际输入或读取中提供。')
      return source
    })
    if (value.decision === 'switch' && (!value.reason.trim() || value.continuation === null || evidence.length === 0)) throw new Error('switch缺少理由、延续关系或真实依据。')
    return { decision: value.decision, reason: value.reason, continuation: value.continuation, evidence }
  } catch (error) {
    throw new SessionManagerEvaluationError('invalid-output', `会话管理Bot输出无效：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

/** Read references only from actual retained history excerpts/pages, never from linked sources.
 * @param content - The execution pipeline's final model-visible content.
 * @returns Exact source references attached to text actually delivered.
 */
export function deliveredManagerSources(content: readonly ContentBlock[]): SourceRef[] {
  const sources: SourceRef[] = []
  const add = (value: unknown) => {
    try { sources.push(decodeNativeProjectSource(value)) }
    catch (error) { /* Non-native result fields cannot become switch evidence. */ }
  }
  for (const block of content) {
    if (block.type !== 'text') continue
    let value: unknown
    try { value = JSON.parse(block.text) }
    catch (error) { continue /* A spill/rejection notice is not an original read. */ }
    if (!object(value)) continue
    if (Array.isArray(value.items)) for (const item of value.items) {
      if (object(item) && (visibleSourceItemText(item)?.length ?? 0) > 0) add(item.nativeSource)
    }
    if (value.format === 'projects-native-content/v1' && typeof value.text === 'string' && value.text.length > 0) add(value.delivered_source ?? value.source)
  }
  return sources
}

/** Reassemble only retained, contiguous pages of one real serialized History result. */
export class ManagerHistoryResultPages {
  private readonly pending = new Map<string, { identity: string; total: number; end: number; text: string[]; ranges: Map<number, { end: number; digest: string }> }>()
  private buffered = 0
  constructor(private readonly maximum: number) {}

  collect(content: readonly ContentBlock[]): ContentBlock[] {
    const complete: ContentBlock[] = []
    for (const block of content) {
      if (block.type !== 'text') continue
      let page: unknown
      try { page = JSON.parse(block.text) } catch { continue }
      if (!object(page) || page.format !== 'projects-tool-read-page/v1' || page.tool !== 'project_history'
        || page.encoding !== 'canonical-json' || page.page_complete !== true || typeof page.text !== 'string'
        || typeof page.snapshot_identity !== 'string' || !/^[a-f0-9]{64}$/.test(page.snapshot_identity)
        || typeof page.same_page_cursor !== 'string' || !object(page.range)) continue
      const cursor = /^([a-f0-9-]{36}):(0|[1-9][0-9]*)$/.exec(page.same_page_cursor)
      const { start, end, total } = page.range
      if (cursor === null || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)
        || (start as number) < 0 || (end as number) <= (start as number) || (end as number) > (total as number)
        || (total as number) > this.maximum || Number(cursor[2]) !== start || pointLength(page.text) !== (end as number) - (start as number)) continue
      const token = cursor[1]!, digest = hash(page.text)
      let pending = this.pending.get(token)
      if (pending !== undefined && (pending.identity !== page.snapshot_identity || pending.total !== total)) { this.drop(token); pending = undefined }
      if (pending === undefined) {
        if (start !== 0) continue
        pending = { identity: page.snapshot_identity, total: total as number, end: 0, text: [], ranges: new Map() }
        this.pending.set(token, pending)
      }
      const previous = pending.ranges.get(start as number)
      if (previous !== undefined && previous.end === end && previous.digest === digest) continue
      if (start !== pending.end || this.buffered + pointLength(page.text) > this.maximum) { this.drop(token); continue }
      pending.text.push(page.text); pending.ranges.set(start as number, { end: end as number, digest }); pending.end = end as number
      this.buffered += (end as number) - (start as number)
      if (end !== total) continue
      const text = pending.text.join('')
      this.drop(token)
      // The pager identity hashes this exact canonical JSON, including excerpt sources.
      if (page.end_of_content !== true || hash(text) !== page.snapshot_identity) continue
      try { if (object(JSON.parse(text))) complete.push({ type: 'text', text }) } catch { /* Not a complete original DTO. */ }
    }
    return complete
  }

  private drop(token: string): void {
    const pending = this.pending.get(token)
    if (pending !== undefined) { this.buffered -= pending.end; this.pending.delete(token) }
  }
}

/** Repeated verified pages carry the same body even when their observation clock/cursor changes. */
export function managerReadDelivery(content: readonly ContentBlock[]): readonly { key: string; points: number }[] {
  return content.flatMap(block => {
    if (block.type !== 'text') return []
    let identity = block.text
    try {
      const value: unknown = JSON.parse(block.text)
      if (object(value) && value.format === 'projects-tool-read-page/v1') identity = JSON.stringify([
        value.format, value.tool, value.snapshot_identity, value.encoding, value.text_field, value.range, value.text,
      ])
    } catch { /* Retention notices still count as actual delivered text. */ }
    return [{ key: hash(identity), points: pointLength(block.text) }]
  })
}

function hash(text: string): string { return createHash('sha256').update(text).digest('hex') }
function pointLength(text: string): number { let count = 0; for (const _point of text) count++; return count }

function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
