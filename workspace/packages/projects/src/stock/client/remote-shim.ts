/** Typed Projects façade -> native client protocol, owned by the private UI domain. */
import type { ClientRemote, RemoteHostFacts } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteStream, type RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionRemote, SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionControlFrame, SessionSummary as NativeSessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import { RemoteError, type TypertClientEventListener } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FileUploadService } from '@deepseek-ai/dsh-client-file-upload/client'
import { bytesToBase64 } from '@deepseek-ai/dsh-util-crypto'
import type { ProjectUiTarget } from '../ui-host/types.ts'
import type { ProjectNativeRemoteCapabilities } from './capabilities/contracts.ts'
import type { ProjectClientRemotePort, FullProjectClientRemotePort, ProjectRemoteShimOptions, SessionCommandsRemote, ProjectRefreshEvent, ProjectClientRefreshFrame } from './remote/contracts.ts'
import { ProjectNativeInteractions, type ProjectInteractionSessions } from './remote/interactions.ts'
import { ProjectNativeHostNotifications } from './native-host-notifications.ts'

export type { ProjectClientRemotePort, FullProjectClientRemotePort, ProjectRemoteShimOptions, SessionCommandsRemote, ProjectRefreshEvent, ProjectClientRefreshFrame } from './remote/contracts.ts'
export type { ProjectInteractionSessions } from './remote/interactions.ts'
export interface SessionSubagentsRemote {
  prompt: ClientRemote['subagents']['prompt']
  interruptByParent: ClientRemote['subagents']['interruptByParent']
}
export interface SessionRemotes {
  readonly $stream: ClientRemote['$stream']
  readonly session: SessionRemote
  readonly commands: SessionCommandsRemote
  readonly subagents: SessionSubagentsRemote
}
export type ProjectClientControlFrame = SessionControlFrame
  | { readonly type: 'catalog'; readonly items: readonly NativeSessionSummary[] }
  | { readonly type: 'status'; readonly sessionId: SessionId; readonly running: boolean }
  | { readonly type: 'error'; readonly sessionId: SessionId; readonly message: string }
  | ProjectClientRefreshFrame

type PrivateEvent = 'api-session/status' | 'api-session/error' | ProjectRefreshEvent | 'approval/request' | 'user-questions/request'
type NativeHostEvent = 'plugin-manager/changed'
type EventListener<Event extends PrivateEvent | NativeHostEvent> = TypertClientEventListener<Event>
type ListenerSets = { [Event in PrivateEvent]: Set<EventListener<Event>> }
export function unsupportedProjectClientOperation(operation: string): never {
  throw new RemoteError('gateway/internal', `Projects client capability is not connected: ${operation}`, {})
}

/** Only provided on a new Context; it never subscribes to or broadcasts root Session events. */
export class ProjectRemoteShim implements SessionRemotes, ProjectNativeRemoteCapabilities {
  readonly hostNotifications = new ProjectNativeHostNotifications()
  readonly session: SessionRemote
  readonly commands: ProjectNativeRemoteCapabilities['commands']
  readonly subagents: SessionSubagentsRemote
  readonly fileReferences: ProjectNativeRemoteCapabilities['fileReferences']
  readonly sessionReferenceResolver: ProjectNativeRemoteCapabilities['sessionReferenceResolver']
  readonly userQuestions: ProjectNativeRemoteCapabilities['userQuestions']
  readonly fileUpload: FileUploadService
  readonly permissionPresets: Pick<ClientRemote['permissionPresets'], 'catalog'>
  readonly agentPresets: Pick<ClientRemote['agentPresets'], 'list'>
  readonly skills: ClientRemote['skills']
  readonly job: ClientRemote['job']
  private readonly listeners: ListenerSets = {
    'api-session/status': new Set(), 'api-session/error': new Set(), 'approval/request': new Set(), 'user-questions/request': new Set(),
    'commands/change': new Set(), 'agent-preset/selected': new Set(), 'llm/adapters-updated': new Set(),
    'settings/document-updated': new Set(), 'credentials/record-updated': new Set(), 'credentials/reference-updated': new Set(),
    'permission-presets/catalog-changed': new Set(),
  }
  private readonly catalog = new Set<(items: readonly NativeSessionSummary[]) => void>()
  private readonly interactions: ProjectNativeInteractions
  private disposed = false
  private readonly pendingUploads = new Set<AbortController>()
  private readonly uploads = new Set<Promise<unknown>>()
  private readonly failures = new Set<(error: unknown) => void>()
  private sessions: ProjectInteractionSessions | undefined
  private readonly stopHostNotifications: (() => void) | undefined

  constructor(
    readonly projects: ProjectClientRemotePort,
    private readonly connection: Pick<ConnectionHandle, 'generation'>,
    readonly $host: RemoteHostFacts,
    private readonly options: ProjectRemoteShimOptions,
  ) {
    const full = options.full
    const missing = async (operation: string): Promise<never> => unsupportedProjectClientOperation(operation)
    this.interactions = new ProjectNativeInteractions(full, id => this.capture(id, false), options.mode === 'reader', error => this.failed(error))
    this.listeners['approval/request'] = this.interactions.approvals
    this.listeners['user-questions/request'] = this.interactions.questions
    this.session = {
      control: signal => {
        const source = projects.uiControl(signal)
        const self = this
        return {
          send: item => source.send(item), end: () => source.end(), dispose: () => source.dispose(),
          async *[Symbol.asyncIterator]() {
            for await (const frame of source) {
              if (frame.type === 'status') { self.observeStatus(frame.sessionId, frame.running); continue }
              if (frame.type === 'error') { self.observeAgentError(frame.sessionId, frame.message); continue }
              if (frame.type === 'catalog') { for (const listener of self.catalog) listener(frame.items); continue }
              if (frame.type === 'refresh') { self.observeRefresh(frame); continue }
              yield frame
            }
          },
        }
      },
      follow: (request, signal) => options.mode === 'reader' ? this.full().uiFollowReadonly(request, signal) : projects.uiFollow(request, signal),
      page: (request, signal) => projects.uiPage(request, signal),
      prompt: (request, signal) => full.uiPrompt({ ...structuredClone(request), ...this.capture(request.sessionId, true) }, signal),
      cancel: request => full.uiCancel({ ...structuredClone(request), ...this.capture(request.sessionId, true) }),
      updateQueue: request => full.uiUpdateQueue({ ...structuredClone(request), ...this.capture(request.sessionId, true) }),
      modelCatalog: () => projects.uiModelCatalog(),
      selectModel: request => full.uiSelectModel({ ...structuredClone(request), ...this.capture(request.sessionId, true) }),
      attachment: request => this.full().uiAttachment(request),
      rename: request => this.full().uiRename({ ...structuredClone(request), ...this.capture(request.sessionId, true) }),
      projections: (request, signal) => this.full().uiProjections(request, signal),
      search: (request, signal) => this.full().uiSearch(request, signal),
      fork: async () => missing('fork: Projects has no branch target'),
      list: async () => missing('native list: use Projects catalog'),
      create: async () => missing('native create: use Projects create'),
      initializeDefaultModel: async () => missing('initializeDefaultModel: owned by Projects create'),
      canOpenWorkspacePath: async () => missing('canOpenWorkspacePath'),
      openWorkspacePath: async () => missing('openWorkspacePath'),
      workspacePathApplications: async () => missing('workspacePathApplications'),
    }
    this.commands = {
      list: id => this.full().uiCommandCatalog(this.capture(id, false)),
      execute: (id, line, attachments, signal) => this.full().uiExecuteCommand({ ...this.capture(id, true), line, attachments: structuredClone(attachments) }, signal),
    }
    this.fileReferences = { list: (id, query, signal) => this.full().uiFileCandidates({ ...this.capture(id, false), query }, signal) }
    this.sessionReferenceResolver = { candidates: (id, query, signal) => this.full().uiSessionCandidates({ ...this.capture(id, false), query }, signal) }
    this.userQuestions = {
      answer: (id, callId, answer) => this.full().uiAnswerQuestion({ ...this.capture(id, true), callId, answer: structuredClone(answer) }),
      attachWait: (id, callId, signal) => this.full().uiAttachQuestionWait({ ...this.capture(id, true), callId }, signal),
    }
    this.fileUpload = { upload: (...args) => this.upload(...args) }
    this.permissionPresets = { catalog: () => this.full().uiPermissionCatalog() }
    this.agentPresets = { list: () => this.full().uiAgentPresetList() }
    this.skills = { list: (request, signal) => this.full().uiSkills(request, signal) }
    this.job = {
      list: (request, signal) => this.full().uiJobList(request, signal),
      follow: (request, signal) => this.full().uiJobFollow(request, signal),
      kill: request => this.full().uiJobKill({ ...structuredClone(request), ...this.capture(request.sessionId, true) }),
    }
    this.subagents = {
      prompt: (request, signal) => {
        const { sessionId: _sessionId, ...access } = this.capture(request.parentSessionId, true)
        return this.full().uiSubagentPrompt({ ...structuredClone(request), ...access }, signal)
      },
      interruptByParent: (childSessionId, parentSessionId, mode) => {
        const { sessionId: _sessionId, ...access } = this.capture(parentSessionId, true)
        return this.full().uiSubagentInterrupt({ childSessionId, parentSessionId, mode, ...access })
      },
    }
    this.stopHostNotifications = options.hostNotifications?.subscribePluginManagerChanged((...args) => {
      this.hostNotifications.publishPluginManagerChanged(...args)
    })
  }

  private full(): FullProjectClientRemotePort {
    return this.options.full
  }
  private capture(id: SessionId, write: boolean): ProjectUiTarget {
    if (this.disposed) throw new Error('Projects client Remote is disposed')
    const target = structuredClone(this.options.captureTarget(id))
    if (target.sessionId !== id) throw new Error('Projects client capture changed the physical Session identity')
    const readonly = this.options.mode === 'reader' || target.readonly === true
    if (write && readonly) throw new Error('PROJECT_READ_ONLY: Reader native capabilities cannot mutate a Session')
    return { ...target, ...(readonly ? { readonly: true } : {}) }
  }
  setPlan(id: SessionId, active: boolean): ReturnType<FullProjectClientRemotePort['uiSetPlan']> {
    return this.full().uiSetPlan({ ...this.capture(id, true), active })
  }
  /** A picker holds one exact native binding and one admission-time creation lease. */
  captureAgentPreset(binding: SessionBinding): (preset: string) => ReturnType<ClientRemote['agentPresets']['select']> {
    if (this.sessions?.binding(binding.sessionId) !== binding) throw new Error('Projects preset selection requires the exact retained native binding')
    const target = this.capture(binding.sessionId, true)
    const full = this.full()
    return preset => {
      if (this.disposed || this.sessions?.binding(binding.sessionId) !== binding) throw new Error('Projects preset selection binding is no longer retained')
      return full.uiAgentPresetSelect({ ...target, preset })
    }
  }

  /** All body kinds use the Projects upload RPC, never the root native binary route. */
  private upload(...[id, body, name, signal, onProgress]: Parameters<FileUploadService['upload']>): ReturnType<FileUploadService['upload']> {
    const target = this.capture(id, true)
    const full = this.full()
    const lifetime = new AbortController()
    const combined = signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal])
    this.pendingUploads.add(lifetime)
    const task = (async () => {
      combined.throwIfAborted()
      let bytes: Uint8Array
      if (body instanceof Uint8Array) bytes = body.slice()
      else {
        const stream = body instanceof Blob ? body.stream() : body
        const reader = stream.getReader()
        const abort = () => { void reader.cancel(combined.reason).catch(() => {}) }
        combined.addEventListener('abort', abort, { once: true })
        const chunks: Uint8Array[] = []
        let loaded = 0
        try {
          while (true) {
            combined.throwIfAborted()
            const part = await reader.read()
            combined.throwIfAborted()
            if (part.done) break
            if (!(part.value instanceof Uint8Array)) throw new TypeError('Projects upload stream produced non-byte data')
            chunks.push(part.value.slice()); loaded += part.value.byteLength
            onProgress?.({ loaded, ...(body instanceof Blob ? { total: body.size } : {}) })
          }
        } finally { combined.removeEventListener('abort', abort); reader.releaseLock() }
        bytes = new Uint8Array(loaded)
        let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      }
      combined.throwIfAborted()
      return full.uiUpload({ ...target, data: bytesToBase64(bytes), ...(name === undefined ? {} : { name }) }, combined)
    })()
    this.uploads.add(task)
    void task.finally(() => { this.pendingUploads.delete(lifetime); this.uploads.delete(task) }).catch(() => {})
    return task
  }

  $stream<Item>(options: RemoteStreamOptions<Item>): RemoteStream<Item> { return new RemoteStream(this.connection, options) }
  $on<Event extends PrivateEvent | NativeHostEvent>(event: Event, listener: EventListener<Event>): () => void {
    if (event === 'plugin-manager/changed') {
      return this.hostNotifications.subscribePluginManagerChanged(listener as EventListener<'plugin-manager/changed'>)
    }
    const listeners = this.listeners[event as PrivateEvent] as Set<EventListener<Event>>
    if (listeners === undefined) throw new Error(`Unsupported private Projects event: ${event}`)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  observeStatus(sessionId: SessionId, running: boolean): void {
    for (const listener of this.listeners['api-session/status']) listener(sessionId, running)
  }
  observeAgentError(sessionId: SessionId, message: string): void {
    for (const listener of this.listeners['api-session/error']) listener(sessionId, message)
    this.failed(new Error(`${sessionId}: ${message}`))
  }
  /** Only Projects control or an explicitly installed read-only configuration bridge calls this. */
  observeRefresh(frame: ProjectClientRefreshFrame): void {
    switch (frame.event) {
      case 'commands/change': for (const listener of this.listeners[frame.event]) listener(...frame.args); break
      case 'agent-preset/selected': for (const listener of this.listeners[frame.event]) listener(...frame.args); break
      case 'llm/adapters-updated': for (const listener of this.listeners[frame.event]) listener(...frame.args); break
      case 'settings/document-updated': for (const listener of this.listeners[frame.event]) listener(...frame.args); break
      case 'credentials/record-updated': for (const listener of this.listeners[frame.event]) listener(...frame.args); break
      case 'credentials/reference-updated': for (const listener of this.listeners[frame.event]) listener(...frame.args); break
      case 'permission-presets/catalog-changed': for (const listener of this.listeners[frame.event]) listener(...frame.args); break
      default: throw new Error(`Unsupported private Projects refresh event: ${String((frame as { event: unknown }).event)}`)
    }
  }
  subscribeCatalog(listener: (items: readonly NativeSessionSummary[]) => void): () => void {
    this.catalog.add(listener)
    return () => { this.catalog.delete(listener) }
  }
  subscribeFailure(listener: (error: unknown) => void): () => void { this.failures.add(listener); return () => { this.failures.delete(listener) } }
  private failed(error: unknown): void { for (const listener of this.failures) listener(error) }
  attachSessions(sessions: ProjectInteractionSessions): void {
    if (this.sessions !== undefined && this.sessions !== sessions) throw new Error('Projects client Session owner is already attached')
    this.sessions = sessions
    this.interactions.attachSessions(sessions)
  }
  retainInteractions(id: SessionId): () => void { return this.interactions.retain(id) }
  start(): void { this.interactions.start() }
  restartInteractions(): void { this.interactions.restart() }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.stopHostNotifications?.()
    this.hostNotifications.dispose()
    for (const lifetime of this.pendingUploads) lifetime.abort()
    await Promise.allSettled([this.interactions.dispose(), ...this.uploads])
    for (const listeners of Object.values(this.listeners)) listeners.clear()
    this.catalog.clear(); this.failures.clear()
  }
}
