/** Explicit required journal vocabulary, installed before any Projects cold read. */
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ProjectSchemaPersistence } from '../stock/request/dispatch.ts'
import { canonicalJson, exact, object, operationReference, snapshotCodec, text, validateInvocation } from './contract.ts'
import type { CommunicationTranscriptEventProposal } from './types.ts'
import { renderCommunicationContent } from './content.ts'

export type CommunicationJournalEvent = CommunicationTranscriptEventProposal | {
  readonly format: 'projects-communication-event/v1'
  readonly phase: 'received'
  readonly message: UserMessage
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap { 'projects/communication': CommunicationJournalEvent }
}

const installed = new WeakSet<object>()
export function installCommunicationEventSchemas(persistence: ProjectSchemaPersistence): void {
  if (installed.has(persistence)) return
  persistence.registerProjectEventSchema('projects/communication', validateCommunicationEvent)
  installed.add(persistence)
}

/** The body and identity are validated together; unknown fields never become ignorable. */
export function validateCommunicationEvent(value: unknown): void {
  const data = object(value, 'communication event')
  if (data.format !== 'projects-communication-event/v1') throw new TypeError('Unsupported communication event format')
  if (data.phase === 'received') {
    exact(data, ['format', 'phase', 'message'])
    const message = object(data.message, 'received communication message')
    exact(message, ['id', 'role', 'source', 'content'])
    text(message.id, 'received message id')
    if (message.role !== 'user' || !Array.isArray(message.content)) throw new TypeError('Invalid received communication message')
    const source = object(message.source, 'received communication source')
    exact(source, ['kind', 'communicationFormat', 'projectId', 'deliveryId', 'operationRef', 'senderSessionId', 'senderHostSessionId', 'targetSessionId', 'targetHostSessionId', 'snapshot'])
    const snapshot = snapshotCodec.decode(source.snapshot as never)
    if (source.kind !== 'project-delivery' || source.communicationFormat !== snapshot.format
      || source.projectId !== snapshot.projectId || source.deliveryId !== snapshot.deliveryId || source.operationRef !== snapshot.operationRef
      || source.senderSessionId !== snapshot.sender.sessionId || source.senderHostSessionId !== snapshot.sender.hostSessionId
      || source.targetSessionId !== snapshot.recipient.sessionId || source.targetHostSessionId !== snapshot.recipient.hostSessionId) throw new TypeError('Received communication source identity mismatch')
    if (canonicalJson(message.content) !== canonicalJson(renderCommunicationContent(snapshot))) throw new TypeError('Received communication content differs from its complete snapshot')
    return
  }
  if (data.phase !== 'prepared' && data.phase !== 'outcome') throw new TypeError('Unsupported communication event phase')
  exact(data, ['format', 'phase', 'invocationSource', 'operationRef', data.phase === 'prepared' ? 'snapshot' : 'outcome'])
  const source = validateInvocation(data.invocationSource)
  if (data.operationRef !== operationReference(source)) throw new TypeError('Communication invocation identity mismatch')
  if (data.phase === 'prepared') {
    const snapshot = snapshotCodec.decode(data.snapshot as never)
    if (snapshot.operationRef !== data.operationRef || snapshot.sender.hostSessionId !== String(source.sessionId)) throw new TypeError('Prepared communication identity mismatch')
  } else canonicalJson(data.outcome)
}
