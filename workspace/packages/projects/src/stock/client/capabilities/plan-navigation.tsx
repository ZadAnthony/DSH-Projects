/** Plan-only navigation owner. Its history/resource provider is installed by stock ui-plan. */
import { useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { acquireUiStyles, ErrorState, IconAction, IconCloseOutlineRegular, LoadingState, MarkdownText, Tooltip } from '../../../client/ui/index.ts'
import type { ProjectsTranslate } from '../../../client/ui/copy.ts'
import type { SidebarRightTabDefinition, SidebarRightOpenResourceOptions } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ProjectPlanNavigationPort } from './contracts.ts'
import type { ProjectNativeToolCapabilityPorts } from './contracts.ts'
import { parseProjectSubagentChatAddress } from './subagent-address.ts'

interface PlanDocument { readonly title: string; readonly markdown: string }
interface PlanView {
  readonly address: string
  readonly title: string
  readonly sessionId: SessionId
  readonly resource: ResourceSnapshot<PlanDocument>
}

export function projectPlanSourceSession(address: string): SessionId | undefined {
  const match = /^dsh-resource:\/\/(plan|plan-review)\/([^?#]+)$/.exec(address)
  if (match === null) return undefined
  try {
    const parts = match[2]!.split('/').map(decodeURIComponent)
    if (parts.some(part => part === '')) return undefined
    if (parts.length === 2) return parts[0] as SessionId
    if (match[1] === 'plan' && parts.length === 5 && parts[0] === 'subagent'
      && (parts[3] === 'one-shot' || parts[3] === 'continuable' || parts[3] === 'unknown')) return parts[2] as SessionId
  } catch { /* invalid URI is rejected before any resource read */ }
  return undefined
}

/** A real private registration table, resource subscription, DOM mount and cancel owner. */
export class ProjectPlanNavigation implements ProjectPlanNavigationPort {
  readonly mounted = createSnapshotStore<SessionId | undefined>(undefined)
  readonly view = createSnapshotStore<PlanView | undefined>(undefined)
  readonly sidebarRight = { mounted: this.mounted,
    openResource: (address: string, options?: SidebarRightOpenResourceOptions) => this.openResource(address, options) }
  readonly sidebarRightTabs = { register: (definition: SidebarRightTabDefinition) => this.register(definition) }
  private readonly types = new Map<string, SidebarRightTabDefinition>()
  private lifetime: AbortController | undefined
  private unsubscribe: (() => void) | undefined
  private releaseSession: (() => void) | undefined
  private previousFocus: HTMLElement | undefined
  private reactRoot: Root | undefined
  private element: HTMLElement | undefined
  private container: HTMLElement | undefined
  private stopSelection: (() => void) | undefined
  private releaseStyles: (() => void) | undefined
  readonly locale: Context['locale']
  readonly translate: ProjectsTranslate
  readonly subscribeLocale = (listener: () => void) => this.locale.subscribe(listener)
  readonly readLocale = () => this.locale.getSnapshot()

  constructor(private readonly ctx: Context, private readonly fallback?: Context['sidebarRight']['openResource'], private readonly openSubagentAside?: ProjectNativeToolCapabilityPorts['openSubagentAside']) {
    this.locale = ctx.locale
    this.translate = ctx.locale.bind('projects')
    ctx.effect(() => () => this.dispose(), 'Projects Plan navigation')
  }

  private register(definition: SidebarRightTabDefinition): () => void {
    if (this.types.has(definition.id)) throw new Error(`Duplicate Projects Plan tab type: ${definition.id}`)
    this.types.set(definition.id, definition)
    return () => {
      if (this.types.get(definition.id) !== definition) return
      this.types.delete(definition.id)
      const current = this.view.getSnapshot()
      if (current !== undefined && definition.canOpen?.(current.address) === true) this.close()
    }
  }

  openResource(address: string, options?: SidebarRightOpenResourceOptions): void {
    if (!/^dsh-resource:\/\/plan(?:-review)?\//.test(address)) {
      if (address.startsWith('dsh-resource://subagentchat/')) {
        const target = parseProjectSubagentChatAddress(address)
        if (target === undefined) throw new Error('Invalid native subagent resource address')
        if (this.openSubagentAside === undefined) throw new Error('Projects subagent ReaderDomain is not connected')
        this.openSubagentAside(target)
        return
      }
      if (this.fallback === undefined) throw new Error('Projects FileReaderOwner is not connected')
      this.fallback(address, options)
      return
    }
    const sessionId = projectPlanSourceSession(address)
    const definition = [...this.types.values()].find(row => row.kind === 'plan' && row.canOpen?.(address) === true)
    if (definition === undefined || sessionId === undefined) throw new Error('Invalid or unavailable Projects Plan address')
    if (this.ctx.sessions.list.getSnapshot().byId[sessionId] === undefined) throw new Error('Plan source is not a Project carrier')
    this.close(false)
    this.previousFocus = this.container?.ownerDocument.activeElement instanceof HTMLElement ? this.container.ownerDocument.activeElement : undefined
    const lifetime = new AbortController()
    this.lifetime = lifetime
    // Retain the exact native generation for the read; neither current selection nor carrier changes retarget it.
    const reference = this.ctx.sessions.retain(sessionId, { source: 'controllerOperation', signal: lifetime.signal })
    this.releaseSession = () => reference.release()
    const temporary = address.startsWith('dsh-resource://plan-review/')
    if (temporary) {
      const params: unknown = options?.params
      const candidate = typeof params === 'object' && params !== null && 'planReview' in params ? params.planReview : undefined
      const document = typeof candidate === 'object' && candidate !== null && 'title' in candidate && typeof candidate.title === 'string' && 'markdown' in candidate && typeof candidate.markdown === 'string'
        ? { title: candidate.title, markdown: candidate.markdown } : undefined
      this.view.set({ address, title: definition.title(address), sessionId, resource: document === undefined
        ? { status: 'failed', value: undefined, failure: new RemoteError('gateway/internal', this.translate('whole.stock.plan.reviewUnavailable'), {}) }
        : { status: 'live', value: document, failure: undefined } })
      return
    }
    const source = this.ctx.resources.source(address)
    const update = () => {
      if (this.lifetime !== lifetime) return
      this.view.set({ address, title: definition.title(address), sessionId, resource: source.getSnapshot() as ResourceSnapshot<PlanDocument> })
    }
    // source.subscribe opens the real stock Plan provider, whose only Remote dependencies are follow/page.
    this.unsubscribe = source.subscribe(update)
    update()
  }

  close(restoreFocus = true): void {
    this.lifetime?.abort()
    this.lifetime = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.releaseSession?.()
    this.releaseSession = undefined
    this.view.set(undefined)
    const focus = this.previousFocus
    this.previousFocus = undefined
    if (restoreFocus && focus?.isConnected === true && this.container?.contains(focus) === true) focus.focus()
  }

  retry(): void {
    const view = this.view.getSnapshot()
    if (view === undefined || view.address.startsWith('dsh-resource://plan-review/')) return
    const focus = this.previousFocus
    this.openResource(view.address)
    this.previousFocus = focus
  }

  mount(container: HTMLElement): () => void {
    if (this.reactRoot !== undefined) throw new Error('Projects Plan navigation is already mounted')
    this.container = container
    this.releaseStyles = acquireUiStyles(container.ownerDocument)
    const element = container.ownerDocument.createElement('div')
    element.className = 'dsh-projects-plan-preview-owner'
    container.append(element)
    this.element = element
    const root = createRoot(element)
    this.reactRoot = root
    root.render(<ProjectPlanPreview owner={this} />)
    const current = this.ctx.uiSession.adapter.current
    const select = () => {
      const next = current.getSnapshot().key as SessionId | undefined
      if (this.view.getSnapshot() !== undefined && this.view.getSnapshot()!.sessionId !== next) this.close(false)
      this.mounted.set(next)
    }
    this.stopSelection = current.subscribe(select)
    select()
    return () => {
      if (this.reactRoot !== root) return
      this.close()
      this.reactRoot = undefined
      this.stopSelection?.()
      this.stopSelection = undefined
      this.mounted.set(undefined)
      root.unmount()
      element.remove()
      this.element = undefined
      this.container = undefined
      this.releaseStyles?.()
      this.releaseStyles = undefined
    }
  }

  dispose(): void {
    this.close(false)
    this.stopSelection?.()
    this.stopSelection = undefined
    this.mounted.set(undefined)
    this.reactRoot?.unmount()
    this.reactRoot = undefined
    this.element?.remove()
    this.element = undefined
    this.container = undefined
    this.releaseStyles?.()
    this.releaseStyles = undefined
    this.types.clear()
  }
}

function ProjectPlanPreview({ owner }: { readonly owner: ProjectPlanNavigation }) {
  const view = useSyncExternalStore(owner.view.subscribe, owner.view.getSnapshot)
  useSyncExternalStore(owner.subscribeLocale, owner.readLocale)
  if (view === undefined) return null
  const plan = view.resource.value
  const t = owner.translate
  const title = plan?.title ?? view.title
  const unavailable = view.resource.status === 'none'
  const failed = view.resource.status === 'failed'
  return <section role="dialog" aria-label={plan?.title ?? view.title} data-projects-plan-preview={view.address}
    className="projects-ui__stock-aside projects-ui__stock-plan">
    <header className="projects-ui__stock-head"><Tooltip label={title}><strong className="projects-ui__stock-title">{title}</strong></Tooltip>
      <IconAction aria-label={t('whole.stock.plan.close')} title={t('whole.stock.plan.close')} icon={<IconCloseOutlineRegular />} onClick={() => owner.close()} />
    </header>
    <div className="projects-ui__stock-plan-content">
      {failed || unavailable ? <ErrorState title={t('whole.stock.plan.unavailable')} description={view.resource.failure?.message}
        retry={view.address.startsWith('dsh-resource://plan-review/') || unavailable ? undefined : () => owner.retry()} retryLabel={t('whole.stock.plan.retry')} />
        : plan === undefined ? <LoadingState label={t('whole.stock.plan.loading')} rows={3} /> : null}
      {plan !== undefined && <MarkdownText text={plan.markdown} labels={{ code: { copyLabel: t('whole.stock.plan.copy'), copiedLabel: t('whole.stock.plan.copied'), toolbarLabels: { codeLabel: t('whole.stock.plan.code'), wrapLabel: t('whole.stock.plan.wrap'), unwrapLabel: t('whole.stock.plan.unwrap') } }, footnotes: t('whole.stock.plan.footnotes') }} />}
    </div>
  </section>
}
