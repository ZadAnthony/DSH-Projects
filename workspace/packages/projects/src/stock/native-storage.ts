/** Finite Projects-owned native write windows; native backends and caches stay original. */
import { join } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { scheduleDomain } from '@deepseek-ai/dsh-schedule'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { withRootWriteLock, type RootWriteScope } from '../metadata-files.ts'

/** Cancel lock wait on context disposal; an admitted native action still drains before release. */
async function withNativeWriteScope<T>(
  ctx: Context, dataRoot: string, action: (scope: RootWriteScope, waiting: AbortSignal) => Promise<T>, signal?: AbortSignal,
): Promise<T> {
  const lifetime = new AbortController()
  const waiting = signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal])
  let pending: Promise<T> | undefined
  const dispose = ctx.effect(() => () => {
    lifetime.abort(new Error('Projects native storage owner is closing'))
    return pending?.then(() => {}, () => {})
  }, 'projects.native-storage-write')
  try {
    pending = withRootWriteLock({ root: join(dataRoot, 'native-storage'), anchor: '.write.lock', signal: waiting },
      scope => action(scope, waiting))
    return await pending
  } finally {
    pending = undefined
    await dispose()
  }
}

/** The current private UI uses this registry read-only once its original startup has completed. */
export function initializeProjectsWorkspaceRegistry(ctx: Context, dataRoot: string, signal?: AbortSignal): Promise<Fiber> {
  return withNativeWriteScope(ctx, dataRoot, async (scope, waiting) => {
    await scope.assertCurrent()
    waiting.throwIfAborted()
    let fiber: Fiber | undefined
    try {
      fiber = ctx.plugin(WorkspaceRegistry)
      await fiber.await()
      waiting.throwIfAborted()
      if (fiber.uid === null || ctx.get('workspaceRegistry') === undefined) throw new Error('Projects Workspace registry did not become ready')
      await scope.assertCurrent()
      return fiber
    } catch (error) {
      try { await fiber?.dispose() }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Projects Workspace initialization and native cleanup were not confirmed') }
      throw error
    }
  }, signal)
}

/** Open after acquiring the shared native-root lock; never let a writable domain escape this scope. */
export function withProjectsScheduleDomain<T>(
  ctx: Context, dataRoot: string, action: (domain: Domain<typeof scheduleDomain>) => Promise<T>, signal?: AbortSignal,
): Promise<T> {
  if (ctx.get('schedule') !== undefined) return Promise.reject(new Error('schedule: native producer must not own Project targets'))
  return withNativeWriteScope(ctx, dataRoot, async scope => {
    if (ctx.get('schedule') !== undefined) throw new Error('schedule: native producer must not own Project targets')
    const facility = ctx.get('storageDomain')
    if (facility === undefined) throw new Error('schedule: private storage domain facility is unavailable')
    await scope.assertCurrent()
    const domain = await facility.open(scheduleDomain)
    let result: T
    try { result = await action(domain) }
    catch (error) {
      try { await domain.close() }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Native Schedule action and close were not confirmed; verify saved state before retrying') }
      throw error
    }
    await domain.close()
    await scope.assertCurrent()
    return result
  }, signal)
}
