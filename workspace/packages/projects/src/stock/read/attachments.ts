/** One native attachment backend per physical Projects carrier. */
import { Context } from '@deepseek-ai/cordis'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { FileAttachmentRef, ImageAttachmentRef, ImageRequestTarget, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import LocalAttachmentStore, { commitPreparedImageFile } from '@deepseek-ai/dsh-attachment-local'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectSessionPersistence } from '../persistence/index.ts'
import { pathSegment } from '../persistence/codec.ts'

export type ExactAttachment =
  | { readonly kind: 'image'; readonly ref: ImageAttachmentRef; readonly data: Uint8Array }
  | { readonly kind: 'file'; readonly ref: FileAttachmentRef; readonly data: Uint8Array | AsyncIterable<Uint8Array> }

/** The UI, communication and history import all share this owner in the private graph. */
export class CarrierAttachmentOwner {
  private readonly contexts = new Map<SessionId, Context>()
  private readonly backends = new Map<SessionId, Promise<LocalAttachmentStore>>()
  private readonly pending = new Map<SessionId, Set<Promise<unknown>>>()
  private readonly unavailable = new Set<SessionId>()
  private closing?: Promise<void>

  constructor(private readonly persistence: ProjectSessionPersistence) {}

  async home(id: SessionId): Promise<string> {
    const owner = await this.persistence.resolveOwner(id)
    if (owner === undefined) throw new Error(`PROJECT_SOURCE_NOT_FOUND: ${id}`)
    return join(this.persistence.dataRoot, 'projects', pathSegment(owner.projectId), 'sessions', pathSegment(id), 'attachment-home')
  }

  forCarrier(id: SessionId): Promise<LocalAttachmentStore> {
    this.assertOpen(id)
    let backend = this.backends.get(id)
    if (backend === undefined) {
      backend = this.track(id, async () => {
        const home = await this.home(id)
        // A distinct Context gives each native provider its own service slot,
        // event domain, compression queue and request-image cache.
        const ctx = new Context()
        this.contexts.set(id, ctx)
        try {
          await ctx.plugin(LocalAttachmentStore, { dshHome: home })
          return ctx.attachments as LocalAttachmentStore
        } catch (error) { this.contexts.delete(id); await ctx.fiber.dispose(); throw error }
      })
      this.backends.set(id, backend)
      void backend.catch(() => { if (this.backends.get(id) === backend) this.backends.delete(id) })
    }
    return backend
  }

  /** Admission and tracking are synchronous; cancellation of a waiter never drops the task. */
  track<T>(id: SessionId, action: (() => Promise<T>) | Promise<T>): Promise<T> {
    this.assertOpen(id)
    let tasks = this.pending.get(id)
    if (tasks === undefined) { tasks = new Set(); this.pending.set(id, tasks) }
    const operation = typeof action === 'function' ? Promise.resolve().then(action) : action
    tasks.add(operation)
    const done = () => { tasks!.delete(operation); if (tasks!.size === 0) this.pending.delete(id) }
    void operation.then(done, done)
    return operation
  }

  /** Own the complete transfer; no native stream escapes either carrier's drain. */
  copyExact(source: SessionId, target: SessionId, request: { readonly kind: 'image'; readonly ref: ImageAttachmentRef } | { readonly kind: 'file'; readonly ref: FileAttachmentRef }, signal?: AbortSignal, beforeSave?: () => void | Promise<void>): Promise<ImageAttachmentRef | FileAttachmentRef> {
    signal?.throwIfAborted()
    this.assertOpen(source)
    this.assertOpen(target)
    const ref = structuredClone(request.ref)
    // Both admissions happen synchronously before I/O starts. A target drain
    // must not finish while a source read is still preparing its target write.
    const operation = Promise.resolve().then(async () => {
      const backend = await this.forCarrier(source)
      signal?.throwIfAborted()
      if (request.kind === 'image') {
        const imageRef = ref as ImageAttachmentRef
        const saved = await backend.readImage(imageRef, signal)
        await beforeSave?.()
        signal?.throwIfAborted()
        if (source !== target) await this.importExact(target, { kind: 'image', ref: imageRef, data: saved.data }, signal)
      } else {
        const fileRef = ref as FileAttachmentRef
        const nativeData = backend.readFileStream(fileRef, signal)
        let validationFailure: { error: unknown } | undefined
        const data = (async function* () {
          yield* nativeData
          // Native saving cannot publish its staging file until this iterator
          // finishes. Recheck after source integrity, before target publication.
          try { await beforeSave?.(); signal?.throwIfAborted() }
          catch (error) { validationFailure = { error }; throw error }
        })()
        try {
          if (source === target) {
            // Same-carrier calls still prove the complete native byte count and
            // digest; they never turn into an unchecked no-op.
            for await (const _chunk of data) { signal?.throwIfAborted() }
          } else await this.importExact(target, { kind: 'file', ref: fileRef, data }, signal)
        } catch (error) {
          // The native stage wraps producer errors as write failures. Preserve
          // the original authorization/guard failure after its cleanup settles;
          // an independent cleanup failure must still retain its own error.
          if (validationFailure !== undefined && (error === validationFailure.error || error instanceof Error && error.cause === validationFailure.error)) throw validationFailure.error
          throw error
        }
      }
      signal?.throwIfAborted()
      return ref
    })
    this.track(source, operation)
    if (source !== target) this.track(target, operation)
    return operation
  }

  async importExact(id: SessionId, input: ExactAttachment, signal?: AbortSignal): Promise<ImageAttachmentRef | FileAttachmentRef> {
    signal?.throwIfAborted()
    const ref = structuredClone(input.ref)
    const bytes = input.data instanceof Uint8Array ? new Uint8Array(input.data) : input.data
    return this.track(id, async () => {
      const backend = await this.forCarrier(id)
      signal?.throwIfAborted()
      if (input.kind === 'image') {
        // The public primitive accepts already normalized bytes. Never run
        // saveImage here: doing so would normalize and change saved identity.
        const imageRef = ref as ImageAttachmentRef
        await commitPreparedImageFile(backend.root, { ref: imageRef, data: bytes as Uint8Array })
        await backend.readImage(imageRef, signal)
        return imageRef
      }
      const data = bytes instanceof Uint8Array ? (async function* () { yield bytes })() : bytes
      const saved = await backend.saveFileStream({ data, name: ref.name, ...(signal === undefined ? {} : { signal }) })
      if (saved.attachmentId !== ref.attachmentId || saved.bytes !== ref.bytes || saved.name !== ref.name) {
        throw new AttachmentError('Exact file copy does not match its saved reference.', 'ATTACHMENT_CORRUPT')
      }
      signal?.throwIfAborted()
      return ref
    })
  }

  /** Native SharedRequest.wait(signal) can return before its compression task.
   * Keep a non-cancelled native waiter as the real completion responsibility,
   * while the caller may stop waiting independently. */
  readImageRequest(id: SessionId, ref: ImageAttachmentRef, target: ImageRequestTarget, signal?: AbortSignal): Promise<RequestImageAttachment> {
    signal?.throwIfAborted()
    const actual = this.track(id, async () => (await this.forCarrier(id)).readImageRequest(ref, target))
    if (signal === undefined) return actual
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      void actual.then(value => { signal.removeEventListener('abort', abort); if (!signal.aborted) resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
    })
  }

  /** Cuts new work first, then waits every actually accepted native operation. */
  async drainForCarrier(id: SessionId): Promise<void> {
    while (this.pending.get(id)?.size) await Promise.allSettled([...this.pending.get(id)!])
  }

  async removeCarrier(id: SessionId): Promise<{ readonly status: 'removed'; readonly path: string }> {
    const home = await this.home(id)
    this.unavailable.add(id)
    await this.drainForCarrier(id)
    await this.contexts.get(id)?.fiber.dispose()
    this.contexts.delete(id)
    this.backends.delete(id)
    await rm(home, { recursive: true, force: true })
    return { status: 'removed', path: home }
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      while (this.pending.size) await Promise.allSettled([...this.pending.values()].flatMap(tasks => [...tasks]))
      const settled = await Promise.allSettled([...this.contexts.values()].map(ctx => ctx.fiber.dispose()))
      const errors = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      this.contexts.clear(); this.backends.clear()
      if (errors.length) throw new AggregateError(errors, 'Projects attachment close failed')
    })()
  }

  private assertOpen(id: SessionId): void {
    if (this.closing !== undefined || this.unavailable.has(id)) throw new Error(`PROJECT_ATTACHMENTS_UNAVAILABLE: ${id}`)
  }
}
