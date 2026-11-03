import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { Button, ErrorState, Feedback, IconCodeOutlineRegular, IconDatabaseOutlineRegular, IconGaugeOutlineRegular, IconSettingsOutlineRegular, Input, LoadingState, Modal, Select, SettingsShell, Tag, projectCopy, type ProjectsTranslate } from './ui/index.ts'
import type { ProjectDetail, ProjectEnvironmentView } from '../public-types.ts'
import { ExecutionDefaultsSettings, ProjectInstructionsSettings, SessionInstructionsSettings } from '../features/settings/client.ts'
import { UsagePanel } from '../features/usage/client.ts'
import type { ProjectsPanelActions } from './controller.ts'
import { MemorySettings } from './memory/MemorySettings.tsx'
import { applySettingsDraftDiscards, useSettingsDraftGuard, type RegisterSettingsDraftGuard, type SettingsDraftState } from './settings-drafts.ts'

type Page = 'general' | 'memory' | 'execution' | 'usage'
export interface ProjectSettingsProps {
  readonly detail: ProjectDetail
  readonly actions: Pick<ProjectsPanelActions, 'updateProject' | 'memoryActions' | 'executionDefaultsActions' | 'projectInstructionsActions' | 'sessionInstructionsActions' | 'settingsEnvironment' | 'usageActions'>
  readonly initialPage?: Page
  readonly initialSessionId?: string
  readonly initialMemoryId?: string
  readonly initialNameEditing?: boolean
  readonly onClose: () => void
  readonly mainModelControl?: ReactNode
  readonly runtimeNotice?: ReactNode
  readonly onOpenNativeModel: (sessionId: string) => void
  readonly translate?: ProjectsTranslate
}

/** A pending save may return focus only while the same editor still owns the gesture. */
function captureEditorFocus(form: HTMLFormElement): () => boolean {
  const document = form.ownerDocument
  let pending = true, ownsFocus = form.contains(document.activeElement)
  const movedFocus = (event: FocusEvent): void => {
    // Disabling the submitted native control can leave BODY as the browser's
    // fallback. Concrete focus destinations, rather than that fallback, revoke ownership.
    if (event.target instanceof Node && event.target !== document.body && event.target !== document.documentElement && !form.contains(event.target)) ownsFocus = false
  }
  const outsidePointer = (event: PointerEvent): void => { if (event.target instanceof Node && !form.contains(event.target)) ownsFocus = false }
  if (ownsFocus) {
    document.addEventListener('focusin', movedFocus)
    document.addEventListener('pointerdown', outsidePointer)
  }
  return () => {
    if (!pending) return false
    pending = false
    document.removeEventListener('focusin', movedFocus)
    document.removeEventListener('pointerdown', outsidePointer)
    const focused = document.activeElement
    return ownsFocus && (focused === null || focused === document.body || focused === document.documentElement || form.contains(focused))
  }
}

export function ProjectSettings(props: ProjectSettingsProps): ReactNode {
  return <ProjectSettingsProject key={props.detail.project.id} {...props} />
}

function ProjectSettingsProject({ detail, actions, initialPage = 'general', initialSessionId, initialMemoryId, initialNameEditing = false, onClose, onOpenNativeModel, mainModelControl, runtimeNotice, translate }: ProjectSettingsProps): ReactNode {
  const text = projectCopy(translate)
  const mainModelError = detail.modelInitializationErrors?.find(item => item.hostSessionId === detail.sessions.find(session => session.role === 'main')?.hostSessionId)
  const [page, setPage] = useState<Page>(initialPage)
  const [sessionId, setSessionId] = useState(initialSessionId ?? detail.project.mainSessionId ?? detail.sessions[0]?.id ?? '')
  const [savedName, setSavedName] = useState(detail.project.name)
  const [name, setName] = useState(detail.project.name)
  const [nameEditing, setNameEditing] = useState(initialNameEditing)
  const nameDraftVersion = useRef(0)
  const nameBaseRevision = useRef(detail.project.revision)
  const workspaceBaseRevision = useRef(detail.project.revision)
  const [savedWorkspace, setSavedWorkspace] = useState(detail.project.workspace?.path ?? '')
  const [workspace, setWorkspace] = useState(savedWorkspace)
  const [workspaceEditing, setWorkspaceEditing] = useState(false)
  const [workspaceNotice, setWorkspaceNoticeText] = useState('')
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const nameEditTrigger = useRef<HTMLButtonElement>(null)
  const workspaceEditTrigger = useRef<HTMLButtonElement>(null)
  const editorFocusReturn = useRef<{ field: 'name' | 'workspace'; form?: HTMLFormElement; finish?: () => boolean }>()
  const pendingFocusCaptures = useRef(new Set<() => boolean>())
  const queueEditorFocus = (field: 'name' | 'workspace', form?: HTMLFormElement, finish?: () => boolean): void => {
    const previous = editorFocusReturn.current?.finish
    if (previous !== undefined) { previous(); pendingFocusCaptures.current.delete(previous) }
    editorFocusReturn.current = { field, ...(form === undefined ? {} : { form }), ...(finish === undefined ? {} : { finish }) }
  }
  useEffect(() => () => { for (const finish of pendingFocusCaptures.current) finish(); pendingFocusCaptures.current.clear() }, [])
  useLayoutEffect(() => {
    const intent = editorFocusReturn.current
    if (intent === undefined) return
    editorFocusReturn.current = undefined
    const ownsFocus = intent.finish?.() ?? true
    if (intent.finish !== undefined) pendingFocusCaptures.current.delete(intent.finish)
    if (!ownsFocus) return
    if (page !== 'general') return
    const trigger = intent.field === 'name' ? nameEditTrigger.current : workspaceEditTrigger.current
    if (trigger === null || trigger.disabled || !trigger.isConnected || trigger.closest('[hidden], [inert], [aria-hidden="true"]') !== null) return
    if (intent.form !== undefined) {
      const document = intent.form.ownerDocument, focused = document.activeElement
      if (focused !== null && focused !== document.body && focused !== document.documentElement && !intent.form.contains(focused)) return
    }
    trigger.focus()
  })
  const [notice, setNoticeText] = useState('')
  const [busy, setBusy] = useState(false)
  const [navigationNotice, setNavigationNotice] = useState('')
  const [feedback, setFeedback] = useState<{ text: string; id: number }>()
  const feedbackSequence = useRef(0)
  const setWorkspaceNotice = (text: string): void => { setWorkspaceNoticeText(text); setFeedback(undefined) }
  const setNotice = (text: string): void => { setNoticeText(text); setFeedback(undefined) }
  const showFeedback = (text: string): void => { setFeedback({ text, id: ++feedbackSequence.current }) }
  const [environment, setEnvironment] = useState<ProjectEnvironmentView>()
  const [environmentError, setEnvironmentError] = useState('')
  const guards = useRef(new Map<string, () => SettingsDraftState>())
  const registerUnsavedGuard = useCallback<RegisterSettingsDraftGuard>((key, read) => {
    guards.current.set(key, read)
    return () => { if (guards.current.get(key) === read) guards.current.delete(key) }
  }, [])
  const [pendingNavigation, setPendingNavigation] = useState<{ continue: () => void }>()
  const requestNavigate = (continuation: () => void): void => {
    const states = [...guards.current.values()].map(read => read())
    if (states.some(state => state.busy)) { setNavigationNotice(text("p5.settings.navigation.busy")); return }
    if (states.some(state => state.dirty)) { setPendingNavigation({ continue: continuation }); return }
    setNavigationNotice(''); continuation()
  }
  const confirmNavigation = (): void => {
    if (pendingNavigation === undefined) return
    const states = [...guards.current.values()].map(read => read())
    if (!applySettingsDraftDiscards(states)) { setNavigationNotice(text("p5.settings.navigation.busy")); return }
    const continuation = pendingNavigation.continue
    flushSync(() => { setPendingNavigation(undefined); setNavigationNotice('') })
    continuation()
  }
  const close = (): void => { requestNavigate(onClose) }
  const changePage = (next: Page): void => { if (next !== page) requestNavigate(() => { setPage(next); setNotice('') }) }
  const discardName = (): void => { setName(savedName); setNameEditing(false) }
  const discardWorkspace = (): void => { setWorkspace(savedWorkspace); setWorkspaceEditing(false) }
  useSettingsDraftGuard(registerUnsavedGuard, 'project-name', { dirty: nameEditing && name !== savedName, busy, discard: discardName })
  useSettingsDraftGuard(registerUnsavedGuard, 'workspace-default', { dirty: workspaceEditing && workspace !== savedWorkspace, busy: workspaceBusy, discard: discardWorkspace })

  useEffect(() => { setSavedName(detail.project.name); if (!nameEditing && !busy) setName(detail.project.name) }, [detail.project.name])
  useEffect(() => { const path = detail.project.workspace?.path ?? ''; setSavedWorkspace(path); if (!workspaceEditing && !workspaceBusy) setWorkspace(path) }, [detail.project.workspace?.path])
  const saveWorkspace = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const form = event.currentTarget, finishFocus = captureEditorFocus(form)
    pendingFocusCaptures.current.add(finishFocus)
    setWorkspaceBusy(true); setWorkspaceNotice('')
    try {
      const saved = await actions.updateProject({ projectId: detail.project.id, expectedRevision: workspaceBaseRevision.current, workspace: workspace.trim() === '' ? null : { path: workspace.trim() } })
      if (saved.project.id !== detail.project.id) throw new Error(text("p3.memory.error.saveProject"))
      const path = saved.project.workspace?.path ?? ''
      workspaceBaseRevision.current = saved.project.revision
      queueEditorFocus('workspace', form, finishFocus)
      setWorkspace(path); setSavedWorkspace(path); setWorkspaceEditing(false); setEnvironment(undefined)
      showFeedback(text("p5.settings.workspace.saved"))
    } catch (error) {
      const failure = projectSaveFailure(error, detail.project.id)
      if (failure.current !== undefined) {
        workspaceBaseRevision.current = failure.current.project.revision
        setSavedWorkspace(failure.current.project.workspace?.path ?? '')
        setWorkspaceNotice(text("p5.settings.workspace.conflict", { value: failure.current.project.workspace?.path ?? text("p3.settings.workspace.internal") }))
      } else setWorkspaceNotice(failure.unknown ? text("p5.settings.workspace.saveUnconfirmed") : text("p5.settings.workspace.saveFailed"))
    }
    finally {
      if (editorFocusReturn.current?.finish !== finishFocus) { finishFocus(); pendingFocusCaptures.current.delete(finishFocus) }
      setWorkspaceBusy(false)
    }
  }
  const saveName = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const nextName = name.trim()
    if (nextName === '') { setNotice(text("p5.settings.name.required")); return }
    const form = event.currentTarget, finishFocus = captureEditorFocus(form)
    pendingFocusCaptures.current.add(finishFocus)
    const submittedVersion = nameDraftVersion.current
    setBusy(true); setNotice('')
    try {
      const saved = await actions.updateProject({ projectId: detail.project.id, expectedRevision: nameBaseRevision.current, name: nextName })
      if (saved.project.id !== detail.project.id) throw new Error(text("p3.memory.error.saveProject"))
      nameBaseRevision.current = saved.project.revision
      setSavedName(saved.project.name)
      if (nameDraftVersion.current === submittedVersion) {
        queueEditorFocus('name', form, finishFocus)
        setName(saved.project.name); setNameEditing(false); showFeedback(text("p5.settings.name.saved"))
      }
      else setNotice(text("p5.settings.name.submittedSaved"))
    } catch (error) {
      const failure = projectSaveFailure(error, detail.project.id)
      if (failure.current !== undefined) {
        nameBaseRevision.current = failure.current.project.revision
        setSavedName(failure.current.project.name)
        setNotice(text("p5.settings.name.conflict", { value: failure.current.project.name }))
      } else setNotice(failure.unknown ? text("p5.settings.name.saveUnconfirmed") : text("p5.settings.name.saveFailed"))
    }
    finally {
      if (editorFocusReturn.current?.finish !== finishFocus) { finishFocus(); pendingFocusCaptures.current.delete(finishFocus) }
      setBusy(false)
    }
  }
  useEffect(() => {
    let active = true
    setEnvironment(undefined); setEnvironmentError('')
    if (page === 'execution' && sessionId !== '') void actions.settingsEnvironment(detail.project.id, sessionId).then(value => {
      if (value.projectId !== detail.project.id || value.sessionId !== sessionId) throw new Error(text("p5.settings.location.wrongConversation"))
      if (active) setEnvironment(value)
    }).catch(() => { if (active) setEnvironmentError(text("p5.settings.location.unreadable")) })
    return () => { active = false }
  }, [actions.settingsEnvironment, detail.project.id, page, sessionId])
  const session = detail.sessions.find(item => item.id === sessionId)
  const pages = [
    { id: 'general', label: text('settings.nav.general'), icon: <IconSettingsOutlineRegular />, description: text('p3.settings.general.description') },
    { id: 'memory', label: text('settings.nav.memory'), icon: <IconDatabaseOutlineRegular />, description: text('p3.settings.memory.description') },
    { id: 'execution', label: text('settings.nav.execution'), icon: <IconCodeOutlineRegular />, description: text('p3.settings.execution.description') },
    { id: 'usage', label: text('settings.nav.usage'), icon: <IconGaugeOutlineRegular />, description: text('p3.settings.usage.description') },
  ] as const
  const selectedPage = pages.find(item => item.id === page)!
  const openSession = (id: string): void => { requestNavigate(() => onOpenNativeModel(id)) }

  return <SettingsShell<Page> open title={text('settings.window.title')} projectName={savedName} navigation={pages} activeId={page} onNavigate={changePage} onClose={close} closeLabel={text('settings.window.closeLabel')}
    footer={<><Button variant="outline" size="md" type="button" onClick={close}>{text('settings.close')}</Button></>}>
    {pendingNavigation !== undefined && <Modal open title={text('p3.settings.draft.title')} description={text('p3.settings.draft.description')} closeLabel={text('p3.settings.cancel')} onClose={() => setPendingNavigation(undefined)}
      footer={<><Button variant="outline" size="md" type="button" data-modal-autofocus onClick={() => setPendingNavigation(undefined)}>{text('p3.settings.cancel')}</Button><Button variant="primary" size="md" type="button" onClick={confirmNavigation}>{text('p3.settings.draft.discard')}</Button></>}>
      {navigationNotice && <p className="projects-ui__field-status" role="status">{navigationNotice}</p>}
    </Modal>}
    {feedback !== undefined && <Feedback key={feedback.id} text={feedback.text} tone="success" onDone={() => setFeedback(undefined)} />}
    {runtimeNotice}
    <p className="projects-ui__settings-section-intro">{selectedPage.description}</p>
    {navigationNotice && <p className="projects-ui__field-status" role="status">{navigationNotice}</p>}
    <div className="projects-ui__settings-content">
          {page === 'general' && <>
            <section className="dsp-form-section dsp-settings-section projects-ui__settings-row"><header className="dsp-settings-object-heading"><div><h3 className="projects-ui__settings-section-heading">{text('p3.settings.name.label')}</h3><p>{text('p3.settings.name.description')}</p></div>{!nameEditing && <Button ref={nameEditTrigger} variant="ghost" size="sm" type="button" onClick={() => { nameBaseRevision.current = detail.project.revision; setNameEditing(true); setNotice('') }}>{text('p3.settings.name.edit')}</Button>}</header>
              {!nameEditing ? <p className="dsp-settings-saved-value">{savedName}</p> : <form onSubmit={event => { void saveName(event) }} className="dsp-settings-form"><label className="dsp-field">{text('p3.settings.name.label')}<Input aria-label={text('p3.settings.name.label')} value={name} required onChange={event => { nameDraftVersion.current++; setName(event.target.value) }} /><small>{name !== savedName ? text('p3.settings.draft.unsaved') : text('p3.settings.draft.editing')}</small></label><div className="dsp-settings-actions"><Button variant="outline" size="md" type="button" disabled={busy} onClick={() => { queueEditorFocus('name'); discardName() }}>{text('p3.settings.draft.cancel')}</Button><Button variant="primary" size="md" type="submit" disabled={busy}>{busy ? text('p3.settings.saving') : text('p3.settings.name.save')}</Button></div></form>}{notice !== '' && <p className="projects-ui__field-status" role="status">{notice}</p>}
            </section>
            <section className="dsp-form-section dsp-settings-section projects-ui__settings-row"><header className="dsp-settings-object-heading"><div><h3 className="projects-ui__settings-section-heading">{text('p3.settings.main.title')}</h3><p>{text('p3.settings.main.description', { name: savedName })}</p></div><Tag tone="quiet">{text('p3.settings.main.current')}</Tag></header>
              <div className="projects-ui__settings-model-control">{mainModelError !== undefined ? <ErrorState inline title={text('p3.settings.model.unknown')} description={mainModelError.message} /> : mainModelControl ?? (detail.project.mainSessionId !== undefined && <Button variant="outline" size="md" type="button" onClick={() => openSession(detail.project.mainSessionId!)}>{text('p3.settings.main.openModel')}</Button>)}</div>
              <details className="dsp-settings-help"><summary>{text('p3.settings.model.help.title')}</summary><p>{text('p3.settings.model.help.description')}</p></details><Button variant="ghost" size="md" type="button" onClick={() => requestNavigate(() => { setSessionId(detail.project.mainSessionId ?? ''); setPage('execution') })}>{text('p3.settings.main.environment')}</Button>
            </section>
            <section className="dsp-form-section dsp-settings-section projects-ui__settings-row"><header className="dsp-settings-object-heading"><div><h3 className="projects-ui__settings-section-heading">{text('p3.settings.workspace.title')}</h3><p>{text('p3.settings.workspace.description')}</p></div>{!workspaceEditing && <Button ref={workspaceEditTrigger} variant="ghost" size="sm" type="button" onClick={() => { workspaceBaseRevision.current = detail.project.revision; setWorkspaceEditing(true); setWorkspaceNotice('') }}>{text('p3.settings.workspace.edit')}</Button>}</header>
              {!workspaceEditing ? <p className="dsp-settings-saved-value">{savedWorkspace || text('p3.settings.workspace.internal')}</p> : <form onSubmit={event => { void saveWorkspace(event) }} className="dsp-settings-form"><label className="dsp-field">{text('p3.settings.workspace.path')}<Input aria-label={text('p3.settings.workspace.pathLabel')} value={workspace} disabled={workspaceBusy} placeholder={text('p3.settings.workspace.placeholder')} onChange={event => setWorkspace(event.target.value)} /><small>{workspace !== savedWorkspace ? text('p3.settings.draft.unsaved') : text('p3.settings.draft.editing')}</small></label><div className="dsp-settings-actions"><Button variant="outline" size="md" type="button" disabled={workspaceBusy} onClick={() => { queueEditorFocus('workspace'); discardWorkspace() }}>{text('p3.settings.draft.cancel')}</Button><Button variant="primary" size="md" type="submit" disabled={workspaceBusy}>{workspaceBusy ? text('p3.settings.saving') : text('p3.settings.workspace.save')}</Button></div></form>}
              {workspaceNotice !== '' && <p className="projects-ui__field-status" role="status">{workspaceNotice}</p>}
            </section>
            <ExecutionDefaultsSettings translate={text} projectId={detail.project.id} actions={actions.executionDefaultsActions(detail.project.id)} registerUnsavedGuard={registerUnsavedGuard} />
            <details className="dsp-settings-help"><summary>{text('p3.settings.overview.help.title')}</summary><p>{text('p3.settings.overview.help.description')}</p></details>
          </>}
          {page === 'memory' && <MemorySettings translate={text} initialMemoryId={initialMemoryId} projectId={detail.project.id} actions={actions.memoryActions(detail.project.id)} scopeOptions={{ session: detail.sessions.map(item => ({ id: item.id, label: item.title })) }} registerUnsavedGuard={registerUnsavedGuard} requestNavigate={requestNavigate} requirements={<ProjectInstructionsSettings translate={text} projectId={detail.project.id} actions={actions.projectInstructionsActions(detail.project.id)} registerUnsavedGuard={registerUnsavedGuard} />} />}
          {page === 'execution' && <>
            <section className="dsp-form-section dsp-settings-section projects-ui__settings-row"><label className="dsp-field dsp-settings__session-select">{text('p3.settings.execution.select')}<Select aria-label={text('p3.settings.execution.selectLabel')} value={sessionId} onValueChange={value => requestNavigate(() => setSessionId(value))}>{detail.sessions.map(item => <option key={item.id} value={item.id}>{item.role === 'main' ? text('project.conversation.main') : text('project.conversation.execution')} · {item.title}</option>)}</Select></label><p className="dsp-settings-description">{text('p3.settings.execution.scope')}</p></section>
            <section className="dsp-form-section dsp-settings-section projects-ui__settings-row"><header className="dsp-settings-object-heading"><div><h3 className="projects-ui__settings-section-heading">{session?.role === 'main' ? text('p3.settings.main.title') : text('p3.settings.execution.title')} · {session?.title ?? text('p3.settings.execution.unavailable')}</h3><p>{text('p3.settings.execution.location')}</p></div></header>
              {environment?.sessionId === sessionId && environment.projectId === detail.project.id ? <p className="dsp-settings-saved-value">{environment.sessionDirectory ?? environment.message ?? text('p3.settings.execution.unreadable')}</p> : <>{environmentError ? <ErrorState inline title={environmentError} /> : <LoadingState label={text('p3.settings.execution.loading')} rows={1} />}</>}
              <p className="dsp-settings-description">{text('p3.settings.execution.viewOnly')}</p>{session !== undefined && <Button variant="outline" size="md" type="button" onClick={() => openSession(session.id)}>{text('p3.settings.execution.back')}</Button>}
            </section>
            {session !== undefined && <SessionInstructionsSettings translate={text} key={session.id} projectId={detail.project.id} sessionId={session.id} sessionTitle={session.title} actions={actions.sessionInstructionsActions(detail.project.id, session.id)} registerUnsavedGuard={registerUnsavedGuard} />}
            <div className="dsp-settings-related"><span>{text('p3.settings.requirements.related')}</span><Button variant="ghost" size="sm" type="button" onClick={() => changePage('memory')}>{text('p3.settings.requirements.open')}</Button></div>
            <details className="dsp-settings-help"><summary>{text('p3.settings.locations.title')}</summary>{environment?.sessionId === sessionId && environment.projectId === detail.project.id && <dl className="dsp-settings-locations"><dt>{text('p3.settings.locations.owned')}</dt><dd>{environment.projectDirectory}</dd><dt>{text('p3.settings.locations.default')}</dt><dd>{environment.configuredWorkspace ?? text('p3.settings.workspace.internal')}</dd></dl>}<p>{text('p3.settings.locations.description')}</p></details>
          </>}
          {page === 'usage' && <div className="dsp-settings-usage"><UsagePanel translate={text} projectId={detail.project.id} actions={actions.usageActions} /></div>}
    </div>
  </SettingsShell>
}

/** Consume serialized Remote failures without losing the user's draft or assuming a reject had no effect. */
function projectSaveFailure(error: unknown, projectId: string): { current?: ProjectDetail; unknown: boolean } {
  const failure = error as { code?: string; details?: { current?: ProjectDetail; effect?: string } } | null
  const current = failure?.code === 'projects/update-conflict' ? failure.details?.current : undefined
  return { ...(current?.project.id === projectId ? { current } : {}),
    unknown: failure?.code === 'projects/update-unconfirmed' || failure?.details?.effect === 'published-durability-unknown' }
}
