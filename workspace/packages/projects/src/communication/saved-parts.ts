/** One catalogue for saved read values, visible blocks and exact reusable sources. */
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { RetainedNativePrefix } from '../source-reader.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { communicationDirectoryEvents, messagesOf, recipientRecordMayMatch } from './directory.ts'
import type { CommunicationDirectory } from './directory.ts'
import { mintNativeProjectSource } from '../native-source-host.ts'
import { canonicalJson, communicationError, digestJson, jsonFrozen, operationReference, snapshotCodec, validateLocator } from './contract.ts'
import type { CommunicationNativeSource, CommunicationPartV1, CommunicationRecordLocator, CommunicationSavedPartSource, CommunicationSnapshotV1, CommunicationVisibleBlock } from './types.ts'

export const COMMUNICATION_AGENT_PART_ID = '$agent'
export interface CommunicationSavedContent {
  readonly id: string
  readonly group: 'agent' | 'user-message' | 'context'
  readonly speaker: CommunicationPartV1['originalSpeaker']
  /** Keep the established $agent string page stream; original parts use blocks. */
  readonly readValue: string | readonly CommunicationVisibleBlock[]
  readonly blocks: readonly CommunicationVisibleBlock[]
  readonly visibleDigest: string
}

export function communicationSavedContents(snapshot: CommunicationSnapshotV1): readonly CommunicationSavedContent[] {
  const entries: CommunicationSavedContent[] = []
  let reusable = true
  if (snapshot.agentMessage !== undefined) {
    // Text is immutable; do not stringify it once here and again with the directory.
    const blocks = Object.freeze([Object.freeze({ type: 'text' as const, text: snapshot.agentMessage })])
    reusable = typeof snapshot.agentMessage === 'string'
    entries.push({ id: COMMUNICATION_AGENT_PART_ID, group: 'agent', speaker: 'assistant', readValue: snapshot.agentMessage, blocks, visibleDigest: digestJson(blocks) })
  }
  for (const [group, parts] of [['user-message', snapshot.userMessageParts], ['context', snapshot.contextParts]] as const) {
    for (const part of parts) {
      reusable = reusable && typeof part.id === 'string' && typeof part.originalSpeaker === 'string' && deeplyFrozenJson(part.blocks)
      entries.push({ id: part.id, group, speaker: part.originalSpeaker, readValue: part.blocks, blocks: part.blocks, visibleDigest: digestJson(part.blocks) })
    }
  }
  // Owner snapshots are already deep-frozen JSON. Their immutable blocks can be
  // shared safely; mutable callers still receive the historical isolated copy.
  if (reusable) return Object.freeze(entries.map(entry => Object.freeze(entry)))
  return jsonFrozen(entries)
}

/** Conservative fast path: reuse only values JSON round-tripping would not change. */
function deeplyFrozenJson(value: unknown, active = new WeakSet<object>(), verified = new WeakSet<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (typeof value !== 'object' || !Object.isFrozen(value)) return false
  if (verified.has(value)) return true
  if (active.has(value)) return false
  const array = Array.isArray(value)
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) return false
  active.add(value)
  const keys = Reflect.ownKeys(value)
  if (array && keys.length !== value.length + 1) return false
  for (const key of keys) {
    if (array && key === 'length') continue
    if (typeof key !== 'string') return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (!descriptor.enumerable || !('value' in descriptor) || !deeplyFrozenJson(descriptor.value, active, verified)) return false
    if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) return false
  }
  active.delete(value); verified.add(value)
  return true
}

export function communicationSavedPartSource(snapshot: CommunicationSnapshotV1, record: CommunicationRecordLocator, partId: string): CommunicationSavedPartSource {
  validateLocator(record)
  const present = partId === COMMUNICATION_AGENT_PART_ID ? snapshot.agentMessage !== undefined
    : [...snapshot.userMessageParts, ...snapshot.contextParts].some(item => item.id === partId)
  if (!present) throw communicationError('COMMUNICATION_SOURCE_UNAVAILABLE', 'Saved content is unavailable')
  return jsonFrozen({ kind: 'communication-part', holder: record.holder, record, deliveryId: snapshot.deliveryId, snapshotVersion: snapshot.snapshotVersion, partId })
}

/** Author is snapshot.sender; origin is this independently saved copy's real native carrier. */
type SavedPartCarrier = Pick<Extract<RetainedNativePrefix, { readable: true }>, 'projectId' | 'sessionId' | 'formatVersion' | 'hostSessionId' | 'sessionCreatedAt' | 'inheritedEventCount'> & { readonly events: readonly SessionEvent[] }
export async function savedAgentMessagePartFromDirectory(snapshot: CommunicationSnapshotV1, source: CommunicationSavedPartSource,
  selectedBy: CommunicationPartV1['selectedBy'], directory: CommunicationDirectory, signal?: AbortSignal): Promise<CommunicationPartV1> {
  const events: SessionEvent[] = []
  const record = source.record
  if (record.kind === 'sender-prepared') {
    for (const seq of [record.invocationSource.startEventSeq, record.eventSeq]) {
      const event = await directory.readEvent(seq)
      if (event !== undefined) events.push(event)
    }
  } else {
    for await (const event of communicationDirectoryEvents(directory, metadata => recipientRecordMayMatch(metadata, record.messageId), signal)) {
      if (messagesOf(event).some(message => message.id === record.messageId)) events.push(event)
    }
  }
  const part = savedAgentMessagePart(snapshot, source, selectedBy, { ...directory, events })
  await directory.revalidate()
  return part
}
export function savedAgentMessagePart(snapshot: CommunicationSnapshotV1, source: CommunicationSavedPartSource,
  selectedBy: CommunicationPartV1['selectedBy'], prefix: SavedPartCarrier): CommunicationPartV1 {
  const entry = communicationSavedContents(snapshot).find(item => item.id === COMMUNICATION_AGENT_PART_ID)
  if (source.partId !== COMMUNICATION_AGENT_PART_ID || entry === undefined || snapshot.deliveryId !== source.deliveryId || snapshot.snapshotVersion !== source.snapshotVersion
    || prefix.hostSessionId !== source.holder.hostSessionId || prefix.sessionCreatedAt !== source.holder.sessionCreatedAt
    || canonicalJson(source.holder) !== canonicalJson(source.record.holder)) throw communicationError('COMMUNICATION_SOURCE_UNAVAILABLE', 'Exact saved Agent message is unavailable')
  let origin: CommunicationNativeSource, originEventSeq: number, originTime: number, prefixEventCount: number
  const record = source.record
  if (record.kind === 'sender-prepared') {
    const prepared = prefix.events.find(event => event.seq === record.eventSeq), invocation = record.invocationSource,
      start = prefix.events.find(event => event.seq === invocation.startEventSeq)
    if (prepared?.type !== 'projects/communication' || prepared.data.phase !== 'prepared' || prepared.seq !== record.eventSeq
      || prepared.data.operationRef !== snapshot.operationRef || snapshot.operationRef !== operationReference(invocation)
      || canonicalJson(prepared.data.invocationSource) !== canonicalJson(invocation)
      || snapshotCodec.identity(snapshotCodec.decode(prepared.data.snapshot)) !== snapshotCodec.identity(snapshot)
      || invocation.sessionId !== prefix.hostSessionId || invocation.sessionCreatedAt !== prefix.sessionCreatedAt
      || invocation.startEventSeq < prefix.inheritedEventCount || start?.seq !== invocation.startEventSeq
      || (start?.type !== 'tool/call' && start?.type !== 'tool/ptc-dispatch-start') || start.data.name !== 'project_send_message'
      || (start.type === 'tool/call' ? start.data.callId !== invocation.callId || invocation.rootCallId !== invocation.callId
        : start.data.subCallId !== invocation.callId || start.data.rootCallId !== invocation.rootCallId)
      || snapshot.sender.hostSessionId !== prefix.hostSessionId || start.seq >= prepared.seq) throw communicationError('COMMUNICATION_SOURCE_UNAVAILABLE', 'Actual saved sender occurrence is unavailable')
    origin = mintNativeProjectSource(prefix, start, start, { toolCallId: String(invocation.callId) })
    originEventSeq = Number(start.seq); originTime = start.time; prefixEventCount = Number(prepared.seq) + 1
  } else {
    const found: Array<{ seq: number; time: number; signature: string }> = []
    let visibleAppends = 0
    for (const event of prefix.events) {
      if (event.seq < prefix.inheritedEventCount) continue
      if (event.type === 'user/message' && event.surfaceOp !== undefined && !isAppendSurfaceEvent(event)) continue
      const messages = event.type === 'user/message' ? [event.data] : event.type === 'agent/inbox/spliced' ? event.data.inserted : event.type === 'projects/communication' && event.data.phase === 'received' ? [event.data.message] : []
      const matches = messages.filter(message => String(message.id) === record.messageId)
      if (matches.length > 1) throw communicationError('COMMUNICATION_SOURCE_UNAVAILABLE', 'Saved message identity is ambiguous')
      for (const message of matches) {
        if (event.type === 'user/message') visibleAppends++
        const native = message.source
        if (native.kind !== 'project-delivery' || !('communicationFormat' in native) || native.communicationFormat !== 'projects-communication/v1' || native.projectId !== snapshot.projectId
          || native.deliveryId !== snapshot.deliveryId || native.operationRef !== snapshot.operationRef
          || native.senderSessionId !== snapshot.sender.sessionId || native.senderHostSessionId !== snapshot.sender.hostSessionId
          || native.targetSessionId !== snapshot.recipient.sessionId || native.targetHostSessionId !== prefix.hostSessionId
          || snapshot.recipient.hostSessionId !== prefix.hostSessionId
          || snapshotCodec.identity(native.snapshot) !== snapshotCodec.identity(snapshot)) throw communicationError('COMMUNICATION_SOURCE_UNAVAILABLE', 'Saved recipient identity changed')
        found.push({ seq: Number(event.seq), time: event.time, signature: digestJson({ id: message.id, source: message.source, content: message.content }) })
      }
    }
    if (found.length === 0 || visibleAppends > 1 || found.some(item => item.signature !== found[0]!.signature)) throw communicationError('COMMUNICATION_SOURCE_UNAVAILABLE', 'Actual saved recipient occurrence is unavailable, changed or ambiguous')
    const first = found[0]!
    const carrier = prefix.events.find(event => event.seq === first.seq)!
    origin = mintNativeProjectSource(prefix, carrier, carrier, { messageId: record.messageId })
    originEventSeq = first.seq; originTime = first.time; prefixEventCount = first.seq + 1
  }
  return jsonFrozen({ id: `${selectedBy.group}:${selectedBy.index}:0`, selectedBy, originalSpeaker: 'assistant',
    producer: { kind: 'project-delivery', projectId: snapshot.projectId, deliveryId: snapshot.deliveryId, senderSessionId: snapshot.sender.sessionId, targetSessionId: snapshot.recipient.sessionId },
    origin, originEventSeq, originTime, acquiredFrom: source,
    version: { sessionCreatedAt: prefix.sessionCreatedAt, prefixEventCount, contentDigest: entry.visibleDigest }, sourceChain: [origin, source], blocks: entry.blocks })
}
