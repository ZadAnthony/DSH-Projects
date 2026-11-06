/** Projects-owned native Session UI adapter. Every runtime import is public. */
import { join, resolve } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection as AgentModelSelection } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import type {
  ModelCatalog, SessionAttachmentRequest, SessionAttachmentValue, SessionCancelRequest,
  SessionCancelValue, SessionControlFrame, SessionFollowFrame, SessionFollowRequest,
  SessionPage, SessionPageRequest, SessionPromptRequest, SessionPromptValue,
  SessionRenameRequest, SessionRenameValue, SessionSelectModelRequest,
  SessionSelectModelValue, SessionSummary, SessionUpdateQueueRequest, SessionUpdateQueueValue,
  SessionProjectionsValue, SkillListRequest, SkillListValue, SessionSearchRequest, SessionSearchValue,
} from '@deepseek-ai/dsh-api-session-controller/types'
import JobController, { type JobListRequest, type JobListFrame, type JobFollowRequest, type JobFollowFrame, type JobKillValue } from '@deepseek-ai/dsh-api-job-controller'
import WorkspaceFiles, { type WorkspaceFileScope, type WorkspaceFileText, type WorkspaceFileBytes, type WorkspaceFileStat, type WorkspaceDirectoryListing, type WorkspaceFileWatchFrame } from '@deepseek-ai/dsh-api-workspace-files'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { initializeProjectsWorkspaceRegistry } from './native-storage.ts'
import { projectPlanModeOwner } from './presets/plan-mode.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { PrivateSessionAttachments } from './ui-host/attachments.ts'
import { PrivateSessionFetchRegistry } from './ui-host/fetch-registry.ts'
import { ReadonlySessionHistoryController } from './ui-host/readonly-history.ts'
import { projectUiHistoryFrame, projectUiHistoryPage } from './ui-host/history-wire.ts'
import { PrivateSessionInteractions } from './ui-host/interactions.ts'
import type {} from './read/index.ts'
import type {} from '@deepseek-ai/dsh-file-reference'
import type {} from '@deepseek-ai/dsh-session-reference'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { WorkspaceFileDiff } from '@deepseek-ai/dsh-workspace-changes/types'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { CommandDescriptor, CommandExecution } from '@deepseek-ai/dsh-commands/types'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types'
import type { SessionReferenceMentionCandidate } from '@deepseek-ai/dsh-session-reference/types'
import type { FileUploadValue } from '@deepseek-ai/dsh-client-file-upload/types'
import type {
  ProjectUiProjectionsRequest, ProjectUiPermissionCatalog, ProjectUiAgentPresetRoster, ProjectUiTarget, ProjectUiAccess, ProjectUiCommandRequest, ProjectUiQueryRequest, ProjectUiUploadRequest,
  ProjectUiPromptRequest, ProjectUiCancelRequest, ProjectUiUpdateQueueRequest, ProjectUiSelectModelRequest,
  ProjectUiRenameRequest, ProjectUiInteractionFrame, ProjectUiInteractionResponse,
  ProjectUiQuestionRequest, ProjectUiQuestionAnswerRequest, ProjectUiPlanRequest,
  ProjectUiFileRequest, ProjectUiFileReadRequest, ProjectUiFileBytesRequest, ProjectUiCarrierAddress,
  ProjectUiSubagentAddress, ProjectUiSubagentPromptReceipt, ProjectUiSubagentInterruptReceipt, ProjectUiSubagentPromptRequest, ProjectUiSubagentInterruptRequest, ProjectUiSubagentInfo, ProjectUiJobKillRequest, ProjectUiAgentPresetSelectRequest,
  ProjectUiChangesRequest, ProjectUiChangesDiffRequest, ProjectUiChangesSummary,
} from './ui-host/types.ts'
export type * from './ui-host/types.ts'

export type PrivateSessionUiOperation = 'read' | 'activate' | 'write'
export type ProjectSessionControlFrame = SessionControlFrame
  | { readonly type: 'catalog'; readonly items: readonly SessionSummary[] }
  | { readonly type: 'status'; readonly sessionId: SessionId; readonly running: boolean }
  | { readonly type: 'error'; readonly sessionId: SessionId; readonly message: string }
  | { readonly type: 'refresh'; readonly event: 'commands/change' | 'llm/adapters-updated' | 'permission-presets/catalog-changed'; readonly args: readonly [] }
  | { readonly type: 'refresh'; readonly event: 'agent-preset/selected'; readonly args: readonly [SessionId, string] }

export interface PrivateSessionDefaultModelPort {
  currentSelection(): AgentModelSelection
  saveSelection(selection: AgentModelSelection): Promise<void>
}

export interface PrivateSessionUiConfig {
  readonly dataRoot: string
  /** Cancels a bootstrap lock wait; already-started native initialization still drains. */
  readonly startupSignal?: AbortSignal
  /** Only model DTOs and explicit saves cross to the single profile owner. */
  readonly defaultModel: PrivateSessionDefaultModelPort
  /** Root ProjectStore checks saved membership/current/archived policy here. */
  readonly resolveAgent?: (id: SessionId, signal?: AbortSignal) => Promise<Agent>
  readonly subagentCatalog?: (rootId: SessionId, signal?: AbortSignal) => Promise<readonly ProjectUiSubagentInfo[]>
  readonly subagentAddress?: (id: SessionId, signal?: AbortSignal) => Promise<ProjectUiSubagentAddress | undefined>
  readonly validateRelatedCapture?: (address: ProjectUiCarrierAddress, targetId: SessionId) => void | Promise<void>
  readonly validateCapture?: (address: ProjectUiCarrierAddress) => void | Promise<void>
  /** Visibility classification only. Unknown/corrupt ownership must reject; it is never an access grant. */
  readonly isVisibleTarget: (id: SessionId, signal?: AbortSignal) => Promise<boolean>
  /** The saved source owner publishes eligibility changes after its commit. */
  readonly subscribeTargetChanges?: (listener: () => void) => () => void
  readonly resolveTarget: (id: SessionId, operation: PrivateSessionUiOperation) => void | Promise<void>
  /** 原control同步核对实时生命周期cut和工作准入。 */
  readonly assertAdmitting: (id: SessionId, agent: Agent) => void
}

export interface PrivateSessionUiPort {
  assertTarget(id: SessionId, operation?: PrivateSessionUiOperation): Promise<void>
  bindAgentAttachments(ctx: Context, id: SessionId): Promise<void>
  catalog(signal?: AbortSignal): Promise<readonly SessionSummary[]>
  control(signal?: AbortSignal): AsyncIterable<ProjectSessionControlFrame>
  follow(request: SessionFollowRequest, signal?: AbortSignal): AsyncIterable<SessionFollowFrame>
  followReadonly(request: SessionFollowRequest, signal?: AbortSignal): AsyncIterable<SessionFollowFrame>
  page(request: SessionPageRequest, signal?: AbortSignal): Promise<SessionPage>
  prompt(request: ProjectUiPromptRequest, signal?: AbortSignal): Promise<SessionPromptValue>
  cancel(request: ProjectUiCancelRequest): Promise<SessionCancelValue>
  updateQueue(request: ProjectUiUpdateQueueRequest): Promise<SessionUpdateQueueValue>
  modelCatalog(): Promise<ModelCatalog>
  selectModel(request: ProjectUiSelectModelRequest): Promise<SessionSelectModelValue>
  rename(request: ProjectUiRenameRequest): Promise<SessionRenameValue>
  attachment(request: SessionAttachmentRequest): Promise<SessionAttachmentValue>
  search(request: SessionSearchRequest, signal?: AbortSignal): Promise<SessionSearchValue>
  projections(request: ProjectUiProjectionsRequest, signal?: AbortSignal): Promise<SessionProjectionsValue>
  commandCatalog(request: ProjectUiTarget, signal?: AbortSignal): Promise<readonly CommandDescriptor[]>
  executeCommand(request: ProjectUiCommandRequest, signal?: AbortSignal): Promise<CommandExecution | undefined>
  fileCandidates(request: ProjectUiQueryRequest, signal?: AbortSignal): Promise<FileReferenceCandidate[]>
  sessionCandidates(request: ProjectUiQueryRequest, signal?: AbortSignal): Promise<SessionReferenceMentionCandidate[]>
  skills(request: SkillListRequest, signal?: AbortSignal): Promise<SkillListValue>
  upload(request: ProjectUiUploadRequest, signal?: AbortSignal): Promise<FileUploadValue>
  /** Normal authenticated Host forwards its request; never exposes a private Agent to root. */
  uploadFetch(request: ProjectUiTarget, transport: Request): Promise<Response>
  interactions(request: ProjectUiTarget, signal?: AbortSignal): AsyncIterable<ProjectUiInteractionFrame>
  respondInteraction(request: ProjectUiInteractionResponse): Promise<{ readonly accepted: boolean }>
  answerQuestion(request: ProjectUiQuestionAnswerRequest): Promise<boolean>
  attachQuestionWait(request: ProjectUiQuestionRequest, signal?: AbortSignal): AsyncIterable<{ remainingMs: number }>
  setPlan(request: ProjectUiPlanRequest): Promise<'committed' | 'queued' | 'cancelled' | 'noop'>
  readFile(request: ProjectUiFileReadRequest, signal?: AbortSignal): Promise<WorkspaceFileText>
  readFileBytes(request: ProjectUiFileBytesRequest, signal?: AbortSignal): Promise<WorkspaceFileBytes>
  statFile(request: ProjectUiFileRequest, signal?: AbortSignal): Promise<WorkspaceFileStat>
  listFiles(request: ProjectUiFileRequest, signal?: AbortSignal): Promise<WorkspaceDirectoryListing>
  fileChanges(request: ProjectUiFileRequest, signal?: AbortSignal): AsyncIterable<WorkspaceFileWatchFrame>
  subagentAddress(request: ProjectUiTarget, signal?: AbortSignal): Promise<ProjectUiSubagentAddress | undefined>
  subagentCatalog(request: ProjectUiTarget, signal?: AbortSignal): Promise<readonly ProjectUiSubagentInfo[]>
  subagentPrompt(request: ProjectUiSubagentPromptRequest, signal?: AbortSignal): Promise<ProjectUiSubagentPromptReceipt>
  subagentInterrupt(request: ProjectUiSubagentInterruptRequest): Promise<ProjectUiSubagentInterruptReceipt>
  jobList(request: JobListRequest, signal?: AbortSignal): AsyncIterable<JobListFrame>
  jobFollow(request: JobFollowRequest, signal?: AbortSignal): AsyncIterable<JobFollowFrame>
  jobKill(request: ProjectUiJobKillRequest): Promise<JobKillValue>
  permissionCatalog(): Promise<ProjectUiPermissionCatalog>
  agentPresetList(): Promise<ProjectUiAgentPresetRoster>
  agentPresetSelect(request: ProjectUiAgentPresetSelectRequest): Promise<string>
  changesSummary(request: ProjectUiChangesRequest, signal?: AbortSignal): Promise<ProjectUiChangesSummary | undefined>
  changesDiff(request: ProjectUiChangesDiffRequest, signal?: AbortSignal): Promise<WorkspaceFileDiff | undefined>
  /** End live stream responsibilities and settle already admitted UI calls. */
  close(): Promise<void>
}

class PrivateDefaultModel extends AgentDefaultModelConfig {
  private readonly pendingSelections = new Set<Promise<void>>()
  constructor(ctx: Context, private readonly port: PrivateSessionDefaultModelPort) {
    super(ctx, {
      provider: { get: () => port.currentSelection().provider },
      model: { get: () => port.currentSelection().model },
      reasoningEffort: { get: () => port.currentSelection().reasoningEffort },
    })
  }
  override currentSelection(): AgentModelSelection { return structuredClone(this.port.currentSelection()) }
  override saveSelection(selection: AgentModelSelection): Promise<void> {
    const task = Promise.resolve().then(() => this.port.saveSelection(structuredClone(selection)))
    this.pendingSelections.add(task)
    void task.then(() => this.pendingSelections.delete(task), () => this.pendingSelections.delete(task))
    return task
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.pendingSelections]) }
}

class StreamQueue<T> {
  private readonly items: T[] = []
  private wake?: () => void
  private ended = false
  private error?: unknown
  push(item: T): void { if (!this.ended) { this.items.push(item); this.wake?.(); this.wake = undefined } }
  end(error?: unknown): void { this.ended = true; this.error = error; this.wake?.(); this.wake = undefined }
  async *iterate(signal: AbortSignal): AsyncIterable<T> {
    const abort = () => this.end()
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!signal.aborted) {
        const item = this.items.shift()
        if (item !== undefined) { yield item; continue }
        if (this.ended) { if (this.error !== undefined) throw this.error; return }
        await new Promise<void>(resolve => { this.wake = resolve })
      }
    } finally { signal.removeEventListener('abort', abort) }
  }
}

/**
 * Call only on the independent graph. Native foundations (FS, storageDomain,
 * commands) must already be ready; these are never obtained from the root.
 */
export async function installPrivateSessionUi(ctx: Context, config: PrivateSessionUiConfig): Promise<PrivateSessionUiPort> {
  for (const key of ['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'typert', 'llm', 'fs', 'commands', 'storageDomain', 'projectsRead', 'sandboxPolicy', 'jobs', 'sessionTitle']) {
    if (ctx.get(key) === undefined) throw new Error(`PROJECT_NOT_READY: private Session UI requires ${key}`)
  }
  for (const key of ['sessionController', 'remoteAccess', 'attachments', 'agentDefaultModel', 'sessionQuery', 'workspaceRegistry', 'connection', 'fileUploads', 'workspaceFiles', 'jobController']) {
    if (ctx.get(key) !== undefined) throw new Error(`Projects private Session UI provider already exists: ${key}`)
  }
  const home = resolve(config.dataRoot)
  // Initialize the Projects format before native side owners make directories.
  await (ctx.sessionPersistence as import('./persistence/index.ts').ProjectSessionPersistence).initialize()
  const attachments = new PrivateSessionAttachments(ctx)
  const defaultModel = new PrivateDefaultModel(ctx, config.defaultModel)
  const fetchRegistry = new PrivateSessionFetchRegistry(ctx)
  const fibers: Fiber[] = [
    ctx.plugin(SqliteSessionQueryEngine, { path: join(home, 'ui-host', 'query.sqlite'), openAt: 'first-search' }),
    await initializeProjectsWorkspaceRegistry(ctx, home, config.startupSignal),
    ctx.plugin(WorkspaceFiles, { maxBytes: 2 * 1024 * 1024, maxFileBytes: 32 * 1024 * 1024, maxLines: 5000, maxEntries: 2000 }),
    ctx.plugin(JobController, {}),
    ctx.plugin(FileUploads),
    ctx.plugin(RemoteAccessService),
    ctx.plugin(SessionController, { nativeOpen: false }),
  ]
  await Promise.all(fibers.map(fiber => fiber.await()))
  const readonlyHistory = new ReadonlySessionHistoryController(ctx)
  const controller = ctx.sessionController
  if (controller === undefined) throw new Error('PROJECT_NOT_READY: native SessionController did not become ready')
  const shutdown = new AbortController()
  const pending = new Set<Promise<unknown>>()
  const streams = new Set<Promise<void>>()
  const closeStreams = new Set<() => Promise<unknown>>()
  let closing: Promise<void> | undefined
  const active = () => { if (shutdown.signal.aborted) throw new RemoteError('gateway/internal', 'PROJECT_CLOSING: Projects UI is closing', {}) }
  const lifetime = (signal?: AbortSignal) => signal === undefined ? shutdown.signal : AbortSignal.any([shutdown.signal, signal])
  const managed = <T>(source: AsyncGenerator<T>, abort: AbortController): AsyncIterable<T> => {
    const close = () => { abort.abort(); return source.return(undefined) }
    closeStreams.add(close)
    return {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            try { const value = await source.next(); if (value.done) closeStreams.delete(close); return value }
            catch (error) { closeStreams.delete(close); throw error }
          },
          return: async () => { try { return await close() } finally { closeStreams.delete(close) } },
          throw: async error => { try { return await source.throw(error) } finally { closeStreams.delete(close) } },
        }
      },
    }
  }
  const assertTarget = async (id: SessionId, operation: PrivateSessionUiOperation = 'write') => { active(); await config.resolveTarget(id, operation); active() }
  const visibleTarget = async (id: SessionId, signal?: AbortSignal): Promise<boolean> => {
    const scope = lifetime(signal)
    scope.throwIfAborted()
    const visible = await config.isVisibleTarget(id, scope)
    scope.throwIfAborted()
    return visible
  }
  const visibleReadableTarget = async (id: SessionId, signal?: AbortSignal): Promise<boolean> => {
    const scope = lifetime(signal)
    if (!await visibleTarget(id, scope)) return false
    try { await assertTarget(id, 'read'); scope.throwIfAborted(); return true } catch (error) {
      scope.throwIfAborted()
      // Collection membership can end between visibility and the strict read.
      // A matching rejection is skippable only after its owner confirms departure.
      const failure = remoteErrorOf(error), details = failure?.details
      if (failure?.code === 'projects/source-unavailable' && details !== null && typeof details === 'object'
        && 'carrierId' in details && details.carrierId === id && !await visibleTarget(id, scope)) return false
      throw error
    }
  }
  const visibleBaseline = async (frame: Extract<SessionControlFrame, { type: 'baseline' }>, signal?: AbortSignal): Promise<SessionControlFrame> => {
    const projections = { ...frame.value.projections }
    for (const id of Object.keys(projections)) {
      if (!await visibleReadableTarget(id as SessionId, signal)) delete projections[id as SessionId]
    }
    return { ...frame, value: { ...frame.value, projections } }
  }
  const track = <T>(action: () => Promise<T>): Promise<T> => {
    active()
    const task = action()
    pending.add(task)
    void task.then(() => pending.delete(task), () => pending.delete(task))
    return task
  }
  const rejectReadonly = (access?: ProjectUiAccess) => {
    if (access?.readonly === true) throw new Error('PROJECT_READ_ONLY: historical reader cannot mutate a Session')
  }
  const assertWriteTarget = async (request: ProjectUiTarget) => {
    rejectReadonly(request)
    const id = request.sessionId
    await assertTarget(id, 'write')
    if (request.carrier !== undefined) {
      if (request.carrier.hostSessionId !== id) {
        if (config.validateRelatedCapture === undefined) throw new Error('PROJECT_UI_SCOPE: captured carrier differs from request target')
        await config.validateRelatedCapture(structuredClone(request.carrier), id)
      }
      if (config.validateCapture === undefined) throw new Error('PROJECT_UI_SCOPE: captured carrier validator is unavailable')
      await config.validateCapture(structuredClone(request.carrier))
    }
    active()
  }
  const write = <T>(request: ProjectUiTarget, action: () => T | Promise<T>, signal?: AbortSignal, requestId?: string): Promise<T> => track(async () => {
    const scope = lifetime(signal)
    await assertWriteTarget(request)
    const id = request.sessionId
    return attachments.runForUiInput(id, {
      requestId,
      revalidate: () => assertWriteTarget(request),
      assertCurrent: agent => {
        scope.throwIfAborted()
        if (ctx.agents.get(id) !== agent) throw new Error('PROJECT_UI_AGENT_UNAVAILABLE: original private Agent changed during prompt preparation')
        config.assertAdmitting(id, agent)
      },
    }, action)
  })
  const agentFor = async (id: SessionId, operation: 'read' | 'write', signal?: AbortSignal): Promise<Agent> => {
    const scope = lifetime(signal)
    scope.throwIfAborted()
    await assertTarget(id, operation === 'read' ? 'activate' : 'write')
    const agent = config.resolveAgent === undefined ? ctx.agents.get(id) : await config.resolveAgent(id, scope)
    scope.throwIfAborted()
    await assertTarget(id, operation === 'read' ? 'activate' : 'write')
    if (agent === undefined || agent.id !== id || ctx.agents.get(id) !== agent) throw new Error('PROJECT_UI_AGENT_UNAVAILABLE: exact private Agent resolver is unavailable')
    return agent
  }
  const workspaceScope = async (id: SessionId, signal?: AbortSignal): Promise<WorkspaceFileScope> => {
    await assertTarget(id, 'read')
    return ctx.projectsRead.withDirectory(id, ({ directory }) => {
      if (directory.header.cwd === undefined) throw new Error('PROJECT_UI_SCOPE: Project carrier has no confirmed workspace')
      return { sessionId: id, workspaceRoot: directory.header.cwd }
    }, { signal: lifetime(signal) })
  }
  const interactions = new PrivateSessionInteractions(ctx, id => assertTarget(id, 'write'))
  const catalog = (signal?: AbortSignal): Promise<readonly SessionSummary[]> => track(async () => {
    const scope = lifetime(signal)
    scope.throwIfAborted()
    const { items } = await controller.list({}, scope)
    const visible: SessionSummary[] = []
    for (const item of items) {
      if (!await visibleReadableTarget(item.sessionId, scope)) continue
      visible.push(item)
    }
    scope.throwIfAborted()
    return visible
  })
  const port: PrivateSessionUiPort = {
    assertTarget,
    bindAgentAttachments: (agentCtx, id) => attachments.bindAgent(agentCtx, id),
    catalog,
    control(signal) {
      const abort = new AbortController()
      return managed((async function* () {
      active()
      const scope = AbortSignal.any([lifetime(signal), abort.signal])
      const queue = new StreamQueue<ProjectSessionControlFrame | { readonly type: 'catalog-ready'; readonly items: readonly SessionSummary[]; readonly revision: number }>()
      const publishedRunning = new Map<SessionId, boolean>()
      let catalogDirty = true
      let catalogRevision = 0
      let catalogTask: Promise<void> | undefined
      const startCatalog = (): void => {
        if (catalogTask !== undefined || !catalogDirty || scope.aborted) return
        // Assign the owner before any native list callback can request another
        // refresh. Only this producer performs collection I/O for the stream.
        const reading = Promise.resolve().then(async () => {
          while (catalogDirty && !scope.aborted) {
            catalogDirty = false
            const revision = catalogRevision
            try {
              const items = await catalog(scope)
              if (!scope.aborted) queue.push({ type: 'catalog-ready', items, revision })
            } catch (error) {
              // 真实成员更新已作废这个集合切点；新集合仍由同一 producer 读取并验证。
              if (!scope.aborted && revision !== catalogRevision && error instanceof Error
                && error.message === 'PROJECT_SOURCE_CHANGED_DURING_READ') continue
              throw error
            }
          }
        })
        catalogTask = reading.then(() => {
          catalogTask = undefined
          if (catalogDirty && !scope.aborted) startCatalog()
        }, error => { queue.end(error) })
      }
      const refreshCatalog = (membershipChanged: boolean): void => {
        if (membershipChanged) catalogRevision++
        catalogDirty = true
        startCatalog()
      }
      const disposers = [
        // Native retirement can precede the saved source commit. That commit
        // must supersede any catalog read which still observed the old source.
        ...(config.subscribeTargetChanges === undefined ? [] : [config.subscribeTargetChanges(() => refreshCatalog(true))]),
        ctx.on('api-session/status', (sessionId, running) => queue.push({ type: 'status', sessionId, running })),
        ctx.on('api-session/error', (sessionId, message) => queue.push({ type: 'error', sessionId, message })),
        ctx.on('api-session/added', () => refreshCatalog(true)),
        ctx.on('api-session/removed', () => refreshCatalog(true)),
        ctx.on('api-session/activity', () => refreshCatalog(false)),
        ctx.on('commands/change', () => queue.push({ type: 'refresh', event: 'commands/change', args: [] })),
        ctx.on('llm/adapters-updated', () => queue.push({ type: 'refresh', event: 'llm/adapters-updated', args: [] })),
        ctx.on('permission-presets/catalog-changed', () => queue.push({ type: 'refresh', event: 'permission-presets/catalog-changed', args: [] })),
        ctx.on('agent-preset/selected', (id, preset) => queue.push({ type: 'refresh', event: 'agent-preset/selected', args: [id, preset] })),
      ]
      const native = controller.control(scope)[Symbol.asyncIterator]()
      const completed = Promise.withResolvers<void>()
      streams.add(completed.promise)
      let pumping: Promise<void> | undefined
      try {
        const first = await native.next()
        if (first.done || first.value.type !== 'baseline') throw new Error('Native Session control omitted its baseline')
        const baseline = await visibleBaseline(first.value, scope)
        // Begin the pump before async catalog work; no projection replacement is lost.
        pumping = (async () => {
          try { for (;;) { const next = await native.next(); if (next.done) break; queue.push(next.value) }; queue.end() }
          catch (error) { queue.end(error) }
        })()
        yield baseline
        startCatalog()
        let initialCatalog = true
        for await (const frame of queue.iterate(scope)) {
          if (frame.type === 'catalog-ready') {
            // A departed/added carrier invalidates the old collection cut. Its
            // dirty replacement is already owned by the same catalog producer.
            if (frame.revision !== catalogRevision) continue
            const items = frame.items.map(item => publishedRunning.has(item.sessionId)
              ? { ...item, running: publishedRunning.get(item.sessionId)! } : item)
            yield { type: 'catalog', items }
            if (initialCatalog) {
              initialCatalog = false
              for (const item of items) {
                if (!await visibleReadableTarget(item.sessionId, scope)) continue
                publishedRunning.set(item.sessionId, item.running)
                yield { type: 'status', sessionId: item.sessionId, running: item.running }
              }
            }
            continue
          }
          if (frame.type === 'baseline') { yield await visibleBaseline(frame, scope); continue }
          if (frame.type === 'projection' || frame.type === 'status' || frame.type === 'error') {
            if (!await visibleReadableTarget(frame.sessionId, scope)) continue
          }
          if (frame.type === 'refresh' && frame.event === 'agent-preset/selected') {
            if (!await visibleReadableTarget(frame.args[0], scope)) continue
          }
          if (frame.type === 'status') publishedRunning.set(frame.sessionId, frame.running)
          yield frame
        }
      } finally {
        abort.abort()
        queue.end()
        for (const dispose of disposers) dispose()
        try { await Promise.all([pumping, catalogTask]); await native.return?.() }
        finally { streams.delete(completed.promise); completed.resolve() }
      }
    })(), abort) },
    follow(request, signal) {
      const abort = new AbortController()
      return managed((async function* () {
      const id = request.address.kind === 'session' ? request.address.sessionId : request.address.childSessionId
      if (request.address.kind === 'subagent') await assertTarget(request.address.parentSessionId, 'read')
      await assertTarget(id, request.address.kind === 'session' ? 'activate' : 'read')
      const scope = AbortSignal.any([lifetime(signal), abort.signal])
      const completed = Promise.withResolvers<void>()
      streams.add(completed.promise)
      try {
        for await (const frame of readonlyHistory.follow(request, scope)) {
          await assertTarget(id, 'read')
          yield projectUiHistoryFrame(frame)
          if (frame.type === 'snapshot' && request.address.kind === 'session' && ctx.agents.get(id) === undefined && !scope.aborted) {
            // Preserve ordinary cold-follow activation after its first frame.
            // Projects' control/factory owns resume; native resolveAgent would
            // prepare and cache an unrelated full canonical observation first.
            const promotion = track(async () => {
              await assertTarget(id, 'activate')
              scope.throwIfAborted()
              if (config.resolveAgent !== undefined) await config.resolveAgent(id, scope)
              else await ctx.agents.resume({ resumeSessionId: id, signal: scope })
            })
            void promotion.catch(error => { if (!scope.aborted) ctx.emit('api-session/error', id, error instanceof Error ? error.message : String(error)) })
          }
        }
      } finally { streams.delete(completed.promise); completed.resolve() }
    })(), abort) },
    followReadonly(input, signal) {
      const request = structuredClone(input)
      const abort = new AbortController()
      return managed((async function* () {
        const id = request.address.kind === 'session' ? request.address.sessionId : request.address.childSessionId
        if (request.address.kind === 'subagent') await assertTarget(request.address.parentSessionId, 'read')
        await assertTarget(id, 'read')
        const scope = AbortSignal.any([lifetime(signal), abort.signal])
        const completed = Promise.withResolvers<void>()
        streams.add(completed.promise)
        try { for await (const frame of readonlyHistory.follow(request, scope)) { await assertTarget(id, 'read'); yield projectUiHistoryFrame(frame) } }
        finally { streams.delete(completed.promise); completed.resolve() }
      })(), abort)
    },
    page: (request, signal) => track(async () => {
      const id = request.address.kind === 'session' ? request.address.sessionId : request.address.childSessionId
      if (request.address.kind === 'subagent') await assertTarget(request.address.parentSessionId, 'read')
      await assertTarget(id, 'read')
      const page = await readonlyHistory.page(request, lifetime(signal))
      await assertTarget(id, 'read')
      return projectUiHistoryPage(page)
    }),
    prompt: (input, signal) => { const request = structuredClone(input); return write(request, () => controller.prompt(request, lifetime(signal)), signal, request.requestId) },
    cancel: input => { const request = structuredClone(input); return write(request, () => controller.cancel(request)) },
    updateQueue: input => { const request = structuredClone(input); return write(request, () => controller.updateQueue(request)) },
    modelCatalog: () => track(() => controller.modelCatalog()),
    selectModel: input => { const request = structuredClone(input); return write(request, () => controller.selectModel(request)) },
    rename: input => { const request = structuredClone(input); return write(request, () => controller.rename(request)) },
    attachment: request => track(async () => {
      await assertTarget(request.sessionId, 'read')
      const result = await attachments.runFor(request.sessionId, () => controller.attachment(request))
      await assertTarget(request.sessionId, 'read')
      return result
    }),
    search: (request, signal) => track(async () => {
      const value = await controller.search(structuredClone(request), lifetime(signal))
      const items: SessionSearchValue['items'][number][] = []
      for (const hit of value.items) {
        if (!await visibleReadableTarget(hit.sessionId, signal)) continue
        items.push(hit)
      }
      return { ...value, items }
    }),
    projections: (request, signal) => track(async () => {
      await assertTarget(request.sessionId, 'read')
      const scope = lifetime(signal)
      scope.throwIfAborted()
      const value = request.expectedCreatedAt === undefined
        ? await controller.projections(request, scope)
        : await readonlyHistory.projections(request, scope)
      scope.throwIfAborted()
      await assertTarget(request.sessionId, 'read')
      return value
    }),
    commandCatalog: (request, signal) => track(async () => {
      rejectReadonly(request)
      const agent = await agentFor(request.sessionId, 'read', signal)
      return ctx.commands.list(agent).filter(command => command.name !== 'goal')
    }),
    executeCommand: (input, signal) => {
      const request = structuredClone(input)
      return write(request, async () => {
        const agent = await agentFor(request.sessionId, 'write', signal)
        return ctx.commands.execute(agent, request.line, request.attachments, lifetime(signal))
      })
    },
    fileCandidates: (request, signal) => track(async () => {
      rejectReadonly(request)
      const agent = await agentFor(request.sessionId, 'read', signal)
      const provider = agent.ctx.get('fileReferences')
      if (provider === undefined) throw new Error('PROJECT_UI_CAPABILITY_UNAVAILABLE: fileReferences')
      return provider.list(agent, request.query, lifetime(signal))
    }),
    sessionCandidates: (request, signal) => track(async () => {
      rejectReadonly(request)
      const agent = await agentFor(request.sessionId, 'read', signal)
      const provider = agent.ctx.get('sessionReferenceResolver')
      if (provider === undefined) throw new Error('PROJECT_UI_CAPABILITY_UNAVAILABLE: sessionReferenceResolver')
      const candidates = await provider.remoteExportCandidates(agent, request.query, lifetime(signal))
      const visible: SessionReferenceMentionCandidate[] = []
      for (const candidate of candidates) {
        if (!await visibleReadableTarget(candidate.sessionId, signal)) continue
        visible.push(candidate)
      }
      return visible
    }),
    skills: (request, signal) => track(async () => {
      await assertTarget(request.sessionId, 'read')
      const provider = ctx.get('sessionSkillCatalog')
      if (provider === undefined) throw new Error('PROJECT_UI_CAPABILITY_UNAVAILABLE: sessionSkillCatalog')
      return provider.list(request, lifetime(signal))
    }),
    upload: (input, signal) => {
      const request = structuredClone(input)
      return write(request, async () => {
        const agent = await agentFor(request.sessionId, 'write', signal)
        return ctx.fileUploads.upload(agent, request, lifetime(signal))
      })
    },
    uploadFetch: (input, transport) => {
      const request = structuredClone(input)
      return write(request, async () => {
        // Ignore ambient URL sessionId; the validated explicit target owns bytes.
        const url = new URL(transport.url)
        url.pathname = '/api/session/uploadFileBinary'
        url.searchParams.set('sessionId', request.sessionId)
        const scope = lifetime(transport.signal)
        scope.throwIfAborted()
        await agentFor(request.sessionId, 'write', scope)
        return fetchRegistry.dispatch(new Request(url, { method: transport.method, headers: transport.headers,
          body: transport.body, signal: scope, ...(transport.body === null ? {} : { duplex: 'half' }) } as RequestInit))
      })
    },
    interactions(request, signal) {
      const target = structuredClone(request), abort = new AbortController()
      return managed((async function* () {
        await assertTarget(target.sessionId, 'read')
        const queue = new StreamQueue<ProjectUiInteractionFrame>()
        const scope = AbortSignal.any([lifetime(signal), abort.signal])
        const dispose = interactions.subscribe(target.sessionId, target.readonly === true, frame => queue.push(frame))
        try { for await (const frame of queue.iterate(scope)) { await assertTarget(target.sessionId, 'read'); yield frame } }
        finally { dispose(); queue.end() }
      })(), abort)
    },
    respondInteraction: input => { const request = structuredClone(input); return write(request, () => interactions.respond(request)) },
    answerQuestion: input => {
      const request = structuredClone(input)
      return write(request, async () => {
        const agent = await agentFor(request.sessionId, 'write')
        const provider = agent.ctx.get('userQuestions')
        if (provider === undefined) throw new Error('PROJECT_UI_CAPABILITY_UNAVAILABLE: userQuestions')
        return provider.answer(agent, request.callId, request.answer)
      })
    },
    attachQuestionWait(request, signal) {
      const target = structuredClone(request), abort = new AbortController()
      return managed((async function* () {
        rejectReadonly(target)
        const scope = AbortSignal.any([lifetime(signal), abort.signal])
        const agent = await agentFor(target.sessionId, 'write', scope)
        const provider = agent.ctx.get('userQuestions')
        if (provider === undefined) throw new Error('PROJECT_UI_CAPABILITY_UNAVAILABLE: userQuestions')
        yield* provider.attachWait(agent, target.callId, scope)
      })(), abort)
    },
    setPlan: input => {
      const request = structuredClone(input)
      return write(request, async () => {
        const agent = await agentFor(request.sessionId, 'write')
        const provider = projectPlanModeOwner(agent)
        if (provider === undefined) throw new Error('PROJECT_UI_CAPABILITY_UNAVAILABLE: planMode')
        return provider.set(agent, request.active)
      })
    },
    readFile: (request, signal) => track(async () => {
      const value = await ctx.workspaceFiles.read(await workspaceScope(request.sessionId, signal), request.path, request.range, lifetime(signal))
      await assertTarget(request.sessionId, 'read'); return value
    }),
    readFileBytes: (request, signal) => track(async () => {
      const value = await ctx.workspaceFiles.readBytes(await workspaceScope(request.sessionId, signal), request.path, request.options, lifetime(signal))
      await assertTarget(request.sessionId, 'read'); return value
    }),
    statFile: (request, signal) => track(async () => {
      const value = await ctx.workspaceFiles.stat(await workspaceScope(request.sessionId, signal), request.path, lifetime(signal))
      await assertTarget(request.sessionId, 'read'); return value
    }),
    listFiles: (request, signal) => track(async () => {
      const value = await ctx.workspaceFiles.list(await workspaceScope(request.sessionId, signal), request.path, lifetime(signal))
      await assertTarget(request.sessionId, 'read'); return value
    }),
    fileChanges(request, signal) {
      const target = structuredClone(request), abort = new AbortController()
      return managed((async function* () {
        const scope = AbortSignal.any([lifetime(signal), abort.signal])
        for await (const frame of ctx.workspaceFiles.changes(await workspaceScope(target.sessionId, scope), target.path, scope)) {
          await assertTarget(target.sessionId, 'read'); yield frame
        }
      })(), abort)
    },
    subagentAddress: (request, signal) => track(async () => {
      await assertTarget(request.sessionId, 'read')
      if (config.subagentAddress === undefined) throw new Error('PROJECT_UI_CAPABILITY_UNAVAILABLE: subagentAddress')
      return config.subagentAddress(request.sessionId, lifetime(signal))
    }),
    subagentCatalog: (request, signal) => track(async () => {
      await assertTarget(request.sessionId, 'read')
      if (config.subagentCatalog === undefined) throw new Error('PROJECT_UI_CAPABILITY_UNAVAILABLE: subagentCatalog')
      return config.subagentCatalog(request.sessionId, lifetime(signal))
    }),
    subagentPrompt: (input, signal) => {
      const request = structuredClone(input)
      return write({ sessionId: request.parentSessionId, readonly: request.readonly, carrier: request.carrier }, async () => {
        await assertTarget(request.childSessionId, 'read')
        if (config.subagentAddress === undefined) throw new Error('PROJECT_UI_CAPABILITY_UNAVAILABLE: subagentAddress')
        const address = await config.subagentAddress(request.childSessionId, lifetime(signal))
        if (address?.parentSessionId !== request.parentSessionId || address.mode !== request.mode) throw new Error('PROJECT_UI_SCOPE: child address is not the exact continuable owner')
        const provider = ctx.get('subagents')
        if (provider === undefined) throw new Error('PROJECT_UI_CAPABILITY_UNAVAILABLE: subagents')
        await assertTarget(request.parentSessionId, 'write')
        return attachments.runFor(request.childSessionId, () => provider.prompt(request, lifetime(signal)))
      })
    },
    subagentInterrupt: input => {
      const request = structuredClone(input)
      return write({ sessionId: request.parentSessionId, readonly: request.readonly, carrier: request.carrier }, () => {
        const provider = ctx.get('subagents')
        if (provider === undefined) throw new Error('PROJECT_UI_CAPABILITY_UNAVAILABLE: subagents')
        return provider.interruptByParent(request.childSessionId, request.parentSessionId, request.mode)
      })
    },
    jobList(request, signal) {
      const target = structuredClone(request), abort = new AbortController()
      return managed((async function* () {
        await assertTarget(target.sessionId, 'read')
        const scope = AbortSignal.any([lifetime(signal), abort.signal])
        for await (const frame of ctx.jobController.list(target, scope)) { await assertTarget(target.sessionId, 'read'); yield frame }
      })(), abort)
    },
    jobFollow(request, signal) {
      const target = structuredClone(request), abort = new AbortController()
      return managed((async function* () {
        // Unowned ordinary jobs never exist in the private capability graph.
        if (target.sessionId === undefined) throw new Error('PROJECT_UI_SCOPE: private job observation requires its exact Session owner')
        await assertTarget(target.sessionId, 'read')
        const scope = AbortSignal.any([lifetime(signal), abort.signal])
        for await (const frame of ctx.jobController.follow(target, scope)) { await assertTarget(target.sessionId, 'read'); yield frame }
      })(), abort)
    },
    jobKill: input => { const request = structuredClone(input); return write(request, () => ctx.jobController.kill(request)) },
    permissionCatalog: () => track(async () => {
      const provider = ctx.get('permissionPresets')
      if (provider === undefined) throw new Error('PROJECT_UI_CAPABILITY_UNAVAILABLE: permissionPresets')
      return structuredClone(provider.catalog())
    }),
    agentPresetList: () => track(async () => {
      const provider = ctx.get('agentPresets')
      if (provider === undefined) throw new Error('PROJECT_UI_CAPABILITY_UNAVAILABLE: agentPresets')
      return provider.remoteExportList()
    }),
    agentPresetSelect: input => {
      const request = structuredClone(input)
      return write(request, async () => {
        const provider = ctx.get('agentPresets')
        if (provider === undefined) throw new Error('PROJECT_UI_CAPABILITY_UNAVAILABLE: agentPresets')
        const agent = await agentFor(request.sessionId, 'write')
        return provider.select(agent, request.preset)
      })
    },
    changesSummary: (input, signal) => {
      const request = structuredClone(input)
      return track(async () => {
        if (!Number.isSafeInteger(request.seq) || request.seq < 0) throw new Error('PROJECT_UI_BAD_REQUEST: changes seq must be a non-negative integer')
        lifetime(signal).throwIfAborted()
        await assertTarget(request.sessionId, 'read')
        const provider = ctx.get('workspaceChanges')
        if (provider === undefined) throw new Error('PROJECT_UI_CAPABILITY_UNAVAILABLE: workspaceChanges')
        const summary = provider.summary(request.sessionId, request.seq)
        if (summary === undefined) return undefined
        const { turn, files, total, added, deleted } = summary
        return structuredClone({ turn, files, total, added, deleted })
      })
    },
    changesDiff: (input, signal) => {
      const request = structuredClone(input)
      return track(async () => {
        if (!Number.isSafeInteger(request.seq) || request.seq < 0 || !Number.isSafeInteger(request.index) || request.index < 0) throw new Error('PROJECT_UI_BAD_REQUEST: changes position must use non-negative integers')
        await assertTarget(request.sessionId, 'read')
        const provider = ctx.get('workspaceChanges')
        if (provider === undefined) throw new Error('PROJECT_UI_CAPABILITY_UNAVAILABLE: workspaceChanges')
        const value = await provider.diff(request.sessionId, request.seq, request.index, lifetime(signal))
        await assertTarget(request.sessionId, 'read')
        return structuredClone(value)
      })
    },
    close: () => closing ??= (async () => {
      shutdown.abort(new Error('Projects Session UI closed'))
      interactions.close()
      await Promise.allSettled([...closeStreams].map(close => close()))
      closeStreams.clear()
      await Promise.allSettled([...streams, ...pending])
      await defaultModel.drain()
    })(),
  }
  ctx.effect(() => () => port.close(), 'projects.private-session-ui')
  return port
}
