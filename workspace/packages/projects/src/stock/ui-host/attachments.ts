/** Native attachment bytes remain inside their exact Projects carrier. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { Context } from '@deepseek-ai/cordis'
import AttachmentStore, { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type {
  FileAttachmentRef, ImageAttachmentRef, ImageRequestTarget, SaveFileAttachment,
  SaveFileStreamAttachment, SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import {
  DEFAULT_MAX_IMAGE_BYTES, DEFAULT_MAX_IMAGE_DIMENSION, DEFAULT_MAX_IMAGE_PIXELS,
  DEFAULT_MAX_IMAGES_PER_MESSAGE, DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
} from '@deepseek-ai/dsh-attachment-local'
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '../read/index.ts'

/**
 * The controller has no Agent scope while admitting prompt bytes. Its explicit
 * target is carried through async admission; Agent/tool callers use their real
 * public scope chain. Missing ownership fails, rather than using a global store.
 */
export class PrivateSessionAttachments extends AttachmentStore {
  private readonly target = new AsyncLocalStorage<SessionId>()
  private readonly owners = new WeakMap<object, SessionId>()
  private readonly backends = new Map<SessionId, LocalAttachmentStore>()
  readonly imageLimits = Object.freeze({
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
    maxImageDimension: DEFAULT_MAX_IMAGE_DIMENSION,
    maxImagePixels: DEFAULT_MAX_IMAGE_PIXELS,
    maxImagesPerMessage: DEFAULT_MAX_IMAGES_PER_MESSAGE,
    maxMessageImageBytes: DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
    mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const),
  })

  constructor(private readonly ownerCtx: Context) {
    super(ownerCtx)
    // Native preset tools close over their standing composition Context, not
    // the calling Agent's Context. An execution started by another Agent can
    // otherwise inherit that initiator's admission target for its whole turn.
    ownerCtx.on('tools/execute', (exec, next) => exec.agent === undefined
      ? next() : this.runFor(exec.agent.id, next))
    ownerCtx.on('llm/stream', (options, next) => {
      if (options.sessionId === undefined) return next()
      const id = options.sessionId as SessionId, self = this
      // Adapters are shared and lazy. Bind both creation and every iterator
      // operation, so request-image preparation uses this request's carrier.
      return { [Symbol.asyncIterator]() {
        const iterator = self.runFor(id, () => next()[Symbol.asyncIterator]())
        return {
          next: (...args: Parameters<typeof iterator.next>) => self.runFor(id, () => iterator.next(...args)),
          ...iterator.return === undefined ? {} : { return: (...args: Parameters<NonNullable<typeof iterator.return>>) => self.runFor(id, () => iterator.return!(...args)) },
          ...iterator.throw === undefined ? {} : { throw: (...args: Parameters<NonNullable<typeof iterator.throw>>) => self.runFor(id, () => iterator.throw!(...args)) },
        }
      } }
    })
  }

  runFor<T>(id: SessionId, action: () => T): T { return this.target.run(id, action) }

  /** Await in factory setup, before the Agent is published or accepts work. */
  async bindAgent(ctx: Context, id: SessionId): Promise<void> {
    const scope = scopeOf(ctx)
    if (scope === undefined) throw new Error('Projects attachment binding requires the real Agent scope')
    await this.open(id)
    this.owners.set(scope, id)
  }

  private currentId(): SessionId {
    // Admission starts background work which may carry this async-local target
    // into a different Agent. Its real bound scope remains the attachment owner.
    for (const key of scopeChainOf(scopeOf(this.ctx))) {
      const bound = this.owners.get(key)
      if (bound !== undefined) return bound
    }
    const explicit = this.target.getStore()
    if (explicit !== undefined) return explicit
    throw new AttachmentError('Projects attachment operation has no carrier owner.', 'INVALID_ATTACHMENT_REF')
  }

  private async open(id: SessionId): Promise<LocalAttachmentStore> {
    const backend = await this.ownerCtx.projectsRead.attachments.forCarrier(id)
    this.backends.set(id, backend)
    return backend
  }

  private operation<T>(action: (backend: LocalAttachmentStore) => Promise<T>): Promise<T> {
    const id = this.currentId()
    return this.ownerCtx.projectsRead.attachments.track(id, async () => action(await this.open(id)))
  }

  private attached(): LocalAttachmentStore {
    const backend = this.backends.get(this.currentId())
    if (backend === undefined) throw new Error('Projects attachment backend must be bound before requesting its host path')
    return backend
  }

  async validateImage(input: SaveImageAttachment) { return this.operation(backend => backend.validateImage(input)) }
  async saveImage(input: SaveImageAttachment) { return this.operation(backend => backend.saveImage(input)) }
  override async saveImages(inputs: readonly SaveImageAttachment[]) { return this.operation(backend => backend.saveImages(inputs)) }
  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal) { return this.operation(backend => backend.readImage(ref, signal)) }
  override imageHostPath(ref: ImageAttachmentRef) { return this.attached().imageHostPath(ref) }
  override async saveFile(input: SaveFileAttachment) { return this.operation(backend => backend.saveFile(input)) }
  override async saveFileStream(input: SaveFileStreamAttachment) { return this.operation(backend => backend.saveFileStream(input)) }
  override async *readFileStream(ref: FileAttachmentRef, signal?: AbortSignal) {
    const id = this.currentId()
    const done = Promise.withResolvers<void>()
    const held = this.ownerCtx.projectsRead.attachments.track(id, () => done.promise)
    try { yield* (await this.open(id)).readFileStream(ref, signal) }
    finally { done.resolve(); await held }
  }
  override fileHostPath(ref: FileAttachmentRef) { return this.attached().fileHostPath(ref) }
  override async readImageRequest(ref: ImageAttachmentRef, target: ImageRequestTarget, signal?: AbortSignal) {
    return this.ownerCtx.projectsRead.attachments.readImageRequest(this.currentId(), ref, target, signal)
  }
}
