/** Read-only Project identity, provenance, and native-file access for core adapters. */

import { isAbsolute, join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import type {} from '@deepseek-ai/dsh-fs'
import type { WorkspaceFileScope } from '@deepseek-ai/dsh-api-workspace-files'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, type SessionHeader } from '@deepseek-ai/dsh-session'
import { sameOwnedCreationHeader } from './stock/control/identity.ts'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ProjectInvocationPort } from './stock/project-ports.ts'
import { projectInvocationPort } from './stock/tools/runtime.ts'

import type {
  ProjectCoreDirectoryListing,
  ProjectCoreFileBytes,
  ProjectCoreOriginalUser,
  ProjectCoreProjectView,
  ProjectCoreSessionScope,
  ProjectCoreSettingsUser,
  ProjectCoreSourceRead,
  ProjectCoreToolScope,
  ProjectsCoreErrorCode,
} from './core-contract.ts'
import { ProjectStore, type MetadataSettlementWriter } from './records.ts'
import type { RootWriteScope } from './metadata-files.ts'
import type { LegacySourceReference } from './records-types.ts'
import type { LibraryScope } from './library-contract.ts'
import type {
  ProjectMembership,
  ProjectSnapshot,
  ProjectSession,
  ProjectSessionCarrier,
  ProjectSessionSource,
  SourceRef,
} from './records-types.ts'
import { mintNativeProjectSource } from './native-source-host.ts'
import { nativeProjectSourceKey, decodeNativeProjectSource } from './native-source.ts'
import { readRetainedProjectSource, readRetainedProjectNativePrefix, readRetainedProjectNativeDirectory } from './source-reader.ts'
import { CommunicationVisibleReader, communicationAttachmentVerifier } from './communication/visible-reader.ts'
import { CommunicationTranscript } from './communication/transcript.ts'
import type { CommunicationPartV1, CommunicationSource } from './communication/contract.ts'
import type { NativeProjectSourceReadOptions } from './source-reader.ts'

/** Stable Project-core failure class for adapters that need to preserve ownership distinctions. */
export class ProjectsCoreAccessError extends HarnessError {
  declare readonly code: ProjectsCoreErrorCode | 'PROJECT_CORE_TOOL_CONTEXT_UNAVAILABLE'

  constructor(message: string, code: ProjectsCoreErrorCode | 'PROJECT_CORE_TOOL_CONTEXT_UNAVAILABLE', options?: ErrorOptions) {
    super(message, code, options)
  }
}

/**
 * Provides read-only Project facts to Library and Memory bridges.
 *
 * It never creates, resolves, or resumes a DSH Agent. Workspace identity comes
 * from the public `workspaceFileScope` lookup, and native source content comes
 * from the Projects read owner.
 */
export class ProjectsCoreAccess {
  private readonly ctx: Context
  private readonly store: ProjectStore
  private readonly dataRoot: string

  constructor(
    ctx: Context,
    store: ProjectStore,
    dataRoot: string,
    private readonly assertSourceAdmitting: (hostSessionId: string) => void = () => {},
    private readonly assertProjectAdmitting:(projectId:string)=>void=()=>{},
    private readonly invocations: ProjectInvocationPort = projectInvocationPort,
  ) {
    this.ctx = ctx
    this.store = store
    this.dataRoot = dataRoot
  }

  /** Fresh authorization and the owner's local read/compare/write share one scope. */
  withMetadataWrite<T>(projectId: string, authorize: (fresh: ProjectSnapshot) => void,
    action: (scope: RootWriteScope, fresh: ProjectSnapshot) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.store.withMetadataWrite(projectId, fresh => {
      if (fresh.project.id !== projectId || fresh.project.sourceLifecycle !== undefined) {
        throw coreError('项目正在删除或来源已不可用，未接纳新的元数据保存。', 'PROJECT_CORE_UNAVAILABLE_SOURCE')
      }
      // Local admission happens before preparation. Already accepted operations
      // may finish while deletion drains; the durable fresh state decides commit.
      authorize(fresh)
    }, action, signal)
  }

  /** Only an internal owner preparing an accepted batch retains this one-shot capability. */
  retainMetadataSettlement(projectId: string, authorize: (fresh: ProjectSnapshot) => void): MetadataSettlementWriter {
    return this.store.retainMetadataSettlement(projectId, fresh => {
      if (fresh.project.id !== projectId || fresh.project.sourceLifecycle !== undefined) {
        throw coreError('项目正在删除或来源已不可用，未提交原批次结算。', 'PROJECT_CORE_UNAVAILABLE_SOURCE')
      }
      authorize(fresh)
    })
  }

  /** Only the existing deletion owner supplies this exact, already committed target. */
  withMetadataCleanup<T>(projectId: string, target: { sessionId: string; hostSessionId?: string;
    header?: SessionHeader; preparationAttemptId?: string },
    action: (scope: RootWriteScope, fresh: ProjectSnapshot) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.store.withMetadataWrite(projectId, fresh => {
      const session = fresh.sessions.find(row => row.id === target.sessionId)
      const hostSessionId = target.hostSessionId ?? session?.hostSessionId
      const preparation = target.preparationAttemptId === undefined ? undefined
        : session?.mainPreparations?.find(row => row.attemptId === target.preparationAttemptId && row.toHostSessionId === hostSessionId)
      const carrier = session?.carriers?.find(row => row.hostSessionId === hostSessionId)
      const life = preparation?.sourceLifecycle ?? carrier?.sourceLifecycle
        ?? (session !== undefined && session.hostSessionId === hostSessionId ? session.sourceLifecycle : undefined)
      const header = preparation?.toHeader ?? carrier?.header ?? carrier?.ownedLifecycle?.rootHeader ?? session?.ownedLifecycle?.rootHeader
      if (session === undefined || life === undefined || life.kind === 'available'
        || target.preparationAttemptId !== undefined && preparation === undefined
        || target.header !== undefined && (header === undefined || !sameOwnedCreationHeader(header, target.header))) {
        throw coreError('删除元数据目标、创建身份或已提交清理阶段不匹配。', 'PROJECT_CORE_UNAVAILABLE_SOURCE')
      }
    }, action, signal)
  }

  /** Internal identities come from a real Host/tool/owner, never tool JSON. */
  assertMetadataSession(fresh: ProjectSnapshot, actor: {
    sessionId?: string; hostSessionId: string; roles?: readonly ProjectSession['role'][];
    activity: 'active' | 'settlement' | 'user-maintenance'
  }): { session: ProjectSession; carrier: import('./records-types.ts').ProjectSessionCarrier } {
    const session = fresh.sessions.find(row => (actor.sessionId === undefined || row.id === actor.sessionId)
      && (row.carriers ?? [{ hostSessionId: row.hostSessionId }]).some(carrier => carrier.hostSessionId === actor.hostSessionId))
    const carrier = session?.carriers?.find(row => row.hostSessionId === actor.hostSessionId)
      ?? (session?.hostSessionId === actor.hostSessionId ? { sequence: 1, hostSessionId: session.hostSessionId,
        isCurrent: true, boundAt: session.createdAt, sourceLifecycle: session.sourceLifecycle } : undefined)
    if (session === undefined || carrier === undefined || session.sourceLifecycle.kind !== 'available'
      || carrier.sourceLifecycle.kind !== 'available' || !carrier.isCurrent || carrier.closed !== undefined
      || actor.roles !== undefined && !actor.roles.includes(session.role)
      || actor.activity === 'active' && (fresh.project.archived || session.archived)) {
      throw coreError('实际调用会话、当前承载或生命周期已变化，未提交元数据。', 'PROJECT_CORE_MISSING_SESSION')
    }
    return { session, carrier }
  }

  assertMetadataTarget(fresh: ProjectSnapshot, sessionId: string): ProjectSession {
    const target = fresh.sessions.find(row => row.id === sessionId)
    if (target === undefined || target.sourceLifecycle.kind !== 'available'
      || target.role !== 'main' && target.role !== 'execution') {
      throw coreError('元数据目标工作会话已不可用。', 'PROJECT_CORE_MISSING_SESSION')
    }
    return target
  }

  assertMetadataSources(fresh: ProjectSnapshot, sources: readonly {
    readonly kind: string; readonly projectId?: string; readonly sessionId?: string; readonly hostSessionId?: string
  }[]): void {
    for (const source of sources) {
      if (source.projectId !== undefined && source.projectId !== fresh.project.id) {
        throw coreError('提交来源不属于当前项目。', 'PROJECT_CORE_FOREIGN_SOURCE')
      }
      if (source.hostSessionId === undefined) continue
      const owner = fresh.sessions.find(session => session.hostSessionId === source.hostSessionId
        || session.carriers?.some(carrier => carrier.hostSessionId === source.hostSessionId)
        || session.ownedLifecycle?.members.some(member => String(member.header.id) === source.hostSessionId)
        || session.carriers?.some(carrier => carrier.ownedLifecycle?.members.some(member => String(member.header.id) === source.hostSessionId)))
        ?? (source.kind === 'native-event' && source.sessionId !== undefined
          ? fresh.sessions.find(session => session.id === source.sessionId) : undefined)
      const carrier = owner?.carriers?.find(row => row.hostSessionId === source.hostSessionId)
      if (owner === undefined || owner.sourceLifecycle.kind !== 'available'
        || carrier !== undefined && carrier.sourceLifecycle.kind !== 'available') {
        throw coreError('提交前来源会话已不可用，未把旧来源验证当作当前事实。', 'PROJECT_CORE_UNAVAILABLE_SOURCE')
      }
    }
  }

  /** Read a committed Project snapshot and its durable Project directory. */
  async forProject(projectId: string): Promise<ProjectCoreProjectView> {
    const snapshot = await this.store.findSnapshot(projectId)
    if (snapshot === undefined) {
      throw coreError(`Project does not exist: ${projectId}`, 'PROJECT_CORE_MISSING_PROJECT')
    }
    if(snapshot.project.sourceLifecycle!==undefined)throw coreError("Project source is unavailable", "PROJECT_CORE_UNAVAILABLE_SOURCE")
    this.assertProjectAdmitting(projectId)
    return this.projectView(snapshot)
  }

  /** Resolve one durable Project session and its public DSH workspace scope without waking an Agent. */
  async forSession(projectId: string, sessionId: string): Promise<ProjectCoreSessionScope> {
    const project = await this.forProject(projectId)
    const session = project.snapshot.sessions.find(candidate => candidate.id === sessionId)
    if (session === undefined) {
      throw coreError(`Project session does not exist: ${projectId}/${sessionId}`, 'PROJECT_CORE_MISSING_SESSION')
    }
    const carrier = sessionCarrier(session, session.hostSessionId)
    if (session.sourceLifecycle.kind !== 'available' || carrier?.sourceLifecycle.kind !== 'available'
      || !carrier.isCurrent || carrier.closed !== undefined) {
      throw coreError(`Project session is unavailable: ${projectId}/${sessionId}`, 'PROJECT_CORE_MISSING_SESSION')
    }
    this.assertSourceAdmitting(session.hostSessionId)
    const scope = await this.workspaceScope(session.hostSessionId)
    return {
      ...project,
      session,
      hostSessionId: session.hostSessionId,
      role: session.role,
      // workspaceFileScope has one authoritative root. It is also the working
      // directory visible to native tools; Project.workspace is only metadata.
      workingDirectory: scope.workspaceRoot,
      workspaceRoot: scope.workspaceRoot,
    }
  }

  /** Read current shared context for a real unpublished main root without granting work or tool access. */
  async preparedMainContext(projectId: string, hostSessionId: string): Promise<{ projectId: string; projectDirectory: string; actorId: string; sessionId: string; role: 'main'; readOnly: true } | undefined> {
    const ownership = await this.store.resolveHostOwnership(hostSessionId, { projectId })
    if (ownership?.kind !== 'preparation' || ownership.project.id !== projectId || ownership.session.role !== 'main'
      || ownership.preparation.state !== 'unpublished' || ownership.preparation.retirement === 'confirmed'
      || ownership.preparation.sourceLifecycle !== undefined && ownership.preparation.sourceLifecycle.kind !== 'available'
      || ownership.preparation.toHeader === undefined) return undefined
    await this.forProject(projectId)
    this.assertSourceAdmitting(hostSessionId)
    return { projectId, projectDirectory: join(this.dataRoot, projectId), actorId: hostSessionId,
      sessionId: ownership.session.id, role: 'main', readOnly: true }
  }

  /** Resolve a host Session only when its durable membership belongs to the expected Project. */
  async forHostSession(expectedProjectId: string, hostSessionId: string): Promise<ProjectCoreSessionScope> {
    const project = await this.forProject(expectedProjectId)
    const logical = project.snapshot.sessions.find(session => sessionCarrier(session, hostSessionId) !== undefined)
    const carrier = logical === undefined ? undefined : sessionCarrier(logical, hostSessionId)
    if (logical === undefined || carrier?.sourceLifecycle.kind !== 'available') {
      // Only an absent local identity needs the global lookup to preserve the
      // distinction between a foreign source and a nonexistent source.
      const foreign = logical === undefined ? await this.store.findCarrierByHostSessionId(hostSessionId) : undefined
      if (foreign !== undefined && foreign.carrier.sourceLifecycle.kind === 'available' && foreign.project.id !== expectedProjectId) {
        throw coreError(`Host session ${hostSessionId} is outside Project ${expectedProjectId}`, 'PROJECT_CORE_FOREIGN_SOURCE')
      }
      throw coreError(`Project host session does not exist: ${hostSessionId}`, 'PROJECT_CORE_MISSING_SESSION')
    }
    const session = { ...logical, hostSessionId, sourceLifecycle: carrier.sourceLifecycle, ownedLifecycle: carrier.ownedLifecycle }
    this.assertSourceAdmitting(hostSessionId)
    const scope = await this.workspaceScope(hostSessionId)
    return {
      ...project,
      session,
      hostSessionId,
      role: session.role,
      workingDirectory: scope.workspaceRoot,
      workspaceRoot: scope.workspaceRoot,
    }
  }

  /**
   * Resolve exactly the live Agent that initiated this tool invocation.
   * No Work, stopped-state, or direct-user condition is required for access.
   */
  async forTool(exec: ToolRunContext, toolName: string): Promise<ProjectCoreToolScope> {
    const agent = exec.agent
    if (agent === undefined
      || this.ctx.agents.get(agent.id) !== agent
      || agent.status !== 'running'
      || this.ctx.agents.currentInitiator() !== agent) {
      throw coreError(
        `${toolName} requires the exact live Project Agent in its active driver`,
        'PROJECT_CORE_TOOL_CONTEXT_UNAVAILABLE',
      )
    }

    const persistence = this.ctx.get('sessionPersistence') as { resolveOwner?(id: SessionId): Promise<{ projectId: string; logicalSessionId: string } | undefined> } | undefined
    const owner = await persistence?.resolveOwner?.(agent.id)
    const binding = owner === undefined ? await this.store.findCarrierByHostSessionId(String(agent.id))
      : await this.store.resolveHostOwnership(String(agent.id), owner)
    const membership = binding === undefined || 'kind' in binding && binding.kind === 'preparation'
      || !binding.carrier.isCurrent || binding.carrier.closed !== undefined || binding.carrier.sourceLifecycle.kind !== 'available' ? undefined : binding
    if (membership === undefined) {
      throw coreError(`${toolName} is not running for a Project session`, 'PROJECT_CORE_MISSING_SESSION')
    }
    const session = await this.forHostSession(membership.project.id, String(agent.id))
    const currentCarrier = sessionCarrier(session.session, String(agent.id))
    if (session.session.id !== membership.session.id || currentCarrier?.isCurrent !== true || currentCarrier.closed !== undefined) {
      throw coreError(`${toolName} Project session binding changed during invocation`, 'PROJECT_CORE_MISSING_SESSION')
    }

    const boundary = this.ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')
    if (boundary === undefined || boundary.openTurnStartSeq === null) {
      throw coreError(`${toolName} requires an open Project turn`, 'PROJECT_CORE_TOOL_CONTEXT_UNAVAILABLE')
    }

    const invocationSources: SourceRef[] = []
    const events = agent.session.snapshotEvents(SessionLogOffset(boundary.openTurnStartSeq + 1))
    for (const event of events) {
      if (event?.type !== 'user/message') continue
      // `project-delivery` is a Projects-owned source extension, so DSH's
      // closed native source union cannot name it directly here.
      const sourceKind = (event.data.source as { readonly kind: string }).kind
      if (sourceKind !== 'user' && sourceKind !== 'project-delivery' && sourceKind !== 'project-schedule'
        && sourceKind !== 'goal' && sourceKind !== 'project-execution-failure') continue
      invocationSources.push(agent.session.header === undefined ? { kind: 'message', hostSessionId: String(agent.id), messageId: event.data.id }
        : mintNativeProjectSource({ projectId: session.project.id, sessionId: session.session.id, hostSessionId: String(agent.id),
          sessionCreatedAt: agent.session.header.createdAt, formatVersion: agent.session.header.version }, event, event, { messageId: String(event.data.id) }))
    }
    const invocation = this.invocations.get(exec)
    const call = invocation === undefined ? undefined : agent.session.eventAt(invocation.startEventSeq)
    const actual = invocation !== undefined && invocation.sessionId === agent.id
      && invocation.sessionCreatedAt === agent.session.header.createdAt && invocation.startEventSeq >= agent.session.inheritedEventCount
      && call?.seq === invocation.startEventSeq
      && (call.type === 'tool/call' && call.data.name === exec.name && call.data.callId === invocation.callId && invocation.rootCallId === invocation.callId
        || call.type === 'tool/ptc-dispatch-start' && call.data.name === exec.name && call.data.subCallId === invocation.callId && call.data.rootCallId === invocation.rootCallId)
    if (!actual || call === undefined) throw coreError(`${toolName} has no exact own tool-start occurrence`, 'PROJECT_CORE_TOOL_CONTEXT_UNAVAILABLE')
    invocationSources.push(mintNativeProjectSource({ projectId: session.project.id, sessionId: session.session.id, hostSessionId: String(agent.id),
      sessionCreatedAt: agent.session.header.createdAt, formatVersion: agent.session.header.version }, call, call, { toolCallId: String(exec.callId) }))

    return { ...session, invocationSources: uniqueSources(invocationSources) }
  }

  /** Retained identity remains authoritative after a source exits operational membership. */
  readSessionSource(hostSessionId: string, projectId?: string): Promise<ProjectSessionSource | undefined> {
    return this.store.findSessionSourceByHostSessionId(hostSessionId, projectId === undefined ? undefined : { projectId })
  }

  /** Internal read-only event bridge; retained scope is rechecked before publication. */
  readNativePrefix(projectId: string, hostSessionId: string, signal?: AbortSignal) {
    return readRetainedProjectNativePrefix(this.ctx, projectId, hostSessionId,
      id => this.readSessionSource(id, projectId), { signal, assertAdmitting: this.assertSourceAdmitting })
  }

  /** Narrow retained observation for scoped history, manager and saved communication reads. */
  readNativeDirectory(projectId: string, hostSessionId: string, signal?: AbortSignal) {
    return readRetainedProjectNativeDirectory(this.ctx, projectId, hostSessionId,
      id => this.readSessionSource(id, projectId), { signal, assertAdmitting: this.assertSourceAdmitting })
  }

  /** Same retained scope and deletion cut for exact native and independently saved communication parts. */
  async readCommunicationSource(projectId: string, source: CommunicationSource,
    selectedBy: CommunicationPartV1['selectedBy'], signal?: AbortSignal) {
    await this.forProject(projectId)
    const transcript = new CommunicationTranscript(this.ctx, (project, host, readSignal) => this.readNativeDirectory(project, host, readSignal))
    return new CommunicationVisibleReader({ readDirectory: (project, host, readSignal) => this.readNativeDirectory(project, host, readSignal),
      readSnapshot: (project, record, readSignal) => transcript.readSnapshot(project, record, readSignal),
      verifyAttachment: communicationAttachmentVerifier(this.ctx) }).readSelected(projectId, source, selectedBy, signal)
  }

  /** 精确来源只允许本项目原生消息／工具，不要求预先登记。 */
  async readSource(projectId: string, source: SourceRef, signal?: AbortSignal,
    options: Pick<NativeProjectSourceReadOptions, 'before' | 'after'> = {}): Promise<ProjectCoreSourceRead> {
    signal?.throwIfAborted()
    await this.forProject(projectId)
    source = decodeNativeProjectSource(source)
    if (source.kind === 'native-event' && source.projectId !== projectId) {
      throw coreError('Native source belongs to another Project.', 'PROJECT_CORE_FOREIGN_SOURCE')
    }
    if (source.kind !== 'message' && source.kind !== 'tool' && source.kind !== 'native-event') {
      throw coreError('当前来源只接受原生消息或工具定位。', 'PROJECT_CORE_UNAVAILABLE_SOURCE')
    }
    const retained = await this.readSessionSource(source.hostSessionId, projectId)
    if (retained?.projectId !== projectId) {
      throw coreError(`Native source is outside Project ${projectId}`, 'PROJECT_CORE_FOREIGN_SOURCE')
    }
    if (retained.sourceLifecycle.kind === 'available' && (retained.role === 'main' || retained.role === 'execution')) {
      this.assertSourceAdmitting(source.hostSessionId)
    }
    const native = await readRetainedProjectSource(this.ctx, projectId, source,
      id => this.readSessionSource(id, projectId), { ...options, signal, assertAdmitting: this.assertSourceAdmitting })
    if (!native.resolved) return {
      projectId, source, readable: false, isUserDecision: false,
      reason: native.reason ?? '原始来源当前不可读。', nativeItems: native.items,
      ...(native.partial === undefined ? {} : { partial: native.partial }),
      ...(native.limitations === undefined ? {} : { limitations: native.limitations }),
    }
    const targets = native.items.filter(item => item.isTarget)
    return {
      projectId, source: targets[0]?.nativeSource ?? source, readable: true,
      isUserDecision: targets.some(item => item.role === 'user' && item.sourceKind === 'user'),
      ...(targets[0]?.sourceKind === undefined ? {} : { producer: targets[0].sourceKind }),
      ...(targets.length === 0 ? {} : { text: targets.map(item => item.text).join('\n') }),
      ...(native.reason === undefined ? {} : { reason: native.reason }), nativeItems: native.items,
      ...(native.partial === undefined ? {} : { partial: native.partial }),
      ...(native.limitations === undefined ? {} : { limitations: native.limitations }),
    }
  }

  /** 仅服务旧 Memory 显式查看来源；不返回旧台账正文或当前用户决定。 */
  async readLegacySource(projectId: string, source: LegacySourceReference, signal?: AbortSignal) {
    signal?.throwIfAborted()
    await this.forProject(projectId)
    const historical = await this.store.readLegacySourceLocators(projectId, source)
    for (const locator of historical.sources) {
      signal?.throwIfAborted()
      const membership = await this.readSessionSource(locator.hostSessionId, projectId)
      if (membership?.projectId !== projectId
        || (membership.role !== 'main' && membership.role !== 'execution')) continue
      return { projectId, readable: false, isUserDecision: false, reason: historical.reason, nativeLocator: locator }
    }
    return { projectId, readable: false, isUserDecision: false,
      reason: `${historical.reason}；没有仍属于本项目的可核对原生定位。` }
  }

  /** Require the exact original native user message, excluding deliveries and adjacent context. */
  async requireOriginalUser(
    projectId: string,
    source: Extract<SourceRef, { kind: 'message' | 'native-event' }>,
    signal?: AbortSignal,
  ): Promise<ProjectCoreOriginalUser> {
    const result = await this.readSource(projectId, source, signal, { before: 0, after: 0 })
    if (!result.readable) {
      throw coreError(
        result.reason ?? 'original user message is unavailable',
        'PROJECT_CORE_UNAVAILABLE_SOURCE',
      )
    }
    const target = result.nativeItems?.find(item =>
      item.isTarget && item.role === 'user' && item.sourceKind === 'user')
    if (!result.isUserDecision || target === undefined) {
      throw coreError('source is not the exact original user message', 'PROJECT_CORE_NOT_ORIGINAL_USER')
    }
    if (target.visibleComplete === false) throw coreError('original user message has unreadable visible content', 'PROJECT_CORE_UNAVAILABLE_SOURCE')
    const membership = await this.assertNativeSourceMembership(projectId, source.hostSessionId)
    return {
      source: target.nativeSource?.kind === 'native-event' ? target.nativeSource : source,
      quote: target.text,
      time: eventTime(target.time),
      sessionId: membership.session.id,
      ...(target.visibleBlocks === undefined ? {} : { visibleBlocks: target.visibleBlocks }),
    }
  }

  /** Thin delegation to DSH workspaceFiles after confirming Project membership. */
  async readBytes(input: {
    readonly hostSessionId: string
    readonly path: string
    readonly signal?: AbortSignal
  }): Promise<ProjectCoreFileBytes> {
    const scope = await this.workspaceScopeForProjectHost(input.hostSessionId)
    const result = await this.ctx.workspaceFiles.readBytes(
      scope,
      input.path,
      {},
      input.signal ?? new AbortController().signal,
    )
    return { data: result.data, absolutePath: result.absolutePath }
  }

  /** Thin delegation to DSH workspaceFiles after confirming Project membership. */
  async listDirectory(input: {
    readonly hostSessionId: string
    readonly path: string
    readonly signal?: AbortSignal
  }): Promise<ProjectCoreDirectoryListing> {
    const scope = await this.workspaceScopeForProjectHost(input.hostSessionId)
    const result = await this.ctx.workspaceFiles.list(
      scope,
      input.path,
      input.signal ?? new AbortController().signal,
    )
    return { entries: result.entries, truncated: result.truncated }
  }

  /** 目录根来自项目 owner；不改 Session cwd 或普通 workspaceFiles.list 的目录边界。 */
  async listProjectDirectory(input: {
    readonly scope: LibraryScope
    readonly relativePath: string
    readonly signal?: AbortSignal
  }): Promise<ProjectCoreDirectoryListing & { readonly absolutePath: string }> {
    const signal = input.signal ?? new AbortController().signal
    signal.throwIfAborted()
    const scope = await this.forHostSession(input.scope.projectId, input.scope.hostSessionId)
    if (scope.session.id !== input.scope.sessionId) throw coreError('文件目录承载不属于指定逻辑会话。', 'PROJECT_CORE_FOREIGN_SOURCE')
    const relativePath = input.relativePath.replace(/\\/g, '/')
    if (isAbsolute(relativePath) || /^[a-z][a-z\d+.-]*:/i.test(relativePath) || relativePath.includes('\0')) {
      throw coreError('项目文件目录必须使用项目根下的相对路径。', 'PROJECT_CORE_FILE_SCOPE_UNAVAILABLE')
    }
    const root = await this.ctx.fs.resolve(scope.projectFilesRoot, { signal })
    const target = await this.ctx.fs.resolve(relativePath || '.', { cwd: scope.projectFilesRoot, signal })
    if (!this.ctx.fs.contains(root, target)) {
      throw coreError('项目目录定位超出项目文件根。', 'PROJECT_CORE_FILE_SCOPE_UNAVAILABLE')
    }
    const info = await this.ctx.fs.stat(target, signal)
    signal.throwIfAborted()
    // 外部工作区项目可尚未实体化自有文件区；缺失的逻辑根确实为空。
    // 只处理可信根，缺失子目录、错误类型及读取失败仍按真实错误返回。
    if (relativePath === '' && info === undefined) return {
      absolutePath: this.ctx.fs.processPath(target), entries: [], truncated: false,
    }
    if (info?.type !== 'directory') throw coreError('项目文件目录不存在或不是目录。', 'PROJECT_CORE_FILE_SCOPE_UNAVAILABLE')
    // 读取实际服务提供者的已校验配置，避免另一份目录上限与宿主配置分叉。
    const config: unknown = this.ctx.reflect._getImpl('workspaceFiles')?.fiber.config
    const limit = typeof config === 'object' && config !== null && 'maxEntries' in config ? config.maxEntries : undefined
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) {
      throw coreError('宿主目录读取上限当前不可得。', 'PROJECT_CORE_FILE_SCOPE_UNAVAILABLE')
    }
    const children = await this.ctx.fs.listDir(target, signal)
    signal.throwIfAborted()
    return {
      absolutePath: this.ctx.fs.processPath(target), truncated: children.length > limit,
      entries: children.slice(0, limit).map(item => ({ name: item.name, type: item.type,
        ...(item.size === undefined ? {} : { size: item.size }) })),
    }
  }

  /** An explicit non-chat user actor for the already-validated settings bridge. */
  async forSettingsUser(projectId: string): Promise<ProjectCoreSettingsUser> {
    const project = await this.forProject(projectId)
    return {
      projectId: project.project.id,
      projectDirectory: project.projectRoot,
      actorId: 'project-settings-user',
    }
  }

  private projectView(snapshot: ProjectSnapshot): ProjectCoreProjectView {
    return {
      project: snapshot.project,
      snapshot,
      projectRoot: join(this.dataRoot, snapshot.project.id),
      projectFilesRoot: join(this.dataRoot, snapshot.project.id, 'artifacts'),
      ...(snapshot.project.workspace === undefined ? {} : { configuredWorkspace: snapshot.project.workspace.path }),
    }
  }

  private async assertNativeSourceMembership(projectId: string, hostSessionId: string): Promise<ProjectMembership> {
    const ownership = await this.store.resolveHostOwnership(hostSessionId, { projectId })
    const binding = ownership?.kind === 'preparation' ? undefined : ownership
    const membership = binding === undefined || binding.carrier.sourceLifecycle.kind !== 'available' ? undefined : { project: binding.project,
      session: { ...binding.session, hostSessionId, sourceLifecycle: binding.carrier.sourceLifecycle, ownedLifecycle: binding.carrier.ownedLifecycle } }
    if (membership === undefined || membership.project.id !== projectId) {
      throw coreError(`Native source is outside Project ${projectId}`, 'PROJECT_CORE_FOREIGN_SOURCE')
    }
    this.assertSourceAdmitting(hostSessionId)
    return membership
  }

  private async workspaceScopeForProjectHost(hostSessionId: string) {
    const membership = await this.store.findCarrierByHostSessionId(hostSessionId)
    if (membership === undefined || membership.carrier.sourceLifecycle.kind !== 'available') {
      throw coreError(`Project host session does not exist: ${hostSessionId}`, 'PROJECT_CORE_MISSING_SESSION')
    }
    this.assertSourceAdmitting(hostSessionId)
    return this.workspaceScope(hostSessionId)
  }

  private async workspaceScope(hostSessionId: string) {
    const lookup = this.ctx.typert.lookups.get('workspaceFileScope')
    if (lookup === undefined) {
      throw coreError('DSH workspaceFileScope lookup is unavailable', 'PROJECT_CORE_FILE_SCOPE_UNAVAILABLE')
    }
    try {
      const scope = await lookup.resolve(SessionId(hostSessionId)) as WorkspaceFileScope | null | undefined
      if (scope === undefined || scope === null) {
        throw coreError(`DSH workspace scope is unavailable for ${hostSessionId}`, 'PROJECT_CORE_FILE_SCOPE_UNAVAILABLE')
      }
      return scope
    } catch (error: unknown) {
      if (error instanceof ProjectsCoreAccessError) throw error
      throw coreError(
        `DSH workspace scope is unavailable for ${hostSessionId}: ${errorMessage(error)}`,
        'PROJECT_CORE_FILE_SCOPE_UNAVAILABLE',
        { cause: error },
      )
    }
  }


}

function coreError(
  message: string,
  code: ProjectsCoreErrorCode | 'PROJECT_CORE_TOOL_CONTEXT_UNAVAILABLE',
  options?: ErrorOptions,
): ProjectsCoreAccessError {
  return new ProjectsCoreAccessError(message, code, options)
}

function uniqueSources(sources: readonly SourceRef[]): SourceRef[] {
  const keys = new Set<string>()
  return sources.filter(source => {
    const key = sourceKey(source)
    if (keys.has(key)) return false
    keys.add(key)
    return true
  })
}

function sourceKey(source: SourceRef): string { return nativeProjectSourceKey(source) }

function sessionCarrier(session: ProjectSession, hostSessionId: string): ProjectSessionCarrier | undefined {
  return session.carriers?.find(carrier => carrier.hostSessionId === hostSessionId)
    ?? (session.carriers === undefined && session.hostSessionId === hostSessionId
      ? { sequence: 1, hostSessionId, isCurrent: true, sourceLifecycle: session.sourceLifecycle,
        ...(session.ownedLifecycle === undefined ? {} : { ownedLifecycle: session.ownedLifecycle }) }
      : undefined)
}

function eventTime(time: number): string {
  const date = new Date(time)
  return Number.isNaN(date.getTime()) ? String(time) : date.toISOString()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
