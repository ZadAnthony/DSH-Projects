/** Actual whole-request capacity projection for a frozen, owner-read native history import. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { measureProjectRequestCandidate, type PreparedRequestContext, type RequestContentProjection, type RequestDispatchCandidate, type RequestSourcedHistory } from '../stock/request/harness.ts'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '../stock/read/index.ts'
import { canonicalJson, communicationError, jsonFrozen, snapshotCodec } from '../communication/contract.ts'
import { renderCommunicationContent } from '../communication/content.ts'
import { communicationVisibleText, projectCommunicationVisibleBlocks } from '../communication/visible-reader.ts'
import { visibleSourceItemForModel } from '../model-visible-content.ts'
import { dispatchFacts, isProjectConversationDispatch, projectRequestFacts, type ProjectRequestPayload, type ProjectRequestPayloadStore } from '../stock/request/records.ts'
import type { MainHistoryCapacity, MainHistoryImportedDelivery } from './history-types.ts'
import { compactPartialHistorySources } from './history-request-sources.ts'

/** Same fitting operation used for new windows and cold native imports. */
export type MainHistoryImportFitter = (history: readonly RequestSourcedHistory[], capacity: MainHistoryCapacity, signal?: AbortSignal) => Promise<MainHistoryImportedDelivery>

/**
 * Project only imported literal bodies using the real complete candidate and token-meter owner.
 * @param holder - Actual native Session and its service context; no Agent is created or resumed.
 * @param imported - This preparation's frozen read from the native import owner.
 * @param fitImported - Shared capacity fitting, preserving original selection and source identities.
 * @returns Content overrides for the same literal messages, without surface or dispatch writes.
 */
export function prepareMainHistoryRequestProjection(holder: Pick<Agent, 'ctx' | 'session'>, imported: readonly RequestSourcedHistory[], fitImported: MainHistoryImportFitter, options: { readonly representation?: 'minimum' } = {}): NonNullable<PreparedRequestContext['projectCandidate']> {
  return async input => {
    if (imported.length === 0) return []
    input.signal.throwIfAborted()
    const window = input.contextWindow, reserved = input.reservedOutputTokens
    if (window === undefined || !Number.isSafeInteger(window) || window <= 0 || !Number.isSafeInteger(reserved) || reserved < 0) throw communicationError('PROJECT_MAIN_HISTORY_CAPACITY_UNKNOWN', 'The actual complete main request capacity or token meter is unavailable')
    for (const entry of imported) {
      const original = input.candidate.messages.find(item => item.message.id === entry.message.id)
      if (entry.message.id === undefined || original?.origin.kind !== 'literal' || original.origin.history?.use !== 'historical-evidence' || canonicalJson(original.origin.history.source) !== canonicalJson(entry.source)) throw communicationError('PROJECT_MAIN_HISTORY_INPUT_INVALID', 'The actual request does not contain the exact imported historical literal')
    }
    const communications = await communicationRepresentations(holder, imported, input.signal)
    const projected = await fitImported(imported, { ...options, fits: async history => {
      input.signal.throwIfAborted()
      const changes = contentChanges(history, communications)
      const measurement = measureProjectRequestCandidate(holder, projectCandidate(input.candidate, changes), { images: input.imageRequestPricing })
      if (measurement.inputTokens === undefined || !Number.isFinite(measurement.inputTokens) || measurement.inputTokens < 0) throw communicationError('PROJECT_MAIN_HISTORY_CAPACITY_UNKNOWN', 'The actual complete main request cannot be measured')
      return measurement.inputTokens <= window - reserved
    } }, input.signal)
    input.signal.throwIfAborted()
    return jsonFrozen(contentChanges(projected.sourcedHistory, communications))
  }
}

function contentChanges(history: readonly RequestSourcedHistory[], communications: ReadonlyMap<string, CommunicationRepresentation>): RequestContentProjection[] {
  return history.map(entry => {
    if (entry.message.id === undefined) throw communicationError('PROJECT_MAIN_HISTORY_INPUT_INVALID', 'Imported history has no stable message identity')
    return { messageId: entry.message.id, content: requestHistoryContent(entry, communications) }
  })
}

/** Remove only one proven duplicate representation inside this request, never the durable import. */
function requestHistoryContent(entry: RequestSourcedHistory, communications: ReadonlyMap<string, CommunicationRepresentation>) {
  const block = entry.message.content[0]
  if (entry.use !== 'historical-evidence' || entry.message.source?.kind !== 'projects-main-history' || entry.message.role !== 'user'
    || entry.message.content.length !== 1 || block?.type !== 'text') return entry.message.content
  let value: Record<string, unknown> | undefined
  try { value = object(JSON.parse(block.text)) } catch { return entry.message.content }
  if (value?.format !== 'projects-main-history/v1' || !['completed-turn', 'unsettled-turn', 'pending-input'].includes(String(value.recordType))
    || !Array.isArray(value.items)) return entry.message.content
  if (object(value.delivery)?.status === 'partial') {
    const compact = compactPartialHistorySources(value)
    return compact === value ? entry.message.content : [{ type: 'text' as const, text: canonicalJson(compact) }]
  }
  if (object(value.delivery)?.status !== 'complete') return entry.message.content
  let changed = false
  const items = value.items.map(raw => {
    const item = object(raw)
    if (item === undefined) return raw
    const identity = communicationIdentity(item, value)
    let result: unknown = raw
    if (identity !== undefined) {
      const representation = communications.get(identity.key) ?? { status: 'unknown' as const, reason: 'The actual adopted communication representation is unavailable.' }
      const { text: _text, visibleBlocks: _blocks, ...metadata } = item
      if (representation.status === 'unknown') {
        result = { ...metadata, communicationRepresentation: representation,
          text: 'The actual prior model request representation is unknown. The saved original and its exact communication/body read entries remain historical sources; their bodies have not been supplied here.' }
      } else {
        const projection = projectCommunicationVisibleBlocks(representation.content)
        result = projection.missingVisible.length === 0
          ? visibleSourceItemForModel({ ...metadata, communicationRepresentation: { status: representation.status, ...(representation.dispatch === undefined ? {} : { dispatch: representation.dispatch }) },
            text: communicationVisibleText(projection.blocks), visibleBlocks: projection.blocks })
          : { ...metadata, communicationRepresentation: { status: 'unknown', reason: 'The recorded request contains an unsupported communication representation.' } }
      }
    } else if (equivalentOriginalText(item)) result = visibleSourceItemForModel(item)
    if (result !== raw) changed = true
    return result
  })
  return changed ? [{ type: 'text' as const, text: canonicalJson({ ...value, items }) }] : entry.message.content
}

interface CommunicationIdentity {
  readonly key: string; readonly projectId: string; readonly sessionId: string; readonly host: string; readonly createdAt: number
  readonly messageId: string; readonly deliveryId: string; readonly eventSeq: number; readonly eventDigest: string; readonly eventType: string; readonly pending: boolean
}
type CommunicationRepresentation = { readonly status: 'unknown'; readonly reason: string } | {
  readonly status: 'adopted' | 'not-previously-adopted'; readonly content: readonly ContentBlock[]
  readonly dispatch?: { readonly hostSessionId: string; readonly eventSeq: number; readonly dispatchId: string }
}

function communicationIdentity(item: Record<string, unknown>, envelope: Record<string, unknown>): CommunicationIdentity | undefined {
  const native = object(item.nativeSource), source = object(item.source)
  if (item.role !== 'user' || item.sourceKind !== 'project-delivery' || source?.kind !== 'project-delivery'
    || !['user/message', 'agent/inbox/spliced'].includes(String(item.kind)) || native?.kind !== 'native-event' || native.version !== 1
    || typeof native.projectId !== 'string' || typeof native.sessionId !== 'string' || typeof native.hostSessionId !== 'string'
    || !Number.isSafeInteger(native.sessionCreatedAt) || !Number.isSafeInteger(native.eventSeq) || typeof native.eventDigest !== 'string'
    || typeof item.messageId !== 'string' || native.messageId !== item.messageId || typeof source.deliveryId !== 'string'
    || source.projectId !== native.projectId || native.eventType !== item.kind) return undefined
  return { key: canonicalJson([native.hostSessionId, native.sessionCreatedAt, item.messageId]), projectId: native.projectId, sessionId: native.sessionId,
    host: native.hostSessionId, createdAt: native.sessionCreatedAt as number, messageId: item.messageId, deliveryId: source.deliveryId,
    eventSeq: native.eventSeq as number, eventDigest: native.eventDigest, eventType: String(native.eventType), pending: envelope.recordType === 'pending-input' }
}

/** Read only each selected message's first actual conversation dispatch, under its original carrier's read lease. */
async function communicationRepresentations(holder: Pick<Agent, 'ctx' | 'session'>, history: readonly RequestSourcedHistory[], signal: AbortSignal): Promise<ReadonlyMap<string, CommunicationRepresentation>> {
  const groups = new Map<string, CommunicationIdentity[]>(), result = new Map<string, CommunicationRepresentation>()
  for (const entry of history) {
    if (entry.use !== 'historical-evidence' || entry.message.source?.kind !== 'projects-main-history' || entry.message.content.length !== 1) continue
    const block = entry.message.content[0]
    if (block?.type !== 'text') continue
    let envelope: Record<string, unknown> | undefined
    try { envelope = object(JSON.parse(block.text)) } catch { continue }
    if (envelope?.format !== 'projects-main-history/v1' || !Array.isArray(envelope.items) || object(envelope.delivery)?.status !== 'complete') continue
    for (const raw of envelope.items) {
      const item = object(raw), identity = item === undefined ? undefined : communicationIdentity(item, envelope)
      if (identity === undefined) continue
      const items = groups.get(identity.host) ?? []; items.push(identity); groups.set(identity.host, items)
    }
  }
  for (const [host, identities] of groups) {
    signal.throwIfAborted()
    try {
      const read = holder.ctx.get('projectsRead'), persistence = holder.ctx.get('sessionPersistence') as unknown as ProjectRequestPayloadStore | undefined
      if (read === undefined || persistence === undefined) throw new Error('The original carrier request reader is unavailable.')
      await read.withDirectory(SessionId(host), async observation => {
        const directory = observation.directory, expected = identities[0]!, wanted = new Map(identities.map(item => [item.messageId, item]))
        if (directory.owner.projectId !== expected.projectId || directory.owner.logicalSessionId !== expected.sessionId || directory.header.createdAt !== expected.createdAt
          || identities.some(item => item.projectId !== expected.projectId || item.sessionId !== expected.sessionId || item.createdAt !== expected.createdAt)) throw new Error('The original communication carrier identity changed.')
        const locators = new Map(directory.records.map(record => [record.seq, record]))
        for (const item of identities) {
          const locator = locators.get(item.eventSeq)
          if (locator?.eventDigest !== item.eventDigest || locator.type !== item.eventType) throw new Error('The original communication event identity changed.')
        }
        const seen = new Set<string>()
        for (const locator of directory.records) {
          signal.throwIfAborted()
          if (locator.type !== 'projects/request-dispatch' && locator.type !== 'projects/request-dispatch-v2') continue
          const event = await observation.readEvent(locator.seq)
          if (event === undefined || !isProjectConversationDispatch(event)) throw new Error('The original request dispatch is unavailable.')
          const facts = dispatchFacts(event), selected = facts.deliveries.filter(row => wanted.has(row.id) && !seen.has(row.id))
          if (selected.length > 0) {
            const payload = event.type === 'projects/request-dispatch' ? event.data : await observation.withOperation(() => persistence.readPayload(SessionId(host), event.data.payload, { signal })) as ProjectRequestPayload
            if (canonicalJson(projectRequestFacts(payload, facts.deliveryPolicy === 'first-adoption' ? seen : undefined)) !== canonicalJson(facts)) throw new Error('The original request dispatch payload does not match its recorded facts.')
            for (const row of selected) {
              const item = wanted.get(row.id)!, message = payload.request.messages[row.inputIndex]
              if (row.projectId !== item.projectId || message?.role !== 'user' || String(message.id) !== item.messageId || message.source?.kind !== 'project-delivery'
                || message.source.projectId !== item.projectId || message.source.deliveryId !== item.deliveryId) throw new Error('The recorded adopted communication identity does not match its original.')
              result.set(item.key, { status: 'adopted', content: message.content, dispatch: { hostSessionId: host, eventSeq: event.seq, dispatchId: event.data.dispatchId } })
              wanted.delete(row.id)
            }
          }
          for (const row of facts.deliveries) seen.add(row.id)
          if (wanted.size === 0) break
        }
        for (const item of wanted.values()) {
          if (!item.pending) { result.set(item.key, { status: 'unknown', reason: 'No saved conversation dispatch establishes the consumed communication representation.' }); continue }
          const event = await observation.readEvent(item.eventSeq)
          const message = event?.type === 'agent/inbox/spliced' ? event.data.inserted.find(message => String(message.id) === item.messageId) : undefined
          if (message?.source.kind !== 'project-delivery' || !('communicationFormat' in message.source) || message.source.communicationFormat !== 'projects-communication/v1'
            || !('snapshot' in message.source)) throw new Error('The saved pending communication snapshot is unavailable.')
          const snapshot = snapshotCodec.decode(message.source.snapshot as unknown as JsonValue)
          if (snapshot.projectId !== item.projectId || snapshot.deliveryId !== item.deliveryId || snapshot.recipient.hostSessionId !== host) throw new Error('The saved pending communication identity changed.')
          result.set(item.key, { status: 'not-previously-adopted', content: renderCommunicationContent(snapshot, {
            record: { kind: 'recipient-message', holder: { hostSessionId: host, sessionCreatedAt: item.createdAt }, messageId: item.messageId }, nativeMessageId: item.messageId, context: 'entry' }) })
        }
        await observation.revalidate()
      }, { signal })
    } catch (error) {
      signal.throwIfAborted()
      for (const item of identities) result.set(item.key, { status: 'unknown', reason: error instanceof Error ? error.message : 'The actual adopted communication representation could not be read.' })
    }
  }
  return result
}

function equivalentOriginalText(item: Record<string, unknown>): boolean {
  const source = object(item.source), native = object(item.nativeSource)
  const ordinary = item.kind === 'user/message' && item.role === 'user' && item.sourceKind === 'user' && source?.kind === 'user' && item.speaker === 'user'
    || item.kind === 'assistant/message' && item.role === 'assistant' && item.sourceKind === 'model' && source?.kind === 'model' && item.speaker === 'assistant'
  if (!ordinary || item.classification !== 'original-visible-record' || item.visibleComplete !== true || item.partial === true || item.recordPhase === 'interrupted'
    || typeof item.text !== 'string'
    || native === undefined || typeof native.hostSessionId !== 'string'
    || !(native.kind === 'native-event' && native.version === 1 && Number.isSafeInteger(native.eventSeq) && typeof native.eventDigest === 'string'
      || native.kind === 'message' && typeof native.messageId === 'string')
    || ['savedPartSource', 'communicationParts', 'communicationContent'].some(key => Object.hasOwn(item, key))) return false
  for (const field of ['attachments', 'missingVisible', 'limitations']) {
    const entries = item[field]
    if (entries !== undefined && (!Array.isArray(entries) || entries.length !== 0)) return false
  }
  const range = object(item.bodyRange)
  if (range !== undefined && (range.unit !== 'unicode-code-points' || range.start !== 0 || !Number.isSafeInteger(range.total) || (range.total as number) < 0 || range.end !== range.total)) return false
  if (!Array.isArray(item.visibleBlocks) || item.visibleBlocks.length !== 1) return false
  const block = object(item.visibleBlocks[0])
  return block !== undefined && Object.keys(block).length === 2 && block.type === 'text' && block.text === item.text
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function projectCandidate(candidate: RequestDispatchCandidate, changes: readonly RequestContentProjection[]): RequestDispatchCandidate {
  const byId = new Map(changes.map(change => [change.messageId, change.content]))
  return { ...candidate, messages: candidate.messages.map(item => {
    const content = item.message.id === undefined ? undefined : byId.get(item.message.id)
    return content === undefined ? item : { ...item, message: { ...item.message, content } }
  }) }
}
