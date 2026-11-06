/** Independent native Subagent Aside. Native mode, physical header and root write lease are fixed. */
import { Context } from '@deepseek-ai/cordis'
import { apply as applyRenderer } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply as applyUiSession } from '@deepseek-ai/dsh-client-ui-session/client'
import { apply as applyConversation, UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply as applyTools } from '@deepseek-ai/dsh-client-ui-tool/client'
import { apply as applyAttachments } from '@deepseek-ai/dsh-client-ui-attachment/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { acquireProjectsLocale } from '../../../client/ui/copy.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-gateway/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionReference, SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { PropsRuntime, PropsRenderSlots, PropsRenderFactories, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ProjectDetail } from '../../../public-types.ts'
import { ProjectClientPreferences } from '../preferences.ts'
import { installProjectNativeAccess } from '../access.ts'
import { ProjectRemoteShim, type FullProjectClientRemotePort } from '../remote-shim.ts'
import { ProjectFileReaderOwner } from '../read/file-reader.ts'
import { ProjectFocusOwner } from '../read/focus.ts'
import { installProjectChat, type InstallProjectChatOptions } from '../read/install-chat.tsx'
import { installProjectNativeCapabilities,
  type ProjectNativeCapabilities, type ProjectNativeCapabilityPorts } from '../capabilities/index.ts'
import { en } from '../native/locales/en.ts'
import { zh } from '../native/locales/zh.ts'
import { en as conversationEn, zh as conversationZh } from '../compat/input/client/locales.ts'
import { ProjectSubagentCapture, projectSubagentRemote, type ProjectSubagentIdentity } from './transport.ts'
import { ProjectSubagentSessions } from './sessions.ts'
import type { ProjectNativeHostNotificationSource } from '../native-host-notifications.ts'

export { ProjectSubagentCapture, projectSubagentRemote, sameSubagentAddress } from './transport.ts'
export { ProjectSubagentSessions } from './sessions.ts'
export type { ProjectSubagentIdentity } from './transport.ts'

export interface ProjectSubagentDomainOptions extends ProjectSubagentIdentity {
  readonly hostNotifications?: ProjectNativeHostNotificationSource
  readonly remote: FullProjectClientRemotePort
  readonly connection: Pick<ConnectionHandle, 'generation'>
  readonly host: RemoteHostFacts
  readonly detail: ProjectDetail
  readonly fileReader: ProjectFileReaderOwner
  readonly focusOwner?: ProjectFocusOwner
  readonly language?: string
  readonly presentedFiles?: ProjectNativeCapabilityPorts['presentedFiles']
  readonly changedFiles?: ProjectNativeCapabilityPorts['changedFiles']
  readonly onOpenSession: (target: SessionTarget) => void | Promise<void>
  readonly onOpenAside: (address: SubagentAddress) => void | Promise<void>
  readonly renderCommunicationMessage?: InstallProjectChatOptions['renderCommunicationMessage']
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap { 'projects.subagent.live': { kind: 'single'; scope: 'session' } }
}
type RootProps = PropsRuntime<'root'> & {
  readonly reference: SessionReference
  readonly mode: SubagentAddress['mode']
  readonly useSubagentFailure: SnapshotSelectorHook<string | undefined>
}
function SubagentReadRoot({ renderSlot, SessionProvider, reference, mode, useSubagentFailure }: RootProps & PropsRenderSlots<'conversation.view' | 'shell.overlay'>) {
  const error = useSubagentFailure(value => value)
  return <div className="dsh-projects-subagent-domain" data-project-subagent-mode={mode}
    data-project-read-only="" style={{ display: 'flex', flex: 1, flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>
    {error === undefined ? null : <p role="alert">{error}</p>}
    <SessionProvider session={reference}>
      {renderSlot('conversation.view', { inspectCall: undefined, viewRequest: null,
        openView: () => {}, completeViewRequest: () => {} }, { only: 'chat' })}
    </SessionProvider>
    {renderSlot('shell.overlay', {})}
  </div>
}
function SubagentLiveRoot({ renderSlot, SessionProvider, reference, mode, useSubagentFailure }: RootProps & PropsRenderSlots<'projects.subagent.live' | 'shell.overlay'>) {
  const error = useSubagentFailure(value => value)
  return <div className="dsh-projects-subagent-domain" data-project-subagent-mode={mode}
    style={{ display: 'flex', flex: 1, flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>
    {error === undefined ? null : <p role="alert">{error}</p>}
    <SessionProvider session={reference}>
      {renderSlot('projects.subagent.live', {})}
    </SessionProvider>
    {renderSlot('shell.overlay', {})}
  </div>
}

function FixedChatViews(props: ConversationViewsProps) { return <>{props.renderSlot('conversation.session', { view: 'chat' })}</> }
/** Same embedded content selection as stock ui-subagent Sidebar ConversationSlotPanel (MIT, 639ed015). */
function ContinuableBody({ useSession, useConversation, renderFactorySlot }: PropsRuntime<'projects.subagent.live'> & PropsRenderFactories) {
  const session = useSession(value => value), conversation = useConversation(value => value)
  const active = conversation.activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running
  const settling = session.openState === 'loading' || session.subagent?.parentAvailable === undefined
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase: settling ? 'settling' : active ? 'active' : 'hero', hero: !active }, {
    slots: { views: FixedChatViews },
  })
}

export class ProjectSubagentDomain {
  readonly ctx: Context
  readonly capture: ProjectSubagentCapture
  readonly remote: ProjectRemoteShim
  readonly sessions: ProjectSubagentSessions
  readonly reference: SessionReference
  readonly failure = createSnapshotStore<string | undefined>(undefined)
  readonly focusOwner: ProjectFocusOwner
  private readonly preferences = new ProjectClientPreferences()
  private capabilities: ProjectNativeCapabilities | undefined
  private unmount: (() => void) | undefined
  private disposed = false

  static async create(options: ProjectSubagentDomainOptions): Promise<ProjectSubagentDomain> {
    const ctx = new Context()
    let domain: ProjectSubagentDomain | undefined
    try { domain = new ProjectSubagentDomain(options, ctx); await domain.initialize(); return domain }
    catch (error) { if (domain !== undefined) await domain.dispose(); else await ctx.fiber.dispose(); throw error }
  }
  private constructor(readonly options: ProjectSubagentDomainOptions, ctx: Context) {
    this.ctx = ctx
    this.capture = new ProjectSubagentCapture(options, error => this.failure.set(error.message))
    if (options.detail.project.id !== this.capture.rootProof.projectId) throw new Error('PROJECT_SUBAGENT_FOREIGN_PROJECT')
    this.focusOwner = options.focusOwner ?? new ProjectFocusOwner()
    if (options.focusOwner === undefined) ctx.effect(() => () => this.focusOwner.dispose(), 'Projects child source focus')
    const port = projectSubagentRemote(options.remote, this.capture)
    this.remote = new ProjectRemoteShim(port, options.connection, options.host, {
      full: port, mode: this.capture.readOnly ? 'reader' : 'live', captureTarget: id => this.capture.target(id),
      hostNotifications: this.capture.readOnly ? undefined : options.hostNotifications,
    })
    ctx.effect(() => () => this.remote.dispose(), 'Projects child private Remote')
    ctx.effect(() => this.remote.subscribeFailure(error => this.failure.set(String(error))), 'Projects child interaction failures')
    ctx.provide('remote', this.remote); ctx.provide('connection', options.connection); ctx.provide('configForms', this.preferences)
    if (!this.capture.readOnly) ctx.provide('fileUpload', this.remote.fileUpload)
    ctx.provide('uiWorkspace', { openSession: (target: SessionTarget) => { void (async () => { await options.onOpenSession(target) })().catch(error => this.failure.set(String(error))) },
      openWorkspace: async () => { throw new Error('Open the Project workspace from its project settings') } })
    applyRenderer(ctx)
    installProjectNativeAccess(ctx)
    // Native ConversationContent consumes this root presentation even in embedded mode.
    // It does not grant child membership or expose a workspace mutation owner.
    ctx.slots.provideRoot({ hooks: { workspaces: createSnapshotStore<WorkspaceSnapshot>({ items: [], archivedSessionIds: [],
      pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null }) } })
    const locale = new LocaleRuntime(ctx)
    locale.register('common', { en, zh })
    ctx.effect(() => acquireProjectsLocale(locale), 'Projects child dictionaries')
    if (this.capture.readOnly) locale.register('conversation', { en: conversationEn, zh: conversationZh })
    if (options.language !== undefined) locale.setLocale(options.language)
    ctx.provide('locale', locale); ctx.slots.installLocale(locale)
    this.sessions = new ProjectSubagentSessions(ctx, this.remote, this.capture, options.detail.project.workspace?.path)
    this.remote.attachSessions(this.sessions)
    ctx.effect(() => () => this.sessions.dispose(), 'Projects fixed native child')
    ctx.effect(() => this.sessions.controlError.subscribe(() => { const error = this.sessions.controlError.getSnapshot(); if (error !== undefined) this.failure.set(error) }), 'Projects child control failures')
    applyUiSession(ctx)
    if (this.capture.readOnly) {
      const conversation = new UiConversation(ctx, this.sessions)
      ctx.uiSession.provide({ hooks: ['conversation'], resolve: binding => ({ hooks: { conversation: conversation.binding(binding).snapshot } }) })
    } else {
      // One physical child has no carrier replacement. Native InputHub owns its complete transient draft.
      applyConversation(ctx, { maxConcurrentFileUploads: 2 })
    }
    installProjectChat(ctx, { fileReader: options.fileReader, focusOwner: this.focusOwner,
      renderCommunicationMessage: options.renderCommunicationMessage })
    applyTools(ctx); applyAttachments(ctx)
    if (!this.capture.readOnly) ctx.slots.inject('projects.subagent.live', () => ctx.slots.register({ name: 'projects.subagent.live' }, ContinuableBody))
    const injectRoot = () => ({ reference: this.reference, mode: this.capture.address.mode, hooks: { subagentFailure: this.failure } })
    if (this.capture.readOnly) ctx.slots.register({ name: 'root', inject: injectRoot, children: {
      'conversation.view': { kind: 'list', scope: 'session' }, 'shell.overlay': { kind: 'list', scope: 'root' },
    } }, SubagentReadRoot)
    else ctx.slots.register({ name: 'root', inject: injectRoot, children: {
      main: { kind: 'keyed', scope: 'root' }, 'projects.subagent.live': { kind: 'single', scope: 'session' },
      'shell.overlay': { kind: 'list', scope: 'root' },
    } }, SubagentLiveRoot)
    // The Aside is the sole visible conversation of its own private renderer.
    // Native root-scoped pending-review/navigation services therefore select
    // this physical child as their main View, without creating any Project member.
    this.reference = this.sessions.retain(this.capture.address, { source: 'mainView' })
    let previous = options.connection.generation.getSnapshot()
    ctx.effect(() => options.connection.generation.subscribe(() => {
      const next = options.connection.generation.getSnapshot(); if (next === previous) return; previous = next
      if (next !== undefined) { ctx.emit('connection/reset'); this.sessions.reconnect(); this.remote.restartInteractions() }
    }), 'Projects child connection')
  }
  private openResource: Context['sidebarRight']['openResource'] = (url, settings) => {
    void this.options.fileReader.openResource(url, settings, this.capture.childSource).catch(error => this.failure.set(String(error)))
  }
  private async initialize(): Promise<void> {
    const selectedTools = { remote: this.remote, uiWorkspace: this.ctx.uiWorkspace,
      openSubagentAside: (address: SubagentAddress) => { void (async () => { await this.options.onOpenAside(address) })().catch(error => this.failure.set(String(error))) } }
    const openFile: NonNullable<ProjectNativeCapabilityPorts['presentedFiles']>['openFile'] = (id, path, settings) => {
      this.capture.assertChild(id)
      return this.options.fileReader.openFile(this.capture.childSource, path, settings)
    }
    const presentedFiles = this.options.presentedFiles === undefined ? undefined : {
      openFile,
      ...(this.options.presentedFiles.externalFiles === undefined ? {} : { externalFiles: this.options.presentedFiles.externalFiles }),
      ...(this.options.presentedFiles.readFileBytes === undefined ? {} : { readFileBytes: ((id, path, settings, signal) => {
        this.capture.assertChild(id); return this.options.presentedFiles!.readFileBytes!(id, path, settings, signal)
      }) as NonNullable<ProjectNativeCapabilityPorts['presentedFiles']>['readFileBytes'] }),
    }
    const changedFiles = this.options.changedFiles === undefined ? undefined : {
      openFile,
      summary: ((id, seq, signal) => { this.capture.assertChild(id); return this.options.changedFiles!.summary(id, seq, signal) }) as NonNullable<ProjectNativeCapabilityPorts['changedFiles']>['summary'],
      diff: ((id, seq, index, signal) => { this.capture.assertChild(id); return this.options.changedFiles!.diff(id, seq, index, signal) }) as NonNullable<ProjectNativeCapabilityPorts['changedFiles']>['diff'],
    }
    if (this.capture.readOnly) {
      // Reader mode installs immutable Plan/tool views; it never installs writer controllers or shortcuts.
      this.capabilities = await installProjectNativeCapabilities(this.ctx, { mode: 'reader', remote: this.remote,
        openResourceFallback: this.openResource, selectedTools, presentedFiles, changedFiles })
    } else {
      await this.ctx.inject(['conversation'], () => {})
      this.capabilities = await installProjectNativeCapabilities(this.ctx, { mode: 'live', remote: this.remote,
        openResourceFallback: this.openResource, selectedTools, presentedFiles, changedFiles,
        currentSessionPickers: { permissionPresets: this.remote.permissionPresets,
          agentPresets: { list: this.remote.agentPresets.list, select: (binding, preset) => this.remote.captureAgentPreset(binding)(preset) },
          developerTools: this.preferences.developerTools.enabled },
      })
      this.sessions.start(); this.remote.start()
    }
    await this.reference.ready
  }
  async mount(container: HTMLElement): Promise<() => void> {
    if (this.disposed || this.unmount !== undefined) throw new Error('Projects child cannot mount')
    const native = this.ctx.uiRenderer.mount(container)
    let capabilities: (() => void) | undefined
    try { capabilities = this.capabilities?.mount(container) }
    catch (error) { native(); throw error }
    const unmount = () => { capabilities?.(); native() }; this.unmount = unmount
    return () => { if (this.unmount === unmount) { this.unmount = undefined; unmount() } }
  }
  async dispose(): Promise<void> {
    if (this.disposed) return; this.disposed = true
    this.capture.dispose(); this.unmount?.(); this.unmount = undefined; this.reference.release()
    // Native input and view observers must retire their binding scopes while
    // their root services and dictionaries still exist.
    await this.sessions.dispose(); await this.remote.dispose()
    await this.ctx.fiber.dispose()
  }
}
