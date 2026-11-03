export type { ProjectMemoryNotice } from './memory-notices.ts'
/** 浏览器安全的当前项目合同；原聊天与文件仍由各自原生 owner 持有。 */
import type {} from '@deepseek-ai/dsh-typert-protocol'
import type { ProjectSessionSourceLifecycle, ProjectWorkSessionRole } from './records-types.ts'
import type { SaveMemoryInput, StoredMemorySource, MemorySettingsActions } from './memory-types.ts'
import type { NativeEventSource, NativeProjectSource, NativeProjectSourceItem, NativeProjectSourceRead, NativeProjectFailureInput } from './source-types.ts'
import type { ProjectHistorySearchRequest, ProjectHistoryReadRequest } from './project-history-types.ts'
import type {
  ProjectLifecycleSessionOutcome,
  ProjectLifecycleStage,
} from './lifecycle-types.ts'

export type * from './library-contract.ts'
export type * from './memory-types.ts'
export type * from './project-history-types.ts'
export type * from './features/overview/contract.ts'
export type * from './features/settings/types.ts'
export type * from './features/usage/contract.ts'
export type * from './features/schedule/contract.ts'
import type { SaveScheduleInput, RunNowScheduleInput } from './features/schedule/contract.ts'

export interface ProjectScheduleReadRequest { projectId: string }
export interface ProjectScheduleSaveRequest { projectId: string; input: SaveScheduleInput; changeId: string }
export interface ProjectScheduleEnabledRequest { projectId: string; scheduleId: string; enabled: boolean; expectedRevision: number; changeId: string }
export interface ProjectScheduleRemoveRequest { projectId: string; scheduleId: string; expectedRevision: number; changeId: string }
export interface ProjectScheduleRunNowRequest { projectId: string; input: RunNowScheduleInput }
export type {
  ProjectLifecycleActionRequest,
  ProjectLifecycleSessionOutcome,
  ProjectLifecycleStage,
  ProjectSessionQuiescence,
} from './lifecycle-types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'projects/not-found': { readonly projectId: string }
    'projects/update-conflict': { readonly current: ProjectDetail }
    'projects/update-revision-required': { readonly projectId: string }
    'projects/update-unconfirmed': { readonly projectId: string; readonly stage: string; readonly effect: string }
  }
}

/** 只改已有 execution 的名称；修订号来自当前项目详情。 */
export interface RenameExecutionSessionRequest {
  readonly projectId: string
  readonly sessionId: string
  readonly title: string
  readonly expectedRevision: number
}

export interface RenameExecutionSessionResult {
  readonly kind: 'renamed' | 'conflict' | 'failed'
  readonly detail: ProjectDetail
  readonly sessionId: string
  readonly message: string
  /** 原生标题已接纳的实际值；saved 只表示其 flush 已确认。 */
  readonly nativeTitle?: { readonly title: string; readonly saved: boolean }
}

export interface WorkspaceReference { readonly path: string }
export type { ProjectSessionRole, ProjectWorkSessionRole } from './records-types.ts'
export type ProjectSourceRef = NativeProjectSource
export type ProjectNativeSourceItem = NativeProjectSourceItem
export type ProjectNativeSourceRead = NativeProjectSourceRead
export interface ReadProjectSourceRequest { readonly projectId: string; readonly source: NativeProjectSource }
export interface QueryProjectHistoryRequest extends ProjectHistorySearchRequest { readonly projectId: string }
export interface ReadProjectHistoryRequest extends ProjectHistoryReadRequest { readonly projectId: string }
export interface ReadMemoryRequest { readonly projectId: string; readonly id: string }
export interface SaveMemoryRequest { readonly projectId: string; readonly input: SaveMemoryInput }
export interface WithdrawMemoryRequest extends ReadMemoryRequest { readonly expectedRevision: number; readonly expectedGeneration?: string }
export interface ReadMemorySourceRequest { readonly projectId: string; readonly source: StoredMemorySource }

/** Source evidence shown by the existing settings source viewer; bounded text is never reported as full. */
export interface ProjectMemorySourceView {
  readonly projectId: string
  readonly readable: boolean
  readonly isUserDecision: boolean
  readonly source?: StoredMemorySource
  readonly producer?: string
  readonly text?: string
  readonly reason?: string
  readonly nativeItems?: readonly NativeProjectSourceItem[]
  readonly partial?: true
  readonly limitations?: readonly string[]
}
export type ProjectMemorySourceContentRequest = import('./native-content-types.ts').NativeContentRequest | import('./communication/content-types.ts').CommunicationContentRequest
export type ProjectMemorySourceContentPage = import('./native-content-types.ts').NativeContentPage | import('./communication/content-types.ts').CommunicationContentPage
export interface ReadMemorySourceContentRequest { readonly projectId: string; readonly content: ProjectMemorySourceContentRequest }
export interface ProjectMemorySettingsActions extends MemorySettingsActions {
  readSourceEvidence?(source: StoredMemorySource): Promise<ProjectMemorySourceView>
  readSourceContent?(content: ProjectMemorySourceContentRequest): Promise<ProjectMemorySourceContentPage>
}

/** 已记录的普通用户输入阶段；不表示模型理解或新的用户授权。 */
export interface ProjectUserInputTiming {
  /** UTC: earliest recorded acceptance of this input ID, not the decision time of each sentence or later edit. */
  readonly acceptedAt?: string
  /** UTC: this native Inbox claim began preparation; it does not mean a model request or understanding. */
  readonly claimedAt?: string
}
/** 实际输入的身份、定位及已知阶段；转达不等于新的用户决定。 */
export interface ProjectInvocationInput {
  readonly producer: 'user' | 'project-delivery' | 'project-schedule' | 'goal' | 'project-execution-failure'
  readonly source: Extract<NativeProjectSource, { readonly kind: 'message' }>
  readonly deliveryId?: string
  readonly scheduleId?: string
  readonly occurrenceId?: string
  readonly goalId?: string
  readonly revision?: number
  readonly round?: number
  readonly run?: { readonly turn: number; readonly startSeq: number; readonly endSeq: number }
  readonly failedAt?: number
  readonly reason?: { readonly code: string; readonly message: string }
  readonly inputs?: readonly NativeProjectFailureInput[]
  readonly provenance: readonly NativeProjectSource[]
  readonly timing?: ProjectUserInputTiming
}

export interface ProjectRecord {
  readonly sourceLifecycle?: import("./records-types.ts").ProjectSourceLifecycle
  readonly id: string
  readonly name: string
  readonly workspace?: WorkspaceReference
  readonly mainSessionId?: string
  readonly archived: boolean
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
}
export interface ProjectSessionRecord {
  readonly id: string
  readonly projectId: string
  readonly hostSessionId: string
  readonly carriers?: readonly {
    readonly sequence: number
    readonly hostSessionId: string
    readonly sessionCreatedAt?: number
    readonly isCurrent: boolean
    readonly sourceKind: 'available' | 'deleting' | 'partial' | 'deleted'
    readonly lifecycleTimeBasis?: 'project-deletion'
    readonly closed?: { readonly confirmedAt: string; readonly reason: 'ended' | 'retired' }
  }[]
  readonly archived: boolean
  readonly role: ProjectWorkSessionRole
  readonly title: string
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
}

/** 消息运输事实，不表示业务完成或核对通过。 */
export interface ProjectDeliveryRecord {
  readonly historical: true
  readonly id: string
  readonly intent: 'assign' | 'change' | 'report' | 'question' | 'coordination' | 'continue'
  readonly senderSessionId: string
  readonly targetSessionId: string
  readonly sources: readonly NativeProjectSource[]
  readonly nativeMessageId?: string
  readonly continuesDeliveryId?: string
  readonly dispatch: 'notDelivered' | 'delivered'
  readonly processing: 'pending' | 'claimed' | 'responded' | 'discardedUnrun'
  readonly createdAt: string
  readonly updatedAt: string
}
export type ProjectNavigationTarget = {
  readonly kind: 'main' | 'execution'
  readonly sessionId: string
  readonly focusEventSeq?: number
  /** Exact native message identity, including an unclaimed Inbox occurrence. */
  readonly focusMessageId?: string
  /** Exact retained history; read without activating its host, ahead of current-chat focus coordinates. */
  readonly source?: NativeEventSource
}
export type ProjectSummary = ProjectRecord
export type { ProjectSessionSourceLifecycle, SessionCleanupProgress, SessionCleanupFailure,
  SessionImageDeletion, SessionImageDeletionResult, SessionImageDeletionRef,
  SessionOwnedDeletion, SessionOwnedDeletionMember, SessionOwnedSessionHeader,
  SessionOwnedCleanupProgress, SessionOwnedDeletedSources } from './records-types.ts'

/** A processing result has no native open target or conversation reference. */
export interface ProjectSessionDeletionResult {
  readonly hostSessionId?: string
  readonly lifecycleTimeBasis?: 'project-deletion'
  readonly id: string
  readonly projectId: string
  readonly title: string
  readonly role: ProjectWorkSessionRole
  readonly revision: number
  readonly sourceLifecycle: Extract<ProjectSessionSourceLifecycle, { readonly kind: 'deleting' | 'partial' }>
}

/** Non-rendered Client invalidation facts, including completely deleted sources. */
export interface ProjectUnavailableSource {
  readonly hostSessionId: string
  readonly kind: Exclude<ProjectSessionSourceLifecycle['kind'], 'available'>
  readonly sourceRevision: number
}

export interface ProjectDetail {
  readonly project: ProjectRecord
  readonly sessions: readonly ProjectSessionRecord[]
  readonly deliveries: readonly ProjectDeliveryRecord[]
  readonly deletionResults: readonly ProjectSessionDeletionResult[]
  readonly unavailableSources: readonly ProjectUnavailableSource[]
  /** 仅当次接手未固定模型的来源；不改变持久来源状态。 */
  readonly modelInitializationErrors?: readonly { readonly hostSessionId: string; readonly message: string }[]
  /** 由当前原生命周期持有派生；用于继续原恢复动作，不是另一份归档状态。 */
  readonly pendingRestores?: readonly (
    | { readonly scope: 'project' }
    | { readonly scope: 'session'; readonly sessionId: string }
  )[]
}
export interface CreateProjectRequest { readonly name: string; readonly workspace?: WorkspaceReference }
export interface CreateProjectResult { readonly detail: ProjectDetail; readonly warning?: string }
export interface GetProjectRequest { readonly projectId: string }
export interface CreateProjectSessionRequest { readonly projectId: string; readonly title?: string; readonly workspace?: WorkspaceReference | null }
export interface UpdateProjectRequest { readonly projectId: string; readonly name?: string; readonly workspace?: WorkspaceReference | null; readonly expectedRevision?: number }

import type { OverviewSourceRef } from './features/overview/contract.ts'
import type { ModelSelection } from './features/settings/types.ts'
export interface OverviewSourceRequest { readonly projectId: string; readonly reference: OverviewSourceRef }
export interface ExecutionDefaultsSaveRequest { readonly projectId: string; readonly selection: ModelSelection | null; readonly expectedRevision: number }
export interface ProjectInstructionsSaveRequest { readonly projectId: string; readonly text: string; readonly expectedRevision: number }
export interface SessionInstructionsRequest { readonly projectId: string; readonly sessionId: string }
export interface SessionInstructionsSaveRequest extends SessionInstructionsRequest { readonly text: string; readonly expectedRevision: number }
export interface UsageRefresh { readonly projectId: string; readonly revision: number }
export interface ProjectEnvironmentView {
  readonly projectId: string
  readonly sessionId: string
  readonly projectDirectory: string
  readonly configuredWorkspace?: string
  readonly sessionDirectory?: string
  readonly message?: string
}

/** 用户单次生命周期动作的实际结果，不另存生命周期状态。 */
export interface ExecutionLifecycleActionRequest { readonly projectId: string; readonly sessionId: string; readonly action: 'archive' | 'restore' }
export interface ExecutionLifecycleActionResult {
  readonly kind: 'archived' | 'restored' | 'unchanged' | 'failed'
  readonly detail: ProjectDetail
  readonly stoppedConfirmed: boolean
  readonly admissionHeld: boolean
  readonly message: string
}

/** 项目整体归档/恢复的真实结果；不会另存 operation 状态。 */
export interface ProjectLifecycleActionResult {
  readonly kind: 'archived' | 'restored' | 'unchanged' | 'failed'
  readonly stage: ProjectLifecycleStage
  readonly detail: ProjectDetail
  readonly sessions: readonly ProjectLifecycleSessionOutcome[]
  readonly admissionHeld: boolean
  readonly message: string
}

export type { ProjectSourceLifecycle } from './records-types.ts'
export interface DeleteExecutionSessionRequest { readonly projectId:string; readonly sessionId:string; readonly expectedRevision:number }
export interface DeleteProjectRequest { readonly projectId:string; readonly expectedRevision:number }
export interface ProjectDeletionActionResult {
  readonly kind:'deleted'|'partial'|'stopped-before-cleanup'|'conflict'; readonly detail:ProjectDetail; readonly message:string
}

/** Read only saved communication records; no client-supplied snapshot is accepted. */
export interface ReadProjectCommunicationRequest {
  readonly holderHostSessionId: string
  readonly locator:
    | { readonly kind: 'sender'; readonly startEventSeq: number; readonly callId: string; readonly rootCallId: string; readonly invocationSource?: import('./communication/types.ts').CommunicationInvocationSource }
    | { readonly kind: 'sender-result'; readonly resultEventSeq: number; readonly callId: string }
    | { readonly kind: 'recipient'; readonly messageId: string }
}
export type ProjectCommunicationRecord = import('./communication/types.ts').CommunicationRecordLocator
export type ProjectCommunicationSnapshot = import('./communication/types.ts').CommunicationSnapshotV1
export type ProjectCommunicationRead =
  | { readonly kind: 'communication'; readonly projectId: string; readonly record: ProjectCommunicationRecord; readonly snapshot: ProjectCommunicationSnapshot;
      readonly result: 'delivered' | 'not-delivered' | 'unknown' | 'preparation-interrupted';
      readonly phase?: import('./communication/types.ts').CommunicationOperation['phase'];
      readonly facts?: import('./communication/types.ts').CommunicationTransportFacts & { readonly senderPersistence: import('./communication/types.ts').CommunicationPersistence };
      readonly failure?: { readonly code: string; readonly message: string } }
  | { readonly kind: 'legacy' | 'unavailable' | 'unsupported' | 'not-prepared'; readonly reason?: string }
export interface ResolveProjectCommunicationNavigationRequest {
  readonly projectId: string
  readonly record: ProjectCommunicationRecord
  readonly target: { readonly kind: 'sender' | 'recipient' | 'reply' } | { readonly kind: 'part-origin'; readonly partId: string }
}
export type ProjectCommunicationNavigation =
  | { readonly kind: 'available'; readonly projectId: string; readonly target: ProjectNavigationTarget; readonly eventSeq: number; readonly messageId?: string }
  | { readonly kind: 'unavailable'; readonly reason: string }
export interface ResolveProjectCommunicationFileRequest {
  readonly projectId: string
  readonly record: ProjectCommunicationRecord
  readonly attachmentId: string
}
export type ProjectCommunicationFile =
  | { readonly kind: 'available'; readonly path: string }
  | { readonly kind: 'unavailable'; readonly reason: string }
