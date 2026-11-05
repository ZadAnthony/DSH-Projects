/** Normal stock-plugin client entry. Root only owns navigation and the Projects DOM mount. */
import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { IconProjectAddOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { acquireProjectsLocale, acquireUiStyles, createWorkspaceDirectoryFlow, ErrorState, LoadingState, WorkspaceDirectoryFlow, WORKSPACE_DIRECTORY_FLOW_SLOT, type ProjectsTranslate, type WorkspaceDirectoryFlowPort } from '../../client/ui/index.ts'
import projectsRemote from '../../../lib/typert.remote-client.js'
import { FullProjectClientDomain, type FullProjectProductRemote } from './full-domain.tsx'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

export { FullProjectClientDomain } from './full-domain.tsx'
export { ProjectRemoteShim } from './remote-shim.ts'
export type { ProjectClientRemotePort, ProjectClientControlFrame } from './remote-shim.ts'
export { ProjectSessions } from './sessions.ts'

const PANEL = 'projects' as MainPanelId

/** Root owns only a DOM mount; the complete product is rendered by the private Context. */
function ProjectsDomainRoot({ domain, translate }: { readonly domain: FullProjectClientDomain; readonly translate: ProjectsTranslate }) {
  const container = useRef<HTMLDivElement>(null)
  const [mountFailure, setMountFailure] = useState<{ readonly owner: FullProjectClientDomain; readonly message: string }>()
  const failure = mountFailure?.owner === domain ? mountFailure.message : undefined
  const configurationWarnings = useSyncExternalStore(domain.configurationWarnings.subscribe, domain.configurationWarnings.getSnapshot)
  const configurationFailure = useSyncExternalStore(domain.configurationFailure.subscribe, domain.configurationFailure.getSnapshot)
  const remoteFailure = useSyncExternalStore(domain.failure.subscribe, domain.failure.getSnapshot)
  const controlFailure = useSyncExternalStore(domain.sessions.controlError.subscribe, domain.sessions.controlError.getSnapshot)
  useEffect(() => { if (remoteFailure !== undefined) console.error('[dsh-projects] interaction failed', remoteFailure) }, [remoteFailure])
  useEffect(() => { if (controlFailure !== undefined) console.error('[dsh-projects] session status updates failed', controlFailure) }, [controlFailure])
  useEffect(() => { if (configurationFailure !== undefined) console.error('[dsh-projects] configuration update failed', configurationFailure) }, [configurationFailure])
  useEffect(() => { if (configurationWarnings.length > 0) console.warn('[dsh-projects] configuration notices', configurationWarnings) }, [configurationWarnings])
  useEffect(() => {
    let live = true
    let unmount: (() => void) | undefined
    queueMicrotask(() => {
      if (!live || container.current === null) return
      void domain.mount(container.current).then(dispose => { if (live) unmount = dispose; else queueMicrotask(dispose) }, error => { if (live) setMountFailure({ owner: domain, message: error instanceof Error ? error.message : String(error) }) })
    })
    return () => { live = false; queueMicrotask(() => { unmount?.() }) }
  }, [domain])
  return <section aria-label="Projects" style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
    {failure !== undefined && <ErrorState inline title={translate('wholeRead.ready.viewFailure')} description={translate('wholeRead.ready.viewRecovery')} diagnostic={{ label: translate('wholeRead.ready.viewFailure'), content: failure }} />}
    <div ref={container} data-projects-native-client="" style={{ flex: 1, minHeight: 0 }} />
  </section>
}

function ProjectsIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconProjectAddOutlineRegular size={size} />
}

export const inject = ['remote', 'connection', 'slots', 'locale', 'layout']

type OwnedDisposer = (() => void | Promise<void>) | undefined

/** Always try every acquired owner; one teardown failure cannot hide later cleanup. */
async function disposeOwned(owners: readonly OwnedDisposer[]): Promise<void> {
  const failures: unknown[] = []
  for (const dispose of owners) {
    if (dispose === undefined) continue
    try { await dispose() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Projects client cleanup failed')
}

type InitializationSnapshot =
  | { readonly phase: 'idle' | 'loading' }
  | { readonly phase: 'ready'; readonly domain: FullProjectClientDomain }
  | { readonly phase: 'failed'; readonly message: string }

/** 根入口与私域初始化分别结算；面板切换不改变已创建Domain的所有权。 */
class ProjectClientInitialization {
  private snapshot: InitializationSnapshot = { phase: 'idle' }
  private readonly listeners = new Set<() => void>()
  private initialization: Promise<void> | undefined
  private ui: import('@deepseek-ai/cordis').Fiber | undefined
  private disposeRemote: OwnedDisposer
  private releaseTask: Promise<void> | undefined
  private closing: Promise<void> | undefined
  private disposed = false

  constructor(private readonly ctx: Context, readonly directoryFlow: WorkspaceDirectoryFlowPort) {}
  readonly getSnapshot = (): InitializationSnapshot => this.snapshot
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(snapshot: InitializationSnapshot): void {
    if (this.disposed) return
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
  start(): void {
    if (this.disposed || this.initialization !== undefined) return
    this.publish({ phase: 'loading' })
    this.initialization = this.initialize().catch(async error => {
      try { await this.release() }
      catch (cleanupError) { console.error('[dsh-projects] failed client-initialization cleanup', cleanupError) }
      if (this.disposed) return
      console.error('[dsh-projects] client initialization failed', error)
      this.publish({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
    })
  }
  private async initialize(): Promise<void> {
    this.disposeRemote = await this.ctx.remote.$mount(projectsRemote)
    if (this.disposed) return
    let failure: unknown
    let initialized = false
    // $mount先拥有namespace，再由子fiber声明读取权限；根entry不等待这个fiber。
    this.ui = this.ctx.inject([...inject, 'remote.projects', 'remote.session', 'configForms'], async scope => {
      if (this.disposed) return
      let domain: FullProjectClientDomain | undefined
      const observers: (() => void)[] = []
      let cleanup: Promise<void> | undefined
      const close = (): Promise<void> => cleanup ??= disposeOwned([...observers].reverse().concat([() => domain?.dispose()]))
      try {
        const remote = scope.remote.projects as unknown as FullProjectProductRemote
        const connection = scope.get('connection') as ConnectionHandle
        domain = await FullProjectClientDomain.create({ remote, connection, host: scope.remote.$host, language: scope.locale.getSnapshot().active,
          preferences: { developerTools: scope.configForms.developerTools.enabled, get: namespace => {
            const form = scope.configForms.get(namespace)
            return { getSnapshot: () => form.getSnapshot(), subscribe: listener => form.subscribe(listener) }
          } },
          externalFiles: { canOpenWorkspacePath: () => scope.remote.session.canOpenWorkspacePath(), openWorkspacePath: request => scope.remote.session.openWorkspacePath(request) },
          pickWorkspaceDirectory: this.directoryFlow.pick,
          toggleGlobalSidebar: () => scope.layout.toggleSidebar(), revealProjects: () => scope.layout.selectPanel(PANEL) })
        if (this.disposed) { await close(); return }
        const current = domain
        observers.push(scope.remote.$on('plugin-manager/changed', (...args) => { current.remote.hostNotifications.publishPluginManagerChanged(...args) }))
        observers.push(scope.remote.$on('settings/document-updated', (...args) => { current.remote.observeRefresh({ type: 'refresh', event: 'settings/document-updated', args }) }))
        observers.push(scope.remote.$on('credentials/record-updated', (...args) => { current.remote.observeRefresh({ type: 'refresh', event: 'credentials/record-updated', args }) }))
        observers.push(scope.remote.$on('credentials/reference-updated', (...args) => { current.remote.observeRefresh({ type: 'refresh', event: 'credentials/reference-updated', args }) }))
        observers.push(scope.remote.$on('llm/adapters-updated', (...args) => { current.remote.observeRefresh({ type: 'refresh', event: 'llm/adapters-updated', args }) }))
        observers.push(scope.locale.subscribe(() => { current.setLocale(scope.locale.getSnapshot().active) }))
        current.setLocale(scope.locale.getSnapshot().active)
        initialized = true
        this.publish({ phase: 'ready', domain: current })
        return close
      } catch (error) {
        failure = error
        try { await close() }
        catch (cleanupError) { console.error('[dsh-projects] failed client-domain cleanup', cleanupError) }
      }
    })
    await this.ui
    if (failure !== undefined) throw failure
    if (!this.disposed && !initialized) throw new Error('Projects initialization dependencies are unavailable')
  }
  private release(): Promise<void> {
    return this.releaseTask ??= disposeOwned([() => this.ui?.dispose(), this.disposeRemote])
  }
  dispose(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.disposed = true
    return this.closing = (async () => {
      await this.initialization
      await this.release()
      this.listeners.clear()
    })()
  }
}

function ProjectsRoot({ initialization, renderSlot, translate }: { readonly initialization: ProjectClientInitialization; readonly translate: ProjectsTranslate } & PropsRenderSlots<typeof WORKSPACE_DIRECTORY_FLOW_SLOT>) {
  const snapshot = useSyncExternalStore(initialization.subscribe, initialization.getSnapshot)
  useEffect(() => { initialization.start() }, [initialization])
  return <>{snapshot.phase === 'ready' ? <ProjectsDomainRoot domain={snapshot.domain} translate={translate} /> : <section className="dsh-projects" aria-label={translate('list.title')} style={{ height: '100%', minHeight: 0 }}>
    {snapshot.phase === 'failed' ? <ErrorState title={translate('wholeRead.initialization.failed')} description={translate('wholeRead.initialization.recovery')} diagnostic={{ label: translate('wholeRead.initialization.failed'), content: snapshot.message }} /> : <LoadingState label={translate('wholeRead.initialization.loading')} rows={3} />}
  </section>}<WorkspaceDirectoryFlow flow={initialization.directoryFlow} renderSlot={renderSlot} /></>
}

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const directoryFlow = createWorkspaceDirectoryFlow(ctx)
  const initialization = new ProjectClientInitialization(ctx, directoryFlow)
  let disposePanel: OwnedDisposer
  let disposeSidebar: OwnedDisposer
  let disposeLocale: OwnedDisposer
  let releaseStyles: OwnedDisposer
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing
    // 先关初始化owner，再等待槽位卸载；初始化途中得到的资源也必须归还。
    const product = initialization.dispose()
    return closing = disposeOwned([() => directoryFlow.dispose(), disposeSidebar, disposePanel, () => product, releaseStyles, disposeLocale])
  }
  try {
    disposeLocale = acquireProjectsLocale(ctx.locale)
    releaseStyles = acquireUiStyles(document)
    disposePanel = ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL, locale: 'projects',
      children: { [WORKSPACE_DIRECTORY_FLOW_SLOT]: { kind: 'single', scope: 'root' } },
    }, (props: PropsRuntime<'main'> & PropsLocale<'projects'> & PropsRenderSlots<typeof WORKSPACE_DIRECTORY_FLOW_SLOT>) => <ProjectsRoot {...props} translate={props.t} initialization={initialization} />))
    disposeSidebar = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 5, label: 'Projects' }, ProjectsIcon))
    return close
  } catch (error) {
    try { await close() }
    catch (cleanupError) { console.error('[dsh-projects] failed client-entry cleanup', cleanupError) }
    throw error
  }
}
