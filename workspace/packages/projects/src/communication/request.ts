/** Communication representation selection from one complete, frozen request candidate. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreparedRequestContext, RequestContentProjection, RequestDispatchCandidate, RequestHistoryProjection } from '../stock/request/harness.ts'
import { readRequestSourcedHistory, measureProjectRequestCandidate } from '../stock/request/harness.ts'
import { projectDeliveryAdoptions, readProjectDispatch, type ProjectRequestPayloadStore, type ConversationDispatchEvent } from '../stock/request/records.ts'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import { buildCommunicationContentDirectory, renderCommunicationContent } from './content.ts'
import { communicationError, jsonFrozen, snapshotCodec, validateSnapshot } from './contract.ts'
import type { CommunicationRecordLocator, CommunicationSnapshotV1 } from './types.ts'

export interface CommunicationRequestAccess {
  /** @param projectId Bound Project. @param record Exact saved holder. @param signal Cancellation. @returns The same complete saved snapshot or its actual absence. */
  readSnapshot(projectId: string, record: CommunicationRecordLocator, signal?: AbortSignal): Promise<CommunicationSnapshotV1 | undefined>
}

/**
 * Reuse actual adopted content in conversation and auxiliary historical inputs.
 * @param agent Actual holder of the conversation log.
 * @param projectId Bound Project identity.
 * @returns Pure historical content restoration; fresh communication remains unchanged.
 */
export async function prepareCommunicationHistoryProjection(agent: Agent, projectId: string, signal?: AbortSignal): Promise<RequestHistoryProjection> {
  const messages = [...agent.session.deriveMessages(), ...readRequestSourcedHistory(agent.session).map(item => item.message)]
  const ids = new Set(messages.flatMap(message => message.id !== undefined && message.role === 'user' && message.source?.kind === 'project-delivery' ? [String(message.id)] : []))
  return communicationHistoryProjection(projectId, await adoptedContent(agent, ids, signal))
}

function communicationHistoryProjection(projectId: string, adopted: ReadonlyMap<MessageId, readonly ContentBlock[]>): RequestHistoryProjection {
  return {
    projectCurrentness(history) {
      return { overrides: history.flatMap(({ message }) => {
        if (message.id === undefined) return []
        const content = adopted.get(message.id)
        return content === undefined || message.role !== 'user' || message.source?.kind !== 'project-delivery' || message.source.projectId !== projectId
          ? [] : [{ messageId: message.id, content }]
      }) }
    },
    renderOmissions: () => [],
  }
}

/** Content retained only by this exact Harness preparation; final fitting still rereads its evidence. */
export interface PreparedCommunicationRequest {
  readonly historyProjection: RequestHistoryProjection
  readonly minimum: NonNullable<PreparedRequestContext['projectCandidate']>
  readonly fit: NonNullable<PreparedRequestContext['projectCandidate']>
}

/** Share the already restored first-adoption content with minimum metering, without retaining a read lease. */
export async function prepareCommunicationRequest(agent: Agent, projectId: string, access: CommunicationRequestAccess, signal?: AbortSignal): Promise<PreparedCommunicationRequest> {
  const messages = [...agent.session.deriveMessages(), ...readRequestSourcedHistory(agent.session).map(item => item.message)]
  const selected = new Set(messages.flatMap(message => message.id !== undefined && message.role === 'user' && message.source?.kind === 'project-delivery' ? [String(message.id)] : []))
  const adopted = await adoptedContent(agent, selected, signal)
  return {
    historyProjection: communicationHistoryProjection(projectId, adopted),
    minimum: communicationRequestProjection(agent, projectId, access, { representation: 'minimum' }, adopted),
    // This is the last producer read before dispatch. Do not replace it with the earlier body:
    // the payload or saved recipient may have become unreadable after history preparation.
    fit: prepareCommunicationRequestProjection(agent, projectId, access),
  }
}

async function adoptedContent(agent: Agent, selected: ReadonlySet<string>, signal?: AbortSignal): Promise<Map<MessageId, readonly ContentBlock[]>> {
  const adopted = new Map<MessageId, readonly ContentBlock[]>()
  const first = projectDeliveryAdoptions(agent.session, selected)
  // Only requests containing selected, still-relevant communications are read; each is released before the next.
  const groups = new Map<ConversationDispatchEvent, { id: string; index: number }[]>()
  for (const [id, item] of first) { const rows = groups.get(item.event) ?? []; rows.push({ id, index: item.index }); groups.set(item.event, rows) }
  for (const [event, rows] of groups) {
    signal?.throwIfAborted()
    const payload = await readProjectDispatch(agent.session, event, agent.ctx.sessionPersistence as unknown as ProjectRequestPayloadStore, signal)
    for (const row of rows) {
      const message = payload.request.messages[row.index]
      if (message?.role !== 'user' || message.id === undefined || String(message.id) !== row.id || message.source?.kind !== 'project-delivery') throw new Error('PROJECT_COMMUNICATION_ADOPTION_SELECTOR_INVALID')
      adopted.set(message.id, message.content)
    }
  }
  return adopted
}

/**
 * Prepare a pure projector; actual conversation dispatches remain the sole adoption facts.
 * @param agent Actual receiving Agent.
 * @param projectId Its bound Project.
 * @param access Stable saved-record reader also used by read_content.
 * @returns Selection using the same owner preparation and complete request for every measurement.
 */
export function prepareCommunicationRequestProjection(agent: Agent, projectId: string, access: CommunicationRequestAccess, options: { readonly representation?: 'minimum' } = {}): NonNullable<PreparedRequestContext['projectCandidate']> {
  return communicationRequestProjection(agent, projectId, access, options)
}

function communicationRequestProjection(agent: Agent, projectId: string, access: CommunicationRequestAccess, options: { readonly representation?: 'minimum' }, prepared: ReadonlyMap<MessageId, readonly ContentBlock[]> = new Map()): NonNullable<PreparedRequestContext['projectCandidate']> {
  return async input => {
    input.signal.throwIfAborted()
    const selected = new Set(input.candidate.messages.flatMap(({ message }) => message.role === 'user' && message.id !== undefined && message.source?.kind === 'project-delivery' && !prepared.has(message.id) ? [String(message.id)] : []))
    const adopted = new Map([...prepared, ...await adoptedContent(agent, selected, input.signal)])
    const communications = input.candidate.messages.flatMap(({ message }) => {
      if (message.role !== 'user' || message.source?.kind !== 'project-delivery' || !('communicationFormat' in message.source)) return []
      if (message.id === undefined) throw communicationError('COMMUNICATION_INPUT_INVALID', 'Received communication has no stable native message identity')
      if (message.source.communicationFormat !== 'projects-communication/v1') throw communicationError('COMMUNICATION_FORMAT_UNSUPPORTED', 'Unsupported received communication format')
      const snapshot = validateSnapshot(message.source.snapshot)
      if (snapshot.projectId !== projectId || !adopted.has(message.id) && snapshot.recipient.hostSessionId !== String(agent.id) || snapshot.deliveryId !== message.source.deliveryId) throw communicationError('COMMUNICATION_INPUT_INVALID', 'Received communication identity does not match this session')
      const record: CommunicationRecordLocator = { kind: 'recipient-message', holder: { hostSessionId: String(agent.id), sessionCreatedAt: agent.session.header.createdAt }, messageId: String(message.id) }
      return [{ id: message.id, snapshot, record }]
    })
    if (communications.length === 0) return []
    const overrides = communications.map(item => ({ messageId: item.id, content: adopted.get(item.id) ?? renderCommunicationContent(item.snapshot, { record: item.record, nativeMessageId: String(item.id), context: 'entry' }) }))
    const fresh = communications.filter(item => !adopted.has(item.id))
    if (fresh.length === 0) return jsonFrozen(overrides)
    // Default context entries must already resolve to this independently saved
    // recipient copy, even when the preferred representation fits immediately.
    const checked = new Set<MessageId>()
    for (const item of fresh.filter(item => item.snapshot.contextParts.length > 0)) {
      input.signal.throwIfAborted()
      const saved = await access.readSnapshot(projectId, item.record, input.signal)
      if (saved === undefined || snapshotCodec.identity(saved) !== snapshotCodec.identity(item.snapshot)) throw communicationError('COMMUNICATION_CONTENT_UNAVAILABLE', 'The complete saved communication cannot be read at its stable entry')
      checked.add(item.id)
    }
    const window = input.contextWindow
    if (window === undefined || !Number.isSafeInteger(window) || window <= 0 || !Number.isSafeInteger(input.reservedOutputTokens) || input.reservedOutputTokens < 0) throw communicationError('COMMUNICATION_CAPACITY_UNKNOWN', 'The actual request input capacity is unavailable')
    const measure = (candidate: RequestDispatchCandidate) => measureProjectRequestCandidate(agent, candidate, { images: input.imageRequestPricing })
    const capacity = window - input.reservedOutputTokens
    const cost = (): number => {
      const measurement = measure(projectCandidate(input.candidate, overrides))
      if (measurement.inputTokens === undefined || !Number.isFinite(measurement.inputTokens) || measurement.inputTokens < 0) throw communicationError('COMMUNICATION_CAPACITY_UNKNOWN', 'The complete request input cannot be measured')
      return measurement.inputTokens
    }
    let currentCost = cost()
    if (currentCost <= capacity && options.representation !== 'minimum') return jsonFrozen(overrides)
    // Candidate order is the only selection order; every message retains its identity and full read entry.
    for (const item of fresh) {
      input.signal.throwIfAborted()
      if (!checked.has(item.id)) {
        const saved = await access.readSnapshot(projectId, item.record, input.signal)
        if (saved === undefined || snapshotCodec.identity(saved) !== snapshotCodec.identity(item.snapshot)) throw communicationError('COMMUNICATION_CONTENT_UNAVAILABLE', 'The complete saved communication cannot be read at its stable entry')
      }
      const override = overrides.find(override => override.messageId === item.id)!
      const full = override.content
      override.content = renderCommunicationEntry(item.snapshot, item.record, item.id)
      const entryCost = cost()
      if (entryCost >= currentCost) override.content = full
      else currentCost = entryCost
      if (currentCost <= capacity && options.representation !== 'minimum') return jsonFrozen(overrides)
    }
    if (options.representation === 'minimum') return jsonFrozen(overrides)
    throw communicationError('COMMUNICATION_CAPACITY_INSUFFICIENT', 'The actual request cannot retain every communication and its complete read entry', { inputTokens: currentCost, availableInputTokens: capacity })
  }
}

/** @param candidate Complete pending request. @param overrides Content-only selections. @returns Same candidate with selected content for metering. */
function projectCandidate(candidate: RequestDispatchCandidate, overrides: readonly RequestContentProjection[]): RequestDispatchCandidate {
  const byId = new Map(overrides.map(item => [item.messageId, item.content]))
  return { ...candidate, messages: candidate.messages.map(item => {
    const content = item.message.id === undefined ? undefined : byId.get(item.message.id)
    return content === undefined ? item : { ...item, message: { ...item.message, content } }
  }) }
}

/** @param snapshot Complete immutable communication. @param record Saved receiving holder. @param messageId Actual native input. @returns Directory and exact ranges still to read. */
function renderCommunicationEntry(snapshot: CommunicationSnapshotV1, record: CommunicationRecordLocator, messageId: MessageId): ContentBlock[] {
  const directory = buildCommunicationContentDirectory(snapshot, record)
  return [{ type: 'text', text: JSON.stringify({
    communication_manifest: { format: snapshot.format, delivery_id: snapshot.deliveryId, operation_ref: snapshot.operationRef, snapshot_version: snapshot.snapshotVersion, native_message_id: String(messageId), mode: 'entry', directory },
    sender: snapshot.sender, recipient: snapshot.recipient, created_at: snapshot.createdAt,
    ...(snapshot.replyTo === undefined ? {} : { reply_to: snapshot.replyTo }),
    not_provided: directory.contents.map(item => ({ part_id: item.part_id, range: item.range })),
  }) + '\n' }]
}
