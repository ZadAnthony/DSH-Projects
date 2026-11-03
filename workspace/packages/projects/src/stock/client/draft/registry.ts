/** Logical draft ownership over stock native shells and public Session faces. */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionBinding, SessionFace, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InboxState } from '@deepseek-ai/dsh-agent/types'
import type { ConversationController, SessionInputResolver, SessionInput, InputActions, DraftInitializationOptions, DraftInitializationResult } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ModelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PlanProjection } from '@deepseek-ai/dsh-plan-mode/types'
import { SessionInputShell, type CapturedInputScope } from '../compat/input/client/input/facade.ts'
import type { InputTriggerController, DraftAttachmentId, CommandClaim } from '../compat/input/client/contract/input.ts'
import { reportMessageSubmission } from '../compat/input/client/input/submission-analytics.ts'
import { freezeCarrier, logicalDraftKey, sameCarrier, type CarrierAddress, type CarrierLease, type ProjectDraftPorts, type UploadArguments } from './types.ts'

export type { CarrierAddress, CarrierLease, ProjectDraftPorts } from './types.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { projectDraftAttempt: unknown }
}

/** One logical conversation owns this original Lexical runtime for its full browser lifetime. */
export class ProjectDraftOwner {
  readonly shell: SessionInputShell
  readonly inbox = createSnapshotStore<InboxState | undefined>(undefined)
  private target: { readonly address: CarrierAddress; readonly binding: SessionBinding } | undefined
  private unsubscribeInbox: (() => void) | undefined
  private readonly leases = new Set<{ controller: AbortController; release(): void }>()
  private ended = false

  constructor(readonly key: string, private readonly registry: ProjectDraftRegistry, first: SessionBinding, address: CarrierAddress) {
    this.target = { address, binding: first }
    this.shell = new SessionInputShell({
      actx: first.ctx,
      captureScope: () => this.captureScope(),
      guardClaim: claim => { const target = this.current(); return this.protectClaim(claim, target.address, target.binding.ctx) },
      submissionState: () => {
        const { session } = this.current().binding
        const state = session.getSnapshot()
        const model = session.projections.faceOf('modelSelection').getSnapshot() as ModelSelectionProjection | undefined
        const plan = session.projections.faceOf('plan').getSnapshot() as PlanProjection | undefined
        const selection = model?.next ?? model?.lastUsed
        return Object.freeze({
          ...state.blank ? {} : { sessionId: state.sessionId },
          ...selection == null ? {} : { model: Object.freeze({ provider: selection.provider, name: selection.model,
            ...selection.reasoningEffort === undefined ? {} : { effort: selection.reasoningEffort } }) },
          runMode: plan?.active ? 'plan' as const : 'default' as const,
          running: state.running,
        })
      },
      messageSubmitted: submission => reportMessageSubmission(this.registry.ctx, submission),
      inputTriggers: () => this.ended ? undefined : this.registry.triggers(this.current().binding.ctx),
      popup: () => this.ended ? undefined : this.registry.popup(this.current().binding.ctx),
      inbox: this.inbox,
      // All actual submissions use captureScope. This fallback fails closed.
      defaultSink: async () => ({ kind: 'error', text: 'PROJECT_INPUT_UNCAPTURED: missing carrier lease' }),
      steerQueue: () => { void this.steerQueue() },
      commandAttachments: this.commandAttachments(),
    })
    this.bind(first, address)
  }

  get address(): CarrierAddress { return this.current().address }
  get disposed(): boolean { return this.ended }

  /** Carrier replacement only changes receiver/read bindings, never the editor or draft. */
  bind(binding: SessionBinding, address: CarrierAddress): void {
    if (this.ended) throw new Error('PROJECT_DRAFT_DELETED: this logical draft has ended')
    if (logicalDraftKey(address) !== this.key || binding.sessionId !== address.hostSessionId) {
      throw new Error('PROJECT_DRAFT_CARRIER_MISMATCH: logical and physical bindings disagree')
    }
    if (this.target?.binding === binding && sameCarrier(this.target.address, address) && this.unsubscribeInbox !== undefined) return
    this.unsubscribeInbox?.()
    this.target = { binding, address }
    const inbox = binding.session.projections.faceOf('inbox')
    const refresh = () => this.inbox.set(inbox.getSnapshot() as InboxState | undefined)
    this.unsubscribeInbox = inbox.subscribe(refresh)
    refresh()
    queueMicrotask(() => {
      if (!this.ended && this.target?.binding === binding) this.shell.refreshInputBinding()
    })
  }

  /** Exact address and Session scope retained until this operation settles. */
  capture(): CarrierLease {
    const { address, binding } = this.current()
    const controller = new AbortController()
    let reference: SessionReference | undefined
    let captureError: unknown
    try {
      this.assertCurrent(address, binding)
      reference = this.registry.sessions.retain(binding.sessionId, { source: 'projectDraftAttempt' })
      if (reference.binding !== binding) throw new Error('PROJECT_INPUT_STALE: Session generation changed')
    } catch (error) { captureError = error; reference?.release(); reference = undefined }
    let released = false
    const operation = { controller, release: () => {
      if (released) return
      released = true
      reference?.release()
      this.leases.delete(operation)
    } }
    this.leases.add(operation)
    return Object.freeze({ address, ctx: binding.ctx, signal: controller.signal,
      assertCurrent: () => {
        if (captureError !== undefined) throw captureError
        if (released || controller.signal.aborted) throw new Error('PROJECT_INPUT_INVALIDATED: captured operation has ended')
        this.assertCurrent(address, binding)
      },
      release: operation.release,
    })
  }

  private assertCurrent(address: CarrierAddress, binding: SessionBinding): void {
    if (this.ended) throw new Error('PROJECT_DRAFT_DELETED: draft was permanently invalidated')
    if (this.registry.sessions.binding(binding.sessionId) !== binding || !this.registry.ports.isCurrent(address)) {
      throw new Error('PROJECT_INPUT_STALE: captured carrier is no longer current; input was not resent')
    }
  }

  private current(): { readonly address: CarrierAddress; readonly binding: SessionBinding } {
    if (this.target === undefined || this.ended) throw new Error('PROJECT_DRAFT_DELETED: logical draft is unavailable')
    return this.target
  }

  private commandAttachments(): CapturedInputScope['commandAttachments'] {
    return {
      serialize: async ids => (await this.registry.conversation().serializeDraftAttachments(ids)).attachments,
      release: ids => { for (const id of ids) this.registry.maybeConversation()?.releaseDraftAttachment(id) },
      unsupportedNotice: token => this.registry.t('command.attachmentsUnsupported', { command: token.trim().replace(/^\//u, '') }),
    }
  }

  private protectClaim(claim: CommandClaim, address: CarrierAddress, actx: Context): CommandClaim {
    return { ...claim, submit: async (args, _currentCtx, attachments) => {
      if (this.ended || !this.registry.ports.isCurrent(address)) {
        throw new Error('PROJECT_INPUT_STALE: command claim belongs to the previous carrier; input was not resent')
      }
      return claim.submit(args, actx, attachments)
    } }
  }

  private captureScope(): CapturedInputScope {
    const lease = this.capture()
    const binding = this.registry.sessions.binding(lease.address.hostSessionId as SessionId)
    const trigger = this.registry.triggers(lease.ctx)
    const commandAttachments = this.commandAttachments()
    return {
      actx: lease.ctx, inputTriggers: trigger, assertCurrent: lease.assertCurrent, release: lease.release,
      signal: lease.signal, commandAttachments,
      guardClaim: claim => this.protectClaim(claim, lease.address, lease.ctx),
      defaultSink: async (text, ids, mode, signal) => {
        lease.assertCurrent()
        if (binding === undefined) throw new Error('PROJECT_INPUT_STALE: captured binding is unavailable')
        const guarded = guardedSession(binding.session, lease)
        return this.registry.conversation().sendSession(guarded, text, ids, mode, AbortSignal.any([signal, lease.signal]))
      },
    }
  }

  private async steerQueue(): Promise<void> {
    const lease = this.capture()
    try {
      lease.assertCurrent()
      const binding = this.registry.sessions.binding(lease.address.hostSessionId as SessionId)
      if (binding === undefined) throw new Error('PROJECT_INPUT_STALE: captured binding is unavailable')
      const inbox = binding.session.projections.faceOf('inbox').getSnapshot() as InboxState | undefined
      for (const item of inbox?.['next-turn'] ?? []) {
        lease.assertCurrent()
        const result = await binding.session.updateQueue(item.id, { kind: 'steer' })
        if (result.ok) continue
        if (result.error.code === 'session/steer-unavailable' || result.error.code === 'session/queue-item-not-found') return
        throw new Error(this.registry.t('queue.steerFailed'))
      }
    } catch (error) {
      if (!this.ended) this.shell.notify('error', error instanceof Error ? error.message : String(error))
    } finally { lease.release() }
  }

  /** Invalidate before deleting records: abort attempts before any late result can restore text. */
  dispose(): void {
    if (this.ended) return
    this.ended = true
    for (const lease of [...this.leases]) { lease.controller.abort(); lease.release() }
    this.unsubscribeInbox?.()
    this.unsubscribeInbox = undefined
    const attachments = this.shell.dispose()
    for (const id of attachments) this.registry.maybeConversation()?.releaseDraftAttachment(id)
    this.target = undefined
  }
}

/** Public-face adapter: validates at the actual prompt call after native serialization/paint awaits. */
function guardedSession(session: SessionFace, lease: CarrierLease): SessionFace {
  const pending = new Map<string, ReturnType<SessionFace['beginSubmission']>>()
  return {
    sessionId: session.sessionId, projections: session.projections,
    getSnapshot: () => session.getSnapshot(), subscribe: listener => session.subscribe(listener),
    beginSubmission: input => { lease.assertCurrent(); const handle = session.beginSubmission(input); pending.set(handle.requestId, handle); return handle },
    prompt: async (content, mode, signal, requestId) => {
      try { lease.assertCurrent() } catch (error) { if (requestId !== undefined) pending.get(requestId)?.abandon(); throw error }
      let result: Awaited<ReturnType<SessionFace['prompt']>>
      try { result = await session.prompt(content, mode, signal, requestId) }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`PROJECT_INPUT_ADMISSION_UNKNOWN: acceptance by captured carrier ${lease.address.hostSessionId} could not be confirmed: ${message}. Input was not automatically resent.`, { cause: error })
      }
      if (!result.ok) throw new Error(`PROJECT_INPUT_REJECTED: ${result.error.message} (${result.error.code})`)
      return result
    },
    readAttachment: id => session.readAttachment(id),
    updateQueue: async (id, action) => { lease.assertCurrent(); return session.updateQueue(id, action) },
    cancel: async () => { lease.assertCurrent(); return session.cancel() },
    rename: async title => { lease.assertCurrent(); return session.rename(title) },
    loadOlder: () => session.loadOlder(), loadThrough: seq => session.loadThrough(seq),
    command: async line => { lease.assertCurrent(); return session.command(line) },
  }
}

interface PreparedUpload {
  readonly file: File
  readonly lease: CarrierLease
  attachmentId?: DraftAttachmentId
  started: boolean
}

/** Logical SessionInputResolver used by both public ConversationController and the composer. */
export class ProjectDraftRegistry implements SessionInputResolver {
  private readonly owners = new Map<string, ProjectDraftOwner>()
  private readonly deleted = new Set<string>()
  private readonly bindingOwners = new WeakMap<SessionBinding, ProjectDraftOwner>()
  private readonly inputFaces = new WeakMap<SessionBinding, SessionInput>()
  private readonly actionFaces = new WeakMap<SessionBinding, InputActions>()
  private readonly boundAddresses = new WeakMap<SessionBinding, CarrierAddress>()
  private readonly uploads = new WeakMap<object, PreparedUpload[]>()
  private readonly queuedUploads = new Map<DraftAttachmentId, PreparedUpload>()
  private readonly uploadLeases = new Set<CarrierLease>()
  private stopUploadObservation: (() => void) | undefined
  private ended = false

  constructor(readonly ctx: Context, readonly t: TranslateNS<'conversation'>, readonly ports: ProjectDraftPorts) {
    ctx.effect(() => () => this.dispose(), 'Projects logical draft owners')
  }

  get sessions(): ISessions { return this.ctx.sessions }
  maybeConversation(): ConversationController | undefined { return this.ctx.get('conversation') as ConversationController | undefined }
  conversation(): ConversationController {
    const conversation = this.maybeConversation()
    if (conversation === undefined) throw new Error('PROJECT_INPUT_UNAVAILABLE: conversation service unavailable')
    return conversation
  }
  ownerFor(address: Pick<CarrierAddress, 'projectId' | 'logicalSessionId'>): ProjectDraftOwner | undefined {
    return this.owners.get(logicalDraftKey(address))
  }
  /** Called by logical-panel selection before rendering the new physical binding. */
  bind(address: CarrierAddress): ProjectDraftOwner | undefined {
    const frozen = freezeCarrier(address)
    const binding = this.sessions.binding(frozen.hostSessionId as SessionId)
    if (binding === undefined) return this.ownerFor(frozen)
    this.resolveOwner(binding, frozen)
    return this.ownerFor(frozen)
  }
  for(actx: Context): SessionInput {
    const session = this.sessions.sessionOf(actx)
    const binding = session === undefined ? undefined : this.sessions.binding(session.sessionId)
    if (binding === undefined || binding.session !== session) throw new Error('PROJECT_INPUT_SCOPE: retained physical Session scope required')
    const owner = this.resolveOwner(binding)
    const existing = this.inputFaces.get(binding)
    if (existing !== undefined) return existing
    const shell = owner.shell
    const address = this.boundAddresses.get(binding)!
    const available = () => {
      if (!owner.disposed && sameCarrier(owner.address, address) && this.ports.isCurrent(address)) return true
      if (!owner.disposed) shell.notify('error', 'PROJECT_INPUT_STALE: captured Session scope cannot edit or submit to the replacement carrier')
      return false
    }
    // A public caller can retain this face across an await. Its mutation verbs
    // stay bound to the captured physical scope, even though the logical shell survives.
    const face: SessionInput = {
      state: shell.state,
      beginCommand: (claim, span) => available() && shell.beginCommand(claim, span),
      insertReference: (reference, span) => available() && shell.insertReference(reference, span),
      setDraft: text => { if (available()) shell.setDraft(text) },
      addAttachments: ids => available() && shell.addAttachments(ids),
      removeAttachment: id => available() && shell.removeAttachment(id),
      pruneAttachments: ids => { if (available()) shell.pruneAttachments(ids) },
      submit: (mode, source) => { if (available()) shell.submit(mode, source) },
      notify: (level, text) => { if (!owner.disposed) shell.notify(level, text) },
      focus: () => { if (available()) shell.focus() },
    }
    this.inputFaces.set(binding, face)
    return face
  }

  /** New native callers must initialize the exact retained physical generation. */
  requestDraftInitialization(binding: SessionBinding, options: DraftInitializationOptions): DraftInitializationResult {
    if (this.sessions.binding(binding.sessionId) !== binding) throw new Error('PROJECT_INPUT_SCOPE: retained physical Session binding required')
    const owner = this.resolveOwner(binding)
    const address = this.boundAddresses.get(binding)!
    if (this.ended || owner.disposed || !sameCarrier(owner.address, address) || !this.ports.isCurrent(address)) return 'blocked'
    return owner.shell.requestDraftInitialization(options)
  }

  /** Standard provide-channel actions retain their physical receiver across caller awaits. */
  actionsFor(binding: SessionBinding): InputActions {
    const owner = this.resolveOwner(binding)
    const existing = this.actionFaces.get(binding)
    if (existing !== undefined) return existing
    const shell = owner.shell
    const address = this.boundAddresses.get(binding)!
    const available = () => {
      if (!owner.disposed && sameCarrier(owner.address, address) && this.ports.isCurrent(address)) return true
      if (!owner.disposed) shell.notify('error', 'PROJECT_INPUT_STALE: old input actions cannot edit or submit to the replacement carrier')
      return false
    }
    const face: InputActions = {
      captureInsertion: () => available() ? shell.actions.captureInsertion() : { start: 0, end: 0, draftRev: -1 },
      insertText: (text, span) => available() && shell.actions.insertText(text, span),
      setDraft: text => { if (available()) shell.actions.setDraft(text) },
      persistDraft: () => { if (available()) shell.actions.persistDraft() },
      addAttachments: ids => available() && shell.actions.addAttachments(ids),
      removeAttachment: id => { if (available()) shell.actions.removeAttachment(id) },
      pruneAttachments: ids => { if (available()) shell.actions.pruneAttachments(ids) },
      submit: () => { if (available()) shell.actions.submit() },
    }
    this.actionFaces.set(binding, face)
    return face
  }

  shellFor(binding: SessionBinding): SessionInputShell { return this.resolveOwner(binding).shell }
  shell(id: SessionId): SessionInputShell {
    const binding = this.sessions.binding(id)
    if (binding === undefined) throw new Error(`PROJECT_INPUT_SCOPE: carrier ${id} has no binding`)
    return this.shellFor(binding)
  }
  keyboard(id: SessionId): SessionInputShell { return this.shell(id) }
  canPickFiles(id: SessionId): boolean {
    const binding = this.sessions.binding(id)
    return binding !== undefined && this.bindingOwners.get(binding)?.shell.canPickFiles() === true
  }
  pickFiles(id: SessionId): void {
    const binding = this.sessions.binding(id)
    if (binding !== undefined) this.bindingOwners.get(binding)?.shell.pickFiles()
  }
  inputTriggers(id: SessionId): InputTriggerController | undefined {
    const binding = this.sessions.binding(id)
    return binding === undefined ? undefined : this.triggers(binding.ctx)
  }
  triggers(actx: Context): InputTriggerController | undefined {
    return (this.ctx.get('inputTriggers') as { sessionOf(ctx: Context): InputTriggerController } | undefined)?.sessionOf(actx)
  }
  popup(actx: Context): { dismiss(): void } | undefined {
    return (this.ctx.get('commandUi') as { popupFor(ctx: Context): { dismiss(): void } } | undefined)?.popupFor(actx)
  }
  captureFor(actx: Context): CarrierLease {
    const session = this.sessions.sessionOf(actx)
    const binding = session === undefined ? undefined : this.sessions.binding(session.sessionId)
    if (binding === undefined || binding.session !== session) throw new Error('PROJECT_INPUT_SCOPE: retained physical Session scope required')
    const owner = this.resolveOwner(binding)
    // Explicit old scopes never silently acquire the replacement carrier.
    const address = this.boundAddresses.get(binding)!
    if (!sameCarrier(owner.address, address)) throw new Error('PROJECT_INPUT_STALE: old scope cannot target the new carrier')
    return owner.capture()
  }
  /** Composer closures from a previous carrier may remain reachable after a React commit. */
  assertBindingCurrent(id: SessionId): void {
    const binding = this.sessions.binding(id)
    if (binding === undefined) throw new Error('PROJECT_INPUT_STALE: physical Session scope has ended')
    const owner = this.resolveOwner(binding)
    const address = this.boundAddresses.get(binding)!
    if (owner.disposed || !sameCarrier(owner.address, address) || !this.ports.isCurrent(address)) {
      throw new Error('PROJECT_INPUT_STALE: captured composer cannot mutate the replacement carrier draft')
    }
  }

  /** Capture before native Workers start, then bind queued leases to their removable draft ids. */
  createDrafts(id: SessionId, files: readonly File[]): ReturnType<ConversationController['createDrafts']> {
    const prepared = this.prepareUploads(id, files)
    try {
      const drafts = this.conversation().createDrafts(id, files)
      let index = 0
      for (const draft of drafts) {
        if (draft.kind !== 'file') continue
        this.bindQueuedUpload(prepared[index++]!, draft.id)
      }
      this.releaseRemovedUploads()
      return drafts
    } catch (error) {
      for (const upload of prepared) if (!upload.started) this.releaseQueuedUpload(upload)
      throw error
    }
  }
  private prepareUploads(id: SessionId, files: readonly File[]): PreparedUpload[] {
    this.assertBindingCurrent(id)
    const binding = this.sessions.binding(id)
    if (binding === undefined) throw new Error('PROJECT_INPUT_SCOPE: upload carrier has no binding')
    const owner = this.resolveOwner(binding)
    if (this.stopUploadObservation === undefined) {
      const state = this.conversation().fileUploads
      this.stopUploadObservation = state.subscribe(() => this.releaseRemovedUploads(state.getSnapshot()))
    }
    const prepared: PreparedUpload[] = []
    try {
      for (const file of files) {
        if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) continue
        const lease = owner.capture()
        const upload: PreparedUpload = { file, lease, started: false }
        prepared.push(upload)
        lease.assertCurrent()
        const queued = this.uploads.get(file) ?? []
        queued.push(upload)
        this.uploads.set(file, queued)
        this.uploadLeases.add(lease)
      }
      return prepared
    } catch (error) {
      for (const upload of prepared) this.releaseQueuedUpload(upload)
      throw error
    }
  }
  private bindQueuedUpload(upload: PreparedUpload, attachmentId: DraftAttachmentId): void {
    if (upload.started) return
    upload.attachmentId = attachmentId
    this.queuedUploads.set(attachmentId, upload)
  }
  private releaseRemovedUploads(state: Readonly<Record<string, unknown>> = this.conversation().fileUploads.getSnapshot()): void {
    for (const [id, upload] of this.queuedUploads) if (!(id in state)) this.releaseQueuedUpload(upload)
  }
  private releaseQueuedUpload(upload: PreparedUpload): void {
    if (upload.started) return
    const queued = this.uploads.get(upload.file)
    const index = queued?.indexOf(upload) ?? -1
    if (index !== -1) queued!.splice(index, 1)
    if (queued?.length === 0) this.uploads.delete(upload.file)
    if (upload.attachmentId !== undefined && this.queuedUploads.get(upload.attachmentId) === upload) this.queuedUploads.delete(upload.attachmentId)
    upload.lease.release()
    this.uploadLeases.delete(upload.lease)
  }
  /** FileUploadService port installed in the private graph by the domain owner. */
  async upload(id: UploadArguments[0], data: UploadArguments[1], name?: UploadArguments[2], signal?: UploadArguments[3], progress?: UploadArguments[4]): Promise<Awaited<ReturnType<import('@deepseek-ai/dsh-client-file-upload/client').FileUploadService['upload']>>> {
    const queued = this.uploads.get(data)
    const upload = queued?.shift()
    if (queued?.length === 0) this.uploads.delete(data)
    if (upload === undefined) throw new Error('PROJECT_UPLOAD_UNCAPTURED: picker intake did not capture this upload')
    upload.started = true
    if (upload.attachmentId !== undefined && this.queuedUploads.get(upload.attachmentId) === upload) this.queuedUploads.delete(upload.attachmentId)
    const lease = upload.lease
    try {
      if (lease.address.hostSessionId !== id) throw new Error('PROJECT_UPLOAD_UNCAPTURED: picker intake did not capture this upload')
      lease.assertCurrent()
      if (this.ports.upload === undefined) throw new Error('PROJECT_UPLOAD_UNAVAILABLE: Projects upload owner is unavailable')
      return await this.ports.upload(lease.address, data, name, signal === undefined ? lease.signal : AbortSignal.any([signal, lease.signal]), progress)
    } finally { lease.release(); this.uploadLeases.delete(lease) }
  }
  /** Public controller's retry must capture the current address as a new explicit action. */
  retryFileUpload(id: SessionId, attachment: DraftAttachmentId): void {
    const draft = this.conversation().resolveDraftAttachments([attachment])[0]
    if (draft === undefined || draft.kind !== 'file') return
    if (this.conversation().fileUploads.getSnapshot()[attachment]?.status !== 'error') return
    const [upload] = this.prepareUploads(id, [draft.file])
    this.bindQueuedUpload(upload!, attachment)
    try { this.conversation().retryFileUpload(id, attachment); this.releaseRemovedUploads() }
    catch (error) { this.releaseQueuedUpload(upload!); throw error }
  }
  invalidateLogical(projectId: string, logicalSessionId: string): void {
    const key = logicalDraftKey({ projectId, logicalSessionId })
    this.deleted.add(key)
    this.owners.get(key)?.dispose()
    this.owners.delete(key)
  }
  dispose(): void {
    if (this.ended) return
    this.ended = true
    this.stopUploadObservation?.(); this.stopUploadObservation = undefined
    for (const owner of this.owners.values()) owner.dispose()
    this.owners.clear()
    for (const lease of this.uploadLeases) lease.release()
    this.uploadLeases.clear()
    this.queuedUploads.clear()
  }

  private resolveOwner(binding: SessionBinding, explicit?: CarrierAddress): ProjectDraftOwner {
    if (this.ended) throw new Error('PROJECT_INPUT_DISPOSED: draft registry has ended')
    const address = freezeCarrier(explicit ?? this.boundAddresses.get(binding) ?? this.ports.resolveCarrier(binding))
    if (address.hostSessionId !== binding.sessionId) throw new Error('PROJECT_INPUT_SCOPE: physical binding address mismatch')
    const key = logicalDraftKey(address)
    if (this.deleted.has(key)) throw new Error('PROJECT_DRAFT_DELETED: permanent deletion invalidated this logical draft')
    let owner = this.owners.get(key)
    if (owner === undefined) {
      owner = new ProjectDraftOwner(key, this, binding, address)
      this.owners.set(key, owner)
    } else if (this.ports.isCurrent(address)) owner.bind(binding, address)
    this.boundAddresses.set(binding, address)
    if (!this.bindingOwners.has(binding)) {
      this.bindingOwners.set(binding, owner)
      const shell = owner.shell
      binding.ctx.effect(() => {
        const live = () => !owner!.disposed && sameCarrier(owner!.address, address) && this.ports.isCurrent(address)
        const offs = [
          binding.ctx.on('slash/input-begin-command', req => live() && shell.beginCommand(req.claim, req.span) ? true : undefined),
          binding.ctx.on('slash/input-insert-reference', req => live() && shell.insertReference(req.reference, req.span) ? true : undefined),
          binding.ctx.on('slash/input-consume-token', req => live() && shell.consumeToken(req.guard) ? true : undefined),
          binding.ctx.on('slash/input-insert-text', req => live() && shell.insertText(req.text, req.span, req.continue === true) ? true : undefined),
        ]
        return () => { for (const off of offs) off(); this.bindingOwners.delete(binding); this.boundAddresses.delete(binding); this.inputFaces.delete(binding); this.actionFaces.delete(binding) }
      }, 'Projects input: physical receiver binding')
    }
    return owner
  }
}

/** Compatibility name consumed by the finite native apply template. */
export { ProjectDraftRegistry as InputHub }
