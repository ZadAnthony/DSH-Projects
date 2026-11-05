import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'

import type { NativeProjectSource } from '../../source-types.ts'
import type {
  LibraryClientActions, LibraryEntry, LibraryFileLocation, LibraryListing, LibraryOpenResult, LibraryTarget,
} from '../../library-contract.ts'
import { RefreshButton } from '../WorkflowControls.tsx'
import type { ReadingScrollPosition, TextReadingView } from '../workflow-reading.ts'
import { isMarkdownFile, TextReadingContent, TextReadingControls } from '../TextReading.tsx'
import { formatUiDate } from '../ui/date-format.ts'
import { Button, EmptyState, ErrorState, Feedback, IconChevronLeftOutlineRegular, FileTypeIcon, IconChevronRightOutlineRegular, IconInfoOutlineRegular, IconSearchOutlineRegular, Input, ListRow, LoadingState, Pill, projectCopy, Select, StateDot, Tag, Tooltip, type ProjectsTranslate } from '../ui/index.ts'

export interface LibrarySelection {
  readonly location: LibraryFileLocation
  readonly name: string
  readonly entry?: LibraryEntry
}

export interface LibraryPanelProps {
  readonly translate?: ProjectsTranslate
  /** Optional navigation control sharing the Library title row in an embedded surface. */
  readonly headerLeading?: ReactNode
  readonly projectId: string
  readonly sessionId: string
  readonly actions: LibraryClientActions
  readonly pickWorkspaceDirectory?: (() => Promise<string | null>) | undefined
  readonly onOpenOriginal?: (target: LibraryTarget) => Promise<void>
  readonly onOpenSource?: (source: NativeProjectSource, opener?: HTMLElement) => void
  /** 父工作面接管阅读时，由父级调用同一真实 open 动作。 */
  readonly onRead?: (selection: LibrarySelection, opener?: HTMLElement) => void
}

export interface LibraryReaderProps {
  readonly translate?: ProjectsTranslate
  readonly selection: LibrarySelection
  readonly value?: LibraryOpenResult
  readonly loading?: boolean
  readonly error?: string
  readonly onReload: () => void
  readonly onBack: () => void
  readonly backLabel?: string
  readonly onOpenOriginal?: (target: LibraryTarget) => Promise<void>
  readonly onRead?: (selection: LibrarySelection, opener?: HTMLElement) => void
  readonly onOpenSource?: (source: NativeProjectSource, opener?: HTMLElement) => void
  readonly initialFocusSource?: NativeProjectSource
  readonly footer?: ReactNode
  readonly initialScrollTop?: number
  readonly initialOuterScrollTop?: number | undefined
  readonly initialPresentation?: ReadingScrollPosition['presentation']
  readonly onReadingScroll?: (scrollTop: number) => void
  readonly onReadingPosition?: (position: ReadingScrollPosition) => void
}

/** 切项目/会话在首次提交就更换本地状态，迟到请求不能显示到新项目。 */
export function LibraryPanel(props: LibraryPanelProps): ReactNode {
  return <ProjectLibrary key={`${props.projectId}:${props.sessionId}`} {...props} />
}

function ProjectLibrary({ projectId, sessionId, actions, pickWorkspaceDirectory, onOpenOriginal, onOpenSource, onRead, translate, headerLeading }: LibraryPanelProps): ReactNode {
  const copy = projectCopy(translate)
  const request = useMemo(() => ({ projectId, sessionId }), [projectId, sessionId])
  const [directory, setDirectory] = useState('')
  const [listing, setListing] = useState<{ readonly directory: string; readonly value: LibraryListing; readonly confirmedUpdates?: true }>()
  const [listRead, setListRead] = useState<{ readonly directory: string; readonly loading: boolean; readonly error?: string }>({ directory: '', loading: true })
  const loading = listRead.directory !== directory || listRead.loading
  const listError = listRead.directory === directory ? listRead.error : undefined
  const [actionError, setActionError] = useState<string>()
  const [readError, setReadError] = useState<string>()
  const [feedback, setFeedback] = useState<string>()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'project' | 'reference'>('all')
  const [selected, setSelected] = useState<LibrarySelection>()
  const selectedRef = useRef<LibrarySelection | undefined>(undefined)
  const [opened, setOpened] = useState<LibraryOpenResult>()
  const [opening, setOpening] = useState(false)
  const [busy, setBusy] = useState(false)
  const [kind, setKind] = useState<'file' | 'directory' | 'url'>('file')
  const [name, setName] = useState('')
  const [location, setLocation] = useState('')
  const [description, setDescription] = useState('')
  const [addingReference, setAddingReference] = useState(false)
  const addDraftVersion = useRef(0)
  const locationId = useId()
  const [choosing, setChoosing] = useState(false)
  const [chooseError, setChooseError] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const picker = useRef<{ readonly version: number; readonly hostPaths?: HostPathBridge }>()
  const hostPaths = hostPathBridge()
  const epoch = useRef(0)
  const openEpoch = useRef(0)
  const listAbort = useRef<AbortController | undefined>(undefined)
  const openAbort = useRef<AbortController | undefined>(undefined)
  const alive = useRef(true)
  const listElement = useRef<HTMLElement | null>(null)
  const directoryNavigation = useRef<HTMLElement | null>(null)
  const listScrollTop = useRef(0)
  const readerOpener = useRef<HTMLElement>()
  const readerOpenerKey = useRef<string>()
  const listRows = useRef(new Map<string, HTMLLIElement>())
  const returnFocus = useRef(false)
  useLayoutEffect(() => {
    if (selected !== undefined || !returnFocus.current) return
    returnFocus.current = false
    const original = readerOpener.current
    const row = readerOpenerKey.current === undefined ? undefined : listRows.current.get(readerOpenerKey.current)?.firstElementChild
    const visible = (element: Element | undefined | null): element is HTMLElement => element instanceof HTMLElement && element.isConnected
      && !element.matches(':disabled') && element.closest('[hidden], [inert], [aria-hidden="true"]') === null
    const target = visible(original) ? original : visible(row) ? row : listElement.current
    if (visible(target)) target.focus({ preventScroll: true })
  }, [selected])

  const refresh = useCallback(async () => {
    const version = ++epoch.current
    listAbort.current?.abort()
    const controller = new AbortController()
    listAbort.current = controller
    setListRead({ directory, loading: true })
    setListing(previous => previous?.directory === directory ? previous : undefined)
    try {
      const value = await actions.list({ ...request, directory }, controller.signal)
      if (version === epoch.current) setListing({ directory, value })
    } catch (error) {
      if (version === epoch.current && !controller.signal.aborted) setListRead({ directory, loading: false, error: message(error) })
    } finally { if (version === epoch.current) setListRead(previous => ({ ...previous, loading: false })) }
  }, [actions, request, directory])
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  useEffect(() => {
    void refresh()
    return () => { epoch.current++; listAbort.current?.abort() }
  }, [refresh])
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; openEpoch.current++; openAbort.current?.abort() }
  }, [])
  useEffect(() => {
    if (selected === undefined && listElement.current !== null) listElement.current.scrollTop = listScrollTop.current
  }, [selected])

  const open = useCallback(async (selection: LibrarySelection) => {
    const version = ++openEpoch.current
    openAbort.current?.abort()
    const controller = new AbortController()
    openAbort.current = controller
    selectedRef.current = selection
    setSelected(selection); setOpened(undefined); setOpening(true); setReadError(undefined)
    try {
      const value = await actions.open({ ...request, location: selection.location }, controller.signal)
      if (version === openEpoch.current) setOpened(value)
    } catch (error) {
      if (version === openEpoch.current && !controller.signal.aborted) setReadError(message(error))
    } finally { if (version === openEpoch.current) setOpening(false) }
  }, [actions, request])

  const closeReader = (): void => {
    returnFocus.current = selectedRef.current !== undefined
    openEpoch.current++; openAbort.current?.abort(); selectedRef.current = undefined
    setSelected(undefined); setOpened(undefined); setOpening(false); setReadError(undefined)
  }
  const browse = (path: string): void => {
    // 目录行会随请求卸载；先交给稳定导航区，异步完成不再抢用户已转移的焦点。
    directoryNavigation.current?.focus({ preventScroll: true })
    closeReader(); listScrollTop.current = 0; setDirectory(path)
  }
  const read = (selection: LibrarySelection, opener: HTMLElement): void => {
    listScrollTop.current = listElement.current?.scrollTop ?? 0
    readerOpener.current = opener; readerOpenerKey.current = selectionKey(selection)
    if (onRead !== undefined) onRead(selection, opener)
    else void open(selection)
  }

  const finishPicking = (operation: NonNullable<typeof picker.current>, path?: string | null, failed = false): void => {
    if (!alive.current || picker.current !== operation) return
    picker.current = undefined; setChoosing(false)
    // 任一字段的新输入优先；即便文字改回原值，旧选择也不能覆盖新草稿。
    if (addDraftVersion.current !== operation.version) return
    if (failed) { setChooseError(true); return }
    if (path === undefined || path === null) return
    if (!absoluteHostPath(path)) { setChooseError(true); return }
    addDraftVersion.current++
    setLocation(path)
    setName(previous => previous.trim() === '' ? path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? '' : previous)
  }
  const choose = async (): Promise<void> => {
    if (busy || picker.current !== undefined || kind === 'url') return
    if (kind === 'directory' && pickWorkspaceDirectory === undefined || kind === 'file' && hostPaths === undefined) return
    const operation = { version: addDraftVersion.current, ...(kind === 'file' ? { hostPaths: hostPaths! } : {}) }
    picker.current = operation; setChoosing(true); setChooseError(false)
    try {
      if (kind === 'directory') finishPicking(operation, await pickWorkspaceDirectory!())
      else {
        // 浏览器仅发起真实用户选择；原件路径只信宿主桥，不读 File 内容或 input.value。
        fileInput.current!.value = ''
        fileInput.current!.click()
      }
    } catch { finishPicking(operation, undefined, true) }
  }
  useEffect(() => {
    const input = fileInput.current
    if (input === null) return
    // input 的原生 cancel 不冒泡；React 的 dialog onCancel 不能替代它。
    const cancel = (): void => { const operation = picker.current; if (operation?.hostPaths !== undefined) finishPicking(operation) }
    input.addEventListener('cancel', cancel)
    return () => input.removeEventListener('cancel', cancel)
  }, [kind, hostPaths, selected])

  const add = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy || picker.current !== undefined || !event.currentTarget.checkValidity()) return
    const submittedVersion = addDraftVersion.current
    setBusy(true); setActionError(undefined); setFeedback(undefined)
    try {
      const entry = await actions.add({ ...request, name, target: kind === 'url' ? { kind, url: location } : { kind, path: location }, ...(description === '' ? {} : { description }) })
      if (!alive.current) return
      if (entry.projectId !== projectId) throw new Error(copy('wholeRead.library.writeScopeMismatch'))
      setListing(previous => previous?.value.references.status !== 'ready' ? previous : { ...previous, confirmedUpdates: true,
        value: { ...previous.value, references: { status: 'ready', entries: [...previous.value.references.entries.filter(value => value.id !== entry.id), entry] } } })
      // 等待期间编辑任一字段，保留整份新草稿，包括引用说明。
      if (addDraftVersion.current === submittedVersion) { setName(''); setLocation(''); setDescription('') }
      setFeedback(copy('p3.library.referenceSaved'))
      await refreshRef.current()
    } catch (error) { if (alive.current) setActionError(message(error)) }
    finally { if (alive.current) setBusy(false) }
  }

  const remove = async (entry: LibraryEntry, opener: HTMLElement): Promise<void> => {
    if (busy) return
    if (document.activeElement === opener) directoryNavigation.current?.focus({ preventScroll: true })
    setBusy(true); setActionError(undefined); setFeedback(undefined)
    try {
      await actions.remove({ ...request, entryId: entry.id })
      if (!alive.current) return
      setListing(previous => previous?.value.references.status !== 'ready' ? previous : { ...previous, confirmedUpdates: true,
        value: { ...previous.value, references: { status: 'ready', entries: previous.value.references.entries.filter(value => value.id !== entry.id) } } })
      const current = selectedRef.current?.location
      if (current?.kind === 'reference' && current.entryId === entry.id) closeReader()
      setFeedback(copy('p3.library.referenceRemoved'))
      await refreshRef.current()
    } catch (error) { if (alive.current) setActionError(message(error)) }
    finally { if (alive.current) setBusy(false) }
  }

  if (selected !== undefined) return <LibraryReader key={selectionKey(selected)} selection={selected} value={opened} loading={opening} error={readError} onReload={() => { void open(selected) }} onBack={closeReader} onRead={selection => { void open(selection) }} onOpenOriginal={onOpenOriginal} onOpenSource={onOpenSource} translate={translate} />

  const value = listing?.directory === directory ? listing.value : undefined
  const files = value?.projectFiles
  const references = value?.references
  const matches = (text: string): boolean => text.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  const entries = filter !== 'project' && references?.status === 'ready' ? references.entries.filter(entry => matches(`${entry.name}\n${entry.description}\n${targetLocation(entry.target)}`)) : []
  const children = filter !== 'reference' && files?.status === 'directory' ? files.entries.filter(entry => matches(`${entry.name}\n${files.absolutePath}/${entry.name}`)) : []
  const count = children.length + entries.length
  const incomplete = listError !== undefined || filter !== 'reference' && (files?.status === 'unavailable' || files?.status === 'directory' && files.truncated) || filter !== 'project' && references?.status === 'unavailable'
  return <section ref={listElement} tabIndex={-1} className="projects-library" aria-label={copy('p3.library.title')} aria-busy={loading || busy} onScroll={event => { listScrollTop.current = event.currentTarget.scrollTop }}>
    <header className="projects-library-heading"><div className="projects-library-title">{headerLeading}<h2>{copy('p3.library.title')}</h2></div><div className="projects-library-actions">
      <Tooltip label={copy('p3.library.searchHelp')}><Button variant="ghost" size="sm" type="button" aria-label={copy('p3.library.help')} icon={<IconInfoOutlineRegular size={16} />} /></Tooltip>
      <RefreshButton translate={copy} onClick={() => { void refresh() }} loading={loading} ariaLabel={copy('p3.library.refresh')} />
    </div></header>
    <div className="projects-library-toolbar">
      <Input className="projects-library-search" type="search" icon={<IconSearchOutlineRegular size={16} />} aria-label={copy('p3.library.search')} value={query} onChange={event => setQuery(event.target.value)} placeholder={copy('p3.library.searchPlaceholder')} />
      <div className="projects-library-filters" role="group" aria-label={copy('p3.library.filter')}>{(['all', 'project', 'reference'] as const).map(key => <Pill key={key} active={filter === key} aria-pressed={filter === key} type="button" onClick={() => setFilter(key)}>{copy(`p3.library.filter.${key}`)}</Pill>)}</div>
      <small className="projects-library-count" role="status">{loading ? <StateDot state="ongoing" /> : listError !== undefined || value === undefined ? copy('wholeRead.library.countUnconfirmed') : copy(incomplete ? 'p3.library.partialCount' : 'p3.library.count', { count })}</small>
    </div>
    <nav ref={directoryNavigation} tabIndex={-1} className="projects-library-directory" aria-label={[copy('p3.library.directory'), directory].filter(Boolean).join(': ')}><Button variant="ghost" size="sm" type="button" onClick={() => browse('')}>{copy('p3.library.projectDirectory')}</Button>{directory !== '' && <><span className="projects-library-directory-name" title={directory}>/ {directory}</span><Button variant="ghost" size="sm" type="button" onClick={() => browse(directory.split('/').slice(0, -1).join('/'))}>{copy('p3.library.parentDirectory')}</Button></>}<small>{copy('p3.library.registeredReferences')}</small></nav>
    {listError !== undefined && <ErrorState title={copy('p3.library.listFailed')} diagnostic={{ label: copy('p5.panel.errorDetails'), content: listError }} retry={() => { void refresh() }} retryLabel={copy('p3.library.retry')} />}
    {value !== undefined && (loading || listError !== undefined) && <p className="projects-library-note" role="status">{copy(listing?.confirmedUpdates ? 'wholeRead.library.retainedAfterWrite' : 'wholeRead.library.retained', { at: value.projectFiles.readAt })}</p>}
    {filter !== 'reference' && files?.status === 'unavailable' && <ErrorState title={copy('p3.library.directoryFailed')} description={failureLabel(files.reason, copy)} diagnostic={{ label: copy('p5.panel.errorDetails'), content: files.message }} retry={() => { void refresh() }} retryLabel={copy('p3.library.retry')} />}
    {filter !== 'project' && references?.status === 'unavailable' && <ErrorState title={copy('p3.library.referencesFailed')} diagnostic={{ label: copy('p5.panel.errorDetails'), content: references.message }} retry={() => { void refresh() }} retryLabel={copy('p3.library.retry')} />}
    {loading && <LoadingState label={copy('p3.library.loading')} rows={3} />}
    <ul className="projects-library-entries" hidden={loading && value === undefined}>{children.map(entry => {
      const path = [directory, entry.name].filter(Boolean).join('/')
      return <li key={`file:${entry.name}`} ref={element => { const key = selectionKey({ location: { kind: 'project-file', relativePath: path }, name: entry.name }); if (element === null) listRows.current.delete(key); else listRows.current.set(key, element) }}><ListRow className="projects-library-entry" icon={<FileTypeIcon {...entry.type === 'directory' ? { kind: 'folder' as const } : { path }} size={20} />} trailing={<IconChevronRightOutlineRegular size={16} className="projects-library-chevron" />} onClick={event => entry.type === 'directory' ? browse(path) : read({ location: { kind: 'project-file', relativePath: path }, name: entry.name }, event.currentTarget)}>
        <span className="projects-library-entry-copy"><strong>{entry.name}{entry.type === 'directory' ? '/' : ''}</strong><small title={path}>{copy('p3.library.projectFile')} · {directory ? `${directory}/` : copy('p3.library.projectDirectory')}{entry.type === 'other' ? ` · ${copy('p3.library.otherType')}` : ''}</small></span>
      </ListRow></li>
    })}{entries.map(entry => <li key={`reference:${entry.id}`} ref={element => { const key = selectionKey({ location: { kind: 'reference', entryId: entry.id }, name: entry.name }); if (element === null) listRows.current.delete(key); else listRows.current.set(key, element) }}><ListRow className="projects-library-entry" icon={<FileTypeIcon {...entry.target.kind === 'directory' ? { kind: 'folder' as const } : entry.target.kind === 'url' ? { kind: 'html' as const } : { path: entry.target.path }} size={20} />} trailing={<IconChevronRightOutlineRegular size={16} className="projects-library-chevron" />} onClick={event => read({ location: { kind: 'reference', entryId: entry.id }, name: entry.name, entry }, event.currentTarget)}>
      <span className="projects-library-entry-copy"><strong>{entry.name}</strong><small title={targetLocation(entry.target)}>{ownershipLabel(entry, copy)} · {targetLocation(entry.target)}</small>{entry.description && <span className="projects-library-entry-description" title={entry.description}>{entry.description}</span>}</span>
    </ListRow><Button className="projects-library-remove" variant="ghost" size="sm" type="button" disabled={busy} aria-label={copy('p3.library.removeNamed', { name: entry.name })} onClick={event => { void remove(entry, event.currentTarget) }}>{copy('p3.library.remove')}</Button></li>)}</ul>
    {!loading && listError === undefined && value !== undefined && count === 0 && <EmptyState icon={<FileTypeIcon kind="folder" size={32} />} title={copy(incomplete ? 'p3.library.emptyPartial' : query ? 'p3.library.noMatches' : 'p3.library.empty')} description={!query && !incomplete ? copy('p3.library.emptyHelp') : undefined} actions={query ? <Button variant="outline" size="sm" type="button" onClick={() => setQuery('')}>{copy('p3.library.clearSearch')}</Button> : !addingReference ? <Button variant="primary" size="sm" type="button" onClick={() => setAddingReference(true)}>{copy('p3.library.addExternal')}</Button> : undefined} />}
    {filter !== 'reference' && files?.status === 'directory' && files.truncated && <p className="projects-library-note" role="status"><StateDot state="warning" />{copy('p3.library.directoryTruncated')}</p>}
    <details className="projects-library-refadd" open={addingReference} onToggle={event => setAddingReference(event.currentTarget.open)}><summary>{copy('p3.library.addExternal')}</summary><form onSubmit={event => { void add(event) }} className="projects-library-add">
      <label className="projects-ui__field">{copy('p3.library.name')}<Input required value={name} onChange={event => { addDraftVersion.current++; setChooseError(false); setName(event.target.value) }} placeholder={copy('p3.library.namePlaceholder')} /></label>
      <label className="projects-ui__field">{copy('p3.library.kind')}<Select aria-label={copy('p3.library.referenceKind')} value={kind} onValueChange={value => { addDraftVersion.current++; picker.current = undefined; setChoosing(false); setChooseError(false); setKind(value as typeof kind) }}><option value="file">{copy('p3.library.kind.file')}</option><option value="directory">{copy('p3.library.kind.directory')}</option><option value="url">{copy('p3.library.kind.url')}</option></Select></label>
      <div className="projects-ui__field projects-library-location"><label htmlFor={locationId}>{copy('p3.library.location')}</label><div className="projects-library-location-control"><Input id={locationId} className="projects-library-location-input" required type={kind === 'url' ? 'url' : 'text'} value={location} aria-describedby={chooseError ? `${locationId}-error` : undefined} onChange={event => { addDraftVersion.current++; setChooseError(false); setLocation(event.target.value) }} placeholder={copy(kind === 'url' ? 'p3.library.urlPlaceholder' : 'p3.library.pathPlaceholder')} />
        {(kind === 'directory' && pickWorkspaceDirectory !== undefined || kind === 'file' && hostPaths !== undefined) && <Button variant="outline" size="sm" type="button" aria-disabled={busy || choosing} aria-busy={choosing} onClick={() => { void choose() }}>{copy(kind === 'directory' ? 'p3.library.chooseDirectory' : 'p3.library.chooseFile')}</Button>}
      </div>{kind === 'file' && hostPaths !== undefined && <input ref={fileInput} type="file" hidden onChange={event => {
        const operation = picker.current, file = event.currentTarget.files?.[0]
        if (operation?.hostPaths === undefined) return
        if (file === undefined) { finishPicking(operation); return }
        try { finishPicking(operation, operation.hostPaths.pathFor(file)) } catch { finishPicking(operation, undefined, true) }
      }} />}{chooseError && <small id={`${locationId}-error`} role="alert">{copy('p3.library.chooseFailed')}</small>}</div>
      <label className="projects-ui__field projects-library-location">{copy('p3.library.description')}<Input value={description} onChange={event => { addDraftVersion.current++; setChooseError(false); setDescription(event.target.value) }} placeholder={copy('p3.library.descriptionPlaceholder')} /></label>
      <div className="projects-library-add-actions"><Tooltip label={copy('p3.library.referenceHelp')}><Button variant="ghost" size="sm" type="button" aria-label={copy('p3.library.referenceHelpLabel')} icon={<IconInfoOutlineRegular size={16} />} /></Tooltip><Button variant="primary" size="sm" type="submit" disabled={busy} aria-disabled={choosing} icon={busy ? <StateDot state="ongoing" /> : undefined}>{copy(busy ? 'p3.library.processing' : 'p3.library.add')}</Button></div>
    </form></details>
    {feedback !== undefined && <Feedback text={feedback} tone="success" onDone={() => setFeedback(undefined)} />}
    {actionError !== undefined && <ErrorState title={copy('p3.library.actionFailed')} diagnostic={{ label: copy('p5.panel.errorDetails'), content: actionError }} inline />}
  </section>
}

/** 阅读正文先于位置和来源；受控结果仅表示当次读取，不推断作者或负责会话。 */
export function LibraryReader({ selection, value, loading = false, error, onReload, onBack, backLabel, onOpenOriginal, onRead, onOpenSource, initialFocusSource, footer, initialScrollTop = 0, initialOuterScrollTop = 0, initialPresentation, onReadingScroll, onReadingPosition, translate }: LibraryReaderProps): ReactNode {
  const copy = projectCopy(translate)
  const returnLabel = backLabel ?? copy('p3.library.back')
  const identity = selectionKey(selection)
  const bodyElement = useRef<HTMLDivElement | null>(null)
  const readerElement = useRef<HTMLElement | null>(null)
  const backButton = useRef<HTMLButtonElement>(null)
  const sourceButton = useRef<HTMLButtonElement>(null)
  const sourceDetails = useRef<HTMLDetailsElement>(null)
  useLayoutEffect(() => {
    if (initialFocusSource !== undefined && sourceDetails.current !== null) sourceDetails.current.open = true
    const target = sourceButton.current ?? backButton.current
    target?.focus({ preventScroll: true })
  }, [identity, initialFocusSource])
  const [originalError, setOriginalError] = useState<string>()
  const actionEpoch = useRef(0)
  const [viewState, setViewState] = useState({ identity, view: initialPresentation?.view ?? 'reading' })
  const readingPosition = useRef<{ identity: string; position: ReadingScrollPosition }>({ identity, position: { scrollTop: initialScrollTop, outerScrollTop: initialOuterScrollTop, ...(initialPresentation === undefined ? {} : { presentation: initialPresentation }) } })
  const restoredRead = useRef<LibraryOpenResult>()
  const restoredView = useRef<TextReadingView>()
  if (readingPosition.current.identity !== identity) {
    readingPosition.current = { identity, position: { scrollTop: initialScrollTop, outerScrollTop: initialOuterScrollTop, ...(initialPresentation === undefined ? {} : { presentation: initialPresentation }) } }
    restoredRead.current = undefined
  }
  useEffect(() => {
    setOriginalError(undefined)
    setViewState({ identity, view: initialPresentation?.view ?? 'reading' })
    return () => { actionEpoch.current++ }
  }, [identity])
  // 重读等待与失败均不继续展示上次正文；位置不一致的结果也不能冒充本文件。
  const current = value !== undefined && sameLocation(value.location, selection.location) ? value : undefined
  const ready = !loading && error === undefined ? current : undefined
  const markdown = ready?.status === 'file' && isMarkdownFile(ready.absolutePath, ready.mediaType)
    && previewText(ready.base64, ready.mediaType, ready.absolutePath) !== undefined
  const view: TextReadingView = markdown ? viewState.identity === identity ? viewState.view : initialPresentation?.view ?? 'reading' : 'raw'
  // owner 返回的不可用结果仍正常展示，但失败页收缩不代表新的正文阅读位置。
  const positionReady = ready?.status === 'unavailable' ? undefined : ready
  if (positionReady === undefined) restoredRead.current = undefined
  useEffect(() => {
    if (positionReady === undefined || restoredRead.current === positionReady && restoredView.current === view || bodyElement.current === null || readerElement.current === null) return
    const saved = readingPosition.current.position
    const paired = saved.presentation === undefined ? saved : saved.presentation.positions[view]
    bodyElement.current.scrollTop = paired?.scrollTop ?? 0
    readerElement.current.scrollTop = paired?.outerScrollTop ?? 0
    const scrollTop = bodyElement.current.scrollTop, outerScrollTop = readerElement.current.scrollTop
    const presentation = saved.presentation === undefined ? undefined : { view, positions: { ...saved.presentation.positions, [view]: { scrollTop, outerScrollTop } } }
    const position = { scrollTop, outerScrollTop, ...(presentation === undefined ? {} : { presentation }) }
    readingPosition.current = { identity, position }
    restoredRead.current = positionReady
    restoredView.current = view
    onReadingPosition?.(position)
  }, [identity, loading, positionReady, view, onReadingPosition])
  const rememberPosition = (bodyScrolled = false): void => {
    if (positionReady === undefined || restoredRead.current !== positionReady || restoredView.current !== view || bodyElement.current === null || readerElement.current === null) return
    const scrollTop = bodyElement.current.scrollTop, outerScrollTop = readerElement.current.scrollTop
    const saved = readingPosition.current.position
    const presentation = saved.presentation === undefined ? undefined : { view, positions: { ...saved.presentation.positions, [view]: { scrollTop, outerScrollTop } } }
    const position = { scrollTop, outerScrollTop, ...(presentation === undefined ? {} : { presentation }) }
    readingPosition.current = { identity, position }
    onReadingPosition?.(position)
    if (bodyScrolled) onReadingScroll?.(scrollTop)
  }
  const changeView = (next: TextReadingView): void => {
    if (next === view || !markdown) return
    rememberPosition()
    const saved = readingPosition.current.position
    readingPosition.current = { identity, position: { ...saved, presentation: {
      view: next, positions: { ...saved.presentation?.positions, [view]: { scrollTop: saved.scrollTop, outerScrollTop: saved.outerScrollTop ?? 0 } },
    } } }
    setViewState({ identity, view: next })
  }
  const target = current?.target ?? (selection.location.kind === 'reference' && selection.location.relativePath ? undefined : selection.entry?.target)
  const parent = parentSelection(selection, copy)
  const original = async (): Promise<void> => {
    if (target === undefined || onOpenOriginal === undefined) return
    const version = ++actionEpoch.current
    setOriginalError(undefined)
    try { await onOpenOriginal(target) }
    catch (error) { if (version === actionEpoch.current) setOriginalError(message(error)) }
  }
  return <section ref={readerElement} className="projects-library-reader" aria-label={copy('p3.library.readNamed', { name: selection.name })} aria-busy={loading} onScroll={event => {
    if (event.target === event.currentTarget) rememberPosition()
  }}>
    <header className="projects-library-readingheader">
      <Button ref={backButton} className="projects-library-back" variant="ghost" size="sm" type="button" icon={<IconChevronLeftOutlineRegular size={16} />} onClick={onBack}>{returnLabel}</Button>
      <h2>{selection.name}</h2>
      <div className="projects-library-heading"><small>{selection.location.kind === 'project-file' ? copy('p3.library.projectFile') : selection.entry === undefined ? copy('p3.library.explicitReference') : ownershipLabel(selection.entry, copy)}{ready?.status === 'file' || ready?.status === 'directory' ? <> · <ReadTimestamp value={ready.readAt} copy={copy} /> {copy('p3.library.readAtSuffix')}</> : ready?.status === 'unavailable' || error !== undefined ? ` · ${copy('p3.library.readFailedStatus')}` : ''}</small><div className="projects-library-actions">
        {parent !== undefined && onRead !== undefined && <Button variant="ghost" size="sm" type="button" onClick={event => onRead(parent, event.currentTarget)}>{copy('p3.library.parentDirectory')}</Button>}
        {target !== undefined && target.kind !== 'url' && onOpenOriginal !== undefined && <Button variant="outline" size="sm" type="button" onClick={() => { void original() }}>{copy('p3.library.openOriginal')}</Button>}
        <RefreshButton translate={copy} onClick={() => { rememberPosition(); onReload() }} loading={loading} label={copy('p3.library.reread')} ariaLabel={copy('p3.library.rereadFile')} />
      </div></div>
      {originalError !== undefined && <ErrorState title={copy('p3.library.originalFailed')} diagnostic={{ label: copy('p5.panel.errorDetails'), content: originalError }} inline />}
      {markdown && <TextReadingControls view={view} onChange={changeView} copy={copy} />}
    </header>
    <div ref={bodyElement} className="projects-library-readingbody" tabIndex={0} role="region" aria-label={copy('p3.library.readNamed', { name: selection.name })} onScroll={event => {
      // 等待时清空正文会收缩滚动区；这种归零不能覆盖用户原来的阅读位置。
      event.stopPropagation()
      if (event.target === event.currentTarget) rememberPosition(true)
    }}>
      {loading ? <LoadingState label={copy('p3.library.reading')} rows={3} /> : error !== undefined ? <ErrorState title={copy('p3.library.readFailed')} diagnostic={{ label: copy('p5.panel.errorDetails'), content: error }} inline><small>{copy('p3.library.failedReadHelp')}</small></ErrorState> : ready !== undefined ? <LibraryPreviewContent value={ready} copy={copy} view={view} onRead={onRead === undefined ? undefined : (name, opener) => onRead(childSelection(selection, name), opener)} /> : <p role="status"><Tag tone="quiet">{copy('p3.library.notRead')}</Tag></p>}
      <details className="projects-library-readingdetails"><summary>{copy('p3.library.readDetails')}</summary><div className="projects-library-detailcontent">
        <code>{ready?.status === 'file' ? ready.absolutePath : target === undefined ? selection.location.kind === 'project-file' ? selection.location.relativePath : copy('p3.library.referenceLocationUnknown') : targetLocation(target)}</code>
        {ready?.status === 'file' ? <p>{copy('p3.library.fileDetails', { mediaType: ready.mediaType, bytes: ready.byteLength })} · <ReadTimestamp value={ready.readAt} copy={copy} /></p> : ready?.status === 'directory' ? <p>{copy('p3.library.kind.directory')} · <ReadTimestamp value={ready.readAt} copy={copy} /></p> : ready?.status === 'url' ? <p>{copy('p3.library.urlDetails')}</p> : <p>{copy(loading ? 'p3.library.pendingRead' : 'p3.library.noReadableContent')}</p>}
        {selection.entry?.description && <p><strong>{copy('p3.library.description')}: </strong>{selection.entry.description}</p>}
        <p>{copy(selection.location.kind === 'project-file' ? 'p3.library.projectOwnership' : 'p3.library.referenceOwnership')}</p>
      </div></details>
      {selection.entry !== undefined && <section className="projects-library-sources" aria-label={copy('p3.library.referenceSources')}>
        <details ref={sourceDetails}><summary>{copy('p3.library.sourcesTitle')} ({selection.entry.sources.length})</summary><div className="projects-library-detailcontent">
          <Tooltip label={copy('p3.library.sourcesHelp')}><Button variant="ghost" size="sm" type="button" aria-label={copy('p3.library.sourcesHelpLabel')} icon={<IconInfoOutlineRegular size={16} />} /></Tooltip>
          {selection.entry.sources.map((source, index) => <div className="projects-library-source" key={index}><code>{source.hostSessionId} · {source.kind === 'native-event' ? `${source.eventType} · ${source.eventSeq}` : source.kind === 'message' ? source.messageId : source.toolCallId}</code>{onOpenSource !== undefined && <Button ref={source === initialFocusSource ? sourceButton : undefined} variant="outline" size="sm" type="button" onClick={event => onOpenSource(source, event.currentTarget)}>{copy('p3.library.viewSource')}</Button>}</div>)}
        </div></details>
        {selection.entry.sourceLimitations?.map(limit => <p className="projects-library-note" key={limit}>{limit}</p>)}
        {selection.entry.sources.length === 0 && (selection.entry.sourceLimitations?.length ?? 0) === 0 && <p className="projects-library-note">{copy('p3.library.noSource')}</p>}
      </section>}
    </div>
    <footer className="projects-library-readingfooter">{footer ?? <Button variant="outline" size="sm" type="button" onClick={onBack}>{returnLabel}</Button>}</footer>
  </section>
}

/** 兼容仅需正文的既有消费者；完整工作面使用 LibraryReader。 */
export function LibraryPreview({ value, translate }: { readonly value: LibraryOpenResult; readonly translate?: ProjectsTranslate }): ReactNode {
  const copy = projectCopy(translate)
  return <section className="projects-library-reading"><LibraryPreviewContent value={value} copy={copy} view="raw" /><code>{value.status === 'file' ? value.absolutePath : targetLocation(value.target)}</code>{(value.status === 'file' || value.status === 'directory') && <p className="projects-library-note"><ReadTimestamp value={value.readAt} copy={copy} />{value.status === 'file' ? ` · ${copy('p3.library.bytes', { bytes: value.byteLength })}` : ''}</p>}</section>
}

function LibraryPreviewContent({ value, copy, onRead, view }: { readonly value: LibraryOpenResult; readonly copy: ProjectsTranslate; readonly view: TextReadingView; readonly onRead?: (name: string, opener: HTMLElement) => void }): ReactNode {
  if (value.status === 'unavailable') return <ErrorState title={copy('p3.library.readFailed')} description={failureLabel(value.reason, copy)} diagnostic={{ label: copy('p5.panel.errorDetails'), content: value.message }} inline><small>{copy('p3.library.failedReadHelp')}</small></ErrorState>
  if (value.status === 'url') return <div className="projects-library-readreference"><h3>{copy('p3.library.webReference')}</h3><p><a className="projects-ui__source-link" href={value.url} target="_blank" rel="noopener noreferrer">{copy('p3.library.openWeb')}</a></p><p className="projects-library-note">{copy('p3.library.webNotRead')}</p></div>
  if (value.status === 'directory') return <>
    <ul className="projects-library-directory-preview">{value.entries.map(entry => {
      const icon = <FileTypeIcon {...entry.type === 'directory' ? { kind: 'folder' as const } : { path: entry.name }} size={20} />
      const label = `${entry.name}${entry.type === 'directory' ? '/' : ''}`
      return <li key={entry.name}>{onRead === undefined ? <>{icon}<span>{label}</span></>
        : <ListRow className="projects-library-entry" icon={icon} trailing={<IconChevronRightOutlineRegular size={16} className="projects-library-chevron" />} onClick={event => onRead(entry.name, event.currentTarget)}>{label}</ListRow>}</li>
    })}</ul>
    {value.entries.length === 0 && <p className="projects-library-note">{copy('p3.library.emptyDirectoryRead')}</p>}
    {value.truncated && <p className="projects-library-note" role="status"><StateDot state="warning" />{copy('p3.library.directoryTruncated')}</p>}
  </>
  const body = previewText(value.base64, value.mediaType, value.absolutePath)
  return body === undefined ? <div className="projects-library-download"><h3>{copy('p3.library.noPreview')}</h3><p>{copy('p3.library.downloadHelp')}</p><a className="projects-ui__source-link" href={`data:${value.mediaType};base64,${value.base64}`} download={value.name}>{copy('p3.library.download')}</a></div> : <TextReadingContent text={body} view={view} copy={copy} />
}

function ReadTimestamp({ value, copy }: { readonly value: string; readonly copy: ProjectsTranslate }): ReactNode {
  return <time dateTime={value} title={value}>{formatUiDate(value, copy, { time: true })}</time>
}

function previewText(base64: string, mediaType: string, path: string): string | undefined {
  if (!mediaType.startsWith('text/') && mediaType !== 'application/json' && mediaType !== 'image/svg+xml' && !isMarkdownFile(path, mediaType)) return undefined
  try {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
    if (bytes.includes(0)) return undefined
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch { return undefined }
}
function sameLocation(left: LibraryFileLocation, right: LibraryFileLocation): boolean { return left.kind === 'project-file' ? right.kind === 'project-file' && left.relativePath === right.relativePath : right.kind === 'reference' && left.entryId === right.entryId && (left.relativePath ?? '') === (right.relativePath ?? '') }
function selectionKey(selection: LibrarySelection): string { const location = selection.location; return JSON.stringify(location.kind === 'project-file' ? [location.kind, location.relativePath] : [location.kind, location.entryId, location.relativePath ?? '']) }
function childSelection(selection: LibrarySelection, name: string): LibrarySelection {
  const location = selection.location
  const relativePath = [location.relativePath ?? '', name].filter(Boolean).join('/')
  return { ...selection, name, location: location.kind === 'project-file' ? { kind: 'project-file', relativePath } : { kind: 'reference', entryId: location.entryId, relativePath } }
}
function parentSelection(selection: LibrarySelection, copy: ProjectsTranslate): LibrarySelection | undefined {
  const location = selection.location
  if (!location.relativePath) return undefined
  const relativePath = location.relativePath.split('/').slice(0, -1).join('/')
  return { ...selection, name: relativePath.split('/').filter(Boolean).at(-1) ?? selection.entry?.name ?? copy(location.kind === 'project-file' ? 'p3.library.projectDirectory' : 'p3.library.explicitReference'), location: location.kind === 'project-file' ? { kind: 'project-file', relativePath } : { kind: 'reference', entryId: location.entryId, ...(relativePath === '' ? {} : { relativePath }) } }
}
function ownershipLabel(entry: LibraryEntry, copy: ProjectsTranslate): string { return copy(`p3.library.ownership.${entry.ownership}`) }
function targetLocation(target: LibraryTarget): string { return target.kind === 'url' ? target.url : target.path }
/** rc.5 原生 preload 的既有原件路径合同；Web 不模拟宿主路径。 */
interface HostPathBridge { pathFor(file: File): string }
function hostPathBridge(): HostPathBridge | undefined {
  const bridge = (globalThis as { __DSH_HOST_PATHS__?: HostPathBridge }).__DSH_HOST_PATHS__
  return typeof bridge?.pathFor === 'function' ? bridge : undefined
}
function absoluteHostPath(path: string): boolean { return typeof path === 'string' && (path.startsWith('/') || /^[a-z]:[\\/]/i.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path)) }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function failureLabel(reason: Extract<LibraryOpenResult, { status: 'unavailable' }>['reason'], copy: ProjectsTranslate): string { return copy(`p3.library.failure.${reason}`) }
