/** Browser-only, explicit Projects RPC faces for the complete private client. */
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionRemote } from '@deepseek-ai/dsh-api-session-controller/client'
import type { CommandDescriptor, CommandExecution } from '@deepseek-ai/dsh-commands/types'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types'
import type { SessionReferenceMentionCandidate } from '@deepseek-ai/dsh-session-reference/types'
import type { FileUploadValue } from '@deepseek-ai/dsh-client-file-upload/types'
import type { RemoteResult, RemoteStreamHandle, TypertClientEventListener } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CreateProjectRequest, CreateProjectResult, GetProjectRequest, ProjectDetail, ProjectSummary } from '../../../public-types.ts'
import type { ProjectClientControlFrame } from '../remote-shim.ts'
import type {
  ProjectUiProjectionsRequest, ProjectUiTarget, ProjectUiPromptRequest, ProjectUiCancelRequest, ProjectUiUpdateQueueRequest,
  ProjectUiSelectModelRequest, ProjectUiRenameRequest, ProjectUiCommandRequest, ProjectUiQueryRequest,
  ProjectUiQuestionAnswerRequest, ProjectUiQuestionRequest, ProjectUiPlanRequest, ProjectUiUploadRequest,
  ProjectUiInteractionFrame, ProjectUiInteractionResponse,
  ProjectUiSubagentPromptRequest, ProjectUiSubagentInterruptRequest, ProjectUiSubagentInfo,
  ProjectUiAgentPresetSelectRequest,
  ProjectUiJobKillRequest,
} from '../../ui-host/types.ts'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { ProjectNativeHostNotificationSource } from '../native-host-notifications.ts'

export interface ProjectClientRemotePort {
  list(): Promise<RemoteResult<readonly ProjectSummary[]>>
  create(input: CreateProjectRequest): Promise<RemoteResult<CreateProjectResult>>
  get(input: GetProjectRequest, signal?: AbortSignal): Promise<RemoteResult<ProjectDetail>>
  uiControl(signal?: AbortSignal): RemoteStreamHandle<ProjectClientControlFrame, never>
  uiFollow: SessionRemote['follow']
  uiPage: SessionRemote['page']
  uiPrompt: SessionRemote['prompt']
  uiCancel: SessionRemote['cancel']
  uiUpdateQueue: SessionRemote['updateQueue']
  uiModelCatalog: SessionRemote['modelCatalog']
  uiSelectModel: SessionRemote['selectModel']
}

/** Every production capability is required. No native RPC fallback is consulted. */
export interface FullProjectClientRemotePort extends ProjectClientRemotePort {
  uiFollowReadonly: SessionRemote['follow']
  uiPrompt(request: ProjectUiPromptRequest, signal?: AbortSignal): ReturnType<SessionRemote['prompt']>
  uiCancel(request: ProjectUiCancelRequest): ReturnType<SessionRemote['cancel']>
  uiUpdateQueue(request: ProjectUiUpdateQueueRequest): ReturnType<SessionRemote['updateQueue']>
  uiSelectModel(request: ProjectUiSelectModelRequest): ReturnType<SessionRemote['selectModel']>
  uiRename(request: ProjectUiRenameRequest): ReturnType<SessionRemote['rename']>
  uiAttachment: SessionRemote['attachment']
  uiProjections(request: ProjectUiProjectionsRequest, signal?: AbortSignal): ReturnType<SessionRemote['projections']>
  uiSearch: SessionRemote['search']
  uiCommandCatalog(request: ProjectUiTarget, signal?: AbortSignal): Promise<RemoteResult<readonly CommandDescriptor[]>>
  uiExecuteCommand(request: ProjectUiCommandRequest, signal?: AbortSignal): Promise<RemoteResult<CommandExecution | undefined>>
  uiFileCandidates(request: ProjectUiQueryRequest, signal?: AbortSignal): Promise<RemoteResult<FileReferenceCandidate[]>>
  uiSessionCandidates(request: ProjectUiQueryRequest, signal?: AbortSignal): Promise<RemoteResult<SessionReferenceMentionCandidate[]>>
  uiAnswerQuestion(request: ProjectUiQuestionAnswerRequest): Promise<RemoteResult<boolean>>
  uiAttachQuestionWait(request: ProjectUiQuestionRequest, signal?: AbortSignal): RemoteStreamHandle<{ remainingMs: number }, never>
  uiSetPlan(request: ProjectUiPlanRequest): Promise<RemoteResult<'committed' | 'queued' | 'cancelled' | 'noop'>>
  uiUpload(request: ProjectUiUploadRequest, signal?: AbortSignal): Promise<RemoteResult<FileUploadValue>>
  uiInteractions(request: ProjectUiTarget, signal?: AbortSignal): RemoteStreamHandle<ProjectUiInteractionFrame, never>
  uiRespondInteraction(request: ProjectUiInteractionResponse): Promise<RemoteResult<{ readonly accepted: boolean }>>
  uiSubagentAddress(request: ProjectUiTarget, signal?: AbortSignal): Promise<RemoteResult<SubagentAddress | undefined>>
  uiSubagentCatalog(request: ProjectUiTarget, signal?: AbortSignal): Promise<RemoteResult<readonly ProjectUiSubagentInfo[]>>
  uiSubagentPrompt(request: ProjectUiSubagentPromptRequest, signal?: AbortSignal): ReturnType<ClientRemote['subagents']['prompt']>
  uiSubagentInterrupt(request: ProjectUiSubagentInterruptRequest): ReturnType<ClientRemote['subagents']['interruptByParent']>
  uiPermissionCatalog: ClientRemote['permissionPresets']['catalog']
  uiAgentPresetList: ClientRemote['agentPresets']['list']
  uiAgentPresetSelect(request: ProjectUiAgentPresetSelectRequest): ReturnType<ClientRemote['agentPresets']['select']>
  uiSkills: ClientRemote['skills']['list']
  uiJobList: ClientRemote['job']['list']
  uiJobFollow: ClientRemote['job']['follow']
  uiJobKill(request: ProjectUiJobKillRequest): ReturnType<ClientRemote['job']['kill']>
}

export type ProjectRefreshEvent = 'commands/change' | 'agent-preset/selected' | 'llm/adapters-updated'
  | 'settings/document-updated' | 'credentials/record-updated' | 'credentials/reference-updated' | 'permission-presets/catalog-changed'
export type ProjectClientRefreshFrame = {
  [Event in ProjectRefreshEvent]: { readonly type: 'refresh'; readonly event: Event; readonly args: Readonly<Parameters<TypertClientEventListener<Event>>> }
}[ProjectRefreshEvent]
export type SessionCommandsRemote = Pick<ClientRemote['commands'], 'list' | 'execute'>
export interface ProjectRemoteShimOptions {
  readonly full: FullProjectClientRemotePort
  readonly mode: 'live' | 'reader'
  /** Synchronous snapshot at admission, before the operation's first await. */
  readonly captureTarget: (id: SessionId) => ProjectUiTarget
  /** Explicit read-only invalidations from the root entry or the owning parent domain. */
  readonly hostNotifications?: ProjectNativeHostNotificationSource
}
