import { randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { DurableMutationError, durableMutationDetails, ensureDirectoryDurable, removeFileDurable, withRootWriteLock, writeFileDurable, type RootWriteScope } from './metadata-files.ts'
import { canonicalSourceJson, decodeNativeProjectSource, nativeProjectSourceKey } from './native-source.ts'
import { validateSource as validateCommunicationSource } from './communication/contract.ts'
import type { NativeEventSource } from './source-reference-types.ts'
import type {
  MemoryDraft, MemoryIndexEntry, MemoryIssue, MemorySnapshot, MemorySource,
  MemoryWriteResult, MemoryMutationFailure, MemoryMutationConfirmedFacts, ProjectMemory, SaveMemoryInput, StoredMemoryDraft, StoredMemoryScope, StoredMemorySource, MemoryWithdrawal,
} from './memory-types.ts'

type Withdrawal = MemoryWithdrawal

type MemoryMetadata = Omit<ProjectMemory, 'body'>
interface MetadataDiskRead {
  memories: MemoryMetadata[]
  withdrawals: Withdrawal[]
  issues: MemoryIssue[]
  memory?: ProjectMemory
}
interface DiskRead extends MetadataDiskRead { memories: ProjectMemory[] }
interface ContextReadOptions { bodyId?: string; signal?: AbortSignal }
interface MetadataContextRead extends Omit<MetadataDiskRead, 'issues'> { snapshot: MemorySnapshot }
interface ValidatedMetadata { version: string; memory: MemoryMetadata; bytes: number }

/** 仅由服务在实际reader唯一解析后提供；不改写旧定位或保存正文。 */
export interface ResolvedMemorySourceAliases {
  current: readonly MemorySource[]
  origin: readonly MemorySource[]
  /** 本次新输入经唯一解析前的locator，仅留作审计，不作为新确认。 */
  legacyLocators?: readonly Extract<MemorySource, { kind: 'message' | 'tool' }>[]
}

/** 只读取既有正文关联及最小撤回标记，不保存设置历史副本。 */
export interface MemorySettingsSourceRead {
  projectId: string
  current: ProjectMemory[]
  withdrawn: Array<{ id: string; withdrawnAt: string }>
  issues: MemoryIssue[]
}

const INDEX = 'index.md'
const WITHDRAWALS = '.withdrawn.json'
const METADATA_ENTRIES_MAX = 128
const METADATA_BYTES_MAX = 1024 * 1024
const METADATA_ENTRY_BYTES_MAX = 64 * 1024

/** 一个项目的正文/索引唯一写入口；不读写核心 record.json，不拥有来源授权。 */
export class ProjectMemoryStore {
  readonly projectId: string
  readonly projectDirectory: string
  // Derived from complete successful parses, never a body or a reusable success snapshot.
  private readonly metadata = new Map<string, ValidatedMetadata>()
  private metadataBytes = 0
  private metadataNamespace?: string

  constructor(projectId: string, projectDirectory: string) {
    this.projectId = requiredText(projectId, 'project id')
    this.projectDirectory = resolve(projectDirectory)
  }

  async list(signal?: AbortSignal): Promise<MemorySnapshot> {
    return this.snapshot(await this.load({ signal }), signal)
  }

  async read(id: string, signal?: AbortSignal): Promise<ProjectMemory | undefined> {
    const data = await this.load({ bodyId: id, signal })
    const memory = data.memory
    if (memory === undefined && data.issues.length > 0) throw new Error(data.issues.map(item => item.message).join('; '))
    return memory
  }

  /** 同一次读取取得正文及其索引；供上下文组装使用。 */
  async readAll(): Promise<{ snapshot: MemorySnapshot; memories: ProjectMemory[]; withdrawals: MemoryWithdrawal[] }>
  /** Validate every current file, retaining a full body only for the explicit read, if any. */
  async readAll(options: ContextReadOptions): Promise<MetadataContextRead>
  async readAll(options?: ContextReadOptions): Promise<MetadataContextRead> {
    const data = options === undefined ? await this.load() : await this.load(options)
    return { snapshot: await this.snapshot(data, options?.signal), memories: data.memories, withdrawals: data.withdrawals,
      ...(data.memory === undefined ? {} : { memory: data.memory }) }
  }

  async readSettingsSource(changeId: string, signal?: AbortSignal): Promise<MemorySettingsSourceRead> {
    const key = sourceKey({ kind: 'settings', changeId })
    const data = await this.load(undefined, signal)
    const matches = (source: StoredMemorySource): boolean => sourceKey(source) === key
    return {
      projectId: this.projectId,
      current: data.memories.filter(memory => memory.sources.some(matches) || memory.originSources.some(matches)
        || (memory.reconfirmedBy !== undefined && matches(memory.reconfirmedBy))),
      withdrawn: data.withdrawals.filter(marker => marker.sources.some(matches))
        .map(marker => ({ id: marker.id, withdrawnAt: marker.withdrawnAt })),
      issues: data.issues,
    }
  }

  async save(input: SaveMemoryInput, actor: string, signal?: AbortSignal, aliases?: ResolvedMemorySourceAliases): Promise<MemoryWriteResult> {
    return this.withWrite(signal, scope => this.saveWithin(scope, input, actor, signal, aliases))
  }

  /** Internal owner seam: the caller already holds the records-root metadata transaction. */
  async saveWithin(scope: RootWriteScope, input: SaveMemoryInput, actor: string, signal?: AbortSignal, aliases?: ResolvedMemorySourceAliases): Promise<MemoryWriteResult> {
    await this.assertScope(scope, signal)
    const draft = validateStoredDraft(input)
    if (draft.scope.kind === 'work') throw new Error('该旧范围已退出当前适用，不能作为新保存范围；请明确选择现行范围。')
    this.assertProjectSources(draft.sources)
    const currentAliases = (aliases?.current ?? []).map(validateCurrentSource)
    const originAliases = (aliases?.origin ?? []).map(validateCurrentSource)
    const legacyLocators = (aliases?.legacyLocators ?? []).map(source => {
      const value = validateCurrentSource(source)
      if (value.kind !== 'message' && value.kind !== 'tool') throw new Error('历史读取locator必须保留其原始消息或工具表示。')
      return value
    })
    this.assertProjectSources([...currentAliases, ...originAliases])
    requiredText(actor, 'recording actor')
    signal?.throwIfAborted()
    const requestedId = input.id === undefined ? undefined : requiredText(input.id, 'memory id')
    const data = await this.load({ ...(requestedId === undefined ? {} : { bodyId: requestedId }), signal })
    if (data.issues.length > 0) throw new Error('记忆文件不可读，未覆盖现有内容：' + data.issues.map(item => item.message).join('; '))
    const current = data.memory
    if (current !== undefined && (input.expectedRevision !== current.revision || input.expectedGeneration !== current.generation)) {
      return { kind: 'conflict', current, message: '内容已变化，请读取当前正文后再纠正。' }
    }
    if (current === undefined && (input.expectedRevision !== undefined || input.expectedGeneration !== undefined)) {
      return { kind: 'conflict', message: '原记忆已撤回或不存在，请读取当前列表。' }
    }
    // 真实设置编辑可保留该主题已有的旧定位；不可借兼容读取创建新的旧业务来源。
    if (draft.sources.some(source => source.kind === 'record'
      && !current?.sources.some(previous => sourceKey(previous) === sourceKey(source)))) {
      throw new Error('旧业务记录来源只可原样保留在已有主题，不能新增或恢复为当前依据。')
    }
    const id = current?.id ?? requestedId ?? randomUUID()
    const currentSources = [...(current?.sources ?? []), ...(current === undefined ? [] : currentAliases)]
    const previousSources = [...(current?.originSources ?? []), ...(current?.sources ?? []), ...(current === undefined ? [] : [...currentAliases, ...originAliases])]
    // originSources 只是历史定位；被用户移出当前依据的来源再次加入时仍是新引入。
    const introducedSources = draft.sources.filter(source => !currentSources.some(previous => sourceCovers(previous, source)))
    const ownWithdrawal = data.withdrawals.some(item => item.id === id)
    // 同一原消息可合法支持多个主题；只阻止把撤回来源新引入其它主题，不连带撤回既有主题。
    const introducedWithdrawnSource = data.withdrawals.some(item => sourcesOverlap(item.sources, introducedSources))
    const reconfirmedBy = input.reconfirmedBy === undefined ? current?.reconfirmedBy : validateCurrentSource(input.reconfirmedBy)
    if (reconfirmedBy !== undefined) this.assertProjectSources([reconfirmedBy])
    const validReconfirmation = reconfirmedBy !== undefined
      && draft.sources.some(source => sourceKey(source) === sourceKey(reconfirmedBy))
      && !data.withdrawals.some(item => item.sources.some(source => sameSourceOrigin(source, reconfirmedBy)))
    // 已有主题的旧确认只延续它自身的合法恢复，不能替新引入的撤回来源提供新确认。
    const freshReconfirmation = input.reconfirmedBy !== undefined && !previousSources.some(source => sameSourceOrigin(source, input.reconfirmedBy!))
    if ((ownWithdrawal && !validReconfirmation)
      || (introducedWithdrawnSource && (!validReconfirmation || !freshReconfirmation))) {
      return { kind: 'conflict', message: '该内容已撤回，旧来源不能自动恢复；需要用户新的明确决定来源。' }
    }
    const topic = current === undefined
      ? input.topic === undefined ? randomUUID() : safeTopic(input.topic)
      : basename(current.path, '.md')
    const path = `memory/${topic}.md`
    if (current === undefined && await this.exists(join(this.directory, `${topic}.md`), signal)) {
      return { kind: 'conflict', message: '该主题文件已存在，请读取后按其标识纠正，或使用另一主题名。' }
    }
    const now = new Date().toISOString()
    // 旧撤回标记没有末次修订号；恢复建立新实例，不能把旧草稿的同修订号当作当前版本。
    const generation = current === undefined && ownWithdrawal ? randomUUID() : current?.generation
    const memory: ProjectMemory = {
      ...draft, id, projectId: this.projectId, path, revision: (current?.revision ?? 0) + 1,
      ...(generation === undefined ? {} : { generation }),
      createdAt: current?.createdAt ?? now, updatedAt: now,
      createdBy: current?.createdBy ?? actor, updatedBy: actor,
      originSources: uniqueSources([...(current?.originSources ?? current?.sources ?? []), ...legacyLocators, ...draft.sources]),
      ...(reconfirmedBy === undefined ? {} : { reconfirmedBy }),
    }
    try {
      await this.ensureDirectory(signal)
      signal?.throwIfAborted()
      await this.atomicWrite(scope, join(this.directory, `${topic}.md`), renderMemory(memory), signal)
    } catch (error) {
      this.throwUnconfirmed(error, 'save', id, 'body', { bodySaved: false, withdrawalSaved: false, bodyRemoved: false, indexSaved: false })
      return { kind: 'failed', stage: 'body', message: messageOf(error) }
    }
    try {
      await this.synchronizeIndex(scope, signal)
    } catch (error) {
      this.throwUnconfirmed(error, 'save', id, 'index', { bodySaved: true, withdrawalSaved: false, bodyRemoved: false, indexSaved: false })
      return { kind: 'partial', operation: 'save', id, bodySaved: true, bodyRemoved: false, indexSaved: false, message: messageOf(error) }
    }
    return { kind: 'saved', memory, bodySaved: true, indexSaved: true }
  }

  async withdraw(id: string, expectedRevision: number, signal?: AbortSignal, resolvedSources: readonly MemorySource[] = [], expectedGeneration?: string): Promise<MemoryWriteResult> {
    return this.withWrite(signal, scope => this.withdrawWithin(scope, id, expectedRevision, signal, resolvedSources, expectedGeneration))
  }

  /** Internal owner seam; never reacquires the transaction lock. */
  async withdrawWithin(scope: RootWriteScope, id: string, expectedRevision: number, signal?: AbortSignal, resolvedSources: readonly MemorySource[] = [], expectedGeneration?: string): Promise<MemoryWriteResult> {
    await this.assertScope(scope, signal)
    const preciseSources = resolvedSources.map(validateCurrentSource)
    this.assertProjectSources(preciseSources)
    signal?.throwIfAborted()
    const data = await this.load({ bodyId: id, signal })
    if (data.issues.length > 0) throw new Error('无法完整读取记忆，未报告撤回成功：' + data.issues.map(item => item.message).join('; '))
    const current = data.memory
    if (current === undefined || current.revision !== expectedRevision || current.generation !== expectedGeneration) {
      return { kind: 'conflict', ...(current === undefined ? {} : { current }), message: '记忆已变化或已撤回，请读取当前列表。' }
    }
    const marker: Withdrawal = {
      id, sources: uniqueSources([...current.originSources, ...current.sources, ...preciseSources]), withdrawnAt: new Date().toISOString(),
    }
    try {
      signal?.throwIfAborted()
      await this.atomicWrite(scope, join(this.directory, WITHDRAWALS), JSON.stringify({
        projectId: this.projectId, withdrawals: [...data.withdrawals, marker],
      }, null, 2) + '\n', signal)
    } catch (error) {
      this.throwUnconfirmed(error, 'withdraw', id, 'withdrawal', { bodySaved: false, withdrawalSaved: false, bodyRemoved: false, indexSaved: false })
      return { kind: 'failed', stage: 'withdrawal', message: messageOf(error) }
    }
    let bodyRemoved = false
    let failure: string | undefined
    let uncertain: { error: unknown; phase: MemoryMutationFailure['phase'] } | undefined
    try {
      signal?.throwIfAborted()
      await this.assertScope(scope, signal)
      await removeFileDurable(join(this.projectDirectory, current.path))
      bodyRemoved = true
    } catch (error) {
      failure = messageOf(error)
      if (durableMutationDetails(error)?.effect !== undefined && durableMutationDetails(error)?.effect !== 'none') uncertain = { error, phase: 'body-removal' }
    }
    let indexSaved = false
    try {
      await this.synchronizeIndex(scope, signal)
      indexSaved = true
    } catch (error) {
      failure = [failure, messageOf(error)].filter(Boolean).join('; ')
      if (durableMutationDetails(error)?.effect !== undefined && durableMutationDetails(error)?.effect !== 'none') uncertain ??= { error, phase: 'index' }
    }
    if (uncertain !== undefined) this.throwUnconfirmed(uncertain.error, 'withdraw', id, uncertain.phase, { bodySaved: false, withdrawalSaved: true, bodyRemoved, indexSaved })
    if (!bodyRemoved || !indexSaved) {
      return { kind: 'partial', operation: 'withdraw', id, bodySaved: false, bodyRemoved, indexSaved,
        message: failure ?? '撤回只完成部分保存；读取能力已排除此条记忆。' }
    }
    return { kind: 'withdrawn', id, bodyRemoved: true, indexSaved: true }
  }

  private get directory(): string { return join(this.projectDirectory, 'memory') }

  private assertProjectSources(sources: readonly StoredMemorySource[]): void {
    if (sources.some(source => source.kind === 'native-event' && source.projectId !== this.projectId)) throw new Error('来源不属于当前项目。')
  }

  private async withWrite<T>(signal: AbortSignal | undefined, action: (scope: RootWriteScope) => Promise<T>): Promise<T> {
    // A standalone fixture owns no Core authorization, but shares the exact production lock.
    // Check the existing project first: the helper must never initialize a missing project root.
    signal?.throwIfAborted()
    await realpath(this.projectDirectory)
    signal?.throwIfAborted()
    return withRootWriteLock({ root: dirname(this.projectDirectory), anchor: '.metadata.lock', signal }, action)
  }

  private async assertScope(scope: RootWriteScope, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    await scope.assertCurrent()
    signal?.throwIfAborted()
    if (scope.root !== await realpath(dirname(this.projectDirectory)) || scope.anchorPath !== join(scope.root, '.metadata.lock')) {
      throw new Error('Memory write scope does not belong to the current records root.')
    }
    signal?.throwIfAborted()
    await realpath(this.projectDirectory)
    signal?.throwIfAborted()
  }

  private async ensureDirectory(signal?: AbortSignal): Promise<void> {
    await this.checkDirectory(signal)
    signal?.throwIfAborted()
    await ensureDirectoryDurable(this.directory)
    await this.checkDirectory(signal)
  }

  private throwUnconfirmed(error: unknown, operation: 'save' | 'withdraw', id: string,
    phase: MemoryMutationFailure['phase'], confirmed: MemoryMutationConfirmedFacts): void {
    const details = durableMutationDetails(error)
    if (details === undefined || details.effect === 'none') return
    const failure = new DurableMutationError(details.stage, details.effect, error)
    failure.message = '共享记忆保存结果未确认；内容可能已更新，请保留草稿并核对当前内容，勿直接重做。 ' + details.message
    const ownerFacts = { owner: 'memory', operation, projectId: this.projectId, id, phase, confirmed }
    Object.assign(failure, ownerFacts, { details: { ...failure.details, ...ownerFacts } })
    throw failure
  }

  private async checkDirectory(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    // 项目根由核心解析；这里拒绝把 memory 链接到另一个项目或外部目录。
    await realpath(this.projectDirectory)
    signal?.throwIfAborted()
    try {
      const info = await lstat(this.directory)
      signal?.throwIfAborted()
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('memory 必须是当前项目内的真实目录。')
      return true
    } catch (error) { signal?.throwIfAborted(); if (isMissing(error)) return false; throw error }
  }

  private async load(options?: undefined, signal?: AbortSignal): Promise<DiskRead>
  private async load(options: ContextReadOptions): Promise<MetadataDiskRead>
  private async load(options?: ContextReadOptions, signal = options?.signal): Promise<MetadataDiskRead> {
    try {
      if (!await this.checkDirectory(signal)) { this.clearMetadata(); return { memories: [], withdrawals: [], issues: [] } }
      let namespace: string | undefined
      if (options !== undefined) {
        namespace = await this.currentMetadataNamespace(signal)
        if (namespace !== this.metadataNamespace) { this.clearMetadata(); this.metadataNamespace = namespace }
      }
      const withdrawals = await this.readWithdrawals(signal)
      const data: MetadataDiskRead = { memories: [], withdrawals, issues: [] }
      signal?.throwIfAborted()
      const files = (await readdir(this.directory)).sort()
      signal?.throwIfAborted()
      if (options !== undefined) {
        const currentPaths = new Set(files.map(file => join(this.directory, file)))
        for (const path of this.metadata.keys()) if (!currentPaths.has(path)) this.forgetMetadata(path)
      }
      for (const file of files) {
        if (!file.endsWith('.md') || file === INDEX) continue
        try {
          const memory = options === undefined
            ? parseMemory(await this.readRegular(join(this.directory, file), signal), this.projectId, `memory/${file}`)
            : await this.readMetadata(file, options)
          if (isWithdrawn(memory, withdrawals)) continue
          if (data.memories.some(item => item.id === memory.id)) throw new Error('重复的记忆标识。')
          if (options !== undefined && 'body' in memory && typeof memory.body === 'string') {
            const { body: _body, ...metadata } = memory
            data.memories.push(metadata)
            data.memory = { ...metadata, body: memory.body }
          } else data.memories.push(memory)
        } catch (error) {
          signal?.throwIfAborted()
          this.forgetMetadata(join(this.directory, file))
          data.issues.push({ path: `memory/${file}`, message: messageOf(error) })
        }
      }
      if (namespace !== undefined && namespace !== await this.currentMetadataNamespace(signal)) throw new Error('memory 目录在读取期间发生变化，请重新读取。')
      return data
    } catch (error) { this.clearMetadata(); throw error }
  }

  private async currentMetadataNamespace(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const projectDirectory = await realpath(this.projectDirectory)
    signal?.throwIfAborted()
    const info = await lstat(this.directory, { bigint: true })
    signal?.throwIfAborted()
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('memory 必须是当前项目内的真实目录。')
    return `${this.projectId}\n${projectDirectory}\n${fileIdentity(info)}`
  }

  /** Every hit still opens the current file; unchanged bytes only reuse their validated metadata. */
  private async readMetadata(file: string, options: ContextReadOptions): Promise<MemoryMetadata | ProjectMemory> {
    const signal = options.signal
    signal?.throwIfAborted()
    const path = join(this.directory, file), relativePath = `memory/${file}`
    const initialPath = await lstat(path, { bigint: true })
    signal?.throwIfAborted()
    if (!initialPath.isFile() || initialPath.isSymbolicLink()) throw new Error(`${file} 不是当前项目内的普通文件。`)
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      signal?.throwIfAborted()
      const initial = await handle.stat({ bigint: true }), version = fileVersion(initial)
      signal?.throwIfAborted()
      if (!initial.isFile() || version !== fileVersion(initialPath)) throw new Error(`${relativePath} 在读取期间发生变化，请重新读取。`)
      const cached = this.metadata.get(path)
      const memory = cached?.version === version && cached.memory.id !== options.bodyId
        ? structuredClone(cached.memory)
        : parseMemory(await handle.readFile({ encoding: 'utf8', signal }), this.projectId, relativePath, options)
      signal?.throwIfAborted()
      const [held, current] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })])
      signal?.throwIfAborted()
      if (!current.isFile() || current.isSymbolicLink() || version !== fileVersion(held) || version !== fileVersion(current)) {
        throw new Error(`${relativePath} 在读取期间发生变化，请重新读取。`)
      }
      if (cached?.version === version && cached.memory.id !== options.bodyId) {
        // Refresh bounded insertion order without copying metadata into the cache again.
        if (this.metadata.get(path) === cached) { this.metadata.delete(path); this.metadata.set(path, cached) }
      } else this.rememberMetadata(path, version, memory)
      return memory
    } finally { await handle.close() }
  }

  private rememberMetadata(path: string, version: string, memory: MemoryMetadata | ProjectMemory): void {
    const { body: _body, ...metadata } = memory as ProjectMemory
    const bytes = Buffer.byteLength(JSON.stringify(metadata))
    this.forgetMetadata(path)
    if (bytes > METADATA_ENTRY_BYTES_MAX) return
    this.metadata.set(path, { version, memory: structuredClone(metadata), bytes })
    this.metadataBytes += bytes
    while (this.metadata.size > METADATA_ENTRIES_MAX || this.metadataBytes > METADATA_BYTES_MAX) {
      this.forgetMetadata(this.metadata.keys().next().value!)
    }
  }

  private forgetMetadata(path: string): void {
    const previous = this.metadata.get(path)
    if (previous !== undefined) { this.metadata.delete(path); this.metadataBytes -= previous.bytes }
  }

  private clearMetadata(): void {
    this.metadata.clear(); this.metadataBytes = 0; this.metadataNamespace = undefined
  }

  private async readWithdrawals(signal?: AbortSignal): Promise<Withdrawal[]> {
    let text: string
    try { text = await this.readRegular(join(this.directory, WITHDRAWALS), signal) }
    catch (error) { signal?.throwIfAborted(); if (isMissing(error)) return []; throw error }
    const value = JSON.parse(text) as { projectId?: unknown; withdrawals?: unknown }
    if (value.projectId !== this.projectId || !Array.isArray(value.withdrawals)) throw new Error('撤回标记不属于当前项目或已损坏。')
    return value.withdrawals.map((raw: unknown) => {
      const item = object(raw)
      const sources = validateSources(item.sources)
      this.assertProjectSources(sources)
      return { id: requiredText(item.id, 'withdrawn id'), sources, withdrawnAt: requiredText(item.withdrawnAt, 'withdrawn time') }
    })
  }

  private async snapshot(data: MetadataDiskRead, signal?: AbortSignal): Promise<MemorySnapshot> {
    const entries = data.memories.map(indexEntry)
    const index = renderMemoryIndex(this.projectId, entries)
    let persisted: string | undefined
    const issues = [...data.issues]
    try { persisted = await this.readRegular(join(this.directory, INDEX), signal) }
    catch (error) { signal?.throwIfAborted(); if (!isMissing(error)) issues.push({ path: 'memory/index.md', message: messageOf(error) }) }
    const indexSynchronized = issues.length === 0 && (persisted === index || (persisted === undefined && entries.length === 0))
    if (!indexSynchronized) issues.push({ path: 'memory/index.md', message: '磁盘索引未与当前正文同步；以下索引由当前可读正文生成，不使用旧摘要。' })
    return { projectId: this.projectId, entries, index, indexSynchronized, issues }
  }

  private async synchronizeIndex(scope: RootWriteScope, signal?: AbortSignal): Promise<void> {
    const data = await this.load({ signal })
    if (data.issues.length > 0) throw new Error('正文读取不完整，索引未报告同步：' + data.issues.map(item => item.message).join('; '))
    await this.atomicWrite(scope, join(this.directory, INDEX), renderMemoryIndex(this.projectId, data.memories.map(indexEntry)), signal)
  }

  private async readRegular(path: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const info = await lstat(path)
    signal?.throwIfAborted()
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${basename(path)} 不是当前项目内的普通文件。`)
    const text = await readFile(path, { encoding: 'utf8', signal })
    signal?.throwIfAborted()
    return text
  }

  private async exists(path: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    try { await lstat(path); signal?.throwIfAborted(); return true }
    catch (error) { signal?.throwIfAborted(); if (isMissing(error)) return false; throw error }
  }

  private async atomicWrite(scope: RootWriteScope, path: string, text: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    await this.assertScope(scope, signal)
    if (await this.exists(path, signal)) await this.readRegular(path, signal)
    signal?.throwIfAborted()
    try { await writeFileDurable(path, text, { beforePublish: () => signal?.throwIfAborted() }) }
    finally { this.clearMetadata() }
  }

}

function fileIdentity(info: BigIntStats): string { return `${info.dev}:${info.ino}:${info.birthtimeNs}` }
function fileVersion(info: BigIntStats): string { return `${fileIdentity(info)}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` }

export function renderMemoryIndex(projectId: string, entries: readonly MemoryIndexEntry[]): string {
  const lines = ['# 项目共享记忆索引', '', `项目：${projectId}`, '', '索引用于选择正文；摘要不代表已读原文，也不授予操作权限。', '']
  for (const item of entries) {
    lines.push(`## ${oneLine(item.title)}`, `- 标识：${item.id}`, `- 正文：${item.path}`,
      `- 类型：${item.type}；性质：${item.nature}；状态：当前有效`,
      `- 范围：${JSON.stringify(item.scope)}`, `- 摘要：${oneLine(item.summary)}`,
      `- 正文更新：${item.updatedAt}（修订 ${item.revision}）`, '')
  }
  if (entries.length === 0) lines.push('当前没有共享记忆。', '')
  return lines.join('\n')
}

function renderMemory(memory: ProjectMemory): string {
  const { body, ...metadata } = memory
  return `---\n${JSON.stringify({ version: 1, ...metadata }, null, 2)}\n---\n\n${body}\n`
}

function parseMemory(text: string, projectId: string, path: string): ProjectMemory
function parseMemory(text: string, projectId: string, path: string, options: ContextReadOptions): MemoryMetadata | ProjectMemory
function parseMemory(text: string, projectId: string, path: string, options?: ContextReadOptions): MemoryMetadata | ProjectMemory {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n\r?\n([\s\S]*)$/.exec(text)
  if (match === null) throw new Error(`${path} 缺少记忆元数据。`)
  const value = object(JSON.parse(match[1]))
  if (value.version !== 1 || value.projectId !== projectId || value.path !== path) throw new Error(`${path} 的格式、项目或路径归属不匹配。`)
  const retainBody = options === undefined || typeof value.id === 'string' && value.id.trim() === options.bodyId
  // Unselected bodies still receive the exact nonempty-text validation. Do not trim,
  // copy or retain their full contents just to prepare an index/current-source view.
  const draft = validateStoredDraft({ ...value, body: match[2] } as unknown as StoredMemoryDraft, retainBody)
  const originSources = validateSources(value.originSources)
  const reconfirmedBy = value.reconfirmedBy === undefined ? undefined : validateSource(value.reconfirmedBy)
  if ([...draft.sources, ...originSources, ...(reconfirmedBy === undefined ? [] : [reconfirmedBy])]
    .some(source => source.kind === 'native-event' && source.projectId !== projectId)) throw new Error(`${path} 的来源不属于当前项目。`)
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) throw new Error(`${path} 修订不合法。`)
  return {
    ...draft, id: requiredText(value.id, 'memory id'), projectId, path, revision: value.revision as number,
    createdAt: requiredText(value.createdAt, 'created time'), updatedAt: requiredText(value.updatedAt, 'updated time'),
    ...(value.generation === undefined ? {} : { generation: requiredText(value.generation, 'memory generation') }),
    createdBy: requiredText(value.createdBy, 'creator'), updatedBy: requiredText(value.updatedBy, 'updater'),
    originSources,
    ...(reconfirmedBy === undefined ? {} : { reconfirmedBy }),
  }
}

export function validateDraft(input: Omit<MemoryDraft, 'sources'> & { sources: readonly StoredMemorySource[] }): MemoryDraft {
  const draft = validateStoredDraft(input)
  if (draft.scope.kind === 'work') throw new Error('该旧范围已退出当前适用，不能作为新保存范围；请明确选择现行范围。')
  if (draft.sources.some(source => source.kind === 'record')) throw new Error('旧业务记录来源只作历史定位，不能作为新保存来源或新用户决定依据。')
  return { ...draft, scope: draft.scope, sources: draft.sources.map(validateCurrentSource) }
}

/** 旧文件和撤回标记仍按原字段解码；只有写输入排除已退出的范围/来源。 */
type StoredDraftInput = Omit<StoredMemoryDraft, 'sources'> & { sources: readonly StoredMemorySource[] }
function validateStoredDraft(input: StoredDraftInput): StoredMemoryDraft
function validateStoredDraft(input: StoredDraftInput, retainBody: boolean): StoredMemoryDraft | Omit<StoredMemoryDraft, 'body'>
function validateStoredDraft(input: StoredDraftInput, retainBody = true): StoredMemoryDraft | Omit<StoredMemoryDraft, 'body'> {
  if (!['rule', 'preference', 'background', 'fact', 'experience'].includes(input.type)) throw new Error('不支持的记忆类型；请选择现有组织类型，正文内容不限类别。')
  if (!['confirmed', 'verified', 'unverified'].includes(input.nature)) throw new Error('请说明内容是已确认、已查证还是待验证。')
  if (input.type === 'rule' && input.nature !== 'confirmed') throw new Error('持续规则必须有用户明确决定，建议不能自动变成规则。')
  const title = requiredText(input.title, 'title'), summary = requiredText(input.summary, 'summary')
  const body = retainBody ? { body: requiredText(input.body, 'body') } : undefined
  if (!retainBody) checkBody(input.body)
  return {
    title, summary, ...body,
    type: input.type, nature: input.nature, scope: validateScope(input.scope), sources: validateSources(input.sources),
  }
}

function validateScope(raw: StoredMemoryScope): StoredMemoryScope {
  const value = object(raw)
  switch (value.kind) {
    case 'project': return { kind: 'project' }
    case 'work': return { kind: 'work', workIds: textArray(value.workIds, 'work ids') }
    case 'session': return { kind: 'session', sessionIds: textArray(value.sessionIds, 'session ids') }
    case 'file': return { kind: 'file', paths: textArray(value.paths, 'file paths') }
    case 'topic': return { kind: 'topic', topics: textArray(value.topics, 'topics') }
    default: throw new Error('记忆适用范围不合法。')
  }
}

export function validateSource(raw: unknown): StoredMemorySource {
  const value = object(raw)
  switch (value.kind) {
    case 'native-event':
    case 'message':
    case 'tool': return decodeNativeProjectSource(value)
    case 'communication-part': {
      const source = validateCommunicationSource(value)
      if (source.kind !== 'communication-part') throw new Error('记忆通信来源不合法。')
      return structuredClone(source)
    }
    case 'record': {
      exactFields(value, ['kind', 'recordKind', 'recordId', 'revision'])
      if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) throw new Error('来源修订不合法。')
      return { kind: 'record', recordKind: requiredText(value.recordKind, 'source record kind'), recordId: requiredText(value.recordId, 'source record'), revision: value.revision as number }
    }
    case 'file': {
      exactFields(value, ['kind', 'path', 'locator'])
      return { kind: 'file', path: requiredText(value.path, 'source file'), ...(value.locator === undefined ? {} : { locator: requiredText(value.locator, 'source locator') }) }
    }
    case 'settings': {
      exactFields(value, ['kind', 'changeId'])
      return { kind: 'settings', changeId: requiredText(value.changeId, 'settings change') }
    }
    default: throw new Error('记忆来源不合法。')
  }
}

export function validateCurrentSource(raw: unknown): MemorySource {
  const source = validateSource(raw)
  if (source.kind === 'record') throw new Error('旧业务记录来源只作历史定位，不能作为新保存来源或新用户决定依据。')
  return source
}

function validateSources(value: unknown): StoredMemorySource[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('记忆必须保留真实来源。')
  return uniqueSources(value.map(item => validateSource(item as MemorySource)))
}

/** 表示键保留精确版本、正文流及范围；不把它误当成重新确认的事件身份。 */
export function sourceKey(source: StoredMemorySource): string {
  const value = validateSource(source)
  return value.kind === 'native-event' ? nativeProjectSourceKey(value)
    : value.kind === 'communication-part' ? canonicalSourceJson(value) : JSON.stringify(value)
}
function uniqueSources(sources: StoredMemorySource[]): StoredMemorySource[] { return [...new Map(sources.map(source => [sourceKey(source), source])).values()] }
/** 同事件的重编码/交叠页面不能复活撤回材料；不同事件版本与不相交正文范围仍独立。 */
export function memorySourcesOverlap(left: readonly StoredMemorySource[], right: readonly StoredMemorySource[]): boolean {
  return right.some(source => left.some(previous => {
    if (sourceKey(previous) === sourceKey(source)) return true
    if (previous.kind !== 'native-event' || source.kind !== 'native-event' || !sameNativeOrigin(previous, source)) return false
    const a = previous.body, b = source.body
    if (a === undefined || b === undefined) return true
    if (a.stream !== b.stream || a.codec !== b.codec || a.digest !== b.digest) return false
    return a.range === undefined || b.range === undefined
      || a.range.start < b.range.end && b.range.start < a.range.end
      || a.range.start === b.range.start && a.range.end === b.range.end
  }))
}
const sourcesOverlap = memorySourcesOverlap
function sameNativeOrigin(left: NativeEventSource, right: NativeEventSource): boolean {
  return left.projectId === right.projectId && left.sessionId === right.sessionId && left.hostSessionId === right.hostSessionId
    && left.sessionCreatedAt === right.sessionCreatedAt && left.eventSpace.kind === right.eventSpace.kind
    && left.eventSpace.formatVersion === right.eventSpace.formatVersion && left.eventSeq === right.eventSeq
    && left.eventType === right.eventType && left.eventDigest === right.eventDigest
    && (left.messageId === undefined || right.messageId === undefined || left.messageId === right.messageId)
    && (left.toolCallId === undefined || right.toolCallId === undefined || left.toolCallId === right.toolCallId)
}
function sameSourceOrigin(left: StoredMemorySource, right: StoredMemorySource): boolean {
  return sourceKey(left) === sourceKey(right) || left.kind === 'native-event' && right.kind === 'native-event' && sameNativeOrigin(left, right)
}
function sourceCovers(previous: StoredMemorySource, next: StoredMemorySource): boolean {
  if (sourceKey(previous) === sourceKey(next)) return true
  if (previous.kind !== 'native-event' || next.kind !== 'native-event' || !sameNativeOrigin(previous, next)) return false
  if (previous.body === undefined) return true
  if (next.body === undefined || previous.body.stream !== next.body.stream || previous.body.codec !== next.body.codec || previous.body.digest !== next.body.digest) return false
  return previous.body.range === undefined || next.body.range !== undefined
    && previous.body.range.start <= next.body.range.start && previous.body.range.end >= next.body.range.end
}
function isWithdrawn(memory: MemoryMetadata, withdrawals: Withdrawal[]): boolean {
  // 一条原消息可能支持多份不同记忆；撤回一个对象不能同时撤回其它已存对象。
  // 旧来源新引入目标主题的检查由 save 唯一入口完成。
  const blocked = withdrawals.filter(item => item.id === memory.id)
  if (blocked.length === 0) return false
  const source = memory.reconfirmedBy
  return source === undefined || !memory.sources.some(item => sourceKey(item) === sourceKey(source))
    || withdrawals.some(item => item.sources.some(previous => sameSourceOrigin(previous, source)))
}
function indexEntry(memory: MemoryMetadata & { body?: string }): MemoryIndexEntry {
  const { body: _body, sources: _sources, originSources: _origin, createdBy: _creator, updatedBy: _updater, createdAt: _created, reconfirmedBy: _reconfirmed, ...entry } = memory
  return entry
}
function safeTopic(value: string): string {
  const topic = value.normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '')
  if (!topic || topic.toLowerCase() === 'index' || topic !== basename(topic)) throw new Error('请使用有效且非 index 的主题名。')
  return topic
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('记忆字段格式不合法。')
  return value as Record<string, unknown>
}
function exactFields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('来源包含不支持的字段；未丢弃字段或声称完整保存。')
}
function textArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} 不能为空。`)
  return [...new Set(value.map(item => requiredText(item, label)))]
}
function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} 不能为空。`)
  return value.trim()
}
/** String.trim() and \S use the same ECMAScript whitespace definition. */
function checkBody(value: unknown): void {
  if (typeof value !== 'string' || !/\S/u.test(value)) throw new Error('body 不能为空。')
}
function oneLine(value: string): string { return value.replace(/[\r\n]+/g, ' ') }
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }
