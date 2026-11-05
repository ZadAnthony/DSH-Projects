/** Full Projects product, composed solely inside its independent native Client domain. */
import { Context } from '@deepseek-ai/cordis'
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-gateway/client'
import { apply as applyRenderer } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply as applyUiSession } from '@deepseek-ai/dsh-client-ui-session/client'
import { apply as applyTools } from '@deepseek-ai/dsh-client-ui-tool/client'
import { apply as applyAttachments } from '@deepseek-ai/dsh-client-ui-attachment/client'
import { conversationPhase } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionBinding, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { HostObservable, PropsRuntime, PropsRenderSlots, PropsRenderFactories, PropsLocale, SessionProviderComponent, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceFileText, WorkspaceFileBytes } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { RemoteStreamHandle, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ProjectUiConfigurationStatus } from '../ui-host/types.ts'
import type { ProjectDetail, ReadProjectCommunicationRequest } from '../../public-types.ts'
import type { NativeEventSource, NativeProjectSource } from '../../source-types.ts'
import type { NativeFileOpenPort, ProjectLogicalBinding, ProjectPanelReference, ProjectsRemote } from '../../client/controller.ts'
import type { ProjectCommunicationInjected, ProjectCommunicationFileContext } from '../../client/ProjectCommunicationCard.tsx'
import { projectSourceNavigation, type ProjectConversationFilePage } from '../../client/workflow-navigation.ts'
import type { ProjectUiCarrierAddress, ProjectUiTarget, ProjectUiFileReadRequest, ProjectUiFileBytesRequest, ProjectUiChangesRequest, ProjectUiChangesDiffRequest, ProjectUiChangesSummary, ProjectUiSubagentInfo } from '../ui-host/types.ts'
import { ProjectSessions } from './sessions.ts'
import { ProjectRemoteShim, type FullProjectClientRemotePort, type ProjectInteractionSubmission } from './remote-shim.ts'
import { ProjectClientPreferences, type ProjectClientPreferenceBridge } from './preferences.ts'
import { installProjectNativeAccess } from './access.ts'
import { applyProjectConversation, type ProjectDraftRegistry } from './compat/input/index.ts'
import { sameCarrier, type CarrierAddress } from './draft/types.ts'
import { installProjectNativeCapabilities, type ProjectNativeCapabilities, type ProjectNativeToolCapabilityPorts } from './capabilities/index.ts'
import { installProjectProductToolViews, installProjectProductUi, type ProjectConversationPresentation } from './product/index.tsx'
import { ProjectFileReaderOwner, ProjectFocusOwner, ProjectReadDomain, ProjectReadSessions, installProjectChat, type ProjectFileBinding } from './read/index.tsx'
import { ProjectSubagentDomain, sameSubagentAddress } from './subagent/index.tsx'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import { ProjectMainModelControl } from '../../client/ProjectMainModelControl.tsx'
import type { ProjectsTranslate } from '../../client/ui/copy.ts'
import { ProjectReplyLinksHost, useProjectReplyLinksNavigation, type ProjectReplyLinksNavigation } from '../../client/ProjectReplySessionLinks.tsx'
import { ErrorState, IconAction, IconCloseOutlineRegular, LoadingState, Tooltip } from '../../client/ui/index.ts'
import type { WorkspaceFileDiff } from '@deepseek-ai/dsh-workspace-changes/types'
import { en } from './native/locales/en.ts'
import { zh } from './native/locales/zh.ts'
import { ProjectMainWelcomeContext } from './ProjectMainWelcome.tsx'

export interface FullProjectProductRemote extends FullProjectClientRemotePort, ProjectsRemote {
  uiConfigurationStatus(signal?: AbortSignal): Promise<RemoteResult<ProjectUiConfigurationStatus>>
  uiWatchConfiguration(signal?: AbortSignal): RemoteStreamHandle<ProjectUiConfigurationStatus, never>
  uiCarrierAddress(request: ProjectUiTarget, signal?: AbortSignal): Promise<RemoteResult<ProjectUiCarrierAddress>>
  uiReadFileBytes(request: ProjectUiFileBytesRequest, signal?: AbortSignal): Promise<RemoteResult<WorkspaceFileBytes>>
  uiChangesSummary(request: ProjectUiChangesRequest, signal?: AbortSignal): Promise<RemoteResult<ProjectUiChangesSummary | undefined>>
  uiChangesDiff(request: ProjectUiChangesDiffRequest, signal?: AbortSignal): Promise<RemoteResult<WorkspaceFileDiff | undefined>>
  uiReadFile(request: ProjectUiFileReadRequest, signal?: AbortSignal): Promise<RemoteResult<WorkspaceFileText>>
}
export interface FullProjectClientDomainOptions {
  readonly remote: FullProjectProductRemote
  readonly connection: Pick<ConnectionHandle, 'generation'>
  readonly host: RemoteHostFacts
  readonly language?: string
  readonly preferences: ProjectClientPreferenceBridge
  /** Explicit user actions only. These methods carry paths, never private Agent objects or Session ids. */
  readonly externalFiles: Pick<NativeFileOpenPort, 'canOpenWorkspacePath' | 'openWorkspacePath'>
  /** Explicit root UI capability; never read from the private navigation service. */
  readonly pickWorkspaceDirectory?: () => Promise<string | null>
  readonly toggleGlobalSidebar?: () => void
  readonly revealProjects?: () => void
}

type Focus = ProjectConversationPresentation['focus']
interface SourceFocusIntent {
  readonly revision: number
  readonly detail: ProjectDetail
  readonly source: NativeProjectSource
  /** Exact navigation produced by this source gesture, not a coincident coordinate prop. */
  readonly coordinate?: string
}
function coordinateFocusKey(sessionId: string, focus: NonNullable<Focus>): string {
  return JSON.stringify([sessionId, focus.id, focus.eventSeq, focus.messageId ?? null])
}
interface RenderBridge {
  readonly Provider: SessionProviderComponent
  native(focus: Focus, visible?: boolean, identity?: ProjectConversationIdentity): ReactNode
  model(): ReactNode
}
interface ProjectConversationIdentity {
  readonly projectName: string
  readonly role: 'main' | 'execution'
}
const RenderContext = createContext<RenderBridge | undefined>(undefined)
const ProjectPresetDockContext = createContext<ReactNode>(null)
function ProjectPresetDock() { return useContext(ProjectPresetDockContext) }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'projects.native.conversation': { kind: 'single'; scope: 'session'; owner: { readonly focus?: Focus; readonly visible?: boolean; readonly identity?: ProjectConversationIdentity } }
    'projects.native.model': { kind: 'single'; scope: 'session' }
    'projects.native.session.actions': { kind: 'list'; scope: 'session' }
    'projects.native.preset': { kind: 'single'; scope: 'session-maybe' }
  }
}

/** The original header/content own their declarations. Reuse only these four native leaves. */
function installProjectNativePaneSeats(ctx: Context): void {
  for (const [source, target, ids] of [
    ['conversation.session.header.actions', 'projects.native.session.actions', new Set(['agent-preset', 'subagent-catalog', 'job-list'])],
    ['conversation.hero.agentPreset', 'projects.native.preset', undefined],
  ] as const) ctx.slots.inject(target, () => {
    const installed = new Map<StoredEntry, () => void>()
    const update = () => {
      const entries = ctx.slots.entriesOfSlot(source).filter(entry => ids === undefined || entry.options.id !== undefined && ids.has(entry.options.id))
      for (const [entry, close] of installed) if (!entries.includes(entry)) { close(); installed.delete(entry) }
      for (const entry of entries) if (!installed.has(entry)) installed.set(entry, ctx.slots.register({
        ...entry.options, name: target, inject: entry.inject, locale: entry.locale, store: entry.store, select: entry.select,
      } as never, entry.component as never))
    }
    update()
    const stop = ctx.slots.subscribe(source, update)
    return () => { stop(); for (const close of installed.values()) close(); installed.clear() }
  })
}

function ProductRoot({ renderSlot, SessionProvider, domain, t }: PropsRuntime<'root'> & PropsLocale<'projects'> & PropsRenderSlots<'main' | 'shell.overlay' | 'projects.native.conversation' | 'projects.native.model'> & { readonly domain: FullProjectClientDomain }) {
  const navigationFailure = useSyncExternalStore(domain.navigationFailure.subscribe, domain.navigationFailure.getSnapshot)
  const submissionFailure = useSyncExternalStore(domain.submissionFailure.subscribe, domain.submissionFailure.getSnapshot)
  const bridge = useMemo<RenderBridge>(() => ({ Provider: SessionProvider,
    native: (focus, visible, identity) => renderSlot('projects.native.conversation', { focus, visible, identity }),
    model: () => renderSlot('projects.native.model', {}),
  }), [SessionProvider, renderSlot])
  return <ProjectReplyLinksHost><RenderContext.Provider value={bridge}><div className="dsh-projects-native-domain" style={{ width: '100%', height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
    {navigationFailure !== undefined && <ErrorState inline title={t('wholeRead.navigation.failed')} description={t('wholeRead.navigation.recovery')} diagnostic={{ label: t('wholeRead.navigation.failed'), content: navigationFailure }}>
      <IconAction aria-label={t('wholeRead.navigation.dismiss')} title={t('wholeRead.navigation.dismiss')} icon={<IconCloseOutlineRegular />} onClick={() => domain.navigationFailure.set(undefined)} />
    </ErrorState>}
    {submissionFailure !== undefined && <ErrorState inline title={t('wholeRead.submission.failed')} description={t('wholeRead.submission.recovery')}>
      <p>{t('wholeRead.submission.retained')}</p>
      <SubmissionContent value={submissionFailure} translate={t} />
      <IconAction aria-label={t('wholeRead.navigation.dismiss')} title={t('wholeRead.navigation.dismiss')} icon={<IconCloseOutlineRegular />} onClick={() => domain.submissionFailure.set(undefined)} />
    </ErrorState>}
    {renderSlot('main', {}, { entryKey: 'projects' })}{renderSlot('shell.overlay', {})}<SubagentAsides domain={domain} translate={t} /><RecordedAside domain={domain} translate={t} />
  </div></RenderContext.Provider></ProjectReplyLinksHost>
}

function SubmissionContent({ value: { item, response }, translate: t }: { readonly value: Extract<ProjectInteractionSubmission, { status: 'failed' }>; readonly translate: ProjectsTranslate }) {
  if (response.kind === 'approval') return <p>{t('wholeRead.submission.approval')}：{t(`wholeRead.submission.outcome.${response.outcome}`)}</p>
  if (response.kind !== 'question' || item.kind !== 'question') return null
  return <dl>{response.answer.answers.map((answer, index) => {
    const question = item.questions.find(question => question.id === answer.id)
    return question === undefined ? null : <div key={index}><dt>{question.question}</dt><dd>{answer.selected.map((selection, index) => <p key={index}>{selection}</p>)}{answer.custom !== undefined && <p style={{ whiteSpace: 'pre-wrap' }}>{answer.custom}</p>}</dd></div>
  })}</dl>
}

function LivePane({ panel, focus, visible = true, projectName }: { readonly panel: ProjectPanelReference; readonly focus: Focus; readonly visible?: boolean; readonly projectName?: string }) {
  const bridge = useContext(RenderContext)
  if (bridge === undefined) throw new Error('Project conversation rendered outside its private renderer')
  const Provider = bridge.Provider
  const currentProjectName = projectName !== undefined ? projectName : panel.detail.project.name
  return <Provider session={panel.reference}>{bridge.native(focus, visible, { projectName: currentProjectName, role: panel.session.role })}</Provider>
}
function LiveModel({ panel }: { readonly panel: ProjectPanelReference }) {
  const bridge = useContext(RenderContext)
  if (bridge === undefined) throw new Error('Project model rendered outside its private renderer')
  const Provider = bridge.Provider
  return <Provider session={panel.reference}>{bridge.model()}</Provider>
}
function ReadModel({ reference, translate }: { readonly reference: SessionReference; readonly translate: ProjectsTranslate }) {
  const source = reference.binding.session.projections.faceOf('modelSelection')
  const value = useSyncExternalStore(source.subscribe, source.getSnapshot) as { next?: { provider: string; model: string } | null; lastUsed?: { provider: string; model: string } | null } | undefined
  const selection = value?.next ?? value?.lastUsed
  return <p role="status">{selection === undefined || selection === null ? translate('p5.model.originalSelectionUnavailable') : translate('p5.model.readOnlySelection', { provider: selection.provider, model: selection.model })}</p>
}

async function painted(signal?: AbortSignal): Promise<void> {
  for (let count = 0; count < 2; count++) { signal?.throwIfAborted(); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) }
  signal?.throwIfAborted()
}

function NativePane({ domain, sessionId, useSession, useConversation, renderFactorySlot, renderSlot, focus, visible = true, identity, t }: PropsRuntime<'projects.native.conversation'> & PropsLocale<'projects'> & PropsRenderFactories & PropsRenderSlots<'projects.native.session.actions' | 'projects.native.preset'> & { readonly domain: FullProjectClientDomain }) {
  const snapshot = useSession(value => value)
  const conversation = useConversation(value => value)
  const [failure, setFailure] = useState<string>()
  const sourceRequest = useSyncExternalStore(domain.sourceFocus.subscribe, domain.sourceFocus.getSnapshot)
  const binding = domain.sessions.binding(sessionId)
  useLayoutEffect(() => visible && binding !== undefined ? domain.retainNativePresetPane(binding) : undefined, [domain, binding, visible])
  const coordinate = focus === undefined ? undefined : coordinateFocusKey(sessionId, focus)
  const latestCoordinate = useRef(coordinate); latestCoordinate.current = coordinate
  const focusAttempt = useRef<AbortController>()
  // Abort at the visibility commit; starting focus stays passive so child Chat can register first.
  useLayoutEffect(() => () => { focusAttempt.current?.abort() }, [visible])
  useEffect(() => {
    if (!visible) return
    const original = sourceRequest?.source.hostSessionId === sessionId && !domain.focusedSourceIntents.has(sourceRequest) ? sourceRequest : undefined
    const sourceNavigationDone = sourceRequest !== undefined && domain.focusedSourceIntents.has(sourceRequest) && sourceRequest.coordinate === coordinate
    if (original === undefined && (coordinate === undefined || domain.focusedCoordinateIntents.has(coordinate) || sourceNavigationDone)) return
    const abort = new AbortController()
    focusAttempt.current = abort
    const current = () => !abort.signal.aborted && focusAttempt.current === abort && latestCoordinate.current === coordinate && domain.sourceFocus.getSnapshot() === sourceRequest
    void (original === undefined ? domain.focusCoordinate(sessionId, focus!, abort.signal) : domain.focusSource(original.detail, original.source, domain.focusOwner, abort.signal, domain.sessions.binding(sessionId))).then(() => {
      if (!current()) return
      if (original !== undefined) domain.focusedSourceIntents.add(original)
      if (original === undefined && coordinate !== undefined) domain.focusedCoordinateIntents.add(coordinate)
      setFailure(undefined)
    }, error => { if (current()) setFailure(error instanceof Error ? error.message : String(error)) })
    return () => { abort.abort(); if (focusAttempt.current === abort) focusAttempt.current = undefined }
  }, [domain, sessionId, coordinate, sourceRequest, visible])
  const phase = snapshot.openState === 'loading' && snapshot.blank ? 'settling'
    : conversation.activeTargets.size === 0 && snapshot.blank && !snapshot.running ? 'hero' : 'active'
  const welcome = identity?.role === 'main' && phase === 'hero' && conversationPhase(snapshot, conversation) === 'blank'
    ? { projectName: identity.projectName, description: t('p5.mainWelcome.description') } : undefined
  const preset = visible && welcome === undefined && phase === 'hero' && conversationPhase(snapshot, conversation) === 'blank'
    ? <div className="projects-ui__preset-seat" data-project-preset-seat={sessionId}>{renderSlot('projects.native.preset', {})}</div> : null
  return <ProjectMainWelcomeContext.Provider value={welcome}><ProjectPresetDockContext.Provider value={preset}>
    {failure !== undefined && <ErrorState inline title={t('whole.stock.reading.failed')} description={t('wholeRead.navigation.recovery')} diagnostic={{ label: t('whole.stock.reading.failed'), content: failure }} />}
    {visible && welcome === undefined && <div className="projects-ui__native-actions" data-project-native-actions={sessionId}>{renderSlot('projects.native.session.actions', {})}</div>}
    {renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero: welcome !== undefined })}
  </ProjectPresetDockContext.Provider></ProjectMainWelcomeContext.Provider>
}

function ReaderPane({ domain, detail, binding, source, focus, visible = true, translate }: { readonly translate: ProjectsTranslate; readonly domain: FullProjectClientDomain; readonly detail: ProjectDetail; readonly binding: ProjectFileBinding; readonly source?: NativeProjectSource; readonly focus?: Focus; readonly visible?: boolean }) {
  const element = useRef<HTMLDivElement>(null)
  const navigation = useProjectReplyLinksNavigation()
  const latestNavigation = useRef(navigation); latestNavigation.current = navigation
  const [failure, setFailure] = useState<string>()
  const [mounted, setMounted] = useState<{ reader: ProjectReadDomain; reference: SessionReference }>()
  const sourceRequest = useSyncExternalStore(domain.sourceFocus.subscribe, domain.sourceFocus.getSnapshot)
  const coordinate = mounted === undefined || focus === undefined ? undefined : coordinateFocusKey(mounted.reference.sessionId, focus)
  const latestCoordinate = useRef(coordinate); latestCoordinate.current = coordinate
  const focusAttempt = useRef<AbortController>()
  const focusedExplicitSource = useRef<{ readonly source: NativeProjectSource; readonly binding: SessionBinding }>()
  useLayoutEffect(() => () => { focusAttempt.current?.abort() }, [visible])
  useEffect(() => {
    const abort = new AbortController()
    setFailure(undefined)
    let reader: ProjectReadDomain | undefined
    let release: (() => void) | undefined
    const start = async () => {
      const replySessionNavigation: ProjectReplyLinksNavigation = {
        projectId: binding.projectId,
        onOpen: async target => {
          const current = latestNavigation.current
          if (abort.signal.aborted || current?.projectId !== binding.projectId) throw new DOMException('Project Reader navigation was replaced', 'AbortError')
          await current.onOpen(target)
        },
      }
      reader = await ProjectReadDomain.create({ remote: domain.options.remote, connection: domain.options.connection, host: domain.options.host,
        fileReader: domain.fileReader, externalFiles: domain.options.externalFiles, language: domain.ctx.locale.getSnapshot().active, changedFiles: domain.changedFileReads, selectedTools: domain.readOnlyToolViews(),
        replySessionNavigation,
        renderCommunicationMessage: props => domain.product.renderCommunicationMessage(props) })
      if (abort.signal.aborted) { await reader.dispose(); return }
      reader.adopt(detail)
      const reference = reader.selectCarrier(binding)
      await reference.ready
      domain.installReadToolViews(reader.ctx, reference.binding)
      if (abort.signal.aborted || element.current === null) { await reader.dispose(); return }
      await painted(abort.signal)
      release = await reader.mount(element.current)
      domain.readers.add(reader); domain.readerProjects.set(reader, detail.project.id)
      setMounted({ reader, reference })
    }
    void start().catch(error => { if (!abort.signal.aborted) setFailure(error instanceof Error ? error.message : String(error)) })
    return () => { abort.abort(); setMounted(undefined); if (reader !== undefined) domain.retireView(reader, release) }
  }, [domain, binding.projectId, binding.sessionId, binding.hostSessionId, binding.sessionCreatedAt, source?.kind === 'native-event' ? source.eventDigest : undefined, focus?.id])
  useEffect(() => {
    if (mounted === undefined || !visible) return
    const original = source ?? (sourceRequest?.source.hostSessionId === binding.hostSessionId && !domain.focusedSourceIntents.has(sourceRequest) ? sourceRequest.source : undefined)
    if (source !== undefined && focusedExplicitSource.current?.source === source && focusedExplicitSource.current.binding === mounted.reference.binding) return
    const sourceNavigationDone = sourceRequest !== undefined && domain.focusedSourceIntents.has(sourceRequest) && sourceRequest.coordinate === coordinate
    if (original === undefined && (coordinate === undefined || domain.focusedCoordinateIntents.has(coordinate) || sourceNavigationDone)) return
    const abort = new AbortController()
    focusAttempt.current = abort
    const originalDetail = source === undefined && sourceRequest !== undefined && sourceRequest.source === original ? sourceRequest.detail : detail
    const action = original !== undefined ? domain.focusSource(originalDetail, original, mounted.reader.focusOwner, abort.signal, mounted.reference.binding)
      : domain.focusCoordinate(mounted.reference.sessionId, focus!, abort.signal, mounted.reader.focusOwner, mounted.reference.binding)
    const current = () => !abort.signal.aborted && focusAttempt.current === abort && latestCoordinate.current === coordinate && domain.sourceFocus.getSnapshot() === sourceRequest
    void action.then(() => {
      if (!current()) return
      if (source !== undefined) focusedExplicitSource.current = { source, binding: mounted.reference.binding }
      else if (original !== undefined && sourceRequest !== undefined) domain.focusedSourceIntents.add(sourceRequest)
      if (original === undefined && coordinate !== undefined) domain.focusedCoordinateIntents.add(coordinate)
      setFailure(undefined)
    }, error => { if (current()) setFailure(error instanceof Error ? error.message : String(error)) })
    return () => { abort.abort(); if (focusAttempt.current === abort) focusAttempt.current = undefined }
  }, [domain, mounted, source, sourceRequest, coordinate, visible])
  return <div className="projects-ui__stock-pane"><p className="projects-ui__stock-readonly" role="status">{translate('p5.reading.originalReadOnly')}</p>
    {failure !== undefined ? <ErrorState title={translate('whole.stock.reading.failed')} description={translate('wholeRead.navigation.recovery')} diagnostic={{ label: translate('whole.stock.reading.failed'), content: failure }} />
      : mounted === undefined ? <LoadingState label={translate('whole.stock.reading.loading')} rows={3} /> : null}
    <div ref={element} className="projects-ui__stock-pane-body" />
  </div>
}

function RecordedAside({ domain, translate }: { readonly domain: FullProjectClientDomain; readonly translate: ProjectsTranslate }) {
  const record = useSyncExternalStore(domain.recordedAside.subscribe, domain.recordedAside.getSnapshot)
  if (record === undefined) return null
  const title = record.binding.sessionTitle ?? record.binding.hostSessionId
  return <aside aria-label={translate('p5.reading.recordedAria')} className="projects-ui__stock-aside projects-ui__stock-aside--recorded">
    <header className="projects-ui__stock-head"><Tooltip label={title}><span className="projects-ui__stock-title">{title}</span></Tooltip>
      <IconAction aria-label={translate('p5.reading.closeOriginal')} title={translate('p5.reading.closeOriginal')}
        icon={<IconCloseOutlineRegular />} onClick={() => { domain.closeRecordedAside(record) }} />
    </header>
    <div className="projects-ui__stock-pane-body"><ReaderPane translate={translate} domain={domain} detail={record.detail} binding={record.binding} /></div>
  </aside>
}

interface ProjectChildAside {
  readonly key: string
  readonly address: SubagentAddress
  readonly rootProof: CarrierAddress
  readonly childSource: ProjectFileBinding
  readonly detail: ProjectDetail
}
function ChildAsidePane({ domain, entry, translate }: { readonly domain: FullProjectClientDomain; readonly entry: ProjectChildAside; readonly translate: ProjectsTranslate }) {
  const element = useRef<HTMLDivElement>(null)
  const [failure, setFailure] = useState<string>()
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    let live = true
    let child: ProjectSubagentDomain | undefined
    let release: (() => void) | undefined
    const start = async () => {
      child = await ProjectSubagentDomain.create({ ...entry, remote: domain.options.remote,
        hostNotifications: domain.remote.hostNotifications,
        connection: domain.options.connection, host: domain.options.host, fileReader: domain.fileReader,
        language: domain.ctx.locale.getSnapshot().active, isRootCurrent: proof => domain.sessions.isCurrent(proof),
        presentedFiles: domain.presentedFiles, changedFiles: { ...domain.changedFileReads, openFile: (id, path, settings) => domain.openPresentedFile(id, path, settings) },
        onOpenSession: target => domain.openNativeSession(target), onOpenAside: address => domain.openSubagentAside(address),
        renderCommunicationMessage: props => domain.product.renderCommunicationMessage(props) })
      if (!live || element.current === null) { await child.dispose(); return }
      domain.installReadToolViews(child.ctx, child.reference.binding)
      await painted()
      if (!live || element.current === null) { await child.dispose(); return }
      release = await child.mount(element.current)
      domain.children.add(child)
      if (live) setMounted(true)
    }
    void start().catch(error => { if (live) setFailure(error instanceof Error ? error.message : String(error)) })
    return () => { live = false; if (child !== undefined) domain.retireView(child, release) }
  }, [domain, entry.key])
  return <div className="projects-ui__stock-pane">
    {failure !== undefined ? <ErrorState title={translate('whole.stock.reading.failed')} description={translate('wholeRead.navigation.recovery')} diagnostic={{ label: translate('whole.stock.reading.failed'), content: failure }} />
      : !mounted ? <LoadingState label={translate('whole.stock.reading.loading')} rows={3} /> : null}
    <div ref={element} className="projects-ui__stock-pane-body" />
  </div>
}
function SubagentAsides({ domain, translate }: { readonly domain: FullProjectClientDomain; readonly translate: ProjectsTranslate }) {
  const entries = useSyncExternalStore(domain.childAsides.subscribe, domain.childAsides.getSnapshot)
  const selected = useSyncExternalStore(domain.selectedChild.subscribe, domain.selectedChild.getSnapshot)
  return <>{entries.map(entry => <aside key={entry.key} aria-label={translate('p5.reading.subagentAria')} hidden={selected !== entry.key}
    className="projects-ui__stock-aside projects-ui__stock-aside--child">
    <header className="projects-ui__stock-head"><Tooltip label={`${entry.address.childSessionId} · ${translate(entry.address.mode === 'continuable' ? 'p5.reading.continuable' : entry.address.mode === 'one-shot' ? 'p5.reading.oneShot' : 'p5.reading.unknownMode')}`}><span className="projects-ui__stock-title">{entry.address.childSessionId} · {translate(entry.address.mode === 'continuable' ? 'p5.reading.continuable' : entry.address.mode === 'one-shot' ? 'p5.reading.oneShot' : 'p5.reading.unknownMode')}</span></Tooltip>
      <IconAction aria-label={translate('p5.reading.closeChild')} title={translate('p5.reading.closeChild')}
        icon={<IconCloseOutlineRegular />} onClick={() => { domain.closeSubagentAside(entry.key) }} />
    </header>
    <div className="projects-ui__stock-pane-body"><ChildAsidePane domain={domain} entry={entry} translate={translate} /></div>
  </aside>)}</>
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined }

interface AsideReturnFocus {
  readonly opener?: HTMLElement
  readonly root?: CarrierAddress
  readonly rootWasCurrent: boolean
}

/** Native visibility plus the collapsible ancestors not represented by computed display in jsdom. */
function usableAsideFocus(element: HTMLElement, container: HTMLElement): boolean {
  if (!element.isConnected || !container.contains(element) || element.matches(':disabled, [aria-disabled="true"]')) return false
  if (element.closest('[hidden], [inert], [aria-hidden="true"], [aria-disabled="true"]') !== null) return false
  for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
    const style = element.ownerDocument.defaultView?.getComputedStyle(node)
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse' || style?.opacity === '0' || style?.contentVisibility === 'hidden') return false
    if (node.tagName === 'DETAILS' && !node.hasAttribute('open') && !node.querySelector(':scope > summary')?.contains(element)) return false
  }
  return true
}

/** No root UI service is shadowed. Full product and native capability lifetimes belong to this Context. */
export class FullProjectClientDomain {
  readonly ctx: Context
  readonly sessions: ProjectSessions
  readonly remote: ProjectRemoteShim
  readonly fileReader: ProjectFileReaderOwner
  readonly focusOwner = new ProjectFocusOwner()
  readonly readers = new Set<ProjectReadDomain>()
  readonly readerProjects = new Map<ProjectReadDomain, string>()
  readonly children = new Set<ProjectSubagentDomain>()
  readonly recordedAside = createSnapshotStore<{ readonly detail: ProjectDetail; readonly binding: ProjectFileBinding } | undefined>(undefined)
  readonly childAsides = createSnapshotStore<readonly ProjectChildAside[]>([])
  readonly selectedChild = createSnapshotStore<string | undefined>(undefined)
  private childNavigation = 0
  private focusContainer: HTMLElement | undefined
  private recordedReturnFocus: AsideReturnFocus | undefined
  private childReturnFocus: Map<string, AsideReturnFocus> | undefined
  private nativePresetPanes: Map<SessionBinding, number> | undefined
  readonly sourceFocus = createSnapshotStore<SourceFocusIntent | undefined>(undefined)
  /** Successful UI intents survive seat remounts; hidden/aborted/failed attempts never consume them. */
  readonly focusedSourceIntents = new WeakSet<SourceFocusIntent>()
  readonly focusedCoordinateIntents = new Set<string>()
  readonly configurationWarnings = createSnapshotStore<readonly string[]>([])
  readonly configurationFailure = createSnapshotStore<string | undefined>(undefined)
  readonly presentedFiles = {
    externalFiles: {
      canOpenWorkspacePath: () => this.options.externalFiles.canOpenWorkspacePath(),
      openWorkspacePath: (request: { readonly path: string }) => this.options.externalFiles.openWorkspacePath(request),
    },
    openFile: (id: import('@deepseek-ai/dsh-session/types').SessionId, path: string, settings?: { readonly line?: number }) => this.openPresentedFile(id, path, settings),
    readFileBytes: (id: import('@deepseek-ai/dsh-session/types').SessionId, path: string, settings: import('@deepseek-ai/dsh-api-workspace-files/types').WorkspaceByteReadOptions, signal?: AbortSignal) => this.options.remote.uiReadFileBytes({ sessionId: id, readonly: true, path, options: settings }, signal),
  }
  readonly changedFileReads = {
    summary: async (id: import('@deepseek-ai/dsh-session/types').SessionId, seq: number, signal?: AbortSignal) => {
      const result = await this.options.remote.uiChangesSummary({ sessionId: id, readonly: true, seq }, signal)
      if (!result.ok) throw result.error
      return result.value === undefined ? undefined : { ...result.value, files: [...result.value.files] }
    },
    diff: async (id: import('@deepseek-ai/dsh-session/types').SessionId, seq: number, index: number, signal?: AbortSignal) => {
      const result = await this.options.remote.uiChangesDiff({ sessionId: id, readonly: true, seq, index }, signal)
      if (!result.ok) throw result.error
      return result.value
    },
  }
  readonly drafts: ProjectDraftRegistry
  readonly failure = createSnapshotStore<string | undefined>(undefined)
  readonly navigationFailure = createSnapshotStore<string | undefined>(undefined)
  readonly submissionFailure = createSnapshotStore<Extract<ProjectInteractionSubmission, { status: 'failed' }> | undefined>(undefined)
  private navigationAttempt = 0
  /** Only an explicit navigation reports here; retained stream diagnostics never become a page notice. */
  private navigate(action: () => Promise<void>): void {
    const attempt = ++this.navigationAttempt
    this.navigationFailure.set(undefined)
    void action().catch(error => {
      console.error('[dsh-projects] navigation failed', error)
      if (attempt === this.navigationAttempt) this.navigationFailure.set(error instanceof Error ? error.message : String(error))
    })
  }
  readonly product: ReturnType<typeof installProjectProductUi>
  private readonly workspaces = createSnapshotStore<WorkspaceSnapshot>({ items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null })
  private readonly sourceBindings = new Map<string, ProjectFileBinding>()
  private readonly details = new Map<string, ProjectDetail>()
  private readonly readerContext = new Context()
  private readonly readSessions: ProjectReadSessions
  private capabilities: ProjectNativeCapabilities | undefined
  private unmount: (() => void) | undefined
  private unmountCapabilities: (() => void) | undefined
  private disposed = false
  private closing: Promise<void> | undefined
  private readonly pendingViewCleanup = new Set<Promise<void>>()

  static async create(options: FullProjectClientDomainOptions): Promise<FullProjectClientDomain> {
    const ctx = new Context()
    let domain: FullProjectClientDomain | undefined
    try {
      domain = new FullProjectClientDomain(options, ctx)
      await domain.initialize()
      return domain
    } catch (error) {
      // Assignment completes only after the constructor returns. A constructor
      // failure is covered by every owner registered on ctx as it is acquired;
      // initialized instances use the same ordered cleanup as normal unload.
      try { if (domain === undefined) await ctx.fiber.dispose(); else await domain.dispose() }
      catch (cleanupError) { console.error('[dsh-projects] full client construction cleanup failed', cleanupError) }
      throw error
    }
  }
  private constructor(readonly options: FullProjectClientDomainOptions, ctx: Context) {
    this.ctx = ctx
    // This is an independent root rather than a child fiber. Own it before
    // acquiring any service that may throw during construction.
    ctx.effect(() => () => this.readerContext.fiber.dispose(), 'Projects independent read context')
    this.remote = new ProjectRemoteShim(options.remote, options.connection, options.host, { full: options.remote, mode: 'live', captureTarget: id => this.captureTarget(id) })
    ctx.effect(() => () => this.remote.dispose(), 'Projects full Remote')
    ctx.provide('remote', this.remote)
    ctx.provide('connection', options.connection)
    const preferences = new ProjectClientPreferences(options.preferences)
    ctx.provide('configForms', preferences)
    ctx.effect(() => () => preferences.dispose(), 'Projects read-only preference bridge')
    ctx.provide('fileUpload', { upload: (...args: Parameters<ProjectRemoteShim['fileUpload']['upload']>) => this.drafts.upload(...args) })
    ctx.provide('uiWorkspace', { openSession: (target: import('@deepseek-ai/dsh-api-session-controller/client').SessionTarget) => this.openNativeSession(target), openWorkspace: async () => { throw new Error('Use the Projects workspace settings') } })
    applyRenderer(ctx)
    installProjectNativeAccess(ctx)
    ctx.slots.provideRoot({ hooks: { workspaces: this.workspaces } })
    const locale = new LocaleRuntime(ctx); locale.register('common', { en, zh }); if (options.language !== undefined) locale.setLocale(options.language)
    ctx.provide('locale', locale); ctx.slots.installLocale(locale)
    this.sessions = new ProjectSessions(ctx, this.remote, { onBinding: binding => this.remote.retainInteractions(binding.sessionId),
      onCarrierInvalidated: (address, permanent) => { if (permanent) this.drafts?.invalidateLogical(address.projectId, address.logicalSessionId); this.fileReader?.invalidate() } })
    this.remote.attachSessions(this.sessions)
    ctx.effect(() => () => this.sessions.dispose(), 'Projects full Sessions')
    ctx.effect(() => this.remote.subscribeFailure(error => this.failure.set(error instanceof Error ? error.message : String(error))), 'Projects interaction failure surface')
    ctx.effect(() => this.remote.subscribeInteractionSubmission(state => {
      if (state.status === 'failed') {
        console.error('[dsh-projects] interaction submission unconfirmed', state.error)
        this.submissionFailure.set(state)
      } else if (state.status === 'submitting' || this.submissionFailure.getSnapshot()?.requestId === state.requestId) this.submissionFailure.set(undefined)
    }), 'Projects current interaction submission result')
    applyUiSession(ctx)
    this.readSessions = new ProjectReadSessions(this.readerContext, options.remote, options.connection, options.host)
    ctx.effect(() => () => this.readSessions.dispose(), 'Projects non-activating panel references')
    this.fileReader = new ProjectFileReaderOwner({ resolveBinding: id => this.sourceBindings.get(id),
      translate: ctx.locale.bind('projects'), subscribeLocale: listener => ctx.locale.subscribe(listener),
      readBytes: async (binding, path, signal) => {
        const result = await options.remote.uiReadFileBytes({ sessionId: SessionId(binding.hostSessionId), readonly: true, path, options: {} }, signal)
        if (!result.ok) throw result.error
        return result.value
      },
      read: async (request, range, signal): Promise<ProjectConversationFilePage> => {
        const result = await options.remote.uiReadFile({ sessionId: SessionId(request.hostSessionId), readonly: true, path: request.path, range: { offset: range?.offset } }, signal)
        if (!result.ok) throw result.error
        return { ...result.value, readAt: new Date().toISOString() }
      }, onReturnFocus: binding => this.focusInput(binding.hostSessionId) })
    ctx.effect(() => () => this.fileReader.dispose(), 'Projects unified FileReader')
    ctx.effect(() => () => this.focusOwner.dispose(), 'Projects exact source focus')
    // File gestures are handled by the exact Chat closure. Plan/child resources get a separate owner below.
    ctx.provide('sidebarRight', { openResource: (address: string, settings?: { params?: { line?: number } }) => { this.navigate(() => this.fileReader.openResource(address, settings)) }, openTab: () => { throw new Error('Projects private tab is not registered') } })
    this.drafts = applyProjectConversation(ctx, { maxConcurrentFileUploads: 2 }, { resolveCarrier: binding => this.sessions.resolveCarrier(binding), isCurrent: address => this.sessions.isCurrent(address),
      upload: (address, body, name, signal, progress) => {
        if (!this.sessions.isCurrent(address)) throw new Error('PROJECT_INPUT_STALE: upload carrier was replaced before dispatch')
        return this.remote.fileUpload.upload(SessionId(address.hostSessionId), body, name, signal, progress)
      } })
    installProjectChat(ctx, { fileReader: this.fileReader, focusOwner: this.focusOwner, allowBranch: false,
      replySessionLinkSource: id => {
        const source = this.sourceBindings.get(id)
        return source?.role === 'main' || source?.role === 'execution' ? { originProjectId: source.projectId, role: source.role } : undefined
      },
      renderCommunicationMessage: props => this.product.renderCommunicationMessage(props) })
    applyTools(ctx); applyAttachments(ctx)
    this.product = installProjectProductUi(ctx, { remote: options.remote, sessions: this.sessions, generation: options.connection.generation,
      files: options.externalFiles, fileReader: this.fileReader, adoptDetail: detail => this.adopt(detail),
      retainPanelSession: (id, info, readOnly) => readOnly ? this.readSessions.retain(id, info) : this.sessions.retain(id, info),
      onLogicalBinding: binding => this.bindLogical(binding),
      onSourceFocus: ({ detail, source, read }) => {
        const target = projectSourceNavigation(detail, source, read)
        const navigation = this.product.actions.hooks.projectNavigation.getSnapshot()
        const coordinate = navigation?.detail.project.id === detail.project.id && target !== undefined
          && target.kind === navigation.target.kind && target.sessionId === navigation.target.sessionId
          && target.focusEventSeq !== undefined && target.focusEventSeq === navigation.target.focusEventSeq
          && target.focusMessageId === navigation.target.focusMessageId
          ? coordinateFocusKey(source.hostSessionId, { id: navigation.id, eventSeq: target.focusEventSeq, messageId: target.focusMessageId }) : undefined
        this.sourceFocus.set({ revision: (this.sourceFocus.getSnapshot()?.revision ?? 0) + 1, detail, source, coordinate })
      },
      beforePermanentDelete: intent => { const detail = this.details.get(intent.request.projectId); if (detail === undefined) return; for (const logical of detail.sessions) if (intent.kind === 'project' || logical.id === intent.request.sessionId) this.drafts.invalidateLogical(detail.project.id, logical.id) },
      sourceInvalidated: () => { this.fileReader.invalidate() },
      renderConversation: (panel, presentation) => this.renderConversation(panel, presentation),
      renderSourceConversation: (detail, source) => this.renderSource(detail, source),
      renderMainModelControl: panel => panel.readOnly ? <ReadModel reference={panel.reference} translate={ctx.locale.bind('projects')} /> : <LiveModel panel={panel} />,
      acquireModelDirectory: reference => ({ ready: reference.ready.then(() => this.ctx.modelDirectories.directoryFor(reference.sessionId)), release: () => {} }),
      focusInput: id => this.focusInput(id), openCommunicationFile: (path, context) => this.openCommunicationFile(path, context),
      resolveCommunicationInvocation: (request, signal) => this.resolveCommunicationInvocation(request, signal),
      subscribeCommunicationChanges: (id, refresh) => this.sessions.binding(SessionId(id))?.eventSource.subscribe(refresh) ?? (() => {}),
      pickWorkspaceDirectory: options.pickWorkspaceDirectory,
      toggleGlobalSidebar: options.toggleGlobalSidebar, revealProjects: options.revealProjects })
    ctx.effect(() => () => this.product.dispose(), 'Projects full product UI')
    ctx.effect(() => this.product.actions.hooks.projectNavigation.subscribe(() => {
      this.navigationAttempt++
      this.navigationFailure.set(undefined)
      this.submissionFailure.set(undefined)
    }), 'Projects navigation notice lifetime')
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'projects-native-preset', order: 9 }, ProjectPresetDock))
    ctx.slots.inject('projects.native.conversation', () => ctx.slots.register({ name: 'projects.native.conversation', locale: 'projects', children: {
      'projects.native.session.actions': { kind: 'list', scope: 'session' }, 'projects.native.preset': { kind: 'single', scope: 'session-maybe' },
    } }, props => <NativePane {...props} domain={this} />))
    installProjectNativePaneSeats(ctx)
    ctx.slots.inject('projects.native.model', () => ctx.slots.register({ name: 'projects.native.model', locale: 'projects', inject: sessionId => ({
      acquireDirectory: () => { const reference = this.sessions.retain(sessionId, { source: 'projectsPanel' }); return {
        ready: reference.ready.then(() => this.ctx.modelDirectories.directoryFor(sessionId)), release: () => reference.release(),
      } }, generation: options.connection.generation,
    }) }, ProjectMainModelControl))
    ctx.slots.register({ name: 'root', locale: 'projects', inject: () => ({ domain: this }), children: { main: { kind: 'keyed', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' },
      'projects.native.conversation': { kind: 'single', scope: 'session' }, 'projects.native.model': { kind: 'single', scope: 'session' } } }, ProductRoot)
    let previous = options.connection.generation.getSnapshot()
    ctx.effect(() => options.connection.generation.subscribe(() => { const next = options.connection.generation.getSnapshot(); if (next === previous) return; previous = next; if (next === undefined) return; ctx.emit('connection/reset'); this.sessions.reconnect(); this.remote.restartInteractions() }), 'Projects full connection')
  }
  private async initialize(): Promise<void> {
    await this.ctx.inject(['conversation'], () => {})
    this.capabilities = await installProjectNativeCapabilities(this.ctx, { mode: 'live', remote: this.remote,
      openResourceFallback: (url, settings) => { this.navigate(() => this.fileReader.openResource(url, settings)) },
      selectedTools: { remote: this.remote, uiWorkspace: { openSession: target => this.openNativeSession(target) }, openSubagentAside: address => { this.navigate(() => this.openSubagentAside(address)) } },
      currentSessionPickers: { permissionPresets: this.remote.permissionPresets, isProjectPaneCurrent: binding => this.isProjectPresetPaneCurrent(binding), agentPresets: { list: () => this.remote.agentPresets.list(), select: (binding, preset) => this.remote.captureAgentPreset(binding)(preset) }, developerTools: this.options.preferences.developerTools },
      presentedFiles: this.presentedFiles,
      changedFiles: { ...this.changedFileReads, openFile: (id, path, settings) => this.openPresentedFile(id, path, settings) } })
    this.sessions.start(); this.remote.start()
    const abort = new AbortController()
    const statuses = this.options.remote.uiWatchConfiguration(abort.signal)
    this.ctx.effect(() => () => { abort.abort(); statuses.dispose() }, 'Projects configuration publication observation')
    void (async () => { try { for await (const status of statuses) {
      if (abort.signal.aborted) return
      this.configurationWarnings.set(status.warnings ?? [])
      this.configurationFailure.set(status.publication?.status === 'failed' ? this.ctx.locale.bind('projects')('p5.configuration.previousConfigurationKept', { error: status.publication.error ?? this.ctx.locale.bind('projects')('p5.configuration.refreshFailed') }) : undefined)
    } } catch (error) { if (!abort.signal.aborted) this.configurationFailure.set(error instanceof Error ? error.message : String(error)) } })()
  }
  private captureTarget(id: import('@deepseek-ai/dsh-session/types').SessionId): ProjectUiTarget {
    const carrier = this.sessions.carrierAddress(id)
    return { sessionId: id, carrier, ...(!this.sessions.isCurrent(carrier) ? { readonly: true } : {}) }
  }
  adopt(detail: ProjectDetail): void {
    this.details.set(detail.project.id, detail); this.sessions.adoptDetail(detail)
    for (const [id, binding] of this.sourceBindings) {
      if (binding.projectId !== detail.project.id) continue
      const aside = this.childAsides.getSnapshot().find(row => row.childSource.hostSessionId === id)
      const root = aside === undefined ? undefined : detail.sessions.find(row => row.id === aside.rootProof.logicalSessionId)
      const availableRoot = aside !== undefined && root?.carriers?.some(carrier => carrier.hostSessionId === aside.rootProof.hostSessionId && carrier.sessionCreatedAt === aside.rootProof.sessionCreatedAt && carrier.sourceKind === 'available')
        && !detail.unavailableSources.some(source => source.hostSessionId === aside.rootProof.hostSessionId)
      if (aside === undefined || !availableRoot || detail.project.sourceLifecycle?.kind === 'deleted') this.sourceBindings.delete(id)
    }
    for (const logical of detail.sessions) for (const carrier of logical.carriers ?? []) {
      if (carrier.sourceKind !== 'available' || carrier.sessionCreatedAt === undefined || detail.unavailableSources.some(row => row.hostSessionId === carrier.hostSessionId)) continue
      const binding: ProjectFileBinding = { projectId: detail.project.id, sessionId: logical.id, hostSessionId: carrier.hostSessionId,
        sessionCreatedAt: carrier.sessionCreatedAt, role: logical.role, sessionTitle: logical.title }
      this.sourceBindings.set(binding.hostSessionId, binding); this.readSessions.adopt(binding, detail.project.workspace?.path)
    }
    this.fileReader.invalidate()
    this.workspaces.set({ items: [{ workspaceId: `projects:${detail.project.id}` as WorkspaceId, path: detail.project.workspace?.path ?? '', title: detail.project.name,
      sessionIds: detail.sessions.map(row => SessionId(row.hostSessionId)), createdAt: detail.project.createdAt, updatedAt: detail.project.updatedAt }], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null })
    for (const reader of this.readers) if (this.readerProjects.get(reader) === detail.project.id) reader.adopt(detail)
  }
  private async bindLogical(binding: ProjectLogicalBinding): Promise<void> {
    await binding.reference.ready
    if (binding.readOnly) return
    this.drafts.bind(this.sessions.carrierAddress(binding.reference.sessionId))
  }
  private renderConversation(panel: ProjectPanelReference, presentation: ProjectConversationPresentation): ReactNode {
    if (!presentation.readOnly) return <LivePane panel={panel} focus={presentation.focus} visible={presentation.visible} projectName={presentation.projectName} />
    const exact = this.sourceBindings.get(panel.session.hostSessionId)
    if (exact === undefined) return <p role="alert">{this.ctx.locale.bind('projects')('p5.reading.originalIdentityUnconfirmed')}</p>
    return <ReaderPane translate={this.ctx.locale.bind('projects')} domain={this} detail={panel.detail} binding={exact} focus={presentation.focus} visible={presentation.visible} />
  }
  private renderSource(detail: ProjectDetail, source: NativeEventSource): ReactNode {
    const exact = this.sourceBindings.get(source.hostSessionId)
    if (exact === undefined || exact.sessionCreatedAt !== source.sessionCreatedAt || exact.projectId !== source.projectId || exact.sessionId !== source.sessionId) return <p role="alert">{this.ctx.locale.bind('projects')('p5.reading.sourceIdentityInvalid')}</p>
    return <ReaderPane translate={this.ctx.locale.bind('projects')} domain={this} detail={detail} binding={exact} source={source} />
  }
  setLocale(language: string): void {
    this.ctx.locale.setLocale(language)
    for (const reader of this.readers) reader.ctx.locale.setLocale(language)
    for (const child of this.children) child.ctx.locale.setLocale(language)
  }
  focusInput(id: string): void { const binding = this.sessions.binding(SessionId(id)); if (binding !== undefined) this.ctx.conversation.input.for(binding.ctx).focus() }
  /** A real visible live pane, independent of the ordinary DSH mainView retain source. */
  retainNativePresetPane(binding: SessionBinding): () => void {
    const panes = this.nativePresetPanes ??= new Map()
    panes.set(binding, (panes.get(binding) ?? 0) + 1)
    let released = false
    return () => { if (released) return; released = true; const count = (panes.get(binding) ?? 0) - 1; if (count <= 0) panes.delete(binding); else panes.set(binding, count) }
  }
  isProjectPresetPaneCurrent(binding: SessionBinding): boolean {
    if (this.disposed || !this.nativePresetPanes?.has(binding) || this.sessions.binding(binding.sessionId) !== binding) return false
    try { return this.sessions.isCurrent(this.sessions.resolveCarrier(binding)) } catch { return false }
  }
  async focusSource(detail: ProjectDetail, source: NativeProjectSource, owner = this.focusOwner, signal?: AbortSignal, nativeBinding?: SessionBinding): Promise<void> {
    const result = await this.options.remote.readSource({ projectId: detail.project.id, source }, signal)
    if (!result.ok) throw result.error
    const binding = this.sourceBindings.get(source.hostSessionId); if (binding === undefined) throw new Error('PROJECT_SOURCE_UNAVAILABLE')
    await painted(signal); await owner.focus({ binding, source, read: result.value, nativeBinding }, signal)
  }
  async focusCoordinate(id: import('@deepseek-ai/dsh-session/types').SessionId, focus: NonNullable<Focus>, signal: AbortSignal, owner = this.focusOwner, captured?: SessionBinding): Promise<void> {
    const binding = captured ?? this.sessions.binding(id)
    if (binding === undefined) throw new Error('PROJECT_SOURCE_SCOPE_ENDED')
    await binding.session.loadThrough(SessionSeq(focus.eventSeq)); signal.throwIfAborted()
    const exact = this.sourceBindings.get(id); const detail = exact === undefined ? undefined : this.details.get(exact.projectId)
    if (exact === undefined || detail === undefined) throw new Error('PROJECT_SOURCE_UNAVAILABLE')
    const event = binding.eventSource.getSnapshot().entries.find(row => row.event.seq === focus.eventSeq)?.event
    if (event === undefined) throw new Error('PROJECT_SOURCE_EVENT_NOT_FOUND')
    const data = record(event.data), message = record(data?.message), messageSource = record(message?.source)
    const messageId = focus.messageId ?? (typeof data?.id === 'string' ? data.id : typeof message?.id === 'string' ? message.id : undefined)
    const callId = typeof data?.callId === 'string' ? data.callId : typeof messageSource?.callId === 'string' ? messageSource.callId : undefined
    const source: NativeProjectSource | undefined = messageId !== undefined ? { kind: 'message', hostSessionId: id, messageId }
      : callId !== undefined ? { kind: 'tool', hostSessionId: id, toolCallId: callId } : undefined
    if (source === undefined) throw new Error('PROJECT_SOURCE_HAS_NO_EXACT_IDENTITY')
    const read = await this.options.remote.readSource({ projectId: detail.project.id, source }, signal)
    if (!read.ok) throw read.error
    if (!read.value.items.some(item => item.isTarget && item.seq === focus.eventSeq && (focus.messageId === undefined || item.messageId === focus.messageId))) throw new Error('PROJECT_SOURCE_COORDINATES_CHANGED')
    await painted(signal); await owner.focus({ binding: exact, source, read: read.value, nativeBinding: binding }, signal)
  }
  async openPresentedFile(id: import('@deepseek-ai/dsh-session/types').SessionId, path: string, settings?: { readonly line?: number }): Promise<void> {
    const binding = this.sourceBindings.get(id); if (binding === undefined) throw new Error('PROJECT_PRESENT_SOURCE_UNAVAILABLE')
    await this.fileReader.openFile(binding, path, settings)
  }
  private async openCommunicationFile(path: string, context: ProjectCommunicationFileContext): Promise<void> {
    const holder = context.record.holder
    const exact = this.sourceBindings.get(holder.hostSessionId)
    if (exact === undefined || exact.sessionCreatedAt !== holder.sessionCreatedAt || exact.projectId !== context.projectId) throw new Error('PROJECT_COMMUNICATION_HOLDER_UNAVAILABLE')
    await this.fileReader.openFile(exact, path)
  }
  private async resolveCommunicationInvocation(query: Parameters<ProjectCommunicationInjected['resolveCommunicationInvocation']>[0], signal: AbortSignal, captured?: SessionBinding): Promise<ReadProjectCommunicationRequest | undefined> {
    signal.throwIfAborted()
    const binding = captured ?? this.sessions.binding(SessionId(query.holderHostSessionId)); if (binding === undefined || binding.sessionId !== query.holderHostSessionId) return undefined
    const entries = binding.eventSource.getSnapshot().entries
    if (query.phase === 'result' && query.eventSeq !== undefined) {
      const event = entries.find(row => row.event.seq === query.eventSeq)?.event
      const data = record(event?.data), message = record(data?.message), source = record(message?.source)
      if (event !== undefined && (data?.callId === query.callId || data?.subCallId === query.callId || source?.callId === query.callId)) return { holderHostSessionId: query.holderHostSessionId, locator: { kind: 'sender-result', resultEventSeq: query.eventSeq, callId: query.callId } }
    }
    const starts = entries.flatMap(row => {
      const event = row.event as { readonly type: string; readonly seq: number; readonly data: unknown }; const data = record(event.data)
      if (data?.name !== 'project_send_message' || query.eventSeq !== undefined && event.seq !== query.eventSeq) return []
      const callId = event.type === 'tool/call' ? data.callId : event.type === 'tool/ptc-dispatch-start' ? data.subCallId : undefined
      if (callId !== query.callId) return []
      return [{ seq: event.seq, rootCallId: event.type === 'tool/call' ? callId : data.rootCallId }]
    })
    if (starts.length !== 1 || typeof starts[0]?.rootCallId !== 'string') return undefined
    const address = this.sourceBindings.get(binding.sessionId); if (address === undefined) return undefined
    return { holderHostSessionId: query.holderHostSessionId, locator: { kind: 'sender', startEventSeq: starts[0].seq, callId: query.callId, rootCallId: starts[0].rootCallId,
      invocationSource: { sessionId: binding.sessionId, sessionCreatedAt: address.sessionCreatedAt, startEventSeq: SessionSeq(starts[0].seq), callId: ToolCallId(query.callId), rootCallId: ToolCallId(starts[0].rootCallId) } } }
  }
  /** Historical cards own their actual native binding; no live lookup is used as a substitute. */
  installReadToolViews(ctx: Context, binding: SessionBinding): void {
    const stop = installProjectProductToolViews(ctx, { ...this.product.communicationPorts,
      resolveCommunicationInvocation: (query, signal) => this.resolveCommunicationInvocation(query, signal, binding),
      subscribeCommunicationChanges: (id, refresh) => id === binding.sessionId ? binding.eventSource.subscribe(refresh) : () => {},
    })
    ctx.effect(() => stop, 'Projects source-owned business tool cards')
  }
  readOnlyToolViews(): ProjectNativeToolCapabilityPorts {
    return { remote: {
      skills: { list: (request, signal) => this.options.remote.uiSkills(request, signal) },
      job: { list: (request, signal) => this.options.remote.uiJobList(request, signal), follow: (request, signal) => this.options.remote.uiJobFollow(request, signal),
        kill: async () => { throw new Error('PROJECT_READ_ONLY: recorded job controls cannot mutate') } },
    }, uiWorkspace: { openSession: target => { this.navigate(() => this.openNativeSession(target)) } },
      openSubagentAside: address => { this.navigate(() => this.openSubagentAside(address)) } }
  }
  private asideRootCurrent(root: CarrierAddress, wasCurrent: boolean): boolean {
    try { return sameCarrier(this.sessions.carrierAddress(SessionId(root.hostSessionId)), root) && (!wasCurrent || this.sessions.isCurrent(root)) }
    catch { return false }
  }
  /** Capture before hiding an old Aside or awaiting a catalog; the native content marks its exact Session. */
  private captureAsideReturnFocus(fallback?: CarrierAddress): AsideReturnFocus {
    const container = this.focusContainer
    const active = container?.ownerDocument.activeElement
    const opener = active !== undefined && active instanceof HTMLElement && container?.contains(active) ? active : undefined
    const source = opener?.closest('[data-conversation-session], [data-project-native-actions]')
    const sourceId = source?.getAttribute('data-conversation-session') ?? source?.getAttribute('data-project-native-actions')
    const parent = sourceId === undefined ? undefined : this.childAsides.getSnapshot().find(row => row.address.childSessionId === sourceId)
    let root = parent === undefined ? undefined : this.childReturnFocus?.get(parent.key)?.root ?? parent.rootProof
    if (opener?.closest('.projects-ui__stock-aside--recorded') != null) root = this.recordedReturnFocus?.root
    if (root === undefined) {
      const id = sourceId ?? this.ctx?.uiSession?.adapter.current.getSnapshot().key
      if (typeof id === 'string') { try { root = this.sessions.carrierAddress(SessionId(id)) } catch { /* A read-only source has no live root input. */ } }
    }
    // A known-but-unresolvable native source cannot borrow the target's unrelated composer.
    if (sourceId == null) root ??= fallback
    return { opener, root: root === undefined ? undefined : Object.freeze({ ...root }), rootWasCurrent: root === undefined ? false : this.sessions.isCurrent(root) }
  }
  private returnAsideFocus(origin: AsideReturnFocus | undefined, navigation: number): void {
    if (origin === undefined) return
    queueMicrotask(() => {
      const container = this.focusContainer
      if (this.disposed || navigation !== this.childNavigation || container === undefined
        || origin.root !== undefined && !this.asideRootCurrent(origin.root, origin.rootWasCurrent)) return
      if (origin.opener !== undefined && usableAsideFocus(origin.opener, container)) { origin.opener.focus({ preventScroll: true }); return }
      const root = origin.root
      if (root === undefined || !this.sessions.isCurrent(root)) return
      // Only a visible composer in the captured exact native root may receive the public input focus verb.
      const seat = [...container.querySelectorAll<HTMLElement>('[data-conversation-session]')].find(element => element.getAttribute('data-conversation-session') === root.hostSessionId && usableAsideFocus(element, container))
      const composer = seat?.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]')
      if (composer !== undefined && composer !== null && usableAsideFocus(composer, container)) this.focusInput(root.hostSessionId)
    })
  }
  closeRecordedAside(expected = this.recordedAside.getSnapshot()): void {
    if (this.disposed || expected === undefined || this.recordedAside.getSnapshot() !== expected) return
    const origin = this.recordedReturnFocus
    this.recordedReturnFocus = undefined
    this.recordedAside.set(undefined)
    this.returnAsideFocus(origin, ++this.childNavigation)
  }
  closeSubagentAside(key: string): void {
    if (this.disposed || this.selectedChild.getSnapshot() !== key) return
    const origin = this.childReturnFocus?.get(key)
    this.childReturnFocus?.delete(key)
    this.selectedChild.set(undefined)
    this.returnAsideFocus(origin, ++this.childNavigation)
  }
  async openNativeSession(target: import('@deepseek-ai/dsh-api-session-controller/client').SessionTarget): Promise<void> {
    if (typeof target !== 'string') { await this.openSubagentAside(target); return }
    if (this.disposed) throw new Error('PROJECT_CLIENT_DISPOSED')
    const origin = this.captureAsideReturnFocus()
    ++this.childNavigation
    const exact = this.sourceBindings.get(target)
    if (exact === undefined) throw new Error('PROJECT_SESSION_TARGET_UNAVAILABLE')
    const detail = this.details.get(exact.projectId)
    const logical = detail?.sessions.find(row => row.id === exact.sessionId)
    if (detail === undefined || logical === undefined) throw new Error('PROJECT_SESSION_OWNER_UNAVAILABLE')
    if (logical.hostSessionId !== exact.hostSessionId) {
      this.recordedReturnFocus = origin
      this.selectedChild.set(undefined)
      this.recordedAside.set({ detail, binding: exact })
      return
    }
    await this.product.actions.openTarget(exact.projectId, { kind: exact.role ?? 'execution', sessionId: exact.sessionId },
      { hostSessionId: exact.hostSessionId, sessionCreatedAt: exact.sessionCreatedAt })
  }
  async openSubagentAside(address: SubagentAddress): Promise<void> {
    if (this.disposed) throw new Error('PROJECT_CLIENT_DISPOSED')
    address = Object.freeze({ ...address })
    if (!address.parentSessionId || !address.childSessionId || address.parentSessionId === address.childSessionId
      || !['one-shot', 'continuable', 'unknown'].includes(address.mode)) throw new Error('PROJECT_SUBAGENT_IDENTITY_INVALID')
    const navigation = ++this.childNavigation
    // A native root catalog can expand an unopened child. Its captured projection
    // path locates a candidate root; the recursive Host catalog must still prove every edge.
    const parentAside = this.childAsides.getSnapshot().find(row => row.address.childSessionId === address.parentSessionId)
    const hints: ProjectUiSubagentInfo[] = []
    const unchangedCatalogs: Array<() => boolean> = []
    const rootProof = (() => {
      if (parentAside !== undefined) return parentAside.rootProof
      try { return this.sessions.carrierAddress(address.parentSessionId) } catch { /* An unopened direct parent is not a Project carrier. */ }
      const snapshots = this.sessions.list.getSnapshot().projectionsBySession
      const hint = (parentId: SessionId, childId: SessionId, mode?: SubagentAddress['mode']): ProjectUiSubagentInfo => {
        const catalog = snapshots[parentId]?.values.subagentCatalog
        const entries = catalog?.filter(row => row.id === childId) ?? []
        const row = entries[0]
        if (entries.length !== 1 || row === undefined || !Number.isFinite(row.createdAt)
          || !['one-shot', 'continuable', 'unknown'].includes(row.mode) || mode !== undefined && row.mode !== mode) throw new Error('PROJECT_SUBAGENT_ANCESTRY_UNCONFIRMED')
        unchangedCatalogs.push(() => this.sessions.list.getSnapshot().projectionsBySession[parentId]?.values.subagentCatalog === catalog)
        const proof = { address: { parentSessionId: parentId, childSessionId: childId, mode: row.mode as SubagentAddress['mode'] }, sessionCreatedAt: row.createdAt }
        hints.push(proof); return proof
      }
      hint(address.parentSessionId, address.childSessionId, address.mode)
      const seen = new Set<string>([address.childSessionId])
      let cursor = address.parentSessionId
      for (;;) {
        if (seen.has(cursor)) throw new Error('PROJECT_SUBAGENT_ANCESTRY_CYCLIC')
        seen.add(cursor)
        try { return this.sessions.carrierAddress(cursor) } catch { /* Continue only through a unique captured native catalog edge. */ }
        const parents = Object.entries(snapshots).flatMap(([parentId, snapshot]) =>
          (snapshot.values.subagentCatalog ?? []).filter(row => row.id === cursor).map(() => SessionId(parentId)))
        if (parents.length !== 1) throw new Error('PROJECT_SUBAGENT_ANCESTRY_UNCONFIRMED')
        cursor = hint(parents[0]!, cursor).address.parentSessionId
      }
    })()
    const rootWasCurrent = this.sessions.isCurrent(rootProof)
    const origin = this.captureAsideReturnFocus(rootProof)
    this.recordedReturnFocus = undefined
    this.recordedAside.set(undefined)
    const detail = this.details.get(rootProof.projectId)
    if (detail === undefined) throw new Error('PROJECT_SUBAGENT_OWNER_UNAVAILABLE')
    const rootBinding = hints.length === 0 ? undefined : this.sessions.binding(SessionId(rootProof.hostSessionId))
    const rootWasVisible = rootBinding !== undefined && this.nativePresetPanes?.has(rootBinding) === true
    const sourceNavigation = hints.length === 0 ? undefined : this.product.actions.hooks.projectNavigation
    const sourceSelection = sourceNavigation?.getSnapshot()
    const assertHintSource = () => {
      if (hints.length === 0) return
      const current = this.details.get(rootProof.projectId)
      const logical = current?.sessions.find(row => row.id === rootProof.logicalSessionId)
      const available = logical?.carriers?.some(row => row.hostSessionId === rootProof.hostSessionId && row.sessionCreatedAt === rootProof.sessionCreatedAt
        && row.sequence === rootProof.carrierEpoch && row.sourceKind === 'available')
      if (!available || current?.project.sourceLifecycle?.kind === 'deleted' || current?.unavailableSources.some(row => row.hostSessionId === rootProof.hostSessionId)
        || !this.asideRootCurrent(rootProof, rootWasCurrent) || unchangedCatalogs.some(check => !check())
        || sourceNavigation?.getSnapshot() !== sourceSelection
        || rootWasVisible && (this.sessions.binding(SessionId(rootProof.hostSessionId)) !== rootBinding || !this.nativePresetPanes?.has(rootBinding!))) throw new Error('PROJECT_SUBAGENT_SOURCE_CHANGED')
    }
    assertHintSource()
    const key = JSON.stringify([address.parentSessionId, address.childSessionId, address.mode, rootProof.hostSessionId, rootProof.sessionCreatedAt, rootProof.carrierEpoch])
    const existing = this.childAsides.getSnapshot().find(row => row.key === key)
    if (existing !== undefined && hints.length === 0) { (this.childReturnFocus ??= new Map()).set(key, origin); this.selectedChild.set(key); return }
    const catalog = await this.options.remote.uiSubagentCatalog({ sessionId: SessionId(rootProof.hostSessionId), readonly: true })
    if (!catalog.ok) throw catalog.error
    assertHintSource()
    const info = catalog.value.find(row => sameSubagentAddress(row.address, address))
    if (info === undefined) throw new Error('PROJECT_SUBAGENT_ADDRESS_NOT_CONFIRMED')
    let cursor = address.childSessionId
    const ancestors = new Set<string>()
    while (cursor !== rootProof.hostSessionId) {
      if (ancestors.has(cursor)) throw new Error('PROJECT_SUBAGENT_ANCESTRY_CYCLIC')
      ancestors.add(cursor)
      const rows = catalog.value.filter(row => row.address.childSessionId === cursor)
      const edge = rows[0], expected = hints.find(row => row.address.childSessionId === cursor)
      if (rows.length !== 1 || edge === undefined || !Number.isFinite(edge.sessionCreatedAt)
        || expected !== undefined && (!sameSubagentAddress(edge.address, expected.address) || edge.sessionCreatedAt !== expected.sessionCreatedAt)) throw new Error('PROJECT_SUBAGENT_ANCESTRY_UNCONFIRMED')
      cursor = edge.address.parentSessionId
    }
    const carrier = await this.options.remote.uiCarrierAddress({ sessionId: address.childSessionId, readonly: true })
    if (!carrier.ok) throw carrier.error
    assertHintSource()
    if (carrier.value.hostSessionId !== address.childSessionId || carrier.value.projectId !== rootProof.projectId
      || carrier.value.logicalSessionId !== rootProof.logicalSessionId || carrier.value.sessionCreatedAt !== info.sessionCreatedAt
      || carrier.value.carrierEpoch !== rootProof.carrierEpoch || existing !== undefined && existing.childSource.sessionCreatedAt !== info.sessionCreatedAt) throw new Error('PROJECT_SUBAGENT_OWNER_CHANGED')
    if (this.disposed) throw new Error('PROJECT_CLIENT_DISPOSED')
    if (!this.asideRootCurrent(rootProof, rootWasCurrent)
      || origin.root !== undefined && !this.asideRootCurrent(origin.root, origin.rootWasCurrent)) return
    // Another navigation may have committed this same exact child during the reads.
    if (this.childAsides.getSnapshot().some(row => row.key === key)) {
      if (navigation === this.childNavigation) { (this.childReturnFocus ??= new Map()).set(key, origin); this.selectedChild.set(key) }
      return
    }
    const rootSource = this.sourceBindings.get(rootProof.hostSessionId)
    const childSource: ProjectFileBinding = { projectId: rootProof.projectId, sessionId: rootProof.logicalSessionId,
      hostSessionId: address.childSessionId, sessionCreatedAt: info.sessionCreatedAt, role: rootSource?.role, sessionTitle: address.childSessionId }
    this.sourceBindings.set(childSource.hostSessionId, childSource)
    const entry = { key, address: Object.freeze({ ...address }), rootProof: Object.freeze({ ...rootProof }), childSource, detail }
    this.childAsides.set([...this.childAsides.getSnapshot(), entry])
    if (navigation === this.childNavigation) { (this.childReturnFocus ??= new Map()).set(key, origin); this.selectedChild.set(key) }
  }
  async mount(container: HTMLElement): Promise<() => void> {
    if (this.disposed || this.unmount !== undefined) throw new Error('Projects full client cannot mount')
    this.focusContainer = container
    this.unmount = this.ctx.uiRenderer.mount(container)
    try { this.unmountCapabilities = this.capabilities?.mount(container) } catch (error) { this.unmount(); this.unmount = undefined; this.focusContainer = undefined; throw error }
    const stop = () => { ++this.childNavigation; this.focusContainer = undefined; this.recordedReturnFocus = undefined; this.childReturnFocus?.clear(); this.nativePresetPanes?.clear(); this.unmountCapabilities?.(); this.unmountCapabilities = undefined; this.unmount?.(); this.unmount = undefined }
    return stop
  }
  /** React cleanup may defer native unmount out of a parent commit; the Domain still owns its promise. */
  retireView(view: ProjectReadDomain | ProjectSubagentDomain, unmount?: () => void): void {
    const cleanup = Promise.resolve().then(async () => {
      try { unmount?.() } finally { await view.dispose() }
    }).finally(() => {
      this.readers.delete(view as ProjectReadDomain); this.children.delete(view as ProjectSubagentDomain)
      this.readerProjects.delete(view as ProjectReadDomain); this.pendingViewCleanup.delete(cleanup)
    })
    this.pendingViewCleanup.add(cleanup)
    void cleanup.catch(error => { console.error('[dsh-projects] native view cleanup failed', error) })
  }
  dispose(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.disposed = true
    ++this.childNavigation
    this.focusContainer = undefined; this.recordedReturnFocus = undefined; this.childReturnFocus?.clear(); this.nativePresetPanes?.clear()
    return this.closing = this.closeOwned()
  }
  private async closeOwned(): Promise<void> {
    const failures: unknown[] = []
    const close = async (operation: () => void | Promise<void>) => { try { await operation() } catch (error) { failures.push(error) } }
    await close(() => { this.unmountCapabilities?.(); this.unmount?.(); this.unmountCapabilities = undefined; this.unmount = undefined })
    const retired = await Promise.allSettled([...this.readers].map(reader => reader.dispose()).concat([...this.children].map(child => child.dispose()), [...this.pendingViewCleanup]))
    for (const result of retired) if (result.status === 'rejected') failures.push(result.reason)
    this.readers.clear(); this.children.clear(); this.readerProjects.clear()
    // Native Provider scopes must retire while dictionaries and adapters still exist.
    // Cordis root effects otherwise dispose concurrently and locale refresh can see
    // a removed Session before its tracked Input binding cleanup has settled.
    await close(() => this.product.controller.dispose())
    await close(() => this.drafts.dispose())
    await close(() => this.sessions.dispose())
    await close(() => this.readSessions.dispose())
    await close(() => this.readerContext.fiber.dispose())
    await close(() => this.product.dispose())
    await close(() => this.remote.dispose())
    await close(() => this.ctx.fiber.dispose())
    if (failures.length > 0) throw new AggregateError(failures, 'Projects full client cleanup failed')
  }
}
