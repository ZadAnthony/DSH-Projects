/** Project-owned navigation around the unchanged host Markdown renderer. */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { isReplySessionLinkDestination, parseReplySessionLink, type ReplySessionLinkTarget } from '../reply-session-links.ts'
import { projectCopy, type ProjectsTranslate } from './ui/copy.ts'
import css from './ProjectReplySessionLinks.module.css'

export interface ProjectReplyLinkSource {
  readonly originProjectId: string
  readonly role: 'main' | 'execution'
}
export interface ProjectReplyLinksNavigation {
  readonly projectId: string
  readonly onOpen: (target: ReplySessionLinkTarget) => Promise<void>
  readonly t?: ProjectsTranslate | undefined
}
const Navigation = createContext<ProjectReplyLinksNavigation | undefined>(undefined)
const HostedNavigation = createContext<ProjectReplyLinksNavigation | undefined>(undefined)
type RegisterNavigation = (token: symbol, navigation: ProjectReplyLinksNavigation) => () => void
const RegisterHostedNavigation = createContext<RegisterNavigation | undefined>(undefined)

/** One product root shares its active screen capability with sibling recorded Readers. */
export function ProjectReplyLinksHost({ children }: { readonly children: ReactNode }): ReactNode {
  const [owner, setOwner] = useState<{ token: symbol; navigation: ProjectReplyLinksNavigation }>()
  const register = useCallback<RegisterNavigation>((token, navigation) => {
    setOwner({ token, navigation })
    return () => { setOwner(current => current?.token === token ? undefined : current) }
  }, [])
  return <RegisterHostedNavigation.Provider value={register}>
    <HostedNavigation.Provider value={owner?.navigation}>{children}</HostedNavigation.Provider>
  </RegisterHostedNavigation.Provider>
}

/** Read the current screen's capability when explicitly bridging an independent React root. */
export function useProjectReplyLinksNavigation(): Readonly<ProjectReplyLinksNavigation> | undefined {
  const local = useContext(Navigation)
  const hosted = useContext(HostedNavigation)
  return local ?? hosted
}

export function ProjectReplyLinksProvider({ projectId, onOpen, t, children }: ProjectReplyLinksNavigation & { readonly children: ReactNode }): ReactNode {
  const value = useMemo(() => ({ projectId, onOpen, t }), [projectId, onOpen, t])
  const register = useContext(RegisterHostedNavigation)
  const token = useRef(Symbol('Project reply navigation owner'))
  useLayoutEffect(() => register?.(token.current, value), [register, value])
  return <Navigation.Provider value={value}>{children}</Navigation.Provider>
}

function ownedAnchor(event: SyntheticEvent<HTMLDivElement>): HTMLAnchorElement | undefined {
  const node = event.target as Node | null
  const element = node?.nodeType === 1 ? node as Element : node?.parentElement
  const anchor = element?.closest<HTMLAnchorElement>('a[href]')
  return anchor !== null && anchor !== undefined && event.currentTarget.contains(anchor)
    && isReplySessionLinkDestination(anchor.getAttribute('href') ?? '') ? anchor : undefined
}
function consume(event: SyntheticEvent): void { event.preventDefault(); event.stopPropagation() }

/** Scope is explicit so a subagent portal cannot inherit a parent work session's authority. */
export function ProjectReplyLinkTextBoundary({ text, enabledSettled, source, children }: {
  readonly text: string
  readonly enabledSettled: boolean
  readonly source?: ProjectReplyLinkSource | undefined
  readonly children: ReactNode
}): ReactNode {
  const navigation = useProjectReplyLinksNavigation()
  const [failed, setFailed] = useState(false)
  const epoch = useRef(0)
  const sourceProject = source?.originProjectId, role = source?.role
  useEffect(() => {
    epoch.current++; setFailed(false)
    return () => { epoch.current++ }
  }, [text, enabledSettled, sourceProject, role, navigation?.projectId])
  const activate = (anchor: HTMLAnchorElement): void => {
    const href = anchor.getAttribute('href') ?? ''
    const target = parseReplySessionLink(href)
    if (!enabledSettled || anchor.closest('code, pre') !== null) return
    if (target === undefined || navigation === undefined || sourceProject !== navigation.projectId
      || target.projectId !== sourceProject || (role !== 'main' && role !== 'execution')) { setFailed(true); return }
    const request = ++epoch.current
    setFailed(false)
    void Promise.resolve().then(() => navigation.onOpen(target)).catch((error: unknown) => {
      if (request !== epoch.current || (error !== null && typeof error === 'object' && 'name' in error && error.name === 'AbortError')) return
      console.error('[dsh-projects] reply session navigation failed', error)
      setFailed(true)
    })
  }
  return <div className={css.boundary} data-project-reply-links="" data-reply-links-settled={enabledSettled || undefined}
    onClickCapture={event => { const anchor = ownedAnchor(event); if (anchor === undefined) return; consume(event); if (event.button === 0) activate(anchor) }}
    onAuxClickCapture={event => { const anchor = ownedAnchor(event); if (anchor === undefined) return; consume(event); if (event.button === 1) activate(anchor) }}
    onMouseDownCapture={event => { if (event.button === 1 && ownedAnchor(event) !== undefined) consume(event) }}
    onKeyDownCapture={event => { const anchor = ownedAnchor(event); if (anchor === undefined || event.key !== 'Enter') return; consume(event); if (!event.repeat) activate(anchor) }}
    onContextMenuCapture={event => { if (ownedAnchor(event) !== undefined) consume(event) }}
    onDragStartCapture={event => { if (ownedAnchor(event) !== undefined) consume(event) }}>
    {children}
    {failed && <p className={css.failure} role="status">{projectCopy(navigation?.t)('replySessionLinks.unavailable')}</p>}
  </div>
}
