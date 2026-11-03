import { constants } from 'node:fs'
import { mkdir, open, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import { SessionAlreadyOwnedError, SessionOwnershipLostError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session'

export function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code
}

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

/** Sync every newly created directory entry, including the configured dataRoot itself. */
export async function durableMkdir(directory: string): Promise<void> {
  try {
    const existing = await stat(directory)
    if (!existing.isDirectory()) throw new TypeError(`not a directory: ${directory}`)
    return
  } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
  const parent = dirname(directory)
  if (parent === directory) throw new Error(`cannot create filesystem root ${directory}`)
  await durableMkdir(parent)
  try { await mkdir(directory, { mode: 0o700 }) } catch (error) { if (!hasCode(error, 'EEXIST')) throw error }
  await syncDirectory(parent)
}

/** FileHandle.write may return a short write. Zero progress is an I/O failure. */
export async function writeAll(file: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0
  while (offset < bytes.length) {
    const result = await file.write(bytes, offset, bytes.length - offset, null)
    if (result.bytesWritten <= 0) throw new Error('journal write made no progress')
    offset += result.bytesWritten
  }
}

/** Stable lock anchors are never removed or renamed; only closing this fd releases ownership. */
export class ProjectWriterLock {
  private closed = false
  private constructor(readonly path: string, private readonly file: FileHandle, private readonly id: SessionId) {}

  static async acquire(dataRoot: string, id: SessionId): Promise<ProjectWriterLock> {
    const directory = join(dataRoot, 'locks')
    await durableMkdir(directory)
    const digest = createHash('sha256').update(Buffer.from(id, 'utf16le')).digest('hex')
    const path = join(directory, `${digest}.lock`)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
      try {
        try { await tryLockExclusive(file.fd) } catch (error) {
          if (hasCode(error, 'EAGAIN') || hasCode(error, 'EWOULDBLOCK')) throw new SessionAlreadyOwnedError(id)
          throw error
        }
        const lock = new ProjectWriterLock(path, file, id)
        try { await lock.assertOwned(); return lock } catch (error) {
          if (!(error instanceof SessionOwnershipLostError)) throw error
        }
      } catch (error) { await file.close(); throw error }
      await file.close()
    }
    throw new SessionAlreadyOwnedError(id)
  }

  async assertOwned(): Promise<void> {
    if (this.closed) throw new SessionOwnershipLostError(this.id)
    const held = await this.file.stat({ bigint: true })
    const current = await stat(this.path, { bigint: true }).catch(error => {
      if (hasCode(error, 'ENOENT')) return undefined
      throw error
    })
    if (current === undefined || held.ino !== current.ino || held.dev !== current.dev) throw new SessionOwnershipLostError(this.id)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.file.close()
  }
}
