import { isDeepStrictEqual } from 'node:util'
import type { ContentBlock, ContextSnapshotSection, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { RequestBodyOccurrence, RequestCandidateMessage, RequestContentProjection, RequestHistoryProjection } from './stock/request/harness.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-tools'
import type { MemoryContext, StoredMemoryScope, StoredMemorySource } from './memory-types.ts'
import { toolReadDigest, toolReadMemoryResource } from './tool-read-pages.ts'
import { retainedMemoryReadEvidence, memoryReadIdentity } from './memory-read-retention.ts'
import type { RetainedMemoryResult } from './memory-read-retention.ts'
import { nativeSourceDigest } from './native-source-host.ts'
import type { RetainedMemoryRead } from './memory-read-retention.ts'
import { hasMemoryAuthorityKeeper, projectMemoryRepresentation } from './memory-result-representation.ts'
import type { MemoryRepresentationOptions } from './memory-result-representation.ts'
import { isHistoricalSourceItem, visibleSourceItemForModel } from './model-visible-content.ts'
import { prepareWorkCurrentRepresentation, type WorkCurrentSupplyReader } from './work-current-representation.ts'
import { createMemoryIndexRepresentation, type MemoryListKeeperFact } from './memory-index-representation.ts'

type Path = readonly (string | number)[]
type RecordValue = Record<string, unknown>
export interface ReadReceiptFact { readonly name: string; readonly digest: string }
interface Receipt extends ReadReceiptFact {}
interface ProjectedReceipt { readonly name: string; readonly value: unknown; readonly anchor: unknown }
interface MemoryRead { readonly id: string; readonly projectId: string; readonly revision: number; readonly generation?: string; readonly body: string; readonly scope: StoredMemoryScope; readonly sources: StoredMemorySource[] }
export interface ObservedMemoryRead { readonly id: string; readonly revision: number; readonly generation?: string; readonly scope: StoredMemoryScope; readonly sources: StoredMemorySource[] }
/** Explicitly prepared from canonical positions; no raw values survive this boundary. */
export interface PreparedProjectReadEvidence {
  readonly retained: readonly RetainedMemoryResult[]
  readonly calls: readonly { readonly messageId: MessageId; readonly name: string; readonly startSeq: number }[]
  readonly nested: readonly { readonly startSeq: number; readonly receipts: readonly ReadReceiptFact[] }[]
  readonly reads: readonly ObservedMemoryRead[]
  readonly issues: readonly { readonly seq: number; readonly message: string }[]
}


/** 只取真实工具结果中的结构化正文；不把原聊天或任意相同字符串当成读取证据。 */
export function projectReadEvidence(
  projectId: string, events: readonly SessionEvent[], current: MemoryContext, representation?: MemoryRepresentationOptions, prepared?: PreparedProjectReadEvidence, work?: WorkCurrentSupplyReader,
): RequestHistoryProjection {
  const retained = retainedMemoryReadEvidence(projectId, events, prepared?.retained)
  const calls = new Map<MessageId, { name: string; startSeq: number }>()
  const active = new Map<number, { name: string; callId: string }>()
  const nested = new Map<number, Receipt[]>()
  // 只记本实例从原receipt严格匹配并生成的后像，绑定原消息及JSON位置。
  const projectedNested = new Map<string, ProjectedReceipt>()
  const memoryIndex = createMemoryIndexRepresentation(projectId, current, representation?.memoryBlock)
  if (prepared !== undefined) {
    for (const call of prepared.calls) calls.set(call.messageId, { name: call.name, startSeq: call.startSeq })
    for (const row of prepared.nested) nested.set(row.startSeq, [...row.receipts])
  }
  for (const event of prepared === undefined ? events : []) {
    if (event.type === 'tool/call') active.set(event.seq, { callId: String(event.data.callId), name: event.data.name })
    if (event.type === 'tool/result') {
      const startSeq = event.sourceEventSeqs?.find(seq => {
        const start = events.find(item => item.seq === seq)
        return start?.type === 'tool/call' && start.data.callId === event.data.message.toolCallId
      })
      if (startSeq !== undefined) {
        const start = active.get(startSeq)
        if (start) calls.set(event.data.message.id, { name: start.name, startSeq })
        active.delete(startSeq)
      }
    }
    if (event.type !== 'tool/ptc-dispatch' || event.data.isError) continue
    const receipts = event.data.content.flatMap(block => {
      const value = block.type === 'text' ? parse(block.text) : undefined
      return value === undefined ? [] : [{ name: event.data.name, digest: nativeSourceDigest(value) }]
    })
    // Native PTC records are emitted inside their still-open root call. A
    // repeated model callId in a later step is a different start seq; never
    // collect all historical occurrences under that string.
    const roots = [...active].filter(([, call]) => call.callId === String(event.data.rootCallId))
    if (roots.length !== 1) continue
    const key = roots[0]![0]
    nested.set(key, [...(nested.get(key) ?? []), ...receipts])
  }
  const projectCurrentness = (history: readonly RequestCandidateMessage[]) => {
    const keeper = representation !== undefined && (hasMemoryAuthorityKeeper(projectId, history, representation.memoryBlock) || memoryIndex.recognizes(history))
    const projectWork = prepareWorkCurrentRepresentation(projectId, history, work?.())
    const overrides: RequestContentProjection[] = []
    const occurrences: RequestBodyOccurrence[] = []
    const memoryLists: MemoryListKeeperFact[] = []
    for (const item of history) {
      const message = item.message
      if (item.origin.kind !== 'event' || message.role !== 'tool' || message.isError) continue
      const seq = item.origin.seq
      const call = calls.get(message.id)
      const name = call?.name
      const receipts = call === undefined ? [] : nested.get(call.startSeq) ?? []
      const retainedContent = retained.project(message.id, seq, message.content, read => expiredMemory(read, current))
      let changed = retainedContent !== undefined
      const content = (retainedContent ?? message.content).map((block, blockIndex) => {
        if (block.type !== 'text') return block
        const value = parse(block.text)
        if (value === undefined) return block
        let blockChanged = false
        const markChanged = () => { changed = true; blockChanged = true }
        const found: RequestBodyOccurrence[] = []
        const occurrence = (path: Path, identity: RequestBodyOccurrence['identity'], body: string) => {
          if (body.length > 0) found.push({ messageId: message.id, seq,
            selector: [blockIndex, '$json', ...path], identity, body })
        }
        const processRaw = (input: unknown, tool: string | undefined, path: Path): unknown => {
          const value = record(input)
          if (value === undefined) return input
          if (tool === 'project_memory_read') {
            const resource = toolReadMemoryResource(value)
            if (resource !== undefined && resource.projectId === projectId) {
              const entry = current.entries.find(entry => entry.id === resource.id)
              if (current.availability === 'unreadable' || entry === undefined || entry.revision !== resource.revision || entry.generation !== resource.generation || toolReadDigest(entry.scope) !== resource.scopeDigest) {
                markChanged()
                return { unavailable: true, memoryId: resource.id, previousRevision: resource.revision,
                  ...(entry === undefined ? {} : { currentRevision: entry.revision }),
                  status: current.availability === 'unreadable' ? 'unavailable' : entry === undefined && current.withdrawals?.some(marker => marker.id === resource.id) ? 'withdrawn' : 'revised-or-unavailable',
                  message: '该旧共享记忆分页已退出当前供给；须从当前索引重新读取，不能继续使用旧页或把部分正文视为全文已读。' }
              }
              const range = record(value.range)
              if (typeof value.text === 'string' && range !== undefined) occurrence([...path, 'text'], {
                source: json({ ...resource, kind: 'project-memory-page' }), version: json({ revision: resource.revision, ...(resource.generation === undefined ? {} : { generation: resource.generation }), snapshotIdentity: value.snapshot_identity }),
                range: json({ kind: value.encoding === 'plain-text' ? 'partial-memory-body' : 'partial-canonical-json', ...range }), use: 'current-read',
              }, value.text)
              return input
            }
            const memory = memoryRead(value, projectId)
            if (memory === undefined) return input
            const expired = expiredMemory(memory, current)
            if (expired !== undefined) {
              markChanged()
              return expired
            }
            occurrence([...path, 'body'], {
              source: json({ kind: 'project-memory', projectId, id: memory.id, scope: memory.scope, sources: value.sources, originSources: value.originSources, reconfirmedBy: value.reconfirmedBy }),
              version: json({ revision: memory.revision, ...(memory.generation === undefined ? {} : { generation: memory.generation }), nature: value.nature }), range: { kind: 'complete-memory-body' }, use: 'current-read',
            }, memory.body)
            return input
          }
          if (tool === 'project_library_open') {
            const page = value.format === 'projects-tool-read-page/v1' && value.tool === tool && value.encoding === 'plain-text' && value.text_field === 'text'
            const source = page ? record(value.metadata) : value, range = page ? record(value.range) : undefined
            if (source?.status !== 'file' || source.content !== 'text' || typeof value.text !== 'string'
              || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)
              || !Number.isSafeInteger(source.byteLength) || record(source.location) === undefined || record(source.target) === undefined) return input
            if (page && (value.status !== 'partial' || value.page_complete !== true || typeof value.snapshot_identity !== 'string'
              || range?.unit !== 'unicode-code-points' || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || !Number.isSafeInteger(range.total)
              || (range.start as number) < 0 || (range.end as number) > (range.total as number)
              || (range.end as number) - (range.start as number) !== Array.from(value.text).length || Object.hasOwn(range, 'kind'))) return input
            occurrence([...path, 'text'], { source: json({ kind: 'project-library', projectId, location: source.location, target: source.target, absolutePath: source.absolutePath }),
              version: json({ sha256: source.sha256, byteLength: source.byteLength, ...(page ? { snapshotIdentity: value.snapshot_identity } : {}) }),
              range: page ? json({ kind: 'partial-library-text', ...range }) : { kind: 'complete-returned-text' }, use: 'current-read' }, value.text)
            return input
          }
          if (tool === 'project_overview_read') return overviewRepresentation(value, projectId)
          if (tool === 'project_history') return historyValue(value, path, occurrence, markChanged)
          if (tool === 'project_read') {
            const source = record(value.source)
            if (source === undefined) return input
            const projected = historyValue(source, [...path, 'source'], occurrence, markChanged)
            return projected === source ? input : { ...value, source: projected }
          }
          return input
        }
        const process = (input: unknown, tool: string | undefined, path: Path): unknown => {
          const location = JSON.stringify([seq, message.id, message.toolCallId, blockIndex, path])
          const previous = projectedNested.get(location)
          const anchor = previous !== undefined && previous.name === tool && isDeepStrictEqual(previous.value, input) ? previous.anchor : input
          const processed = processRaw(anchor, tool, path)
          const memoryProjected = representation === undefined ? processed : projectMemoryRepresentation(projectId, tool, processed, keeper)
          const next = projectWork(tool, memoryProjected)
          if (tool === 'project_memory_list') memoryLists.push({ messageId: message.id, selector: [blockIndex, '$json', ...path], value: next })
          if (!isDeepStrictEqual(next, input)) markChanged()
          if (tool !== undefined && !isDeepStrictEqual(next, anchor)) projectedNested.set(location, { name: tool, value: json(next), anchor: json(anchor) })
          return next
        }
        const walk = (value: unknown, path: Path): unknown => {
          // 历史来源 item 的正文可能恰好是 Memory JSON；它始终保留历史用途。
          if (historicalItem(record(value))) return value
          const matched = receipts.filter(receipt => receipt.digest === nativeSourceDigest(value))
          const location = JSON.stringify([seq, message.id, message.toolCallId, blockIndex, path])
          if (matched.length > 0) {
            const names = [...new Set(matched.map(receipt => receipt.name))]
            if (names.length === 1 && (names[0] !== 'project_overview_read' || matched.length === 1)) {
              const name = names[0]!
              return process(value, name, path)
            }
            return value
          }
          const projectedReceipt = projectedNested.get(location)
          if (projectedReceipt !== undefined && isDeepStrictEqual(projectedReceipt.value, value)) return process(value, projectedReceipt.name, path)
          if (typeof value === 'string') {
            const parsed = parse(value)
            if (parsed === undefined) return value
            const next = walk(parsed, [...path, '$json'])
            return next === parsed ? value : JSON.stringify(next)
          }
          if (Array.isArray(value)) return value.map((child, index) => walk(child, [...path, index]))
          const object = record(value)
          if (object !== undefined) return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, walk(child, [...path, key])]))
          return value
        }
        const next = name === 'project_memory_read' || name === 'project_memory_list' || name === 'project_library_open' || name === 'project_overview_read' || name === 'project_history' || name === 'project_read'
          || name === 'project_instructions_read' || name === 'project_instructions_save' || name === 'project_overview_put_block' || name === 'project_overview_remove_block' || name === 'project_overview_reorder'
          ? process(value, name, []) : walk(value, [])
        occurrences.push(...found)
        return !blockChanged ? block : { ...block, text: JSON.stringify(next) }
      })
      if (changed) overrides.push({ messageId: message.id, content })
    }
    return { overrides: [...overrides, ...memoryIndex.project(history, memoryLists)], occurrences }
  }
  return { projectCurrentness, renderOmissions }
}

/** 同次读取的完整document是keeper；来源观察及未知字段不参与省略。 */
function overviewRepresentation(value: RecordValue, projectId: string): unknown {
  const document = record(value.document)
  if (value.projectId !== projectId || document?.projectId !== projectId || document.schemaVersion !== 2
    || value.documentStatus !== 'available' || value.partial === true || document.partial === true
    || !Array.isArray(document.blocks) || !Array.isArray(value.blocks)
    || record(value.project) === undefined || record(value.runtime) === undefined || typeof value.loadedAt !== 'string') return value
  const keepers = new Map<string, RecordValue[]>()
  for (const raw of document.blocks) {
    const block = record(raw)
    if (block === undefined || typeof block.id !== 'string' || typeof block.title !== 'string'
      || record(block.content) === undefined || !Array.isArray(block.sources) || typeof block.updatedAt !== 'string'
      || typeof block.updatedBySessionId !== 'string' || block.partial === true) return value
    keepers.set(block.id, [...(keepers.get(block.id) ?? []), block])
  }
  let changed = false
  const blocks = value.blocks.map(raw => {
    const wrapper = record(raw), block = record(wrapper?.block)
    if (wrapper === undefined || block === undefined || typeof block.id !== 'string'
      || Object.hasOwn(wrapper, 'blockId') || wrapper.partial === true || !Array.isArray(wrapper.sources)) return raw
    const candidates = keepers.get(block.id)
    if (candidates?.length !== 1 || !isDeepStrictEqual(candidates[0], block)) return raw
    const { block: _block, ...observations } = wrapper
    changed = true
    return { ...observations, blockId: block.id }
  })
  return changed ? { ...value, blocks } : value
}

/** 观察事实用于失效说明；仅真实 Memory 读取，不将 history 中的旧 JSON 算作当前读取。 */
export function observedMemoryReads(projectId: string, events: readonly SessionEvent[], prepared?: PreparedProjectReadEvidence): ObservedMemoryRead[] {
  if (prepared !== undefined) return structuredClone([...prepared.reads])
  const retained = retainedMemoryReadEvidence(projectId, events)
  const calls = new Map<string, string>()
  const recorded = new Set<string>()
  const nested = new Map<string, { read: MemoryRead; value: unknown }[]>()
  const result: ObservedMemoryRead[] = []
  for (const event of events) {
    if (event.type === 'tool/call') { calls.set(String(event.data.callId), event.data.name); recorded.delete(String(event.data.callId)); nested.delete(String(event.data.callId)) }
    if (['tool/execution-start', 'projects/tool-execution-start', 'tool/execution-return', 'projects/tool-execution-return'].includes(event.type)) {
      const root = (event.data as unknown as RecordValue).rootCallId
      if (typeof root === 'string' && calls.has(root)) recorded.add(root)
    }
    if (event.type === 'tool/ptc-dispatch' && event.data.name === 'project_memory_read' && !event.data.isError) {
      const reads = event.data.content.flatMap(block => {
        const read = block.type === 'text' ? memoryRead(record(parse(block.text)), projectId) : undefined
        return read === undefined ? [] : [{ read, value: parse(block.type === 'text' ? block.text : '') }]
      })
      const root = String(event.data.rootCallId)
      nested.set(root, [...(nested.get(root) ?? []), ...reads])
    }
    if (event.type !== 'tool/result' || event.data.message.isError) continue
    const message = event.data.message
    const reads: RetainedMemoryRead[] = recorded.has(String(message.toolCallId)) ? [] : calls.get(String(message.toolCallId)) === 'project_memory_read'
      ? message.content.flatMap(block => {
        const read = block.type === 'text' ? memoryRead(record(parse(block.text)), projectId) : undefined
        return read === undefined ? [] : [read]
      }) : (nested.get(String(message.toolCallId)) ?? []).filter(receipt => message.content.some(block => {
        if (block.type !== 'text') return false
        const value = parse(block.text)
        return value === undefined ? block.text.includes(JSON.stringify(receipt.value)) : containsExactValue(value, receipt.value)
      })).map(receipt => receipt.read)
    for (const read of retained.completeObservations(message.id, event.seq)) {
      if (!reads.some(known => known.id === read.id && known.revision === read.revision && known.generation === read.generation && isDeepStrictEqual(known.scope, read.scope))) reads.push(read)
    }
    for (const read of reads) result.push({ id: read.id, revision: read.revision, ...(read.generation === undefined ? {} : { generation: read.generation }), scope: structuredClone(read.scope), sources: structuredClone(read.sources) })
  }
  return result
}

function expiredMemory(memory: RetainedMemoryRead, current: MemoryContext): RecordValue | undefined {
  const entry = current.entries.find(entry => entry.id === memory.id)
  if (current.availability !== 'unreadable' && entry !== undefined && entry.revision === memory.revision && entry.generation === memory.generation && isDeepStrictEqual(entry.scope, memory.scope)) return
  return { unavailable: true, memoryId: memory.id, previousRevision: memory.revision,
    ...(entry === undefined ? {} : { currentRevision: entry.revision }),
    status: current.availability === 'unreadable' ? 'unavailable' : entry === undefined && current.withdrawals?.some(marker => marker.id === memory.id) ? 'withdrawn' : 'revised-or-unavailable',
    message: '该旧共享记忆读取结果已退出当前供给；使用前须按当前索引重新按需读取。历史原件只作当时证据，不能恢复当前效力。' }
}

function historyValue(value: RecordValue, path: Path,
  occurrence: (path: Path, identity: RequestBodyOccurrence['identity'], body: string) => void, changed: () => void): unknown {
  if ((value.format === 'projects-native-content/v1' || value.format === 'projects-communication-content/v1')
    && typeof value.text === 'string' && record(value.range) !== undefined) {
    const source = record(value.source)
    occurrence([...path, 'text'], { source: source === undefined
      ? json({ kind: 'communication-body', projectId: value.project_id, record: value.record, deliveryId: value.delivery_id, partId: value.part_id })
      : json({ kind: 'native-body', source }),
      version: source === undefined ? json({ snapshotVersion: value.snapshot_version, snapshotIdentity: value.snapshot_identity })
        : json({ sessionCreatedAt: source.sessionCreatedAt, eventSpace: source.eventSpace, eventSeq: source.eventSeq, eventDigest: source.eventDigest, body: source.body }),
      range: json(value.range), use: 'historical-evidence' }, value.text)
    if (value.evidenceUse === 'historical-evidence') return value
    changed()
    return { ...value, evidenceUse: 'historical-evidence' }
  }
  if (!Array.isArray(value.items)) return value
  let compacted = false
  const items = value.items.map((raw, index) => {
    if (!historicalItem(record(raw))) return raw
    const item = visibleSourceItemForModel(raw) as RecordValue
    if (item !== raw) compacted = true
    const source = record(item.nativeSource)!
    const identity = {
      source: json({ kind: 'native-event', nativeSource: source, role: item.role, kindName: item.kind }),
      version: source.kind === 'native-event' ? json({ sessionCreatedAt: source.sessionCreatedAt, eventSpace: source.eventSpace, eventSeq: source.eventSeq, eventDigest: source.eventDigest, body: source.body }) : json({ seq: item.seq, messageId: item.messageId, toolCallId: item.toolCallId }),
      use: 'historical-evidence' as const,
    }
    const range = { bodyRange: item.bodyRange, bodySource: item.bodySource, partial: item.partial === true, limitations: item.limitations ?? [], attachments: item.attachments ?? [] }
    if (typeof item.text === 'string') occurrence([...path, 'items', index, 'text'], { ...identity,
      range: json({ kind: 'visible-event-text', ...range }) }, item.text)
    else for (const body of historicalVisibleStrings(item.visibleBlocks)) occurrence([...path, 'items', index, 'visibleBlocks', ...body.path], { ...identity,
      range: json({ kind: 'visible-event-block-text', ...range, blockPath: body.path }) }, body.text)
    return item
  })
  if (compacted) changed()
  const projected = compacted ? { ...value, items } : value
  if (value.evidenceUse === 'historical-evidence') return projected
  changed()
  return { ...projected, evidenceUse: 'historical-evidence',
    evidenceNotice: 'items是实际取得的当时原生事件及可见范围，仅作历史证据；不能据此恢复已修订或撤回记忆的当前效力。' }
}

function historicalItem(item: RecordValue | undefined): boolean {
  return isHistoricalSourceItem(item)
}

/** Ordered visible strings keep their exact block path; same text at another path is another fact. */
function historicalVisibleStrings(value: unknown): readonly { readonly path: Path; readonly text: string }[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((value, index) => {
    const block = record(value)
    if (block?.type === 'text' && typeof block.text === 'string') return [{ path: [index, 'text'], text: block.text }]
    if (block?.type === 'quoted-tool-call' && typeof block.arguments === 'string') return [{ path: [index, 'arguments'], text: block.arguments }]
    if (block?.type === 'quoted-tool-result') return historicalVisibleStrings(block.content).map(body => ({ path: [index, 'content', ...body.path], text: body.text }))
    return []
  })
}

function memoryRead(value: RecordValue | undefined, projectId: string): MemoryRead | undefined {
  const scope = record(value?.scope)
  if (value === undefined || value.projectId !== projectId || typeof value.id !== 'string' || !Number.isSafeInteger(value.revision)
    || typeof value.body !== 'string' || scope === undefined || !['project', 'session', 'file', 'topic'].includes(String(scope.kind)) || !Array.isArray(value.sources)) return
  const identity = memoryReadIdentity(value, projectId)
  return identity === undefined ? undefined : { ...identity, projectId, body: value.body }
}

/** 同一消息的所有被选正文一次渲染；路径或原正文不匹配时拒绝省略。 */
function renderOmissions(history: readonly RequestCandidateMessage[], omitted: readonly RequestBodyOccurrence[]): readonly RequestContentProjection[] {
  const result: RequestContentProjection[] = []
  const byMessage = new Map<MessageId, RequestBodyOccurrence[]>()
  for (const item of omitted) byMessage.set(item.messageId, [...(byMessage.get(item.messageId) ?? []), item])
  if (byMessage.size === 0) return result
  const messages = firstMessagesById(history)
  for (const [messageId, occurrences] of byMessage) {
    const item = messages.get(messageId)
    if (item === undefined || item.message.role !== 'tool' || item.message.isError) throw new Error('重复正文不属于当前成功工具结果。')
    let content: readonly ContentBlock[] = item.message.content
    for (const occurrence of occurrences) {
      const [blockIndex, ...path] = occurrence.selector
      if (typeof blockIndex !== 'number') throw new Error('重复正文的block定位无效。')
      const block = content[blockIndex]
      if (block?.type !== 'text') throw new Error('重复正文的原text block不可用。')
      const next = replaceBody(block.text, path, occurrence.body)
      content = content.map((block, index) => index === blockIndex ? { type: 'text' as const, text: next as string } : block)
    }
    result.push({ messageId, content })
  }
  return result
}

function replaceBody(value: unknown, path: Path, body: string): unknown {
  if (path.length === 0) {
    if (value !== body) throw new Error('重复正文已变化，不能省略。')
    return '[重复正文已省略；本次实际输入中保留另一份完整正文，调用与来源事实不变。]'
  }
  const [part, ...rest] = path
  if (part === '$json') {
    if (typeof value !== 'string') throw new Error('重复正文的JSON定位无效。')
    const parsed = parse(value)
    if (parsed === undefined) throw new Error('重复正文的完整JSON不可读。')
    return JSON.stringify(replaceBody(parsed, rest, body))
  }
  if (Array.isArray(value) && typeof part === 'number' && part in value) return value.map((child, index) => index === part ? replaceBody(child, rest, body) : child)
  const object = record(value)
  if (object !== undefined && typeof part === 'string' && Object.hasOwn(object, part)) return { ...object, [part]: replaceBody(object[part], rest, body) }
  throw new Error('重复正文的精确子对象定位已失效。')
}
function parse(text: string): unknown { try { return JSON.parse(text) } catch { return undefined } }
function record(value: unknown): RecordValue | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : undefined }
function json(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue }

/** 保留原find的首次匹配；索引只属于当前调用中的这一份历史。 */
function firstMessagesById(history: readonly RequestCandidateMessage[]): Map<MessageId | undefined, RequestCandidateMessage> {
  const messages = new Map<MessageId | undefined, RequestCandidateMessage>()
  for (const item of history) {
    const id = item.message.id
    if (!messages.has(id)) messages.set(id, item)
  }
  return messages
}

/** 顺序合并既有请求投影；每个producer仍只渲染自己证明的正文。 */
export function combineProjectHistoryProjections(...input: readonly (RequestHistoryProjection | undefined)[]): RequestHistoryProjection {
  const projections = input.filter((projection): projection is RequestHistoryProjection => projection !== undefined)
  const apply = (history: readonly RequestCandidateMessage[], changes: readonly RequestContentProjection[] = [], excluded: readonly MessageId[] = []) => {
    const byId = new Map(changes.map(change => [change.messageId, change.content]))
    const ids = new Set(excluded)
    return history.filter(item => item.message.id === undefined || !ids.has(item.message.id)).map(item => {
      const content = item.message.id === undefined ? undefined : byId.get(item.message.id)
      return content === undefined ? item : { ...item, message: { ...item.message, content } }
    })
  }
  const differences = (before: readonly RequestCandidateMessage[], after: readonly RequestCandidateMessage[]) => {
    const messages = firstMessagesById(before)
    return after.flatMap(item => {
      const id = item.message.id
      const original = messages.get(id)
      return id !== undefined && original !== undefined && !isDeepStrictEqual(original.message.content, item.message.content)
        ? [{ messageId: id, content: item.message.content }] : []
    })
  }
  return {
    projectCurrentness(history) {
      let current = history
      const excluded: MessageId[] = []
      const occurrences: RequestBodyOccurrence[] = []
      const contextSections = new Map<MessageId, readonly ContextSnapshotSection[]>()
      for (const projection of projections) {
        const result = projection.projectCurrentness(current)
        current = apply(current, result.overrides, result.excludeMessageIds)
        excluded.push(...(result.excludeMessageIds ?? []))
        occurrences.push(...(result.occurrences ?? []))
        for (const row of result.contextSections ?? []) contextSections.set(row.messageId, row.sections)
      }
      const messages = firstMessagesById(current)
      return { overrides: differences(history, current), excludeMessageIds: [...new Set(excluded)],
        contextSections: [...contextSections].flatMap(([messageId, sections]) => messages.has(messageId) ? [{ messageId, sections }] : []),
        occurrences: occurrences.filter(occurrence => {
          const item = messages.get(occurrence.messageId)
          return item !== undefined && selectedBody(item.message.content, occurrence.selector) === occurrence.body
        }) }
    },
    renderOmissions(history, omitted) {
      let current = history
      for (const projection of projections) {
        const owned = projection.projectCurrentness(current).occurrences ?? []
        const selected = omitted.filter(occurrence => owned.some(candidate => candidate.messageId === occurrence.messageId
          && isDeepStrictEqual(candidate.selector, occurrence.selector) && candidate.body === occurrence.body && isDeepStrictEqual(candidate.identity, occurrence.identity)))
        if (selected.length > 0) current = apply(current, projection.renderOmissions(current, selected))
      }
      return differences(history, current)
    },
  }
}
function selectedBody(content: readonly ContentBlock[], selector: Path): unknown {
  const [blockIndex, ...path] = selector
  if (typeof blockIndex !== 'number') return
  const block = content[blockIndex]
  if (block?.type !== 'text') return
  let value: unknown = block.text
  for (const part of path) {
    if (part === '$json') { if (typeof value !== 'string') return; value = parse(value) }
    else if (Array.isArray(value) && typeof part === 'number') value = value[part]
    else { const object = record(value); if (object === undefined || typeof part !== 'string') return; value = object[part] }
  }
  return value
}

function containsExactValue(value: unknown, target: unknown): boolean {
  // 外层只打印历史事件时，不能因item.text内恰好含同版Memory JSON而承认隐藏读取已供给。
  if (historicalItem(record(value)) || record(value)?.evidenceUse === 'historical-evidence') return false
  if (isDeepStrictEqual(value, target)) return true
  if (typeof value === 'string') { const parsed = parse(value); return parsed !== undefined && containsExactValue(parsed, target) }
  if (Array.isArray(value)) return value.some(child => containsExactValue(child, target))
  const object = record(value)
  return object !== undefined && Object.values(object).some(child => containsExactValue(child, target))
}
