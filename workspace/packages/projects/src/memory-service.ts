import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { RootWriteScope } from './metadata-files.ts'
import { ProjectMemoryStore, memorySourcesOverlap, sourceKey, validateCurrentSource, validateDraft, validateSource, type ResolvedMemorySourceAliases } from './memory-store.ts'
import { selectMemoryContext } from './memory-context.ts'
import { isCurrentMemorySource, LEGACY_MEMORY_SCOPE_NOTICE } from './memory-types.ts'
import { MEMORY_CURRENT_AUTHORITY, currentMemoryReference } from './memory-authority.ts'
import type { MemoryRequestInput, MemoryRequestPort, MemoryRequestResult, MemoryRequestContextSource, MemoryRequestSource } from './memory-request.ts'
import type { NativeProjectSourceItem, NativeProjectSourceReadOptions } from './source-reader.ts'
import type {
  MemoryContext, MemoryContextTarget, MemoryScope, MemorySnapshot, MemorySource, MemoryWriteResult,
  ProjectMemory, SaveMemoryInput, StoredMemorySource, LegacyMemorySource, MemoryNativeSource, MemoryMessageRelations, MemoryWithdrawal,
} from './memory-types.ts'

/** actor 由已核实的工具/Host 构造，不从模型参数接收 settings 身份。 */
export interface MemoryAccessRequest {
  projectId: string
  actor: { kind: 'session'; hostSessionId: string } | { kind: 'settings' }
  signal?: AbortSignal
}

export interface MemoryProjectAccess {
  projectId: string
  projectDirectory: string
  actorId: string
  sessionId?: string
  /** 仅由核心真实绑定返回；未提供角色不能获得后台写入能力。 */
  role?: 'main' | 'execution' | 'memory' | 'session-manager'
  /** Unpublished main context can only be read, never mutate Memory or request a batch. */
  readOnly?: true
}

export interface MemorySourceEvidence {
  projectId: string
  readable: boolean
  /** 实际读取后固定的source及producer；不由模型自报身份。 */
  source?: StoredMemorySource
  producer?: string
  /** 历史字段名：只表示原人类用户来源身份，不证明语义采纳、持续性或主题整体已确认。 */
  isUserDecision: boolean
  text?: string
  reason?: string
  /** 程序读取异常只供诊断，不作为来源正文或用户可见原因。 */
  diagnostic?: string
  /** 历史业务定位仅借此指向实际消息/tool；不得把旧记录正文作为原话。 */
  nativeLocator?: MemoryNativeSource
  /** 保留原生说话者、producer、时间、相邻正文及读取限制，不用target纯文本冒充完整来源。 */
  nativeItems?: readonly NativeProjectSourceItem[]
  partial?: true
  limitations?: readonly string[]
}

export type MemorySourceReadOptions = Pick<NativeProjectSourceReadOptions, 'before' | 'after'>

/** 核心只暴露归属、真实来源和范围核实，不把整份 ProjectStore 交给记忆模块。 */
export interface MemoryCorePort {
  resolveProject(request: MemoryAccessRequest): Promise<MemoryProjectAccess>
  /** Fresh Core authorization and the same records-root scope are required for every write. */
  withMetadataWrite<T>(request: MemoryAccessRequest, access: MemoryProjectAccess,
    authorization: { scope?: MemoryScope; sources?: readonly StoredMemorySource[] },
    action: (scope: RootWriteScope) => Promise<T>): Promise<T>
  readSource(access: MemoryProjectAccess, source: StoredMemorySource, signal?: AbortSignal, options?: MemorySourceReadOptions): Promise<MemorySourceEvidence>
  validateScope(access: MemoryProjectAccess, scope: MemoryScope): Promise<void>
}

interface ContextData {
  snapshot: MemorySnapshot
  memories: Omit<ProjectMemory, 'body'>[]
  withdrawals: MemoryWithdrawal[]
  memory?: ProjectMemory
}

export class ProjectMemoryService {
  // 只复用存储层的有界元数据缓存；每次请求独立读取当前快照。
  private readonly stores = new Map<string, WeakRef<ProjectMemoryStore>>()
  constructor(private readonly core: MemoryCorePort) {}

  async list(request: MemoryAccessRequest): Promise<MemorySnapshot> {
    const access = await this.resolve(request)
    const data = await this.loadContext(access, undefined, request.signal)
    return { ...data.snapshot, issues: [...data.snapshot.issues,
      ...data.snapshot.entries.filter(item => item.scope.kind === 'work').map(item => ({ path: item.path, message: LEGACY_MEMORY_SCOPE_NOTICE })),
    ] }
  }

  async read(request: MemoryAccessRequest, id: string): Promise<ProjectMemory | undefined> {
    const access = await this.resolve(request)
    const data = await this.loadContext(access, id, request.signal)
    const memory = data.memory
    if (memory === undefined && data.snapshot.issues.length > 0) throw new Error(data.snapshot.issues.map(item => item.message).join('; '))
    return memory
  }

  /** 从同一次当前owner读取派生精确message关联；不读历史正文、不持久化关系。 */
  async relateMessageSources(request: MemoryAccessRequest, sources: readonly Extract<MemorySource, { kind: 'message' | 'native-event' }>[]): Promise<MemoryMessageRelations> {
    const access = await this.resolve(request)
    const exact = [...new Map(sources.map(source => {
      const value = validateCurrentSource(source)
      if (value.kind !== 'message' && value.kind !== 'native-event') throw new Error('当前主题关系只接受完整消息或精确事件定位。')
      return [sourceKey(value), value] as const
    })).values()]
    try {
      const data = await this.loadContext(access, undefined, request.signal)
      request.signal?.throwIfAborted()
      const issues = [...data.snapshot.issues, ...data.memories.filter(memory => memory.scope.kind === 'work')
        .map(memory => ({ path: memory.path, message: LEGACY_MEMORY_SCOPE_NOTICE }))]
      return { projectId: access.projectId, status: issues.length === 0 ? 'ok' : 'partial',
        relations: exact.map(source => {
          const matches = (value: StoredMemorySource) => memorySourcesOverlap([value], [source])
          return { source, current: data.memories.filter(memory => memory.scope.kind !== 'work' && [...memory.sources, ...memory.originSources].some(matches)).map(currentMemoryReference),
            historicalWithdrawals: structuredClone(data.withdrawals.filter(marker => marker.sources.some(matches))) }
        }), issues: structuredClone(issues), guidance: MEMORY_CURRENT_AUTHORITY }
    } catch (error) {
      request.signal?.throwIfAborted()
      return { projectId: access.projectId, status: 'unavailable', relations: [],
        issues: [{ path: 'memory/', message: error instanceof Error ? error.message : String(error) }], guidance: MEMORY_CURRENT_AUTHORITY }
    }
  }

  async readSource(request: MemoryAccessRequest, source: StoredMemorySource, options?: MemorySourceReadOptions): Promise<MemorySourceEvidence> {
    const access = await this.resolve(request)
    return this.source(access, validateSource(source), request.signal, options)
  }

  /** 新保存只用原消息、工具、文件或真实设置来源；旧业务台账不再成为新依据。 */
  async save(request: MemoryAccessRequest, input: SaveMemoryInput): Promise<MemoryWriteResult> {
    if (request.actor.kind !== 'session') throw new Error('设置提交应使用 saveFromSettings。')
    const access = await this.resolve(request)
    if (access.readOnly || access.role !== 'memory') throw new Error('自动维护共享记忆只允许核心核实的 Memory Bot；工作会话请提交明确请求。')
    const draft = validateDraft(input)
    if (draft.nature === 'unverified') throw new Error('Memory Bot 不能把未经查证的推测保存为共享记忆。')
    // 旧message/tool仅是读取入口；新自动写入须由实际reader唯一固定到事件版本。
    const sources: MemorySource[] = []
    const evidence: MemorySourceEvidence[] = []
    for (const source of draft.sources) {
      const read = await this.source(access, source, request.signal)
      const precise = this.preciseSource(source, read)
      sources.push(precise)
      evidence.push(source.kind === 'message' || source.kind === 'tool'
        ? await this.source(access, precise, request.signal) : read)
    }
    const unreadable = evidence.find(item => !item.readable)
    if (unreadable !== undefined) throw new Error(unreadable.reason ?? '来源当前不可读，不能声称核对并保存了新内容。')
    if (input.nature === 'confirmed' && !evidence.some(item => item.isUserDecision)) {
      throw new Error('已确认规则或偏好需要真实用户决定来源；Agent 建议不能作为已确认记忆保存。')
    }
    let reconfirmedBy = input.reconfirmedBy
    if (input.reconfirmedBy !== undefined) {
      const originalKey = sourceKey(validateCurrentSource(input.reconfirmedBy))
      const originalIndex = draft.sources.findIndex(source => sourceKey(source) === originalKey)
      reconfirmedBy = originalIndex < 0 ? input.reconfirmedBy : sources[originalIndex]
      const key = sourceKey(validateCurrentSource(reconfirmedBy))
      const index = sources.findIndex(source => sourceKey(source) === key)
      if (index < 0 || !evidence[index].isUserDecision) throw new Error('恢复已撤回内容需要本项目用户新的明确决定来源。')
    }
    await this.core.validateScope(access, draft.scope)
    request.signal?.throwIfAborted()
    const store = this.store(access)
    const current = input.id === undefined ? undefined : await store.read(input.id.trim(), request.signal)
    request.signal?.throwIfAborted()
    const aliases = await this.resolveExistingAliases(access, current, request.signal)
    aliases.legacyLocators = draft.sources.filter((source): source is Extract<MemorySource, { kind: 'message' | 'tool' }> => source.kind === 'message' || source.kind === 'tool')
    const prepared = { ...input, ...draft, sources, ...(reconfirmedBy === undefined ? {} : { reconfirmedBy }) }
    const retainedSources = new Set([...(current?.sources ?? []), ...aliases.current].map(sourceKey))
    const introducedSources = [...sources, ...(reconfirmedBy === undefined ? [] : [reconfirmedBy])].filter(source => !retainedSources.has(sourceKey(source)))
    return this.commit(request, access, { scope: draft.scope, sources: introducedSources },
      scope => store.saveWithin(scope, prepared, access.actorId, request.signal, aliases))
  }

  /** 本次真实设置提交本身是用户纠正来源，不伪造原生聊天消息。 */
  async saveFromSettings(request: MemoryAccessRequest, input: SaveMemoryInput): Promise<MemoryWriteResult> {
    if (request.actor.kind !== 'settings') throw new Error('只有真实设置提交才能生成设置修改来源。')
    const access = await this.resolve(request)
    const change: MemorySource = { kind: 'settings', changeId: randomUUID() }
    const store = this.store(access)
    const current = input.id === undefined ? undefined : await store.read(input.id.trim(), request.signal)
    request.signal?.throwIfAborted()
    const oldSources = new Set(current?.sources.map(sourceKey) ?? [])
    const sources = input.sources.map(validateSource)
    // 只校验现行部分；旧record原样保留，由下方核对现存主题，不能新增旧来源。
    const currentDraft = validateDraft({ ...input, sources: [...sources.filter(isCurrentMemorySource), change] })
    const draft = { ...currentDraft, sources: [...sources, change] }
    for (const source of sources) {
      // 先前来源已删除仍保留定位；本次修改依据明确是当前设置动作。
      if (!oldSources.has(sourceKey(source))) {
        if (source.kind === 'record') throw new Error('旧业务记录来源只可原样保留在已有主题，不能新增为当前依据。')
        const evidence = await this.source(access, source, request.signal)
        if (!evidence.readable) throw new Error(evidence.reason ?? '新增的来源不可读。')
      }
    }
    await this.core.validateScope(access, draft.scope)
    request.signal?.throwIfAborted()
    const prepared = { ...input, ...draft, reconfirmedBy: change }
    return this.commit(request, access, { scope: draft.scope, sources: [...sources.filter(source => !oldSources.has(sourceKey(source))), change] },
      scope => store.saveWithin(scope, prepared, access.actorId, request.signal))
  }

  async withdraw(request: MemoryAccessRequest, id: string, expectedRevision: number, expectedGeneration?: string): Promise<MemoryWriteResult> {
    const access = await this.resolve(request)
    if (access.readOnly || request.actor.kind !== 'settings' && access.role !== 'memory') throw new Error('撤回共享记忆只允许真实设置操作或核心核实的 Memory Bot。')
    const store = this.store(access)
    const current = await store.read(id, request.signal)
    request.signal?.throwIfAborted()
    const resolved: MemorySource[] = []
    for (const source of [...(current?.sources ?? []), ...(current?.originSources ?? [])]) {
      if (source.kind !== 'message' && source.kind !== 'tool') continue
      try {
        const read = await this.source(access, source, request.signal, { before: 0, after: 0 })
        if (read.readable) resolved.push(this.preciseSource(source, read))
      } catch { request.signal?.throwIfAborted() /* 不可读旧来源仍可撤回；不猜其历史版本。 */ }
    }
    return this.commit(request, access, {},
      scope => store.withdrawWithin(scope, id, expectedRevision, request.signal, resolved, expectedGeneration))
  }

  /** 核对真实原用户消息后仅交定位；accepted 不是已保存，执行前仍须重读原文。 */
  async requestChange(request: MemoryAccessRequest, input: MemoryRequestInput, port: MemoryRequestPort): Promise<MemoryRequestResult> {
    if (request.actor.kind !== 'session') throw new Error('明确记忆请求来自真实项目会话；设置直接维护记忆。')
    const access = await this.resolve(request)
    if (access.readOnly || (access.role !== 'main' && access.role !== 'execution')) throw new Error('明确记忆请求只允许实际工作会话。')
    if (!['remember', 'correct', 'withdraw'].includes(input.operation)) throw new Error('未知的记忆请求操作。')
    let source = validateCurrentSource(input.source)
    if (source.kind !== 'message' && source.kind !== 'native-event') throw new Error('明确记忆请求必须定位原用户消息事件。')
    const memoryId = input.memoryId?.trim()
    if (input.memoryId !== undefined && !memoryId) throw new Error('记忆标识不能为空。')
    const contextSources = (input.contextSources ?? []).map(item => {
      const value = validateCurrentSource(item)
      if (value.kind === 'settings') throw new Error('请求上下文使用原消息、工具或文件定位，不接受模型自报设置来源。')
      return value as MemoryRequestContextSource
    })
    try {
      const evidence = await this.source(access, source, request.signal)
      const target = evidence.nativeItems?.filter(item => item.isTarget)
      const human = target?.length === 1 && target[0].role === 'user' && target[0].speaker === 'user' && target[0].sourceKind === 'user'
      if (!evidence.readable || !human || !evidence.text?.trim()) return {
        kind: 'unavailable', message: evidence.reason ?? '无法取得本项目原用户消息；未保留记忆请求。',
      }
      source = this.preciseSource(source, evidence)
      if (source.kind !== 'native-event') return { kind: 'unavailable', message: '原请求没有可唯一固定的事件版本；未保留记忆请求。' }
      for (const [index, context] of contextSources.entries()) {
        const read = await this.source(access, context, request.signal)
        if (!read.readable) return { kind: 'unavailable', message: read.reason ?? '必要上下文来源当前不可读；未保留记忆请求。' }
        contextSources[index] = this.preciseSource(context, read) as MemoryRequestContextSource
      }
    } catch (error) {
      request.signal?.throwIfAborted()
      return { kind: 'unavailable', message: error instanceof Error ? error.message : String(error) }
    }
    request.signal?.throwIfAborted()
    try {
      return await port.accept({ projectId: access.projectId, operation: input.operation, source: source as MemoryRequestSource,
        ...(memoryId === undefined ? {} : { memoryId }), contextSources }, request.signal)
    } catch (error) {
      request.signal?.throwIfAborted()
      return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  async context(request: MemoryAccessRequest, target: MemoryContextTarget): Promise<MemoryContext> {
    const access = await this.resolve(request)
    if (target.projectId !== access.projectId || access.sessionId === undefined || target.sessionId !== access.sessionId) {
      throw new Error('记忆上下文只能提供给当前已核实的项目会话。')
    }
    const data = await this.loadContext(access, undefined, request.signal)
    return selectMemoryContext(data.snapshot, data.memories, target, data.withdrawals)
  }

  private async loadContext(access: MemoryProjectAccess, bodyId?: string, signal?: AbortSignal): Promise<ContextData> {
    signal?.throwIfAborted()
    const data = await this.store(access).readAll({ ...(bodyId === undefined ? {} : { bodyId }), signal })
    signal?.throwIfAborted()
    return data
  }

  private async commit(request: MemoryAccessRequest, access: MemoryProjectAccess,
    authorization: { scope?: MemoryScope; sources?: readonly StoredMemorySource[] },
    write: (scope: RootWriteScope) => Promise<MemoryWriteResult>): Promise<MemoryWriteResult> {
    return this.core.withMetadataWrite(request, access, authorization, write)
  }

  private async resolve(request: MemoryAccessRequest): Promise<MemoryProjectAccess> {
    request.signal?.throwIfAborted()
    const access = await this.core.resolveProject(request)
    request.signal?.throwIfAborted()
    if (access.projectId !== request.projectId || !access.actorId || !access.projectDirectory) throw new Error('核心未返回匹配的项目归属。')
    const projectDirectory = await realpath(access.projectDirectory)
    request.signal?.throwIfAborted()
    return { ...access, projectDirectory }
  }

  private store(access: MemoryProjectAccess): ProjectMemoryStore {
    const key = `${access.projectId}\n${access.projectDirectory}`
    for (const [key, reference] of this.stores) if (reference.deref() === undefined) this.stores.delete(key)
    let store = this.stores.get(key)?.deref()
    if (store === undefined) { store = new ProjectMemoryStore(access.projectId, access.projectDirectory); this.stores.set(key, new WeakRef(store)) }
    return store
  }

  private preciseSource(source: MemorySource, evidence: MemorySourceEvidence): MemorySource {
    if (source.kind !== 'message' && source.kind !== 'tool') return source
    const targets = evidence.nativeItems?.filter(item => item.isTarget) ?? []
    const exact = targets.length === 1 ? targets[0].nativeSource : undefined
    if (exact?.kind !== 'native-event' || exact.hostSessionId !== source.hostSessionId
      || source.kind === 'message' && exact.messageId !== source.messageId
      || source.kind === 'tool' && exact.toolCallId !== source.toolCallId) {
      throw new Error('旧消息或工具定位不能唯一确定事件版本；请读取原文取得精确source，不用当前正文冒充历史。')
    }
    return validateCurrentSource(exact)
  }

  private async resolveExistingAliases(access: MemoryProjectAccess, memory: ProjectMemory | undefined, signal?: AbortSignal): Promise<ResolvedMemorySourceAliases> {
    signal?.throwIfAborted()
    const aliases: ResolvedMemorySourceAliases = { current: [], origin: [] }
    if (memory === undefined) return aliases
    const resolved = new Map<string, MemorySource>()
    for (const source of [...memory.sources, ...memory.originSources]) {
      if (source.kind !== 'message' && source.kind !== 'tool' || resolved.has(sourceKey(source))) continue
      try {
        const evidence = await this.source(access, source, signal, { before: 0, after: 0 })
        if (evidence.readable) resolved.set(sourceKey(source), this.preciseSource(source, evidence))
      } catch { signal?.throwIfAborted() /* 无法唯一确定的旧版不伪造等价关系。 */ }
    }
    return { current: memory.sources.flatMap(source => resolved.has(sourceKey(source)) ? [resolved.get(sourceKey(source))!] : []),
      origin: memory.originSources.flatMap(source => resolved.has(sourceKey(source)) ? [resolved.get(sourceKey(source))!] : []) }
  }

  private async source(access: MemoryProjectAccess, source: StoredMemorySource, signal?: AbortSignal, options?: MemorySourceReadOptions): Promise<MemorySourceEvidence> {
    signal?.throwIfAborted()
    if (source.kind === 'native-event' && source.projectId !== access.projectId) throw new Error('来源不属于当前项目。')
    const result = source.kind === 'settings'
      ? await this.settingsSource(access, source.changeId, signal)
      : source.kind === 'record' ? await this.legacySource(access, source, signal, options)
      : await this.core.readSource(access, source, signal, options)
    signal?.throwIfAborted()
    if (result.projectId !== access.projectId) throw new Error('来源不属于当前项目。')
    return result
  }

  private async legacySource(access: MemoryProjectAccess, source: LegacyMemorySource, signal?: AbortSignal, options?: MemorySourceReadOptions): Promise<MemorySourceEvidence> {
    const historical = await this.core.readSource(access, source, signal)
    signal?.throwIfAborted()
    if (historical.projectId !== access.projectId) throw new Error('历史来源不属于当前项目。')
    if (historical.nativeLocator === undefined) return {
      projectId: access.projectId, readable: false, isUserDecision: false,
      reason: '该业务来源仅作历史定位；没有可核对的真实原生定位，不能用旧台账正文代替原话。' + (historical.reason ?? ''),
    }
    const locator = validateCurrentSource(historical.nativeLocator)
    if (locator.kind !== 'message' && locator.kind !== 'tool' && locator.kind !== 'native-event') return {
      projectId: access.projectId, readable: false, isUserDecision: false, reason: '历史来源未提供真实消息或工具定位。',
    }
    const native = await this.core.readSource(access, locator, signal, options)
    signal?.throwIfAborted()
    if (native.projectId !== access.projectId) throw new Error('原生来源不属于当前项目。')
    return { projectId: access.projectId, readable: native.readable, isUserDecision: false, nativeLocator: locator,
      ...(native.nativeItems === undefined ? {} : { nativeItems: native.nativeItems }),
      ...(native.partial === undefined ? {} : { partial: native.partial }),
      ...(native.limitations === undefined ? {} : { limitations: native.limitations }),
      ...(native.readable && native.text !== undefined ? { text: '仅历史来源定位；以下是实际原生来源内容，不是当前用户新决定。\n' + native.text } : {}),
      ...(native.reason === undefined ? {} : { reason: native.reason }),
    }
  }

  private async settingsSource(access: MemoryProjectAccess, changeId: string, signal?: AbortSignal): Promise<MemorySourceEvidence> {
    const read = await this.store(access).readSettingsSource(changeId, signal)
    if (read.current.length === 0 && read.withdrawn.length === 0) return {
      projectId: access.projectId, readable: false, isUserDecision: false,
      reason: read.issues.length === 0 ? '当前项目没有与该设置来源标识关联的已保存记忆或撤回标记。'
        : '部分记忆文件当前无法读取，暂时无法核实该设置来源。',
      ...(read.issues.length === 0 ? {} : { diagnostic: read.issues.map(issue => issue.message).join('; ') }),
    }
    return {
      projectId: access.projectId, readable: true, isUserDecision: true,
      text: [
        `已持久化的设置修改来源定位：${changeId}（项目 ${access.projectId}）。`,
        '以下关联信息不是当时编辑快照；未保存该次编辑的历史正文或编辑时间。',
        ...read.current.map(memory => [
          memory.scope.kind === 'work' ? '关联记忆的历史范围正文（该旧范围已退出当前适用，不进入默认供给）：' : '关联记忆的当前正文：',
          JSON.stringify({ projectId: memory.projectId, memoryId: memory.id, path: memory.path,
            revision: memory.revision, currentFileUpdatedAt: memory.updatedAt, scope: memory.scope }),
          memory.body,
        ].join('\n')),
        ...read.withdrawn.map(marker => [
          '关联记忆的最小撤回标记；不提供已撤回正文或摘要，也不能据此恢复旧内容。',
          JSON.stringify({ projectId: access.projectId, memoryId: marker.id, withdrawnAt: marker.withdrawnAt }),
        ].join('\n')),
      ].join('\n'),
      ...(read.issues.length === 0 ? {} : {
        limitations: ['部分记忆文件当前无法读取；显示的关联信息可能不完整。'],
        diagnostic: read.issues.map(issue => issue.message).join('; '),
      }),
    }
  }
}
