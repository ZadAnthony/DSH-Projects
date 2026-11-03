import { realpath } from 'node:fs/promises'
import { ProjectSettingsStore, SessionInstructionsReadError, modelSelection } from './store.ts'
import type {
  DefaultSelectionStatus, ExecutionDefaults, ExecutionDefaultsView, ModelCatalog, ModelSelection, NewExecutionDefaults,
  PreparedProjectInstructions, PreparedSessionInstructions, ProjectInstructionContext, ProjectInstructions, ProjectInstructionsDeletionCut,
  SessionInstructionContext, SessionInstructions, SessionInstructionsInitialization, SessionInstructionsCreation, ExistingSessionInstructionsInitialization, SessionInstructionsDeletionCut, SettingsCatalogRead, SettingsCorePort,
  SettingsModelPort, SettingsProjectAccess, SettingsProjectRequest, SettingsSessionAccess, SettingsSessionRequest, SettingsWriteResult,
} from './types.ts'

interface InstructionSlot { context: SessionInstructionContext }
interface ProjectInstructionSlot { context: ProjectInstructionContext }

export class ProjectSettingsService {
  private readonly instructionSlots = new Map<string, InstructionSlot>()
  private readonly projectInstructionSlots = new Map<string, ProjectInstructionSlot>()
  private readonly instructionOperations = new Map<string, Set<Promise<void>>>()
  private readonly instructionDeletionCuts = new Set<string>()
  private readonly retiredInstructions = new Set<string>()
  constructor(private readonly core: SettingsCorePort, private readonly models: SettingsModelPort, private readonly sessionInstructionAdmission?: (request: SettingsSessionRequest) => (() => void) | undefined) {}

  async readExecutionDefaults(request: SettingsProjectRequest): Promise<ExecutionDefaultsView> {
    const access = await this.project(request)
    const defaults = await this.store(access).readDefaults()
    const catalog = await this.catalog(request.signal)
    return { defaults, catalog, status: defaults.selection === null ? { kind: 'inherit' } : this.selectionStatus(defaults.selection, catalog) }
  }

  async saveExecutionDefaults(request: SettingsProjectRequest, selection: ModelSelection | null, expectedRevision: number): Promise<SettingsWriteResult<ExecutionDefaults>> {
    const access = await this.project(request)
    const next = selection === null ? null : modelSelection(selection)
    if (next !== null) {
      const status = this.selectionStatus(next, await this.catalog(request.signal))
      if (status.kind === 'unavailable') return { kind: 'unavailable', message: status.message }
    }
    return this.core.withMetadataWrite(request, access, 'save',
      scope => this.store(access).saveDefaultsWithin(scope, next, expectedRevision, request.signal))
  }

  /** 核心仅在新建执行会话时调用；已有会话不读取本项目默认作为当前模型。 */
  async prepareNewExecution(request: SettingsProjectRequest): Promise<NewExecutionDefaults> {
    const access = await this.project(request)
    const defaults = await this.store(access).readDefaults()
    if (defaults.selection === null) return { kind: 'inherit', projectId: access.projectId, revision: defaults.revision }
    const status = this.selectionStatus(defaults.selection, await this.catalog(request.signal))
    if (status.kind === 'unavailable') return { kind: 'unavailable', projectId: access.projectId, revision: defaults.revision, message: status.message }
    return { kind: 'configured', projectId: access.projectId, revision: defaults.revision, selection: structuredClone(defaults.selection) }
  }

  async readProjectInstructions(request: SettingsProjectRequest): Promise<ProjectInstructions> {
    return this.projectInstructionOperation(request, async () => {
      const access = await this.projectInstructionsAccess(request)
      return this.loadProjectInstructions(access)
    })
  }

  async saveProjectInstructions(request: SettingsProjectRequest, instructions: string, expectedRevision: number): Promise<SettingsWriteResult<ProjectInstructions>> {
    return this.projectInstructionOperation(request, async () => {
      const access = await this.projectInstructionsAccess(request)
      try {
        const result = await this.core.withMetadataWrite(request, access, 'save',
          scope => this.store(access).saveProjectInstructionsWithin(scope, instructions, expectedRevision, request.signal))
        if (result.kind !== 'unavailable') this.updateProjectInstructions(access, result.kind === 'saved' ? result.value : result.current)
        return result
      } catch (error) { await this.refreshProjectInstructions(access); throw error }
    })
  }

  /** 本项目全部工作会话共用同一正文；实际会话归属仍由调用方的原入口核实。 */
  async prepareProjectInstructions(request: SettingsProjectRequest): Promise<PreparedProjectInstructions> {
    return this.projectInstructionOperation(request, async () => {
      const access = await this.projectInstructionsAccess(request)
      const slot = this.projectSlot(access)
      await this.refreshProjectInstructions(access)
      return {
        get: () => structuredClone(slot.context),
        render: () => renderProjectInstructions(slot.context),
        refresh: async () => { await this.readProjectInstructions({ projectId: access.projectId }) },
      }
    })
  }

  prepareProjectInstructionsDeletion(projectId: string): ProjectInstructionsDeletionCut {
    const key = projectInstructionTarget({ projectId })
    if (this.instructionDeletionCuts.has(key)) throw new Error('项目指令已有待决删除操作。')
    this.instructionDeletionCuts.add(key)
    const drained = settleInstructionOperations(this.instructionOperations.get(key))
    let pending = true
    const consume = () => {
      if (!pending) throw new Error('项目指令删除操作已提交或释放。')
      pending = false
      this.instructionDeletionCuts.delete(key)
    }
    return {
      drained,
      commit: () => {
        consume()
        this.retiredInstructions.add(key)
        this.invalidateProjectInstructions({ projectId }, new Error('来源项目已删除，项目指令不可用。'))
      },
      release: consume,
    }
  }

  async readSessionInstructions(request: SettingsSessionRequest): Promise<SessionInstructions> {
    return this.instructionOperation(request, async () => {
      const access = await this.session(request)
      return this.loadInstructions(access)
    })
  }

  /** 创建或旧会话首次安装时调用；普通请求准备始终只读当前保存值。 */
  async initializeSessionInstructions(request: SettingsSessionRequest, instructions: string): Promise<SessionInstructionsInitialization> {
    return this.instructionOperation(request, async () => {
      const access = await this.session(request)
      try {
        const result = await this.core.withMetadataWrite(request, access, 'initialize',
          scope => this.store(access).initializeInstructionsWithin(scope, access.sessionId, instructions, request.signal))
        this.updateInstructions(access, result.value)
        return result
      } catch (error) { await this.refreshInstructions(access); throw error }
    })
  }

  /**
   * 原创建接纳期间捕获真实access；回滚不重新打开已封口的普通设置入口。
   * caller须先证明原生会话未物化；existing或后写值不归本次撤销，真实I/O失败仍拒绝。
   */
  async prepareSessionInstructionsCreation(request: SettingsSessionRequest, instructions: string): Promise<SessionInstructionsCreation> {
    return this.instructionOperation(request, async () => {
      const access = await this.session(request)
      const store = this.store(access)
      let initialization: SessionInstructionsInitialization
      try {
        initialization = await this.core.withMetadataWrite(request, access, 'initialize',
          scope => store.initializeInstructionsWithin(scope, access.sessionId, instructions, request.signal))
        this.updateInstructions(access, initialization.value)
      } catch (error) { await this.refreshInstructions(access); throw error }
      const initial = structuredClone(initialization.value)
      const ownsInitialization = initialization.kind === 'initialized'
      let discarded: Promise<boolean> | undefined
      return {
        initialization,
        discardUncreated: () => discarded ??= (async () => {
          if (!ownsInitialization) return false
          try {
            const removed = await this.core.withMetadataWrite({ ...request, signal: undefined }, access, 'discard',
              scope => store.discardInitializedInstructionsWithin(scope, initial))
            await this.loadInstructions(access)
            return removed
          } catch (error) { this.invalidateInstructions(access, error); throw error }
        })(),
      }
    })
  }

  /** 旧会话来源不可读只撤下该指令；真实归属、生命周期、取消与保存失败仍拒绝。 */
  async initializeExistingSessionInstructions(request: SettingsSessionRequest, instructions: string): Promise<ExistingSessionInstructionsInitialization> {
    try { return await this.initializeSessionInstructions(request, instructions) }
    catch (error) {
      request.signal?.throwIfAborted()
      if (!(error instanceof SessionInstructionsReadError)) throw error
      return { kind: 'unavailable', message: errorText(error) }
    }
  }

  async discardInitializedSessionInstructions(request: SettingsSessionRequest, initial: SessionInstructions): Promise<boolean> {
    return this.instructionOperation(request, async () => {
      const access = await this.session(request)
      if (initial.sessionId !== access.sessionId) throw new Error('初始指令不属于该会话。')
      try {
        const removed = await this.core.withMetadataWrite(request, access, 'discard',
          scope => this.store(access).discardInitializedInstructionsWithin(scope, initial))
        await this.refreshInstructions(access)
        return removed
      } catch (error) { await this.refreshInstructions(access); throw error }
    })
  }

  async saveSessionInstructions(request: SettingsSessionRequest, instructions: string, expectedRevision: number): Promise<SettingsWriteResult<SessionInstructions>> {
    const release = this.sessionInstructionAdmission?.(request)
    try { return await this.instructionOperation(request, async () => {
      const access = await this.session(request)
      try {
        const result = await this.core.withMetadataWrite(request, access, 'save',
          scope => this.store(access).saveInstructionsWithin(scope, access.sessionId, instructions, expectedRevision, request.signal))
        if (result.kind !== 'unavailable') this.updateInstructions(access, result.kind === 'saved' ? result.value : result.current)
        return result
      } catch (error) { await this.refreshInstructions(access); throw error }
    }) } finally { release?.() }
  }

  /** 首次/继续时异步读取；宿主同步组装只调用返回的 render/get。 */
  async prepareSessionInstructions(request: SettingsSessionRequest): Promise<PreparedSessionInstructions> {
    return this.instructionOperation(request, async () => {
      const access = await this.session(request)
      const slot = this.slot(access)
      await this.refreshInstructions(access)
      return {
        get: () => structuredClone(slot.context),
        render: () => renderSessionInstructions(slot.context),
        refresh: () => this.instructionOperation(access, () => this.refreshInstructions(access)),
      }
    })
  }

  prepareSessionInstructionsDeletion(projectId: string, sessionId: string): SessionInstructionsDeletionCut {
    const target = { projectId, sessionId }
    const key = instructionTarget(target)
    if (this.instructionDeletionCuts.has(key)) throw new Error('单会话指令已有待决删除操作。')
    this.instructionDeletionCuts.add(key)
    const drained = settleInstructionOperations(this.instructionOperations.get(key))
    let pending = true
    const consume = () => {
      if (!pending) throw new Error('单会话指令删除操作已提交或释放。')
      pending = false
      this.instructionDeletionCuts.delete(key)
    }
    return {
      drained,
      commit: () => {
        consume()
        this.retiredInstructions.add(key)
        this.invalidateInstructions(target, new Error('来源会话已删除，单会话持续指令不可用。'))
        return { remove: async () => {
          await drained
          // 冷 partial 的 session access 已不可用；清理只需既有项目根和精确会话路径。
          const access = await this.project({ projectId })
          return this.core.withMetadataWrite({ projectId, sessionId } as SettingsSessionRequest, access, 'cleanup',
            scope => this.store(access).removeInstructionsWithin(scope, sessionId))
        } }
      },
      release: consume,
    }
  }

  private instructionOperation<T>(target: SettingsSessionRequest, operation: () => Promise<T>): Promise<T> {
    const key = instructionTarget(target)
    return this.scopedInstructionOperation(key, '来源会话已删除，单会话持续指令不可用。', '单会话持续指令正在删除，暂不接受读取或修改。', operation)
  }

  private projectInstructionOperation<T>(target: SettingsProjectRequest, operation: () => Promise<T>): Promise<T> {
    return this.scopedInstructionOperation(projectInstructionTarget(target), '来源项目已删除，项目指令不可用。', '项目指令正在删除，暂不接受读取或修改。', operation)
  }

  private scopedInstructionOperation<T>(key: string, unavailable: string, deleting: string, operation: () => Promise<T>): Promise<T> {
    if (this.retiredInstructions.has(key)) return Promise.reject(new Error(unavailable))
    if (this.instructionDeletionCuts.has(key)) return Promise.reject(new Error(deleting))
    const completion=Promise.withResolvers<void>()
    const settled=completion.promise;void settled.catch(()=>{})
    let operations = this.instructionOperations.get(key)
    if (operations === undefined) { operations = new Set(); this.instructionOperations.set(key, operations) }
    operations.add(settled)
    return (async () => {
      try { const result=await operation();completion.resolve();return result } catch(error){completion.reject(error);throw error} finally {
        operations.delete(settled)
        if (operations.size === 0) this.instructionOperations.delete(key)
      }
    })()
  }

  private async catalog(signal?: AbortSignal): Promise<SettingsCatalogRead> {
    signal?.throwIfAborted()
    try {
      const catalog = await this.models.modelCatalog(signal)
      signal?.throwIfAborted()
      return { kind: 'available', catalog: structuredClone(catalog), readAt: new Date().toISOString() }
    } catch (error) {
      signal?.throwIfAborted()
      return { kind: 'unavailable', message: errorText(error), readAt: new Date().toISOString() }
    }
  }

  private selectionStatus(selection: ModelSelection, catalog: SettingsCatalogRead): DefaultSelectionStatus {
    if (catalog.kind === 'unavailable') return { kind: 'unavailable', message: 'DSH 模型目录当前不可用：' + catalog.message }
    return validateCatalogSelection(catalog.catalog, selection)
  }

  private async project(request: SettingsProjectRequest): Promise<SettingsProjectAccess> {
    request.signal?.throwIfAborted()
    const access = await this.core.resolveProject(request)
    request.signal?.throwIfAborted()
    if (access.projectId !== request.projectId) throw new Error('设置项目归属不匹配。')
    return { ...access, projectDirectory: await realpath(access.projectDirectory) }
  }

  private async session(request: SettingsSessionRequest): Promise<SettingsSessionAccess> {
    request.signal?.throwIfAborted()
    try {
      const access = await this.core.resolveSession(request)
      request.signal?.throwIfAborted()
      if (access.projectId !== request.projectId || access.sessionId !== request.sessionId || !access.hostSessionId) throw new Error('设置会话归属不匹配。')
      return { ...access, projectDirectory: await realpath(access.projectDirectory) }
    } catch (error) {
      this.invalidateInstructions(request, error)
      throw error
    }
  }

  private store(access: SettingsProjectAccess): ProjectSettingsStore {
    return new ProjectSettingsStore(access.projectId, access.projectDirectory)
  }

  private async projectInstructionsAccess(request: SettingsProjectRequest): Promise<SettingsProjectAccess> {
    try { return await this.project(request) }
    catch (error) { this.invalidateProjectInstructions(request, error); throw error }
  }

  private projectSlot(access: SettingsProjectAccess): ProjectInstructionSlot {
    const key = JSON.stringify([access.projectId, access.projectDirectory])
    let slot = this.projectInstructionSlots.get(key)
    if (slot === undefined) { slot = { context: { projectId: access.projectId, available: false,
      message: this.retiredInstructions.has(projectInstructionTarget(access)) ? '来源项目已删除，项目指令不可用。' : '项目指令尚未读取。' } }; this.projectInstructionSlots.set(key, slot) }
    return slot
  }

  private updateProjectInstructions(access: SettingsProjectAccess, value: ProjectInstructions, previous?: ProjectInstructionContext): void {
    if (this.retiredInstructions.has(projectInstructionTarget(access))) return
    const slot = this.projectSlot(access)
    if (!shouldPublishInstructionValue(slot.context, value.revision, previous)) return
    slot.context = { projectId: access.projectId, available: true, value: structuredClone(value) }
  }

  private invalidateProjectInstructions(target: SettingsProjectRequest, error: unknown): void {
    for (const slot of this.projectInstructionSlots.values()) {
      if (slot.context.projectId !== target.projectId) continue
      slot.context = { projectId: target.projectId, available: false, message: errorText(error) }
    }
  }

  private async loadProjectInstructions(access: SettingsProjectAccess): Promise<ProjectInstructions> {
    const previous = this.projectSlot(access).context
    try {
      const value = await this.store(access).readProjectInstructions()
      this.updateProjectInstructions(access, value, previous)
      return value
    } catch (error) { this.invalidateProjectInstructions(access, error); throw error }
  }

  private async refreshProjectInstructions(access: SettingsProjectAccess): Promise<void> {
    try { await this.loadProjectInstructions(access) } catch { /* 失败时只提供不可读事实，不沿用旧正文。 */ }
  }

  private slot(access: SettingsSessionAccess): InstructionSlot {
    const key = `${access.projectId}\n${access.projectDirectory}\n${access.sessionId}`
    let slot = this.instructionSlots.get(key)
    if (slot === undefined) { slot = { context: { projectId: access.projectId, sessionId: access.sessionId, available: false,
      message: this.retiredInstructions.has(instructionTarget(access)) ? '来源会话已删除，单会话持续指令不可用。' : '单会话指令尚未读取。' } }; this.instructionSlots.set(key, slot) }
    return slot
  }

  private updateInstructions(access: SettingsSessionAccess, value: SessionInstructions, previous?: SessionInstructionContext): void {
    if (this.retiredInstructions.has(instructionTarget(access))) return
    const slot = this.slot(access)
    if (!shouldPublishInstructionValue(slot.context, value.revision, previous)) return
    slot.context = { projectId: access.projectId, sessionId: access.sessionId, available: true, value: structuredClone(value) }
  }

  private invalidateInstructions(target: SettingsSessionRequest, error: unknown): void {
    // 解析失败时没有可信目录；只按既有投影里已核实的项目/会话定位撤下正文，不创建新槽。
    for (const slot of this.instructionSlots.values()) {
      if (slot.context.projectId !== target.projectId || slot.context.sessionId !== target.sessionId) continue
      slot.context = { projectId: slot.context.projectId, sessionId: slot.context.sessionId, available: false, message: errorText(error) }
    }
  }

  private async loadInstructions(access: SettingsSessionAccess): Promise<SessionInstructions> {
    const previous = this.slot(access).context
    try {
      const value = await this.store(access).readInstructions(access.sessionId)
      this.updateInstructions(access, value, previous)
      return value
    } catch (error) {
      this.invalidateInstructions(access, error)
      throw error
    }
  }

  private async refreshInstructions(access: SettingsSessionAccess): Promise<void> {
    try { await this.loadInstructions(access) } catch { /* 同步提供器显示读取限制，不沿用旧正文。 */ }
  }
}

export function validateCatalogSelection(catalog: ModelCatalog, selection: ModelSelection): DefaultSelectionStatus {
  const provider = catalog.groups.find(item => item.id === selection.provider)
  const model = provider?.models.find(item => item.id === selection.model)
  if (model === undefined || !catalog.routableProviders.includes(selection.provider)) {
    const failure = catalog.failures.find(item => item.id === selection.provider)
    return { kind: 'unavailable', message: failure === undefined ? '所选模型当前不在 DSH 可用目录中；未替换已保存配置。' : '该提供者的模型目录不可用：' + failure.message }
  }
  if (selection.reasoningEffort !== undefined && !model.reasoning?.efforts.some(item => item.id === selection.reasoningEffort)) {
    return { kind: 'unavailable', message: '所选推理选项当前不受该模型支持；未替换已保存配置。' }
  }
  return { kind: 'available' }
}

export function renderSessionInstructions(context: SessionInstructionContext): string {
  if (!context.available || context.value === undefined) return '本会话持续指令当前不可读，不能沿用旧投影声称取得最新指令：' + (context.message ?? '尚未读取。')
  return context.value.instructions
}
export function renderProjectInstructions(context: ProjectInstructionContext): string {
  if (!context.available || context.value === undefined) return '本项目显式指令当前不可读，不能沿用旧投影声称取得最新指令：' + (context.message ?? '尚未读取。')
  return context.value.instructions
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
/** An unlocked read must not undo a publication that settled while its I/O was pending. */
function shouldPublishInstructionValue(current: ProjectInstructionContext, revision: number, previous?: ProjectInstructionContext): boolean {
  if (previous === current) return true
  if (previous !== undefined) return current.available && current.value !== undefined && revision > current.value.revision
  return current.value === undefined || revision >= current.value.revision
}
/** A failed accepted operation cannot let another accepted operation outlive the deletion barrier. */
async function settleInstructionOperations(operations: ReadonlySet<Promise<unknown>> | undefined): Promise<void> {
  const results = await Promise.allSettled([...(operations ?? [])])
  const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length === 1) throw failures[0]
  if (failures.length > 0) throw new AggregateError(failures, '已接纳指令操作失败；全部操作已结束。')
}
function instructionTarget(target: Pick<SettingsSessionRequest, 'projectId' | 'sessionId'>): string { return JSON.stringify([target.projectId, target.sessionId]) }
function projectInstructionTarget(target: SettingsProjectRequest): string { return JSON.stringify([target.projectId]) }
