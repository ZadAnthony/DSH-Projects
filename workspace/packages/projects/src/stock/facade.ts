/** Project DTO owner over the private stock runtime; no private object crosses Remote. */
import type { Context, Plugin } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, ModelSelection as AgentModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-session-title'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type {
  ModelCatalog, SessionCancelRequest, SessionCancelValue, SessionControlFrame,
  SessionFollowFrame, SessionFollowRequest, SessionPage, SessionPageRequest,
  SessionProjectionsValue, SkillListRequest, SkillListValue, SessionSearchRequest, SessionSearchValue,
  SessionAttachmentRequest, SessionAttachmentValue, SessionRenameValue,
  SessionPromptRequest, SessionPromptValue, SessionSelectModelRequest,
  SessionSelectModelValue, SessionSummary, SessionUpdateQueueRequest, SessionUpdateQueueValue,
} from '@deepseek-ai/dsh-api-session-controller/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createDarwinSchedulePowerFacts } from '../features/schedule/power-darwin.ts'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type {
  CreateProjectRequest, CreateProjectResult, CreateProjectSessionRequest, GetProjectRequest,
  ProjectDetail, ProjectInstructionsSaveRequest, ProjectSummary,
  SessionInstructionsRequest, SessionInstructionsSaveRequest,
} from '../public-types.ts'
import type { Project, ProjectCarrierMembership, ProjectHostOwnership, ProjectSession, ProjectSnapshot } from '../records-types.ts'
import { ProjectStore } from '../records.ts'
import { projectDetail } from '../project-context.ts'
import { initialSessionInstructions } from '../roles.ts'
import { ProjectsRuntime, type ProjectsRuntimeOptions } from '../runtime.ts'
import { createProjectPaths, type ProjectPaths } from './project-paths.ts'
import { installProjectsReadPort, type ProjectReadPort } from './read/index.ts'
import { projectInvocationPort } from './tools/runtime.ts'
import { createProjectRecordingPort } from './recording/index.ts'
import { ProjectOwnedControl } from './control/index.ts'
import { createOwnedProjectTitles } from './control/titles.ts'
import { createOwnedStockCapabilities, type StockCapabilityOwnership } from './control/capabilities.ts'
import { ProjectsSubagentTool } from './main-delegation.ts'
import type { ProjectsLlmRuntime } from './host-ports.ts'
import type { ProjectsPresetPublication } from './presets/revisions.ts'
import { prepareProjectHarness } from './request/harness.ts'
import { ProjectsCompactionEngine } from './request/compaction.ts'
import { installMemoryCompaction } from './request/memory-compaction.ts'
import type { ProjectInstructions, SessionInstructions, SettingsWriteResult } from '../features/settings/types.ts'
import { ProjectSettingsStore } from '../features/settings/store.ts'
import { durableMutationDetails } from '../metadata-errors.ts'
import { createProjectsRuntimeGraph, type ProjectsRuntimeGraph, type ProjectsGraphCloseResult } from './graph.ts'
import type { ProjectsHostPorts } from './host-ports.ts'
import {
  captureProjectsNativeFoundations, installProjectsNativeFoundations,
  type InstalledProjectsNativeFoundations, type ProjectsNativeFoundationSnapshot,
} from './presets/native-foundations.ts'
import { installPrivateSessionUi, type PrivateSessionUiPort, type ProjectSessionControlFrame } from './ui-port.ts'
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

export interface ProjectsFacadeConfig extends Pick<ProjectsRuntimeOptions, 'memoryModel' | 'sessionManagerModel' | 'sessionManagerTimeoutMs' | 'originalRecording'> { readonly dataRoot: string; readonly presetId?: string }

/** Internal test/composition seams, never part of the Projects Remote contract. */
export interface ProjectsFacadeOptions {
  readonly hostPorts?: ProjectsHostPorts
  readonly foundationSnapshot?: ProjectsNativeFoundationSnapshot
  readonly automaticPower?: ProjectsRuntimeOptions['automaticPower']
}

export type ProjectsUiControlFrame = ProjectSessionControlFrame
export interface ProjectConfigurationStatus { readonly revision: number; readonly publication: ProjectsPresetPublication | null; readonly warnings: readonly string[] }

export type ProjectsCreationPhase = 'project-record-saved' | 'membership-saved' | 'instructions-saved'
  | 'native-created' | 'header-confirmed' | 'initial-state-durable'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'projects/not-ready': Record<string, never>
    'projects/closing': Record<string, never>
    'projects/unknown-target': { readonly carrierId: string }
    'projects/read-only-carrier': { readonly carrierId: string }
    'projects/archived': { readonly projectId: string; readonly sessionId?: string }
    'projects/source-unavailable': { readonly carrierId: string }
    'projects/invalid-workspace': {
      readonly path: string
      readonly reason: 'absolute-required' | 'not-found' | 'not-directory' | 'unreadable'
      readonly systemCode?: string
    }
    'projects/create-partial': {
      readonly projectId: string; readonly sessionId?: string; readonly carrierId?: string
      readonly phase: ProjectsCreationPhase; readonly journal: 'materialized' | 'absent' | 'unknown'
    }
    'projects/create-rejected': { readonly effect: 'none'; readonly phase: 'project-instructions' }
  }
}

class CreationFailure extends Error {
  constructor(
    readonly detail: {
      projectId: string; sessionId?: string; carrierId?: string
      phase: ProjectsCreationPhase; journal: 'materialized' | 'absent' | 'unknown'
    },
    cause: unknown,
  ) { super(`Projects 创建未完整完成（${detail.phase}）：${errorText(cause)}`, { cause }) }
}

/**
 * ProjectStore remains the only Project/logical-session/membership authority.
 * Startup recovers metadata, never Agents or pending work. Every public writer
 * is checked again by the private UI owner immediately before native execution.
 */
export class ProjectsFacade {
  private readonly dataRoot: string
  private readonly store: ProjectStore
  private runtime: ProjectsRuntime | undefined
  private readonly paths: ProjectPaths
  private read: ProjectReadPort | undefined
  private control: ProjectOwnedControl | undefined
  private get settings() { return this.requireRuntime().features.settings }
  private graph: ProjectsRuntimeGraph | undefined
  private ui: PrivateSessionUiPort | undefined
  private foundations: InstalledProjectsNativeFoundations | undefined
  private state: 'starting' | 'ready' | 'closing' | 'closed' | 'failed' = 'starting'
  private readonly pending = new Set<Promise<unknown>>()
  private readonly shutdown = new AbortController()
  private starting: Promise<void> | undefined
  private startupError: string | undefined
  private closing: Promise<ProjectsGraphCloseResult | undefined> | undefined
  private configurationRevision = 0
  private configurationPublication: ProjectsPresetPublication | null = null
  private readonly configurationListeners = new Set<() => void>()

  constructor(private readonly root: Context, private readonly config: ProjectsFacadeConfig, private readonly options: ProjectsFacadeOptions = {}) {
    this.paths = createProjectPaths(config.dataRoot)
    this.dataRoot = this.paths.dataRoot
    this.store = new ProjectStore(this.paths.recordsRoot)
  }

  /** Internal domain aggregation, never returned through the Remote protocol. */
  get domain(): ProjectsRuntime { this.assertReady(); return this.requireRuntime() }
  private requireRuntime(): ProjectsRuntime {
    if (this.runtime === undefined) throw new RemoteError('projects/not-ready', 'Projects domain is not ready', {})
    return this.runtime
  }

  initialize(): Promise<void> { return this.starting ??= this.initializeOwned() }

  private async initializeOwned(): Promise<void> {
    try {
      const ownership: StockCapabilityOwnership = {
        assertAdmitting: (id, agent) => { if (this.control === undefined) throw new Error('Project control is not ready'); this.control.assertAdmitting(id, agent) },
        track: responsibility => { if (this.control === undefined) throw new Error('Project control is not ready'); this.control.track(responsibility) },
      }
      const capabilities = createOwnedStockCapabilities(ownership)
      const moduleOverrides = new Map<string, Plugin>([
        ['@deepseek-ai/dsh-jobs-local', capabilities.Jobs],
        ['@deepseek-ai/dsh-subagent', capabilities.Subagents],
        ['@deepseek-ai/dsh-tool-subagent', ProjectsSubagentTool],
        ['@deepseek-ai/dsh-workflow-ptc', capabilities.Workflow],
        ['@deepseek-ai/dsh-compaction-basic', ProjectsCompactionEngine],
        ['@deepseek-ai/dsh-session-title', createOwnedProjectTitles(ownership)],
      ])
      const snapshot = this.options.foundationSnapshot ?? captureProjectsNativeFoundations(this.root)
      this.graph = await createProjectsRuntimeGraph(this.root, {
        dataRoot: this.dataRoot, presetId: this.config.presetId, hostPorts: this.options.hostPorts,
        registerRootCleanup: false,
        startupSignal: this.shutdown.signal,
        onConfigurationChange: publication => {
          if (JSON.stringify(publication) === JSON.stringify(this.configurationPublication)) return
          this.configurationPublication = structuredClone(publication)
          this.configurationRevision += 1
          for (const listener of this.configurationListeners) listener()
        },
        afterFactory: (_ctx, factory) => { this.control!.attachFactory(factory) },
        shouldMountWorkPreset: async (agent, parent) => {
          const ownership = await this.store.resolveHostOwnership(String(agent.id))
          if (ownership !== undefined) return ownership.session.role === 'main' || ownership.session.role === 'execution'
          if (parent !== undefined) {
            const owner = await (parent.ctx.sessionPersistence as import('./persistence/index.ts').ProjectSessionPersistence).resolveOwner(parent.id)
            if (owner === undefined) throw new Error('Project child has no saved parent owner')
            const session = await this.store.getSession(owner.projectId, owner.logicalSessionId)
            if (session === undefined) throw new Error('Project child logical membership is unavailable')
            return session.role === 'main' || session.role === 'execution'
          }
          throw new Error('Project Harness role has no saved authority')
        },
        prepareConfiguration: async () => this.foundations?.prepareRefresh(captureProjectsNativeFoundations(this.root)),
        configure: async (ctx, startupSignal) => {
          this.foundations = await installProjectsNativeFoundations(ctx, { dataRoot: this.dataRoot, snapshot, moduleOverrides })
          await this.store.init()
          const persistence = ctx.sessionPersistence as import('./persistence/index.ts').ProjectSessionPersistence
          for (const saved of await this.store.listRetainedSnapshots()) {
            for (const session of saved.sessions) {
              for (const carrier of session.carriers ?? [{ hostSessionId: session.hostSessionId }]) {
                persistence.registerSessionOwner(SessionId(carrier.hostSessionId), { projectId: saved.project.id, logicalSessionId: session.id })
              }
              for (const preparation of session.mainPreparations ?? []) if (preparation.state !== 'committed') {
                persistence.registerSessionOwner(SessionId(preparation.toHostSessionId), { projectId: saved.project.id, logicalSessionId: session.id })
              }
            }
          }
          this.read = installProjectsReadPort(ctx, { persistence, store: this.store })
          await ctx.inject(['sandboxPolicy', 'jobs', 'sessionTitle'], () => {}).await()
          this.ui = await installPrivateSessionUi(ctx, {
            dataRoot: this.dataRoot,
            startupSignal,
            defaultModel: {
              currentSelection: () => this.root.agentDefaultModel.currentSelection(),
              saveSelection: selection => this.root.agentDefaultModel.saveSelection(selection),
            },
            resolveAgent: async (id, signal) => {
              signal?.throwIfAborted()
              if (this.control === undefined) throw new Error('Projects control is not ready')
              const result = await this.control.resolve(id)
              signal?.throwIfAborted()
              if ('error' in result) throw new Error(result.error.message)
              return result.agent
            },
            resolveTarget: (id, operation) => this.resolveTarget(id, operation),
            isVisibleTarget: (id, signal) => this.isVisibleUiTarget(id, signal),
            validateCapture: address => this.validateCapture(address),
            validateRelatedCapture: (address, id) => this.validateRelatedCapture(address, id),
            subagentCatalog: async (id, signal) => {
              signal?.throwIfAborted()
              if (this.control === undefined) throw new Error('Projects control is not ready')
              const members = await this.control.inspectOwnedSessions(id)
              signal?.throwIfAborted()
              return members.map(member => ({ address: { parentSessionId: SessionId(member.parentSessionId), childSessionId: member.header.id, mode: member.mode }, sessionCreatedAt: member.header.createdAt }))
            },
            subagentAddress: async (id, signal) => this.readSubagentAddress(id, signal),
          })
          await this.foundations.ready()
          this.control = new ProjectOwnedControl(ctx, {
            persistence, store: this.store, read: this.read, getFactory: () => this.graph?.factory, recordsRoot: this.paths.recordsRoot,
            canSaveColdInput: async id => {
              const member = await this.store.findCarrierByHostSessionId(String(id))
              return member !== undefined && member.carrier.isCurrent && member.carrier.closed === undefined
                && member.project.sourceLifecycle === undefined && member.session.sourceLifecycle.kind === 'available'
                && member.carrier.sourceLifecycle.kind === 'available' && (member.project.archived || member.session.archived)
            },
          })
          const modelGateway = ctx.llm as ProjectsLlmRuntime
          modelGateway.setOwnership(this.control)
          this.runtime = new ProjectsRuntime(ctx, this.dataRoot, {
            ...this.config,
            automaticPower: this.options.automaticPower ?? (process.platform === 'darwin' ? onHint => createDarwinSchedulePowerFacts({
              bindingPath: fileURLToPath(new URL('./power-darwin/power-darwin.node', import.meta.url)), subscribe: true, onHint,
            }) : undefined),
            composition: { paths: this.paths, store: this.store, ports: {
              control: this.control, read: this.read, invocations: projectInvocationPort, recording: createProjectRecordingPort(),
            } },
            creation: {
              create: (request, signal) => this.createOwned(request, signal),
              createSession: (request, signal) => this.createSessionOwned(request, signal),
              createExecution: (project, title, instructions, signal) => this.createExecutionOwned(project, title, instructions, signal),
            },
          })
        },
        closeOwners: [
          { name: 'project-admission', close: async () => { this.runtime?.beginClose() } },
          { name: 'private-session-ui', close: async () => { await this.ui?.close() } },
          { name: 'native-title-producers', close: async () => { await this.foundations?.closeTitles() } },
          { name: 'project-models', close: async () => { await (this.graph?.ctx.get('llm') as ProjectsLlmRuntime | undefined)?.close() } },
          { name: 'project-domain', close: async () => { await this.runtime?.dispose() } },
          { name: 'native-producers', close: async () => { await this.foundations?.close() } },
          { name: 'project-reads', close: async () => { await this.read?.close() } },
        ],
        factoryOptions: {
          resolveOwner: async (id, parent) => {
            if (parent !== undefined) {
              const owner = await (this.read === undefined ? undefined : (parent.ctx.sessionPersistence as import('./persistence/index.ts').ProjectSessionPersistence).resolveOwner(parent.id))
              if (owner === undefined) throw new Error('Project child has no exact parent owner')
              return owner
            }
            const ownership = await this.store.resolveHostOwnership(String(id))
            if (ownership?.kind === 'preparation') return { projectId: ownership.project.id, logicalSessionId: ownership.session.id }
            const membership = await this.store.findCarrierByHostSessionId(String(id))
            if (membership === undefined || !membership.carrier.isCurrent || membership.carrier.sourceLifecycle.kind !== 'available') throw new Error('Project factory target is unavailable')
            return { projectId: membership.project.id, logicalSessionId: membership.session.id }
          },
          setupBase: async (agentCtx, agent) => this.setupAgent(agentCtx, agent),
          request: { prepare: prepareProjectHarness },
        },
      })
      await this.requireRuntime().initialize()
      this.shutdown.signal.throwIfAborted()
      this.state = 'ready'
    } catch (error) {
      this.startupError = errorText(error)
      this.state = 'failed'
      await this.graph?.close()
      throw error
    }
  }

  private async setupAgent(ctx: Context, agent: Agent): Promise<void> {
    await this.requireUi().bindAgentAttachments(ctx, agent.id)
    await this.requireRuntime().installAgent(agent)
    const membership = await this.store.findCarrierByHostSessionId(String(agent.id))
    if (membership?.session.role === 'memory') installMemoryCompaction(ctx, agent)
  }

  list(signal?: AbortSignal): Promise<readonly ProjectSummary[]> {
    return this.accept(signal, () => this.requireRuntime().list())
  }

  get(request: GetProjectRequest, signal?: AbortSignal): Promise<ProjectDetail> {
    return this.accept(signal, async () => { const detail = await this.requireRuntime().get(request.projectId); if (detail === undefined) await this.requireProject(request.projectId); return detail! })
  }

  create(request: CreateProjectRequest, signal?: AbortSignal): Promise<CreateProjectResult> {
    return this.accept(signal, () => this.requireRuntime().create(request, signal))
  }

  private async createOwned(request: CreateProjectRequest, signal?: AbortSignal): Promise<CreateProjectResult> {
    return (async () => {
      const workspace = request.workspace === undefined ? undefined : { path: await this.workspace(request.workspace.path) }
      if (request.instructions !== undefined && typeof request.instructions !== 'string') throw new Error('项目说明与要求必须是文字。')
      const instructions = request.instructions?.trim() ? request.instructions : undefined
      let instructionsFailed = false
      let project: Project
      try {
        project = await this.store.createProject({ name: request.name, ...(workspace === undefined ? {} : { workspace }) },
          instructions === undefined ? {} : { prepareDirectory: async (projectId, directory) => {
            try {
              const saved = await new ProjectSettingsStore(projectId, directory).saveProjectInstructions(instructions, 0, signal)
              if (saved.kind !== 'saved') throw new Error('初始项目指令保存冲突。')
            } catch (error) { instructionsFailed = true; throw error }
          } })
      } catch (error) {
        if (instructionsFailed && durableMutationDetails(error)?.effect === 'none') {
          throw new RemoteError('projects/create-rejected', '项目未创建：项目说明与要求保存失败。' + errorText(error),
            { effect: 'none', phase: 'project-instructions' }, { cause: error })
        }
        throw error
      }
      try {
        await this.createCarrier(project, 'main', `${project.name} 主会话`, undefined, signal)
        return { detail: projectDetail(await this.store.getSnapshot(project.id)) }
      } catch (error) {
        const failure = error instanceof CreationFailure ? error : new CreationFailure({ projectId: project.id, phase: 'project-record-saved', journal: 'unknown' }, error)
        return { detail: projectDetail(await this.store.getSnapshot(project.id)),
          warning: `${failure.message}。已保存的项目及会话关系保留；${JSON.stringify(failure.detail)}。没有启动模型。` }
      }
    })()
  }

  createSession(request: CreateProjectSessionRequest, signal?: AbortSignal): Promise<ProjectDetail> {
    return this.accept(signal, () => this.requireRuntime().createSession(request, signal))
  }

  private async createSessionOwned(request: CreateProjectSessionRequest, signal?: AbortSignal): Promise<ProjectDetail> {
    return (async () => {
      const project = await this.requireProject(request.projectId)
      this.assertProjectWritable(project)
      const workspace = request.workspace === undefined ? undefined : request.workspace === null ? null : await this.workspace(request.workspace.path)
      try { await this.createCarrier(project, 'execution', request.title ?? '执行会话', workspace, signal) }
      catch (error) {
        if (error instanceof CreationFailure) throw new RemoteError('projects/create-partial', error.message, error.detail, { cause: error })
        throw error
      }
      return projectDetail(await this.store.getSnapshot(project.id))
    })()
  }

  private async createExecutionOwned(project: Project, title: string, instructions?: string, signal?: AbortSignal): Promise<{ session: ProjectSession; warning?: string }> {
    try { return { session: await this.createCarrier(project, 'execution', title, undefined, signal, instructions) } }
    catch (error) {
      if (!(error instanceof CreationFailure) || error.detail.journal !== 'materialized' || error.detail.sessionId === undefined) throw error
      const binding = await this.store.findCarrierByHostSessionId(error.detail.carrierId!)
      if (binding?.project.id !== project.id || binding.session.id !== error.detail.sessionId || binding.carrier.header === undefined) throw error
      return { session: binding.session, warning: error.message }
    }
  }

  private async createCarrier(project: Project, role: 'main' | 'execution', title: string, workspace: string | null | undefined, signal?: AbortSignal, instructions?: string): Promise<ProjectSession> {
    const graph = this.requireGraph()
    this.assertProjectWritable(project)
    const sessionId = randomUUID(), carrierId = SessionId(randomUUID())
    return this.requireRuntime().withCarrierCreation(carrierId, async () => {
    let phase: ProjectsCreationPhase = 'project-record-saved'
    let journal: 'materialized' | 'absent' | 'unknown' = 'absent'
    let member: ProjectSession | undefined
    let handle: AgentHandle | undefined
    try {
      signal?.throwIfAborted()
      member = await this.store.bindSession(project.id, { id: sessionId, hostSessionId: carrierId, role, title })
      phase = 'membership-saved'
      graph.persistence.registerSessionOwner(carrierId, { projectId: project.id, logicalSessionId: sessionId })
      await this.settings.initializeSessionInstructions({ projectId: project.id, sessionId, signal }, instructions ?? initialSessionInstructions(role))
      phase = 'instructions-saved'
      const cwd = workspace === null ? await this.ensureProjectFilesRoot(project.id)
        : workspace ?? project.workspace?.path ?? await this.ensureProjectFilesRoot(project.id)
      let selection = this.root.agentDefaultModel.currentSelection()
      if (role === 'execution') {
        const configured = await this.settings.prepareNewExecution({ projectId: project.id, signal })
        if (configured.kind === 'unavailable') throw new Error(configured.message)
        if (configured.kind === 'configured') selection = agentSelection(configured.selection)
      }
      handle = await graph.ctx.agents.create({
        sessionId: carrierId, signal, meta: { cwd, agentPreset: graph.preset.id }, agentOptions: selection,
        setup: (_ctx, agent) => {
          // A real model selection makes the empty carrier recoverable. Native
          // title ownership requires publication, so rename follows confirmation.
          agent.session.append('model/selection', selection)
        },
      })
      this.requireRuntime().retainCarrierHandle(handle)
      phase = 'native-created'; journal = 'materialized'
      const confirmed = await this.store.confirmSessionCarrierHeader({ projectId: project.id, sessionId,
        expectedRevision: (await this.store.getSession(project.id, sessionId))!.revision, hostSessionId: carrierId, header: handle.agent.session.header })
      if (confirmed.kind !== 'updated') throw new Error('Carrier identity confirmation conflicted; created journal was retained')
      phase = 'header-confirmed'
      await this.requireUi().rename({ sessionId: carrierId, title: member.title })
      if (!await graph.ctx.sessions.flush(handle.agent.session)) throw new Error('Project journal has no native flush owner')
      phase = 'initial-state-durable'
      return (await this.store.getSession(project.id, sessionId))!
    } catch (error) {
      const releaseErrors: unknown[] = []
      try { await handle?.dispose() } catch (releaseError) { releaseErrors.push(releaseError) }
      if (member !== undefined && phase !== 'header-confirmed' && phase !== 'initial-state-durable') {
        try {
          const stored = await graph.persistence.stat(carrierId)
          journal = stored === undefined ? 'absent' : 'materialized'
          if (stored !== undefined) await this.confirmMaterializedHeader(project.id, sessionId, carrierId, stored.header)
        } catch (inspectionError) { journal = 'unknown'; releaseErrors.push(inspectionError) }
      }
      throw new CreationFailure({ projectId: project.id, ...(member === undefined ? {} : { sessionId, carrierId }), phase, journal },
        releaseErrors.length ? new AggregateError([error, ...releaseErrors], 'creation and cleanup/inspection did not all complete') : error)
    }
    })
  }

  private async confirmMaterializedHeader(projectId: string, sessionId: string, carrierId: SessionId, header: SessionHeader): Promise<void> {
    const current = await this.store.getSession(projectId, sessionId)
    if (current === undefined) throw new Error('Created carrier membership disappeared')
    const result = await this.store.confirmSessionCarrierHeader({ projectId, sessionId, hostSessionId: carrierId, expectedRevision: current.revision, header })
    if (result.kind !== 'updated') throw new Error('Created carrier header confirmation remains unconfirmed')
  }

  readProjectInstructions(request: GetProjectRequest, signal?: AbortSignal): Promise<ProjectInstructions> {
    return this.accept(signal, () => this.settings.readProjectInstructions({ ...request, signal }))
  }
  saveProjectInstructions(request: ProjectInstructionsSaveRequest, signal?: AbortSignal): Promise<SettingsWriteResult<ProjectInstructions>> {
    return this.accept(signal, async () => { this.assertProjectWritable(await this.requireProject(request.projectId)); return this.settings.saveProjectInstructions({ projectId: request.projectId, signal }, request.text, request.expectedRevision) })
  }
  readSessionInstructions(request: SessionInstructionsRequest, signal?: AbortSignal): Promise<SessionInstructions> {
    return this.accept(signal, () => this.settings.readSessionInstructions({ ...request, signal }))
  }
  saveSessionInstructions(request: SessionInstructionsSaveRequest, signal?: AbortSignal): Promise<SettingsWriteResult<SessionInstructions>> {
    return this.accept(signal, async () => {
      const session = await this.requireLogicalSession(request.projectId, request.sessionId)
      await this.requireCarrier(SessionId(session.hostSessionId), 'write')
      return this.settings.saveSessionInstructions({ projectId: request.projectId, sessionId: request.sessionId, signal }, request.text, request.expectedRevision)
    })
  }

  /** Called by the private UI controller, never by a root Session API. */
  async resolveTarget(id: SessionId, operation: 'read' | 'activate' | 'write'): Promise<void> {
    this.assertReady()
    await this.requireCarrier(id, operation)
  }

  uiControl(signal: AbortSignal): AsyncIterable<ProjectsUiControlFrame> {
    const self = this, lifetime = AbortSignal.any([signal, this.shutdown.signal])
    return (async function* () {
      await self.waitReady(lifetime)
      yield* self.requireUi().control(lifetime)
    })()
  }
  uiFollow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    const self = this, lifetime = AbortSignal.any([signal, this.shutdown.signal])
    return (async function* () {
      await self.waitReady(lifetime)
      yield* self.requireUi().follow(request, lifetime)
    })()
  }
  uiPage(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage> { return this.accept(signal, () => this.requireUi().page(request, signal)) }
  uiPrompt(request: ProjectUiPromptRequest, signal: AbortSignal): Promise<SessionPromptValue> { return this.accept(signal, () => this.requireUi().prompt(request, signal)) }
  uiCancel(request: ProjectUiCancelRequest): Promise<SessionCancelValue> { return this.accept(undefined, async () => this.requireUi().cancel(request)) }
  uiUpdateQueue(request: ProjectUiUpdateQueueRequest): Promise<SessionUpdateQueueValue> { return this.accept(undefined, () => this.requireUi().updateQueue(request)) }
  uiModelCatalog(signal?: AbortSignal): Promise<ModelCatalog> { return this.accept(signal, () => this.requireUi().modelCatalog()) }
  uiSelectModel(request: ProjectUiSelectModelRequest): Promise<SessionSelectModelValue> { return this.accept(undefined, () => this.requireUi().selectModel(request)) }

  uiCarrierAddress(request: ProjectUiTarget): Promise<ProjectUiCarrierAddress> {
    return this.accept(undefined, async () => {
      const saved = await this.findCarrier(request.sessionId)
      if (saved !== undefined) {
        const { project, session, carrier } = await this.requireCarrier(request.sessionId, 'read')
        if (carrier.header === undefined) throw new Error('Project carrier creation has not been confirmed')
        return { projectId: project.id, logicalSessionId: session.id, hostSessionId: carrier.hostSessionId,
          sessionCreatedAt: carrier.header.createdAt, carrierEpoch: carrier.sequence }
      }
      // A child has no logical-session row of its own. Read its actual creation
      // and parent chain, then retain the saved root's logical owner/epoch.
      if (this.read === undefined) throw new Error('Projects source owner is not ready')
      const child = await this.read.withDirectory(request.sessionId, ({ directory }) => ({ header: directory.header, owner: directory.owner }))
      let root = child
      const seen = new Set<string>()
      while (root.header.parentSession !== undefined) {
        if (seen.has(root.header.id)) throw new Error('Project child ancestry is cyclic')
        seen.add(root.header.id)
        root = await this.read.withDirectory(SessionId(root.header.parentSession), ({ directory }) => ({ header: directory.header, owner: directory.owner }))
        if (root.owner.projectId !== child.owner.projectId || root.owner.logicalSessionId !== child.owner.logicalSessionId) throw new Error('Project child ancestry changed its logical owner')
      }
      const binding = await this.requireCarrier(root.header.id, 'read')
      if (binding.project.id !== child.owner.projectId || binding.session.id !== child.owner.logicalSessionId
        || binding.carrier.header?.createdAt !== root.header.createdAt) throw new Error('Project child physical root does not match its saved owner')
      return { projectId: binding.project.id, logicalSessionId: binding.session.id, hostSessionId: child.header.id,
        sessionCreatedAt: child.header.createdAt, carrierEpoch: binding.carrier.sequence }
    })
  }
  private async validateCapture(address: ProjectUiCarrierAddress): Promise<void> {
    const binding = await this.requireCarrier(SessionId(address.hostSessionId), 'write')
    if (binding.project.id !== address.projectId || binding.session.id !== address.logicalSessionId
      || binding.carrier.hostSessionId !== address.hostSessionId || binding.carrier.header?.createdAt !== address.sessionCreatedAt
      || binding.carrier.sequence !== address.carrierEpoch) throw new Error('PROJECT_INPUT_STALE_CARRIER: captured Project carrier identity has changed')
  }

  private async validateRelatedCapture(address: ProjectUiCarrierAddress, targetId: SessionId): Promise<void> {
    await this.validateCapture(address)
    if (this.read === undefined) throw new Error('Projects source owner is not ready')
    let id = targetId
    const seen = new Set<string>()
    while (id !== address.hostSessionId) {
      if (seen.has(id)) throw new Error('Project child ancestry is cyclic')
      seen.add(id)
      const prefix = await this.read.withDirectory(id, ({ directory }) => ({ header: directory.header, owner: directory.owner }))
      if (prefix.owner.projectId !== address.projectId || prefix.owner.logicalSessionId !== address.logicalSessionId || prefix.header.parentSession === undefined) {
        throw new Error('PROJECT_INPUT_STALE_CARRIER: target does not belong to the captured physical carrier')
      }
      id = SessionId(prefix.header.parentSession)
    }
    await this.validateCapture(address)
  }

  private async readSubagentAddress(id: SessionId, signal?: AbortSignal): Promise<ProjectUiSubagentAddress | undefined> {
    if (this.read === undefined || this.control === undefined) throw new Error('Projects source/control owner is not ready')
    const child = await this.read.withDirectory(id, ({ directory }) => directory.header, { signal })
    if (child.parentSession === undefined) return undefined
    let parentId = SessionId(child.parentSession)
    const seen = new Set<string>([id])
    for (;;) {
      if (seen.has(parentId)) throw new Error('Project child ancestry is cyclic')
      seen.add(parentId)
      const header = await this.read.withDirectory(parentId, ({ directory }) => directory.header, { signal })
      if (header.parentSession === undefined) break
      parentId = SessionId(header.parentSession)
    }
    const member = (await this.control.inspectOwnedSessions(parentId)).find(value => value.header.id === id && value.header.createdAt === child.createdAt)
    return member === undefined ? undefined : { parentSessionId: SessionId(member.parentSessionId), childSessionId: member.header.id, mode: member.mode }
  }
  uiReadFile(request: ProjectUiFileReadRequest, signal: AbortSignal): Promise<WorkspaceFileText> { return this.accept(signal, () => this.requireUi().readFile(request, signal)) }
  uiReadFileBytes(request: ProjectUiFileBytesRequest, signal: AbortSignal): Promise<WorkspaceFileBytes> { return this.accept(signal, () => this.requireUi().readFileBytes(request, signal)) }
  uiStatFile(request: ProjectUiFileRequest, signal: AbortSignal): Promise<WorkspaceFileStat> { return this.accept(signal, () => this.requireUi().statFile(request, signal)) }
  uiListFiles(request: ProjectUiFileRequest, signal: AbortSignal): Promise<WorkspaceDirectoryListing> { return this.accept(signal, () => this.requireUi().listFiles(request, signal)) }
  uiFileChanges(request: ProjectUiFileRequest, signal: AbortSignal): AsyncIterable<WorkspaceFileWatchFrame> {
    const self = this, lifetime = AbortSignal.any([signal, this.shutdown.signal])
    return (async function* () { await self.waitReady(lifetime); yield* self.requireUi().fileChanges(request, lifetime) })()
  }
  uiSubagentAddress(request: ProjectUiTarget, signal: AbortSignal): Promise<ProjectUiSubagentAddress | undefined> { return this.accept(signal, () => this.requireUi().subagentAddress(request, signal)) }
  uiSubagentCatalog(request: ProjectUiTarget, signal: AbortSignal): Promise<readonly ProjectUiSubagentInfo[]> { return this.accept(signal, () => this.requireUi().subagentCatalog(request, signal)) }
  uiSubagentPrompt(request: ProjectUiSubagentPromptRequest, signal: AbortSignal): Promise<ProjectUiSubagentPromptReceipt> { return this.accept(signal, () => this.requireUi().subagentPrompt(request, signal)) }
  uiSubagentInterrupt(request: ProjectUiSubagentInterruptRequest): Promise<ProjectUiSubagentInterruptReceipt> { return this.accept(undefined, () => this.requireUi().subagentInterrupt(request)) }

  uiFollowReadonly(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    const self = this, lifetime = AbortSignal.any([signal, this.shutdown.signal])
    return (async function* () { await self.waitReady(lifetime); yield* self.requireUi().followReadonly(request, lifetime) })()
  }
  uiProjections(request: ProjectUiProjectionsRequest, signal: AbortSignal): Promise<SessionProjectionsValue> { return this.accept(signal, () => this.requireUi().projections(request, signal)) }
  uiRename(request: ProjectUiRenameRequest): Promise<SessionRenameValue> { return this.accept(undefined, () => this.requireUi().rename(request)) }
  uiAttachment(request: SessionAttachmentRequest): Promise<SessionAttachmentValue> { return this.accept(undefined, () => this.requireUi().attachment(request)) }
  uiCommandCatalog(request: ProjectUiTarget, signal: AbortSignal): Promise<readonly CommandDescriptor[]> { return this.accept(signal, () => this.requireUi().commandCatalog(request, signal)) }
  uiExecuteCommand(request: ProjectUiCommandRequest, signal: AbortSignal): Promise<CommandExecution | undefined> { return this.accept(signal, () => this.requireUi().executeCommand(request, signal)) }
  uiFileCandidates(request: ProjectUiQueryRequest, signal: AbortSignal): Promise<FileReferenceCandidate[]> { return this.accept(signal, () => this.requireUi().fileCandidates(request, signal)) }
  uiSessionCandidates(request: ProjectUiQueryRequest, signal: AbortSignal): Promise<SessionReferenceMentionCandidate[]> { return this.accept(signal, () => this.requireUi().sessionCandidates(request, signal)) }
  uiSkills(request: SkillListRequest, signal: AbortSignal): Promise<SkillListValue> { return this.accept(signal, () => this.requireUi().skills(request, signal)) }
  uiUpload(request: ProjectUiUploadRequest, signal: AbortSignal): Promise<ProjectUiUploadValue> { return this.accept(signal, () => this.requireUi().upload(request, signal)) }
  /** Only the authenticated root Fetch contribution may pass a transport Request. */
  uiUploadFetch(request: ProjectUiTarget, transport: Request): Promise<Response> { return this.accept(transport.signal, () => this.requireUi().uploadFetch(request, transport)) }
  uiInteractions(request: ProjectUiTarget, signal: AbortSignal): AsyncIterable<ProjectUiInteractionFrame> {
    const self = this, lifetime = AbortSignal.any([signal, this.shutdown.signal])
    return (async function* () { await self.waitReady(lifetime); yield* self.requireUi().interactions(request, lifetime) })()
  }
  uiRespondInteraction(request: ProjectUiInteractionResponse): Promise<{ readonly accepted: boolean }> { return this.accept(undefined, () => this.requireUi().respondInteraction(request)) }
  uiAnswerQuestion(request: ProjectUiQuestionAnswerRequest): Promise<boolean> { return this.accept(undefined, () => this.requireUi().answerQuestion(request)) }
  uiAttachQuestionWait(request: ProjectUiQuestionRequest, signal: AbortSignal): AsyncIterable<{ remainingMs: number }> {
    const self = this, lifetime = AbortSignal.any([signal, this.shutdown.signal])
    return (async function* () { await self.waitReady(lifetime); yield* self.requireUi().attachQuestionWait(request, lifetime) })()
  }
  uiSetPlan(request: ProjectUiPlanRequest): Promise<'committed' | 'queued' | 'cancelled' | 'noop'> { return this.accept(undefined, () => this.requireUi().setPlan(request)) }

  uiJobList(request: JobListRequest, signal: AbortSignal): AsyncIterable<JobListFrame> {
    const self = this, lifetime = AbortSignal.any([signal, this.shutdown.signal])
    return (async function* () { await self.waitReady(lifetime); yield* self.requireUi().jobList(request, lifetime) })()
  }
  uiJobFollow(request: JobFollowRequest, signal: AbortSignal): AsyncIterable<JobFollowFrame> {
    const self = this, lifetime = AbortSignal.any([signal, this.shutdown.signal])
    return (async function* () { await self.waitReady(lifetime); yield* self.requireUi().jobFollow(request, lifetime) })()
  }
  uiJobKill(request: ProjectUiJobKillRequest): Promise<JobKillValue> { return this.accept(undefined, () => this.requireUi().jobKill(request)) }

  private configurationWarnings(): readonly string[] {
    const complete = (route: ProjectsFacadeConfig['memoryModel']) => typeof route?.provider === 'string' && route.provider.trim() !== ''
      && typeof route.model === 'string' && route.model.trim() !== ''
    const warnings: string[] = []
    if (!complete(this.config.memoryModel)) warnings.push('共享记忆自动整理尚未配置后台模型。请在 DSH 的 Projects 插件配置中填写 memoryModel.provider 和 memoryModel.model；主会话与执行会话仍可使用。')
    if (!complete(this.config.sessionManagerModel)) warnings.push('主会话接力判断尚未配置后台模型。请在 DSH 的 Projects 插件配置中填写 sessionManagerModel.provider 和 sessionManagerModel.model；主会话与执行会话仍可使用。')
    return warnings
  }

  uiConfigurationStatus(signal: AbortSignal): Promise<ProjectConfigurationStatus> {
    return this.accept(signal, async () => ({ revision: this.configurationRevision, publication: structuredClone(this.configurationPublication), warnings: this.configurationWarnings() }))
  }
  uiWatchConfiguration(signal: AbortSignal): AsyncIterable<ProjectConfigurationStatus> {
    const self = this, lifetime = AbortSignal.any([signal, this.shutdown.signal])
    return (async function* () {
      await self.waitReady(lifetime)
      let pending = true, wake: (() => void) | undefined
      const listener = () => { pending = true; wake?.() }
      const aborted = () => wake?.()
      self.configurationListeners.add(listener)
      lifetime.addEventListener('abort', aborted, { once: true })
      try {
        while (!lifetime.aborted) {
          if (pending) {
            pending = false
            yield { revision: self.configurationRevision, publication: structuredClone(self.configurationPublication), warnings: self.configurationWarnings() }
          }
          if (!pending && !lifetime.aborted) await new Promise<void>(resolve => { wake = resolve; if (pending || lifetime.aborted) resolve() })
        }
      } finally { self.configurationListeners.delete(listener); lifetime.removeEventListener('abort', aborted) }
    })()
  }

  uiSearch(request: SessionSearchRequest, signal: AbortSignal): Promise<SessionSearchValue> { return this.accept(signal, () => this.requireUi().search(request, signal)) }
  uiPermissionCatalog(signal: AbortSignal): Promise<ProjectUiPermissionCatalog> { return this.accept(signal, () => this.requireUi().permissionCatalog()) }
  uiAgentPresetList(signal: AbortSignal): Promise<ProjectUiAgentPresetRoster> { return this.accept(signal, () => this.requireUi().agentPresetList()) }
  uiAgentPresetSelect(request: ProjectUiAgentPresetSelectRequest): Promise<string> { return this.accept(undefined, () => this.requireUi().agentPresetSelect(request)) }

  uiChangesSummary(request: ProjectUiChangesRequest, signal: AbortSignal): Promise<ProjectUiChangesSummary | undefined> { return this.accept(signal, () => this.requireUi().changesSummary(request, signal)) }
  uiChangesDiff(request: ProjectUiChangesDiffRequest, signal: AbortSignal): Promise<WorkspaceFileDiff | undefined> { return this.accept(signal, () => this.requireUi().changesDiff(request, signal)) }

  /** Catalog visibility is separate from the strict read/write target policy. */
  private async isVisibleUiTarget(id: SessionId, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    const ownership = await this.persistedOwnership(id)
    if (ownership?.kind === 'preparation') return false
    const saved = ownership
    if (saved !== undefined) {
      if (saved.session.role === 'memory' || saved.session.role === 'session-manager') return false
      return saved.project.sourceLifecycle === undefined && saved.session.sourceLifecycle.kind === 'available'
        && saved.carrier.sourceLifecycle.kind === 'available'
    }
    if (this.graph === undefined || this.read === undefined) throw new Error('Projects catalog owner is not ready')
    const owner = await this.graph.persistence.resolveOwner(id)
    if (owner === undefined) throw new Error(`Project catalog target has no saved owner: ${String(id)}`)
    const [project, session] = await Promise.all([
      this.store.getProject(owner.projectId), this.store.getSession(owner.projectId, owner.logicalSessionId),
    ])
    signal?.throwIfAborted()
    if (project === undefined || session === undefined) throw new Error(`Project catalog target has an unknown logical owner: ${String(id)}`)
    if (project.sourceLifecycle !== undefined || session.sourceLifecycle.kind !== 'available') return false
    // Only the read owner can establish a child relationship: it checks the
    // real header, matching creation and non-inherited parent catalog chain.
    const child = await this.read.withDirectory(id, ({ directory }) => ({ header: directory.header, owner: directory.owner }), { signal })
    if (child.header.parentSession === undefined || child.owner.projectId !== owner.projectId
      || child.owner.logicalSessionId !== owner.logicalSessionId) throw new Error(`Project catalog child ownership changed: ${String(id)}`)
    return session.role === 'main' || session.role === 'execution'
  }

  private async persistedOwnership(id: SessionId): Promise<ProjectHostOwnership | undefined> {
    const owner = await this.graph?.persistence.resolveOwner(id)
    return this.store.resolveHostOwnership(id, owner)
  }
  private async findCarrier(id: SessionId): Promise<ProjectCarrierMembership | undefined> {
    const ownership = await this.persistedOwnership(id)
    return ownership === undefined || ownership.kind === 'preparation' ? undefined : {
      project: ownership.project, session: ownership.session, projectSessionId: ownership.session.id, carrier: ownership.carrier,
    }
  }
  private async requireCarrier(id: SessionId, operation: 'read' | 'activate' | 'write' | 'create'): Promise<ProjectCarrierMembership> {
    const binding = await this.findCarrier(id)
    let rootId: string | undefined
    let membership = binding
    if (membership === undefined && this.read !== undefined) {
      const owner = await this.read.withDirectory(id, ({ directory }) => directory.owner).catch(() => undefined)
      if (owner !== undefined) {
        const logical = await this.store.getSession(owner.projectId, owner.logicalSessionId)
        if (logical !== undefined) { rootId = logical.hostSessionId; membership = await this.findCarrier(SessionId(rootId)) }
      }
    }
    if (membership === undefined) throw new RemoteError('projects/unknown-target', 'Unknown Project carrier', { carrierId: id })
    const { project, session, carrier } = membership
    if (project.sourceLifecycle !== undefined || session.sourceLifecycle.kind !== 'available' || carrier.sourceLifecycle.kind !== 'available') {
      throw new RemoteError('projects/source-unavailable', 'Project carrier source is unavailable', { carrierId: id })
    }
    workRole(session)
    if (operation === 'read') return membership
    if (!carrier.isCurrent || session.hostSessionId !== (rootId ?? id) || carrier.closed !== undefined) {
      throw new RemoteError('projects/read-only-carrier', 'Historical Project carrier is read only', { carrierId: id })
    }
    this.assertProjectWritable(project)
    if (session.archived) throw new RemoteError('projects/archived', 'Project session is archived', { projectId: project.id, sessionId: session.id })
    if (operation !== 'create' && carrier.header === undefined) throw new RemoteError('projects/source-unavailable', 'Project carrier creation was not confirmed', { carrierId: id })
    return membership
  }
  private async requireProject(id: string): Promise<Project> {
    const project = await this.store.getProject(id)
    if (project === undefined || project.sourceLifecycle?.kind === 'deleted') throw new RemoteError('projects/not-found', `Project "${id}" was not found`, { projectId: id })
    return project
  }
  private async requireSnapshot(id: string): Promise<ProjectSnapshot> { await this.requireProject(id); return this.store.getSnapshot(id) }
  private async requireLogicalSession(projectId: string, id: string): Promise<ProjectSession> {
    await this.requireProject(projectId)
    const session = await this.store.getSession(projectId, id)
    if (session === undefined) throw new RemoteError('projects/unknown-target', 'Unknown logical Project session', { carrierId: id })
    workRole(session)
    return session
  }
  private assertProjectWritable(project: Project): void {
    if (project.sourceLifecycle !== undefined) throw new RemoteError('projects/source-unavailable', 'Project source is unavailable', { carrierId: project.id })
    if (project.archived) throw new RemoteError('projects/archived', 'Project is archived', { projectId: project.id })
  }
  private projectDirectory(id: string): string { return this.paths.project(id) }
  private projectFilesRoot(id: string): string { return join(this.projectDirectory(id), 'artifacts') }
  private async ensureProjectFilesRoot(id: string): Promise<string> { const path = this.projectFilesRoot(id); await mkdir(path, { recursive: true }); return realpath(path) }
  private async workspace(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new RemoteError('projects/invalid-workspace', 'Project workspace must be an absolute directory', { path, reason: 'absolute-required' })
    let canonical: string
    let directory: boolean
    try {
      canonical = await realpath(path)
      directory = (await stat(canonical)).isDirectory()
    } catch (error) {
      const systemCode = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
      const reason = systemCode === 'ENOENT' ? 'not-found' : systemCode === 'ENOTDIR' ? 'not-directory' : 'unreadable'
      throw new RemoteError('projects/invalid-workspace', error instanceof Error ? error.message : String(error),
        { path, reason, ...(systemCode === undefined ? {} : { systemCode }) }, { cause: error })
    }
    if (!directory) throw new RemoteError('projects/invalid-workspace', 'Project workspace must be a directory', { path, reason: 'not-directory' })
    return canonical
  }
  private assertReady(): void {
    if (this.state === 'closing' || this.state === 'closed') throw new RemoteError('projects/closing', 'Projects is closing', {})
    if (this.state !== 'ready') throw new RemoteError('projects/not-ready', this.startupError === undefined ? 'Projects is not ready' : `Projects startup failed: ${this.startupError}`, {})
    this.graph!.assertReady()
  }
  private requireGraph(): ProjectsRuntimeGraph { this.assertReady(); return this.graph! }
  private requireUi(): PrivateSessionUiPort { if (this.ui === undefined) throw new RemoteError('projects/not-ready', 'Projects UI is not ready', {}); return this.ui }
  /** Wait for this one startup, never for the surrounding root Loader or a retry. */
  private async waitReady(signal?: AbortSignal): Promise<void> {
    const lifetime = signal === undefined ? this.shutdown.signal : AbortSignal.any([signal, this.shutdown.signal])
    lifetime.throwIfAborted()
    if (this.state === 'starting' && this.starting !== undefined) {
      const aborted = Promise.withResolvers<never>()
      const onAbort = () => aborted.reject(lifetime.reason)
      lifetime.addEventListener('abort', onAbort, { once: true })
      try { await Promise.race([this.starting.catch(() => {}), aborted.promise]) }
      finally { lifetime.removeEventListener('abort', onAbort) }
    }
    lifetime.throwIfAborted()
    this.assertReady()
  }
  private accept<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    const pending = (async () => { await this.waitReady(signal); return operation() })()
    this.pending.add(pending)
    void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending))
    return pending
  }

  close(): Promise<ProjectsGraphCloseResult | undefined> {
    return this.closing ??= (async () => {
      this.state = 'closing'
      this.shutdown.abort(new Error('Projects is closing'))
      this.runtime?.beginClose()
      await this.starting?.catch(() => {})
      await this.ui?.close()
      // An accepted create/settings write retains ownership until its real I/O
      // settles. The graph then cancels producers, UI-owned handles and writers.
      await Promise.allSettled([...this.pending])
      const result = await this.graph?.close()
      this.state = result?.status === 'partial' ? 'failed' : 'closed'
      return result
    })()
  }
}

function workRole(session: ProjectSession): 'main' | 'execution' {
  if (session.role !== 'main' && session.role !== 'execution') throw new RemoteError('projects/unknown-target', 'Target is not a Project work session', { carrierId: session.hostSessionId })
  return session.role
}
function agentSelection(selection: { provider: string; model: string; reasoningEffort?: string }): AgentModelSelection {
  return { provider: selection.provider, model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }) }
}
function instructionBlock(kind: string, context: { projectId: string; sessionId?: string; available: boolean; value?: ProjectInstructions }, text: string): string {
  if (context.available && text === '') return ''
  return [JSON.stringify({ producer: 'projects', kind, projectId: context.projectId, sessionId: context.sessionId,
    status: context.available ? 'available' : 'unreadable', revision: context.value?.revision, updatedAt: context.value?.updatedAt }), text].join('\n')
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
