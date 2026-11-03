/** Candidate-local summary references; owner indexes and canonical tool pages stay intact. */
import { isDeepStrictEqual } from 'node:util'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'
import type { RequestCandidateMessage, RequestContentProjection, RequestCurrentBlock } from './stock/request/harness.ts'
import type { MemoryContext, MemoryIndexEntry } from './memory-types.ts'
import { renderMemoryIndex } from './memory-store.ts'
import { renderMemoryContext } from './memory-context.ts'
import { nativeSourceDigest } from './native-source-host.ts'
import { toolReadDigest } from './tool-read-pages.ts'

type Value = Record<string, unknown>
export interface MemoryListKeeperFact { readonly messageId: MessageId; readonly selector: readonly (string | number)[]; readonly value: unknown }
interface List { readonly entries: readonly unknown[]; readonly locations: readonly MemoryListKeeperFact[] }
interface Page { readonly fact: MemoryListKeeperFact; readonly start: number; readonly end: number; readonly total: number; readonly text: string }

/** All retained state is this prepare's own generated content digests, never a body cache. */
export function createMemoryIndexRepresentation(projectId: string, current: MemoryContext, expected?: RequestCurrentBlock) {
  const generated = new Map<MessageId, Set<string>>()
  const full = expected?.value
  const source = record(full?.source)
  const enabled = expected?.producer === 'projects' && expected.key === `memory-index:${projectId}` && full != null
    && source?.kind === 'project-memory-index' && source.producer === 'projects' && source.form === 'catalog' && source.projectId === projectId
    && current.projectId === projectId && current.availability !== 'unreadable' && current.issues.length === 0
    && current.index === renderMemoryIndex(projectId, current.entries)
    && isDeepStrictEqual(full.content, [{ type: 'text', text: renderMemoryContext(current) }])
  const candidate = (history: readonly RequestCandidateMessage[]) => {
    if (!enabled || !expected || !full) return
    const matches = history.filter(({ message, origin }) => message.role === 'user' && message.id !== undefined
      && message.currentBlock?.producer === expected.producer && message.currentBlock.key === expected.key
      && !(origin.kind === 'literal' && origin.history !== undefined) && isDeepStrictEqual(message.source, full.source))
    const item = matches[0]
    if (matches.length !== 1 || item === undefined || item.message.role !== 'user') return
    const message = item.message
    if (message.id === undefined) return
    return isDeepStrictEqual(message.content, full.content) || generated.get(message.id)?.has(nativeSourceDigest(message.content)) ? { ...message, id: message.id } : undefined
  }
  return {
    recognizes(history: readonly RequestCandidateMessage[]): boolean { return candidate(history) !== undefined },
    project(history: readonly RequestCandidateMessage[], facts: readonly MemoryListKeeperFact[]): readonly RequestContentProjection[] {
      const message = candidate(history)
      if (message === undefined || !full) return []
      const present = new Set(history.filter(item => item.origin.kind === 'event' && item.message.role === 'tool' && !item.message.isError).map(item => item.message.id))
      const lists = completeLists(projectId, facts.filter(fact => present.has(fact.messageId))), locations = new Map<string, readonly MemoryListKeeperFact[]>()
      const entries = current.entries.map(entry => {
        if (entry.summary.length === 0) return entry
        const keeper = lists.find(list => list.entries.filter(value => isDeepStrictEqual(value, entry)).length === 1)
        if (keeper === undefined) return entry
        locations.set(entry.id, keeper.locations)
        return { ...entry, summary: summaryReference(entry, keeper.locations) }
      })
      const projected = locations.size === 0 ? full.content : [{ type: 'text' as const, text: renderMemoryContext({ ...current, index: renderMemoryIndex(projectId, entries) }) }]
      const before = JSON.stringify(full.content), after = JSON.stringify(projected)
      const content = after.length < before.length && Buffer.byteLength(after) < Buffer.byteLength(before)
        && estimateContent(projected) <= estimateContent(full.content) ? projected : full.content
      if (!isDeepStrictEqual(content, full.content)) {
        const digests = generated.get(message.id) ?? new Set<string>()
        digests.add(nativeSourceDigest(content)); generated.set(message.id, digests)
      }
      return isDeepStrictEqual(content, message.content) ? [] : [{ messageId: message.id, content }]
    },
  }
}

function summaryReference(entry: MemoryIndexEntry, locations: readonly MemoryListKeeperFact[]): string {
  const sources = locations.map(location => ({ message: location.messageId,
    ...(isDeepStrictEqual(location.selector, [0, '$json']) ? {} : { selector: location.selector }) }))
  return '完整摘要见本请求project_memory_list结果：' + JSON.stringify({ sources, id: entry.id, revision: entry.revision,
    ...(entry.generation === undefined ? {} : { generation: entry.generation }) })
}
function completeLists(projectId: string, facts: readonly MemoryListKeeperFact[]): List[] {
  const result: List[] = [], groups = new Map<string, Page[]>()
  for (const fact of facts) {
    const value = record(fact.value)
    if (list(value, projectId)) { result.push({ entries: value!.entries as unknown[], locations: [fact] }); continue }
    const range = record(value?.range)
    if (value?.format !== 'projects-tool-read-page/v1' || value.tool !== 'project_memory_list' || value.encoding !== 'canonical-json'
      || value.status !== 'partial' || value.page_complete !== true || typeof value.text !== 'string'
      || typeof value.snapshot_identity !== 'string' || !/^[a-f0-9]{64}$/.test(value.snapshot_identity)
      || range?.unit !== 'unicode-code-points' || !integer(range.start) || !integer(range.end) || !integer(range.total)
      || range.end <= range.start || range.end > range.total || Array.from(value.text).length !== range.end - range.start
      || value.complete !== (range.start === 0 && range.end === range.total) || value.end_of_content !== (range.end === range.total)) continue
    const key = `${value.snapshot_identity}:${range.total}`, pages = groups.get(key) ?? []
    pages.push({ fact, start: range.start, end: range.end, total: range.total, text: value.text }); groups.set(key, pages)
  }
  for (const [key, pages] of groups) {
    const unique = pages.filter((page, index) => pages.findIndex(other => other.start === page.start && other.end === page.end && other.text === page.text) === index)
      .sort((a, b) => a.start - b.start)
    if (unique[0]?.start !== 0 || unique.at(-1)?.end !== unique[0]?.total || unique.some((page, index) => index > 0 && page.start !== unique[index - 1]!.end)) continue
    try {
      const value = JSON.parse(unique.map(page => page.text).join(''))
      if (list(record(value), projectId) && toolReadDigest(value) === key.split(':')[0]) result.push({ entries: value.entries, locations: unique.map(page => page.fact) })
    } catch { /* An incomplete, changed or unknown result never becomes a keeper. */ }
  }
  return result
}
function list(value: Value | undefined, projectId: string): boolean {
  return value?.projectId === projectId && Array.isArray(value.entries) && typeof value.indexSynchronized === 'boolean' && Array.isArray(value.issues)
    && value.issues.length === 0 && value.partial !== true && value.complete !== false && value.status === undefined && value.format === undefined
    && value.entries.every(entry => { const item = record(entry); return item?.projectId === projectId && typeof item.id === 'string'
      && typeof item.summary === 'string' && typeof item.path === 'string' && integer(item.revision) && record(item.scope) !== undefined })
}
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
function record(value: unknown): Value | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Value : undefined }
