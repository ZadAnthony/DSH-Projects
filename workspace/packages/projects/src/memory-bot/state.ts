import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { syncDirectory, withRootWriteLock, writeFileDurable, type RootWriteScope } from '../metadata-files.ts'
import type { FrozenMemoryBatch, MemoryBotState } from './types.ts'

export const MEMORY_BOT_STATE_FILE = '.bot-state.json'

export async function readMemoryBotState(projectDirectory: string, projectId: string): Promise<MemoryBotState> {
  let text: string
  try {
    await checkDirectory(projectDirectory)
    const path = join(projectDirectory, 'memory', MEMORY_BOT_STATE_FILE)
    await checkStateFile(path)
    text = await readFile(path, 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, projectId, processed: [], requests: [], pendingBatches: [] }
    throw error
  }
  const value: MemoryBotState = JSON.parse(text)
  if (value.projectId !== projectId) throw new Error('记忆批处理状态不属于当前项目。')
  return upgradeMemoryBotState(value)
}

/** Lossless structural migration only: no IO, no completion, no new execution. */
export function upgradeMemoryBotState(value: MemoryBotState): MemoryBotState {
  if ((value.version !== 1 && value.version !== 2) || !Array.isArray(value.processed) || !Array.isArray(value.requests)) throw new Error('记忆批处理状态格式不可读。')
  const state = structuredClone(value)
  if (state.version === 1) {
    state.version = 2
    state.pendingBatches = state.frozen === undefined ? [] : [{ ...state.frozen, kind: 'ordinary', legacy: true }]
    const attempted = new Set(state.frozen?.requestIds ?? [])
    const retained = state.requests.filter(request => !attempted.has(request.requestId))
    if (retained.length > 0) state.pendingBatches.push({ batchId: `legacy-pending-${state.projectId}`, kind: 'explicit', cuts: [], requestIds: retained.map(request => request.requestId), legacy: true })
    // A cold upgrade cannot grant a fresh automatic attempt to historical requests.
    state.requests = state.requests.map(request => ({ ...request, attempted: true }))
  }
  if (!Array.isArray(state.pendingBatches)) state.pendingBatches = state.frozen === undefined ? [] : [state.frozen]
  if (new Set(state.pendingBatches.map(batch => batch.batchId)).size !== state.pendingBatches.length) throw new Error('记忆批次标识重复。')
  for (const batch of [...state.pendingBatches, ...(state.frozen === undefined ? [] : [state.frozen])]) {
    if (batch.projectionVersion !== undefined && batch.projectionVersion !== 2) throw new Error('不支持的记忆投影版本。')
  }
  state.frozen = state.pendingBatches[0]
  if (state.frozen === undefined) delete state.frozen
  return state
}

export class MemoryBotStateConflictError extends Error {
  readonly code = 'PROJECT_MEMORY_STATE_CONFLICT'
  constructor() { super('记忆批次状态已由另一端更新，未覆盖或重新准备冻结输入。') }
}

export function assertMemoryBotState(previous: MemoryBotState | FrozenMemoryBatch, current: MemoryBotState | FrozenMemoryBatch): void {
  if (!isDeepStrictEqual(previous, current)) throw new MemoryBotStateConflictError()
}

/** Standalone format/scratch entry; production supplies the Core-authorized scope. */
export function mutateMemoryBotState<T>(projectDirectory: string, projectId: string, transform: (latest: MemoryBotState) => T, signal?: AbortSignal): Promise<T> {
  return withRootWriteLock({ root: dirname(projectDirectory), anchor: '.metadata.lock', signal },
    scope => mutateMemoryBotStateWithin(scope, projectDirectory, projectId, transform, signal))
}

export async function mutateMemoryBotStateWithin<T>(scope: RootWriteScope, projectDirectory: string, projectId: string, transform: (latest: MemoryBotState) => T, signal?: AbortSignal): Promise<T> {
  await assertStateScope(scope, projectDirectory)
  signal?.throwIfAborted()
  const latest = await readMemoryBotState(projectDirectory, projectId)
  const result = transform(latest)
  await writeMemoryBotStateWithin(scope, projectDirectory, latest, signal)
  return result
}

/** Explicit whole-state replacement retained for isolated format fixtures, never owner RMW. */
export function writeMemoryBotState(projectDirectory: string, state: MemoryBotState): Promise<void> {
  return withRootWriteLock({ root: dirname(projectDirectory), anchor: '.metadata.lock' }, scope => writeMemoryBotStateWithin(scope, projectDirectory, state))
}

export async function writeMemoryBotStateWithin(scope: RootWriteScope, projectDirectory: string, state: MemoryBotState, signal?: AbortSignal): Promise<void> {
  await assertStateScope(scope, projectDirectory)
  state = upgradeMemoryBotState(state)
  const directory = join(projectDirectory, 'memory')
  await checkDirectory(projectDirectory)
  try { await mkdir(directory, { mode: 0o700 }); await syncDirectory(projectDirectory) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  await checkDirectory(projectDirectory)
  const target = join(directory, MEMORY_BOT_STATE_FILE)
  await checkStateFile(target)
  await scope.assertCurrent()
  await writeFileDurable(target, JSON.stringify(state, null, 2) + '\n', { beforePublish: () => signal?.throwIfAborted() })
}

async function assertStateScope(scope: RootWriteScope, projectDirectory: string): Promise<void> {
  await scope.assertCurrent()
  if (dirname(await realpath(projectDirectory)) !== scope.root) throw new Error('记忆状态不属于当前metadata事务root。')
}

/** 对齐ProjectMemoryStore既有边界：项目根由core解析，memory必须是项目内真实目录。 */
async function checkDirectory(projectDirectory: string): Promise<void> {
  await realpath(projectDirectory)
  try {
    const info = await lstat(join(projectDirectory, 'memory'))
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('memory 必须是当前项目内的真实目录。')
  } catch (error) { if (!isMissing(error)) throw error }
}

async function checkStateFile(path: string): Promise<void> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('记忆批处理状态必须是当前项目内的普通文件。')
  } catch (error) { if (!isMissing(error)) throw error }
}

function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
