/** Plugin-owned capability boundaries. These never pretend to extend stock services. */
import type { Agent, AgentHandle, InboxTarget, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionHeader, SessionId, Session, UserMessage } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ProjectStore } from '../records.ts'
import type { SessionOwnedLifecycle } from '../records-types.ts'
import type { ToolInvocationSource } from '../communication/invocation-source.ts'
import type { ProjectReadPort } from './read/index.ts'
import type { ProjectsDeletionV1Scope } from '../deletion-v1.ts'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { OwnedSubagentMember, OwnedQuiescence, OwnedRetirement, OwnedRetirementOptions, ProjectAbsentCarrierProof } from './control/identity.ts'
import type { ProjectPaths } from './project-paths.ts'

export interface ProjectSourceExecutionDisposition {
  readonly state: 'active' | 'readonly' | 'unknown'
  readonly rootSessionId: SessionId
  readonly scope?: 'session'
  readonly member?: SessionOwnedLifecycle['members'][number]
  readonly releasedAt?: string
}
export interface ProjectSourceDispositionSnapshot {
  readonly generation: number
  readonly claimed: ReadonlySet<SessionId>
  readonly unavailable: ReadonlyMap<SessionId, { readonly sourceRevision: number }>
  readonly userAddressable?: ReadonlySet<SessionId>
  readonly nativeScheduleExcluded?: ReadonlySet<SessionId>
  readonly execution?: ReadonlyMap<SessionId, ProjectSourceExecutionDisposition>
}
export interface ProjectInputAdmission {
  assert(id: SessionId, operation: string): void
  accept(id: SessionId, operation: string): { release(): void } | undefined
}
export interface ProjectRetirement {
  readonly status: 'stopped' | 'unconfirmed'
  readonly errors: readonly unknown[]
}
export interface ProjectControlPort {
  prepareAbsentCarrier(id: SessionId): Promise<ProjectAbsentCarrierProof>
  createPreparedAgent(request: { projectId: string; sessionId: string; attemptId: string; options: CreateAgentOptions }): Promise<AgentHandle>
  resolve(id: SessionId): Promise<{ agent: Agent } | { error: { message: string } }>
  inspect(id: SessionId): Promise<{ meta: SessionHeader; events: readonly SessionEvent[]; inheritedEventCount: number; owner?: { readonly projectId: string; readonly logicalSessionId: string } }>
  retire(id: SessionId, options?: { handle?: AgentHandle }): Promise<ProjectRetirement>
  captureSettled(id: SessionId): Promise<() => void>
  assertSettled(id: SessionId): Promise<void>
  assertAdmitting(id: SessionId, agent?: Agent): void
  registerInputAdmission(admission: ProjectInputAdmission): () => void
  registerSourceDisposition(source: { getSnapshot(): ProjectSourceDispositionSnapshot; subscribe(listener: () => void): () => void }): () => void
  captureColdInbox(id: SessionId): Promise<readonly MessageId[]>
  settleColdInbox(id: SessionId, preserve: boolean, selected?: readonly MessageId[]): Promise<void>
  inspectOwnedSessions(id: SessionId): Promise<readonly OwnedSubagentMember[]>
  prepareOwnedQuiescence(roots: readonly { header: SessionHeader; members: readonly OwnedSubagentMember[] }[], hooks: {
    install(agent: Agent, rootId: SessionId): void; capture(session: Session): void; settle(agent: Agent): Promise<void>; settleCold?(id: SessionId, selected: readonly MessageId[]): Promise<void>
  }): OwnedQuiescence
  prepareOwnedRetirement(id: SessionId, options: OwnedRetirementOptions): OwnedRetirement
  deliverPreparedInput(id: SessionId, message: UserMessage, options: { target: InboxTarget; wakeup: boolean; signal?: AbortSignal; prepare?: (session: Session) => void | Promise<void> }): Promise<{
    insertion: 'inserted' | 'not-inserted' | 'unknown'; persistence: 'flushed' | 'failed' | 'not-started'; copyPersistence: 'flushed' | 'failed' | 'not-started'; wakeup: boolean | 'unknown'; error?: string
  }>
  editSessionMetadata<T>(target: { projectId: string; sessionId: string; hostSessionId: string }, run: (session: Session, flush: () => Promise<void>) => Promise<T>): Promise<T>
  removeCarrier(id: SessionId): Promise<void>
  deletionScope(): ProjectsDeletionV1Scope
  closeOwned(roots: readonly { id: SessionId; epoch?: Agent }[], beforeRetire?: Promise<void>): Promise<void>
}
export interface ProjectInvocationPort { get(exec: Readonly<ToolExecution>): ToolInvocationSource | undefined }
export interface ProjectRecordingPort {
  install(agent: Agent, policy: { streamCheckpointBytes: number; streamCheckpointIntervalMs: number }): void
}
export interface ProjectsRuntimePorts {
  readonly control: ProjectControlPort
  readonly read: ProjectReadPort
  readonly invocations: ProjectInvocationPort
  readonly recording: ProjectRecordingPort
}
export interface ProjectsRuntimeComposition {
  readonly paths: ProjectPaths
  readonly store: ProjectStore
  readonly ports: ProjectsRuntimePorts
}
