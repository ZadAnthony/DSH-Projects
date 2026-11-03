/** Lossless communication rendering and bounded reads of one immutable saved content stream. */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { canonicalJson, canonicalJsonWindow, countCanonicalJsonPoints, communicationError, digestJson, jsonFrozen, snapshotCodec, validateJsonSerialization, validateLocator, validateSnapshot } from './contract.ts'
import { sliceCodePoints } from '../canonical-chunks.ts'
import type { CommunicationRecordLocator, CommunicationSnapshotV1, CommunicationVisibleBlock } from './contract.ts'
import type { CommunicationAttachmentAccess, CommunicationAttachmentVerifier } from './visible-reader.ts'
import { communicationSavedContents, communicationSavedPartSource } from './saved-parts.ts'

export type * from './content-types.ts'
import type { CommunicationContentBudget, CommunicationContentRequest, CommunicationContentPage, CommunicationContentDirectory } from './content-types.ts'

export const COMMUNICATION_CONTENT_DEFAULT_LIMIT = 4096
export const COMMUNICATION_CONTENT_LIMIT_MAX = 16384

export function buildCommunicationContentDirectory(snapshot: CommunicationSnapshotV1, record: CommunicationRecordLocator): CommunicationContentDirectory {
  validateLocator(record)
  return jsonFrozen({ format: 'projects-communication-directory/v1', delivery_id: snapshot.deliveryId, snapshot_version: 1,
    contents: communicationSavedContents(snapshot).map(item => {
      const total = countCanonicalJsonPoints(item.readValue)
      return { part_id: item.id, group: item.group, original_speaker: item.speaker, content_digest: item.visibleDigest,
        source: communicationSavedPartSource(snapshot, record, item.id), range: { unit: 'unicode-code-points' as const, start: 0, end: total, total },
        read_content: { action: 'read_content' as const, record, snapshot_version: 1 as const, delivery_id: snapshot.deliveryId, part_id: item.id } }
    }) })
}

/** All role and content values are JSON-escaped. Quoted calls/results never become executable tool blocks. */
export function renderCommunicationContent(snapshot: CommunicationSnapshotV1, options: { readonly record?: CommunicationRecordLocator; readonly nativeMessageId?: string; readonly context?: 'entry' } = {}): ContentBlock[] {
  validateSnapshot(snapshot)
  validateJsonSerialization(snapshot)
  const contextEntry = options.context === 'entry' && snapshot.contextParts.length > 0
  if (contextEntry && options.record === undefined) throw communicationError('COMMUNICATION_INPUT_INVALID', 'Context entries require the exact saved communication holder')
  const directory = options.record === undefined ? undefined : buildCommunicationContentDirectory(snapshot, options.record)
  const suppliedDirectory = contextEntry ? { ...directory!, contents: directory!.contents.map(item => {
    const part = snapshot.contextParts.find(part => part.id === item.part_id)
    return { ...item, ...(part === undefined ? {} : { producer: part.producer, origin: part.origin, source_chain: part.sourceChain, version: part.version }), inline_provided: item.group !== 'context' }
  }) } : directory
  const content: ContentBlock[] = []
  const line = (value: unknown) => content.push({ type: 'text', text: JSON.stringify(value) + '\n' })
  line({ communication_manifest: { format: snapshot.format, delivery_id: snapshot.deliveryId, operation_ref: snapshot.operationRef, snapshot_version: snapshot.snapshotVersion, mode: contextEntry ? 'context-entry' : 'full', ...(options.nativeMessageId === undefined ? {} : { native_message_id: options.nativeMessageId }), ...(suppliedDirectory === undefined ? {} : { directory: suppliedDirectory }) }, sender: snapshot.sender, recipient: snapshot.recipient, created_at: snapshot.createdAt, ...(snapshot.replyTo === undefined ? {} : { reply_to: snapshot.replyTo }), ...(contextEntry ? { note: 'Agent message and selected human-user originals are supplied below. Context bodies are not supplied or read; choose exact saved read_content entries as needed. Origin links preserve provenance and do not replace the independently saved recipient copy.' } : {}) })
  if (snapshot.agentMessage !== undefined) line({ communication_agent_message: snapshot.agentMessage })
  for (const [group, parts] of [['user-message', snapshot.userMessageParts], ['context', snapshot.contextParts]] as const) for (const part of parts) {
    if (contextEntry && group === 'context') continue
    const { blocks, ...metadata } = part
    line({ communication_part_start: { group, ...metadata } })
    const blockLine = (block: CommunicationVisibleBlock, index: number, parent?: number) => {
      if (block.type === 'quoted-tool-result') {
        const { content: nested, ...metadata } = block
        line({ quoted_tool_result_start: { index, ...metadata } })
        for (const [nestedIndex, inner] of nested.entries()) blockLine(inner, nestedIndex, index)
        line({ quoted_tool_result_end: { index } })
      } else {
        line({ communication_block: { index, ...(parent === undefined ? {} : { parent_result_index: parent }), ...block } })
        if (block.type === 'file' || block.type === 'image') content.push(jsonFrozen(block) as ContentBlock)
      }
    }
    for (const [index, block] of blocks.entries()) blockLine(block, index)
    line({ communication_part_end: { part_id: part.id } })
  }
  return content
}

interface ContentCursor {
  readonly format: 'projects-communication-content-cursor/v1'
  readonly projectId: string
  readonly record: CommunicationRecordLocator
  readonly deliveryId: string
  readonly snapshotVersion: 1
  readonly snapshotIdentity: string
  readonly partId: string
  readonly contentIdentity: string
  readonly start: number
  readonly total: number
}
export class CommunicationContentReader {
  constructor(private readonly deps: {
    readSnapshot(projectId: string, record: CommunicationRecordLocator, signal?: AbortSignal): Promise<CommunicationSnapshotV1 | undefined>
    verifyAttachment: CommunicationAttachmentVerifier
  }) {}
  async readContent(projectId: string, request: CommunicationContentRequest, budget: CommunicationContentBudget, signal?: AbortSignal): Promise<CommunicationContentPage> {
    validateLocator(request.record); signal?.throwIfAborted()
    if (request.snapshot_version !== 1) throw communicationError('COMMUNICATION_FORMAT_UNSUPPORTED', 'Unsupported saved snapshot version')
    const limit = request.limit ?? COMMUNICATION_CONTENT_DEFAULT_LIMIT
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > COMMUNICATION_CONTENT_LIMIT_MAX) throw communicationError('COMMUNICATION_CONTENT_ARGUMENTS_INVALID', `Body limit must be 1–${COMMUNICATION_CONTENT_LIMIT_MAX} Unicode code points`)
    const snapshot = await this.deps.readSnapshot(projectId, request.record, signal)
    if (snapshot === undefined || snapshot.projectId !== projectId || snapshot.deliveryId !== request.delivery_id) throw communicationError('COMMUNICATION_CONTENT_UNAVAILABLE', 'The requested saved holder/record is unavailable')
    const selected = communicationSavedContents(snapshot).find(item => item.id === request.part_id)
    if (selected === undefined) throw communicationError('COMMUNICATION_CONTENT_UNAVAILABLE', 'The exact saved part does not exist')
    const part = [...snapshot.userMessageParts, ...snapshot.contextParts].find(part => part.id === request.part_id)
    const value = selected.readValue
    const cursor = request.cursor === undefined ? undefined : decodeCursor(request.cursor)
    const start = cursor?.start ?? 0
    if (!Number.isSafeInteger(start) || start < 0) throw communicationError('COMMUNICATION_CURSOR_INVALID', 'Content cursor range is invalid')
    const { text: window, total } = canonicalJsonWindow(value, start, start + limit)
    const identity = snapshotCodec.identity(snapshot), contentIdentity = digestJson(value)
    const common = { format: 'projects-communication-content-cursor/v1' as const, projectId, record: request.record, deliveryId: snapshot.deliveryId, snapshotVersion: 1 as const, snapshotIdentity: identity, partId: request.part_id, contentIdentity, total }
    if (cursor !== undefined) {
      const { start: position, ...binding } = cursor
      if (canonicalJson(binding) !== canonicalJson(common) || !Number.isSafeInteger(position) || position < 0 || position > total) throw communicationError('COMMUNICATION_CURSOR_INVALID', 'Content cursor does not match this project, holder, record, snapshot, part or range')
    }
    const attachments: CommunicationAttachmentAccess[] = []
    if (part !== undefined) for (const block of part.blocks) for (const plain of block.type === 'quoted-tool-result' ? block.content : [block]) {
      signal?.throwIfAborted()
      if (plain.type === 'file' || plain.type === 'image') attachments.push(await this.deps.verifyAttachment(plain, signal, request.record.holder.hostSessionId))
    }
    const page = (end: number): CommunicationContentPage => jsonFrozen({ format: 'projects-communication-content/v1', project_id: projectId, record: request.record, delivery_id: snapshot.deliveryId, snapshot_version: 1, snapshot_identity: identity, part_id: request.part_id, original_speaker: part?.originalSpeaker ?? 'assistant', source_chain: part?.sourceChain ?? [], encoding: 'canonical-json', text: sliceCodePoints(window, 0, end - start), range: { unit: 'unicode-code-points', start, end, total }, complete: start === 0 && end === total, end_of_content: end === total, same_page_cursor: encodeCursor({ ...common, start }), ...(end === total ? {} : { next_cursor: encodeCursor({ ...common, start: end }) }), attachments })
    const cap = budget.maxInlineTokens
    if (cap !== undefined && (!Number.isSafeInteger(cap) || cap < 0)) throw communicationError('COMMUNICATION_CONTENT_BUDGET_INVALID', 'Tool result retention budget is invalid')
    const fits = (candidate: CommunicationContentPage): boolean => {
      const cost = budget.estimate(renderCommunicationContentPage(candidate))
      if (!Number.isFinite(cost) || cost < 0) throw communicationError('COMMUNICATION_CONTENT_BUDGET_INVALID', 'Tool result estimate is unavailable')
      return cap === undefined || cost <= cap
    }
    const publish = async (candidate: CommunicationContentPage): Promise<CommunicationContentPage> => {
      const current = await this.deps.readSnapshot(projectId, request.record, signal)
      if (current === undefined || snapshotCodec.identity(current) !== identity) throw communicationError('COMMUNICATION_CONTENT_UNAVAILABLE', 'The saved holder or snapshot changed during this content read')
      signal?.throwIfAborted()
      return candidate
    }
    const end = Math.min(total, start + limit)
    if (fits(page(end))) return publish(page(end))
    let low = start, high = end - 1
    while (low < high) { const middle = Math.ceil((low + high) / 2); if (fits(page(middle))) low = middle; else high = middle - 1 }
    const result = page(low)
    if ((low === start && start < total) || !fits(result)) throw communicationError('COMMUNICATION_CONTENT_CAPACITY_UNAVAILABLE', 'The actual tool output budget cannot retain a content page and its continuation manifest')
    signal?.throwIfAborted()
    return publish(result)
  }
}
export function renderCommunicationContentPage(page: CommunicationContentPage): ContentBlock[] { return [{ type: 'text', text: JSON.stringify(page) }] }

/** Called after actual post-execute spill. A damaged inline page continues from its own start. */
export function finalizeCommunicationContentPage(page: CommunicationContentPage, retained: readonly ContentBlock[], budget: CommunicationContentBudget): ContentBlock[] {
  const canonical = renderCommunicationContentPage(page)
  if (canonicalJson(retained) === canonicalJson(canonical)) return canonical
  const notice: ContentBlock = { type: 'text', text: JSON.stringify({ communication_content_retention: { delivery_id: page.delivery_id, part_id: page.part_id, inline_complete: false, same_page_cursor: page.same_page_cursor, read_content: { action: 'read_content', record: page.record, delivery_id: page.delivery_id, snapshot_version: page.snapshot_version, part_id: page.part_id, cursor: page.same_page_cursor }, note: 'The page was changed by output retention. Use the retained spill path or re-read this same page; next_cursor does not establish that its text was read.' } }) }
  let result = [...retained, notice]
  if (budget.maxInlineTokens !== undefined && budget.estimate(result) > budget.maxInlineTokens) {
    // A retained preview may already occupy its whole allowance. The real spill
    // owner can provide this occurrence's canonical notice without trusting a
    // locator-shaped string that happened to occur in the quoted page.
    const recovery = budget.recoveryContent?.()
    if (recovery !== undefined) result = [...recovery, notice]
    if (recovery === undefined || budget.estimate(result) > budget.maxInlineTokens) throw communicationError('COMMUNICATION_CONTENT_CAPACITY_UNAVAILABLE', 'Output retention left no room for a valid spill locator and same-page recovery manifest')
  }
  return result
}
function encodeCursor(cursor: ContentCursor): string {
  return Buffer.from(JSON.stringify({ cursor, checksum: digestJson(cursor) }), 'utf8').toString('base64url')
}
function decodeCursor(value: string): ContentCursor {
  try {
    if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('encoding')
    const raw = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { cursor: ContentCursor; checksum: string }
    if (raw.cursor?.format !== 'projects-communication-content-cursor/v1' || raw.checksum !== digestJson(raw.cursor) || encodeCursor(raw.cursor) !== value) throw new Error('binding')
    return raw.cursor
  } catch { throw communicationError('COMMUNICATION_CURSOR_INVALID', 'Content cursor is invalid') }
}
