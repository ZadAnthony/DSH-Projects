/** Independent native read domain. Same physical id may also be held by a live domain. */
import { Context } from '@deepseek-ai/cordis'
import { apply as applyRenderer } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply as applyUiSession } from '@deepseek-ai/dsh-client-ui-session/client'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply as applyTools } from '@deepseek-ai/dsh-client-ui-tool/client'
import { apply as applyAttachments } from '@deepseek-ai/dsh-client-ui-attachment/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote, RemoteHostFacts } from '@deepseek-ai/dsh-api-gateway/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale, PropsRuntime, PropsRenderSlots, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { acquireProjectsLocale, EmptyState } from '../../../client/ui/index.ts'
import type { ProjectDetail } from '../../../public-types.ts'
import { ProjectClientPreferences } from '../preferences.ts'
import { installProjectNativeAccess } from '../access.ts'
import { en } from '../native/locales/en.ts'
import { zh } from '../native/locales/zh.ts'
import { en as conversationEn, zh as conversationZh } from '../compat/input/client/locales.ts'
import { ProjectReadSessions, projectReadOnlyError, type ProjectReadRemotePort } from './sessions.ts'
import { ProjectFileReaderOwner, sameProjectFileBinding, type ProjectFileBinding } from './file-reader.ts'
import { ProjectFocusOwner } from './focus.ts'
import { installProjectChat, type InstallProjectChatOptions } from './install-chat.tsx'
import { installProjectReadOnlyNativePresentations } from '../capabilities/read-only.ts'
import type { ProjectChangedFilesPorts } from '../capabilities/changes/index.ts'
import type { ProjectPresentedFilesPorts } from '../capabilities/deliverables/index.ts'
import type { ProjectNativeToolCapabilityPorts } from '../capabilities/contracts.ts'
import { installProjectNativeToolViews } from '../capabilities/tool-views.ts'
import { parseProjectSubagentChatAddress } from '../capabilities/subagent-address.ts'
import { ProjectReplyLinksProvider, type ProjectReplyLinksNavigation } from '../../../client/ProjectReplySessionLinks.tsx'

export { ProjectReadSessions, ProjectReadSession, projectReadOnlyError } from './sessions.ts'
export type { ProjectReadRemotePort } from './sessions.ts'
export { ProjectFileReaderOwner } from './file-reader.ts'
export type { ProjectFileBinding, ProjectFileRequest, ProjectFileReaderOptions } from './file-reader.ts'
export { ProjectFocusOwner } from './focus.ts'
export type { ProjectFocusRequest } from './focus.ts'
export { installProjectChat } from './install-chat.tsx'
export type { InstallProjectChatOptions } from './install-chat.tsx'

export interface ProjectReadDomainOptions {
  readonly remote: ProjectReadRemotePort
  readonly connection: Pick<ConnectionHandle, 'generation'>
  readonly host: RemoteHostFacts
  readonly fileReader: ProjectFileReaderOwner
  readonly focusOwner?: ProjectFocusOwner
  readonly renderCommunicationMessage?: InstallProjectChatOptions['renderCommunicationMessage']
  readonly changedFiles?: Pick<ProjectChangedFilesPorts, 'summary' | 'diff'>
  readonly externalFiles?: ProjectPresentedFilesPorts['externalFiles']
  readonly selectedTools?: ProjectNativeToolCapabilityPorts
  readonly language?: string
  /** Explicit capability bridge: uiRenderer.mount creates an independent React root. */
  readonly replySessionNavigation?: ProjectReplyLinksNavigation | undefined
}

type ReaderRootProps = PropsRuntime<'root'> & PropsLocale<'projects'> & PropsRenderSlots<'conversation.view' | 'shell.overlay' | 'conversation.session.header.lineage' | 'conversation.session.header.actions'> & {
  readonly useReaderSelection: SnapshotSelectorHook<SessionReference | undefined>
  readonly useReaderError: SnapshotSelectorHook<string | undefined>
  readonly replySessionNavigation?: ProjectReplyLinksNavigation | undefined
}
function ReaderRoot({ renderSlot, SessionProvider, useReaderSelection, useReaderError, useSessions, t, replySessionNavigation }: ReaderRootProps) {
  const selected = useReaderSelection(value => value)
  const error = useReaderError(value => value)
  const title = useSessions(value => selected === undefined ? '' : value.byId[selected.sessionId]?.displayTitle ?? selected.sessionId)
  const content = <div className="dsh-projects-native-reader" data-project-read-only="" style={{ display: 'flex', flex: 1, flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>
    {error !== undefined && <p role="alert">{error}</p>}
    <SessionProvider session={selected} empty={() => <EmptyState role="status" title={t('wholeRead.recorded.select')} />}>
      <div data-project-reader-navigation="" style={{ display: 'flex', flexShrink: 0, alignItems: 'center' }}>
        {selected === undefined ? null : renderSlot('conversation.session.header.lineage', { lineageSessionId: selected.sessionId, displayTitle: title })}
        {renderSlot('conversation.session.header.actions', {})}
      </div>
      {renderSlot('conversation.view', { inspectCall: undefined, viewRequest: null,
        openView: () => {}, completeViewRequest: () => {} }, { only: 'chat' })}
    </SessionProvider>
    {renderSlot('shell.overlay', {})}
  </div>
  return replySessionNavigation === undefined ? content : <ProjectReplyLinksProvider projectId={replySessionNavigation.projectId}
    onOpen={replySessionNavigation.onOpen} t={t}>{content}</ProjectReplyLinksProvider>
}

export class ProjectReadDomain {
  readonly ctx: Context
  readonly sessions: ProjectReadSessions
  readonly focusOwner: ProjectFocusOwner
  readonly ready: Promise<void>
  private readonly selection = createSnapshotStore<SessionReference | undefined>(undefined)
  private readonly sourceError = createSnapshotStore<string | undefined>(undefined)
  private reference: SessionReference | undefined
  private unmount: (() => void) | undefined
  private disposed = false
  private readonly stopConnection: () => void
  private readonly ownFocus: boolean
  private detail: ProjectDetail | undefined
  private sourceProjectId: string | undefined
  private nativePresentations: Awaited<ReturnType<typeof installProjectReadOnlyNativePresentations>> | undefined
  get projectId(): string | undefined {
    return this.detail?.project.id ?? this.sourceProjectId
  }

  static async create(options: ProjectReadDomainOptions): Promise<ProjectReadDomain> {
    const ctx = new Context()
    try { const domain = new ProjectReadDomain(options, ctx); await domain.ready; return domain }
    catch (error) { await ctx.fiber.dispose(); throw error }
  }
  private constructor(readonly options: ProjectReadDomainOptions, ctx: Context) {
    this.ctx = ctx; this.ownFocus = options.focusOwner === undefined; this.focusOwner = options.focusOwner ?? new ProjectFocusOwner()
    // Only named reads are supplied to selected-preset views. Kill cannot escape the Reader boundary.
    const selected = options.selectedTools
    const selectedTools: ProjectNativeToolCapabilityPorts | undefined = selected === undefined ? undefined : {
      ...selected, remote: {
        skills: { list: (...args) => selected.remote.skills.list(...args) },
        job: { list: (...args) => selected.remote.job.list(...args), follow: (...args) => selected.remote.job.follow(...args),
          kill: async () => ({ ok: false, error: projectReadOnlyError('job.kill') }) },
      },
    }
    // No active Remote service or root service is shared. Session reads use their captured exact transport.
    ctx.provide('remote', { $host: options.host, session: {}, $on: () => () => {}, ...selectedTools?.remote } as unknown as ClientRemote)
    ctx.provide('connection', options.connection)
    ctx.provide('configForms', new ProjectClientPreferences())
    ctx.provide('uiWorkspace', { openSession: () => { throw projectReadOnlyError('openSession') }, openWorkspace: async () => { throw projectReadOnlyError('openWorkspace') } })
    ctx.provide('sidebarRight', { openResource: (url: string, settings?: { params?: { line?: number } }) => {
      const selected = this.reference
      if (selected === undefined) throw new Error('PROJECT_SOURCE_INVALID: no recorded conversation selected')
      void options.fileReader.openResource(url, settings, this.sessions.address(selected.sessionId))
    }, openTab: () => { throw projectReadOnlyError('openTab') } })
    applyRenderer(ctx)
    installProjectNativeAccess(ctx)
    const locale = new LocaleRuntime(ctx)
    locale.register('common', { en, zh }); locale.register('conversation', { en: conversationEn, zh: conversationZh })
    ctx.effect(() => acquireProjectsLocale(locale), 'Projects Reader dictionaries')
    if (options.language !== undefined) locale.setLocale(options.language)
    ctx.provide('locale', locale); ctx.slots.installLocale(locale)
    this.sessions = new ProjectReadSessions(ctx, options.remote, options.connection, options.host)
    ctx.effect(() => () => this.sessions.dispose(), 'Projects read Session owners')
    applyUiSession(ctx)
    const conversation = new UiConversation(ctx, this.sessions)
    ctx.uiSession.provide({ hooks: ['conversation'], resolve: binding => ({ hooks: { conversation: conversation.binding(binding).snapshot } }) })
    installProjectChat(ctx, { fileReader: options.fileReader, focusOwner: this.focusOwner, allowBranch: false,
      replySessionLinkSource: id => {
        const source = options.fileReader.options.resolveBinding(id)
        return source?.role === 'main' || source?.role === 'execution' ? { originProjectId: source.projectId, role: source.role } : undefined
      },
      ...(options.renderCommunicationMessage === undefined ? {} : { renderCommunicationMessage: options.renderCommunicationMessage }) })
    applyTools(ctx); applyAttachments(ctx)
    // Only Chat and read-only overlays are declared. Composer, input, queue and controls have no slots or owners here.
    const replyNavigationOwner = options.replySessionNavigation
    const replySessionNavigation: ProjectReplyLinksNavigation | undefined = replyNavigationOwner === undefined ? undefined : {
      projectId: replyNavigationOwner.projectId,
      onOpen: async target => {
        if (this.disposed || this.projectId !== replyNavigationOwner.projectId || target.projectId !== this.projectId) {
          throw new DOMException('Project Reader navigation owner is no longer current', 'AbortError')
        }
        await replyNavigationOwner.onOpen(target)
      },
    }
    ctx.slots.register({ name: 'root', locale: 'projects', inject: () => ({ replySessionNavigation, hooks: { readerSelection: this.selection, readerError: this.sourceError } }), children: {
      'conversation.view': { kind: 'list', scope: 'session' }, 'shell.overlay': { kind: 'list', scope: 'root' },
      'conversation.session.header.lineage': { kind: 'single', scope: 'session' },
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
    } }, ReaderRoot)
    let previous = options.connection.generation.getSnapshot()
    this.stopConnection = options.connection.generation.subscribe(() => {
      const next = options.connection.generation.getSnapshot(); if (next === previous) return; previous = next
      if (next !== undefined) { ctx.emit('connection/reset'); void this.sessions.reconnect() }
    })
    ctx.effect(() => this.stopConnection, 'Projects read connection subscription')
    const sourceSession = (address: import('@deepseek-ai/dsh-api-session-controller/types').SessionAddress) => {
      if (address.kind !== 'session') throw new Error('PROJECT_SOURCE_INVALID: the addressed child needs its own verified read adapter')
      return this.sessions.remoteFor(address.sessionId).session
    }
    const fallback = ctx.sidebarRight.openResource
    const openPresentedFile = async (id: import('@deepseek-ai/dsh-session/types').SessionId, path: string, settings?: { readonly line?: number }) => {
      const exact = options.fileReader.options.resolveBinding(id)
      if (exact === undefined) throw new Error('PROJECT_SOURCE_STALE: original presented file session is unavailable')
      await options.fileReader.openFile(exact, path, settings)
    }
    this.ready = installProjectReadOnlyNativePresentations(ctx, { session: {
      follow: (request, signal) => sourceSession(request.address).follow(request, signal),
      page: (request, signal) => sourceSession(request.address).page(request, signal),
    }, openResourceFallback: fallback, presentedFiles: { openFile: openPresentedFile, ...(options.externalFiles === undefined ? {} : { externalFiles: options.externalFiles }) },
      ...(options.changedFiles === undefined ? {} : { changedFiles: { ...options.changedFiles, openFile: openPresentedFile } }),
    }).then(async handle => {
      this.nativePresentations = handle
      if (selectedTools === undefined) return
      await installProjectNativeToolViews(ctx, selectedTools, 'reader')
      const sidebar = ctx.sidebarRight
      const openResource: Context['sidebarRight']['openResource'] = (address, settings) => {
        if (!address.startsWith('dsh-resource://subagentchat/')) return sidebar.openResource(address, settings)
        const target = parseProjectSubagentChatAddress(address)
        if (target === undefined) throw new Error('PROJECT_SOURCE_INVALID: malformed native child navigation address')
        selectedTools.openSubagentAside(target)
      }
      ctx.set('sidebarRight', { ...sidebar, openResource })
    })
  }

  adopt(detail: ProjectDetail): void {
    this.detail = detail
    this.sourceProjectId = detail.project.id
    for (const logical of detail.sessions) {
      if (logical.role !== 'main' && logical.role !== 'execution') continue
      for (const carrier of logical.carriers ?? []) {
        if (carrier.sourceKind !== 'available' || carrier.sessionCreatedAt === undefined
          || detail.unavailableSources.some(value => value.hostSessionId === carrier.hostSessionId)) continue
        this.sessions.adopt({ projectId: detail.project.id, sessionId: logical.id, hostSessionId: carrier.hostSessionId,
          sessionCreatedAt: carrier.sessionCreatedAt, role: logical.role, sessionTitle: logical.title }, detail.project.workspace?.path)
      }
    }
    const exact = this.reference === undefined ? undefined : this.sessions.address(this.reference.sessionId)
    if (exact !== undefined && !this.available(exact)) this.clearSelection('PROJECT_SOURCE_STALE: the original recorded conversation is unavailable')
  }
  private available(exact: ProjectFileBinding): boolean {
    const latest = this.options.fileReader.options.resolveBinding(exact.hostSessionId)
    if (latest === undefined || !sameProjectFileBinding(exact, latest)) return false
    const detail = this.detail
    if (detail === undefined) return true
    if (detail.project.id !== exact.projectId || detail.unavailableSources.some(row => row.hostSessionId === exact.hostSessionId)) return false
    const logical = detail.sessions.find(row => row.id === exact.sessionId)
    if (logical === undefined) return false
    if (logical.carriers === undefined) return logical.hostSessionId === exact.hostSessionId
    return logical.carriers.some(carrier => carrier.hostSessionId === exact.hostSessionId && carrier.sourceKind === 'available'
      && carrier.sessionCreatedAt === exact.sessionCreatedAt)
  }
  private clearSelection(error: string): void {
    this.sourceError.set(error); this.selection.set(undefined)
    const previous = this.reference; this.reference = undefined; previous?.release()
  }
  selectCarrier(exact: ProjectFileBinding): SessionReference {
    if (this.disposed) throw new Error('Project Reader is disposed')
    if (!this.available(exact)) {
      this.clearSelection('PROJECT_SOURCE_STALE: the requested recorded conversation is unavailable')
      throw new Error('PROJECT_SOURCE_STALE: the requested recorded conversation is unavailable')
    }
    this.sourceError.set(undefined)
    this.sourceProjectId = exact.projectId
    this.sessions.adopt(exact, this.detail?.project.workspace?.path)
    if (this.reference?.sessionId === exact.hostSessionId) return this.reference
    const next = this.sessions.retain(SessionId(exact.hostSessionId), { source: 'mainView' })
    const old = this.reference; this.reference = next; this.selection.set(next); old?.release()
    return next
  }
  async mount(container: HTMLElement): Promise<() => void> {
    await this.ready
    if (this.disposed) throw new Error('Project Reader is disposed')
    if (this.unmount !== undefined) throw new Error('Project Reader is already mounted')
    const unmountNative = this.ctx.uiRenderer.mount(container)
    let unmountPresentations: (() => void) | undefined
    try { unmountPresentations = this.nativePresentations?.mount(container) }
    catch (error) { unmountNative(); throw error }
    const unmount = () => { unmountPresentations?.(); unmountNative() }; this.unmount = unmount
    return () => { if (this.unmount === unmount) { this.unmount = undefined; unmount() } }
  }
  async dispose(): Promise<void> {
    if (this.disposed) return; this.disposed = true
    this.stopConnection(); this.unmount?.(); this.unmount = undefined
    this.selection.set(undefined); this.reference?.release(); this.reference = undefined
    this.nativePresentations?.dispose(); this.nativePresentations = undefined
    await this.sessions.dispose(); if (this.ownFocus) this.focusOwner.dispose(); await this.ctx.fiber.dispose()
  }
}
