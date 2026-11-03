/** Small run facts and explicit, owner-bound references to complete request evidence. */
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { RequestMessage } from '@deepseek-ai/dsh-llm'
import type { ProjectPayloadReference, ProjectLegacyRecordReference } from '../persistence/types.ts'
import type { ProjectRequestSnapshot, ProjectPresetIdentity } from './dispatch.ts'
import type { RequestDispatchData, RequestOmissionRelation } from './types.ts'
import { nativeSourceDigest } from '../../native-source-host.ts'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { MemoryIndexDeliveryState } from '../../memory-index-delivery.ts'

export type ProjectRequestReference = ProjectPayloadReference | ProjectLegacyRecordReference
export interface ProjectRequestPayload { request: ProjectRequestSnapshot; context?: RequestDispatchData; preset?: ProjectPresetIdentity }
export interface ProjectRequestPayloadStore {
  stagePayload(id: Session['id'], input: { codec: string; value: unknown; capture?: (value: unknown) => void }): ProjectPayloadReference
  readPayload(id: Session['id'], ref: ProjectRequestReference, options?: { signal?: AbortSignal }): Promise<unknown>
}
export interface RequestCurrentFact {
  readonly producer: string; readonly key: string; readonly inputIndex: number; readonly eventSeq?: SessionSeq
  readonly contentDigest: string; readonly sourceDigest: string
}
export interface ProjectRequestRuntimeFacts {
  readonly hasContext: boolean
  readonly deliveryPolicy: 'all-inputs' | 'first-adoption'
  readonly systemContentDigest?: string
  readonly currentBlocks: readonly RequestCurrentFact[]
  readonly omissions: readonly RequestOmissionRelation[]
  readonly deliveries: readonly { readonly id: string; readonly projectId: string; readonly inputIndex: number }[]
  readonly memoryCatalogs: readonly { readonly projectId: string; readonly inputIndex: number }[]
  readonly evaluations: readonly { readonly messageId: string; readonly attemptId: string; readonly inputIndex: number }[]
}
interface ReferencedDispatch {
  version: 2; representation: 'recorded' | 'legacy-derived'; dispatchId: string; prefixLength: number
  payload: ProjectRequestReference; facts: ProjectRequestRuntimeFacts; preset?: ProjectPresetIdentity
}
export interface ProjectRequestDispatchV2 extends ReferencedDispatch { turn: number; step: number; attempt: number }
export interface ProjectAuxiliaryDispatchV2 extends ReferencedDispatch { purpose: 'compaction'; compactionId: string; attempt: number }
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'projects/request-dispatch-v2': ProjectRequestDispatchV2
    'projects/auxiliary-dispatch-v2': ProjectAuxiliaryDispatchV2
  }
}
export type ConversationDispatchEvent = SessionEvent<'projects/request-dispatch'> | SessionEvent<'projects/request-dispatch-v2'>
export type AnyDispatchEvent = ConversationDispatchEvent | SessionEvent<'projects/auxiliary-dispatch'> | SessionEvent<'projects/auxiliary-dispatch-v2'>
export function isProjectConversationDispatch(event: SessionEvent): event is ConversationDispatchEvent {
  return event.type === 'projects/request-dispatch' || event.type === 'projects/request-dispatch-v2'
}
export function isProjectAuxiliaryDispatch(event: SessionEvent): event is SessionEvent<'projects/auxiliary-dispatch'> | SessionEvent<'projects/auxiliary-dispatch-v2'> {
  return event.type === 'projects/auxiliary-dispatch' || event.type === 'projects/auxiliary-dispatch-v2'
}
export function projectRequestFacts(payload: ProjectRequestPayload, deliveredBefore?: Pick<ReadonlySet<string>, 'has'>): ProjectRequestRuntimeFacts {
  const { request, context } = payload
  const deliveries: { id: string; projectId: string; inputIndex: number }[] = []
  const memoryCatalogs: { projectId: string; inputIndex: number }[] = []
  const evaluations: { messageId: string; attemptId: string; inputIndex: number }[] = []
  for (const [inputIndex, message] of request.messages.entries()) {
    if (message.role !== 'user' || message.source === undefined) continue
    const source = message.source as unknown as Record<string, unknown>
    if (source.kind === 'project-delivery' && typeof source.projectId === 'string' && message.id !== undefined && !deliveredBefore?.has(String(message.id))) deliveries.push({ id: String(message.id), projectId: source.projectId, inputIndex })
    if (source.kind === 'project-memory-index' && source.form === 'catalog' && typeof source.projectId === 'string') memoryCatalogs.push({ projectId: source.projectId, inputIndex })
    if (source.kind === 'project-session-evaluation' && typeof source.attemptId === 'string' && message.id !== undefined) evaluations.push({ messageId: String(message.id), attemptId: source.attemptId, inputIndex })
  }
  const system = request.messages.findLast(message => message.role === 'system')
  return { hasContext: context !== undefined, deliveryPolicy: deliveredBefore === undefined ? 'all-inputs' : 'first-adoption', ...(system === undefined ? {} : { systemContentDigest: nativeSourceDigest(system.content) }),
    currentBlocks: (context?.currentBlocks ?? []).map(block => {
      const message = request.messages[block.inputIndex]
      if (message === undefined || message.role !== 'user' || message.source === undefined) throw new Error('PROJECT_DISPATCH_CURRENT_MESSAGE_UNAVAILABLE')
      const origin = context!.messages[block.inputIndex]
      return { ...block, ...(origin?.kind === 'event' ? { eventSeq: origin.seq } : {}), contentDigest: nativeSourceDigest(message.content), sourceDigest: nativeSourceDigest(message.source) }
    }), omissions: context?.omissions ?? [], deliveries, memoryCatalogs, evaluations }
}
export function dispatchFacts(event: AnyDispatchEvent): ProjectRequestRuntimeFacts {
  return event.type === 'projects/request-dispatch' || event.type === 'projects/auxiliary-dispatch' ? projectRequestFacts(event.data) : event.data.facts
}
/** Does not rewrite old storage. The seed explicitly identifies its different run representation. */
export function transformProjectDispatchForRun(event: SessionEvent, legacy: ProjectLegacyRecordReference): SessionEvent {
  if (event.type !== 'projects/request-dispatch' && event.type !== 'projects/auxiliary-dispatch') return event
  if (legacy.seq !== event.seq || legacy.type !== event.type || legacy.time !== event.time || legacy.eventDigest !== nativeSourceDigest(event)) throw new Error('PROJECT_REQUEST_LEGACY_LOCATOR_MISMATCH')
  const { request: _request, context: _context, ...identity } = event.data
  return { ...event, type: event.type === 'projects/request-dispatch' ? 'projects/request-dispatch-v2' : 'projects/auxiliary-dispatch-v2',
    data: { ...identity, version: 2, representation: 'legacy-derived', payload: { ...legacy, codec: 'projects-request/v1' }, facts: projectRequestFacts(event.data) } } as SessionEvent
}
export async function readProjectDispatch(session: Session, event: AnyDispatchEvent, store: ProjectRequestPayloadStore, signal?: AbortSignal): Promise<ProjectRequestPayload> {
  signal?.throwIfAborted()
  try {
    if (event.type === 'projects/request-dispatch' || event.type === 'projects/auxiliary-dispatch') return event.data
    const value = await store.readPayload(session.id, event.data.payload, { signal })
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !('request' in value)) throw new Error('PROJECT_REQUEST_PAYLOAD_INVALID')
    const payload = value as ProjectRequestPayload
    if (!Array.isArray(payload.request?.messages) || nativeSourceDigest(projectRequestFacts(payload, event.data.facts.deliveryPolicy === 'first-adoption' ? priorProjectDeliveryIds(session, event.seq) : undefined)) !== nativeSourceDigest(event.data.facts)) throw new Error('PROJECT_REQUEST_PAYLOAD_FACTS_MISMATCH')
    return payload
  } catch (error) {
    // An observed source failure ends trust in this small derived state. Caller
    // cancellation alone does not contradict the already captured dispatch.
    const projection = projections.get(session)
    if (!signal?.aborted && projection?.latest && sameDispatchRecord(projection.latest, event)) {
      projection.memorySupply = undefined
      projection.memorySupplyRevision++
    }
    throw error
  }
}
function sameDispatchRecord(left: ConversationDispatchEvent, right: AnyDispatchEvent): boolean {
  if (left === right) return true
  if (left.type !== right.type || left.seq !== right.seq || left.time !== right.time || left.data.dispatchId !== right.data.dispatchId) return false
  // Canonical readers and restored snapshots may own another object for the
  // same event. Bind the complete recorded identity, including payload owner,
  // reference and digest, so an old or substituted source cannot revoke it.
  try { return nativeSourceDigest(left) === nativeSourceDigest(right) }
  catch { return false } // Preserve the original read failure for an invalid borrowed envelope.
}
interface DeliveryAdoption { readonly event: SessionEvent<'projects/request-dispatch-v2'>; readonly index: number }
interface RequestProjection {
  throughSeq: number
  latest?: SessionEvent<'projects/request-dispatch-v2'>
  latestContext?: SessionEvent<'projects/request-dispatch-v2'>
  memorySupply?: { readonly event: ConversationDispatchEvent; readonly states: ReadonlyMap<string, MemoryIndexDeliveryState | undefined> }
  memorySupplyRevision: number
  readonly seen: Set<string>
  readonly first: Map<string, DeliveryAdoption>
}
const projections = new WeakMap<Session, RequestProjection>()
function requestProjection(session: Session): RequestProjection {
  const projection = projections.get(session)
  if (projection === undefined) throw new Error('PROJECT_REQUEST_PROJECTION_NOT_INITIALIZED')
  return projection
}
/** Seed is supplied by factory's one canonical/run scan. This never reads Session history. */
export function initializeProjectRequestProjection(session: Session, seed: readonly SessionEvent[]): void {
  if (projections.has(session)) throw new Error('PROJECT_REQUEST_PROJECTION_ALREADY_INITIALIZED')
  projections.set(session, { throughSeq: -1, memorySupplyRevision: 0, seen: new Set(), first: new Map() })
  for (const event of seed) applyProjectRequestProjection(session, event)
}
/** Install before consumer observers; repeated publication of the exact event is harmless. */
export function applyProjectRequestProjection(session: Session, event: SessionEvent): void {
  const projection = requestProjection(session)
  if (event.seq <= projection.throughSeq) return
  projection.throughSeq = event.seq
  if (!isProjectConversationDispatch(event)) return
  if (event.type !== 'projects/request-dispatch-v2') throw new Error('PROJECT_REQUEST_RUN_PROJECTION_REQUIRES_REFERENCE')
  const facts = dispatchFacts(event)
  projection.latest = event
  projection.memorySupplyRevision++
  const captured = currentProjectDispatchCapture(session, event)
  // This is the actual synchronous dispatch capture, never a prepared catalog.
  // Cold seeds have only a reference; their first read must still verify it.
  projection.memorySupply = captured === undefined ? undefined : { event, states: memoryCatalogStates(event, captured) }
  if (facts.hasContext) projection.latestContext = event
  for (const row of facts.deliveries) {
    if (projection.seen.has(row.id)) continue
    projection.seen.add(row.id)
    projection.first.set(row.id, { event, index: row.inputIndex })
  }
}
export function disposeProjectRequestProjection(session: Session): void { projections.delete(session) }
/** Actual warm commit uses the existing set. Historical verification queries only first-adoption seq metadata. */
export function priorProjectDeliveryIds(session: Session, before?: number): Pick<ReadonlySet<string>, 'has'> {
  const projection = requestProjection(session)
  if (before === undefined) return projection.seen
  return { has: id => { const first = projection.first.get(id); return first !== undefined && first.event.seq < before } }
}
export function projectDeliveryAdoptions(session: Session, selected: ReadonlySet<string>): ReadonlyMap<string, DeliveryAdoption> {
  const projection = requestProjection(session), found = new Map<string, DeliveryAdoption>()
  for (const id of selected) { const entry = projection.first.get(id); if (entry !== undefined) found.set(id, entry) }
  return found
}
export function latestProjectDispatch(session: Session): ConversationDispatchEvent | undefined { return requestProjection(session).latest }
export function latestProjectContextDispatch(session: Session): ConversationDispatchEvent | undefined { return requestProjection(session).latestContext }
/** Last actual catalog metadata under this Session owner, without retaining request bodies. */
export async function readProjectMemoryCatalogState(session: Session, event: ConversationDispatchEvent, projectId: string, store: ProjectRequestPayloadStore, signal?: AbortSignal): Promise<MemoryIndexDeliveryState | undefined> {
  signal?.throwIfAborted()
  const projection = requestProjection(session)
  if (projection.memorySupply?.event === event) return structuredClone(projection.memorySupply.states.get(projectId))
  if (!dispatchFacts(event).memoryCatalogs.some(item => item.projectId === projectId)) return
  const revision = projection.memorySupplyRevision
  // One cold/legacy read retains the existing owner, digest and request-facts
  // checks. Failed reads do not create a projection or substitute current state.
  const payload = await readProjectDispatch(session, event, store, signal)
  signal?.throwIfAborted()
  const states = memoryCatalogStates(event, payload)
  // A valid earlier read can return its historical state, but cannot undo a
  // source failure observed while that read was pending, even without a cache.
  if (projection.latest === event && projection.memorySupplyRevision === revision) projection.memorySupply = { event, states }
  return structuredClone(states.get(projectId))
}
function memoryCatalogStates(event: ConversationDispatchEvent, payload: ProjectRequestPayload): ReadonlyMap<string, MemoryIndexDeliveryState | undefined> {
  const states = new Map<string, MemoryIndexDeliveryState | undefined>()
  for (const selected of dispatchFacts(event).memoryCatalogs) {
    const message = payload.request.messages[selected.inputIndex]
    const source = message?.role === 'user' ? message.source : undefined
    if (source?.kind !== 'project-memory-index' || source.projectId !== selected.projectId || source.form !== 'catalog'
      || !source.state || !Array.isArray(source.state.entries) || typeof source.state.index !== 'string'
      || typeof source.state.status !== 'string' || typeof source.state.readRevisions !== 'object' || source.state.readRevisions === null) {
      states.set(selected.projectId, undefined)
      continue
    }
    const { index, entries, readRevisions, status, projectId, references, invalidations } = source.state
    // Copy only the delivery contract. In particular no source/content/tool
    // objects or backing request graph survive this projection boundary.
    states.set(selected.projectId, deepFreeze(structuredClone({ index, entries, readRevisions, status,
      ...(projectId === undefined ? {} : { projectId }), ...(references === undefined ? {} : { references }),
      ...(invalidations === undefined ? {} : { invalidations }),
    })))
  }
  return states
}
const captures = new WeakMap<Session, { dispatchId: string; payload: ProjectRequestPayload }>()
export function captureProjectDispatch<T>(session: Session, dispatchId: string, payload: ProjectRequestPayload, append: () => T): T {
  const previous = captures.get(session)
  captures.set(session, { dispatchId, payload })
  try { const result = append(); applyProjectRequestProjection(session, result as SessionEvent); return result } finally { if (previous) captures.set(session, previous); else captures.delete(session) }
}
/** Only valid during the exact synchronous Session append observer, never a retained payload cache. */
export function currentProjectDispatchCapture(session: Session, event: AnyDispatchEvent): ProjectRequestPayload | undefined {
  if (event.type === 'projects/request-dispatch' || event.type === 'projects/auxiliary-dispatch') return event.data
  const capture = captures.get(session)
  return capture?.dispatchId === event.data.dispatchId ? capture.payload : undefined
}
export function selectedRequestMessage(payload: ProjectRequestPayload, index: number): RequestMessage {
  const message = payload.request.messages[index]
  if (message === undefined) throw new Error('PROJECT_REQUEST_MESSAGE_SELECTOR_INVALID')
  return message
}
