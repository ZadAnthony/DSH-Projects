import React, { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { RefreshButton } from '../WorkflowControls.tsx'
import { Button, EmptyState, ErrorState, Feedback, IconArchiveOutlineRegular, IconChevronRightOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular, Input, LoadingState, Modal, Pill, Select, StateDot, Tag, Textarea, projectCopy, type ProjectsTranslate } from '../ui/index.ts'
import { applySettingsDraftDiscards, useSettingsDraftGuard, type RegisterSettingsDraftGuard } from '../settings-drafts.ts'
import type {
  MemoryDraft, MemoryScope, MemorySnapshot, StoredMemorySource, MemoryType, ProjectMemory,
  StoredMemoryDraft, StoredMemoryScope, MemoryWriteResult,
} from '../../memory-types.ts'
import type { ProjectMemorySettingsActions, ProjectMemorySourceView, ProjectMemorySourceContentRequest, ProjectMemorySourceContentPage } from '../../public-types.ts'
import { LEGACY_MEMORY_SCOPE_NOTICE, memoryMutationFailure } from '../../memory-types.ts'
import { emptyMemoryDraft, memoryDraftKey, memoryEditInput, memoryOutcome, memoryErrorText, scopeTargets, scopeWithTargets } from './memory-editor.ts'
import { formatUiDate } from '../ui/date-format.ts'

export interface MemorySettingsProps {
  projectId: string
  actions: ProjectMemorySettingsActions
  /** Same category and directory; the requirements keep their own save action. */
  requirements?: ReactNode
  registerUnsavedGuard?: RegisterSettingsDraftGuard
  beforeNavigate?: () => boolean
  requestNavigate?: (continuation: () => void) => void
  scopeOptions?: { session: readonly { id: string; label: string }[] }
  translate?: ProjectsTranslate
  /** Optional initial UI destination supplied by a memory notice. */
  initialMemoryId?: string
}

export function MemorySettings(props: MemorySettingsProps): ReactNode {
  return <MemorySettingsProject key={props.projectId} {...props} />
}

function MemorySettingsProject({ projectId, actions, scopeOptions, requirements, registerUnsavedGuard, beforeNavigate, requestNavigate, translate, initialMemoryId }: MemorySettingsProps): ReactNode {
  const copy = projectCopy(translate)
  const [snapshot, setSnapshot] = useState<MemorySnapshot>()
  const [filter, setFilter] = useState<MemoryType | 'all'>('all')
  const [query, setQuery] = useState('')
  // Visibility only: the editor, guard and request owners stay mounted at every width.
  const [pane, setPane] = useState<'list' | 'detail'>('list')
  const root = useRef<HTMLElement>(null)
  const listInvoker = useRef<HTMLElement>()
  const editor = useRef<HTMLFormElement>(null)
  const scopeTargetsField = useRef<HTMLSelectElement>(null)
  const scopeTargetsErrorId = useId()
  const [scopeTargetsError, setScopeTargetsError] = useState(false)
  const [detailRevealVersion, setDetailRevealVersion] = useState(0)
  const editorBody = useRef<HTMLTextAreaElement>(null)
  const editorEntryFocus = useRef(false)
  const addEntry = useRef<HTMLButtonElement>(null)
  const editEntry = useRef<HTMLButtonElement>(null)
  const readingTitle = useRef<HTMLHeadingElement>(null)
  const sourceEvidence = useRef<HTMLElement>(null)
  const focusEpoch = useRef(0)
  const editorReturnFocus = useRef<{ from: HTMLElement; epoch: number; version: number; memoryId?: string }>()
  const sourceReturnFocus = useRef<{ from: HTMLElement; epoch: number; version: number; sourceVersion: number }>()
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 899px)').matches === true)
  useLayoutEffect(() => {
    if (detailRevealVersion === 0 || narrow) return
    const detail = root.current?.querySelector<HTMLElement>('.dsp-memory-detail')
    const body = root.current?.closest<HTMLElement>('.projects-ui__settings-body')
    if (detail === undefined || detail === null || body === undefined || body === null) return
    const detailTop = detail.getBoundingClientRect().top, viewport = body.getBoundingClientRect()
    // Only the accepted directory gesture reveals the destination. The later
    // body response never resets a scroll position chosen while it was pending.
    if (detailTop < viewport.top || detailTop >= viewport.bottom) body.scrollTop += detailTop - viewport.top
  }, [detailRevealVersion])
  useEffect(() => {
    const media = root.current?.ownerDocument.defaultView?.matchMedia?.('(max-width: 899px)')
    if (media === undefined) return
    const update = (): void => setNarrow(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useLayoutEffect(() => {
    const element = root.current
    const focused = element?.ownerDocument.activeElement as HTMLElement | null
    if (element === null || focused === null || !element.contains(focused)) return
    const list = element.querySelector<HTMLElement>('.dsp-memory-list')!
    const detail = element.querySelector<HTMLElement>('.dsp-memory-detail')!
    const hiddenPane = pane === 'detail' ? list : detail
    if (!(narrow ? hiddenPane.contains(focused) : focused.matches('.dsp-memory-back, .dsp-memory-resume'))) return
    const invoker = listInvoker.current
    const target = pane === 'detail'
      ? narrow ? detail.querySelector<HTMLElement>('.dsp-memory-back') : detail
      : invoker?.isConnected && list.contains(invoker) && !invoker.matches(':disabled') && (narrow || !invoker.matches('.dsp-memory-resume')) ? invoker
        : list.querySelector<HTMLElement>('.dsp-memory-list-item[aria-current="true"]:not(:disabled)') ?? list.querySelector<HTMLElement>('input:not(:disabled)')
    const destination = target ?? (pane === 'detail' ? detail : list)
    destination.focus({ preventScroll: true })
  }, [pane, narrow])
  const [selectedMemoryId, setSelectedMemoryId] = useState<string>()
  const [current, setCurrent] = useState<ProjectMemory>()
  const [draft, setDraft] = useState<StoredMemoryDraft>()
  const [selection, setSelection] = useState<'memory' | 'requirements'>('memory')
  const [busy, setBusy] = useState(false)
  const [listBusy, setListBusy] = useState(false)
  const [listError, setListError] = useState<string>()
  const [bodyRead, setBodyRead] = useState<{ status: 'loading' } | { status: 'error'; message?: string; diagnostic?: string }>()
  const [editing, setEditing] = useState(false)
  useLayoutEffect(() => {
    if (!editing || !editorEntryFocus.current) return
    editorEntryFocus.current = false
    editorBody.current?.focus()
  }, [editing])
  const [notice, setNoticeText] = useState('')
  const [feedback, setFeedback] = useState<{ text: string; id: number }>()
  const feedbackSequence = useRef(0)
  const setNotice = (text: string): void => { setNoticeText(text); setFeedback(undefined) }
  const writeOutcome = (result: MemoryWriteResult): string => {
    if (result.kind !== 'failed' && result.kind !== 'partial') return memoryOutcome(result, copy)
    console.error('[dsh-projects]', copy('p5.panel.errorDetails'), result.message)
    return result.kind === 'failed' ? copy('p3.memory.writeFailed') : memoryOutcome({ ...result, message: '' }, copy).trim()
  }
  const writeError = (error: unknown): string => {
    console.error('[dsh-projects]', copy('p5.panel.errorDetails'), errorText(error))
    return memoryMutationFailure(error) === undefined ? copy('p3.memory.writeResultUnconfirmed') : memoryErrorText(error, copy)
  }
  const showFeedback = (text: string): void => { setFeedback({ text, id: ++feedbackSequence.current }) }
  const [writeUnconfirmed, setWriteUnconfirmed] = useState(false)
  const [sourceRead, setSourceRead] = useState<
    | { source: StoredMemorySource; status: 'loading' }
    | { source: StoredMemorySource; status: 'error'; message: string }
    | { source: StoredMemorySource; status: 'ready'; view: ProjectMemorySourceView }
    | { source: StoredMemorySource; status: 'ready'; text: string }
  >()
  const active = useRef(true)
  const requestVersion = useRef(0)
  const listRequestVersion = useRef(0)
  const sourceRequestVersion = useRef(0)
  const latestActions = useRef(actions)
  latestActions.current = actions
  useEffect(() => {
    const document = root.current?.ownerDocument
    if (document === undefined) return
    const moved = (): void => { focusEpoch.current++ }
    document.addEventListener('focusin', moved)
    document.addEventListener('pointerdown', moved, true)
    return () => { document.removeEventListener('focusin', moved); document.removeEventListener('pointerdown', moved, true) }
  }, [])
  useLayoutEffect(() => {
    const pending = editorReturnFocus.current
    if (pending === undefined || editing) return
    editorReturnFocus.current = undefined
    const element = root.current
    const focused = element?.ownerDocument.activeElement
    if (element === null || focused === undefined || pending.epoch !== focusEpoch.current || pending.version !== requestVersion.current || selection !== 'memory') return
    if (focused !== pending.from && focused !== element.ownerDocument.body && focused !== element.ownerDocument.documentElement) return
    const adding = pending.memoryId === undefined
    if (adding ? current !== undefined || selectedMemoryId !== undefined || pane !== 'list' : current?.id !== pending.memoryId || (narrow && pane !== 'detail')) return
    const target = adding ? addEntry.current : editEntry.current?.disabled ? readingTitle.current : editEntry.current
    target?.focus()
  }, [editing, pane, narrow, current?.id, selectedMemoryId, selection, busy])
  useLayoutEffect(() => {
    const pending = sourceReturnFocus.current
    if (pending === undefined || busy) return
    sourceReturnFocus.current = undefined
    const element = root.current
    const focused = element?.ownerDocument.activeElement
    if (element === null || pending.epoch !== focusEpoch.current || pending.version !== requestVersion.current || pending.sourceVersion !== sourceRequestVersion.current) return
    if (selection !== 'memory' || (narrow && pane !== 'detail') || sourceRead === undefined || sourceRead.status === 'loading') return
    if (focused !== pending.from && focused !== element.ownerDocument.body && focused !== element.ownerDocument.documentElement) return
    sourceEvidence.current?.focus()
  }, [busy, sourceRead, pane, narrow, selection])
  const editorFocusOwner = (): { from: HTMLElement; epoch: number; version: number } | undefined => {
    const focused = root.current?.ownerDocument.activeElement as HTMLElement | null
    return focused != null && editor.current?.contains(focused) ? { from: focused, epoch: focusEpoch.current, version: requestVersion.current } : undefined
  }
  const discard = (): void => { setDraft(current); setEditing(false); setWriteUnconfirmed(false); setScopeTargetsError(false) }
  const cancelEditor = (): void => {
    const owner = editorFocusOwner()
    if (owner !== undefined) editorReturnFocus.current = { ...owner, memoryId: current?.id }
    setPane(current === undefined ? 'list' : 'detail')
    discard()
  }
  const draftState = { dirty: editing && draft !== undefined && memoryDraftKey(draft) !== memoryDraftKey(current ?? emptyMemoryDraft()), busy, discard }
  useSettingsDraftGuard(registerUnsavedGuard, 'memory', draftState)
  const [pendingNavigation, setPendingNavigation] = useState<{ continue: () => void }>()
  const navigate = (continuation: () => void): void => {
    if (requestNavigate !== undefined) { requestNavigate(continuation); return }
    if (beforeNavigate !== undefined) { if (beforeNavigate()) continuation(); return }
    if (draftState.busy) return
    if (draftState.dirty) { setPendingNavigation({ continue: continuation }); return }
    continuation()
  }
  const confirmNavigation = (): void => {
    if (pendingNavigation === undefined || !applySettingsDraftDiscards([draftState])) return
    const continuation = pendingNavigation.continue
    flushSync(() => setPendingNavigation(undefined))
    continuation()
  }
  const clearSource = (): void => {
    sourceRequestVersion.current++
    sourceReturnFocus.current = undefined
    setSourceRead(undefined)
  }

  const read = async (id: string, reveal = true): Promise<void> => {
    const version = ++requestVersion.current
    // Navigation has already guarded edits; only this object's last saved body can remain during a reload.
    const retained = selection === 'memory' && selectedMemoryId === id ? current : undefined
    setSelectedMemoryId(id)
    if (reveal) setPane('detail')
    setSelection('memory'); setBusy(true); setBodyRead({ status: 'loading' }); setEditing(false)
    setDraft(retained); setCurrent(retained); clearSource(); setNotice(''); setWriteUnconfirmed(false)
    setScopeTargetsError(false)
    try {
      const value = await latestActions.current.read(id)
      if (!active.current || version !== requestVersion.current) return
      if (value === undefined) {
        setCurrent(undefined); setDraft(undefined); setBodyRead({ status: 'error', message: copy('p3.memory.removed') })
        await refresh(); return
      }
      if (value.projectId !== projectId) throw new Error(copy('p3.memory.error.bodyProject'))
      setCurrent(value); setDraft(value); setBodyRead(undefined)
    } catch (error) { if (active.current && version === requestVersion.current) setBodyRead({ status: 'error', diagnostic: errorText(error) }) }
    finally { if (active.current && version === requestVersion.current) setBusy(false) }
  }
  const refresh = async (selectFirst = false): Promise<void> => {
    const version = ++listRequestVersion.current
    const selectionVersion = requestVersion.current
    setListBusy(true); setListError(undefined)
    try {
      const value = await latestActions.current.list()
      if (!active.current || version !== listRequestVersion.current) return
      if (value.projectId !== projectId) throw new Error(copy('p3.memory.error.listProject'))
      setSnapshot(value)
      // Initial loading must not replace a draft or destination chosen while the list was pending.
      if (selectFirst && selectionVersion === requestVersion.current && value.entries[0] !== undefined) await read(value.entries[0].id, false)
    } catch (error) { if (active.current && version === listRequestVersion.current) setListError(errorText(error)) }
    finally { if (active.current && version === listRequestVersion.current) setListBusy(false) }
  }
  useEffect(() => {
    active.current = true
    void refresh(initialMemoryId === undefined)
    if (initialMemoryId !== undefined) void read(initialMemoryId)
    return () => { active.current = false; requestVersion.current++; listRequestVersion.current++; sourceRequestVersion.current++ }
  }, [])

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (draft === undefined || busy) return
    if (draft.scope.kind === 'session' && draft.scope.sessionIds.length === 0) {
      setScopeTargetsError(true); scopeTargetsField.current?.focus(); return
    }
    const focusOwner = editorFocusOwner()
    setBusy(true); clearSource(); setNotice('')
    try {
      const result = await latestActions.current.save(memoryEditInput(draft, current))
      if (!active.current) return
      setWriteUnconfirmed(false)
      if (result.kind === 'saved') {
        if (result.memory.projectId !== projectId) throw new Error(copy('p3.memory.error.saveProject'))
        if (focusOwner !== undefined && focusOwner.epoch === focusEpoch.current) editorReturnFocus.current = { ...focusOwner, memoryId: result.memory.id }
        setCurrent(result.memory); setDraft(result.memory); setEditing(false)
        setBodyRead(undefined)
        setSelectedMemoryId(result.memory.id)
        setNotice(''); showFeedback(writeOutcome(result))
      } else setNotice(writeOutcome(result))
      if (result.kind === 'partial' && result.operation === 'save') {
        try {
          const value = await latestActions.current.read(result.id)
          if (!active.current) return
          if (value === undefined) setBodyRead({ status: 'error', message: copy('p3.memory.removed') })
          else {
            if (value.projectId !== projectId) throw new Error(copy('p3.memory.error.saveProject'))
            setCurrent(value); setSelectedMemoryId(value.id); setBodyRead(undefined)
            // Readback owns saved facts and concurrency metadata, never the user's editable input.
            setDraft(previous => previous === undefined ? previous : { ...previous, sources: value.sources })
          }
        } catch (error) { if (active.current) setBodyRead({ status: 'error', diagnostic: errorText(error) }) }
      }
      await refresh()
    } catch (error) { if (active.current) {
      setNotice(writeError(error))
      if (memoryMutationFailure(error) !== undefined) setWriteUnconfirmed(true)
    } }
    finally { if (active.current) setBusy(false) }
  }
  const withdraw = async (): Promise<void> => {
    if (current === undefined || busy) return
    setPane('detail')
    setBusy(true); clearSource()
    try {
      const result = await latestActions.current.withdraw(current.id, current.revision, current.generation)
      if (!active.current) return
      if (result.kind === 'saved' || result.kind === 'withdrawn') { setNotice(''); showFeedback(writeOutcome(result)) }
      else setNotice(writeOutcome(result))
      setWriteUnconfirmed(false)
      if (result.kind === 'withdrawn' || (result.kind === 'partial' && result.operation === 'withdraw')) {
        setDraft(undefined); setCurrent(undefined); setSelectedMemoryId(undefined); setEditing(false)
        setBodyRead(undefined)
      }
      await refresh()
    } catch (error) { if (active.current) {
      setNotice(writeError(error))
      if (memoryMutationFailure(error) !== undefined) setWriteUnconfirmed(true)
    } }
    finally { if (active.current) setBusy(false) }
  }
  const readSource = async (source: StoredMemorySource): Promise<void> => {
    if ((latestActions.current.readSourceEvidence === undefined && latestActions.current.readSource === undefined) || busy) return
    const version = ++sourceRequestVersion.current
    const selectionVersion = requestVersion.current
    const focused = root.current?.ownerDocument.activeElement as HTMLElement | null
    sourceReturnFocus.current = focused?.matches('button') && root.current?.contains(focused) && focused.closest('.dsp-memory-sources, .dsp-memory-evidence') !== null
      ? { from: focused, epoch: focusEpoch.current, version: selectionVersion, sourceVersion: version } : undefined
    const ownsRequest = (): boolean => active.current && version === sourceRequestVersion.current && selectionVersion === requestVersion.current
    setPane('detail')
    setBusy(true); setSourceRead({ source, status: 'loading' })
    try {
      if (latestActions.current.readSourceEvidence !== undefined) {
        const value = await latestActions.current.readSourceEvidence(source)
        if (value.projectId !== projectId) throw new Error(copy('p3.memory.error.sourceProject'))
        if (ownsRequest()) setSourceRead({ source, status: 'ready', view: value })
      } else {
        const value = await latestActions.current.readSource!(source)
        if (ownsRequest()) setSourceRead({ source, status: 'ready', text: value })
      }
    } catch (error) { if (ownsRequest()) setSourceRead({ source, status: 'error', message: errorText(error) }) }
    finally { if (ownsRequest()) setBusy(false) }
  }
  const patch = (value: Partial<StoredMemoryDraft>): void => { setDraft(previous => previous === undefined ? previous : { ...previous, ...value }) }
  const previousSources = current?.originSources.filter(source => !current.sources.some(candidate => JSON.stringify(candidate) === JSON.stringify(source))) ?? []
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleEntries = snapshot?.entries.filter(item => (filter === 'all' || item.type === filter)
    && (normalizedQuery === '' || `${item.title} ${item.summary}`.toLocaleLowerCase().includes(normalizedQuery)))
  const isEmpty = snapshot?.entries.length === 0
  const addMemory = (): void => navigate(() => {
    setDetailRevealVersion(version => version + 1); setScopeTargetsError(false)
    requestVersion.current++; setSelection('memory'); setSelectedMemoryId(undefined); setPane('detail')
    setCurrent(undefined); setDraft(emptyMemoryDraft()); setEditing(true); setBodyRead(undefined); setNotice(''); clearSource()
  })
  const openMemory = (id: string): void => {
    // Preserve a loaded draft or pending read; a failed read with no content can retry.
    if (selection === 'memory' && selectedMemoryId === id && (current !== undefined || draft !== undefined || busy)) { setPane('detail'); setDetailRevealVersion(version => version + 1); return }
    navigate(() => { setDetailRevealVersion(version => version + 1); void read(id) })
  }
  const openRequirements = (): void => {
    if (selection === 'requirements') { setPane('detail'); setDetailRevealVersion(version => version + 1); return }
    navigate(() => { setDetailRevealVersion(version => version + 1); requestVersion.current++; setSelection('requirements'); setPane('detail'); setBodyRead(undefined); setNotice(''); clearSource() })
  }
  const hasDestination = selection === 'requirements' || draft !== undefined || selectedMemoryId !== undefined
  const destinationTitle = selection === 'requirements' ? copy('p3.memory.requirements')
    : current?.title || draft?.title || (selectedMemoryId === undefined ? copy('p3.memory.add') : copy('p3.memory.current'))
  const renderSource = (source: StoredMemorySource, index: number, previous = false): ReactNode => <div key={`${previous ? 'previous' : 'current'}-${index}`} className="projects-memory-source">
    <details className="dsp-memory-source-locator"><summary>{sourceTitle(source, copy)}</summary><p>{sourceLabel(source, copy)}</p></details>
    {(actions.readSourceEvidence !== undefined || actions.readSource !== undefined) && <Button variant="ghost" size="sm" type="button" disabled={busy} onClick={() => { void readSource(source) }}>{copy(previous ? 'p3.memory.source.previousAction' : 'p3.memory.source.action')}</Button>}
  </div>
  const sourceSection = draft === undefined ? null : <section className="dsp-memory-sources" aria-label={copy('p3.memory.source.label')}>
    <h3>{copy('p3.memory.source.current')}</h3>
    {draft.sources.map((source, index) => renderSource(source, index))}
    {draft.sources.length === 0 && <p className="dsp-settings-description">{copy('p3.memory.source.empty')}</p>}
    {previousSources.length > 0 && <details className="dsp-settings-help"><summary>{copy('p3.memory.source.previous', { count: previousSources.length })}</summary><p>{copy('p3.memory.source.previousDescription')}</p>{previousSources.map((source, index) => renderSource(source, index, true))}</details>}
    {current !== undefined && <details className="dsp-settings-help"><summary>{copy('p3.memory.source.metadata')}</summary><p>{copy('p3.memory.updated')}<time dateTime={current.updatedAt} title={current.updatedAt}>{formatUiDate(current.updatedAt, copy)}</time>{copy('p3.memory.revision', { revision: current.revision })}</p><p>{copy('p3.memory.updatedBy', { actor: current.updatedBy === 'project-settings-user' ? copy('p3.memory.settingsUser') : current.updatedBy })}</p><p>{current.path}</p><p>{copy('p3.memory.source.description')}</p></details>}
  </section>

  return <section ref={root} className="projects-memory dsp-theme" data-memory-pane={pane} aria-label={copy('p3.memory.label')} aria-busy={busy || listBusy}>
    {pendingNavigation !== undefined && <Modal open title={copy('p3.memory.unsaved.title')} description={copy('p3.memory.unsaved.description')} closeLabel={copy('p3.memory.cancel')} onClose={() => setPendingNavigation(undefined)}
      footer={<><Button variant="outline" size="md" type="button" data-modal-autofocus onClick={() => setPendingNavigation(undefined)}>{copy('p3.memory.cancel')}</Button><Button variant="primary" size="md" type="button" onClick={confirmNavigation}>{copy('p3.memory.unsaved.discard')}</Button></>} />}
    {feedback !== undefined && <Feedback key={feedback.id} text={feedback.text} tone="success" onDone={() => setFeedback(undefined)} />}
    {notice && <p role="status" className="projects-ui__field-status projects-memory-notice">{notice}</p>}
    {snapshot !== undefined && !snapshot.indexSynchronized && <p className="projects-ui__field-status" role="status">{copy('p3.memory.indexUnsynchronized')}</p>}
    {snapshot?.issues.map((issue, index) => <ErrorState inline key={index} title={issue.message === LEGACY_MEMORY_SCOPE_NOTICE ? LEGACY_MEMORY_SCOPE_NOTICE : copy('p3.memory.readIssues')}
      {...(issue.message === LEGACY_MEMORY_SCOPE_NOTICE ? {} : { diagnostic: { label: copy('p5.panel.errorDetails'), content: issue.message } })} />)}
    <div className="projects-memory-layout">
      <nav className="dsp-memory-list" tabIndex={-1} aria-label={copy('p3.memory.directory')} onFocusCapture={event => { listInvoker.current = event.target as HTMLElement }} onClickCapture={event => {
        const invoker = (event.target as Element).closest<HTMLElement>('button')
        if (invoker !== null) listInvoker.current = invoker
      }}>
        <div className="dsp-memory-toolbar">
          <Input className="dsp-memory-search" type="search" icon={<IconSearchOutlineRegular />} aria-label={copy('p3.memory.search')} placeholder={copy('p3.memory.search')} value={query} onChange={event => setQuery(event.target.value)} />
          <div className="dsp-settings-actions">
            {!isEmpty && <Button ref={addEntry} variant={editing || selection === 'requirements' ? 'ghost' : 'primary'} size="md" type="button" disabled={busy} onClick={addMemory}>{copy('p3.memory.add')}</Button>}
            <Button variant="ghost" size="sm" type="button" disabled={busy || listBusy} aria-busy={listBusy} aria-label={copy('p3.memory.refresh')} title={copy('p3.memory.refresh')} icon={listBusy ? <StateDot state="ongoing" /> : <IconRefreshOutlineRegular />} onClick={() => { void refresh() }} />
          </div>
        </div>
        {hasDestination && <Button variant="ghost" size="sm" className="dsp-memory-resume" type="button" onClick={() => setPane('detail')}>{copy(editing ? 'p3.memory.resumeDraft' : 'p3.memory.resume', { title: destinationTitle })}</Button>}
        {requirements !== undefined && <Button variant="ghost" size="md" className="dsp-memory-list-item dsp-memory-requirements" type="button" disabled={busy && selection !== 'requirements'} aria-current={selection === 'requirements' ? 'true' : undefined} onClick={openRequirements}><span className="dsp-memory-item-title"><strong>{copy('p3.memory.requirements')}</strong><IconChevronRightOutlineRegular className="dsp-memory-entry-arrow" size={16} aria-hidden="true" /></span><span>{copy('p3.memory.requirementsDescription')}</span></Button>}
        <header className="dsp-memory-list-heading"><strong>{copy('p3.memory.shared')}{snapshot === undefined ? '' : copy('p3.memory.count', { count: snapshot.entries.length })}</strong></header>
        <div className="dsp-memory-filter" role="group" aria-label={copy('p3.memory.typeFilter')}>
          <Pill active={filter === 'all'} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>{copy('p3.memory.all')}</Pill>
          {memoryTypes.map(type => <Pill key={type} active={filter === type} aria-pressed={filter === type} onClick={() => setFilter(type)}>{typeLabel(type, copy)}</Pill>)}
        </div>
        {listError !== undefined && <ErrorState inline={snapshot !== undefined} title={copy('p3.memory.listError')} description={snapshot !== undefined ? copy('whole.memory.previousList') : undefined} diagnostic={{ label: copy('p5.panel.errorDetails'), content: listError }}
          retry={busy || listBusy ? undefined : () => { void refresh() }} retryLabel={copy('p3.memory.retry')} />}
        {snapshot === undefined ? listError === undefined && <LoadingState label={copy('p3.memory.loadingList')} rows={3} /> : listError !== undefined ? null : isEmpty ? <EmptyState icon={<IconArchiveOutlineRegular size={32} />} title={copy('p3.memory.empty')} description={copy('p3.memory.emptyDescription')} actions={<Button ref={addEntry} variant={editing || selection === 'requirements' ? 'ghost' : 'primary'} size="md" disabled={busy} onClick={addMemory}>{copy('p3.memory.add')}</Button>} /> : null}
        <div role="status" aria-live="polite" aria-atomic="true">{snapshot !== undefined && listError === undefined && !isEmpty && visibleEntries?.length === 0 && <EmptyState title={copy('p3.memory.noMatches')} description={copy('p3.memory.noMatchesDescription')} />}</div>
        {visibleEntries?.map(item => {
          const selected = selection === 'memory' && selectedMemoryId === item.id
          return <Button variant="ghost" size="md" className="dsp-memory-list-item" key={item.id} type="button" disabled={busy && !selected} aria-current={selected ? 'true' : undefined}
            onClick={() => openMemory(item.id)}><span className="dsp-memory-item-title"><strong>{item.title}</strong><Tag tone="neutral">{typeLabel(item.type, copy)}</Tag><IconChevronRightOutlineRegular className="dsp-memory-entry-arrow" size={16} aria-hidden="true" /></span><span className="dsp-memory-item-summary">{item.summary}</span><span className="dsp-memory-item-meta"><time dateTime={item.updatedAt} title={item.updatedAt}>{copy('p3.memory.updated')}{formatUiDate(item.updatedAt, copy)}</time><span>{scopeLabel(item.scope, copy)}</span></span></Button>
        })}
      </nav>
      <div className="dsp-memory-detail" tabIndex={-1}>
        <Button variant="ghost" size="sm" className="dsp-memory-back" type="button" onClick={() => setPane('list')}>{copy('p3.memory.back')}</Button>
        {selection === 'memory' && bodyRead !== undefined && (bodyRead.status === 'loading'
          ? <LoadingState label={copy('p3.memory.loadingBody')} rows={draft === undefined ? 3 : 0} />
          : <ErrorState inline={draft !== undefined} title={copy('whole.memory.bodyError')} description={<>{bodyRead.message}{current !== undefined && <p>{copy('whole.memory.previousBody')}</p>}</>}
            {...(bodyRead.diagnostic === undefined ? {} : { diagnostic: { label: copy('p5.panel.errorDetails'), content: bodyRead.diagnostic } })}
            retry={busy || selectedMemoryId === undefined ? undefined : () => navigate(() => { void read(selectedMemoryId) })} retryLabel={copy('whole.memory.retryBody')} />)}
        {selection === 'requirements' ? requirements : draft === undefined ? bodyRead === undefined && <EmptyState icon={<IconArchiveOutlineRegular size={32} />} title={copy('p3.memory.detailEmpty')} description={copy('p3.memory.detailEmptyDescription')} /> : <>
          {!editing && current !== undefined ? <article className="dsp-memory-reading">
            <header className="dsp-memory-detail-heading"><div><h3 ref={readingTitle} tabIndex={-1}>{draft.title}</h3><p className="dsp-memory-item-meta"><Tag tone="neutral">{typeLabel(draft.type, copy)}</Tag><span>{copy('p3.memory.scopeValue', { scope: scopeLabel(draft.scope, copy) })}{draft.scope.kind === 'project' ? '' : ` · ${draft.scope.kind === 'session' ? draft.scope.sessionIds.map(id => scopeOptions?.session.find(item => item.id === id)?.label ?? id).join(copy("p5.common.listSeparator")) : scopeTargets(draft.scope)}`}</span><time dateTime={current.updatedAt} title={current.updatedAt}>{copy('p3.memory.updated')}{formatUiDate(current.updatedAt, copy)}</time></p></div><Button ref={editEntry} variant="ghost" size="md" type="button" disabled={busy} onClick={() => { editorEntryFocus.current = true; setPane('detail'); setEditing(true); setNotice('') }}>{copy('p3.memory.edit')}</Button></header>
            {draft.scope.kind === 'work' && <p className="projects-ui__field-status" role="alert">{LEGACY_MEMORY_SCOPE_NOTICE}{copy('p3.memory.legacyTargets', { targets: draft.scope.workIds.join(copy("p5.common.listSeparator")) })}</p>}
            <div className="dsp-memory-body" aria-label={copy('p3.memory.savedBody')}>{draft.body}</div>
            <details className="dsp-settings-help"><summary>{copy('p3.memory.summaryDetails')}</summary><p>{draft.summary}</p><p>{typeLabel(draft.type, copy)} · {natureLabel(draft.nature, copy)}</p></details>
          </article> : <form ref={editor} className="dsp-memory-edit-form" onSubmit={event => { void save(event) }}>
            <fieldset disabled={busy}><legend>{current === undefined ? copy('p3.memory.add') : copy('p3.memory.editTitle', { title: current.title })}</legend><small>{copy(writeUnconfirmed ? 'p3.memory.writeUnconfirmed' : draftState.dirty ? 'p3.memory.unsaved' : 'p3.memory.editing')}</small>
              <label className="dsp-field">{copy('p3.memory.scope')}<Select aria-label={copy('p3.memory.scope')} value={draft.scope.kind} onValueChange={value => { setScopeTargetsError(false); patch({ scope: scopeWithTargets(value as MemoryScope['kind'], '') }) }}>
                {draft.scope.kind === 'work' && <option value="work" disabled>{copy('p3.memory.scope.work')}</option>}
                <option value="project">{copy('p3.memory.scope.project')}</option><option value="session">{copy('p3.memory.scope.session')}</option><option value="file">{copy('p3.memory.scope.fileOrDirectory')}</option><option value="topic">{copy('p3.memory.scope.topic')}</option>
              </Select></label>
              {draft.scope.kind === 'work' && <p className="projects-ui__field-status" role="alert">{LEGACY_MEMORY_SCOPE_NOTICE}{copy('p3.memory.legacyTargets', { targets: draft.scope.workIds.join(copy("p5.common.listSeparator")) })}</p>}
              {draft.scope.kind === 'session' && <label className="dsp-field">{copy('p3.memory.targets')}<Select ref={scopeTargetsField} className="dsp-memory-targets" aria-label={copy('p3.memory.targets')} multiple required value={scopeTargets(draft.scope).split('\n').filter(Boolean)}
                aria-invalid={scopeTargetsError || undefined} aria-describedby={scopeTargetsError ? scopeTargetsErrorId : undefined}
                onInvalid={event => { if (event.currentTarget.validity.valueMissing) setScopeTargetsError(true) }}
                onValueChange={values => { setScopeTargetsError(false); patch({ scope: scopeWithTargets('session', values.join('\n')) }) }}>
                {scopeOptions?.session.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</Select>{scopeTargetsError && <small id={scopeTargetsErrorId} className="projects-ui__field-status" role="alert">{copy('p3.memory.targetsRequired')}</small>}{scopeOptions === undefined && <small>{copy('p3.memory.targetsUnavailable')}</small>}</label>}
              {(draft.scope.kind === 'file' || draft.scope.kind === 'topic') && <label className="dsp-field">{copy(draft.scope.kind === 'file' ? 'p3.memory.paths' : 'p3.memory.topics')}<Textarea required rows={2} value={scopeTargets(draft.scope)} onChange={event => patch({ scope: scopeWithTargets(draft.scope.kind === 'file' ? 'file' : 'topic', event.target.value, true) })} /></label>}
              <label className="dsp-field">{copy('p3.memory.body')}<Textarea ref={editorBody} aria-label={copy('p3.memory.bodyLabel')} required rows={10} value={draft.body} onChange={event => patch({ body: event.target.value })} /></label>
              <label className="dsp-field">{copy('p3.memory.title')}<Input aria-label={copy('p3.memory.titleLabel')} required value={draft.title} onChange={event => patch({ title: event.target.value })} /></label>
              <label className="dsp-field">{copy('p3.memory.summary')}<Textarea aria-label={copy('p3.memory.summaryLabel')} required rows={3} value={draft.summary} onChange={event => patch({ summary: event.target.value })} /><small>{copy('p3.memory.summaryDescription')}</small></label>
              <div className="projects-memory-row">
                <label className="dsp-field">{copy('p3.memory.type')}<Select aria-label={copy('p3.memory.type')} value={draft.type} onValueChange={value => { const type = value as MemoryType; patch({ type, ...(type === 'rule' ? { nature: 'confirmed' as const } : {}) }) }}>{memoryTypes.map(type => <option key={type} value={type}>{typeLabel(type, copy)}</option>)}</Select></label>
                <label className="dsp-field">{copy('p3.memory.nature')}<Select aria-label={copy('p3.memory.nature')} value={draft.nature} onValueChange={value => patch({ nature: value as MemoryDraft['nature'] })}><option value="confirmed">{copy('p3.memory.nature.confirmed')}</option><option value="verified" disabled={draft.type === 'rule'}>{copy('p3.memory.nature.verified')}</option><option value="unverified" disabled={draft.type === 'rule'}>{copy('p3.memory.nature.unverified')}</option></Select></label>
              </div>
              <div className="dsp-settings-actions"><Button variant="outline" size="md" type="button" onClick={cancelEditor}>{copy(current === undefined ? 'p3.memory.cancelAdd' : 'p3.memory.cancelEdit')}</Button><Button variant="primary" size="md" type="submit" disabled={draft.scope.kind === 'work'} icon={busy ? <StateDot state="ongoing" /> : undefined}>{copy(busy ? 'p3.memory.processing' : 'p3.memory.save')}</Button></div>
            </fieldset>
          </form>}
          {sourceSection}
          {sourceRead !== undefined && <section ref={sourceEvidence} tabIndex={-1} className="dsp-memory-evidence" aria-label={copy('p3.memory.source.evidence')}>
            <p className="dsp-settings-description dsp-memory-source-locator">{sourceTitle(sourceRead.source, copy)} · {sourceLabel(sourceRead.source, copy)}</p>
            {sourceRead.status === 'loading' && <LoadingState label={copy('whole.memory.loadingSource')} />}
            {sourceRead.status === 'error' && <ErrorState inline title={copy('whole.memory.sourceError')} diagnostic={{ label: copy('p5.panel.errorDetails'), content: sourceRead.message }}
              retry={busy ? undefined : () => { void readSource(sourceRead.source) }} retryLabel={copy('whole.memory.retrySource')} />}
            {sourceRead.status === 'ready' && 'view' in sourceRead && <MemorySourceEvidence key={JSON.stringify(sourceRead.source)} view={sourceRead.view} readContent={actions.readSourceContent}
              retry={() => { void readSource(sourceRead.source) }} copy={copy} />}
            {sourceRead.status === 'ready' && 'text' in sourceRead && <pre className="dsp-memory-source-text" aria-label={copy('p3.memory.source.content')}>{sourceRead.text}</pre>}
          </section>}
          {current !== undefined && <div className="dsp-memory-detail-footer"><RefreshButton translate={copy} disabled={busy} label={copy('p3.memory.reload')} onClick={() => navigate(() => { void read(current.id) })} /><Button variant="outline" size="md" type="button" disabled={busy} onClick={() => navigate(() => { void withdraw() })}>{copy('p3.memory.withdraw')}</Button></div>}
          <details className="dsp-settings-help"><summary>{copy('p3.memory.help')}</summary><p>{copy('p3.memory.helpDescription')}</p><p>{copy('p3.memory.saveDescription')}</p><p>{copy('p3.memory.withdrawDescription')}</p></details>
        </>}
      </div>
    </div>
  </section>
}

function MemorySourceEvidence({ view, readContent, retry, copy }: { readonly view: ProjectMemorySourceView; readonly readContent: ProjectMemorySettingsActions['readSourceContent']; readonly retry: () => void; readonly copy: ProjectsTranslate }): ReactNode {
  const [bodyFailure, setBodyFailure] = useState<string>()
  useEffect(() => {
    if (view.diagnostic !== undefined) console.error('[dsh-projects]', copy('p5.panel.errorDetails'), view.diagnostic)
  }, [view.diagnostic])
  if (!view.readable) return <ErrorState inline title={view.reason ?? copy('p3.memory.source.unreadable')} retry={retry} retryLabel={copy('whole.memory.retrySource')} />
  const bodies: ProjectMemorySourceContentRequest[] = (view.nativeItems ?? []).flatMap(item => item.isTarget && item.bodySource !== undefined ? [{ source: item.bodySource }] : [])
  if (view.source?.kind === 'communication-part') bodies.push({ record: view.source.record, delivery_id: view.source.deliveryId, snapshot_version: 1, part_id: view.source.partId })
  return <>
    {view.partial && <p className="projects-ui__field-status" role="status">{copy('p3.memory.source.partial')}</p>}
    {view.reason !== undefined && <p>{view.reason}</p>}
    {(view.limitations ?? []).map((text, index) => <p key={index}>{text}</p>)}
    {bodyFailure === undefined && view.text !== undefined && <pre className="dsp-memory-source-text" aria-label={copy('p3.memory.source.content')}>{view.text}</pre>}
    {readContent !== undefined && bodies.map((content, index) => <MemorySourceBody key={JSON.stringify(content)} content={content} read={readContent} label={copy('p3.memory.source.body', { number: index + 1 })} onStatus={setBodyFailure} copy={copy} />)}
  </>
}
function MemorySourceBody({ content, read, label, onStatus, copy }: { readonly onStatus: (error: string | undefined) => void; readonly content: ProjectMemorySourceContentRequest; readonly read: NonNullable<ProjectMemorySettingsActions['readSourceContent']>; readonly label: string; readonly copy: ProjectsTranslate }): ReactNode {
  const [page, setPage] = useState<ProjectMemorySourceContentPage>()
  const [text, setText] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const active = useRef(true)
  useEffect(() => () => { active.current = false }, [])
  const load = async (restart = false): Promise<void> => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const request = { ...content, ...(!restart && page?.next_cursor !== undefined ? { cursor: page.next_cursor } : {}) }
      const value = await read(request)
      if (!active.current) return
      onStatus(undefined)
      setText(previous => restart || page === undefined ? value.text : previous + value.text); setPage(value)
    } catch (caught) { if (active.current) { setText(''); setPage(undefined); setError(errorText(caught)); onStatus(errorText(caught)) } }
    finally { if (active.current) setBusy(false) }
  }
  return <div aria-label={label}>
    <Button variant="outline" size="md" type="button" disabled={busy} onClick={() => { void load(true) }}>{copy('p3.memory.source.readBody', { label })}</Button>
    {busy && <LoadingState label={copy('whole.memory.loadingSourceBody', { label })} />}
    {page !== undefined && <>
      <p>{copy('p3.memory.source.range', { start: page.range.start, end: page.range.end, total: page.range.total })}{copy(page.end_of_content ? 'p3.memory.source.end' : 'p3.memory.source.more')}</p>
      <pre className="dsp-memory-source-text" aria-label={copy('p3.memory.source.pageContent', { label })}>{text}</pre>
      {page.next_cursor !== undefined && <Button variant="outline" size="md" type="button" disabled={busy} onClick={() => { void load() }}>{copy('p3.memory.source.continue', { label })}</Button>}
    </>}
    {error && <ErrorState inline title={copy('whole.memory.sourceError')} description={copy('p3.memory.source.retryDescription')} diagnostic={{ label: copy('p5.panel.errorDetails'), content: error }} retry={busy ? undefined : () => { void load(true) }} retryLabel={copy('whole.memory.retrySourceBody', { label })} />}
  </div>
}

const memoryTypes: readonly MemoryType[] = ['rule', 'preference', 'background', 'fact', 'experience']
function typeLabel(type: MemoryType, copy: ProjectsTranslate): string {
  return copy(`p3.memory.type.${type}`)
}
function sourceLabel(source: StoredMemorySource, copy: ProjectsTranslate): string {
  switch (source.kind) {
    case 'native-event': return copy('p3.memory.source.locator.native', { sessionId: source.sessionId, hostSessionId: source.hostSessionId, eventType: source.eventType, eventSeq: source.eventSeq, body: source.body === undefined ? '' : ` · ${source.body.stream}${source.body.range === undefined ? '' : ` [${source.body.range.start}, ${source.body.range.end})`}` })
    case 'communication-part': return copy('p3.memory.source.locator.communication', { hostSessionId: source.holder.hostSessionId, deliveryId: source.deliveryId, partId: source.partId, version: source.snapshotVersion })
    case 'message': return copy('p3.memory.source.locator.message', { hostSessionId: source.hostSessionId, messageId: source.messageId })
    case 'tool': return copy('p3.memory.source.locator.tool', { hostSessionId: source.hostSessionId, toolCallId: source.toolCallId })
    case 'record': return copy('p3.memory.source.locator.record', { recordKind: source.recordKind, recordId: source.recordId, revision: source.revision })
    case 'file': return copy('p3.memory.source.locator.file', { path: source.path, locator: source.locator === undefined ? '' : ` · ${source.locator}` })
    case 'settings': return copy('p3.memory.source.locator.settings', { changeId: source.changeId })
  }
}
function scopeLabel(scope: StoredMemoryScope, copy: ProjectsTranslate): string {
  return copy(`p3.memory.scope.${scope.kind}`)
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function natureLabel(nature: MemoryDraft['nature'], copy: ProjectsTranslate): string {
  return copy(`p3.memory.nature.${nature}`)
}
function sourceTitle(source: StoredMemorySource, copy: ProjectsTranslate): string {
  return copy(`p3.memory.source.kind.${source.kind}`)
}
