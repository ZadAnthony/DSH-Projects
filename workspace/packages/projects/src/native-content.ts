/** Bounded visible native bodies using the communication canonical JSON and retention protocol. */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { canonicalJson, communicationError, jsonFrozen } from './communication/contract.ts'
import type { CommunicationContentBudget } from './communication/content-types.ts'
import type { CommunicationAttachmentBlock, CommunicationAttachmentVerifier } from './communication/visible-reader.ts'
import type { CommunicationVisibleBlock } from './communication/types.ts'
import type { NativeProjectSourceRead } from './source-types.ts'
import { canonicalSourceJson, decodeNativeEventSource } from './native-source.ts'
import { nativeSourceDigest } from './native-source-host.ts'
import { canonicalCodePointLength, canonicalWindow, sliceCodePoints } from './canonical-chunks.ts'
import type { NativeEventSource } from './source-reference-types.ts'
export type * from './native-content-types.ts'
import type { NativeContentRequest, NativeContentPage, NativeContentAttachmentAccess } from './native-content-types.ts'

export const NATIVE_CONTENT_DEFAULT_LIMIT = 4096
export const NATIVE_CONTENT_LIMIT_MAX = 16384
interface NativeCursor {
  readonly format: 'projects-native-content-cursor/v1'
  readonly source: NativeEventSource
  readonly start: number
  readonly total: number
  readonly selectionStart: number
  readonly selectionEnd: number
}
export class NativeContentReader {
  constructor(private readonly readSource: (projectId: string, source: NativeEventSource, signal?: AbortSignal) => Promise<NativeProjectSourceRead>,
    private readonly verifyAttachment?: CommunicationAttachmentVerifier) {}
  async readContent(projectId: string, request: NativeContentRequest, budget: CommunicationContentBudget, signal?: AbortSignal): Promise<NativeContentPage> {
    const input = decodeNativeEventSource(request.source)
    if (input.projectId !== projectId) throw communicationError('PROJECT_HISTORY_SOURCE_INVALID', 'Body source belongs to another Project')
    const limit = request.limit ?? NATIVE_CONTENT_DEFAULT_LIMIT
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > NATIVE_CONTENT_LIMIT_MAX) throw communicationError('PROJECT_HISTORY_ARGUMENTS_INVALID', `Body limit must be 1–${NATIVE_CONTENT_LIMIT_MAX} Unicode code points`)
    const read = await this.readSource(projectId, input, signal)
    signal?.throwIfAborted()
    if (!read.resolved) throw communicationError('PROJECT_HISTORY_CONTENT_UNAVAILABLE', read.reason ?? 'The exact body source is unavailable')
    const target = read.items.filter(item => item.isTarget)
    if (target.length !== 1) throw communicationError('PROJECT_HISTORY_SOURCE_INVALID', 'One exact visible record is required for a body stream')
    const value = target[0]!.visibleBlocks ?? []
    const digest = nativeSourceDigest(value), total = canonicalCodePointLength(value)
    if (input.body !== undefined && (input.body.stream === 'tool-value' || input.body.digest !== digest)) throw communicationError('PROJECT_HISTORY_SOURCE_INVALID', 'Native body stream is unavailable or changed')
    const source: NativeEventSource = { ...input, body: input.body ?? { stream: 'visible-blocks', codec: 'canonical-json/v1', digest } }
    const selectionStart = source.body?.range?.start ?? 0, selectionEnd = source.body?.range?.end ?? total
    if (selectionStart > total || selectionEnd > total) throw communicationError('PROJECT_HISTORY_SOURCE_INVALID', 'Body range is outside this exact content')
    const common = { format: 'projects-native-content-cursor/v1' as const, source, total, selectionStart, selectionEnd }
    let start = selectionStart
    if (request.cursor !== undefined) {
      const cursor = decodeCursor(request.cursor)
      const { start: position, ...binding } = cursor
      if (canonicalSourceJson(binding) !== canonicalSourceJson(common) || !Number.isSafeInteger(position) || position < selectionStart || position > selectionEnd) throw communicationError('PROJECT_HISTORY_CURSOR_INVALID', 'Body cursor does not match the exact source, stream, version and selection')
      start = position
    }
    const maximumEnd = Math.min(selectionEnd, start + limit)
    const window = canonicalWindow(value, start, maximumEnd).text
    const attachments: NativeContentAttachmentAccess[] = []
    for (const descriptor of attachmentDescriptors(value)) {
      // A range-scoped source does not authorize expanding a partly selected
      // descriptor. A text page may split that descriptor, so expose its exact
      // range separately without claiming the unshown message text was read.
      if (descriptor.start < selectionStart || descriptor.end > selectionEnd || descriptor.end <= start || descriptor.start >= maximumEnd) continue
      const common = { block: descriptor.block, descriptor_range: { unit: 'unicode-code-points' as const, start: descriptor.start, end: descriptor.end, total } }
      try {
        if (this.verifyAttachment === undefined) throw new Error('Attachment access is unavailable for this reader')
        const access = await this.verifyAttachment(descriptor.block, signal)
        signal?.throwIfAborted()
        if (canonicalJson(access.block) !== canonicalJson(descriptor.block) || !access.readonlyPath.trim()) throw new Error('Verified attachment access does not match this exact descriptor')
        attachments.push({ ...common, status: 'available', readonlyPath: access.readonlyPath })
      } catch (error) {
        signal?.throwIfAborted()
        attachments.push({ ...common, status: 'unavailable', reason: error instanceof Error ? error.message : String(error) })
      }
    }
    const page = (end: number): NativeContentPage => {
      const visibleAttachments = attachments.filter(item => item.descriptor_range.start < end && item.descriptor_range.end > start)
      return jsonFrozen({ format: 'projects-native-content/v1', project_id: projectId, source, encoding: 'canonical-json',
      text: sliceCodePoints(window, 0, end - start), range: { unit: 'unicode-code-points', start, end, total }, selected_range: { start: selectionStart, end: selectionEnd },
      complete: start === selectionStart && end === selectionEnd, end_of_content: end === total, end_of_selection: end === selectionEnd,
      same_page_cursor: encodeCursor({ ...common, start }), ...(end === selectionEnd ? {} : { next_cursor: encodeCursor({ ...common, start: end }) }),
      ...(visibleAttachments.length === 0 ? {} : { attachments: visibleAttachments,
        attachment_access_notice: 'These are read-only attachment access entries, not attachment bodies. Read available paths with the file/image tools when needed. descriptor_range locates the complete descriptor in this selected message stream; it does not mark unshown message text or attachment bytes as read.' }) })
    }
    const cap = budget.maxInlineTokens
    if (cap !== undefined && (!Number.isSafeInteger(cap) || cap < 0)) throw communicationError('PROJECT_HISTORY_CONTENT_BUDGET_INVALID', 'Invalid retention budget')
    const fits = (candidate: NativeContentPage) => {
      const cost = budget.estimate(renderNativeContentPage(candidate))
      if (!Number.isFinite(cost) || cost < 0) throw communicationError('PROJECT_HISTORY_CONTENT_BUDGET_INVALID', 'Retention estimate is unavailable')
      return cap === undefined || cost <= cap
    }
    let low = start, high = maximumEnd
    if (fits(page(high))) low = high
    else { while (low < high) { const middle = Math.ceil((low + high) / 2); if (fits(page(middle))) low = middle; else high = middle - 1 } }
    const result = page(low)
    if ((low === start && start < selectionEnd) || !fits(result)) throw communicationError('PROJECT_HISTORY_CONTENT_CAPACITY_UNAVAILABLE', 'No room for a native body page and its continuation manifest')
    // Source disposition is rechecked after all asynchronous work before publication.
    const current = await this.readSource(projectId, source, signal)
    if (!current.resolved) throw communicationError('PROJECT_HISTORY_CONTENT_UNAVAILABLE', current.reason ?? 'The source changed during reading')
    const currentTargets = current.items.filter(item => item.isTarget)
    if (currentTargets.length !== 1 || nativeSourceDigest(currentTargets[0]!.visibleBlocks ?? []) !== digest) throw communicationError('PROJECT_HISTORY_CONTENT_UNAVAILABLE', 'The exact body changed during attachment access')
    signal?.throwIfAborted()
    return result
  }
}
/** Locate only typed visible attachment blocks in the unchanged canonical stream. */
function attachmentDescriptors(blocks: readonly CommunicationVisibleBlock[]) {
  const descriptors: Array<{ block: CommunicationAttachmentBlock; start: number; end: number }> = []
  let offset = 1 // opening array bracket
  for (const [index, block] of blocks.entries()) {
    if (index !== 0) offset++
    const length = canonicalCodePointLength(block)
    if (block.type === 'file' || block.type === 'image') descriptors.push({ block, start: offset, end: offset + length })
    else if (block.type === 'quoted-tool-result') {
      let contentStart = offset + 1 // opening object brace
      const entries = Object.entries(block).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      for (const [index, [key, value]] of entries.entries()) {
        if (index !== 0) contentStart++
        contentStart += canonicalCodePointLength(key) + 1
        if (key === 'content') break
        contentStart += canonicalCodePointLength(value)
      }
      let nested = contentStart + 1
      for (const [index, inner] of block.content.entries()) {
        if (index !== 0) nested++
        const size = canonicalCodePointLength(inner)
        if (inner.type === 'file' || inner.type === 'image') descriptors.push({ block: inner, start: nested, end: nested + size })
        nested += size
      }
    }
    offset += length
  }
  return descriptors
}

export function renderNativeContentPage(page: NativeContentPage): ContentBlock[] { return [{ type: 'text', text: JSON.stringify(page) }] }
export function finalizeNativeContentPage(page: NativeContentPage, retained: readonly ContentBlock[], budget: CommunicationContentBudget): ContentBlock[] {
  const canonical = renderNativeContentPage(page)
  if (canonicalJson(retained) === canonicalJson(canonical)) return canonical
  const notice: ContentBlock = { type: 'text', text: JSON.stringify({ native_content_retention: { source: page.source, inline_complete: false,
    same_page_cursor: page.same_page_cursor, read_content: { action: 'read_content', source: page.source, cursor: page.same_page_cursor },
    note: 'Output retention changed this page. Read the actual retained spill or recover this same page; next_cursor does not prove earlier text was delivered.' } }) }
  let result = [...retained, notice]
  if (budget.maxInlineTokens !== undefined && budget.estimate(result) > budget.maxInlineTokens) {
    const recovery = budget.recoveryContent?.()
    if (recovery !== undefined) result = [...recovery, notice]
    if (recovery === undefined || budget.estimate(result) > budget.maxInlineTokens) throw communicationError('PROJECT_HISTORY_CONTENT_CAPACITY_UNAVAILABLE', 'No room for the actual spill and same-page recovery manifest')
  }
  return result
}
function encodeCursor(cursor: NativeCursor): string { return encodeURIComponent(JSON.stringify(cursor)) }
function decodeCursor(value: string): NativeCursor {
  try {
    const raw = JSON.parse(decodeURIComponent(value))
    if (raw === null || typeof raw !== 'object' || raw.format !== 'projects-native-content-cursor/v1') throw new Error('Wrong cursor kind')
    const source = decodeNativeEventSource(raw.source)
    if (![raw.start, raw.total, raw.selectionStart, raw.selectionEnd].every(item => Number.isSafeInteger(item) && item >= 0)) throw new Error('Wrong cursor range')
    return { format: raw.format, source, start: raw.start, total: raw.total, selectionStart: raw.selectionStart, selectionEnd: raw.selectionEnd }
  } catch { throw communicationError('PROJECT_HISTORY_CURSOR_INVALID', 'Invalid native body cursor') }
}
