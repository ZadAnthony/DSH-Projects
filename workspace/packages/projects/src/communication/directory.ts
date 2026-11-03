/** Communication queries select record metadata before touching canonical bodies. */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { RetainedNativeDirectory } from '../source-reader.ts'
import type { ProjectRecordLocator } from '../stock/persistence/types.ts'
import { canonicalJson, jsonFrozen, validateInvocation } from './contract.ts'
import type { CommunicationInvocationSource } from './contract.ts'

export type CommunicationDirectory = Extract<RetainedNativeDirectory, { readable: true }>
export type CommunicationDirectoryReader = (projectId: string, hostSessionId: string, signal?: AbortSignal) => Promise<RetainedNativeDirectory>
export type NativeMessage = { id: string; source: Record<string, unknown>; content: unknown }
export type MessageAt = { event: SessionEvent; message: NativeMessage }

export async function* communicationDirectoryEvents(directory: CommunicationDirectory, select: (record: ProjectRecordLocator) => boolean,
  signal?: AbortSignal): AsyncGenerator<SessionEvent> {
  for (const record of directory.directory.records) {
    signal?.throwIfAborted()
    if (record.seq > directory.endSeq || !select(record)) continue
    const event = await directory.readEvent(record.seq)
    if (event === undefined || Number(event.seq) !== record.seq || event.time !== record.time || event.type !== record.type)
      throw new Error('Selected communication record is unavailable or changed')
    yield event
  }
}

/** Omitted facts mean "unknown", never "not a match" (including oversized ids). */
export function factMayMatch(record: ProjectRecordLocator, key: string, value: string | number): boolean {
  return record.facts[key] === undefined || record.facts[key] === value
}
export function messagesOf(event: SessionEvent): readonly NativeMessage[] {
  if (event.type === 'user/message' && event.surfaceOp !== undefined && !isAppendSurfaceEvent(event)) return []
  const messages = event.type === 'user/message' ? [event.data] : event.type === 'agent/inbox/spliced' ? event.data.inserted
    : event.type === 'projects/communication' && event.data.phase === 'received' ? [event.data.message] : []
  return messages.filter(message => typeof message.id === 'string' && object(message.source) !== undefined) as unknown as readonly NativeMessage[]
}
export function recipientRecordMayMatch(record: ProjectRecordLocator, messageId?: string): boolean {
  return record.type === 'agent/inbox/spliced' && (messageId === undefined || record.inboxMetadata === undefined || record.inboxMetadata.inserted.some(message => message.id === messageId)) || (record.type === 'user/message'
    || record.type === 'projects/communication' && factMayMatch(record, 'phase', 'received'))
    && (messageId === undefined || factMayMatch(record, 'messageId', messageId))
}

/** A saved delivery lookup never reads unrelated user messages or queue bodies. */
export function communicationDeliveryMayMatch(record: ProjectRecordLocator, deliveryId: string): boolean {
  if (record.type === 'agent/inbox/spliced') {
    return record.inboxMetadata === undefined || record.inboxMetadata.inserted.some(message => message.sourceKind === 'project-delivery'
      && (message.deliveryId === undefined || message.deliveryId === deliveryId));
  }
  return recipientRecordMayMatch(record) && (record.facts.sourceKind === undefined || record.facts.sourceKind === 'project-delivery')
    && factMayMatch(record, 'deliveryId', deliveryId);
}

/** Only active queue identities and the requested message survive each splice. */
export async function communicationMessageAt(directory: CommunicationDirectory, messageId: string,
  purpose: 'saved' | 'navigation' = 'navigation', signal?: AbortSignal): Promise<MessageAt | undefined> {
  let first: MessageAt | undefined, user: MessageAt | undefined
  const queues: Record<'next-turn' | 'next-step', Array<{ id: string; selected?: MessageAt }>> = { 'next-turn': [], 'next-step': [] }
  for (const record of directory.directory.records) {
    signal?.throwIfAborted()
    if (record.seq > directory.endSeq) continue
    if (record.type !== 'agent/inbox/spliced' && !recipientRecordMayMatch(record, messageId)) continue
    const spliceMetadata = record.type === 'agent/inbox/spliced' ? record.inboxMetadata : undefined
    const needsBody = record.type !== 'agent/inbox/spliced' || spliceMetadata === undefined || spliceMetadata.inserted.some(message => message.id === messageId)
    const event = needsBody ? await directory.readEvent(record.seq) : undefined
    if (needsBody && (event === undefined || event.seq !== record.seq)) throw new Error('Selected communication message is unavailable')
    if (event !== undefined && event.seq >= directory.inheritedEventCount) for (const message of messagesOf(event)) if (message.id === messageId) {
      const at = { event, message }
      if (first !== undefined && !sameCommunicationMessage(first.message, message)) return undefined
      first ??= at
      if (event.type === 'user/message') { if (user !== undefined) return undefined; user = at }
    }
    if (record.type !== 'agent/inbox/spliced') continue
    const fullSplice = event?.type === 'agent/inbox/spliced' ? event.data : undefined
    const target = fullSplice?.target ?? record.facts.target
    if (target !== 'next-turn' && target !== 'next-step') return undefined
    const start = fullSplice?.start ?? record.facts.start, removed = fullSplice?.removedCount ?? record.facts.removedCount ?? 0
    const queue = queues[target]
    if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0 || start > queue.length
      || typeof removed !== 'number' || !Number.isSafeInteger(removed) || removed < 0 || start + removed > queue.length) return undefined
    const inserted = fullSplice?.inserted ?? spliceMetadata?.inserted
    if (inserted === undefined) return undefined
    queue.splice(start, removed, ...inserted.map(message => ({ id: String(message.id),
      ...(String(message.id) === messageId && event !== undefined ? { selected: { event, message: message as unknown as NativeMessage } } : {}) })))
    const ids = new Set<string>()
    for (const entry of [...queues['next-turn'], ...queues['next-step']]) {
      if (ids.has(entry.id)) return undefined
      ids.add(entry.id)
    }
  }
  if (first === undefined) return undefined
  const active = [...queues['next-turn'], ...queues['next-step']].flatMap(entry => entry.selected !== undefined
    && entry.selected.event.seq >= directory.inheritedEventCount ? [entry.selected] : [])
  if (active.length > 1 || user !== undefined && active.length > 0) return undefined
  await directory.revalidate()
  return user ?? active[0] ?? (purpose === 'saved' ? first : undefined)
}
export function sameCommunicationMessage(left: NativeMessage, right: NativeMessage): boolean {
  return left.id === right.id && canonicalJson(left.source) === canonicalJson(right.source) && canonicalJson(left.content) === canonicalJson(right.content)
}
export function communicationHolder(directory: CommunicationDirectory) {
  return { hostSessionId: directory.hostSessionId, sessionCreatedAt: directory.sessionCreatedAt }
}
export async function communicationInvocationAt(directory: CommunicationDirectory, seq: number, callId: string, rootCallId: string): Promise<CommunicationInvocationSource | undefined> {
  if (!Number.isSafeInteger(seq) || seq < directory.inheritedEventCount || seq > directory.endSeq) return undefined
  const record = directory.directory.records[seq]
  if (record === undefined || (record.type !== 'tool/call' && record.type !== 'tool/ptc-dispatch-start')) return undefined
  const event = await directory.readEvent(seq)
  if (event?.seq !== seq) return undefined
  if (event.type === 'tool/call') {
    if (event.data.name !== 'project_send_message' || event.data.callId !== callId || rootCallId !== callId) return undefined
  } else if (event.type === 'tool/ptc-dispatch-start') {
    if (event.data.name !== 'project_send_message' || event.data.subCallId !== callId || event.data.rootCallId !== rootCallId) return undefined
  } else return undefined
  return jsonFrozen(validateInvocation({ sessionId: directory.hostSessionId, sessionCreatedAt: directory.sessionCreatedAt, startEventSeq: seq, callId, rootCallId }))
}
export async function communicationInvocationMatches(directory: CommunicationDirectory, source: CommunicationInvocationSource): Promise<boolean> {
  validateInvocation(source)
  if (String(source.sessionId) !== directory.hostSessionId || source.sessionCreatedAt !== directory.sessionCreatedAt) return false
  const actual = await communicationInvocationAt(directory, source.startEventSeq, source.callId, source.rootCallId)
  return actual !== undefined && canonicalJson(actual) === canonicalJson(source)
}
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
