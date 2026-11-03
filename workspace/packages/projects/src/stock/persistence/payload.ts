import { link, open, opendir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { deepFreeze, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { durableMkdir, hasCode, syncDirectory, writeAll } from './files.ts'
import { rowDigest } from './directory.ts'
import type { ProjectPayloadOwner, ProjectPayloadReference } from './types.ts'

interface Staged { readonly ref: ProjectPayloadReference; readonly bytes: Buffer }
/** Same carrier ownership as its journal. Pending objects are one-shot, byte-accounted responsibilities. */
export class ProjectPayloadStore {
  private readonly pending = new Map<string, Staged>()
  private readonly published = new Map<string, ProjectPayloadReference>()
  private readonly publishing = new Map<string, Set<Promise<void>>>()
  private readonly readers = new Map<string, Map<string, number>>()
  private readonly reclaiming = new Map<string, Promise<void>>()
  private pendingBytes = 0
  constructor(private readonly maximumPendingBytes: number) {}
  stage(owner: ProjectPayloadOwner, input: { codec: string; value: unknown; capture?: (value: unknown) => void; inheritedFrom?: Omit<NonNullable<ProjectPayloadReference['inheritedFrom']>, 'payloadDigest'> & { payloadDigest?: string } }): ProjectPayloadReference {
    if (typeof input.codec !== 'string' || !/^[a-z][a-z0-9/-]*\/v[1-9][0-9]*$/.test(input.codec)) throw new TypeError('invalid Projects payload codec')
    const captured = snapshotJsonValue(input.value)
    if (captured === undefined) throw new TypeError('Projects payload is not lossless JSON')
    deepFreeze(captured)
    const bytes = Buffer.from(JSON.stringify(captured))
    // One idle payload may exceed the backlog budget: it is the current required
    // request/raw value, not an extra product size limit. While it is outstanding,
    // any further producer must wait at its async boundary or fail before append.
    if (this.pendingBytes > 0 && bytes.length > this.maximumPendingBytes - this.pendingBytes) throw new Error('Projects payload recording queue byte capacity is exhausted')
    const digest = rowDigest(bytes)
    const ref = deepFreeze({ kind: 'projects-payload' as const, version: 1 as const, codec: input.codec, id: randomUUID(), digest, bytes: bytes.length, owner: { ...owner },
      ...(input.inheritedFrom === undefined ? {} : { inheritedFrom: { ...input.inheritedFrom, payloadDigest: input.inheritedFrom.payloadDigest ?? digest } }) })
    input.capture?.(captured)
    this.pending.set(ref.id, { ref, bytes })
    this.pendingBytes += bytes.length
    return ref
  }
  assertOwner(ref: ProjectPayloadReference, owner: ProjectPayloadOwner): void {
    if (ref.kind !== 'projects-payload' || ref.version !== 1 || !/^[0-9a-f-]{36}$/.test(ref.id) || !/^sha256:[0-9a-f]{64}$/.test(ref.digest)
      || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || typeof ref.codec !== 'string'
      || ref.owner?.carrierId !== owner.carrierId || ref.owner.createdAt !== owner.createdAt
      || ref.owner.projectId !== owner.projectId || ref.owner.logicalSessionId !== owner.logicalSessionId) throw new Error('PROJECT_PAYLOAD_OWNER_OR_REFERENCE_MISMATCH')
  }
  publish(directory: string, ref: ProjectPayloadReference, owner: ProjectPayloadOwner): Promise<void> {
    const operation = this.publishOwned(directory, ref, owner)
    let jobs = this.publishing.get(owner.carrierId)
    if (jobs === undefined) { jobs = new Set(); this.publishing.set(owner.carrierId, jobs) }
    jobs.add(operation)
    const done = () => { jobs!.delete(operation); if (!jobs!.size) this.publishing.delete(owner.carrierId) }
    void operation.then(done, done)
    return operation
  }
  private async publishOwned(directory: string, ref: ProjectPayloadReference, owner: ProjectPayloadOwner): Promise<void> {
    this.assertOwner(ref, owner)
    const published = this.published.get(ref.id)
    if (published !== undefined && JSON.stringify(published) === JSON.stringify(ref)) return
    const staged = this.pending.get(ref.id)
    if (staged !== undefined && JSON.stringify(staged.ref) !== JSON.stringify(ref)) throw new Error('PROJECT_PAYLOAD_REFERENCE_CHANGED')
    const target = join(directory, 'payloads', `${ref.id}.json`)
    if (staged === undefined) {
      await this.read(directory, ref, owner)
      // A visible orphan or a previously imported object is not a prior durability receipt.
      const file = await open(target, 'r+')
      try { await file.sync() } finally { await file.close() }
      await syncDirectory(join(directory, 'payloads'))
      this.published.set(ref.id, ref)
      return
    }
    const payloadDirectory = join(directory, 'payloads')
    const temporary = join(payloadDirectory, `.stage-${randomUUID()}`)
    try {
      await durableMkdir(payloadDirectory)
      const file = await open(temporary, 'wx', 0o600)
      try { await writeAll(file, staged.bytes); await file.sync() } finally { await file.close() }
      try { await link(temporary, target) }
      catch (error) { if (!hasCode(error, 'EEXIST')) throw error; await this.read(directory, ref, owner) }
      await unlink(temporary)
      await syncDirectory(payloadDirectory)
      this.published.set(ref.id, ref)
    } finally {
      await unlink(temporary).catch(error => { if (!hasCode(error, 'ENOENT')) throw error })
      this.pending.delete(ref.id)
      this.pendingBytes -= staged.bytes.length
    }
  }
  async read(directory: string, ref: ProjectPayloadReference, owner: ProjectPayloadOwner, signal?: AbortSignal): Promise<unknown> {
    this.assertOwner(ref, owner)
    signal?.throwIfAborted()
    for (let gate = this.reclaiming.get(owner.carrierId); gate !== undefined; gate = this.reclaiming.get(owner.carrierId)) await gate
    let readers = this.readers.get(owner.carrierId)
    if (readers === undefined) { readers = new Map(); this.readers.set(owner.carrierId, readers) }
    readers.set(ref.id, (readers.get(ref.id) ?? 0) + 1)
    const release = () => { const count = readers!.get(ref.id)! - 1; if (count > 0) readers!.set(ref.id, count); else readers!.delete(ref.id); if (!readers!.size) this.readers.delete(owner.carrierId) }
    let file: Awaited<ReturnType<typeof open>>
    try { file = await open(join(directory, 'payloads', `${ref.id}.json`), 'r') } catch (error) { release(); throw error }
    try {
      const before = await file.stat({ bigint: true })
      if (!before.isFile() || before.size !== BigInt(ref.bytes)) throw new Error('PROJECT_PAYLOAD_CONTENT_MISMATCH')
      const raw = Buffer.allocUnsafe(ref.bytes)
      let offset = 0
      while (offset < raw.length) {
        signal?.throwIfAborted()
        const { bytesRead } = await file.read(raw, offset, raw.length - offset, offset)
        if (!bytesRead) throw new Error('PROJECT_PAYLOAD_CONTENT_MISMATCH')
        offset += bytesRead
      }
      const after = await file.stat({ bigint: true })
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || rowDigest(raw) !== ref.digest) throw new Error('PROJECT_PAYLOAD_CONTENT_MISMATCH')
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
    } finally { try { await file.close() } finally { release() } }
  }
  acknowledged(ref: ProjectPayloadReference): void { this.published.delete(ref.id) }
  abandon(ref: ProjectPayloadReference): void { this.published.delete(ref.id) }
  async drain(id: string): Promise<void> { while (this.publishing.get(id)?.size) await Promise.allSettled([...this.publishing.get(id)!]) }
  /** Only the owning, drained writer may call this at recovery or close, never at append/read. */
  async reclaim(directory: string, id: string, referenced: ReadonlySet<string>, assertOwned: () => Promise<void>): Promise<number> {
    await this.drain(id)
    const gate = Promise.withResolvers<void>()
    this.reclaiming.set(id, gate.promise)
    let removed = 0
    try {
      await assertOwned()
      let entries: Awaited<ReturnType<typeof opendir>>
      try { entries = await opendir(join(directory, 'payloads')) } catch (error) { if (hasCode(error, 'ENOENT')) return 0; throw error }
      for await (const entry of entries) {
        if (!entry.isFile()) continue
        const payload = /^([0-9a-f-]{36})\.json$/.exec(entry.name)
        const temporary = /^\.stage-[0-9a-f-]{36}$/.test(entry.name)
        if (payload === null && !temporary) continue
        const key = payload?.[1]
        if (key !== undefined && (referenced.has(key) || this.pending.get(key)?.ref.owner.carrierId === id
          || this.published.get(key)?.owner.carrierId === id || this.readers.get(id)?.has(key))) continue
        await assertOwned()
        try { await unlink(join(directory, 'payloads', entry.name)); removed++ } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
      }
      if (removed > 0) await syncDirectory(join(directory, 'payloads'))
      return removed
    } finally { if (this.reclaiming.get(id) === gate.promise) this.reclaiming.delete(id); gate.resolve() }
  }
  discard(id: string): void {
    for (const [key, staged] of this.pending) if (staged.ref.owner.carrierId === id) { this.pending.delete(key); this.pendingBytes -= staged.bytes.length }
    for (const [key, ref] of this.published) if (ref.owner.carrierId === id) this.published.delete(key)
  }
}
