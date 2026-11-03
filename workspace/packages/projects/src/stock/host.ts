import type { ReadProjectCommunicationRequest, ProjectCommunicationRead, ResolveProjectCommunicationNavigationRequest, ProjectCommunicationNavigation, ResolveProjectCommunicationFileRequest, ProjectCommunicationFile } from '../public-types.ts'
import type { DeleteExecutionSessionRequest,DeleteProjectRequest,ProjectDeletionActionResult } from "../public-types.ts"
import type {
  ProjectScheduleReadRequest, ProjectScheduleSaveRequest, ProjectScheduleEnabledRequest,
  ProjectScheduleRemoveRequest, ProjectScheduleRunNowRequest, ScheduleSnapshot, ScheduleWriteResult, ManualRunAdmissionResult,
} from '../public-types.ts'
import type {
  ExecutionLifecycleActionRequest,
  ExecutionLifecycleActionResult,
  ProjectLifecycleActionRequest,
  ProjectLifecycleActionResult,
} from '../public-types.ts'
/** Projects Remote owner: durable Project records plus empty DSH root Sessions. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import type {
  QueryProjectHistoryRequest, ReadProjectHistoryRequest, ProjectHistorySearchResult, ProjectHistoryReadResult,
  ProjectEnvironmentView, ProjectInstructionsSaveRequest, OverviewSourceRequest, ExecutionDefaultsSaveRequest, SessionInstructionsRequest, SessionInstructionsSaveRequest, UsageRefresh,
  CreateProjectRequest,
  CreateProjectResult,
  CreateProjectSessionRequest,
  GetProjectRequest,
  ProjectDetail,
  ProjectNativeSourceRead,
  ProjectSummary,
  ReadMemoryRequest, SaveMemoryRequest, WithdrawMemoryRequest, ReadMemorySourceRequest,
  ProjectMemorySourceView, ReadMemorySourceContentRequest, ProjectMemorySourceContentPage,
  ReadProjectSourceRequest,
  UpdateProjectRequest,
  RenameExecutionSessionRequest, RenameExecutionSessionResult,
} from '../public-types.ts'
import { ProjectNotFoundError } from '../runtime.ts'
import type {
  LibraryListRequest, LibraryAddRequest, LibraryEntryRequest, LibraryEntry,
  LibraryOpenRequest, LibraryOpenResult, LibraryListing,
} from '../library-contract.ts'
import type { OverviewRequest, OverviewSourceView, OverviewView } from '../features/overview/contract.ts'
import type { ExecutionDefaults, ExecutionDefaultsView, ModelCatalog, ProjectInstructions, SessionInstructions, SettingsWriteResult } from '../features/settings/types.ts'
import type { ProjectUsageQuery, ProjectUsageResult } from '../features/usage/contract.ts'
import type { ProjectMemoryNotice } from '../memory-notices.ts'
import type { MemorySnapshot, ProjectMemory, MemoryWriteResult } from '../memory-types.ts'
import type { ControlledScheduleDependencies } from '../features/schedule/runtime.ts'

import type {
  ModelCatalog as NativeModelCatalog, SessionCancelRequest, SessionCancelValue, SessionFollowFrame,
  SessionFollowRequest, SessionPage, SessionPageRequest, SessionPromptRequest,
  SessionPromptValue, SessionSelectModelRequest, SessionSelectModelValue,
  SessionUpdateQueueRequest, SessionUpdateQueueValue,
  SessionProjectionsValue, SkillListRequest, SkillListValue, SessionSearchRequest, SessionSearchValue,
  SessionAttachmentRequest, SessionAttachmentValue, SessionRenameValue,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-client-connection'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { JobListRequest, JobListFrame, JobFollowRequest, JobFollowFrame, JobKillValue } from '@deepseek-ai/dsh-api-job-controller/types'
import type { WorkspaceFileDiff } from '@deepseek-ai/dsh-workspace-changes/types'
import type { WorkspaceFileText, WorkspaceFileBytes, WorkspaceFileStat, WorkspaceDirectoryListing, WorkspaceFileWatchFrame } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { CommandDescriptor, CommandExecution } from '@deepseek-ai/dsh-commands/types'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types'
import type { SessionReferenceMentionCandidate } from '@deepseek-ai/dsh-session-reference/types'
import type {
  ProjectUiProjectionsRequest, ProjectUiCarrierAddress, ProjectUiTarget, ProjectUiCommandRequest, ProjectUiQueryRequest, ProjectUiUploadRequest, ProjectUiUploadValue, ProjectUiPermissionCatalog, ProjectUiAgentPresetRoster,
  ProjectUiPromptRequest, ProjectUiCancelRequest, ProjectUiUpdateQueueRequest, ProjectUiSelectModelRequest,
  ProjectUiRenameRequest, ProjectUiInteractionFrame, ProjectUiInteractionResponse,
  ProjectUiQuestionRequest, ProjectUiQuestionAnswerRequest, ProjectUiPlanRequest,
  ProjectUiFileRequest, ProjectUiFileReadRequest, ProjectUiFileBytesRequest,
  ProjectUiSubagentPromptRequest, ProjectUiSubagentInterruptRequest, ProjectUiSubagentInfo, ProjectUiSubagentAddress, ProjectUiSubagentPromptReceipt, ProjectUiSubagentInterruptReceipt, ProjectUiJobKillRequest, ProjectUiAgentPresetSelectRequest, ProjectUiChangesRequest, ProjectUiChangesDiffRequest, ProjectUiChangesSummary,
} from './ui-host/types.ts'
import { ProjectsFacade, type ProjectsFacadeConfig, type ProjectsUiControlFrame, type ProjectConfigurationStatus } from './facade.ts'

export type Config = ProjectsFacadeConfig
export const Config: z<Config> = z.object({
  dataRoot: z.string().min(1).required(),
  presetId: z.union([z.string().min(1), z.const(undefined)]),
  sessionManagerTimeoutMs: z.number().min(1).max(2147483647).step(1).default(60000),
  memoryModel: z.union([z.object({ provider: z.string().min(1).required(), model: z.string().min(1).required(), maxTokens: z.number().min(1) }), z.const(undefined)]),
  sessionManagerModel: z.union([z.object({ provider: z.string().min(1).required(), model: z.string().min(1).required(), maxTokens: z.number().min(1) }), z.const(undefined)]),
  originalRecording: z.object({ streamCheckpointBytes: z.number().min(1).default(4096), streamCheckpointIntervalMs: z.number().min(1).default(1000) }).default({ streamCheckpointBytes: 4096, streamCheckpointIntervalMs: 1000 }),
})
/** Only configuration and transport owners are injected from the ordinary root. */
export const inject = ['loader', 'llm', 'agentPresets', 'agentDefaultModel', 'typert']
declare module '@deepseek-ai/cordis' { interface Context { projectsController: ProjectsController } }

export class ProjectsController extends TypertRemoteService {
  private readonly facade: ProjectsFacade
  private get runtime() { return this.facade.domain }
  constructor(ctx: Context, config: Config) {
    super(ctx, 'projectsController', { namespace: 'projects' })
    this.facade = new ProjectsFacade(ctx, config)
    ctx.inject(['connection'], scope => {
      scope.effect(() => scope.connection.fetch.register({
        path: '/api/projects/uploadFileBinary', methods: ['POST'], requestBody: 'streaming',
        fetch: async request => {
          const id = new URL(request.url).searchParams.get('sessionId')
          if (!id) return new Response('Missing Project carrier', { status: 400 })
          return this.facade.uiUploadFetch({ sessionId: SessionId(id) }, request)
        },
      }), 'projects: authenticated binary upload')
    })
  }
  initialize(): Promise<void> { return this.facade.initialize() }
  async dispose(): Promise<void> {
    const result = await this.facade.close()
    if (result?.status === 'partial') throw new Error(`Projects shutdown was partial: ${JSON.stringify(result.owners)}`)
  }

  @Remote('deleteExecutionSession')
  async deleteExecutionSession(request:DeleteExecutionSessionRequest,signal:AbortSignal):Promise<ProjectDeletionActionResult>{return this.runtime.acceptOperation(()=>{signal.throwIfAborted();return this.runtime.deleteExecutionSession(request)})}
  @Remote('deleteProject')
  async deleteProject(request:DeleteProjectRequest,signal:AbortSignal):Promise<ProjectDeletionActionResult>{return this.runtime.acceptOperation(()=>{signal.throwIfAborted();return this.runtime.deleteProject(request)})}

  /** Private fixture dependency injection into this installed singleton. Deliberately no @Remote action. */
  private async controlledScheduleFixture(dependencies: ControlledScheduleDependencies): Promise<void> {
    await this.runtime.scheduleRuntime.connectControlled(dependencies)
  }

  @Remote('list')
  list(signal: AbortSignal): Promise<readonly ProjectSummary[]> { return this.facade.list(signal) }

  @Remote('create')
  create(request: CreateProjectRequest, signal: AbortSignal): Promise<CreateProjectResult> { return this.facade.create(request, signal) }

  @Remote('get')
  get(request: GetProjectRequest, signal: AbortSignal): Promise<ProjectDetail> { return this.facade.get(request, signal) }

  /** Stream one Project's committed records and confirmed lifecycle release without waking an Agent. */
  @Remote({ mode: 'stream' })
  watch(request: GetProjectRequest, signal: AbortSignal): AsyncIterable<ProjectDetail> {
    return this.runtime.watch(request.projectId, signal)
  }

  /** Read the exact saved sender/recipient record without running an Agent. */
  @Remote('readCommunication')
  async readCommunication(request: ReadProjectCommunicationRequest, signal: AbortSignal): Promise<ProjectCommunicationRead> {
    return this.runtime.acceptOperation(() => this.runtime.readCommunication(request, signal))
  }

  @Remote('resolveCommunicationNavigation')
  async resolveCommunicationNavigation(request: ResolveProjectCommunicationNavigationRequest, signal: AbortSignal): Promise<ProjectCommunicationNavigation> {
    return this.runtime.acceptProjectOperation(request.projectId, () => this.runtime.resolveCommunicationNavigation(request, signal))
  }

  @Remote('resolveCommunicationFile')
  async resolveCommunicationFile(request: ResolveProjectCommunicationFileRequest, signal: AbortSignal): Promise<ProjectCommunicationFile> {
    return this.runtime.acceptProjectOperation(request.projectId, () => this.runtime.resolveCommunicationFile(request, signal))
  }

  /** Read a Project-referenced native source without resuming its Session Agent. */
  @Remote('readSource')
  async readSource(request: ReadProjectSourceRequest, signal: AbortSignal): Promise<ProjectNativeSourceRead> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    return this.runtime.acceptProjectOperation(request.projectId,async () => {
    signal.throwIfAborted()
    try {
      return await this.runtime.readSource(request, signal)
    } catch (error: unknown) {
      if (isProjectNotFound(error)) throw projectNotFound(request.projectId)
      throw error
    }
  
    })
  }

  @Remote('queryHistory')
  async queryHistory(request: QueryProjectHistoryRequest, signal: AbortSignal): Promise<ProjectHistorySearchResult> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    return this.runtime.acceptProjectOperation(request.projectId,async () => {
    return this.runtime.queryHistory(request, signal)
  
    })
  }

  @Remote('readHistory')
  async readHistory(request: ReadProjectHistoryRequest, signal: AbortSignal): Promise<ProjectHistoryReadResult> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    return this.runtime.acceptProjectOperation(request.projectId,async () => {
    return this.runtime.readHistory(request, signal)
  
    })
  }

  @Remote('createSession')
  createSession(request: CreateProjectSessionRequest, signal: AbortSignal): Promise<ProjectDetail> { return this.facade.createSession(request, signal) }

  /** Update the basic Project metadata currently supported by P1.0. */
  @Remote('executionLifecycle')
  async executionLifecycle(request: ExecutionLifecycleActionRequest, signal: AbortSignal): Promise<ExecutionLifecycleActionResult> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    return this.runtime.acceptOperation(async () => {
    signal.throwIfAborted()
    return this.runtime.executionLifecycle(request)
  
    })
  }

  /** Archive or restore the entire Project; main-session actions use this same owner. */
  @Remote('projectLifecycle')
  async projectLifecycle(request: ProjectLifecycleActionRequest, signal: AbortSignal): Promise<ProjectLifecycleActionResult> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    return this.runtime.acceptOperation(async () => {
    signal.throwIfAborted()
    return this.runtime.projectLifecycle(request)
  
    })
  }

  @Remote('renameExecutionSession')
  async renameExecutionSession(request: RenameExecutionSessionRequest, signal: AbortSignal): Promise<RenameExecutionSessionResult> {
    signal.throwIfAborted()
    try { return await this.runtime.renameExecutionSession(request) }
    catch (error: unknown) {
      if (isProjectNotFound(error)) throw projectNotFound(request.projectId)
      throw error
    }
  }

  @Remote('update')
  async update(request: UpdateProjectRequest, signal: AbortSignal): Promise<ProjectDetail> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    return this.runtime.acceptProjectOperation(request.projectId,async () => {
    signal.throwIfAborted()
    try {
      return await this.runtime.update(request)
    } catch (error: unknown) {
      if (isProjectNotFound(error)) throw projectNotFound(request.projectId)
      throw error
    }
  
    })
  }

  @Remote('libraryList')
  async libraryList(request: LibraryListRequest, signal: AbortSignal): Promise<LibraryListing> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    return this.runtime.acceptProjectOperation(request.projectId,async () => {
    signal.throwIfAborted()
    return this.runtime.library.list(request, signal)
  
    })
  }

  @Remote('libraryAdd')
  async libraryAdd(request: LibraryAddRequest, signal: AbortSignal): Promise<LibraryEntry> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    return this.runtime.acceptProjectOperation(request.projectId,async () => {
    signal.throwIfAborted()
    return this.runtime.library.add(request)
  
    })
  }

  @Remote('libraryOpen')
  async libraryOpen(request: LibraryOpenRequest, signal: AbortSignal): Promise<LibraryOpenResult> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    return this.runtime.acceptProjectOperation(request.projectId,async () => {
    return this.runtime.library.open(request, signal)
  
    })
  }

  @Remote('libraryRemove')
  async libraryRemove(request: LibraryEntryRequest, signal: AbortSignal): Promise<void> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    return this.runtime.acceptProjectOperation(request.projectId,async () => {
    signal.throwIfAborted()
    await this.runtime.library.remove(request)
  
    })
  }

  @Remote('overviewRead')
  async overviewRead(request: OverviewRequest, signal: AbortSignal): Promise<OverviewView> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    return this.runtime.acceptProjectOperation(request.projectId,async () => {
    signal.throwIfAborted()
    return this.runtime.features.overview().read(request)
  
    })
  }

  @Remote('overviewSource')
  async overviewSource(request: OverviewSourceRequest, signal: AbortSignal): Promise<OverviewSourceView> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    return this.runtime.acceptProjectOperation(request.projectId,async () => {
    signal.throwIfAborted()
    return this.runtime.features.overviewSource(request)
  
    })
  }

  @Remote('settingsEnvironment')
  async settingsEnvironment(request: SessionInstructionsRequest, signal: AbortSignal): Promise<ProjectEnvironmentView> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    return this.runtime.acceptProjectOperation(request.projectId,async () => {
    signal.throwIfAborted()
    const view = await this.runtime.core.forProject(request.projectId)
    if (!view.snapshot.sessions.some(item => item.id === request.sessionId && item.role !== 'memory')) throw new Error('工作位置目标不属于当前项目。')
    let sessionDirectory: string | undefined, message: string | undefined
    try { sessionDirectory = (await this.runtime.core.forSession(request.projectId, request.sessionId)).workingDirectory }
    catch { message = '本会话当前实际工作位置不可读，未用项目默认位置替代。' }
    signal.throwIfAborted()
    return { projectId: view.project.id, sessionId: request.sessionId, projectDirectory: view.projectRoot,
      ...(view.configuredWorkspace === undefined ? {} : { configuredWorkspace: view.configuredWorkspace }),
      ...(sessionDirectory === undefined ? { message } : { sessionDirectory }) }
  
    })
  }

  @Remote('settingsCatalog')
  async settingsCatalog(signal: AbortSignal): Promise<ModelCatalog> {
    return this.facade.uiModelCatalog(signal)
  }

  @Remote('executionDefaultsRead')
  async executionDefaultsRead(request: GetProjectRequest, signal: AbortSignal): Promise<ExecutionDefaultsView> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    return this.runtime.acceptProjectOperation(request.projectId,async () => {
    return this.runtime.features.settings.readExecutionDefaults({ ...request, signal })
  
    })
  }

  @Remote('executionDefaultsSave')
  async executionDefaultsSave(request: ExecutionDefaultsSaveRequest, signal: AbortSignal): Promise<SettingsWriteResult<ExecutionDefaults>> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    return this.runtime.acceptProjectOperation(request.projectId,async () => {
    return this.runtime.features.settings.saveExecutionDefaults({ projectId: request.projectId, signal }, request.selection, request.expectedRevision)
  
    })
  }

  @Remote('projectInstructionsRead')
  async projectInstructionsRead(request: GetProjectRequest, signal: AbortSignal): Promise<ProjectInstructions> {
    return this.runtime.acceptProjectOperation(request.projectId, () =>
      this.runtime.features.settings.readProjectInstructions({ projectId: request.projectId, signal }))
  }

  @Remote('projectInstructionsSave')
  async projectInstructionsSave(request: ProjectInstructionsSaveRequest, signal: AbortSignal): Promise<SettingsWriteResult<ProjectInstructions>> {
    return this.runtime.acceptProjectOperation(request.projectId, () =>
      this.runtime.features.settings.saveProjectInstructions({ projectId: request.projectId, signal }, request.text, request.expectedRevision))
  }

  @Remote('sessionInstructionsRead')
  async sessionInstructionsRead(request: SessionInstructionsRequest, signal: AbortSignal): Promise<SessionInstructions> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    return this.runtime.acceptProjectOperation(request.projectId,async () => {
    return this.runtime.features.settings.readSessionInstructions({ ...request, signal })
  
    })
  }

  @Remote('sessionInstructionsSave')
  async sessionInstructionsSave(request: SessionInstructionsSaveRequest, signal: AbortSignal): Promise<SettingsWriteResult<SessionInstructions>> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    return this.runtime.acceptProjectOperation(request.projectId,async () => {
    return this.runtime.features.settings.saveSessionInstructions({ projectId: request.projectId, sessionId: request.sessionId, signal }, request.text, request.expectedRevision)
  
    })
  }

  @Remote('usage')
  async usage(request: ProjectUsageQuery, signal: AbortSignal): Promise<ProjectUsageResult> {
    // Runtime owns this consumer; ProjectsRead separately drains already-started shared I/O.
    return this.runtime.acceptProjectOperation(request.projectId,async () => {
    signal.throwIfAborted()
    return this.runtime.features.usage.query(request, signal)
  
    })
  }

  @Remote('scheduleRead')
  async scheduleRead(request: ProjectScheduleReadRequest, signal: AbortSignal): Promise<ScheduleSnapshot> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    return this.runtime.acceptProjectOperation(request.projectId,async () => {
    return this.runtime.features.schedule.read({ ...this.runtime.features.scheduleSettingsRequest(request.projectId, 'read'), signal })
  
    })
  }

  @Remote('scheduleSave')
  async scheduleSave(request: ProjectScheduleSaveRequest, signal: AbortSignal): Promise<ScheduleWriteResult> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    return this.runtime.acceptProjectOperation(request.projectId,async () => {
    return this.runtime.features.schedule.save({ ...this.runtime.features.scheduleSettingsRequest(request.projectId, request.changeId), signal }, request.input)
  
    })
  }

  @Remote('scheduleSetEnabled')
  async scheduleSetEnabled(request: ProjectScheduleEnabledRequest, signal: AbortSignal): Promise<ScheduleWriteResult> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    return this.runtime.acceptProjectOperation(request.projectId,async () => {
    return this.runtime.features.schedule.setEnabled({ ...this.runtime.features.scheduleSettingsRequest(request.projectId, request.changeId), signal }, request.scheduleId, request.enabled, request.expectedRevision)
  
    })
  }

  @Remote('scheduleRemove')
  async scheduleRemove(request: ProjectScheduleRemoveRequest, signal: AbortSignal): Promise<ScheduleWriteResult> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    return this.runtime.acceptProjectOperation(request.projectId,async () => {
    return this.runtime.features.schedule.remove({ ...this.runtime.features.scheduleSettingsRequest(request.projectId, request.changeId), signal }, request.scheduleId, request.expectedRevision)
  
    })
  }

  @Remote('scheduleRunNow')
  async scheduleRunNow(request: ProjectScheduleRunNowRequest, signal: AbortSignal): Promise<ManualRunAdmissionResult> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    return this.runtime.acceptProjectOperation(request.projectId,async () => {
    return this.runtime.features.schedule.runNow({ ...this.runtime.features.scheduleSettingsRequest(request.projectId, request.input.requestId), signal }, request.input)
  
    })
  }

  @Remote({ mode: 'stream' })
  watchUsage(request: GetProjectRequest, signal: AbortSignal): AsyncIterable<UsageRefresh> {
    return this.runtime.features.watchUsage(request.projectId, signal)
  }

  @Remote({ mode: 'stream' })
  watchMemoryChanges(request: GetProjectRequest, signal: AbortSignal): AsyncIterable<ProjectMemoryNotice> {
    return this.runtime.watchMemoryChanges(request.projectId, signal)
  }

  @Remote('memoryList')
  async memoryList(request: GetProjectRequest, signal: AbortSignal): Promise<MemorySnapshot> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    return this.runtime.acceptProjectOperation(request.projectId,async () => {
    return this.runtime.memory.list({ ...request, actor: { kind: 'settings' }, signal })
  
    })
  }

  @Remote('memoryRead')
  async memoryRead(request: ReadMemoryRequest, signal: AbortSignal): Promise<ProjectMemory | undefined> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    return this.runtime.acceptProjectOperation(request.projectId,async () => {
    return this.runtime.memory.read({ projectId: request.projectId, actor: { kind: 'settings' }, signal }, request.id)
  
    })
  }

  @Remote('memorySave')
  async memorySave(request: SaveMemoryRequest, signal: AbortSignal): Promise<MemoryWriteResult> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    const runtime = this.runtime
    return runtime.acceptProjectOperation(request.projectId,async () => {
    const result = await runtime.memory.saveFromSettings({ projectId: request.projectId, actor: { kind: 'settings' }, signal }, request.input)
    if (result.kind === 'saved') runtime.publishMemoryNotice({ projectId: request.projectId, kind: request.input.id === undefined ? 'added' : 'updated', memoryIds: [result.memory.id] })
    return result
  
    })
  }

  @Remote('memoryWithdraw')
  async memoryWithdraw(request: WithdrawMemoryRequest, signal: AbortSignal): Promise<MemoryWriteResult> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    const runtime = this.runtime
    return runtime.acceptProjectOperation(request.projectId,async () => {
    const result = await runtime.memory.withdraw({ projectId: request.projectId, actor: { kind: 'settings' }, signal }, request.id, request.expectedRevision, request.expectedGeneration)
    if (result.kind === 'withdrawn') runtime.publishMemoryNotice({ projectId: request.projectId, kind: 'updated', memoryIds: [result.id] })
    return result
  
    })
  }

  @Remote('memorySource')
  async memorySource(request: ReadMemorySourceRequest, signal: AbortSignal): Promise<ProjectMemorySourceView> {
    // 原Runtime持有本次已接纳请求到所有读取句柄/写入真实结算。
    return this.runtime.acceptProjectOperation(request.projectId,async () => {
    const read = await this.runtime.memory.readSource({ projectId: request.projectId, actor: { kind: 'settings' }, signal }, request.source)
    return { ...read, source: read.source ?? request.source }
  
    })
  }
  @Remote('memorySourceContent')
  async memorySourceContent(request: ReadMemorySourceContentRequest, signal: AbortSignal): Promise<ProjectMemorySourceContentPage> {
    return this.runtime.acceptProjectOperation(request.projectId, () => this.runtime.readMemorySourceContent(request, signal))
  }

  @Remote({ mode: 'stream' })
  uiControl(signal: AbortSignal): AsyncIterable<ProjectsUiControlFrame> { return this.facade.uiControl(signal) }
  @Remote({ mode: 'stream' })
  uiFollow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> { return this.facade.uiFollow(request, signal) }
  @Remote('uiPage')
  uiPage(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage> { return this.facade.uiPage(request, signal) }
  @Remote('uiPrompt')
  uiPrompt(request: ProjectUiPromptRequest, signal: AbortSignal): Promise<SessionPromptValue> { return this.facade.uiPrompt(request, signal) }
  @Remote('uiCancel')
  uiCancel(request: ProjectUiCancelRequest): Promise<SessionCancelValue> { return this.facade.uiCancel(request) }
  @Remote('uiUpdateQueue')
  uiUpdateQueue(request: ProjectUiUpdateQueueRequest): Promise<SessionUpdateQueueValue> { return this.facade.uiUpdateQueue(request) }
  @Remote('uiModelCatalog')
  uiModelCatalog(signal: AbortSignal): Promise<NativeModelCatalog> { return this.facade.uiModelCatalog(signal) }
  @Remote('uiSelectModel')
  uiSelectModel(request: ProjectUiSelectModelRequest): Promise<SessionSelectModelValue> { return this.facade.uiSelectModel(request) }

  @Remote('projectInstructions')
  projectInstructions(request: GetProjectRequest, signal: AbortSignal): Promise<ProjectInstructions> { return this.facade.readProjectInstructions(request, signal) }
  @Remote('saveProjectInstructions')
  saveProjectInstructions(request: ProjectInstructionsSaveRequest, signal: AbortSignal): Promise<SettingsWriteResult<ProjectInstructions>> { return this.facade.saveProjectInstructions(request, signal) }
  @Remote('sessionInstructions')
  sessionInstructions(request: SessionInstructionsRequest, signal: AbortSignal): Promise<SessionInstructions> { return this.facade.readSessionInstructions(request, signal) }
  @Remote('saveSessionInstructions')
  saveSessionInstructions(request: SessionInstructionsSaveRequest, signal: AbortSignal): Promise<SettingsWriteResult<SessionInstructions>> { return this.facade.saveSessionInstructions(request, signal) }
  @Remote('uiCarrierAddress')
  uiCarrierAddress(request: ProjectUiTarget): Promise<ProjectUiCarrierAddress> { return this.facade.uiCarrierAddress(request) }
  @Remote({ mode: 'stream' })
  uiFollowReadonly(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> { return this.facade.uiFollowReadonly(request, signal) }
  @Remote('uiProjections')
  uiProjections(request: ProjectUiProjectionsRequest, signal: AbortSignal): Promise<SessionProjectionsValue> { return this.facade.uiProjections(request, signal) }
  @Remote('uiRename')
  uiRename(request: ProjectUiRenameRequest): Promise<SessionRenameValue> { return this.facade.uiRename(request) }
  @Remote('uiAttachment')
  uiAttachment(request: SessionAttachmentRequest): Promise<SessionAttachmentValue> { return this.facade.uiAttachment(request) }
  @Remote('uiCommandCatalog')
  uiCommandCatalog(request: ProjectUiTarget, signal: AbortSignal): Promise<readonly CommandDescriptor[]> { return this.facade.uiCommandCatalog(request, signal) }
  @Remote('uiExecuteCommand')
  uiExecuteCommand(request: ProjectUiCommandRequest, signal: AbortSignal): Promise<CommandExecution | undefined> { return this.facade.uiExecuteCommand(request, signal) }
  @Remote('uiFileCandidates')
  uiFileCandidates(request: ProjectUiQueryRequest, signal: AbortSignal): Promise<FileReferenceCandidate[]> { return this.facade.uiFileCandidates(request, signal) }
  @Remote('uiSessionCandidates')
  uiSessionCandidates(request: ProjectUiQueryRequest, signal: AbortSignal): Promise<SessionReferenceMentionCandidate[]> { return this.facade.uiSessionCandidates(request, signal) }
  @Remote('uiSkills')
  uiSkills(request: SkillListRequest, signal: AbortSignal): Promise<SkillListValue> { return this.facade.uiSkills(request, signal) }
  @Remote('uiUpload')
  uiUpload(request: ProjectUiUploadRequest, signal: AbortSignal): Promise<ProjectUiUploadValue> { return this.facade.uiUpload(request, signal) }
  @Remote({ mode: 'stream' })
  uiInteractions(request: ProjectUiTarget, signal: AbortSignal): AsyncIterable<ProjectUiInteractionFrame> { return this.facade.uiInteractions(request, signal) }
  @Remote('uiRespondInteraction')
  uiRespondInteraction(request: ProjectUiInteractionResponse): Promise<{ readonly accepted: boolean }> { return this.facade.uiRespondInteraction(request) }
  @Remote('uiAnswerQuestion')
  uiAnswerQuestion(request: ProjectUiQuestionAnswerRequest): Promise<boolean> { return this.facade.uiAnswerQuestion(request) }
  @Remote({ mode: 'stream' })
  uiAttachQuestionWait(request: ProjectUiQuestionRequest, signal: AbortSignal): AsyncIterable<{ remainingMs: number }> { return this.facade.uiAttachQuestionWait(request, signal) }
  @Remote('uiSetPlan')
  uiSetPlan(request: ProjectUiPlanRequest): Promise<'committed' | 'queued' | 'cancelled' | 'noop'> { return this.facade.uiSetPlan(request) }
  @Remote('uiReadFile')
  uiReadFile(request: ProjectUiFileReadRequest, signal: AbortSignal): Promise<WorkspaceFileText> { return this.facade.uiReadFile(request, signal) }
  @Remote('uiReadFileBytes')
  uiReadFileBytes(request: ProjectUiFileBytesRequest, signal: AbortSignal): Promise<WorkspaceFileBytes> { return this.facade.uiReadFileBytes(request, signal) }
  @Remote('uiStatFile')
  uiStatFile(request: ProjectUiFileRequest, signal: AbortSignal): Promise<WorkspaceFileStat> { return this.facade.uiStatFile(request, signal) }
  @Remote('uiListFiles')
  uiListFiles(request: ProjectUiFileRequest, signal: AbortSignal): Promise<WorkspaceDirectoryListing> { return this.facade.uiListFiles(request, signal) }
  @Remote({ mode: 'stream' })
  uiFileChanges(request: ProjectUiFileRequest, signal: AbortSignal): AsyncIterable<WorkspaceFileWatchFrame> { return this.facade.uiFileChanges(request, signal) }
  @Remote('uiSubagentAddress')
  uiSubagentAddress(request: ProjectUiTarget, signal: AbortSignal): Promise<ProjectUiSubagentAddress | undefined> { return this.facade.uiSubagentAddress(request, signal) }
  @Remote('uiSubagentCatalog')
  uiSubagentCatalog(request: ProjectUiTarget, signal: AbortSignal): Promise<readonly ProjectUiSubagentInfo[]> { return this.facade.uiSubagentCatalog(request, signal) }
  @Remote('uiSubagentPrompt')
  uiSubagentPrompt(request: ProjectUiSubagentPromptRequest, signal: AbortSignal): Promise<ProjectUiSubagentPromptReceipt> { return this.facade.uiSubagentPrompt(request, signal) }
  @Remote('uiSubagentInterrupt')
  uiSubagentInterrupt(request: ProjectUiSubagentInterruptRequest): Promise<ProjectUiSubagentInterruptReceipt> { return this.facade.uiSubagentInterrupt(request) }
  @Remote({ mode: 'stream' })
  uiJobList(request: JobListRequest, signal: AbortSignal): AsyncIterable<JobListFrame> { return this.facade.uiJobList(request, signal) }
  @Remote({ mode: 'stream' })
  uiJobFollow(request: JobFollowRequest, signal: AbortSignal): AsyncIterable<JobFollowFrame> { return this.facade.uiJobFollow(request, signal) }
  @Remote('uiJobKill')
  uiJobKill(request: ProjectUiJobKillRequest): Promise<JobKillValue> { return this.facade.uiJobKill(request) }
  @Remote('uiConfigurationStatus')
  uiConfigurationStatus(signal: AbortSignal): Promise<ProjectConfigurationStatus> { return this.facade.uiConfigurationStatus(signal) }
  @Remote({ mode: 'stream' })
  uiWatchConfiguration(signal: AbortSignal): AsyncIterable<ProjectConfigurationStatus> { return this.facade.uiWatchConfiguration(signal) }
  @Remote('uiSearch')
  uiSearch(request: SessionSearchRequest, signal: AbortSignal): Promise<SessionSearchValue> { return this.facade.uiSearch(request, signal) }
  @Remote('uiPermissionCatalog')
  uiPermissionCatalog(signal: AbortSignal): Promise<ProjectUiPermissionCatalog> { return this.facade.uiPermissionCatalog(signal) }
  @Remote('uiAgentPresetList')
  uiAgentPresetList(signal: AbortSignal): Promise<ProjectUiAgentPresetRoster> { return this.facade.uiAgentPresetList(signal) }
  @Remote('uiAgentPresetSelect')
  uiAgentPresetSelect(request: ProjectUiAgentPresetSelectRequest): Promise<string> { return this.facade.uiAgentPresetSelect(request) }
  @Remote('uiChangesSummary')
  uiChangesSummary(request: ProjectUiChangesRequest, signal: AbortSignal): Promise<ProjectUiChangesSummary | undefined> { return this.facade.uiChangesSummary(request, signal) }
  @Remote('uiChangesDiff')
  uiChangesDiff(request: ProjectUiChangesDiffRequest, signal: AbortSignal): Promise<WorkspaceFileDiff | undefined> { return this.facade.uiChangesDiff(request, signal) }
}

/**
 * Register the only root close owner first. Preset diagnostics may await the
 * root Loader; keeping that Loader entry pending on private startup would make
 * it wait for itself. Projects serves explicit not-ready until startup settles.
 */
export async function* apply(ctx: Context, config: Config): AsyncGenerator<() => Promise<void>, void, void> {
  const controller = new ProjectsController(ctx, config)
  yield () => controller.dispose()
  void controller.initialize().catch((error: unknown) => { ctx.logger.error('Projects initialization failed: %o', error) })
}

function projectNotFound(projectId: string): RemoteError<'projects/not-found'> {
  return new RemoteError('projects/not-found', `Project "${projectId}" was not found`, { projectId })
}

function isProjectNotFound(error: unknown): boolean {
  return error instanceof ProjectNotFoundError
}
