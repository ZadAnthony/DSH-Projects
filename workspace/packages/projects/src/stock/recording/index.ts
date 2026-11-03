import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import type { ProjectRecordingPort } from '../project-ports.ts'
import type { ProjectDriverPersistence } from '../request/dispatch.ts'
import { isProjectRawRecordType, stageProjectRawRecord } from './records.ts'
export { installProjectRecordingSchemas, foldProjectAssistantProgress, projectRecordingLocator } from './events.ts'
export { decodeProjectRecord, transformProjectRawForRun, projectRecordSemanticType } from './records.ts'
import './events.ts'

export interface ProjectOriginalRecordingPolicy { readonly streamCheckpointBytes: number; readonly streamCheckpointIntervalMs: number }
const policies = new WeakMap<Agent, ProjectOriginalRecordingPolicy>()
/** Binding is private to this plugin, never added to stock Session. */
export function createProjectRecordingPort(): ProjectRecordingPort {
  return { install(agent, policy) {
    for (const value of [policy.streamCheckpointBytes, policy.streamCheckpointIntervalMs]) if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Original recording limits must be explicit positive integers')
    policies.set(agent, Object.freeze({ ...policy }))
  } }
}
export function projectRecordingPolicy(agent: Agent): ProjectOriginalRecordingPolicy | undefined { return policies.get(agent) }
export interface ProjectStreamRecording {
  readonly session: Session
  readonly persistence: ProjectDriverPersistence
  readonly policy: ProjectOriginalRecordingPolicy
  readonly failed: (error: unknown) => void
}
export function projectStreamRecording(agent: Agent, persistence: ProjectDriverPersistence, failed: (error: unknown) => void): ProjectStreamRecording | undefined {
  const policy = policies.get(agent)
  return policy === undefined ? undefined : { session: agent.session, policy, persistence, failed }
}
type ProjectRecordingType = Extract<keyof SessionEventMap, `projects/${string}`>
export function appendProjectRecording<T extends ProjectRecordingType>(session: Session, persistence: ProjectDriverPersistence, type: T, data: SessionEventMap[T]): SessionEvent {
  persistence.assertHealthy()
  try {
    if (isProjectRawRecordType(type)) {
      if (persistence.stagePayload === undefined) throw new Error('PROJECT_RAW_PAYLOAD_STORE_UNAVAILABLE')
      const recording = stageProjectRawRecord(session, { stagePayload: persistence.stagePayload.bind(persistence) }, type, data as SessionEventMap[typeof type])
      const append = session.append as (type: typeof recording.type, data: typeof recording.data) => SessionEvent
      return append.call(session, recording.type, recording.data)
    }
    // Every Projects recording event is log-only; native's generic conditional
    // rest parameter cannot prove that fact through this extensible type alias.
    const append = session.append as (type: T, data: SessionEventMap[T]) => SessionEvent<T>
    return append.call(session, type, data)
  }
  catch (error) { persistence.fail(error); throw error }
}
export async function flushProjectRecording(persistence: ProjectDriverPersistence): Promise<void> {
  persistence.assertHealthy()
  try { await persistence.flush(); persistence.assertHealthy() }
  catch (error) { persistence.fail(error); throw error }
}
