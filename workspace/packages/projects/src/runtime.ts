import { installProjectWorkTools } from './project-work-tools.ts'
import { ProjectSourceDeletion } from "./deletion-all.ts"
import type { DeleteExecutionSessionRequest, DeleteProjectRequest, ProjectDeletionActionResult, RenameExecutionSessionRequest, RenameExecutionSessionResult } from "./public-types.ts"
import type { ProjectTargetDeletionCut } from './deletion-v1.ts'
import type { ProjectSourceDispositionSnapshot, ProjectsRuntimeComposition } from './stock/project-ports.ts'
import { installMainDelegationPolicy } from './stock/main-delegation.ts'
import { onProjectTurnSettled, onProjectCancelRequested, onProjectInboxClaimed } from './stock/request/harness.ts'
import { ProjectExecutionLifecycle, LifecycleStoppedPersistenceError } from './lifecycle-runtime.ts'
import { LifecycleOperationError, LifecycleBoundaryError } from './lifecycle-types.ts'
import type {
  ExecutionLifecycleActionRequest,
  ExecutionLifecycleActionResult,
  ProjectLifecycleActionRequest,
  ProjectLifecycleActionResult,
} from './public-types.ts'
/** Project-owned Session lifecycle and catalog membership runtime. */

import { createHash } from 'node:crypto'
import { MainContinuityHistory } from './continuity/history.ts'
import { MainSessionManager } from './continuity/manager.ts'
import { MainContinuityNative, readMainNativePolicy } from './continuity/native.ts'
import { MainContinuityRuntime } from './continuity/runtime.ts'
import { MainAdmissionCoordinator } from './continuity/admission.ts'
import type { MainAdmissionLease } from './continuity/types.ts'
import type { MainCarrierPreparation, ProjectHostOwnership } from './records-types.ts'
import type { CommunicationSessionIdentity } from './communication/types.ts'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { PendingInputCoordinationError, sameOwnedCreationHeader } from './stock/control/identity.ts'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import { createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-title'
import { SessionId, SessionLogOffset, type SessionHeader } from '@deepseek-ai/dsh-session'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-spill-policy'
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'
import { TOOL_ABORTED, TOOL_ABORTED_BEFORE_DISPATCH, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

import {
  projectDetail,
  projectRecord,
  projectSessionRecord,
  projectSessionReplyReference,
} from './project-context.ts'
import {
  installProjectTools, installProjectHistoryTools,
  type CreateSessionArgs,
  type ProjectToolRuntime,
  type ReadProjectArgs,
  type SendMessageArgs,
  type HistoryArgs,
  type PreparedProjectHistoryContent,
} from './project-tools.ts'
import { ProjectStore } from './records.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { durableMutationDetails } from './metadata-files.ts'
import { CommunicationOperationRepository } from './communication/records.ts'
import { CommunicationTranscript } from './communication/transcript.ts'
import { CommunicationQuery } from './communication/query.ts'
import { NativeInputPort } from './communication/native-input.ts'
import { CommunicationService, type CommunicationAccess } from './communication/service.ts'
import { CommunicationVisibleReader, communicationAttachmentVerifier } from './communication/visible-reader.ts'
import { CommunicationSavedRead } from './communication/saved-read.ts'
import { finalizeCommunicationContentPage } from './communication/content.ts'
import type { CommunicationContentBudget, CommunicationContentRequest } from './communication/content-types.ts'
import { communicationError, snapshotCodec } from './communication/contract.ts'
import type { CommunicationEndpoint, CommunicationSnapshotV1 } from './communication/types.ts'
import type {} from './workspace-introduction.ts'
import { ProjectsCoreAccess } from './core-access.ts'
import { libraryCorePort, memoryCorePort } from './core-modules.ts'
import { LibraryStore } from './library-store.ts'
import { LibraryService } from './library-service.ts'
import { installLibraryTools } from './library-tools.ts'
import { ProjectMemoryService } from './memory-service.ts'
import { initialSessionInstructions, projectSystemInstructions } from './roles.ts'
import { ProjectFeatureModules } from './project-features.ts'
import { ProjectScheduleRuntime } from './features/schedule/runtime.ts'
import type { ControlledScheduleDependencies, ScheduleRuntimeTarget } from './features/schedule/runtime.ts'
import type { SchedulePowerFacts } from './features/schedule/power-facts.ts'
import { foldScheduleNativeEvents } from './features/schedule/native.ts'
import { hasSchedulePending, coordinateSchedulePending } from './features/schedule/pending.ts'
import { ProjectScheduleStore } from './features/schedule/store.ts'
import { installScheduleTools } from './features/schedule/tools.ts'
import { installOverviewTools } from './features/overview/index.ts'
import {
  initializeExistingProjectModelSelections,
} from './features/settings/index.ts'
import { ProjectHistoryReader } from './project-history.ts'
import type { PreparedToolRead } from './tool-read-pages.ts'
import { finalizeProjectHistoryContentPage } from './project-history.ts'
import type { ProjectHistoryContentRequest } from './project-history.ts'
import type { ProjectHistorySearchResult, ProjectHistoryReadResult } from './project-history.ts'
import { installMemoryTools } from './memory-tools.ts'
import { installInstructionTools } from './instruction-tools.ts'
import { installProjectControlTools, stopProjectExecution, type StopExecutionArgs } from './project-control-tools.ts'
import { installExecutionFailureNotices, type ExecutionFailureDeliveryResult, type ProjectExecutionFailureMessageSource } from './execution-failure-notice.ts'
import { ProjectMemoryRuntime } from './memory-bot-runtime.ts'
import { installProjectRequestContext } from './project-request-context.ts'
import { userInputTiming } from './input-timing.ts'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-commands'
import type { ProjectMemoryNotice } from './memory-notices.ts'
import { mintNativeProjectSource } from './native-source-host.ts'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-token-meter'
import { nativeProjectSourceKey, decodeNativeEventSource } from './native-source.ts'
import { readRetainedProjectSource } from './source-reader.ts'
import type { NativeProjectSource, NativeProjectSourceRead } from './source-reader.ts'
import type {
  Project,
  ProjectMembership,
  ProjectRecordSnapshot,
  ProjectSession,
  ProjectSnapshot,
  SourceRef,
} from './records-types.ts'
import type {
  CreateProjectRequest,
  CreateProjectResult,
  CreateProjectSessionRequest,
  ProjectDetail,
  ProjectNavigationTarget,
  ProjectNativeSourceRead,
  ReadProjectSourceRequest,
  ProjectSummary,
  ProjectInvocationInput,
  UpdateProjectRequest,
  QueryProjectHistoryRequest,
  ReadProjectHistoryRequest,
  ReadProjectCommunicationRequest,
  ProjectCommunicationRead,
  ResolveProjectCommunicationNavigationRequest,
  ProjectCommunicationNavigation,
  ResolveProjectCommunicationFileRequest,
  ProjectCommunicationFile,
} from './public-types.ts'

interface ProjectToolContext {
  readonly agent: Agent
  readonly membership: ProjectMembership & { readonly session: ProjectSession & { readonly role: 'main' | 'execution' } }
  readonly snapshot: ProjectSnapshot
  readonly sources: readonly SourceRef[]
  readonly inputs: readonly ProjectInvocationInput[]
}

interface ProjectWorkspace {
  readonly cwd: string
  /** Only present when this create attempt made the default Project artifacts directory. */
  readonly freshDefaultArtifactsPath?: string
}

export interface ProjectsRuntimeOptions {
  /** Actual private graph capabilities and one shared metadata owner. */
  readonly composition?: ProjectsRuntimeComposition
  /** Published creation uses the verified façade implementation under this admission owner. */
  readonly creation?: {
    create(request: CreateProjectRequest, signal?: AbortSignal): Promise<CreateProjectResult>
    createSession(request: CreateProjectSessionRequest, signal?: AbortSignal): Promise<ProjectDetail>
    createExecution(project: Project, title: string, instructions?: string, signal?: AbortSignal): Promise<{ session: ProjectSession; warning?: string }>
  }
  /** 明确指定的后台route；缺失不能从工作默认模型猜测经济档。 */
  readonly memoryModel?: AgentOptions
  readonly sessionManagerModel?: AgentOptions
  readonly sessionManagerTimeoutMs?: number
  /** Projects-owned recording policy; native deliberately has no hidden defaults. */
  readonly originalRecording?: { readonly streamCheckpointBytes: number; readonly streamCheckpointIntervalMs: number }
  /** Private controlled Host fixture only, absent from Config and Remote. */
  readonly schedule?: ControlledScheduleDependencies
  /** Actual Host factory only; the first business read waits for launcher appReady. */
  readonly automaticPower?: (hint: () => void) => SchedulePowerFacts
}

class ProjectDeletionCreationSettledError extends Error {}
class ProjectsClosingError extends Error { constructor() { super('项目服务正在退出。'); this.name = 'ProjectsClosingError' } }

/** 初始保存归所属Agent scope；factory回滚不等待尚未开始的caller。 */
class InitialSessionSave {
  private closing = false
  private pending: Promise<void> | undefined
  private release: (() => Promise<void>) | undefined
  install(ctx: Context): void {
    this.release = ctx.effect(() => () => {
      this.closing = true
      return this.pending
    }, 'projects.initial-session-save')
  }
  async run<T>(save: () => Promise<T>): Promise<T> {
    if (this.closing) throw new ProjectsClosingError()
    const settled = Promise.withResolvers<void>()
    this.pending = settled.promise
    try { return await save() }
    finally {
      // 原retire/rollback只在本责任解除后进行，不能让scope反等它自己。
      settled.resolve()
      const release = this.release; this.release = undefined
      await release?.()
    }
  }
}

/** Aggregates the private Project domain over its single metadata and lifecycle owners. */
export class ProjectsRuntime implements ProjectToolRuntime {
  private readonly deletion: ProjectSourceDeletion
  private readonly creatingRoots=new Map<string,Promise<void>>()
  private readonly projectDeletionCuts=new Map<string,{committed:boolean}>()
  private readonly projectOperationKeys=new Map<string,symbol>()
  private readonly targetDeletionCuts = new Map<string, { committed: boolean }>()
  private readonly targetOperations = new Map<string | symbol, Set<Promise<unknown>>>()
  private readonly runtimeOperationKey = Symbol('projects accepted runtime operation')
  private sourceDisposition: ProjectSourceDispositionSnapshot = { generation:0, claimed:new Set(), unavailable:new Map() }
  private modelInitializationErrors: ReadonlyMap<SessionId, Error> = new Map()
  private readonly lifecycle: ProjectExecutionLifecycle
  private readonly store: ProjectStore
  private readonly mainAdmission: MainAdmissionCoordinator
  private readonly ownershipByHost = new Map<string, ProjectHostOwnership>()
  private readonly withheldMainHosts = new Set<string>()
  readonly core: ProjectsCoreAccess
  readonly library: LibraryService
  readonly memory: ProjectMemoryService
  readonly memoryRuntime: ProjectMemoryRuntime
  readonly scheduleRuntime: ProjectScheduleRuntime
  private readonly botCreations = new Map<string, Promise<Agent>>()
  private readonly installedScopes = new WeakSet<Agent>()
  private readonly installedScopeModes = new WeakMap<Agent, 'prepared' | 'current'>()
  readonly continuity: MainContinuityRuntime
  readonly continuityHistory: MainContinuityHistory
  private readonly sessionManager: MainSessionManager
  private readonly continuityNative: MainContinuityNative
  private readonly memoryNoticeListeners = new Map<string, Set<(notice: ProjectMemoryNotice | undefined) => void>>()
  readonly features: ProjectFeatureModules
  readonly communicationTranscript: CommunicationTranscript
  readonly communicationQuery: CommunicationQuery
  private readonly communicationSavedRead: CommunicationSavedRead
  private readonly communication: CommunicationService
  private readonly historyReader: ProjectHistoryReader
  private readonly membershipsByHostSessionId = new Map<string, ProjectMembership>()
  /** Last committed Project snapshots, used synchronously by dynamic prompt context. */
  private readonly snapshotsByProjectId = new Map<string, ProjectSnapshot>()
  private readonly catalogListeners = new Set<() => void>()
  private readonly lifecycleDetailListeners = new Set<(snapshot: ProjectSnapshot) => void>()
  private readonly handles = new Map<string, AgentHandle>()

  private catalogSnapshot: ReadonlySet<SessionId> = new Set()
  private unsubscribeStore: (() => void) | undefined
  private disposeCatalogMembership: (() => void) | undefined
  private disposeProjectAgentCreated: (() => unknown) | undefined
  private disposeProjectSessionCreated: (() => unknown) | undefined
  private disposeProjectAgentDisposed: (() => unknown) | undefined
  private initializing: Promise<void> | undefined
  private disposed = false
  private disposing: Promise<void> | undefined
  private admissionClose: { continuity: Promise<void>; memory: Promise<void>; schedule: Promise<void> } | undefined
  private cancelAutomaticReady: (() => void) | undefined
  private automaticConnection: Promise<void> | undefined

  /**
   * @param ctx - Independent Projects graph; ordinary Host services never enter this domain.
   * @param dataRoot - New-format journal home; domain stores use composition.paths.recordsRoot.
   */
  private readonly dataRoot: string
  private readonly composition: ProjectsRuntimeComposition

  constructor(
    private readonly ctx: Context,
    dataRoot: string,
    private readonly options: ProjectsRuntimeOptions = {},
  ) {
    if (options.composition === undefined || options.creation === undefined) throw new Error('ProjectsRuntime requires its private graph composition and creation owner')
    this.composition = options.composition
    if (this.composition.paths.dataRoot !== dataRoot) throw new Error('ProjectsRuntime data root does not match its journal owner')
    this.dataRoot = dataRoot = this.composition.paths.recordsRoot
    this.disposeProjectAgentDisposed = ctx.on('agent/disposed', ({ agent }) => {
      const id = String(agent.id)
      const handle = this.handles.get(id)
      if (handle?.agent !== agent) return
      // disposed早于最终持久关闭；仅完整成功才能归还自己的handle责任。
      void handle.dispose().then(() => {
        if (this.handles.get(id) === handle) this.handles.delete(id)
      }, (_error: unknown) => { /* 保留真实失败handle，后续删除/退出仍需核实它。 */ })
    })
    this.store = this.composition.store
    this.mainAdmission = new MainAdmissionCoordinator((projectId, sessionId) => {
      const snapshot = this.snapshotsByProjectId.get(projectId), session = snapshot?.sessions.find(row => row.id === sessionId)
      return snapshot === undefined || session === undefined || session.sourceLifecycle.kind !== 'available' ? undefined : { project: snapshot.project, session }
    }, host => this.ownershipByHost.get(host), host => !this.withheldMainHosts.has(host))
    ctx.effect(() => this.composition.ports.control.registerInputAdmission({
      assert: (id, operation) => this.mainAdmission.assertExact(String(id), operation),
      accept: (id, operation) => this.mainAdmission.acceptExact(String(id), operation),
    }), 'projects.main-admission')
    this.core = new ProjectsCoreAccess(ctx, this.store, dataRoot, id => this.assertTargetAdmitting(id),projectId=>{if(this.projectDeletionCuts.has(projectId))throw new Error("项目正在删除，内容不可用。")}, this.composition.ports.invocations)
    this.lifecycle = new ProjectExecutionLifecycle(ctx, this.store,
      id => this.membershipsByHostSessionId.get(id), snapshot => {
        this.replaceProjectMembership(snapshot)
        for (const listener of this.lifecycleDetailListeners) listener(snapshot)
      }, {
        suspend: projectId => Promise.all([this.memoryRuntime.batches.suspend(projectId, 'archive'), this.continuity.suspend(projectId)]),
        resume: projectId => { this.memoryRuntime.batches.resume(projectId); this.continuity.resume(projectId) },
      }, {
        nativeStorageDataRoot: this.composition.paths.dataRoot,
        canDrive: id => !this.withheldMainHosts.has(id),
        changed: () => { if (this.snapshotsByProjectId.size > 0 || this.disposeCatalogMembership !== undefined) this.publishCatalogSnapshot() },
        rootFor: id => this.sourceDisposition.execution?.get(SessionId(id))?.rootSessionId,
        modelInitializationFailed: id => this.modelInitializationErrors.has(SessionId(id)),
        drain: ids => {
          const pending = ids.flatMap(id => [...(this.targetOperations.get(id) ?? [])])
          return Promise.allSettled(pending).then(results => {
            const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
            if (errors.length) throw new AggregateError(errors, '所选目标已接纳保存未确认。')
          })
        },
        now: () => this.scheduleRuntime.currentTime(),
        captureBoundary: () => this.scheduleRuntime.captureBoundary(),
        hint: () => this.scheduleRuntime.hint(),
      }, this.composition.ports.control)
    this.library = new LibraryService({
      store: new LibraryStore(dataRoot),
      core: libraryCorePort(this.core),
      files: this.core,
    })
    this.memory = new ProjectMemoryService(memoryCorePort(this.core))
    this.memoryRuntime = new ProjectMemoryRuntime(ctx, this.store, this.core, this.memory, {
      ensureBot: projectId => this.ensureMemoryBot(projectId),
      invocations: this.composition.ports.invocations,
      sourceTools: { names: ['project_history'], install: (agent, resolveRequest) => installProjectHistoryTools(agent, {
        history: async (exec, args) => { const request = await resolveRequest(exec); return this.historyForProject(request.projectId, args, exec.signal) },
        prepareHistoryRead: (exec, args) => this.prepareHistoryReadFor(exec, args, async next => {
          const request = await resolveRequest(next); return { projectId: request.projectId }
        }),
        readHistoryContent: async (exec, args) => { const request = await resolveRequest(exec); return this.prepareHistoryContent(request.projectId, exec, args) },
      }) },
      notify: (projectId, changes) => {
        if (changes.length === 0) return
        this.publishMemoryNotice({ projectId, kind: changes.some(change => change.kind === 'updated') ? 'updated' : 'added', memoryIds: [...new Set(changes.map(change => change.memoryId))] })
      },
    })
    this.scheduleRuntime = new ProjectScheduleRuntime({
      withMetadataWrite: (target, activity, action, signal, authorization) => this.core.withMetadataWrite(target.projectId, fresh => {
        if (authorization !== undefined) {
          if (authorization.projectId !== target.projectId) throw new Error('定时实际调用者属于其它项目。')
          if (authorization.actor.kind === 'session') {
            if (authorization.actor.hostSessionId === undefined) throw new Error('定时实际调用者缺少承载。')
            const caller = this.core.assertMetadataSession(fresh, { sessionId: authorization.actor.sessionId,
              hostSessionId: authorization.actor.hostSessionId, roles: ['main', 'execution'], activity: 'active' })
            if (caller.session.role !== 'main' && caller.session.id !== target.id) throw new Error('执行会话不能派发其它会话的定时。')
          }
        }
        this.core.assertMetadataSession(fresh, { sessionId: target.id, hostSessionId: target.hostSessionId,
          roles: ['main', 'execution'], activity })
      }, scope => action(scope), signal),
      projects: async () => (await this.store.listProjects()).map(project => ({ projectId: project.id, projectDirectory: join(dataRoot, project.id) })),
      targets: async projectId => (await this.store.listDispatchTargets(projectId)).flatMap<ScheduleRuntimeTarget>(session => session.role !== 'main' && session.role !== 'execution' ? [] : [{
        projectId, projectDirectory: join(dataRoot, projectId), id: session.id, hostSessionId: session.hostSessionId,
        role: session.role, title: session.title, archived: session.archived,
      }]),
      native: async target => {
        const rows = await this.store.listSessionCarriers(target.projectId, target.id)
        const observations = await Promise.all(rows.map(async carrier => {
          if (carrier.sourceLifecycle.kind !== 'available') throw new Error('定时原承载来源已不可读；不能按空历史处理。')
          const read = await this.core.readNativePrefix(target.projectId, carrier.hostSessionId)
          if (!read.readable) throw new Error(read.reason)
          return foldScheduleNativeEvents(read.events, carrier.hostSessionId)
        }))
        return observations.flat()
      },
      prepare: async (target, start) => {
        const resolve = () => this.composition.ports.control.resolve(SessionId(target.hostSessionId))
        const resolved = await (start === undefined ? resolve() : start(resolve))
        if ('error' in resolved) throw new Error(resolved.error.message)
        const membership = this.membershipsByHostSessionId.get(target.hostSessionId)
        if (membership === undefined || membership.project.id !== target.projectId || membership.session.id !== target.id
          || (membership.session.role !== 'main' && membership.session.role !== 'execution')) throw new Error('定时工作目标归属已变化。')
        await this.installProjectAgentScope(resolved.agent, membership)
        const agent = resolved.agent
        const assertCurrent = () => {
          const current = this.currentScheduleTarget(target)
          if (this.disposed || current.projectArchived || current.sessionArchived) throw new Error('原会话已停止接纳设置和新工作。')
        }
        return {
          observations: () => foldScheduleNativeEvents(agent.session.snapshotEvents(), target.hostSessionId),
          send: (source, prompt) => {
            const message = createUserMessage({ source, content: [{ type: 'text', text: prompt }] })
            assertCurrent(); agent.send(message, 'next-turn', true)
            return String(message.id)
          },
          flush: () => ctx.sessions.flush(agent.session),
          prepareInput: (source, prompt) => {
            const message = createUserMessage({ source, content: [{ type: 'text', text: prompt }] })
            return { messageId: String(message.id), send: () => { assertCurrent(); agent.send(message, 'next-turn', true) } }
          },
          pending: { assertCurrent,
            apply: state => { assertCurrent(); return coordinateSchedulePending(agent,
              { projectId: target.projectId, sessionId: target.id, hostSessionId: target.hostSessionId }, state) },
            flush: () => ctx.sessions.flush(agent.session) },
        }
      },
      prepareConfiguration: target => this.prepareScheduleConfigurations(target),
      current: target => this.currentScheduleTarget(target),
      withTargetAdmission: (target, operation, run) => this.withCurrentMainAdmission(target.projectId, target.id, operation, async lease => {
        const current = await this.store.findDispatchTarget(target.projectId, target.id)
        if (current === undefined || (current.role !== 'main' && current.role !== 'execution') || current.hostSessionId !== lease.hostSessionId) throw new Error('定时工作目标归属已变化。')
        const actual: ScheduleRuntimeTarget = { ...target, hostSessionId: lease.hostSessionId, role: current.role, title: current.title, archived: current.archived }
        lease.assertCurrent()
        return this.withTargetOperation(lease.hostSessionId, () => run(actual, () => lease.assertCurrent()))
      }),
      access: request => this.features.resolveScheduleAccess(request),
    })
    this.features = new ProjectFeatureModules(ctx, this.core, this.library, this.memory, dataRoot,
      this.scheduleRuntime, () => this.scheduleRuntime.currentTime(), request => {
        const session = this.snapshotsByProjectId.get(request.projectId)?.sessions.find(row => row.id === request.sessionId)
        if (session?.role !== 'main') return undefined
        const lease = this.mainAdmission.acceptExact(session.hostSessionId, 'main-instructions')
        return lease === undefined ? undefined : () => lease.release()
      })
    this.historyReader = new ProjectHistoryReader(ctx, projectId => this.store.listRetainedSessionSources(projectId),
      (id, projectId) => this.core.readSessionSource(id, projectId), id => this.assertTargetAdmitting(id), projectId => this.store.listRetainedSessionSources(projectId))
    this.continuityHistory = new MainContinuityHistory({ store: this.store, core: this.core, history: this.historyReader })
    this.sessionManager = new MainSessionManager(ctx, this.core, (projectId, mainId) => this.continuityHistory.reader(projectId, mainId), {
      overview: (projectId, signal) => this.features.overview().readContext({ projectId, ...(signal === undefined ? {} : { signal }) }),
      memoryList: request => this.memory.list(request), memoryRead: (request, id) => this.memory.read(request, id),
      observations: async (envelope, signal) => {
        const main = this.ctx.agents.get(SessionId(envelope.hostSessionId)), observedAt = new Date().toISOString()
        if (main === undefined) return { observedAt, state: 'unknown' as const, contextUsage: null, limitations: ['当前承载没有活动Agent；用量观测未知。'], sources: [] }
        const projection = this.ctx.sessionProjections.snapshot(main.session, ['contextPressure'])
        const selected = await this.ctx.projectsRead.withDirectory(main.id, observation => [
          observation.directory.records.findLast(record => record.seq < observation.cut.nextSeq && record.type === 'request/context'),
          observation.directory.records.findLast(record => record.seq < observation.cut.nextSeq && (record.type === 'assistant/message' || record.type === 'assistant/attempt')),
          observation.directory.records.findLast(record => record.seq < observation.cut.nextSeq && (record.type === 'projects/request-dispatch' || record.type === 'projects/request-dispatch-v2')),
        ].flatMap(record => record === undefined ? [] : [record]), { ...(signal === undefined ? {} : { signal }) })
        const identity = { projectId: envelope.projectId, sessionId: envelope.mainSessionId, hostSessionId: envelope.hostSessionId,
          sessionCreatedAt: main.session.header.createdAt, formatVersion: main.session.header.version }
        const { formatVersion, ...sourceIdentity } = identity
        // Directory digests are computed from canonical records by the storage
        // owner. Source references need no request/body hydration or run seed.
        const sources = selected.map(record => decodeNativeEventSource({ kind: 'native-event', version: 1,
          ...sourceIdentity, eventSpace: { kind: 'canonical', formatVersion },
          eventSeq: record.seq, eventType: record.type, eventDigest: record.eventDigest }))
        return { observedAt, state: main.status, contextUsage: projection.values.contextPressure === undefined ? null : asJson({
          values: projection.values.contextPressure, asOfSeq: projection.asOfSeq,
          recordedSources: selected.map((record, index) => ({ eventType: record.type, eventSeq: record.seq, recordedAt: record.time, source: sources[index] })),
          semantics: { pressureTokens: '最近provider报告的输入prompt用量，不含输出；可能属于先前route。',
            projectedTokens: '原生token-meter基于实际input和legal tail的估计，可能经provider样本锚定。', contextWindow: '最近记录route声明容量；三个字段不是同一原子请求观测，不作为程序切换门槛。' } }),
          limitations: ['原生contextPressure各字段分别last-wins，未知字段缺省；估计值不证明当前完整请求一定适合。'], sources }
      },
    }, (window, capacity, signal) => this.continuityHistory.fit(window, capacity, signal), this.composition.ports)
    this.continuityNative = new MainContinuityNative(ctx, this.store, this.composition.ports.control)
    this.continuity = new MainContinuityRuntime(ctx, this.store, this.mainAdmission, this.continuityHistory, this.sessionManager,
      options.sessionManagerTimeoutMs ?? 60_000, {
      current: host => { const owner = this.ownershipByHost.get(host); return owner?.kind === 'current' ? this.membershipsByHostSessionId.get(host) : undefined },
      configuration: async (agent, membership) => {
        const instructions = (await this.features.settings.prepareSessionInstructions({ projectId: membership.project.id, sessionId: membership.session.id })).get()
        if (!instructions.available) throw new Error('Current main instructions are unavailable.')
        return createHash('sha256').update(JSON.stringify({ selection: this.ctx.sessionProjections.stateOf(agent.session, 'modelSelection'),
          options: agent.options, cwd: agent.session.header.cwd, preset: agent.session.header.agentPreset, instructions, nativePolicy: await readMainNativePolicy(agent) })).digest('hex')
      },
      safe: async agent => {
        if (agent.status !== 'idle' || agent.inbox.nextStep.length !== 0 || agent.inbox.nextTurn.length !== 0 || (this.targetOperations.get(String(agent.id))?.size ?? 0) !== 0) throw new Error('Current main still owns accepted work.')
        const questions = this.ctx.sessionProjections.stateOf(agent.session, 'userQuestions')
        if ((questions?.questions.active.length ?? 0) > 0) throw new Error('Current main still owns an unanswered native user question.')
        return this.composition.ports.control.captureSettled(agent.id)
      },
      ensureManager: projectId => this.ensureSessionManager(projectId),
      prepare: (envelope, agent, window, signal, assertValid) => this.continuityNative.prepare(envelope, agent, window, signal, {
        installPrepared: (created, ownership) => this.installPreparedMainScope(created, ownership),
        activate: created => this.activatePublishedMainScope(created), hold: host => { this.withheldMainHosts.add(host) },
        retain: handle => { this.handles.set(String(handle.agent.id), handle) }, assertValid,
      }),
      activate: prepared => this.activatePublishedMainScope(prepared.handle.agent),
      abandon: (envelope, prepared) => this.continuityNative.abandon(envelope, prepared),
    })
    onProjectTurnSettled(ctx, fact => { this.continuity.onSettledTurn(fact) })
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end' && event.type !== 'compaction/summary' && event.type !== 'compaction/end' && event.type !== 'projects/model-request-usage' && event.type !== 'session/title-llm-request') return
      const root = this.sourceDisposition.execution?.get(session.id)?.rootSessionId
      if (root === undefined || root === session.id) return
      const ownership = this.ownershipByHost.get(String(root))
      if (ownership?.kind === 'preparation') this.features.notifyUsage(ownership.project.id)
    })
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'model/selection' && event.type !== 'agent-preset/selected' && event.type !== 'permission/preset'
        && event.type !== 'sandbox/mode' && event.type !== 'approval/policy' && event.type !== 'plan/mode'
        && !(event.type === 'command/run' && event.data.name === 'plan')) return
      const owner = this.ownershipByHost.get(String(session.id))
      if (owner?.kind === 'current' && owner.session.role === 'main') this.continuity.invalidate(owner.project.id, owner.session.id, `native configuration: ${event.type}`)
    })
    onProjectCancelRequested(ctx, ({ agent }) => {
      const owner = this.ownershipByHost.get(String(agent.id))
      if (owner?.kind === 'current' && owner.session.role === 'main') this.continuity.invalidate(owner.project.id, owner.session.id, 'Stop', true)
    })
    const communicationRepository = new CommunicationOperationRepository(this.store)
    this.communicationTranscript = new CommunicationTranscript(ctx,
      (projectId, hostSessionId, signal) => this.core.readNativeDirectory(projectId, hostSessionId, signal))
    this.communicationQuery = new CommunicationQuery(communicationRepository, this.communicationTranscript, this.store)
    const visibleReader = new CommunicationVisibleReader({
      readDirectory: (projectId, hostSessionId, signal) => this.core.readNativeDirectory(projectId, hostSessionId, signal),
      readSnapshot: (projectId, record, signal) => this.communicationTranscript.readSnapshot(projectId, record, signal),
      verifyAttachment: communicationAttachmentVerifier(ctx),
    })
    this.communicationSavedRead = new CommunicationSavedRead({ ctx, store: this.store, core: this.core,
      transcript: this.communicationTranscript, query: this.communicationQuery })
    this.communication = new CommunicationService(communicationRepository, this.communicationTranscript, new NativeInputPort(ctx, {
      control: this.composition.ports.control,
      assertTarget: target => this.assertCommunicationTarget(target), canDrive: id => this.lifecycle.canDrive(id),
    }), this.communicationQuery, {
      invocations: this.composition.ports.invocations,
      access: exec => this.communicationAccess(exec),
      authorizeNew: async (exec, access) => {
        const current = await this.toolContext(exec, 'project_send_message')
        if (current.membership.project.id !== access.projectId || current.membership.session.id !== access.sender.sessionId
          || !this.lifecycle.canDrive(access.sender.hostSessionId)) throw communicationError('COMMUNICATION_NEW_OPERATION_FORBIDDEN', 'The actual sender is not admitting new communication')
        this.assertTargetAdmitting(access.sender.hostSessionId)
      },
      withTarget: (projectId, sessionId, operation, run) => this.withCurrentMainAdmission(projectId, sessionId, operation, async lease => {
        const target = await this.store.findDispatchTarget(projectId, sessionId)
        if (target === undefined || (target.role !== 'main' && target.role !== 'execution') || target.hostSessionId !== lease.hostSessionId) throw communicationError('COMMUNICATION_TARGET_UNAVAILABLE', 'The actual Project recipient is unavailable')
        lease.assertCurrent()
        return this.withTargetOperation(lease.hostSessionId, () => run(communicationEndpoint(target), () => lease.assertCurrent()))
      }),
      replyHolders: async (projectId, sessionId) => {
        const session = await this.store.getSession(projectId, sessionId)
        if (session === undefined || (session.role !== 'main' && session.role !== 'execution')) return []
        const holders: CommunicationSessionIdentity[] = []
        for (const carrier of await this.store.listSessionCarriers(projectId, sessionId)) {
          if (carrier.header !== undefined) { holders.push({ hostSessionId: carrier.hostSessionId, sessionCreatedAt: carrier.header.createdAt }); continue }
          if (carrier.sourceLifecycle.kind !== 'available') continue
          const directory = await this.core.readNativeDirectory(projectId, carrier.hostSessionId)
          if (directory.readable) holders.push({ hostSessionId: carrier.hostSessionId, sessionCreatedAt: directory.sessionCreatedAt })
        }
        return holders
      },
      withHolder: (id, run) => this.withTargetOperation(id, run),
      resolveSources: input => visibleReader.resolveSources(input),
      sessionCreatedAt: async (projectId, hostSessionId) => {
        const directory = await this.core.readNativeDirectory(projectId, hostSessionId)
        if (!directory.readable) throw communicationError('COMMUNICATION_TARGET_UNAVAILABLE', directory.reason)
        return directory.sessionCreatedAt
      },
    })
    this.deletion = new ProjectSourceDeletion(ctx, this.store, dataRoot, this.lifecycle, this.features.settings, {
      nativeStorageDataRoot: this.composition.paths.dataRoot,
      metadataCleanup: (target, action) => this.core.withMetadataCleanup(target.projectId, target, scope => action(scope)),
      control: this.composition.ports.control,
      creating:id=>this.creatingRoots.get(id),
      scope: () => this.composition.ports.control.deletionScope(),
      prepareProject:projectId=>this.prepareProjectDeletion(projectId),
      prepareBackground:projectId=>this.memoryRuntime.batches.prepareDeletion(projectId),
      library:projectId=>this.library.prepareProjectDeletion(projectId),
      prepareTarget:(projectId,sessionId,hostSessionId,preparation) => this.prepareExecutionDeletionTarget(projectId,sessionId,hostSessionId,preparation),
      handle:id => this.handles.get(id), detail:projectId => this.requireDetail(projectId),
    })
  }

  /** Factory setup receives only the exact Agent created inside this graph. */
  async installAgent(agent: Agent): Promise<void> {
    const ownership = await this.store.resolveHostOwnership(String(agent.id))
    if (ownership?.kind === 'preparation') {
      if (ownership.preparation.toHeader === undefined) {
        // This exact reserved create has not run caller.setup yet. Its owner
        // confirms the real header there before installing the prepared scope.
        this.composition.ports.recording.install(agent, this.options.originalRecording ?? { streamCheckpointBytes: 4096, streamCheckpointIntervalMs: 1000 })
        return
      }
      await this.installPreparedMainScope(agent, ownership)
      return
    }
    const binding = await this.store.findCarrierByHostSessionId(String(agent.id))
    // Native children inherit their root's scope/preset; they do not become logical work sessions.
    if (binding === undefined && agent.session.header.parentSession !== undefined) {
      this.composition.ports.recording.install(agent, this.options.originalRecording ?? { streamCheckpointBytes: 4096, streamCheckpointIntervalMs: 1000 })
      return
    }
    if (binding === undefined) throw new Error('Factory Agent has no saved Project membership')
    await this.installProjectAgentScope(agent, { project: binding.project, session: { ...binding.session,
      hostSessionId: binding.carrier.hostSessionId, sourceLifecycle: binding.carrier.sourceLifecycle,
      ownedLifecycle: binding.carrier.ownedLifecycle } })
  }

  isCreatingCarrier(id: string): boolean { return this.creatingRoots.has(id) }
  carrierRoot(id: string): string | undefined { return this.sourceDisposition.execution?.get(SessionId(id))?.rootSessionId }

  /** P0 creation remains tracked by the same lifecycle owner as all domain creation. */
  async withCarrierCreation<T>(id: string, run: () => Promise<T>): Promise<T> {
    this.assertInitializing()
    if (this.creatingRoots.has(id)) throw new Error('Project carrier is already being created')
    const settled = Promise.withResolvers<void>()
    this.creatingRoots.set(id, settled.promise)
    void settled.promise.catch(() => {})
    try { return await run() }
    catch (error) { settled.reject(error); throw error }
    finally { settled.resolve(); if (this.creatingRoots.get(id) === settled.promise) this.creatingRoots.delete(id) }
  }
  retainCarrierHandle(handle: AgentHandle): void { this.handles.set(String(handle.agent.id), handle) }

  /** Load memberships and initialize eligible retained model choices before publishing the catalog source. */
  async initialize(): Promise<void> {
    if (this.initializing !== undefined) return await this.initializing
    this.initializing = this.initializeInner()
    return await this.initializing
  }

  /** Cut producers synchronously; their real settlement is joined by dispose after model drain. */
  beginClose(): void {
    if (this.admissionClose !== undefined) return
    this.store.cancelPendingWrites(new ProjectsClosingError())
    this.disposed = true
    this.cancelAutomaticReady?.(); this.cancelAutomaticReady = undefined
    this.lifecycle.closeAdmission()
    const start = (run: () => Promise<void>): Promise<void> => {
      let promise: Promise<void>
      try { promise = run() } catch (error) { promise = Promise.reject(error) }
      void promise.catch(() => {})
      return promise
    }
    this.admissionClose = {
      continuity: start(() => this.continuity.close()),
      memory: start(() => this.memoryRuntime.close()),
      schedule: start(() => this.scheduleRuntime.closeAdmission()),
    }
    // Cancel does not dispose a handle or close its journal writer.
    for (const agent of this.ctx.agents.list()) agent.cancel({ kind: 'disposed' }, { keepInbox: true })
  }

  /** Release only live Project handles and catalog registration; durable records stay intact. */
  dispose(): Promise<void> {
    return this.disposing ??= this.disposeInner()
  }
  private async disposeInner(): Promise<void> {
    this.beginClose()
    const pending: Promise<unknown>[] = []
    const start = (run: () => unknown): Promise<unknown> => {
      let promise: Promise<unknown>
      try { promise = Promise.resolve(run()) } catch (error) { promise = Promise.reject(error) }
      pending.push(promise)
      return promise
    }
    // 所有责任先发停止；必要source通知失败也不能跳过其余真实owner。
    const continuityClosed = start(() => this.admissionClose!.continuity)
    const memoryClosed = start(() => this.admissionClose!.memory)
    const backgroundSettled = Promise.allSettled([continuityClosed, memoryClosed]).then(() => undefined)
    start(() => this.lifecycle.closeAdmission())
    start(() => this.admissionClose!.schedule)
    if (this.automaticConnection !== undefined) pending.push(this.automaticConnection)
    const ids = [...new Set([...this.membershipsByHostSessionId.keys(), ...this.handles.keys(), ...this.creatingRoots.keys(),
      ...[...this.snapshotsByProjectId.values()].flatMap(snapshot => snapshot.sessions.flatMap(session =>
        (session.mainPreparations ?? []).filter(preparation => preparation.state !== 'committed' && preparation.retirement !== 'confirmed').map(preparation => preparation.toHostSessionId)))])]
    const roots = ids.map(id => ({ id: SessionId(id), epoch: this.handles.get(id)?.agent ?? this.ctx.agents.get(SessionId(id)) }))
    // Native subtree admission/rollback must be captured before root cancellation.
    start(() => this.composition.ports.control.closeOwned(roots, backgroundSettled))
    for (const { epoch } of roots) if (epoch !== undefined) start(() => epoch.cancel({ kind: 'disposed' }, { keepInbox: true }))
    // API自己持有已接纳创建/rollback和真handle；不能以registry缺席替代结局。
    for (const id of ids) {
      const creation = this.creatingRoots.get(id)
      const handle = this.handles.get(id)
      // 先停止真工作；只有仍未交回真handle的本root延后API退役，不拖住其它root。
      if (creation !== undefined && handle === undefined) this.ctx.agents.get(SessionId(id))?.cancel({ kind: 'disposed' }, { keepInbox: true })
      start(async () => {
        await backgroundSettled
        const created = creation !== undefined && handle === undefined
          ? await Promise.allSettled([creation]) : []
        const retirement = await this.composition.ports.control.retire(SessionId(id), { handle: this.handles.get(id) })
        const failures = created.flatMap(row => row.status === 'rejected'
          && !(row.reason instanceof ProjectsClosingError) && !(row.reason instanceof ProjectDeletionCreationSettledError) ? [row.reason] : [])
        if (retirement.status !== 'stopped') failures.push(...retirement.errors)
        if (failures.length) throw new AggregateError(failures, `项目根会话 ${id} 真实关闭未确认。`)
      })
    }
    start(() => this.lifecycle.settleAccepted())
    for (const operation of [...this.targetOperations.values()].flatMap(values => [...values])) pending.push(operation.catch(error => { if (!(error instanceof ProjectsClosingError)) throw error }))
    if (this.initializing !== undefined) pending.push(this.initializing.catch(error => {
      if (!(error instanceof ProjectsClosingError)) throw error
    }))
    const results = await Promise.allSettled(pending)
    // 已接纳创建可以晚交回handle；此时其最后命名/保存/rollback已结算。
    const released = await Promise.allSettled([...this.handles.values()].map(handle => handle.dispose()))
    const failures = [...results, ...released].flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) {
      this.scheduleRuntime.disposeFacts()
      throw new AggregateError(failures, 'projects: Agent/B settlement teardown failed; source remains readonly')
    }
    this.handles.clear()
    this.unsubscribeStore?.(); this.unsubscribeStore = undefined
    await Promise.resolve(this.disposeProjectAgentDisposed?.()); this.disposeProjectAgentDisposed = undefined
    const disposeCreated = this.disposeProjectAgentCreated; this.disposeProjectAgentCreated = undefined
    await Promise.resolve(disposeCreated?.())
    await Promise.resolve(this.disposeProjectSessionCreated?.()); this.disposeProjectSessionCreated = undefined
    this.disposeCatalogMembership?.(); this.disposeCatalogMembership = undefined
    this.scheduleRuntime.disposeFacts()
    for (const listeners of this.memoryNoticeListeners.values()) { for (const listener of listeners) listener(undefined); listeners.clear() }
    this.memoryNoticeListeners.clear()
  }

  /** List durable Project records without waking any DSH Session. */
  async list(): Promise<readonly ProjectSummary[]> {
    this.assertReady()
    return (await this.store.listProjects()).map(projectRecord)
  }

  /** Read one Project record and its bindings without waking any DSH Session. */
  async get(projectId: string): Promise<ProjectDetail | undefined> {
    this.assertReady()
    const project = await this.store.getProject(projectId)
    if (project === undefined) return undefined
    return this.requireDetail(projectId)
  }

  /** Stream committed records and confirmed lifecycle release details without waking a Session. */
  async *watch(projectId: string, signal: AbortSignal): AsyncIterable<ProjectDetail> {
    this.assertReady()
    signal.throwIfAborted()
    let pending: ProjectDetail | undefined
    let wake: (() => void) | undefined
    const enqueue = (snapshot: ProjectSnapshot): void => {
      if (snapshot.project.id !== projectId) return
      pending = this.projectDetail(snapshot)
      wake?.()
    }
    const unsubscribe = this.store.subscribe(enqueue)
    this.lifecycleDetailListeners.add(enqueue)
    const abort = (): void => { wake?.() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const initial = this.projectDetail(await this.snapshot(projectId))
      // A commit may race between the asynchronous read settling and this
      // generator resuming. Keep the latest pending snapshot, dropping only an identical
      // baseline rather than clearing a newer ProjectStore commit.
      let lastFingerprint = detailFingerprint(initial)
      yield initial
      while (!signal.aborted) {
        const next = pending
        pending = undefined
        if (next !== undefined) {
          const fingerprint = detailFingerprint(next)
          if (fingerprint === lastFingerprint) continue
          lastFingerprint = fingerprint
          yield next
          continue
        }
        await new Promise<void>(resolve => { wake = resolve })
        wake = undefined
      }
    } finally {
      unsubscribe()
      this.lifecycleDetailListeners.delete(enqueue)
      signal.removeEventListener('abort', abort)
    }
  }

  /** Create and save a Project and its main Session, then wait for user input. */
  create(request: CreateProjectRequest, signal?: AbortSignal): Promise<CreateProjectResult> {
    return this.acceptOperation(() => this.options.creation!.create(request, signal))
  }

  /** Persist and create one empty execution Session under an existing Project. */
  createSession(request: CreateProjectSessionRequest, signal?: AbortSignal): Promise<ProjectDetail> {
    return this.acceptProjectOperation(request.projectId,() => this.options.creation!.createSession(request, signal))
  }

  /** 改名只保存已有身份的用户标题，不投递消息或改变生命周期。 */
  renameExecutionSession(request: RenameExecutionSessionRequest): Promise<RenameExecutionSessionResult> {
    this.assertReady()
    return this.acceptProjectOperation(request.projectId, () => {
      const target = this.snapshotsByProjectId.get(request.projectId)?.sessions.find(session => session.id === request.sessionId)
      if (target === undefined || target.role !== 'execution' || target.sourceLifecycle.kind !== 'available') {
        throw new Error('改名目标不是本项目的可用执行会话。')
      }
      // 首次 await 前按既有 host 身份登记；单目标/整项目删除及归档沿原 owner 排空。
      return this.withTargetOperation(target.hostSessionId, () => this.renameExecutionSessionAccepted(request, target))
    }).catch((error: unknown) => {
      // 写失败仍拒绝原 accepted operation，不能让同时开始的删除把未确认保存当成功排空。
      if (error instanceof ExecutionSessionRenameError || error instanceof ExecutionSessionRenameClosingError) return error.result
      if (error instanceof ProjectsClosingError) return this.renameResult(request, 'failed', '项目服务正在退出，本次名称未保存。')
      throw error
    })
  }

  private async renameExecutionSessionAccepted(
    request: RenameExecutionSessionRequest,
    target: ProjectSession,
  ): Promise<RenameExecutionSessionResult> {
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1) throw new Error('执行会话修订号无效。')
    const snapshot = await this.store.getSnapshot(request.projectId)
    const current = snapshot.sessions.find(session => session.id === request.sessionId)
    if (current?.hostSessionId !== target.hostSessionId || current.role !== 'execution' || current.sourceLifecycle.kind !== 'available') {
      throw new Error('执行会话归属或来源状态已变化。')
    }
    if (current.revision !== request.expectedRevision) return this.renameResult(request, 'conflict', '执行会话已变化，已刷新当前名称；请核对后重新修改。')
    this.assertInitializing()
    this.assertTargetAdmitting(target.hostSessionId)
    let nativeTitle: RenameExecutionSessionResult['nativeTitle']
    try {
      // 先取得同一metadata writer再进入Store CAS；归档标题保存不需要工作准入或Agent冷恢复。
      const transaction = await this.composition.ports.control.editSessionMetadata({
        projectId: request.projectId, sessionId: request.sessionId, hostSessionId: target.hostSessionId,
      }, async (session, flush) => {
        try {
          this.assertInitializing()
          this.assertTargetAdmitting(target.hostSessionId)
          const saved = await this.store.renameExecutionSession({
            projectId: request.projectId, sessionId: request.sessionId,
            hostSessionId: target.hostSessionId, expectedRevision: request.expectedRevision,
          }, async () => {
            this.assertInitializing()
            this.assertTargetAdmitting(target.hostSessionId)
            const accepted = this.ctx.sessionTitle.rename(session, request.title)
            nativeTitle = { title: accepted.title, saved: false }
            await flush()
            nativeTitle = { title: accepted.title, saved: true }
            this.assertInitializing()
            this.assertTargetAdmitting(target.hostSessionId)
            return accepted.title
          })
          return { kind: 'saved' as const, saved }
        } catch (error) {
          // The original target operation retains the business rejection; the
          // control owner separately joins the successfully released writer.
          return { kind: 'failed' as const, error }
        }
      })
      if (transaction.kind === 'failed') throw transaction.error
      const saved = transaction.saved
      return this.renameResult(request, saved.kind === 'conflict' ? 'conflict' : 'renamed',
        saved.kind === 'conflict' ? '执行会话已变化，已刷新当前名称；请核对后重新修改。' : '执行会话名称已保存。', nativeTitle)
    } catch (error: unknown) {
      if (error instanceof ProjectsClosingError && nativeTitle === undefined) throw error
      const message = nativeTitle === undefined ? `执行会话改名未完成：${errorMessage(error)}`
        : error instanceof ProjectsClosingError && nativeTitle.saved ? `项目服务正在退出，改名未完整保存：聊天标题已保存为「${nativeTitle.title}」，项目列表名称未更新。`
        : nativeTitle.saved ? `改名未完整保存：聊天标题已保存为「${nativeTitle.title}」，项目列表名称保存未确认。${errorMessage(error)}`
        : `改名未完整保存：聊天已接纳「${nativeTitle.title}」，但其落盘未确认；项目列表名称未更新。${errorMessage(error)}`
      const result = await this.renameResult(request, 'failed', message, nativeTitle)
      if (error instanceof ProjectsClosingError) throw new ExecutionSessionRenameClosingError(result)
      throw new ExecutionSessionRenameError(result, { cause: error })
    }
  }

  private async renameResult(
    request: RenameExecutionSessionRequest,
    kind: RenameExecutionSessionResult['kind'],
    message: string,
    nativeTitle?: RenameExecutionSessionResult['nativeTitle'],
  ): Promise<RenameExecutionSessionResult> {
    return { kind, sessionId: request.sessionId, detail: await this.requireDetail(request.projectId), message,
      ...(nativeTitle === undefined ? {} : { nativeTitle }) }
  }

  async executionLifecycle(request: ExecutionLifecycleActionRequest): Promise<ExecutionLifecycleActionResult> {
    this.assertReady()
    let result: ExecutionLifecycleActionResult['kind'] = 'failed'
    let message: string
    let stoppedConfirmed = false
    try {
      const changed = await this.lifecycle.change(request, request.action)
      result = changed.kind
      stoppedConfirmed = changed.kind !== 'unchanged'
      message = changed.kind === 'archived' ? '执行会话已归档，当前运行已结束；后来消息已保留。'
        : changed.kind === 'restored' ? '执行会话已恢复；本次没有发送消息或自动续跑。'
        : '归档记录未变化；本次没有重新确认停止或执行工作。'
    } catch (error: unknown) {
      stoppedConfirmed = error instanceof LifecycleOperationError
        && (error.stoppedConfirmed || error.cause instanceof LifecycleStoppedPersistenceError)
      const boundary = error instanceof LifecycleBoundaryError ? error.code : undefined
      const reason = boundary === 'LIFECYCLE_PROJECT_ACTION_REQUIRED' ? '主会话的同类操作属于整个项目，请使用项目入口。'
        : boundary === 'LIFECYCLE_SCHEDULES_OUT_OF_SLICE' ? '该会话有定时设置，当前入口尚未接入此类会话。'
        : boundary === 'LIFECYCLE_PROJECT_ARCHIVED' ? '请先恢复整个项目。'
        : error instanceof LifecycleOperationError && error.stage === 'prepare-archive' ? '归档准备或记录保存失败。'
        : error instanceof LifecycleOperationError && error.stage === 'save-restore' ? '恢复记录保存失败。'
        : '本次处理失败，未自动回滚或重试。'
      message = error instanceof LifecycleOperationError && error.cause instanceof Error
        ? error.cause.message : `本次${request.action === 'archive' ? '归档' : '恢复'}未完成。${reason}`
      this.ctx.logger.warn(`projects: execution lifecycle ${request.projectId}/${request.sessionId}: ${errorMessage(error)}`)

    }
    const actual = await this.store.getSnapshot(request.projectId)
    if (result !== 'failed') this.replaceProjectMembership(actual)
    const detail = this.projectDetail(actual)
    const session = detail.sessions.find(item => item.id === request.sessionId)
    if (session === undefined) throw new Error('生命周期目标当前不可读。')
    if (result === 'failed') message += ` 当前记录：${session.archived ? '已归档' : '活跃'}；${stoppedConfirmed ? '当前运行已结束' : '当前停止结果未确认'}。`
    return { kind: result, detail, stoppedConfirmed, admissionHeld: !this.lifecycle.canDrive(session.hostSessionId), message }
  }


  async deleteExecutionSession(request:DeleteExecutionSessionRequest):Promise<ProjectDeletionActionResult>{this.assertReady();return this.deletion.deleteExecution(request)}
  async deleteProject(request:DeleteProjectRequest):Promise<ProjectDeletionActionResult>{this.assertReady();return this.deletion.deleteProject(request)}

  async projectLifecycle(request: ProjectLifecycleActionRequest): Promise<ProjectLifecycleActionResult> {
    this.assertReady()
    const { snapshot, ...result } = await this.lifecycle.changeProject(request)
    return { ...result, detail: this.projectDetail(snapshot) }
  }

  /** Update the P1.0 Project fields and return the actual saved detail. */
  update(request: UpdateProjectRequest): Promise<ProjectDetail> {
    return this.acceptProjectOperation(request.projectId,() => this.updateAccepted(request))
  }

  private async updateAccepted(request: UpdateProjectRequest): Promise<ProjectDetail> {
    this.assertReady()
    if (request.expectedRevision === undefined) throw new RemoteError('projects/update-revision-required',
      '请刷新项目后按所读取的版本保存；缺少编辑版本，未提交本次修改。', { projectId: request.projectId })
    const current = await this.requireProject(request.projectId)
    let result
    try {
      result = await this.store.updateProject(current.id, {
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.workspace === undefined ? {} : { workspace: request.workspace }),
      }, { expectedRevision: request.expectedRevision })
    } catch (error) {
      const detail = durableMutationDetails(error)
      if (detail !== undefined && detail.effect !== 'none') throw new RemoteError('projects/update-unconfirmed', detail.message,
        { projectId: request.projectId, stage: detail.stage, effect: detail.effect }, { cause: error })
      throw error
    }
    const actual = await this.requireDetail(result.project.id)
    if (result.kind === 'conflict') throw new RemoteError('projects/update-conflict',
      '项目已被其它窗口修改；本次未覆盖，请核对当前内容后重新保存。', { current: actual })
    return actual
  }

  /** 按需读当前基础事实、同一看板正文和精确原生来源。 */
  async readProject(exec: ToolRunContext, args: ReadProjectArgs): Promise<JsonValue> {
    if (args.operation_ref !== undefined || args.delivery_id !== undefined) {
      if ((args.operation_ref === undefined) === (args.delivery_id === undefined)
        || args.source_host_session_id !== undefined || args.source_message_id !== undefined || args.source_tool_call_id !== undefined) {
        throw communicationError('COMMUNICATION_QUERY_ARGUMENTS_INVALID', 'Use exactly one operation_ref or delivery_id without another source locator')
      }
      const access = await this.communicationAccess(exec)
      return await this.communicationQuery.read(access.projectId, { operationRef: args.operation_ref, deliveryId: args.delivery_id }) as unknown as JsonValue
    }
    const current = await this.toolContext(exec, 'project_read')
    if (current.membership.session.role !== 'main' && current.membership.session.role !== 'execution') throw projectToolError('后台记忆不属于工作会话。', 'PROJECT_TOOL_SESSION_REQUIRED')
    const source = nativeSourceFromReadArgs(args)
    const nativeSource = source === undefined
      ? undefined
      : await this.readSourceForProject(current.snapshot, source, exec.signal)
    const detail = this.projectDetail(current.snapshot)
    return asJson({
      ...detail,
      sessions: detail.sessions.map(session => ({ ...session, ...projectSessionReplyReference(session) })),
      overview: await this.features.overview({ kind: 'session', sessionId: current.membership.session.id,
        role: current.membership.session.role }).readContext({ projectId: current.snapshot.project.id }),
      targets: [projectTarget(current.membership.session)],
      currentSession: {
        id: current.membership.session.id,
        role: current.membership.session.role,
        ...projectSessionReplyReference(current.membership.session),
      },
      invocationInputs: current.inputs,
      ...(nativeSource === undefined ? {} : { source: nativeSource,
        currentMemory: await this.memoryRelations(current, nativeSource.items, exec.signal) }),
    })
  }

  /** Read a stored Project source for UI use without activating its DSH Agent. */
  async readSource(request: ReadProjectSourceRequest, signal: AbortSignal): Promise<ProjectNativeSourceRead> {
    this.assertReady()
    signal.throwIfAborted()
    const snapshot = await this.snapshot(request.projectId)
    return await this.readSourceForProject(snapshot, request.source, signal)
  }

  async queryHistory(request: QueryProjectHistoryRequest, signal: AbortSignal): Promise<ProjectHistorySearchResult> {
    this.assertReady()
    const { projectId, ...query } = request
    return this.historyReader.search(projectId, query, signal, undefined, { displaySummary: true, chat: true })
  }

  async readHistory(request: ReadProjectHistoryRequest, signal: AbortSignal): Promise<ProjectHistoryReadResult> {
    this.assertReady()
    const { projectId, ...query } = request
    return this.historyReader.read(projectId, query, signal, { chat: true })
  }

  async readCommunication(request: ReadProjectCommunicationRequest, signal: AbortSignal): Promise<ProjectCommunicationRead> {
    this.assertReady()
    signal.throwIfAborted()
    return this.communicationSavedRead.readCommunication(request, signal)
  }

  async resolveCommunicationNavigation(request: ResolveProjectCommunicationNavigationRequest, signal: AbortSignal): Promise<ProjectCommunicationNavigation> {
    this.assertReady()
    signal.throwIfAborted()
    return this.communicationSavedRead.resolveCommunicationNavigation(request, signal)
  }

  async resolveCommunicationFile(request: ResolveProjectCommunicationFileRequest, signal: AbortSignal): Promise<ProjectCommunicationFile> {
    this.assertReady()
    signal.throwIfAborted()
    return this.communicationSavedRead.resolveCommunicationFile(request, signal)
  }

  /** Browser settings uses the same retained source reader; no tool/Agent/model is created. */
  async readMemorySourceContent(request: import('./public-types.ts').ReadMemorySourceContentRequest, signal: AbortSignal): Promise<import('./public-types.ts').ProjectMemorySourceContentPage> {
    this.assertReady(); signal.throwIfAborted()
    await this.core.forSettingsUser(request.projectId)
    return this.historyReader.readContent(request.projectId, request.content, { estimate: content => estimateContent(content) }, signal)
  }

  /** Capture the real output-retention owner once for this exact execution. */
  async readHistoryContent(exec: ToolRunContext, args: ProjectHistoryContentRequest): Promise<PreparedProjectHistoryContent> {
    const current = await this.toolContext(exec, 'project_history')
    return this.prepareHistoryContent(current.membership.project.id, exec, args)
  }

  private async prepareHistoryContent(projectId: string, exec: ToolRunContext, args: ProjectHistoryContentRequest): Promise<PreparedProjectHistoryContent> {
    const budget: CommunicationContentBudget = this.ctx.get('toolResultRetention')?.budget(exec)
      ?? { estimate: content => estimateContent(content) }
    const page = await this.historyReader.readContent(projectId, args, budget, exec.signal)
    return { page, finalize: retained => finalizeProjectHistoryContentPage(page, retained, budget) }
  }

  async history(exec: ToolRunContext, args: HistoryArgs): Promise<JsonValue> {
    const current = await this.toolContext(exec, 'project_history')
    return this.historyForProject(current.membership.project.id, args, exec.signal, current)
  }

  async prepareHistoryRead(exec: ToolRunContext, args: HistoryArgs): Promise<PreparedToolRead> {
    return this.prepareHistoryReadFor(exec, args, async next => {
      const current = await this.toolContext(next, 'project_history')
      return { projectId: current.membership.project.id, current }
    })
  }

  private async prepareHistoryReadFor(exec: ToolRunContext, args: HistoryArgs,
    authorize: (exec: ToolRunContext) => Promise<{ projectId: string; current?: ProjectToolContext }>): Promise<PreparedToolRead> {
    const access = await authorize(exec), projectId = access.projectId
    let samePage: ((signal?: AbortSignal) => Promise<ProjectHistorySearchResult>) | undefined
    const value = await this.historyForProject(projectId, args, exec.signal, access.current, read => { samePage = read })
    const read = samePage
    return { value, ...(read === undefined ? {} : { reread: async (next: ToolRunContext) => {
      const fresh = await authorize(next)
      if (fresh.projectId !== projectId) throw projectToolError('History result belongs to another Project.', 'PROJECT_HISTORY_ARGUMENTS_INVALID')
      const result = await read(next.signal)
      return asJson({ ...result, ...(fresh.current === undefined ? {} : {
        currentMemory: await this.memoryRelations(fresh.current, result.items, next.signal),
      }) })
    } }) }
  }

  private async historyForProject(projectId: string, args: HistoryArgs, signal: AbortSignal, current?: ProjectToolContext,
    captureSamePage?: (read: (signal?: AbortSignal) => Promise<ProjectHistorySearchResult>) => void): Promise<JsonValue> {
    const named = args.source_host_session_id !== undefined || args.source_message_id !== undefined || args.source_tool_call_id !== undefined
    if (args.source !== undefined && named) throw projectToolError('source 不可与命名原生定位混用。', 'PROJECT_HISTORY_ARGUMENTS_INVALID')
    const source = args.source ?? nativeSourceFromReadArgs(args)
    if (args.action === 'read') {
      if (source === undefined || args.session_ids !== undefined || args.from_time !== undefined
        || args.to_time !== undefined || args.host_session_ids !== undefined || args.producer !== undefined || args.record_kinds !== undefined || args.time_field !== undefined || args.keyword !== undefined || args.speaker !== undefined
        || args.cursor !== undefined || args.limit !== undefined) {
        throw projectToolError('read 只接受精确消息/tool定位及前后文数量。', 'PROJECT_HISTORY_ARGUMENTS_INVALID')
      }
      const result = await this.historyReader.read(projectId, { source, before: args.before, after: args.after }, signal)
      return asJson({ ...result, ...(current === undefined ? {} : { currentMemory: await this.memoryRelations(current, result.items, signal) }) })
    }
    if (args.action !== 'search' || source !== undefined || args.before !== undefined || args.after !== undefined) {
      throw projectToolError('search 使用筛选条件，read 使用精确来源定位。', 'PROJECT_HISTORY_ARGUMENTS_INVALID')
    }
    const result = await this.historyReader.search(projectId, {
      sessionIds: args.session_ids, hostSessionIds: args.host_session_ids, producer: args.producer, recordKinds: args.record_kinds, timeField: args.time_field, fromTime: historyTime(args.from_time), toTime: historyTime(args.to_time),
      speaker: args.speaker, keyword: args.keyword, limit: args.limit, cursor: args.cursor,
    }, signal, captureSamePage)
    return asJson({ ...result, ...(current === undefined ? {} : { currentMemory: await this.memoryRelations(current, result.items, signal) }) })
  }

  /** 只在工作工具组合层附关系；UI及原生reader继续忠实提供原件。 */
  private memoryRelations(current: ProjectToolContext, items: readonly { nativeSource?: NativeProjectSource }[], signal: AbortSignal) {
    const sources = items.flatMap(item => item.nativeSource !== undefined && (item.nativeSource.kind === 'message' || item.nativeSource.kind === 'native-event') ? [item.nativeSource] : [])
    return this.memory.relateMessageSources({ projectId: current.membership.project.id,
      actor: { kind: 'session', hostSessionId: current.membership.session.hostSessionId }, signal }, sources)
  }

  /** 主会话新建或复用执行会话后直接发送交办，不生成业务任务对象。 */
  async createProjectSession(exec: ToolRunContext, args: CreateSessionArgs): Promise<JsonValue> {
    const current = await this.toolContext(exec, 'project_create_session')
    this.requireRole(current, 'main', 'project_create_session')
    const title = requiredText(args.title, 'title')
    if (args.instructions !== undefined && typeof args.instructions !== 'string') throw communicationError('COMMUNICATION_ARGUMENTS_INVALID', 'instructions must be a complete string, including an explicit empty value')
    const created = await this.acceptProjectOperation(current.snapshot.project.id, () =>
      this.options.creation!.createExecution(current.snapshot.project, title, args.instructions, exec.signal))
    return asJson({ projectId: current.snapshot.project.id, creation: 'created', target: { ...projectSessionRecord(created.session), ...projectSessionReplyReference(created.session) }, targets: [projectTarget(created.session)], modelStarted: false,
      ...(created.warning === undefined ? {} : { error: created.warning }) })
  }

  sendProjectMessage(exec: ToolRunContext, args: SendMessageArgs): Promise<JsonValue> {
    return this.communication.send(exec, args)
  }

  /** Query access is a real retained Project binding, independent of the original turn or target lifetime. */
  private async communicationAccess(exec: ToolRunContext): Promise<CommunicationAccess> {
    const agent = exec.agent
    if (agent === undefined) throw communicationError('COMMUNICATION_PROJECT_ACCESS_REQUIRED', 'A real Project session caller is required')
    const retained = await this.store.findSessionSourceByHostSessionId(String(agent.id))
    if (retained === undefined || retained.projectDeletion || (retained.role !== 'main' && retained.role !== 'execution')) throw communicationError('COMMUNICATION_PROJECT_ACCESS_REQUIRED', 'The caller has no retained work-session binding in an available Project')
    const invocation = this.composition.ports.invocations.get(exec)
    if (invocation !== undefined && (String(invocation.sessionId) !== String(agent.id)
      || invocation.sessionCreatedAt !== agent.session.header.createdAt)) throw communicationError('COMMUNICATION_INVOCATION_INVALID', 'Invocation and actual caller identity do not match')
    return { projectId: retained.projectId, sender: communicationEndpoint(retained), agent }
  }

  private assertCommunicationTarget(target: CommunicationEndpoint): void {
    this.assertTargetAdmitting(target.hostSessionId)
    const current = this.membershipsByHostSessionId.get(target.hostSessionId)
    if (this.disposed || current?.session.id !== target.sessionId || current.session.role !== target.role) throw communicationError('COMMUNICATION_TARGET_UNAVAILABLE', 'The original recipient is unavailable; it was not recreated')
  }

  async stopExecution(exec: ToolRunContext, args: StopExecutionArgs): Promise<JsonValue> {
    return asJson(await stopProjectExecution(exec, args, {
      ctx: this.ctx,
      resolveCall: async call => {
        const current = await this.toolContext(call, 'project_stop_execution')
        return { projectId: current.membership.project.id, sessionId: current.membership.session.id,
          hostSessionId: String(current.agent.id), role: current.membership.session.role }
      },
      readUserSource: async (projectId, source, signal) => {
        const original = await this.core.requireOriginalUser(projectId, source, signal)
        return { readable: true, isUserDecision: true, text: original.quote }
      },
      readTarget: async (projectId, sessionId) => {
        const target = await this.store.findDispatchTarget(projectId, sessionId)
        return target === undefined || (target.role !== 'main' && target.role !== 'execution') ? undefined : { projectId, sessionId: target.id, hostSessionId: target.hostSessionId, role: target.role }
      },
      assertCurrent: (call, target) => {
        const agent = exec.agent, caller = this.membershipsByHostSessionId.get(call.hostSessionId)
        const current = this.membershipsByHostSessionId.get(target.hostSessionId)
        if (this.disposed || agent === undefined || String(agent.id) !== call.hostSessionId
          || this.ctx.agents.get(agent.id) !== agent || agent.status !== 'running' || this.ctx.agents.currentInitiator() !== agent
          || caller?.project.id !== call.projectId || caller.session.id !== call.sessionId || caller.session.role !== 'main'
          || !this.lifecycle.canDrive(call.hostSessionId)
          || current?.project.id !== call.projectId || current.session.id !== target.sessionId || current.session.role !== 'execution') {
          throw new Error('停止调用的真实主会话、执行目标或生命周期已变化。')
        }
        this.assertTargetAdmitting(call.hostSessionId)
        this.assertTargetAdmitting(target.hostSessionId)
      },
    }))
  }

  /** Recover caller identity, Project membership, and only sources consumed in this active turn. */
  private async toolContext(exec: ToolRunContext, toolName: string): Promise<ProjectToolContext> {
    const agent = exec.agent
    if (agent === undefined
      || this.ctx.agents.get(agent.id) !== agent
      || agent.status !== 'running'
      || this.ctx.agents.currentInitiator() !== agent) {
      throw projectToolError(`${toolName} requires the exact live Project Agent in its active turn`, 'PROJECT_TOOL_DRIVER_REQUIRED')
    }
    const membership = this.membershipsByHostSessionId.get(agent.id)
    if (membership === undefined || (membership.session.role !== 'main' && membership.session.role !== 'execution')) {
      throw projectToolError(`${toolName} is available only in a Project session`, 'PROJECT_TOOL_SESSION_REQUIRED')
    }
    const boundary = this.ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')
    if (boundary === undefined || boundary.openTurnStartSeq === null) {
      throw projectToolError(`${toolName} requires an open Project turn`, 'PROJECT_TOOL_TURN_REQUIRED')
    }
    const snapshot = await this.snapshot(membership.project.id)
    const sources: SourceRef[] = []
    const inputs = this.invocationInputs(agent, snapshot)
    for (const input of inputs) sources.push(input.source, ...input.provenance)
    const scope = await this.core.forTool(exec, toolName)
    sources.push(...scope.invocationSources.filter(source => source.kind === 'native-event' && source.toolCallId === String(exec.callId)))
    return {
      agent,
      membership: { ...membership, session: { ...membership.session, role: membership.session.role } },
      snapshot,
      sources: uniqueSourceRefs(sources),
      inputs,
    }
  }

  /** 当前输入与转达来源是可核对的数据，不把 Agent 转述升级成用户决定。 */
  private invocationInputs(
    agent: Agent,
    snapshot: ProjectSnapshot | undefined,
    claimed: readonly ProjectInvocationInput[] = [],
  ): ProjectInvocationInput[] {
    const boundary = this.ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')
    if (snapshot === undefined || boundary?.openTurnStartSeq === null || boundary?.openTurnStartSeq === undefined) return []
    const recorded = agent.session.snapshotEvents(SessionLogOffset(boundary.openTurnStartSeq + 1)).flatMap<ProjectInvocationInput>(event => {
      if (event.type !== 'user/message') return []
      const input = this.invocationInput(agent, event.data, snapshot)
      return input === undefined ? [] : [input]
    })
    return [...new Map([...recorded, ...claimed].map(input => [input.source.messageId, input])).values()]
  }

  private invocationInput(agent: Agent, message: UserMessage, snapshot: ProjectSnapshot): ProjectInvocationInput | undefined {
    const source = message.source
    const messageRef = { kind: 'message' as const, hostSessionId: String(agent.id), messageId: String(message.id) }
    const raw = source as unknown as { kind: string; goalId?: string; revision?: number; round?: number }
    if (raw.kind === 'goal') {
      if (typeof raw.goalId !== 'string' || typeof raw.revision !== 'number' || typeof raw.round !== 'number') return undefined
      return { producer: 'goal', source: messageRef, goalId: raw.goalId, revision: raw.revision, round: raw.round, provenance: [] }
    }
    if (source.kind === 'project-execution-failure') {
      if (source.projectId !== snapshot.project.id) return undefined
      return { producer: source.kind, source: messageRef, run: source.run, failedAt: source.failedAt, reason: source.reason,
        inputs: source.inputs, provenance: uniqueSourceRefs(source.inputs.map(input => input.source)) }
    }
    if (source.kind !== 'user' && source.kind !== 'project-delivery' && source.kind !== 'project-schedule') return undefined
    if (source.kind === 'user') {
      const timing = userInputTiming(this.ctx.sessionProjections.stateOf(agent.session, 'projects/user-input-timing'), String(message.id))
      return { producer: 'user', source: messageRef, provenance: [], ...(timing === undefined ? {} : { timing }) }
    }
    if (source.kind === 'project-schedule') {
      const target = snapshot.sessions.find(item => item.id === source.sessionId && carrierSessions(item).some(carrier => carrier.hostSessionId === String(agent.id))
        && (item.role === 'main' || item.role === 'execution'))
      if (target === undefined || source.projectId !== snapshot.project.id) return undefined
      return { producer: 'project-schedule', source: messageRef, scheduleId: source.scheduleId, occurrenceId: source.occurrenceId,
        provenance: (source.trigger === 'manual' ? source.requestedBy.sources : source.managementSources ?? [])
          .flatMap<NativeProjectSource>(ref => ref.kind === 'message' || ref.kind === 'tool' || ref.kind === 'native-event' ? [ref] : []) }
    }
    if ('communicationFormat' in source) {
      if (source.communicationFormat !== 'projects-communication/v1') return undefined
      let saved: CommunicationSnapshotV1
      try { saved = snapshotCodec.decode(source.snapshot as unknown as JsonValue) } catch { return undefined }
      const target = snapshot.sessions.find(item => carrierSessions(item).some(carrier => carrier.hostSessionId === String(agent.id)))
      if (saved.projectId !== snapshot.project.id || source.projectId !== saved.projectId
        || source.deliveryId !== saved.deliveryId || source.operationRef !== saved.operationRef
        || source.senderSessionId !== saved.sender.sessionId || source.senderHostSessionId !== saved.sender.hostSessionId
        || source.targetSessionId !== saved.recipient.sessionId || source.targetHostSessionId !== saved.recipient.hostSessionId
        || saved.recipient.hostSessionId !== String(agent.id) || saved.recipient.sessionId !== target?.id) return undefined
      return { producer: 'project-delivery', source: messageRef, deliveryId: saved.deliveryId,
        provenance: uniqueSourceRefs([...saved.userMessageParts, ...saved.contextParts].map(part => part.origin)) }
    }
    const delivery = snapshot.deliveries.find(item => item.id === source.deliveryId
      && item.senderSessionId === source.senderSessionId && item.targetSessionId === source.targetSessionId
      && source.projectId === snapshot.project.id
      && (item.nativeMessageId === undefined || item.nativeMessageId === message.id))
    return { producer: 'project-delivery', source: messageRef,
      deliveryId: source.deliveryId, provenance: delivery?.sources ?? [] }
  }

  /** 核对同项目归属后读取原始日志；定位不必已登记在项目记录里。 */
  private async readSourceForProject(
    snapshot: ProjectSnapshot,
    source: NativeProjectSource,
    signal?: AbortSignal,
  ): Promise<ProjectNativeSourceRead> {
    return nativeSourceRead(await readRetainedProjectSource(this.ctx, snapshot.project.id, source,
      id => this.core.readSessionSource(id, snapshot.project.id), {signal,assertAdmitting:id => this.assertTargetAdmitting(id)}))
  }

  private requireRole(current: ProjectToolContext, role: ProjectSession['role'], toolName: string): void {
    if (current.membership.session.role === role) return
    throw projectToolError(`${toolName} is available only to the Project ${role} session`, 'PROJECT_TOOL_ROLE_REQUIRED')
  }

  /** 系统原消息沿普通队列保存；只有运输事实，不生成Agent汇报或补发台账。 */
  private deliverExecutionFailure(source: ProjectExecutionFailureMessageSource, message: UserMessage): Promise<ExecutionFailureDeliveryResult> {
    return this.acceptProjectOperation(source.projectId, async () => {
      try {
        const snapshot = await this.snapshot(source.projectId)
        const main = snapshot.sessions.find(session => session.role === 'main')
        if (main === undefined) return { insertion: 'not-inserted', wakeup: false, persistence: 'not-started', error: '本项目主会话已不可用；没有重建。' }
        return await this.withTargetOperation(main.hostSessionId, async () => {
          const resolved = await this.composition.ports.control.resolve(SessionId(main.hostSessionId))
          if ('error' in resolved) return { insertion: 'not-inserted', wakeup: false, persistence: 'not-started', error: resolved.error.message }
          this.assertTargetAdmitting(main.hostSessionId)
          const current = this.membershipsByHostSessionId.get(main.hostSessionId)
          if (this.disposed || current?.project.id !== source.projectId || current.session.id !== main.id || current.session.role !== 'main') {
            return { insertion: 'not-inserted', wakeup: false, persistence: 'not-started', error: '原主会话已失效；没有重建。' }
          }
          const wakeup = this.lifecycle.canDrive(main.hostSessionId)
          try { resolved.agent.send(message, 'next-turn', wakeup) }
          catch (error) { return { insertion: 'unknown', wakeup: 'unknown', persistence: 'not-started', error: errorMessage(error) } }
          try {
            const flushed = await this.ctx.sessions.flush(resolved.agent.session)
            return { insertion: 'inserted', wakeup, persistence: flushed ? 'flushed' : 'unavailable' }
          } catch (error) { return { insertion: 'inserted', wakeup, persistence: 'failed', error: errorMessage(error) } }
        })
      } catch (error) { return { insertion: 'not-inserted', wakeup: false, persistence: 'not-started', error: errorMessage(error) } }
    })
  }

  private async initializeInner(): Promise<void> {
    await this.store.init()
    this.assertInitializing()
    const retained = await this.store.listRetainedSnapshots()
    this.assertInitializing()
    // Complete the exact retained identity index before native model/recovery
    // operations can materialize a Project Agent or consult Goal eligibility.
    for (const snapshot of retained) this.replaceProjectMembership(snapshot)
    const incomingModel = this.ctx.agentDefaultModel.currentSelection()
    this.modelInitializationErrors = await initializeExistingProjectModelSelections(this.ctx, retained.flatMap(snapshot => snapshot.sessions
      .filter(session => session.sourceLifecycle.kind === 'available'
        && (session.role === 'main' || session.role === 'execution'))
      .map(session => SessionId(session.hostSessionId))), incomingModel)
    this.assertInitializing()
    for (const [id, error] of this.modelInitializationErrors) {
      this.ctx.logger.warn(`projects: model initialization failed for ${id}`, error)
    }
    // Reopen follows the durable relation. Unpublished roots are only retired, never created or driven.
    for (const snapshot of retained) for (const session of snapshot.sessions) {
      let revision = session.revision
      for (const preparation of session.mainPreparations ?? []) {
        if (preparation.state === 'committed' || preparation.retirement === 'confirmed' || preparation.sourceLifecycle !== undefined) continue
        const result = await this.composition.ports.control.retire(SessionId(preparation.toHostSessionId))
        const settled = await this.store.abandonMainPreparation({ projectId: snapshot.project.id, sessionId: session.id,
          attemptId: preparation.attemptId, expectedRevision: revision, retirementConfirmed: result.status === 'stopped' })
        if (settled.kind !== 'updated') throw new Error('Recovery preparation revision conflicted before admission.')
        revision = settled.session.revision
        this.replaceProjectMembership(await this.store.getSnapshot(snapshot.project.id))
        if (result.status !== 'stopped') this.ctx.logger.warn('projects: unpublished main preparation retirement is unconfirmed', preparation.toHostSessionId)
      }
    }
    await this.lifecycle.initializeSources([...this.snapshotsByProjectId.values()])
    this.assertInitializing()
    const memberships = await this.store.listOperationalMemberships()
    this.assertInitializing()
    this.replaceAllMemberships(memberships)
    // 旧空live来源不抢writer；同一失败事实也必须阻止原实例继续驱动。
    for (const id of this.modelInitializationErrors.keys()) {
      const live = this.ctx.agents.get(id)
      const membership = this.membershipsByHostSessionId.get(id)
      if (live !== undefined && membership !== undefined) await this.installProjectAgentScope(live, membership)
    }

    const unsubscribeSource = this.store.addSourceDispositionListener(snapshot => {
      this.replaceProjectMembership(snapshot)
    })
    const unsubscribeDisplay = this.store.subscribe(snapshot => { this.features.notifyUsage(snapshot.project.id) })
    this.unsubscribeStore = () => { unsubscribeSource(); unsubscribeDisplay() }
    try {
      this.disposeCatalogMembership = this.composition.ports.control.registerSourceDisposition({
        getSnapshot: () => this.sourceDisposition,
        subscribe: listener => {
          this.catalogListeners.add(listener)
          return () => { this.catalogListeners.delete(listener) }
        },
      })
    } catch (error: unknown) {
      this.disposeCatalogMembership?.()
      this.disposeCatalogMembership = undefined
      this.unsubscribeStore()
      this.unsubscribeStore = undefined
      throw error
    }

    // Native Session Controller may lazily resume an exact Project Session on
    // Client retain. This serial lifecycle seam runs before queued input, so
    // the same Project role context is present without waking anything here.
    this.disposeProjectSessionCreated = this.ctx.on('session/created', session => this.lifecycle.captureSession(session))
    this.disposeProjectAgentCreated = this.ctx.on('agent/created', async ({ agent }) => {
      const membership = this.membershipsByHostSessionId.get(agent.id)
      if (membership === undefined) return
      await this.installProjectAgentScope(agent, membership)
    })
    this.assertInitializing()
    this.scheduleRuntime.markHostReady()
    if (this.options.schedule !== undefined) await this.scheduleRuntime.connectControlled(this.options.schedule)
    else if (this.options.automaticPower !== undefined) {
      this.automaticConnection = this.connectAutomaticSchedule()
      await this.automaticConnection
    }
    this.assertInitializing()
  }

  private async connectAutomaticSchedule(): Promise<void> {
    let facts: SchedulePowerFacts | undefined
    try {
      if (this.disposed) return
      facts = this.options.automaticPower!(() => {
        void this.scheduleRuntime.hint().catch(error => this.ctx.logger.warn(`projects: schedule observation failed: ${errorMessage(error)}`))
      })
      if (this.disposed) { facts.dispose(); return }
      await this.scheduleRuntime.connectHost({ powerFacts: facts })
    } catch (error) {
      facts?.dispose()
      if (!this.disposed) this.ctx.logger.warn(`projects: automatic schedule connection failed: ${errorMessage(error)}`)
    }
  }

  private assertInitializing(): void { if (this.disposed) throw new ProjectsClosingError() }
  /** Install static identity plus a synchronous view over committed Project records. */
  private async installProjectAgentScope(agent: Agent, membership: ProjectMembership, prepared = false): Promise<void> {
    if (this.installedScopes.has(agent)) return
    this.installedScopes.add(agent)
    this.installedScopeModes.set(agent, prepared ? 'prepared' : 'current')
    const disposers: Array<() => unknown> = []
    if (membership.session.role === 'main') disposers.push(installMainDelegationPolicy(agent))
    const recording = this.options.originalRecording ?? { streamCheckpointBytes: 4096, streamCheckpointIntervalMs: 1000 }
    if (!Number.isSafeInteger(recording.streamCheckpointBytes) || recording.streamCheckpointBytes < 1
      || !Number.isSafeInteger(recording.streamCheckpointIntervalMs) || recording.streamCheckpointIntervalMs < 1) {
      this.installedScopes.delete(agent)
      throw new Error('Projects original recording policy must contain positive integer limits.')
    }
    this.composition.ports.recording.install(agent, recording)
    this.lifecycle.install(agent, prepared)
    if (prepared) agent.ctx.tools.guard(() => this.installedScopeModes.get(agent) === 'prepared' ? 'Prepared main has no business execution authority.' : undefined)
    // 未固定模型的来源只保留原停止责任，不安装工作能力或触发说明初始化。
    if (this.modelInitializationErrors.has(agent.id)) return
    if (!prepared) await this.confirmCarrierHeader(agent, membership)
    // 用量属于每个真实Projects会话；Bot结算只通知视图，不触发工作活动或清理工作输入。
    const disposeUsage = agent.ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      if (event.type === 'turn/end' || event.type === 'compaction/summary' || event.type === 'compaction/end' || event.type === 'projects/model-request-usage' || event.type === 'session/title-llm-request') {
        this.features.notifyUsage(membership.project.id)
      }
    })
    disposers.push(disposeUsage)
    if (membership.session.role === 'session-manager') {
      agent.ctx.on('agent/request', async (_payload, next) => {
        const { reasoningEffort: _effort, maxTokens: _limit, ...config } = await next()
        const route = this.options.sessionManagerModel
        if (!route?.provider || !route.model) throw new Error('会话管理Bot route尚未明确配置。')
        return { ...config, ...route, provider: route.provider, model: route.model }
      })
      agent.ctx.effect(() => this.sessionManager.install(agent, membership), 'projects.session-manager')
      return
    }
    if (membership.session.role === 'memory') {
      // 内部生命周期可能冷恢复root；实际调用仍固定为显式Bot route，而非工作默认选择。
      agent.ctx.on('agent/request', async (_payload, next) => {
        const { reasoningEffort: _oldEffort, maxTokens: _oldLimit, ...config } = await next()
        const route = this.options.memoryModel
        if (!route?.provider || !route.model) throw new Error('共享记忆后台模型route尚未明确配置。')
        return { ...config, provider: route.provider, model: route.model,
          ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
          ...(route.maxTokens === undefined ? {} : { maxTokens: route.maxTokens }) }
      })
      try { agent.ctx.effect(() => this.memoryRuntime.installBot(agent, membership), 'projects.memory-bot') }
      catch (error) { disposeUsage(); this.installedScopes.delete(agent); throw error }
      return
    }
    try {
      const workRole = membership.session.role
      // Initialize native replay once at installation, not while constructing each request's finite source window.
      this.ctx.sessionProjections.stateOf(agent.session, 'projects/user-input-timing')
      let deferredInstructionInitialization = this.lifecycle.isCloseOnly(String(agent.id))
      // 冷关闭只安装停止责任；恢复后复用此scope时，初始化延到首次真实请求。
      if (!prepared && !deferredInstructionInitialization) {
        await this.features.settings.initializeExistingSessionInstructions(
          { projectId: membership.project.id, sessionId: membership.session.id },
          initialSessionInstructions(workRole),
        )
      }
      // 只投影这个窗口里的来源定位；正文仍由原生 inbox/session 唯一持有。
      const claimedInputs = new Map<string, ProjectInvocationInput>()
      disposers.push(onProjectInboxClaimed(agent, ({ message }) => {
        const snapshot = this.snapshotsByProjectId.get(membership.project.id)
        if (snapshot === undefined) return
        const input = this.invocationInput(agent, message, snapshot)
        if (input !== undefined) claimedInputs.set(String(message.id), input)
      }))
      // Correlate a failed body's final outcome with its later committed root result.
      // Preparation failures have no body entry; Tools observers run before Session append.
      const startedToolCalls = new Set<number>(), completedErrorCalls = new Set<number>(), stoppedTurns = new Set<number>()
      const clearToolActivity = (): void => { startedToolCalls.clear(); completedErrorCalls.clear(); stoppedTurns.clear() }
      disposers.push(agent.ctx.effect(() => clearToolActivity, 'projects.memory-tool-activity'))
      disposers.push(agent.ctx.on('tools/result', (exec, result) => {
        const source = this.composition.ports.invocations.get(exec)
        if (!result.isError || exec.agent !== agent || exec.parent !== undefined || source === undefined
          || source.sessionId !== agent.id || source.sessionCreatedAt !== agent.session.header.createdAt
          || source.callId !== exec.callId || !startedToolCalls.has(source.startEventSeq)
          || exec.signal.aborted || result.error.info?.code === TOOL_ABORTED || result.error.info?.code === TOOL_ABORTED_BEFORE_DISPATCH) return
        completedErrorCalls.add(source.startEventSeq)
      }))
      disposers.push(agent.ctx.on('session/event', (session, event) => {
        if (session !== agent.session) return
        if (event.type === 'user/message') claimedInputs.delete(String(event.data.id))
        if (event.type === 'turn/end') { claimedInputs.clear(); clearToolActivity() }
        if (event.type === 'projects/tool-execution-start') startedToolCalls.add(event.data.startEventSeq)
        if (event.type === 'projects/agent-stop-request' && event.data.state.kind === 'running') stoppedTurns.add(event.data.state.turn)
        if (event.type === 'turn/start') this.memoryRuntime.activity(membership.project.id, { kind: 'work-start' })
        if (event.type === 'assistant/message' && event.surfaceOp === 'append') this.memoryRuntime.activity(membership.project.id, { kind: 'visible-progress' })
        // 模型专用replacement没有再次执行工具，不能触发刚失败批次重试。
        if (event.type === 'tool/result' && isAppendSurfaceEvent(event)) {
          let completedError = false
          for (const seq of event.sourceEventSeqs ?? []) {
            completedError = completedErrorCalls.delete(seq) || completedError
            startedToolCalls.delete(seq)
          }
          if (event.data.message.isError !== true || (completedError && !stoppedTurns.has(event.data.turn)
            && event.data.error?.code !== TOOL_ABORTED && event.data.error?.code !== TOOL_ABORTED_BEFORE_DISPATCH)) {
            this.memoryRuntime.activity(membership.project.id, { kind: 'tool-completed' })
          }
        }
        if (event.type === 'turn/end' && event.data.reason.kind === 'completed') this.memoryRuntime.activity(membership.project.id, { kind: 'natural-end' })
      }))
      disposers.push(installProjectRolePrompt(agent.ctx, membership.project, membership.session))
      const request = { projectId: membership.project.id, sessionId: membership.session.id }
      const overview = this.features.overview({ kind: 'session', sessionId: membership.session.id, role: membership.session.role })
      disposers.push(installProjectRequestContext(agent, membership, {
        memory: this.memory, projectFilesRoot: join(this.dataRoot, membership.project.id, 'artifacts'),
        readSnapshot: () => this.store.getSnapshot(membership.project.id),
        readOverview: () => overview.readContext(request),
        prepareSessionInstructions: async signal => {
          if (deferredInstructionInitialization) {
            await this.features.settings.initializeExistingSessionInstructions({ ...request, signal }, initialSessionInstructions(workRole))
            deferredInstructionInitialization = false
          }
          return this.features.settings.prepareSessionInstructions({ ...request, signal })
        },
        prepareProjectInstructions: signal => this.features.settings.prepareProjectInstructions({ projectId: membership.project.id, signal }),
        invocationInputs: snapshot => this.invocationInputs(agent, snapshot, [...claimedInputs.values()]),
        communication: { readSnapshot: (projectId, record, signal) => this.communicationTranscript.readSnapshot(projectId, record, signal) },
        ...(membership.session.role === 'main' ? { mainHistory: (history, capacity, signal) => this.continuityHistory.fitImported(history, capacity, signal) } : {}),
      }))
      disposers.push(installOverviewTools(agent, {
        resolveCall: async exec => {
          const scope = await this.core.forTool(exec, 'project_overview')
          if (scope.role !== 'main' && scope.role !== 'execution') throw new Error('后台记忆不维护整体看板。')
          return { service: this.features.overview({ kind: 'session', sessionId: scope.session.id, hostSessionId: scope.hostSessionId, role: scope.role }),
            request: { projectId: scope.project.id } }
        },
      }, workRole))
      disposers.push(installProjectTools(agent, this, workRole))
      disposers.push(installProjectWorkTools(agent, {
        run: (exec, toolName, action) => this.acceptProjectOperation(membership.project.id, async () => {
          const scope = await this.core.forTool(exec, toolName)
          if (scope.project.id !== membership.project.id) throw new Error('工作工具项目归属已变化。')
          return action(scope)
        }),
        updateName: (projectId, name, expectedRevision) => this.store.updateProject(projectId, { name }, { expectedRevision }),
        queryUsage: query => this.features.usage.query(query),
      }, workRole))
      disposers.push(installProjectControlTools(agent, this, workRole))
      disposers.push(installInstructionTools(agent, {
        service: this.features.settings,
        resolveRequest: async exec => {
          const scope = await this.core.forTool(exec, 'project_instructions')
          if (scope.role !== 'main' && scope.role !== 'execution') throw new Error('后台记忆不读取或修改工作会话指令。')
          return { projectId: scope.project.id, sessionId: scope.session.id, hostSessionId: scope.hostSessionId, role: scope.role }
        },
      }))
      disposers.push(installScheduleTools(agent, {
        resolveCall: async exec => {
          const scope = await this.core.forTool(exec, 'project_schedule')
          if (scope.role !== 'main' && scope.role !== 'execution') throw new Error('后台记忆不管理或运行定时任务。')
          return { service: this.features.schedule, request: this.features.scheduleToolRequest(scope.project.id, exec) }
        },
      }))
      disposers.push(installLibraryTools(agent, {
        service: this.library,
        resolveRequest: async exec => {
          const scope = await this.core.forTool(exec, 'project_library')
          return { projectId: scope.project.id, sessionId: scope.session.id, hostSessionId: scope.hostSessionId }
        },
        sourceForCall: async exec => {
          const scope = await this.core.forTool(exec, 'project_library')
          const source = scope.invocationSources.find(source => source.kind === 'native-event' && source.toolCallId === String(exec.callId))
          if (source?.kind !== 'native-event') throw new Error('资料引用缺少本次真实工具事件来源。')
          return source
        },
      }))
      disposers.push(installMemoryTools(agent, {
        service: this.memory,
        requests: this.memoryRuntime.requests,
        resolveRequest: async exec => {
          const scope = await this.core.forTool(exec, 'project_memory')
          return { projectId: scope.project.id, actor: { kind: 'session', hostSessionId: scope.hostSessionId } }
        },
      }))
      const failureNotice = installExecutionFailureNotices(agent, {
        projectId: membership.project.id, sessionId: membership.session.id, hostSessionId: String(agent.id), role: membership.session.role,
      }, {
        canNotify: () => !this.disposed,
        deliver: (source, message) => this.deliverExecutionFailure(source, message),
        observed: observation => {
          const result = JSON.stringify({ projectId: observation.source.projectId, sessionId: observation.source.sessionId,
            run: observation.source.run, messageId: observation.messageId, delivery: observation.delivery })
          if (observation.delivery.insertion !== 'inserted' || observation.delivery.persistence !== 'flushed') {
            this.ctx.logger.warn(`projects: system failure notice delivery unconfirmed: ${result}`)
          } else this.ctx.logger.info(`projects: system failure notice transport: ${result}`)
        },
      })
      disposers.push(failureNotice.dispose)
      agent.ctx.effect(() => failureNotice.dispose, 'projects.execution-failure-notice')
      // 原factory maintenance包围本回调；在首次claim前协调，不能等到模型步骤。
      if (hasSchedulePending(agent) && !this.lifecycle.isCloseOnly(String(agent.id))) {
        try {
          await this.withTargetOperation(String(agent.id), async () => {
            const scope = { projectId: membership.project.id, sessionId: membership.session.id, hostSessionId: String(agent.id) }
            const target: ScheduleRuntimeTarget = { ...scope, id: membership.session.id, projectDirectory: join(this.dataRoot, membership.project.id),
              role: membership.session.role === 'main' ? 'main' : 'execution', title: membership.session.title, archived: membership.session.archived }
            const effect = await new ProjectScheduleStore(scope.projectId, target.projectDirectory).readWith(state => {
              const current = this.currentScheduleTarget(target)
              if (this.disposed || current.projectArchived || current.sessionArchived) throw new Error('原目标已停止接纳工作。')
              return coordinateSchedulePending(agent, scope, state)
            })
            if (effect.kind === 'unconfirmed' || effect.kind === 'not-connected') throw new Error(effect.error ?? '待执行修改未确认。')
            if (!await this.ctx.sessions.flush(agent.session)) throw new Error('待执行修改保存未确认。')
          })
        } catch (error) {
          if (this.disposed || !this.lifecycle.canDrive(String(agent.id))) throw error
          throw new PendingInputCoordinationError('定时待执行修改未确认；原输入保留，当前目标未启动。', { cause: error })
        }
      }
    } catch (error: unknown) {
      this.installedScopes.delete(agent)
      for (const dispose of disposers.toReversed()) dispose()
      throw error
    }
  }

  /** Preparation uses its real Store ownership; lifecycle and header confirmation are explicit modes. */
  private async installPreparedMainScope(agent: Agent, ownership: Extract<ProjectHostOwnership, { kind: 'preparation' }>): Promise<void> {
    if (ownership.preparation.toHeader?.id !== agent.id || ownership.preparation.toHeader.createdAt !== agent.session.header.createdAt
      || ownership.session.role !== 'main') throw new Error('Prepared scope requires its exact confirmed native creation.')
    this.withheldMainHosts.add(String(agent.id))
    const scope = { project: ownership.project, session: { ...ownership.session, hostSessionId: String(agent.id) } }
    await this.installProjectAgentScope(agent, scope, true)
  }

  /** Publication is the authority; installed preparation must explicitly transition to current. */
  private async activatePublishedMainScope(agent: Agent): Promise<void> {
    const owner = await this.store.resolveHostOwnership(String(agent.id))
    if (owner?.kind !== 'current' || owner.carrier.header?.createdAt !== agent.session.header.createdAt) throw new Error('Published current creation identity is unavailable.')
    if (this.installedScopeModes.get(agent) !== 'prepared' && this.installedScopeModes.get(agent) !== 'current') throw new Error('Published main scope was not installed.')
    try {
      this.replaceProjectMembership(await this.store.getSnapshot(owner.project.id))
      this.installedScopeModes.set(agent, 'current')
      this.withheldMainHosts.delete(String(agent.id))
      this.publishCatalogSnapshot()
    } catch (error) {
      this.withheldMainHosts.add(String(agent.id))
      this.installedScopeModes.set(agent, 'prepared')
      try { this.publishCatalogSnapshot() } catch (publicationError) { this.ctx.logger.warn('projects: published main remains unavailable after activation failure', publicationError) }
      throw error
    }
  }

  private async confirmCarrierHeader(agent: Agent, membership: ProjectMembership): Promise<void> {
    const binding = await this.store.findCarrierByHostSessionId(String(agent.id))
    if (binding === undefined || binding.project.id !== membership.project.id || binding.session.id !== membership.session.id) {
      throw new Error('Projects recording requires the exact durable carrier binding.')
    }
    if (binding.carrier.header !== undefined) {
      if (binding.carrier.header.id !== agent.session.header.id || binding.carrier.header.createdAt !== agent.session.header.createdAt) {
        throw new Error('Projects carrier creation identity changed.')
      }
      return
    }
    // Archive/restore owns its captured revision and persists this exact header in its all-carrier proof.
    // Cold setup during that finite cut must not insert a competing relation revision.
    if (this.lifecycle.isCloseOnly(String(agent.id))) return
    await this.store.confirmSessionCarrierHeader({ projectId: membership.project.id, sessionId: membership.session.id,
      expectedRevision: binding.session.revision, hostSessionId: String(agent.id), header: agent.session.header })
  }

  private replaceAllMemberships(memberships: readonly ProjectMembership[]): void {
    this.membershipsByHostSessionId.clear()
    for (const snapshot of this.snapshotsByProjectId.values()) this.cacheCarrierMemberships(snapshot)
    for (const membership of memberships) if (!this.membershipsByHostSessionId.has(membership.session.hostSessionId)) {
      this.membershipsByHostSessionId.set(membership.session.hostSessionId, membership)
    }
    this.publishCatalogSnapshot()
  }

  private replaceProjectMembership(snapshot: ProjectRecordSnapshot): void {
    this.snapshotsByProjectId.set(snapshot.project.id, snapshot)
    for (const [hostSessionId, membership] of this.membershipsByHostSessionId) {
      if (membership.project.id === snapshot.project.id) this.membershipsByHostSessionId.delete(hostSessionId)
    }
    this.cacheCarrierMemberships(snapshot)
    this.publishCatalogSnapshot()
  }

  private cacheCarrierMemberships(snapshot: ProjectRecordSnapshot): void {
    for (const [host, ownership] of this.ownershipByHost) if (ownership.project.id === snapshot.project.id) this.ownershipByHost.delete(host)
    for (const session of snapshot.sessions) {
      for (const carrier of session.carriers ?? []) this.ownershipByHost.set(carrier.hostSessionId, { kind: carrier.isCurrent ? 'current' : 'historical', project: snapshot.project, session, carrier })
      for (const preparation of session.mainPreparations ?? []) if (preparation.state !== 'committed') {
        this.ownershipByHost.set(preparation.toHostSessionId, { kind: 'preparation', project: snapshot.project, session, preparation })
      }
    }
    for (const session of snapshot.sessions) for (const carrier of session.carriers ?? [{ hostSessionId: session.hostSessionId, sourceLifecycle: session.sourceLifecycle, ownedLifecycle: session.ownedLifecycle }]) {
      if (carrier.sourceLifecycle.kind !== 'available') continue
      this.membershipsByHostSessionId.set(carrier.hostSessionId, { project: snapshot.project,
        session: { ...session, archived: session.archived || hasPendingSourceDeletion(session) || ('closed' in carrier && carrier.closed !== undefined), hostSessionId: carrier.hostSessionId, sourceLifecycle: carrier.sourceLifecycle, ownedLifecycle: carrier.ownedLifecycle } })
    }
  }

  /** Drop only local cache/catalog state after Store proved a just-created Project is empty and removed. */
  private forgetProject(projectId: string): void {
    this.snapshotsByProjectId.delete(projectId)
    for (const [hostSessionId, membership] of this.membershipsByHostSessionId) {
      if (membership.project.id === projectId) this.membershipsByHostSessionId.delete(hostSessionId)
    }
    for (const [host, ownership] of this.ownershipByHost) {
      if (ownership.project.id === projectId) this.ownershipByHost.delete(host)
    }
    this.publishCatalogSnapshot()
  }

  /** Replace the immutable source snapshot before notifying Session Controller subscribers. */
  private publishCatalogSnapshot(): void {
    const claimed = new Set<SessionId>()
    const unavailable = new Map<SessionId,{readonly sourceRevision:number}>()
    const userAddressable = new Set<SessionId>()
    const nativeScheduleExcluded = new Set<SessionId>()
    const execution = new Map<SessionId, import('./stock/project-ports.ts').ProjectSourceExecutionDisposition>()
    for (const snapshot of this.snapshotsByProjectId.values()) {
      for (const logical of snapshot.sessions) for (const preparation of logical.mainPreparations ?? []) {
        if (preparation.state === 'committed') continue
        const id = SessionId(preparation.toHostSessionId)
        claimed.add(id); nativeScheduleExcluded.add(id)
        if (preparation.sourceLifecycle !== undefined) unavailable.set(id, { sourceRevision: logical.revision })
        execution.set(id, { state: 'readonly', rootSessionId: id })
        if (preparation.sourceLifecycle !== undefined && preparation.sourceLifecycle.kind !== 'available') {
          for (const member of preparation.sourceLifecycle.ownedDeletion?.members ?? []) {
            const child = SessionId(member.header.id)
            claimed.add(child); nativeScheduleExcluded.add(child); unavailable.set(child, { sourceRevision: logical.revision })
            execution.set(child, { state: 'readonly', rootSessionId: id })
          }
        }
      }
      for (const logical of snapshot.sessions) for (const session of carrierSessions(logical)) {
        const id = SessionId(session.hostSessionId)
        claimed.add(id)
        nativeScheduleExcluded.add(id)
        if (session.role === 'main' || session.role === 'execution') userAddressable.add(id)
        if (session.sourceLifecycle.kind !== 'available' || hasPendingSourceDeletion(logical)) unavailable.set(id,{sourceRevision:session.revision})
        if (session.sourceLifecycle.kind === 'available' && !hasPendingSourceDeletion(logical)) {
          for (const [targetId, disposition] of this.lifecycle.sourceEntries(session, snapshot.project.archived)) {
            execution.set(targetId, disposition)
            claimed.add(targetId)
            if (session.role === 'main' || session.role === 'execution') userAddressable.add(targetId)
          }
        }
        // The root Store owns the finite native roster even after a member log is gone.
        if (session.sourceLifecycle.kind !== 'available' || hasPendingSourceDeletion(logical)) {
          for (const member of session.sourceLifecycle.kind === 'available' ? session.ownedLifecycle?.members ?? [] : session.sourceLifecycle.ownedDeletion?.members ?? []) {
            const childId = SessionId(member.header.id)
            claimed.add(childId)
            if(session.role==='main'||session.role==='execution')userAddressable.add(childId)
            unavailable.set(childId, {sourceRevision:session.revision})
          }
        }
      }
    }
    this.catalogSnapshot = claimed
    this.sourceDisposition = {generation:this.sourceDisposition.generation+1,claimed,unavailable,userAddressable,nativeScheduleExcluded,execution}
    this.composition.ports.read.publishDisposition(this.sourceDisposition)
    for (const listener of [...this.catalogListeners]) listener()
  }

  private assertTargetAdmitting(hostSessionId: string): void {
    const projectId=this.membershipsByHostSessionId.get(hostSessionId)?.project.id??[...this.snapshotsByProjectId.values()].find(snapshot=>snapshot.sessions.some(row=>carrierSessions(row).some(carrier=>carrier.hostSessionId===hostSessionId)))?.project.id
    if ((projectId!==undefined&&this.projectDeletionCuts.has(projectId)) || this.targetDeletionCuts.has(hostSessionId) || this.sourceDisposition.unavailable.has(SessionId(hostSessionId))) {
      throw new Error('来源会话正在删除或已不可用，不能打开或投递。')
    }
  }

  /** Prepare the original pending Inbox owner in every real carrier, preserving each accepted identity. */
  private async prepareScheduleConfigurations(target: ScheduleRuntimeTarget): Promise<import('./features/schedule/contract.ts').SchedulePendingConsumer> {
    const carriers = await this.store.listSessionCarriers(target.projectId, target.id)
    const consumers: import('./features/schedule/contract.ts').SchedulePendingConsumer[] = []
    const needsFlush = new Set<import('./features/schedule/contract.ts').SchedulePendingConsumer>()
    try {
      for (const carrier of carriers) {
        if (carrier.sourceLifecycle.kind !== 'available') continue
        consumers.push(await this.prepareScheduleConfigurationTarget({ ...target, hostSessionId: carrier.hostSessionId }))
      }
      if (consumers.length === 0) throw new Error('定时目标没有可读取的原承载。')
      return { assertCurrent: () => { for (const consumer of consumers) consumer.assertCurrent() },
        apply: state => {
          const effects = consumers.map(consumer => { const effect = consumer.apply(state); if (effect.kind !== 'unchanged') needsFlush.add(consumer); return effect })
          const kind = effects.some(effect => effect.kind === 'unconfirmed') ? 'unconfirmed' as const
            : effects.some(effect => effect.kind === 'not-connected') ? 'not-connected' as const
              : effects.some(effect => effect.kind === 'applied') ? 'applied' as const : 'unchanged' as const
          return { kind, updatedMessageIds: effects.flatMap(effect => effect.updatedMessageIds), removedMessageIds: effects.flatMap(effect => effect.removedMessageIds),
            ...(effects.some(effect => effect.error !== undefined) ? { error: effects.flatMap(effect => effect.error === undefined ? [] : [effect.error]).join('；') } : {}) }
        },
        flush: async () => { const results = await Promise.all([...needsFlush].map(consumer => consumer.flush())); return results.every(Boolean) },
        release: () => { for (const consumer of consumers.toReversed()) consumer.release?.() },
      }
    } catch (error) { for (const consumer of consumers.toReversed()) consumer.release?.(); throw error }
  }

  private async prepareScheduleConfigurationTarget(target: ScheduleRuntimeTarget): Promise<import('./features/schedule/contract.ts').SchedulePendingConsumer> {
        const assertCurrent = () => {
          this.assertTargetAdmitting(target.hostSessionId)
          const current = this.membershipsByHostSessionId.get(target.hostSessionId)
          if (this.disposed || current?.project.id !== target.projectId || current.session.id !== target.id
            || (current.session.role !== 'main' && current.session.role !== 'execution')) throw new Error('设置目标归属已变化或已不可用。')
        }
        assertCurrent()
        let agent=this.ctx.agents.get(SessionId(target.hostSessionId))
        let hold:{assertCurrent(header:SessionHeader):void;release():void}|undefined
        if(agent===undefined){
          const current=this.currentScheduleTarget(target)
          const read=await this.core.readNativePrefix(target.projectId,target.hostSessionId)
          if(!read.readable)throw new Error(read.reason)
          const pending=foldScheduleNativeEvents(read.events,target.hostSessionId).some(row=>row.current&&row.pending!==undefined)
          assertCurrent()
          agent=this.ctx.agents.get(SessionId(target.hostSessionId))
          if(agent===undefined&&pending&&!current.projectArchived&&!current.sessionArchived){
            const inspected=await this.composition.ports.control.inspect(SessionId(target.hostSessionId))
            assertCurrent()
            // Existing factory initialization observes the cut before its first possible Inbox claim.
            hold=this.lifecycle.prepareScheduleConfiguration(inspected.meta)
            try{
              const resolved=await this.composition.ports.control.resolveScheduleConfiguration(inspected.meta,hold)
              if('error' in resolved)throw new Error(resolved.error.message)
              agent=resolved.agent
              const membership=this.membershipsByHostSessionId.get(target.hostSessionId)
              if(membership===undefined||membership.project.id!==target.projectId||membership.session.id!==target.id)throw new Error('设置准备目标归属已变化。')
              await this.installProjectAgentScope(agent,membership)
            }catch(error){hold.release();throw error}
          }
          if(agent===undefined){
            let connected:Agent|undefined
            return {assertCurrent,
              apply:state=>{
                assertCurrent();connected=this.ctx.agents.get(SessionId(target.hostSessionId))
                return connected===undefined
                  ? {kind:pending?'not-connected' as const:'unchanged' as const,updatedMessageIds:[],removedMessageIds:[]}
                  : coordinateSchedulePending(connected,{projectId:target.projectId,sessionId:target.id,hostSessionId:target.hostSessionId},state)
              },
              flush:()=>connected===undefined?Promise.resolve(false):this.ctx.sessions.flush(connected.session)}
          }
        }
        const exact=agent
        return {assertCurrent,
          apply:state=>{
            assertCurrent()
            if(this.ctx.agents.get(SessionId(target.hostSessionId))!==exact)throw new Error('原会话待执行owner已变化。')
            return coordinateSchedulePending(exact,{projectId:target.projectId,sessionId:target.id,hostSessionId:target.hostSessionId},state)
          },
          flush:()=>this.ctx.sessions.flush(exact.session),
          ...(hold===undefined?{}:{release:()=>hold.release()}),
        }
  }

  private currentScheduleTarget(target: ScheduleRuntimeTarget): { projectArchived: boolean; sessionArchived: boolean; projectRestoredAt?: string; sessionRestoredAt?: string } {
    this.assertTargetAdmitting(target.hostSessionId)
    const membership = this.membershipsByHostSessionId.get(target.hostSessionId)
    if (membership?.project.id !== target.projectId || membership.session.id !== target.id
      || (membership.session.role !== 'main' && membership.session.role !== 'execution')
      || membership.session.sourceLifecycle.kind !== 'available') throw new Error('当前定时目标不是可用的原工作会话。')
    return { projectArchived: membership.project.archived,
      sessionArchived: membership.session.archived || !this.lifecycle.canDrive(target.hostSessionId),
      ...this.lifecycle.restoredAt(target.projectId, target.hostSessionId) }
  }

  /** Stable main targets acquire their exact host before any preparation await. */
  async withCurrentMainAdmission<T>(projectId: string, sessionId: string, operation: string, run: (lease: MainAdmissionLease) => Promise<T>): Promise<T> {
    const lease = await this.mainAdmission.acceptCurrent(projectId, sessionId, operation)
    try { lease.assertCurrent(); return await run(lease) }
    finally { lease.release() }
  }

  /** Host-only accepted request boundary, shared with the original target-operation owner. */
  acceptOperation<T>(run: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new ProjectsClosingError())
    return this.trackAcceptedOperation(this.runtimeOperationKey, run)
  }

  acceptProjectOperation<T>(projectId:string,run:()=>Promise<T>):Promise<T>{
    if(this.disposed)return Promise.reject(new ProjectsClosingError())
    if(this.projectDeletionCuts.has(projectId)||this.snapshotsByProjectId.get(projectId)?.project.sourceLifecycle!==undefined)return Promise.reject(new Error("项目正在删除或已不可用。"))
    let key=this.projectOperationKeys.get(projectId);if(key===undefined){key=Symbol(projectId);this.projectOperationKeys.set(projectId,key)}
    return this.acceptOperation(()=>this.trackAcceptedOperation(key!,run))
  }
  private prepareProjectDeletion(projectId:string):ProjectTargetDeletionCut & {readonly continuitySettled:Promise<void>} {
    const instructions = this.features.settings.prepareProjectInstructionsDeletion(projectId)
    const cut=this.projectDeletionCuts.get(projectId)??{committed:false};this.projectDeletionCuts.set(projectId,cut)
    const suspended=this.continuity.suspend(projectId)
    const key=this.projectOperationKeys.get(projectId)
    const pending=[...(key===undefined?[]:this.targetOperations.get(key)??[])]
    const accepted=Promise.allSettled(pending).then(results=>{const errors=results.flatMap(row=>row.status==='rejected'&&!(row.reason instanceof ProjectDeletionCreationSettledError)?[row.reason]:[]);if(errors.length)throw new AggregateError(errors,"本项目已接纳保存/创建未确认。")})
    const drained=Promise.allSettled([accepted,instructions.drained,suspended]).then(results=>{const errors=results.flatMap(row=>row.status==='rejected'?[row.reason]:[]);if(errors.length)throw new AggregateError(errors,"本项目指令/已接纳操作/接力结算未确认。")})
    return {drained,continuitySettled:suspended,commit:()=>{instructions.commit();cut.committed=true},release:()=>{
      instructions.release()
      if(!cut.committed&&this.projectDeletionCuts.get(projectId)===cut){
        this.projectDeletionCuts.delete(projectId)
        const project=this.snapshotsByProjectId.get(projectId)?.project
        if(!this.disposed&&project!==undefined&&project.sourceLifecycle===undefined&&!project.archived)this.continuity.resume(projectId)
      }
    }}
  }

  private withTargetOperation<T>(hostSessionId: string, run: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new ProjectsClosingError())
    this.assertTargetAdmitting(hostSessionId)
    return this.trackAcceptedOperation(hostSessionId, run)
  }

  private trackAcceptedOperation<T>(key: string | symbol, run: () => Promise<T>): Promise<T> {
    const pending = this.targetOperations.get(key) ?? new Set<Promise<unknown>>()
    this.targetOperations.set(key, pending)
    const operation = Promise.withResolvers<T>()
    pending.add(operation.promise)
    // 先登记责任，再同步进入原动作，包含首个Store/workspace await之前的写入。
    try { Promise.resolve(run()).then(operation.resolve, operation.reject) } catch (error) { operation.reject(error) }
    void operation.promise.finally(() => {
      pending.delete(operation.promise)
      if (pending.size === 0 && this.targetOperations.get(key) === pending) this.targetOperations.delete(key)
    }).catch(() => {})
    return operation.promise
  }

  private prepareExecutionDeletionTarget(projectId: string, sessionId: string, hostSessionId: string, preparation?: MainCarrierPreparation): ProjectTargetDeletionCut {
    const source = this.snapshotsByProjectId.get(projectId)?.sessions.find(item => item.id === sessionId)
    const reserved = preparation === undefined ? undefined : source?.mainPreparations?.find(item => item.attemptId === preparation.attemptId && item.toHostSessionId === hostSessionId && item.state !== 'committed')
    if (source === undefined || preparation === undefined && !carrierSessions(source).some(carrier => carrier.hostSessionId === hostSessionId)
      || preparation !== undefined && (source.role !== 'main' || reserved === undefined || !sameOwnedCreationHeader(reserved.fromHeader, preparation.fromHeader))) throw new Error('删除来源归属已变化。')
    // 未发布root仍归Store的准确reservation，不借carrier成员资格授予删除权。
    const ownership = preparation === undefined ? Promise.resolve() : this.store.resolveHostOwnership(hostSessionId).then(owner => {
      if (owner?.kind !== 'preparation' || owner.project.id !== projectId || owner.session.id !== sessionId || owner.session.role !== 'main'
        || owner.preparation.attemptId !== preparation.attemptId || owner.preparation.toHostSessionId !== hostSessionId
        || !sameOwnedCreationHeader(owner.preparation.fromHeader, preparation.fromHeader)
        || preparation.toHeader !== undefined && (owner.preparation.toHeader === undefined || !sameOwnedCreationHeader(owner.preparation.toHeader, preparation.toHeader))) throw new Error('删除准备物的原Store身份已变化。')
    })
    const previous = this.targetDeletionCuts.get(hostSessionId)
    const cut = {committed:previous?.committed ?? false}
    this.targetDeletionCuts.set(hostSessionId,cut)
    const drained = Promise.allSettled([ownership, ...(this.targetOperations.get(hostSessionId) ?? [])]).then(results=>{const failures=results.flatMap(row=>row.status==='rejected'?[row.reason]:[]);if(failures.length)throw new AggregateError(failures,'目标身份或已接纳保存未确认。')})
    let settled = false
    return { drained,
      commit:() => { if (settled) throw new Error('删除切点已结算。'); settled=true;cut.committed=true },
      release:() => { if (settled) throw new Error('删除切点已结算。'); settled=true;
        if (!cut.committed && this.targetDeletionCuts.get(hostSessionId) === cut) this.targetDeletionCuts.delete(hostSessionId) },
    }
  }

  publishMemoryNotice(notice: ProjectMemoryNotice): void {
    for (const listener of this.memoryNoticeListeners.get(notice.projectId) ?? []) listener(notice)
  }

  /** 只传订阅后的真实结果；重连不重放旧成功。 */
  async *watchMemoryChanges(projectId: string, signal: AbortSignal): AsyncIterable<ProjectMemoryNotice> {
    await this.requireProject(projectId)
    signal.throwIfAborted()
    const queue: ProjectMemoryNotice[] = []
    let wake: (() => void) | undefined
    const listeners = this.memoryNoticeListeners.get(projectId) ?? new Set<(notice: ProjectMemoryNotice | undefined) => void>()
    this.memoryNoticeListeners.set(projectId, listeners)
    const listener = (notice: ProjectMemoryNotice | undefined) => { if (notice !== undefined) queue.push(notice); wake?.() }
    const abort = () => wake?.()
    listeners.add(listener); signal.addEventListener('abort', abort, { once: true })
    try {
      while (!signal.aborted && !this.disposed) {
        const notice = queue.shift()
        if (notice !== undefined) { yield notice; continue }
        await new Promise<void>(resolve => { wake = resolve }); wake = undefined
      }
    } finally {
      listeners.delete(listener); signal.removeEventListener('abort', abort)
      if (listeners.size === 0) this.memoryNoticeListeners.delete(projectId)
    }
  }

  private ensureSessionManager(projectId: string): Promise<Agent> {
    const key = `session-manager:${projectId}`, previous = this.botCreations.get(key)
    if (previous !== undefined) return previous
    const operation = this.acceptProjectOperation(projectId, () => this.createOrResumeMemoryBot(projectId, 'session-manager'))
    this.botCreations.set(key, operation)
    void operation.finally(() => { if (this.botCreations.get(key) === operation) this.botCreations.delete(key) }).catch(() => {})
    return operation
  }

  private ensureMemoryBot(projectId: string): Promise<Agent> {
    const previous = this.botCreations.get(projectId)
    if (previous !== undefined) return previous
    const operation = this.acceptProjectOperation(projectId,() => this.createOrResumeMemoryBot(projectId))
    this.botCreations.set(projectId, operation)
    void operation.finally(() => { if (this.botCreations.get(projectId) === operation) this.botCreations.delete(projectId) }).catch(() => {})
    return operation
  }

  private async createOrResumeMemoryBot(projectId: string, role: 'memory' | 'session-manager' = 'memory'): Promise<Agent> {
    this.assertReady()
    const route = role === 'memory' ? this.options.memoryModel : this.options.sessionManagerModel
    if (!route?.provider || !route.model) throw new Error('共享记忆后台模型route尚未明确配置，未沿用工作默认模型。')
    if (this.projectDeletionCuts.has(projectId) || !this.lifecycle.canBindProject(projectId)) throw new Error('项目生命周期已关闭后台新接纳。')
    const snapshot = await this.store.getSnapshot(projectId)
    this.assertInitializing()
    if (snapshot.project.archived) throw new Error('项目已归档。')
    let session = snapshot.sessions.find(item => item.role === role)
    if (session !== undefined) {
      const live = this.ctx.agents.get(SessionId(session.hostSessionId))
      if (live !== undefined) { await this.installProjectAgentScope(live, { project: snapshot.project, session }); return live }
    }
    const fresh = session === undefined
    const id = SessionId(session?.hostSessionId ?? `project-${role}-${randomUUID()}`)
    const creation = Promise.withResolvers<void>()
    this.creatingRoots.set(id, creation.promise); void creation.promise.catch(() => {})
    try {
    if (session === undefined) session = await this.store.bindSession(projectId, {
      role, title: role === 'memory' ? '共享记忆后台维护' : '主会话管理后台', hostSessionId: id,
    })
    this.assertInitializing()
    const membership = { project: snapshot.project, session }
    const initialSave = new InitialSessionSave()
    const setup = async (agentCtx: Context, agent: Agent) => { initialSave.install(agentCtx); await this.installProjectAgentScope(agent, membership) }
    const handle = fresh
      ? await this.ctx.agents.create({ sessionId: id, meta: { cwd: (await this.workspaceFor(snapshot.project)).cwd }, agentOptions: route, setup })
      : await this.ctx.agents.resume({ resumeSessionId: id, agentOptions: route, setup })
    this.handles.set(session.hostSessionId, handle)
    try {
      await initialSave.run(async () => {
        this.assertInitializing()
        if (fresh) this.ctx.sessionTitle.rename(handle.agent.session, membership.session.title)
        if (!await this.ctx.sessions.flush(handle.agent.session)) throw new Error('后台会话初始持久化未确认。')
      })
    } catch (error) {
      if (error instanceof ProjectsClosingError) {
        const stopped=await this.composition.ports.control.retire(id,{handle})
        if(stopped.status!=='stopped')throw new Error('后台晚创建关闭未确认。')
      }
      throw error
    }
    if (!this.lifecycle.canDrive(session.hostSessionId) || this.disposed) {
      const stopped=await this.composition.ports.control.retire(id,{handle});if(stopped.status!=='stopped')throw new Error('后台晚创建关闭未确认。')
      if(this.disposed)throw new ProjectsClosingError()
      throw new ProjectDeletionCreationSettledError('后台晚创建已关闭。')
    }
    return handle.agent
    } catch (error) {
      if (error instanceof ProjectDeletionCreationSettledError) creation.resolve(); else creation.reject(error)
      throw error
    } finally { creation.resolve(); this.creatingRoots.delete(id) }
  }

  private async workspaceFor(project: Project, selectedWorkspace?: string | null): Promise<ProjectWorkspace> {
    const artifacts = join(this.dataRoot, project.id, 'artifacts')
    const created = await mkdir(artifacts, { recursive: true })
    return {
      cwd: selectedWorkspace === null ? artifacts : selectedWorkspace ?? project.workspace?.path ?? artifacts,
      ...(created === undefined ? {} : { freshDefaultArtifactsPath: artifacts }),
    }
  }

  private projectDetail(snapshot: ProjectSnapshot): ProjectDetail {
    const pendingRestores = this.lifecycle.pendingRestores(snapshot.project.id)
    const modelInitializationErrors = snapshot.sessions.flatMap(session => {
      const error = this.modelInitializationErrors.get(SessionId(session.hostSessionId))
      return error === undefined ? [] : [{ hostSessionId: session.hostSessionId, message: errorMessage(error) }]
    })
    return { ...projectDetail(snapshot), ...(pendingRestores.length ? { pendingRestores } : {}),
      ...(modelInitializationErrors.length ? { modelInitializationErrors } : {}) }
  }

  private async detail(projectId: string): Promise<ProjectDetail | undefined> {
    const project = await this.store.getProject(projectId)
    if (project === undefined) return undefined
    return this.projectDetail(await this.store.getSnapshot(project.id))
  }

  private async requireDetail(projectId: string): Promise<ProjectDetail> {
    const detail = await this.detail(projectId)
    if (detail === undefined) throw new ProjectNotFoundError(projectId)
    return detail
  }

  private async requireProject(projectId: string): Promise<Project> {
    const project = await this.store.getProject(projectId)
    if (project === undefined) throw new ProjectNotFoundError(projectId)
    return project
  }

  /** Read or hydrate exactly one Project record; this never resolves a DSH Agent. */
  private async snapshot(projectId: string): Promise<ProjectSnapshot> {
    const cached = this.snapshotsByProjectId.get(projectId)
    if (cached !== undefined) return cached
    const project = await this.store.getProject(projectId)
    if (project === undefined) throw new ProjectNotFoundError(projectId)
    const snapshot = await this.store.getSnapshot(project.id)
    this.replaceProjectMembership(snapshot)
    return snapshot
  }

  private assertReady(): void {
    if (this.initializing === undefined || this.disposed) {
      throw new Error('projects: runtime is not active')
    }
  }
}

/** 仅把真实失败反馈交给用户；已接纳的写操作本身仍以 rejection 结算。 */
class ExecutionSessionRenameError extends Error {
  constructor(readonly result: RenameExecutionSessionResult, options: ErrorOptions) {
    super(result.message, options)
  }
}

/** 退出取消不伪装成落盘故障；原生已保存值仍随结果返回。 */
class ExecutionSessionRenameClosingError extends ProjectsClosingError {
  constructor(readonly result: RenameExecutionSessionResult) { super() }
}

/** Local, pre-wire signal that a requested durable Project record is absent. */
export class ProjectNotFoundError extends Error {
  constructor(readonly projectId: string) {
    super(`Project not found: ${projectId}`)
  }
}

/** Install a static, Agent-scoped identity for the exact Project and role. */
function installProjectRolePrompt(agentCtx: Context, project: Project, session: ProjectSession): () => void {
  if (session.role !== 'main' && session.role !== 'execution') throw new Error('后台记忆不使用工作会话身份说明。')
  return agentCtx.systemPrompt.section({
    name: `projects:role:${session.id}`,
    order: agentCtx.systemPrompt.getSectionOrder('TEAM_POLICY'),
    text: projectSystemInstructions(project.id, session.id, session.role),
  })
}

function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left.size !== right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined
}


function uniqueSourceRefs(values: readonly SourceRef[]): SourceRef[] {
  const seen = new Set<string>()
  return values.filter(value => {
    const key = sourceRefKey(value)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function sourceRefKey(source: SourceRef): string { return nativeProjectSourceKey(source) }

function projectTarget(session: Pick<ProjectSession, 'id' | 'role'>): ProjectNavigationTarget {
  if (session.role !== 'main' && session.role !== 'execution') throw new Error('后台记忆不是工作导航目标。')
  return { kind: session.role, sessionId: session.id }
}


function historyTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) {
    throw projectToolError('历史时间需为带时区的 ISO 时间。', 'PROJECT_HISTORY_TIME_INVALID')
  }
  return Date.parse(value)
}

function requiredText(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw projectToolError(`${label} must not be empty`, 'PROJECT_TOOL_TEXT_REQUIRED')
  }
  return value
}

function projectToolError(message: string, code: string): HarnessError {
  return new HarnessError(message, code)
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue
}

/** 同一持久版本也可能完成恢复；完整detail相等才是重复通知。 */
function detailFingerprint(detail: ProjectDetail): string {
  return JSON.stringify(detail)
}

function nativeSourceFromReadArgs(args: ReadProjectArgs): NativeProjectSource | undefined {
  const hostSessionId = args.source_host_session_id
  const messageId = args.source_message_id
  const toolCallId = args.source_tool_call_id
  if (hostSessionId === undefined && messageId === undefined && toolCallId === undefined) return undefined
  if (hostSessionId === undefined || (messageId === undefined && toolCallId === undefined) || (messageId !== undefined && toolCallId !== undefined)) {
    throw projectToolError(
      'project_read source lookup requires source_host_session_id and exactly one of source_message_id or source_tool_call_id',
      'PROJECT_SOURCE_ARGUMENTS_INVALID',
    )
  }
  if (messageId !== undefined) return { kind: 'message', hostSessionId, messageId }
  if (toolCallId !== undefined) return { kind: 'tool', hostSessionId, toolCallId }
  throw projectToolError('project_read source lookup is incomplete', 'PROJECT_SOURCE_ARGUMENTS_INVALID')
}

function nativeSourceRead(value: NativeProjectSourceRead): ProjectNativeSourceRead {
  return { ...value, items: value.items.map(item => ({ ...item })) }
}

function communicationEndpoint(session: Pick<ProjectSession, 'id' | 'hostSessionId' | 'role' | 'title'>): CommunicationEndpoint {
  if (session.role !== 'main' && session.role !== 'execution') throw communicationError('COMMUNICATION_WORK_SESSION_REQUIRED', 'Memory Bot is not a communication endpoint')
  return { sessionId: session.id, hostSessionId: session.hostSessionId, role: session.role, title: session.title }
}

/** One logical owner may have multiple independent native root responsibilities. */
function carrierSessions(session: ProjectSession): ProjectSession[] {
  return (session.carriers ?? [{ hostSessionId: session.hostSessionId, sourceLifecycle: session.sourceLifecycle, ownedLifecycle: session.ownedLifecycle }])
    .map(carrier => ({ ...session, archived: session.archived || hasPendingSourceDeletion(session) || ('closed' in carrier && carrier.closed !== undefined), hostSessionId: carrier.hostSessionId, sourceLifecycle: carrier.sourceLifecycle, ownedLifecycle: carrier.ownedLifecycle }))
}

function hasPendingSourceDeletion(session: ProjectSession): boolean { return (session.carriers ?? [session]).some(carrier => carrier.sourceLifecycle.kind === 'deleting' || carrier.sourceLifecycle.kind === 'partial') }
