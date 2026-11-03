import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as wait } from 'node:timers/promises'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'

import type { RootWriteScope } from './metadata-contract.ts'
export type { RootWriteScope } from './metadata-contract.ts'

import { DurableMutationError, type DurableMutationEffect, type DurableMutationStage } from './metadata-errors.ts'
export { DurableMutationError, durableMutationDetails } from './metadata-errors.ts'
export type { DurableMutationEffect, DurableMutationStage } from './metadata-errors.ts'

function hasCode(error: unknown, code: string): boolean { return (error as NodeJS.ErrnoException | undefined)?.code === code }

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

/** For an owner's stable root or already-authorized child directory only. */
export async function ensureDirectoryDurable(path: string): Promise<void> {
  try {
    const current = await stat(path)
    if (!current.isDirectory()) throw new Error(`Metadata directory is not a directory: ${path}`)
    // Another process may have just created this entry and not synced its parent yet.
    await syncDirectory(dirname(path))
    return
  } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
  const parent = dirname(path)
  if (parent === path) throw new Error(`Cannot create metadata filesystem root: ${path}`)
  await ensureDirectoryDurable(parent)
  try { await mkdir(path, { mode: 0o700 }) } catch (error) { if (!hasCode(error, 'EEXIST')) throw error }
  await syncDirectory(parent)
}

/**
 * The anchor is stable and never unlinked. Kernel ownership, rather than a PID
 * record or a Promise queue, coordinates every process using this owner root.
 * Wait polling only adapts the addon's nonblocking flock and is cancellable.
 */
export async function withRootWriteLock<T>(
  options: { root: string; anchor: string; signal?: AbortSignal },
  action: (scope: RootWriteScope) => Promise<T>,
): Promise<T> {
  if (!options.anchor || options.anchor === '.' || options.anchor === '..' || /[\\/]/u.test(options.anchor)) throw new TypeError('Metadata lock anchor must be a basename')
  options.signal?.throwIfAborted()
  await ensureDirectoryDurable(resolve(options.root))
  const root = await realpath(options.root)
  const anchorPath = join(root, options.anchor)
  const file = await open(anchorPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  let active = true
  let acquired = false
  let actionSucceeded = false
  const scope: RootWriteScope = {
    root, anchorPath,
    async assertCurrent() {
      if (!active || !acquired) throw new Error('Metadata write scope is not active')
      const held = await file.stat({ bigint: true })
      const current = await lstat(anchorPath, { bigint: true })
      if (!current.isFile() || current.isSymbolicLink() || held.dev !== current.dev || held.ino !== current.ino) throw new Error('Metadata lock anchor identity changed')
      const currentRoot = await realpath(options.root)
      if (currentRoot !== root) throw new Error('Metadata owner root identity changed')
    },
  }
  try {
    for (;;) {
      options.signal?.throwIfAborted()
      try { await tryLockExclusive(file.fd); acquired = true; break }
      catch (error) {
        if (!hasCode(error, 'EAGAIN') && !hasCode(error, 'EWOULDBLOCK')) throw error
        try { await wait(10, undefined, options.signal === undefined ? {} : { signal: options.signal }) }
        catch (error) { options.signal?.throwIfAborted(); throw error }
      }
    }
    options.signal?.throwIfAborted()
    await scope.assertCurrent()
    const result = await action(scope)
    actionSucceeded = true
    return result
  } finally {
    active = false
    // action is awaited before release, including its original I/O drain.
    try { await file.close() } catch (error) {
      // Releasing a lock cannot retroactively make a confirmed write disappear.
      if (actionSucceeded) console.warn('Metadata transaction completed but lock release was not confirmed', error)
      else console.warn('Metadata transaction failed and lock release also failed', error)
    }
  }
}

/** Durable same-directory replacement. Parent existence/authorization is the owner’s responsibility. */
export async function writeFileDurable(
  path: string, content: string | Uint8Array, options?: { beforePublish?: () => void },
): Promise<void> {
  const scratch = `${path}.${randomUUID()}.tmp`
  let stage: DurableMutationStage = 'write'
  let published = false
  let scratchIdentity: { ino: bigint; dev: bigint } | undefined
  try {
    // Node's writeFile handles short writes and closes its original fd before resolving.
    await writeFile(scratch, content, { flag: 'wx', mode: 0o600 })
    stage = 'file-sync'
    const file = await open(scratch, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { scratchIdentity = await file.stat({ bigint: true }); await file.sync() } finally { await file.close() }
    options?.beforePublish?.()
    stage = 'rename'
    await rename(scratch, path)
    published = true
    stage = 'directory-sync'
    await syncDirectory(dirname(path))
  } catch (error) {
    let effect: DurableMutationEffect = published ? 'published-durability-unknown' : 'none'
    if (!published && stage === 'rename') {
      try {
        const actual = await stat(path, { bigint: true })
        if (scratchIdentity === undefined || actual.ino === scratchIdentity.ino && actual.dev === scratchIdentity.dev) effect = 'published-durability-unknown'
      } catch (readError) { if (!hasCode(readError, 'ENOENT')) effect = 'published-durability-unknown' }
    }
    const failure = new DurableMutationError(stage, effect, error)
    try { await unlink(scratch) } catch (cleanup) {
      if (!hasCode(cleanup, 'ENOENT')) console.warn('Metadata scratch cleanup failed after original mutation failure', cleanup)
    }
    throw failure
  }
}

export async function removeFileDurable(path: string): Promise<'removed' | 'already-absent'> {
  let removed = false
  let originalExists = false
  try {
    try { await lstat(path); originalExists = true } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
    try { await unlink(path); removed = true } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
    await syncDirectory(dirname(path))
    return removed ? 'removed' : 'already-absent'
  } catch (error) {
    let effect: DurableMutationEffect = removed ? 'published-durability-unknown' : 'none'
    if (!removed && originalExists) {
      try { await lstat(path) } catch (readError) {
        // The call rejected after a possibly effective unlink, or current visibility is unknown.
        effect = 'published-durability-unknown'
      }
    }
    throw new DurableMutationError(removed ? 'directory-sync' : 'remove', effect, error)
  }
}
