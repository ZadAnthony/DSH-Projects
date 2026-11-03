import { lstat, readFile, realpath, rmdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { DurableMutationError, ensureDirectoryDurable, removeFileDurable, syncDirectory, withRootWriteLock, writeFileDurable, type RootWriteScope } from '../../metadata-files.ts'
import type { ExecutionDefaults, ModelSelection, ProjectInstructions, SessionInstructions, SessionInstructionsInitialization, SettingsWriteResult } from './types.ts'

/** 只标识初始化的来源读取失败；归属、取消与保存失败不归入此类。 */
export class SessionInstructionsReadError extends Error {
  constructor(cause: unknown) {
    super('单会话指令读取失败：' + (cause instanceof Error ? cause.message : String(cause)), { cause })
  }
}

/** 每个配置只写自己的文件，保持与核心记录、共享记忆和 DSH 当前选择分离。 */
export class ProjectSettingsStore {
  readonly projectDirectory: string
  constructor(readonly projectId: string, projectDirectory: string) {
    text(projectId, 'project id')
    this.projectDirectory = resolve(projectDirectory)
  }

  readDefaults(): Promise<ExecutionDefaults> {
    return this.loadDefaults()
  }

  saveDefaults(selection: ModelSelection | null, expectedRevision: number, signal?: AbortSignal): Promise<SettingsWriteResult<ExecutionDefaults>> {
    return this.mutate(signal, scope => this.saveDefaultsWithin(scope, selection, expectedRevision, signal))
  }

  async saveDefaultsWithin(scope: RootWriteScope, selection: ModelSelection | null, expectedRevision: number, signal?: AbortSignal): Promise<SettingsWriteResult<ExecutionDefaults>> {
    await this.assertScope(scope)
    const nextSelection = selection === null ? null : modelSelection(selection)
    revision(expectedRevision)
    signal?.throwIfAborted()
    const current = await this.loadDefaults()
    if (current.revision !== expectedRevision) return { kind: 'conflict', current }
    const value: ExecutionDefaults = { projectId: this.projectId, revision: current.revision + 1,
      selection: nextSelection, updatedAt: new Date().toISOString() }
    await this.write(scope, ['settings'], 'execution-defaults.json', value, signal)
    return { kind: 'saved', value }
  }

  readInstructions(sessionId: string): Promise<SessionInstructions> {
    leaf(sessionId)
    return this.loadInstructions(sessionId)
  }

  /** 缺文件才初始化；显式清空仍是已保存值，不能再次还原默认职责。 */
  initializeInstructions(sessionId: string, instructions: string, signal?: AbortSignal): Promise<SessionInstructionsInitialization> {
    return this.mutate(signal, scope => this.initializeInstructionsWithin(scope, sessionId, instructions, signal))
  }

  async initializeInstructionsWithin(scope: RootWriteScope, sessionId: string, instructions: string, signal?: AbortSignal): Promise<SessionInstructionsInitialization> {
    await this.assertScope(scope)
    leaf(sessionId)
    if (typeof instructions !== 'string') throw new Error('会话指令必须是文字。')
    signal?.throwIfAborted()
    let current: SessionInstructions
    try { current = await this.loadInstructions(sessionId) }
    catch (error) { throw new SessionInstructionsReadError(error) }
    if (current.revision !== 0) return { kind: 'existing', value: current }
    const value: SessionInstructions = { projectId: this.projectId, sessionId, revision: 1,
      instructions: instructions.trim() === '' ? '' : instructions, updatedAt: new Date().toISOString() }
    await this.write(scope, ['sessions', sessionId, 'settings'], 'instructions.json', value, signal)
    return { kind: 'initialized', value }
  }

  /** 仅用于已证实原生会话从未物化的创建回滚；不删除后来保存的用户值。 */
  discardInitializedInstructions(initial: SessionInstructions): Promise<boolean> {
    return this.mutate(undefined, scope => this.discardInitializedInstructionsWithin(scope, initial))
  }

  async discardInitializedInstructionsWithin(scope: RootWriteScope, initial: SessionInstructions): Promise<boolean> {
    await this.assertScope(scope)
    leaf(initial.sessionId)
    if (initial.projectId !== this.projectId || initial.revision !== 1) throw new Error('不是本项目的初始会话指令。')
    const current = await this.loadInstructions(initial.sessionId)
    if (current.revision !== 0 && (current.revision !== initial.revision
      || current.instructions !== initial.instructions || current.updatedAt !== initial.updatedAt)) return false
    const parts = ['sessions', initial.sessionId, 'settings']
    const directory = await this.directory(parts, false)
    if (directory !== undefined && current.revision !== 0) await removeFileDurable(join(directory, 'instructions.json'))
    for (let length = parts.length; length > 0; length -= 1) {
      const path = await this.directory(parts.slice(0, length), false)
      if (path === undefined) continue
      let removed = false
      try {
        await scope.assertCurrent()
        await rmdir(path); removed = true
        await syncDirectory(dirname(path))
      } catch (error) {
        if (removed) throw new DurableMutationError('directory-sync', 'published-durability-unknown', error)
        if (missing(error)) continue
        if ((error as NodeJS.ErrnoException)?.code === 'ENOTEMPTY') break
        throw error
      }
    }
    return true
  }

  readProjectInstructions(): Promise<ProjectInstructions> {
    return this.loadProjectInstructions()
  }

  saveProjectInstructions(instructions: string, expectedRevision: number, signal?: AbortSignal): Promise<SettingsWriteResult<ProjectInstructions>> {
    return this.mutate(signal, scope => this.saveProjectInstructionsWithin(scope, instructions, expectedRevision, signal))
  }

  async saveProjectInstructionsWithin(scope: RootWriteScope, instructions: string, expectedRevision: number, signal?: AbortSignal): Promise<SettingsWriteResult<ProjectInstructions>> {
    await this.assertScope(scope)
    revision(expectedRevision)
    if (typeof instructions !== 'string') throw new Error('项目指令必须是文字。')
    signal?.throwIfAborted()
    const current = await this.loadProjectInstructions()
    if (current.revision !== expectedRevision) return { kind: 'conflict', current }
    const value: ProjectInstructions = { projectId: this.projectId, revision: current.revision + 1,
      instructions: instructions.trim() === '' ? '' : instructions, updatedAt: new Date().toISOString() }
    await this.write(scope, ['settings'], 'project-instructions.json', value, signal)
    return { kind: 'saved', value }
  }

  saveInstructions(sessionId: string, instructions: string, expectedRevision: number, signal?: AbortSignal): Promise<SettingsWriteResult<SessionInstructions>> {
    return this.mutate(signal, scope => this.saveInstructionsWithin(scope, sessionId, instructions, expectedRevision, signal))
  }

  async saveInstructionsWithin(scope: RootWriteScope, sessionId: string, instructions: string, expectedRevision: number, signal?: AbortSignal): Promise<SettingsWriteResult<SessionInstructions>> {
    await this.assertScope(scope)
    leaf(sessionId); revision(expectedRevision)
    if (typeof instructions !== 'string') throw new Error('会话指令必须是文字。')
    signal?.throwIfAborted()
    const current = await this.loadInstructions(sessionId)
    if (current.revision !== expectedRevision) return { kind: 'conflict', current }
    const value: SessionInstructions = { projectId: this.projectId, sessionId, revision: current.revision + 1,
      instructions: instructions.trim() === '' ? '' : instructions, updatedAt: new Date().toISOString() }
    await this.write(scope, ['sessions', sessionId, 'settings'], 'instructions.json', value, signal)
    return { kind: 'saved', value }
  }

  removeInstructions(sessionId: string): Promise<'removed' | 'already-absent'> {
    return this.mutate(undefined, scope => this.removeInstructionsWithin(scope, sessionId))
  }

  async removeInstructionsWithin(scope: RootWriteScope, sessionId: string): Promise<'removed' | 'already-absent'> {
    await this.assertScope(scope)
    leaf(sessionId)
    const directory = await this.directory(['sessions', sessionId, 'settings'], false)
    if (directory === undefined) return 'already-absent'
    const path = join(directory, 'instructions.json')
    try {
      await regular(path)
      await scope.assertCurrent()
      return await removeFileDurable(path)
    } catch (error) { if (missing(error)) return 'already-absent'; throw error }
  }

  private async loadDefaults(): Promise<ExecutionDefaults> {
    const data = await this.read(['settings'], 'execution-defaults.json')
    if (data === undefined) return { projectId: this.projectId, revision: 0, selection: null }
    this.owner(data)
    return { projectId: this.projectId, revision: storedRevision(data.revision),
      selection: data.selection === null ? null : modelSelection(data.selection), updatedAt: text(data.updatedAt, '更新时间') }
  }

  private async loadInstructions(sessionId: string): Promise<SessionInstructions> {
    const data = await this.read(['sessions', sessionId, 'settings'], 'instructions.json')
    if (data === undefined) return { projectId: this.projectId, sessionId, revision: 0, instructions: '' }
    this.owner(data)
    if (data.sessionId !== sessionId) throw new Error('会话指令的会话归属不匹配。')
    if (typeof data.instructions !== 'string') throw new Error('已保存的会话指令损坏。')
    return { projectId: this.projectId, sessionId, revision: storedRevision(data.revision),
      instructions: data.instructions, updatedAt: text(data.updatedAt, '更新时间') }
  }

  private async loadProjectInstructions(): Promise<ProjectInstructions> {
    const data = await this.read(['settings'], 'project-instructions.json')
    if (data === undefined) return { projectId: this.projectId, revision: 0, instructions: '' }
    this.owner(data)
    if (typeof data.instructions !== 'string') throw new Error('已保存的项目指令损坏。')
    return { projectId: this.projectId, revision: storedRevision(data.revision),
      instructions: data.instructions, updatedAt: text(data.updatedAt, '更新时间') }
  }

  private owner(data: Record<string, unknown>): void {
    if (data.version !== 1 || data.projectId !== this.projectId) throw new Error('设置文件的版本或项目归属不匹配。')
  }

  private mutate<T>(signal: AbortSignal | undefined, operation: (scope: RootWriteScope) => Promise<T>): Promise<T> {
    return withRootWriteLock({ root: dirname(this.projectDirectory), anchor: '.metadata.lock', signal }, operation)
  }

  private async assertScope(scope: RootWriteScope): Promise<void> {
    await scope.assertCurrent()
    if (scope.root !== await realpath(dirname(this.projectDirectory))) throw new Error('设置写入不属于当前元数据根。')
    await this.assertProjectDirectory()
  }

  private async assertProjectDirectory(): Promise<void> {
    const info = await lstat(this.projectDirectory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('设置项目必须是已存在的真实目录。')
  }

  private async directory(parts: string[], create: boolean): Promise<string | undefined> {
    await this.assertProjectDirectory()
    let directory = this.projectDirectory
    for (const part of parts) {
      leaf(part)
      directory = join(directory, part)
      try {
        const info = await lstat(directory)
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('设置目录不属于项目内的真实目录。')
      } catch (error) {
        if (!missing(error)) throw error
        if (!create) return undefined
        await this.assertProjectDirectory()
        await ensureDirectoryDurable(directory)
      }
    }
    return directory
  }

  private async read(parts: string[], file: string): Promise<Record<string, unknown> | undefined> {
    const directory = await this.directory(parts, false)
    if (directory === undefined) return undefined
    const path = join(directory, file)
    try {
      await regular(path)
      const value: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('设置文件格式不合法。')
      return value as Record<string, unknown>
    } catch (error) { if (missing(error)) return undefined; throw error }
  }

  private async write(scope: RootWriteScope, parts: string[], file: string, value: object, signal?: AbortSignal): Promise<void> {
    await this.assertScope(scope)
    const directory = (await this.directory(parts, true))!
    const path = join(directory, file)
    try { await regular(path) } catch (error) { if (!missing(error)) throw error }
    signal?.throwIfAborted()
    await scope.assertCurrent()
    await writeFileDurable(path, JSON.stringify({ version: 1, ...value }, null, 2) + '\n', { beforePublish: () => signal?.throwIfAborted() })
  }
}

export function modelSelection(raw: unknown): ModelSelection {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('模型选择格式不合法。')
  const value = raw as Record<string, unknown>
  return { provider: text(value.provider, '模型提供者'), model: text(value.model, '模型'),
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: text(value.reasoningEffort, '推理选项') }) }
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空。`)
  return value.trim()
}
function leaf(value: string): void {
  if (!value || value === '.' || value === '..' || /[/\\\x00]/.test(value)) throw new Error('会话或目录标识不合法。')
}
function revision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('设置修订不合法。')
}
function storedRevision(value: unknown): number { revision(value as number); if (value === 0) throw new Error('设置修订不合法。'); return value as number }
async function regular(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('设置文件必须是项目内的普通文件。')
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }
