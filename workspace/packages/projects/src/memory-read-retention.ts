import { isDeepStrictEqual } from 'node:util'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { hasSpillNotice } from '@deepseek-ai/dsh-spill-policy/notice'
import type { StoredMemoryScope, StoredMemorySource } from './memory-types.ts'
import { toolReadDigest, toolReadMemoryResource } from './tool-read-pages.ts'
import type {} from './stock/recording/events.ts'
import { nativeSourceDigest } from './native-source-host.ts'
import { isProjectRawReferenceType } from './stock/recording/records.ts'
import { validateSource } from './memory-store.ts'

type RecordValue = Record<string, unknown>
export interface RetainedMemoryRead {
  readonly id: string
  readonly revision: number
  readonly generation?: string
  readonly scope: StoredMemoryScope
  readonly sources: StoredMemorySource[]
}
interface Receipt { read: RetainedMemoryRead; digest: string }
interface Edit { start: number; end: number; text: string }
interface ReadRange { readonly kind: 'complete-memory-body' | 'partial-memory-body'; readonly unit?: string; readonly start?: number; readonly end?: number; readonly total?: number }
interface ReadSpan { start: number; end: number; depth: number; read: RetainedMemoryRead; complete: boolean; range: ReadRange; snapshotIdentity?: string }
export interface RetainedMemoryOccurrence {
  readonly read: RetainedMemoryRead
  readonly range: ReadRange
  readonly retained: boolean
  readonly complete: boolean
  readonly snapshotIdentity?: string
}
interface DisplayEdit { start: number; end: number; depth: number; read: RetainedMemoryRead; insert: boolean }
/** Disposable metadata only: no canonical body, returned value or content closure. */
export interface RetainedMemoryResult {
  readonly seq: number
  readonly messageId: string
  readonly contentDigest: string
  readonly observations: readonly RetainedMemoryRead[]
  readonly complete: readonly RetainedMemoryRead[]
  readonly occurrences: readonly RetainedMemoryOccurrence[]
  readonly edits: readonly DisplayEdit[]
}
export interface RetainedMemoryEvidence {
  observations(messageId: string, seq: number): RetainedMemoryRead[]
  completeObservations(messageId: string, seq: number): RetainedMemoryRead[]
  project(messageId: string, seq: number, content: readonly ContentBlock[], replace: (read: RetainedMemoryRead) => unknown | undefined): readonly ContentBlock[] | undefined
}
interface InvocationStart {
  readonly type: 'tool/call' | 'tool/ptc-dispatch-start'
  readonly seq: number
  readonly data: { readonly callId: string; readonly rootCallId: string; readonly name: string; readonly parentCallId?: string }
}
interface CanonicalReturn { readonly value: unknown; readonly content: readonly ContentBlock[] }
interface Invocation {
  start: InvocationStart
  began?: boolean
  canonical?: CanonicalReturn
  settled?: boolean
  nested: Invocation[]
}

/**
 * Reconstruct only existing execution facts. There is no new persisted read ledger.
 * A root result is bound to its own start, successful execution and actual result;
 * nested values additionally need their successful dispatch settlement.
 */
export function retainedMemoryReadEvidence(projectId: string, events: readonly SessionEvent[], prepared?: readonly RetainedMemoryResult[]): RetainedMemoryEvidence {
  return retainedMemoryEvidenceFromFacts(prepared ?? summarizeRetainedMemoryReads(projectId, events))
}

export function summarizeRetainedMemoryReads(projectId: string, events: readonly SessionEvent[]): RetainedMemoryResult[] {
  if (events.some(event => isProjectRawReferenceType(event.type))) throw new Error('PROJECT_READ_EVIDENCE_REQUIRES_ASYNC_PREPARATION')
  const starts = new Map<number, Invocation>()
  const roots = new Map<string, Invocation>()
  const active = new Map<string, Invocation>()
  const results: RetainedMemoryResult[] = []
  for (const event of events) {
    const raw = event as unknown as { type: string; seq: number; data: RecordValue }
    if (event.type === 'tool/call') {
      const invocation: Invocation = { start: { type: 'tool/call', seq: event.seq,
        data: { callId: String(event.data.callId), rootCallId: String(event.data.callId), name: event.data.name } }, nested: [] }
      starts.set(event.seq, invocation)
      roots.set(String(event.data.callId), invocation)
      active.set(String(event.data.callId), invocation)
    } else if (raw.type === 'tool/ptc-dispatch-start') {
      const root = roots.get(String(raw.data.rootCallId))
      if (root === undefined) continue
      if (typeof raw.data.subCallId !== 'string' || typeof raw.data.rootCallId !== 'string' || typeof raw.data.name !== 'string') continue
      const invocation: Invocation = { start: { type: raw.type, seq: event.seq, data: {
        callId: raw.data.subCallId, rootCallId: raw.data.rootCallId, name: raw.data.name,
        ...(typeof raw.data.parentCallId === 'string' ? { parentCallId: raw.data.parentCallId } : {}),
      } }, nested: [] }
      starts.set(event.seq, invocation)
      active.set(raw.data.subCallId, invocation)
      root.nested.push(invocation)
    } else if (raw.type === 'tool/execution-start' || raw.type === 'projects/tool-execution-start'
      || (raw.type === 'tool/execution-return' || raw.type === 'projects/tool-execution-return') && raw.data.phase === 'canonical') {
      const invocation = typeof raw.data.startEventSeq === 'number' ? starts.get(raw.data.startEventSeq) : undefined
      const start = invocation?.start
      if (start === undefined) continue
      if (raw.data.callId !== start.data.callId || raw.data.rootCallId !== start.data.rootCallId || raw.data.name !== start.data.name) continue
      if (raw.type === 'tool/execution-start' || raw.type === 'projects/tool-execution-start') invocation!.began = true
      else if (invocation!.began && Array.isArray(raw.data.content)) {
        // Projects retains the actual native pipeline result without adding
        // fields to stock events. Only a successful canonical value is a read.
        const result = raw.type === 'projects/tool-execution-return' ? record(raw.data.result) : undefined
        if (raw.type === 'projects/tool-execution-return' && (result?.isError !== false || !Object.hasOwn(result, 'value'))) continue
        invocation!.canonical = { value: result === undefined ? raw.data.value : result.value, content: raw.data.content as ContentBlock[] }
      }
    } else if (event.type === 'tool/ptc-dispatch') {
      const invocation = active.get(String(event.data.subCallId))
      const start = invocation?.start
      if (start !== undefined && start.type !== 'tool/call' && start.data.rootCallId === event.data.rootCallId
        && start.data.parentCallId === event.data.parentCallId && start.data.name === event.data.name) invocation!.settled = !event.data.isError
    } else if (event.type === 'tool/result') {
      const message = event.data.message
      const invocation = roots.get(String(message.toolCallId))
      // A result closes this particular root even if a later call reuses its id.
      roots.delete(String(message.toolCallId))
      if (message.isError || invocation?.canonical === undefined) continue
      const canonical = textOnly(invocation.canonical.content)
      if (canonical === undefined || textOnly(message.content) === undefined) continue
      const name = invocation.start.data.name
      let spans: ReadSpan[] = []
      if (name === 'project_memory_read') {
        const read = memoryReadIdentity(invocation.canonical.value, projectId)
        if (read !== undefined && equalJson(canonical, invocation.canonical.value)) {
          const receipt = { read, digest: nativeSourceDigest(invocation.canonical.value) }
          spans = memorySpans(canonical, [receipt])
        }
      } else if (name === 'run_code') {
        const receipts = invocation.nested.flatMap(child => {
          if (!child.settled || child.start.data.name !== 'project_memory_read' || child.canonical === undefined) return []
          if (invocation.nested.some(other => other.settled && other.canonical !== undefined && other.start.data.name !== 'project_memory_read'
            && isDeepStrictEqual(other.canonical.value, child.canonical!.value))) return []
          const read = memoryReadIdentity(child.canonical.value, projectId)
          return read === undefined ? [] : [{ read, digest: nativeSourceDigest(child.canonical.value) }]
        })
        if (receipts.length > 0) spans = programSpans(invocation.canonical.value, canonical, receipts)
      }
      if (spans.length > 0) {
        const segments = retainedSegments(canonical, textOnly(message.content)!)
        if (segments === undefined) continue
        const edits: DisplayEdit[] = [], complete: RetainedMemoryRead[] = [], occurrences: RetainedMemoryOccurrence[] = []
        for (const span of spans) {
          let displayedOffset = 0, inserted = false, covered = 0
          for (const segment of segments) {
            if (segment.start !== undefined) {
              const from = Math.max(span.start, segment.start), to = Math.min(span.end, segment.start + segment.text.length)
              if (to > from) {
                edits.push({ start: displayedOffset + from - segment.start, end: displayedOffset + to - segment.start,
                  depth: span.depth, read: span.read, insert: !inserted })
                inserted = true
                covered += to - from
              }
            }
            displayedOffset += segment.text.length
          }
          const suppliedComplete = span.complete && covered === span.end - span.start
          if (suppliedComplete) complete.push(span.read)
          occurrences.push({ read: span.read, range: span.range, retained: covered > 0, complete: suppliedComplete,
            ...(span.snapshotIdentity === undefined ? {} : { snapshotIdentity: span.snapshotIdentity }) })
        }
        results.push({ seq: event.seq, messageId: message.id, contentDigest: nativeSourceDigest(message.content),
          observations: occurrences.filter(item => item.retained).map(item => item.read), complete, occurrences, edits: edits.sort((a, b) => a.start - b.start) })
      }
    }
  }
  return results
}

export function retainedMemoryEvidenceFromFacts(results: readonly RetainedMemoryResult[]): RetainedMemoryEvidence {
  const byMessage = new Map(results.map(result => [result.messageId, result]))
  const selected = (id: string, seq: number) => { const result = byMessage.get(id); return result?.seq === seq ? result : undefined }
  return {
    observations: (id, seq) => structuredClone([...(selected(id, seq)?.observations ?? [])]),
    completeObservations: (id, seq) => structuredClone([...(selected(id, seq)?.complete ?? [])]),
    project(id, seq, content, replace) {
      const result = selected(id, seq)
      if (result === undefined || nativeSourceDigest(content) !== result.contentDigest) return
      const text = textOnly(content)
      if (text === undefined) return
      const edits: Edit[] = []
      for (const edit of result.edits) {
        const replacement = replace(edit.read)
        if (replacement === undefined) continue
        let value = JSON.stringify(replacement)
        for (let depth = 0; depth < edit.depth; depth++) value = JSON.stringify(value).slice(1, -1)
        edits.push({ start: edit.start, end: edit.end, text: edit.insert ? value : '' })
      }
      if (!edits.length) return
      const projected = applyEdits(text, edits)
      return projected === text ? undefined : [{ type: 'text', text: projected }]
    },
  }
}

/** Exact source ranges in the canonical display; never search for body substrings. */
function programSpans(value: unknown, canonical: string, receipts: readonly Receipt[]): ReadSpan[] {
  const result: ReadSpan[] = [], output = record(value)
  if (!Array.isArray(output?.logs) || !output.logs.every(log => typeof log === 'string')) return result
  const logs = output.logs as string[], joined = logs.join('\n')
  if (!canonical.startsWith(joined)) return result
  const append = (text: string, offset: number) => {
    result.push(...memorySpans(text, receipts).map(span => ({ ...span, start: span.start + offset, end: span.end + offset })))
  }
  let offset = 0
  for (const log of logs) { append(log, offset); offset += log.length + 1 }
  if (!Object.hasOwn(output!, 'result')) return result
  offset = joined.length + (joined.length > 0 ? 1 : 0)
  let rendered = canonical.slice(offset)
  const sandbox = record(output!.sandbox)
  if (sandbox?.denied === true) {
    // Native appends a fixed denial sentence plus provider guidance after the
    // return and optional partial-enforcement sentence. This is canonical
    // renderer text, not program text. The exact result-value check below is
    // still required, and edits never include any of these suffixes.
    const suffix = `\nThe ${sandbox.mode} file sandbox denied an operation.`
    const at = rendered.lastIndexOf(suffix)
    if (at < 0) return result
    rendered = rendered.slice(0, at)
  }
  if (sandbox?.enforcement === 'partial') {
    const suffix = '\nFile sandbox enforcement is partial on this host.'
    if (!rendered.endsWith(suffix)) return result
    rendered = rendered.slice(0, -suffix.length)
  }
  if (typeof output!.result === 'string' ? rendered === output!.result : equalJson(rendered, output!.result)) append(rendered, offset)
  return result
}

/** Parse a complete JSON value and retain token ranges while walking that value. */
function memorySpans(text: string, receipts: readonly Receipt[]): ReadSpan[] {
  const empty = (): ReadSpan[] => []
  let value: unknown
  try { value = JSON.parse(text) } catch { return empty() }
  const result = empty()
  let position = 0
  const space = () => { while (/\s/.test(text[position] ?? '') && position < text.length) position++ }
  const expect = (char: string) => { space(); if (text[position++] !== char) throw new Error('JSON token does not match its parsed value') }
  const stringEnd = () => {
    if (text[position++] !== '"') throw new Error('JSON string token is unavailable')
    while (position < text.length) {
      const char = text[position++]
      if (char === '\\') position++
      else if (char === '"') return
    }
    throw new Error('JSON string token is incomplete')
  }
  const walk = (node: unknown, allowed: boolean) => {
    space()
    const start = position
    const match = allowed ? receipts.find(receipt => receipt.digest === nativeSourceDigest(node)) : undefined
    const inspect = allowed && match === undefined && !historicalItem(record(node))
    if (typeof node === 'string') {
      stringEnd()
      if (JSON.parse(text.slice(start, position)) !== node) throw new Error('JSON string differs from its parsed position')
    }
    else if (Array.isArray(node)) {
      expect('[')
      for (let index = 0; index < node.length; index++) { if (index > 0) expect(','); walk(node[index], inspect) }
      expect(']')
    } else if (record(node) !== undefined) {
      expect('{')
      for (const [index, key] of Object.keys(node as RecordValue).entries()) {
        if (index > 0) expect(',')
        space()
        const keyStart = position
        stringEnd()
        // JSON.parse reorders integer keys and collapses duplicate keys. Those
        // texts do not establish these source ranges: fail closed, never pair
        // a parsed Memory node with an unrelated lexeme at another position.
        if (JSON.parse(text.slice(keyStart, position)) !== key) throw new Error('JSON key order or duplication prevents an exact range')
        expect(':')
        walk((node as RecordValue)[key], inspect)
      }
      expect('}')
    } else {
      while (position < text.length && !/[\s,\]}]/.test(text[position]!)) position++
      if (!isDeepStrictEqual(JSON.parse(text.slice(start, position)), node)) throw new Error('JSON primitive differs from its parsed position')
    }
    if (match !== undefined) {
      const object = record(node)
      const range = record(object?.range), page = toolReadMemoryResource(node) !== undefined
      result.push({ start, end: position, depth: 0, read: match.read,
        complete: page ? range?.start === 0 && range.end === range.total : typeof object?.body === 'string' && !Object.hasOwn(object, 'range'),
        range: page ? { kind: 'partial-memory-body', unit: String(range!.unit), start: Number(range!.start), end: Number(range!.end), total: Number(range!.total) } : { kind: 'complete-memory-body' },
        ...(page && typeof object?.snapshot_identity === 'string' ? { snapshotIdentity: object.snapshot_identity } : {}) })
    } else if (inspect && typeof node === 'string') {
      const nested = memorySpans(node, receipts)
      // Map decoded JSON positions back into this exact string token. Only
      // offsets and escaping depth survive; the parent string is released.
      for (const span of nested) result.push({ ...span,
        start: start + 1 + JSON.stringify(node.slice(0, span.start)).length - 2,
        end: start + 1 + JSON.stringify(node.slice(0, span.end)).length - 2, depth: span.depth + 1 })
    }
  }
  try { walk(value, true); space(); return position === text.length ? result : empty() } catch { return empty() }
}

function applyEdits(text: string, edits: readonly Edit[]): string {
  let result = '', offset = 0
  for (const edit of edits) { result += text.slice(offset, edit.start) + edit.text; offset = edit.end }
  return result + text.slice(offset)
}

interface Segment { text: string; start?: number }
/**
 * The notice alone is not provenance. Require the bound original/result pair,
 * exact contiguous canonical ends, a unique split and the exact omitted bytes.
 * Framing and the original recovery locator are retained verbatim.
 */
function retainedSegments(canonical: string, displayed: string): Segment[] | undefined {
  if (canonical === displayed) return [{ text: displayed, start: 0 }]
  const candidates: Segment[][] = []
  const footer = /(?:^|\n\n)(\(Omitted ([0-9]+) bytes\. Full formatted result stored at: [\s\S]*\))$/.exec(displayed)
  if (footer === null || !hasSpillNotice(footer[1]!)) return
  const omitted = Number(footer[2])
  if (!Number.isSafeInteger(omitted)) return
  if (footer.index === 0 && displayed === footer[1] && omitted === Buffer.byteLength(canonical)) return [{ text: displayed }]
  const preview = displayed.slice(0, footer.index), gap = '\n\n[...]\n\n'
  for (let at = preview.indexOf(gap); at >= 0; at = preview.indexOf(gap, at + 1)) {
    const head = preview.slice(0, at), tail = preview.slice(at + gap.length)
    if (head.length + tail.length > canonical.length || !canonical.startsWith(head) || !canonical.endsWith(tail)
      || Buffer.byteLength(canonical.slice(head.length, canonical.length - tail.length)) !== omitted) continue
    candidates.push([{ text: head, start: 0 }, { text: gap }, { text: tail, start: canonical.length - tail.length }, { text: displayed.slice(footer.index) }])
  }
  return candidates.length === 1 ? candidates[0] : undefined
}

function textOnly(content: readonly ContentBlock[]): string | undefined {
  return content.length === 1 && content[0]?.type === 'text' ? content[0].text : undefined
}
function record(value: unknown): RecordValue | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined }
function equalJson(text: string, value: unknown): boolean { try { return isDeepStrictEqual(JSON.parse(text), value) } catch { return false } }
export function memoryReadIdentity(value: unknown, projectId: string): RetainedMemoryRead | undefined {
  const memory = record(value), scope = record(memory?.scope)
  const resource = toolReadMemoryResource(value), metadata = record(memory?.metadata), pageScope = record(metadata?.scope)
  if (resource?.projectId === projectId && memory?.encoding === 'plain-text' && memory.text_field === 'body'
    && metadata?.projectId === projectId && metadata.id === resource.id && metadata.revision === resource.revision && metadata.generation === resource.generation
    && pageScope !== undefined && ['project', 'session', 'file', 'topic'].includes(String(pageScope.kind))
    && toolReadDigest(pageScope) === resource.scopeDigest && Array.isArray(metadata.sources)) {
    return compactRead(resource.id, resource.revision, pageScope, metadata.sources, resource.generation)
  }
  if (memory?.projectId !== projectId || typeof memory.id !== 'string' || !Number.isSafeInteger(memory.revision) || typeof memory.body !== 'string'
    || scope === undefined || !['project', 'session', 'file', 'topic'].includes(String(scope.kind)) || !Array.isArray(memory.sources)) return
  return compactRead(memory.id, memory.revision as number, scope, memory.sources, memory.generation)
}
function historicalItem(value: RecordValue | undefined): boolean {
  const source = record(value?.nativeSource)
  return value !== undefined && source !== undefined && typeof source.hostSessionId === 'string'
    && (source.kind === 'native-event' && source.version === 1 && Number.isSafeInteger(source.eventSeq) && typeof source.eventDigest === 'string'
      || source.kind === 'message' && typeof source.messageId === 'string' || source.kind === 'tool' && typeof source.toolCallId === 'string')
    && Number.isSafeInteger(value.seq) && typeof value.kind === 'string' && typeof value.role === 'string' && typeof value.text === 'string'
}

/** Select only the existing identity Schema; unknown fields cannot smuggle bodies into metadata. */
function compactRead(id: string, revision: number, value: RecordValue, sources: readonly unknown[], generation?: unknown): RetainedMemoryRead | undefined {
  if (generation !== undefined && typeof generation !== 'string') return
  let scope: StoredMemoryScope
  if (value.kind === 'project') scope = { kind: 'project' }
  else {
    const field = value.kind === 'session' ? 'sessionIds' : value.kind === 'file' ? 'paths' : value.kind === 'topic' ? 'topics' : undefined
    const selected = field === undefined ? undefined : value[field]
    if (!Array.isArray(selected) || !selected.every(item => typeof item === 'string')) return
    scope = { kind: value.kind, [field!]: [...selected] } as StoredMemoryScope
  }
  try { return { id, revision, ...(generation === undefined ? {} : { generation: generation as string }), scope, sources: sources.map(validateSource) } } catch { return }
}
