/** Communication owns the copy decision; the carrier attachment port owns the bytes. */
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectAttachmentCopy, ProjectReadPort } from '../stock/read/index.ts'
import type { CommunicationSnapshotV1, CommunicationVisibleBlock } from './types.ts'
import { canonicalJson } from './contract.ts'

export async function copyCommunicationAttachments(read: ProjectReadPort, snapshot: CommunicationSnapshotV1, targetHostSessionId: string, options: { readonly fromSender?: boolean; readonly signal?: AbortSignal } = {}): Promise<void> {
  const copied = new Set<string>(), requests: ProjectAttachmentCopy[] = []
  for (const part of [...snapshot.userMessageParts, ...snapshot.contextParts]) {
    const sourceHost = options.fromSender ? snapshot.sender.hostSessionId
      : part.acquiredFrom.kind === 'communication-part' ? part.acquiredFrom.record.holder.hostSessionId : part.acquiredFrom.hostSessionId
    const visit = (block: CommunicationVisibleBlock): void => {
      options.signal?.throwIfAborted()
      if (block.type === 'quoted-tool-result') { for (const nested of block.content) visit(nested); return }
      if (block.type !== 'file' && block.type !== 'image') return
      const key = `${block.type}:${canonicalJson(block.attachment)}`
      if (copied.has(key)) return
      requests.push(block.type === 'image'
        ? { source: SessionId(sourceHost), kind: 'image', ref: block.attachment }
        : { source: SessionId(sourceHost), kind: 'file', ref: block.attachment })
      copied.add(key)
    }
    for (const block of part.blocks) visit(block)
  }
  if (requests.length) await read.copyAttachments(requests, SessionId(targetHostSessionId), options)
}
