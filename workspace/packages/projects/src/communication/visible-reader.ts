/** Exact, ordered visible source reads. Retained directory admission remains owned by core/source-reader. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { CommunicationSourceFailure } from './types.ts'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '../stock/read/index.ts'
import { readNativeProjectSourceFromDirectory } from '../source-reader.ts'
import { canonicalJson, communicationError, digestJson, jsonFrozen, snapshotCodec, validateSource } from './contract.ts'
import type { CommunicationPartV1, CommunicationPlainVisibleBlock, CommunicationRecordLocator, CommunicationSnapshotV1, CommunicationSource, CommunicationVisibleBlock, CommunicationVisibleRead } from './contract.ts'
import type { CommunicationSourceResolver } from './service.ts'
import { COMMUNICATION_AGENT_PART_ID, savedAgentMessagePartFromDirectory } from './saved-parts.ts'
import type { CommunicationDirectoryReader } from './directory.ts'

export interface CommunicationVisibleProjection {
  readonly blocks: readonly CommunicationVisibleBlock[]
  readonly hiddenExcluded: CommunicationVisibleRead['hiddenExcluded']
  readonly missingVisible: CommunicationVisibleRead['missingVisible']
}
export type CommunicationAttachmentBlock = Extract<CommunicationPlainVisibleBlock, { type: 'file' | 'image' }>
export interface CommunicationAttachmentAccess { readonly block: CommunicationAttachmentBlock; readonly readonlyPath: string }
export type CommunicationAttachmentVerifier = (block: CommunicationAttachmentBlock, signal?: AbortSignal, holderHostSessionId?: string) => Promise<CommunicationAttachmentAccess>
export interface CommunicationVisibleReaderDependencies {
  readDirectory: CommunicationDirectoryReader
  readSnapshot(projectId: string, record: CommunicationRecordLocator, signal?: AbortSignal): Promise<CommunicationSnapshotV1 | undefined>
  verifyAttachment: CommunicationAttachmentVerifier
}
type GuardedVisibleRead = CommunicationVisibleRead & { readonly nativeRevalidate?: () => Promise<void>; readonly savedIdentity?: string }

/** Only known visible data survives; hidden reasoning is separately accounted for. */
export function projectCommunicationVisibleBlocks(content: unknown, plainOnly = false): CommunicationVisibleProjection {
  const blocks: CommunicationVisibleBlock[] = [], hidden: Array<'reasoning' | 'internal-instructions'> = []
  const missing: Array<CommunicationVisibleRead['missingVisible'][number]> = []
  if (!Array.isArray(content)) return { blocks, hiddenExcluded: hidden, missingVisible: [{ code: 'MISSING_BLOCK' }] }
  for (const [blockIndex, raw] of content.entries()) {
    const block = object(raw)
    if (block?.type === 'reasoning') { hidden.push('reasoning'); continue }
    if (block?.type === 'text' && typeof block.text === 'string') blocks.push({ type: 'text', text: block.text })
    else if ((block?.type === 'file' || block?.type === 'image') && object(block.attachment) !== undefined
      && typeof object(block.attachment)?.attachmentId === 'string') {
      const blockKeys = block.type === 'image' ? ['type', 'attachment', 'offloaded'] : ['type', 'attachment']
      const refKeys = block.type === 'image' ? ['attachmentId', 'mediaType', 'bytes', 'width', 'height', 'name', 'originalDimensions'] : ['attachmentId', 'name', 'bytes']
      if (Object.keys(block).some(key => !blockKeys.includes(key)) || Object.keys(object(block.attachment)!).some(key => !refKeys.includes(key))) missing.push({ code: 'UNSUPPORTED_BLOCK', blockIndex })
      else if (block.type === 'image' && block.offloaded !== undefined && block.offloaded !== true) missing.push({ code: 'MISSING_BLOCK', blockIndex })
      else blocks.push(jsonFrozen(block) as unknown as CommunicationAttachmentBlock)
    } else if (!plainOnly && block?.type === 'tool-call' && typeof block.id === 'string' && typeof block.name === 'string' && typeof block.arguments === 'string') {
      blocks.push({ type: 'quoted-tool-call', toolCallId: block.id, name: block.name, arguments: block.arguments })
    } else missing.push({ code: block?.type === 'text' || block?.type === 'file' || block?.type === 'image' || block?.type === undefined ? 'MISSING_BLOCK' : 'UNSUPPORTED_BLOCK', blockIndex })
  }
  return jsonFrozen({ blocks, hiddenExcluded: [...new Set(hidden)], missingVisible: missing })
}

/** A human-readable compatibility projection, derived from ordered blocks rather than the reverse. */
export function communicationVisibleText(blocks: readonly CommunicationVisibleBlock[]): string {
  return blocks.map(block => {
    if (block.type === 'text') return block.text
    if (block.type === 'file' || block.type === 'image') return `[${block.type === 'file' ? '文件附件' : '图片附件'}：${block.attachment.name ?? '未命名附件'}，${block.attachment.bytes} bytes]`
    if (block.type === 'quoted-tool-call') return `[工具调用：${block.name}]\n${block.arguments}`
    return communicationVisibleText(block.content)
  }).join('\n')
}

/** Owner verifies immutable bytes and supplies the actual execution-readable path. */
export function communicationAttachmentVerifier(ctx: Context): CommunicationAttachmentVerifier {
  return async (block, signal, holderHostSessionId) => {
    signal?.throwIfAborted()
    const read = ctx.get('projectsRead')
    const store = holderHostSessionId !== undefined && read !== undefined
      ? await read.attachments.forCarrier(SessionId(holderHostSessionId)) : ctx.get('attachments')
    const fs = ctx.get('fs')
    if (store === undefined || fs === undefined) throw communicationError('COMMUNICATION_ATTACHMENT_UNAVAILABLE', 'Attachment owner or file access is unavailable')
    let hostPath: string | undefined
    if (block.type === 'image') { await store.readImage(block.attachment, signal); hostPath = store.imageHostPath(block.attachment) }
    else { for await (const _ of store.readFileStream(block.attachment, signal)) { signal?.throwIfAborted() }; hostPath = store.fileHostPath(block.attachment) }
    if (hostPath === undefined) throw communicationError('COMMUNICATION_ATTACHMENT_UNAVAILABLE', 'Attachment has no usable read-only path')
    const readonlyPath = fs.processPathFromHostPath(hostPath)
    if (readonlyPath === undefined) throw communicationError('COMMUNICATION_ATTACHMENT_UNAVAILABLE', 'Attachment path is outside the execution-readable filesystem')
    return jsonFrozen({ block, readonlyPath })
  }
}

export class CommunicationVisibleReader {
  constructor(private readonly deps: CommunicationVisibleReaderDependencies) {}
  async readSelected(projectId: string, source: CommunicationSource, selectedBy: CommunicationPartV1['selectedBy'], signal?: AbortSignal): Promise<CommunicationVisibleRead> {
    validateSource(source); signal?.throwIfAborted()
    let read: GuardedVisibleRead
    try {
      read = source.kind === 'communication-part'
        ? await this.saved(projectId, source, selectedBy, signal)
        : await this.native(projectId, source, selectedBy, signal)
    } catch (error) {
      signal?.throwIfAborted()
      return jsonFrozen({ source, visibleComplete: false, parts: [], hiddenExcluded: [], missingVisible: [{ code: 'SOURCE_UNAVAILABLE' }] })
    }
    const missing = [...read.missingVisible]
    for (const part of read.parts) for (const [blockIndex, block] of part.blocks.entries()) {
      const attachments = block.type === 'quoted-tool-result' ? block.content : [block]
      for (const attachment of attachments) if (attachment.type === 'file' || attachment.type === 'image') {
        try { await this.deps.verifyAttachment(attachment, signal, source.kind === 'communication-part' ? source.record.holder.hostSessionId : source.hostSessionId) }
        catch { signal?.throwIfAborted(); missing.push({ code: 'ATTACHMENT_UNAVAILABLE', blockIndex }) }
      }
    }
    // Attachment verification may await I/O. Reuse the same source owner after it,
    // rather than publishing a prefix acquired before a deletion/replacement cut.
    try {
      if (source.kind === 'communication-part') {
        const current = await this.deps.readSnapshot(projectId, source.record, signal)
        if (current === undefined || snapshotCodec.identity(current) !== read.savedIdentity) missing.push({ code: 'SOURCE_UNAVAILABLE' })
      } else {
        await read.nativeRevalidate!()
      }
    } catch { signal?.throwIfAborted(); missing.push({ code: 'SOURCE_UNAVAILABLE' }) }
    signal?.throwIfAborted()
    return jsonFrozen({ source: read.source, parts: read.parts, hiddenExcluded: read.hiddenExcluded, visibleComplete: read.visibleComplete && missing.length === 0, missingVisible: missing })
  }
  readonly resolveSources: CommunicationSourceResolver = async input => {
    const failures: CommunicationSourceFailure[] = []
    const select = async (refs: readonly CommunicationSource[], group: CommunicationPartV1['selectedBy']['group']) => {
      const parts: CommunicationPartV1[] = []
      for (const [index, source] of refs.entries()) {
        const read = await this.readSelected(input.projectId, source, { group, index }, input.signal)
        const human = group !== 'user-message' || (read.parts.length > 0 && read.parts.every(part => part.originalSpeaker === 'user' && part.producer.kind === 'user'))
        if (!read.visibleComplete || !human) failures.push({ group, index, source, missing: human ? read.missingVisible : [{ code: 'SOURCE_UNAVAILABLE' }] })
        else parts.push(...read.parts)
      }
      return parts
    }
    const userMessageParts = await select(input.userMessageRefs, 'user-message')
    const contextParts = await select(input.contextRefs, 'context')
    if (failures.length) throw communicationError('COMMUNICATION_SOURCES_INCOMPLETE', 'Selected visible sources are unavailable; no communication was delivered', jsonFrozen(failures) as unknown as JsonValue)
    return jsonFrozen({ userMessageParts, contextParts })
  }
  private async saved(projectId: string, source: Extract<CommunicationSource, { kind: 'communication-part' }>, selectedBy: CommunicationPartV1['selectedBy'], signal?: AbortSignal): Promise<GuardedVisibleRead> {
    if (canonicalJson(source.holder) !== canonicalJson(source.record.holder)) throw communicationError('COMMUNICATION_SOURCE_INVALID', 'Saved source holder differs from record holder')
    const snapshot = await this.deps.readSnapshot(projectId, source.record, signal)
    if (snapshot === undefined || snapshot.projectId !== projectId || snapshot.deliveryId !== source.deliveryId || snapshot.snapshotVersion !== source.snapshotVersion) throw communicationError('COMMUNICATION_SOURCE_UNAVAILABLE', 'Saved snapshot is unavailable')
    if (source.partId === COMMUNICATION_AGENT_PART_ID) {
      const directory = await this.deps.readDirectory(projectId, source.holder.hostSessionId, signal)
      if (!directory.readable) throw communicationError('COMMUNICATION_SOURCE_UNAVAILABLE', directory.reason)
      const part = await savedAgentMessagePartFromDirectory(snapshot, source, selectedBy, directory, signal)
      return { source, visibleComplete: true, parts: [part], hiddenExcluded: [], missingVisible: [], savedIdentity: snapshotCodec.identity(snapshot) }
    }
    const original = [...snapshot.userMessageParts, ...snapshot.contextParts].find(part => part.id === source.partId)
    if (original === undefined) throw communicationError('COMMUNICATION_SOURCE_UNAVAILABLE', 'Saved part is unavailable')
    if (original.version.contentDigest !== digestJson(original.blocks)) throw communicationError('COMMUNICATION_SOURCE_INVALID', 'Saved part content identity does not match its version')
    const part = jsonFrozen({ ...original, id: partId(selectedBy, 0), selectedBy, acquiredFrom: source, sourceChain: [...original.sourceChain, source] })
    return { source, visibleComplete: true, parts: [part], hiddenExcluded: [], missingVisible: [], savedIdentity: snapshotCodec.identity(snapshot) }
  }
  private async native(projectId: string, source: Exclude<CommunicationSource, { kind: 'communication-part' }>, selectedBy: CommunicationPartV1['selectedBy'], signal?: AbortSignal): Promise<GuardedVisibleRead> {
    const directory = await this.deps.readDirectory(projectId, source.hostSessionId, signal)
    if (!directory.readable) throw communicationError('COMMUNICATION_SOURCE_UNAVAILABLE', directory.reason)
    const read = await readNativeProjectSourceFromDirectory(directory, source, { before: 0, after: 0,
      ...(signal === undefined ? {} : { signal }), fullBody: true })
    if (!read.resolved) throw communicationError('COMMUNICATION_SOURCE_UNAVAILABLE', read.reason ?? 'Exact native event is unavailable')
    const targets = read.items.filter(item => item.isTarget)
    const parts = targets.map((item, index) => {
      const blocks = item.visibleBlocks ?? []
      return jsonFrozen({ id: partId(selectedBy, index), selectedBy, originalSpeaker: item.speaker ?? 'unknown',
        producer: item.source ?? { kind: item.sourceKind ?? 'unknown' }, origin: source, originEventSeq: item.seq, originTime: item.time,
        acquiredFrom: source, version: { sessionCreatedAt: directory.sessionCreatedAt, prefixEventCount: directory.endSeq + 1, contentDigest: digestJson(blocks) }, sourceChain: [source], blocks })
    })
    const missing = targets.flatMap(item => item.missingVisible ?? [])
    await directory.revalidate()
    return { source, visibleComplete: targets.length > 0 && targets.every(item => item.visibleComplete === true) && missing.length === 0,
      parts, hiddenExcluded: [...new Set(targets.flatMap(item => item.hiddenExcluded ?? []))], missingVisible: missing,
      nativeRevalidate: directory.revalidate }
  }
}
function partId(selected: CommunicationPartV1['selectedBy'], index: number): string { return `${selected.group}:${selected.index}:${index}` }
function object(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
