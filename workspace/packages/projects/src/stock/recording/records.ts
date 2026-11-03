/** Canonical raw evidence is owner-bound; runtime seeds retain only explicit references. */
import type { Session, SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import type { ProjectPayloadRef, ProjectPayloadReference, ProjectLegacyRecordReference } from '../persistence/types.ts'
import { nativeSourceDigest } from '../../native-source-host.ts'
import { validateProjectToolRaw } from '../request/dispatch.ts'
import type { ProjectToolRaw } from '../request/dispatch.ts'
import { validateProjectRecordingData } from './events.ts'
import type { ProjectAssistantProgress, ProjectExecutionIdentity, ProjectExecutionReturn } from './events.ts'

export const projectRawRecordTypes = {
  'projects/assistant-progress': 'projects/assistant-progress-v2',
  'projects/tool-raw': 'projects/tool-raw-v2',
  'projects/tool-execution-return': 'projects/tool-execution-return-v2',
  'projects/tool-execution-final': 'projects/tool-execution-final-v2',
} as const
export type ProjectRawRecordType = keyof typeof projectRawRecordTypes
export type ProjectRawReferenceType = typeof projectRawRecordTypes[ProjectRawRecordType]
export interface ProjectRawRecordFactsMap {
  'projects/assistant-progress': Readonly<Omit<ProjectAssistantProgress, 'stream'>>
  'projects/tool-raw': Readonly<Omit<ProjectToolRaw, 'value' | 'error'>>
  'projects/tool-execution-return': Readonly<ProjectExecutionIdentity & { phase: ProjectExecutionReturn['phase']; origin: ProjectExecutionReturn['origin']; isError?: boolean }>
  'projects/tool-execution-final': Readonly<ProjectExecutionIdentity & { isError: boolean }>
}
export type ProjectRawRecordFacts = ProjectRawRecordFactsMap[ProjectRawRecordType]
export interface ProjectRawRecordReference<T extends ProjectRawRecordType = ProjectRawRecordType> {
  readonly version: 2
  readonly representation: 'recorded' | 'legacy-derived'
  readonly payload: ProjectPayloadRef
  readonly facts: ProjectRawRecordFactsMap[T]
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'projects/assistant-progress-v2': ProjectRawRecordReference<'projects/assistant-progress'>
    'projects/tool-raw-v2': ProjectRawRecordReference<'projects/tool-raw'>
    'projects/tool-execution-return-v2': ProjectRawRecordReference<'projects/tool-execution-return'>
    'projects/tool-execution-final-v2': ProjectRawRecordReference<'projects/tool-execution-final'>
  }
}
export interface ProjectRawPayloadWriter {
  stagePayload(id: Session['id'], input: { codec: string; value: unknown; capture?: (value: unknown) => void }): ProjectPayloadReference
}
export interface ProjectRawPayloadReader {
  readPayload(id: Session['id'], ref: ProjectPayloadRef, options?: { signal?: AbortSignal }): Promise<unknown>
}
const legacyTypes = new Map<string, ProjectRawRecordType>(Object.entries(projectRawRecordTypes).map(([legacy, reference]) => [reference, legacy as ProjectRawRecordType]))
const identityKeys = ['startEventSeq', 'callId', 'rootCallId', 'name', 'invocationId', 'parentInvocationId'] as const

export function isProjectRawRecordType(type: string): type is ProjectRawRecordType { return Object.hasOwn(projectRawRecordTypes, type) }
export function isProjectRawReferenceType(type: string): type is ProjectRawReferenceType { return legacyTypes.has(type) }
export function projectRecordSemanticType(type: string): string { return legacyTypes.get(type) ?? type }

/** Facts are selected, never obtained by omitting a growing list of payload fields. */
export function projectRawRecordFacts(type: ProjectRawRecordType, value: unknown): ProjectRawRecordFacts {
  if (type === 'projects/tool-raw') validateProjectToolRaw(value)
  else validateProjectRecordingData(type, value)
  const data = value as Record<string, unknown>
  const keys = type === 'projects/assistant-progress' ? ['turn', 'step', 'attemptId', 'fromIndex', 'toIndex']
    : type === 'projects/tool-raw' ? ['callSeq', 'invocationId', 'parentInvocationId', 'phase', 'name', 'callId']
      : type === 'projects/tool-execution-return' ? [...identityKeys, 'phase', 'origin'] : identityKeys
  const facts: Record<string, string | number | boolean> = {}
  for (const key of keys) if (data[key] !== undefined) facts[key] = data[key] as string | number | boolean
  if (type === 'projects/tool-execution-final' || type === 'projects/tool-execution-return' && data.phase === 'canonical') facts.isError = (data.result as { isError: boolean }).isError
  return facts as unknown as ProjectRawRecordFacts
}

export function stageProjectRawRecord<T extends ProjectRawRecordType>(session: Session, store: ProjectRawPayloadWriter, type: T, data: SessionEventMap[T]): { type: typeof projectRawRecordTypes[T]; data: ProjectRawRecordReference } {
  // Capture the exact detached value accepted by the owner, not the mutable producer input.
  let facts: ProjectRawRecordFacts | undefined
  const payload = store.stagePayload(session.id, { codec: 'projects-raw-record/v2', value: data, capture: captured => { facts = projectRawRecordFacts(type, captured) } })
  if (facts === undefined) throw new Error('PROJECT_RAW_RECORD_CAPTURE_UNAVAILABLE')
  return { type: projectRawRecordTypes[type], data: { version: 2, representation: 'recorded', payload, facts } }
}

/** One cold scan may discard v1 evidence from the run seed without rewriting its original bytes. */
export function transformProjectRawForRun(event: SessionEvent, original: ProjectLegacyRecordReference): SessionEvent {
  if (!isProjectRawRecordType(event.type)) return event
  return { ...event, type: projectRawRecordTypes[event.type], data: { version: 2, representation: 'legacy-derived',
    payload: { ...original, codec: 'projects-raw-record/v1' }, facts: projectRawRecordFacts(event.type, event.data) } } as SessionEvent
}

export interface DecodedProjectRecord { readonly canonical: SessionEvent; readonly semantic: SessionEvent }
/** Source mint/digests use canonical; only the consumer's original business logic uses semantic. */
export async function decodeProjectRecord(record: SessionEvent, persistence: ProjectRawPayloadReader, options: { signal?: AbortSignal } = {}): Promise<DecodedProjectRecord> {
  options.signal?.throwIfAborted()
  if (!isProjectRawReferenceType(record.type)) return { canonical: record, semantic: record }
  validateProjectRecordingData(record.type, record.data)
  const reference = record.data as ProjectRawRecordReference
  const type = legacyTypes.get(record.type)!
  const data = await persistence.readPayload(reference.payload.owner.carrierId, reference.payload, options)
  if (nativeSourceDigest(projectRawRecordFacts(type, data)) !== nativeSourceDigest(reference.facts)) throw new Error('PROJECT_RAW_RECORD_FACTS_MISMATCH')
  const semantic = { ...record, type, data } as SessionEvent
  if (reference.representation === 'recorded') return { canonical: record, semantic }
  const original = reference.payload as ProjectLegacyRecordReference
  if (original.type !== type || original.seq !== record.seq || original.time !== record.time) throw new Error('PROJECT_RAW_RECORD_LEGACY_LOCATOR_MISMATCH')
  // Projects recordings are log-only. Their original envelope has no surface operation.
  const canonical = semantic
  if (nativeSourceDigest(canonical) !== original.eventDigest) throw new Error('PROJECT_RAW_RECORD_LEGACY_DIGEST_MISMATCH')
  return { canonical, semantic: canonical }
}
