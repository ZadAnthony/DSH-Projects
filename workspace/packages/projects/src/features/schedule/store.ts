import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { durableMutationDetails, ensureDirectoryDurable, withRootWriteLock, writeFileDurable, type RootWriteScope } from '../../metadata-files.ts'
import type { ScheduleMetadataFailure, SchedulePendingEffect } from './contract.ts'
import { stateSchema, type ScheduleState } from './validation.ts'

// 本地读写顺序保持；完整 mutation 另共用 records root 的跨进程短写锁。
const writes = new Map<string, Promise<void>>()
export interface ProjectSchedulePurgeResult {
  complete: boolean
  removed: string[]
  alreadyAbsent: boolean
  failure?: string
  metadata?: ScheduleMetadataFailure
}
export class ProjectScheduleStore {
  constructor(readonly projectId: string, readonly projectDirectory: string) {}
  async read(): Promise<ScheduleState> { return this.serial(() => this.load()) }
  async readWith<T>(consumer: (state: ScheduleState) => T): Promise<T> {
    return this.serial(async () => structuredClone(consumer(await this.load())))
  }
  /** 删除事务已封闭目标写入后，清除其全部定义及两种trigger的历史，包括已移除定义。 */
  async purgeSession(sessionId: string): Promise<ProjectSchedulePurgeResult> {
    try { return await this.mutate(undefined, scope => this.purgeSessionWithin(scope, sessionId)) }
    catch (error) { return { complete: false, removed: [], alreadyAbsent: false, failure: describe(error),
      ...(durableMutationDetails(error) === undefined ? {} : { metadata: durableMutationDetails(error) }) } }
  }
  async purgeSessionWithin(scope: RootWriteScope, sessionId: string): Promise<ProjectSchedulePurgeResult> {
    const result: ProjectSchedulePurgeResult = { complete: false, removed: [], alreadyAbsent: false }
    try {
      await this.assertScope(scope)
      const state = await this.load()
      const selected = [...state.schedules.filter(item => item.sessionId === sessionId).map(item => `definition:${item.id}`),
        ...state.runs.filter(item => item.sessionId === sessionId).map(item => `run:${item.id}`)]
      result.alreadyAbsent = selected.length === 0
      state.schedules = state.schedules.filter(item => item.sessionId !== sessionId)
      state.runs = state.runs.filter(item => item.sessionId !== sessionId)
      try { if (selected.length > 0) { await this.assertScope(scope); await this.save(state) } }
      catch (error) { result.failure = describe(error); result.metadata = durableMutationDetails(error) }
      // 读回只核对当前可见清理，不确认曾失败的目录耐久同步。
      const actual = await this.load()
      const remaining = new Set([...actual.schedules.map(item => `definition:${item.id}`), ...actual.runs.map(item => `run:${item.id}`)])
      result.removed = selected.filter(id => !remaining.has(id))
      result.complete = result.failure === undefined && !actual.schedules.some(item => item.sessionId === sessionId) && !actual.runs.some(item => item.sessionId === sessionId)
      if (!result.complete) result.failure ??= '目标定时记录清理未确认。'
      return result
    } catch (error) {
      result.failure = [result.failure, describe(error)].filter(Boolean).join('；')
      result.metadata ??= durableMutationDetails(error)
      return result
    }
  }
  /** 设置保存与同步 pending 消费共用原 serial；flush 留给同一 target operation。 */
  async changeCommitted<T>(
    operation: (state: ScheduleState) => T,
    consumer: (state: ScheduleState, result: T) => SchedulePendingEffect,
    signal?: AbortSignal,
  ): Promise<ScheduleCommitResult<T>> {
    return this.mutate(signal, scope => this.changeCommittedWithin(scope, operation, consumer, signal))
  }
  async changeCommittedWithin<T>(
    scope: RootWriteScope,
    operation: (state: ScheduleState) => T,
    consumer: (state: ScheduleState, result: T) => SchedulePendingEffect,
    signal?: AbortSignal,
  ): Promise<ScheduleCommitResult<T>> {
    await this.assertScope(scope)
    signal?.throwIfAborted()
    const state = await this.load()
    const previous = JSON.stringify(state)
    const result = operation(state)
    stateSchema.parse(state)
    const intended = JSON.stringify(state)
    let configuration: 'confirmed' | 'unconfirmed' | 'unchanged' = intended === previous ? 'unchanged' : 'confirmed'
    if (intended !== previous) {
      try { await this.assertScope(scope); await this.save(state, signal) }
      catch (error) {
        // rename 后的错误不能被称为零效果；读回仍留在原 slot，不重试写或修改 native。
        let actual: string | undefined
        let readError: string | undefined
        try { actual = JSON.stringify(await this.load()) } catch (failure) { readError = describe(failure) }
        const metadata = durableMutationDetails(error)
        configuration = metadata !== undefined && metadata.effect !== 'none' ? 'unconfirmed' : actual === previous ? 'unchanged' : 'unconfirmed'
        const message = [describe(error), readError === undefined ? undefined : `保存后读取未确认：${readError}`].filter(Boolean).join('；')
        return { result: structuredClone(result), configuration,
          pending: effect(configuration === 'unchanged' ? 'unchanged' : 'unconfirmed', message), error: message,
          ...(metadata === undefined ? {} : { metadata }) }
      }
    }
    try { return { result: structuredClone(result), configuration, pending: structuredClone(consumer(state, result)) } }
    catch (error) {
      const message = describe(error)
      return { result: structuredClone(result), configuration, pending: effect('unconfirmed', message), error: message }
    }
  }
  async change<T>(operation: (state: ScheduleState) => T, signal?: AbortSignal): Promise<T> {
    return this.mutate(signal, scope => this.changeWithin(scope, operation, signal))
  }
  async changeWithin<T>(scope: RootWriteScope, operation: (state: ScheduleState) => T, signal?: AbortSignal): Promise<T> {
    await this.assertScope(scope)
    signal?.throwIfAborted()
    const state = await this.load(); const previous = JSON.stringify(state)
    const result = operation(state)
    stateSchema.parse(state)
    if (JSON.stringify(state) !== previous) { await this.assertScope(scope); await this.save(state, signal) }
    return structuredClone(result)
  }
  private async mutate<T>(signal: AbortSignal | undefined, action: (scope: RootWriteScope) => Promise<T>): Promise<T> {
    await this.assertProjectDirectory()
    return this.serial(() => withRootWriteLock({ root: dirname(this.projectDirectory), anchor: '.metadata.lock', signal }, action))
  }
  private async assertScope(scope: RootWriteScope): Promise<void> {
    await scope.assertCurrent()
    if (scope.root !== await realpath(dirname(this.projectDirectory))) throw new Error('定时写入不属于当前元数据根。')
    await this.assertProjectDirectory()
  }
  private async assertProjectDirectory(): Promise<void> {
    const info = await lstat(this.projectDirectory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('定时项目必须是已存在的真实目录。')
  }
  private async serial<T>(action: () => Promise<T>): Promise<T> {
    const key = join(await realpath(this.projectDirectory), 'schedules', 'state.json')
    const next = (writes.get(key) ?? Promise.resolve()).then(action, action)
    const settled = next.then(() => {}, () => {}); writes.set(key, settled)
    try { return await next } finally { if (writes.get(key) === settled) writes.delete(key) }
  }
  private async directory(create: boolean): Promise<string | undefined> {
    await this.assertProjectDirectory()
    const directory = join(await realpath(this.projectDirectory), 'schedules')
    try {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('定时目录不属于项目内的真实目录。')
    } catch (error) {
      if (!missing(error)) throw error
      if (!create) return undefined
      await this.assertProjectDirectory()
      await ensureDirectoryDurable(directory)
    }
    return directory
  }
  private async load(): Promise<ScheduleState> {
    const directory = await this.directory(false)
    if (directory === undefined) return this.empty()
    try {
      const path = join(directory, 'state.json'); await regular(path)
      const state = stateSchema.parse(JSON.parse(await readFile(path, 'utf8')))
      if (state.projectId !== this.projectId) throw new Error('定时文件的项目归属不匹配。')
      return state
    } catch (error) { if (missing(error)) return this.empty(); throw error }
  }
  private empty(): ScheduleState { return { version: 3, projectId: this.projectId, schedules: [], runs: [] } }
  private async save(state: ScheduleState, signal?: AbortSignal): Promise<void> {
    const directory = (await this.directory(true))!
    const path = join(directory, 'state.json')
    try { await regular(path) } catch (error) { if (!missing(error)) throw error }
    signal?.throwIfAborted()
    await writeFileDurable(path, JSON.stringify(state, null, 2) + '\n', { beforePublish: () => signal?.throwIfAborted() })
  }
}
export interface ScheduleCommitResult<T> {
  result: T
  configuration: 'confirmed' | 'unconfirmed' | 'unchanged'
  pending: SchedulePendingEffect
  error?: string
  metadata?: ScheduleMetadataFailure
}
async function regular(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('定时记录不是项目内的普通文件。')
}
function missing(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT' }

function describe(error: unknown): string { return typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error) }
function effect(kind: SchedulePendingEffect['kind'], error?: string): SchedulePendingEffect {
  return { kind, updatedMessageIds: [], removedMessageIds: [], ...(error === undefined ? {} : { error }) }
}
