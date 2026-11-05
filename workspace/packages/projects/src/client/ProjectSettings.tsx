import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { Button, ErrorState, IconCodeOutlineRegular, IconDatabaseOutlineRegular, IconFolderOpenOutlineRegular, IconGaugeOutlineRegular, IconSettingsOutlineRegular, Input, LoadingState, Modal, Select, SettingsShell, projectCopy, type ProjectsTranslate } from './ui/index.ts'
import type { ProjectDetail, ProjectEnvironmentView } from '../public-types.ts'
import { ExecutionDefaultsSettings, ProjectInstructionsSettings, SessionInstructionsSettings } from '../features/settings/client.ts'
import { UsagePanel } from '../features/usage/client.ts'
import type { ProjectsPanelActions } from './controller.ts'
import { MemorySettings } from './memory/MemorySettings.tsx'
import { useProjectBasicsDraft } from './project-basics-draft.ts'
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
  readonly pickWorkspaceDirectory?: (() => Promise<string | null>) | undefined
  readonly readProject?: ((projectId: string) => Promise<ProjectDetail>) | undefined
  readonly translate?: ProjectsTranslate
}

export function ProjectSettings(props: ProjectSettingsProps): ReactNode {
  return <ProjectSettingsProject key={props.detail.project.id} {...props} />
}

function ProjectSettingsProject({ detail, actions, initialPage = 'general', initialSessionId, initialMemoryId, initialNameEditing = false, onClose, onOpenNativeModel, pickWorkspaceDirectory, readProject, mainModelControl, runtimeNotice, translate }: ProjectSettingsProps): ReactNode {
  const text = projectCopy(translate)
  const mainModelError = detail.modelInitializationErrors?.find(item => item.hostSessionId === detail.sessions.find(session => session.role === 'main')?.hostSessionId)
  const [page, setPage] = useState<Page>(initialPage)
  const [sessionId, setSessionId] = useState(initialSessionId ?? detail.project.mainSessionId ?? detail.sessions[0]?.id ?? '')
  const [navigationNotice, setNavigationNotice] = useState('')
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
  const changePage = (next: Page): void => { if (next !== page) requestNavigate(() => { setPage(next) }) }
  const basics = useProjectBasicsDraft(detail, actions.updateProject, text, () => setEnvironment(undefined), readProject)
  const { name, workspace } = basics.fields
  const fieldId = useId()
  const nameInput = useRef<HTMLInputElement>(null)
  const workspaceInput = useRef<HTMLInputElement>(null)
  const directoryButton = useRef<HTMLButtonElement>(null)
  const directoryRequest = useRef(0)
  const directoryPending = useRef(false)
  const [choosingDirectory, setChoosingDirectory] = useState(false)
  const [directoryError, setDirectoryError] = useState('')
  useEffect(() => () => { directoryRequest.current++; directoryPending.current = false }, [])
  const chooseDirectory = async (): Promise<void> => {
    if (pickWorkspaceDirectory === undefined || workspace.busy || workspace.checking || directoryPending.current) return
    const request = ++directoryRequest.current, version = workspace.version
    directoryPending.current = true; setChoosingDirectory(true); setDirectoryError('')
    try {
      const path = await pickWorkspaceDirectory()
      if (request !== directoryRequest.current || version !== workspace.version || path === null) return
      basics.change('workspace', path)
      // A new selection uses the same serialized writer; uncertainty still needs explicit retry.
      basics.save('workspace')
      const focused = workspaceInput.current?.ownerDocument.activeElement
      if (focused === workspaceInput.current || focused === directoryButton.current) workspaceInput.current?.focus()
    } catch {
      if (request === directoryRequest.current && version === workspace.version) setDirectoryError(text('create.workspace.choose.error'))
    } finally {
      if (request === directoryRequest.current) { directoryPending.current = false; setChoosingDirectory(false) }
    }
  }
  useLayoutEffect(() => { if (initialNameEditing) nameInput.current?.focus() }, [])
  useSettingsDraftGuard(registerUnsavedGuard, 'project-name', { dirty: name.draft !== name.saved, busy: name.busy || name.checking, discard: () => basics.discard('name') })
  useSettingsDraftGuard(registerUnsavedGuard, 'workspace-default', { dirty: workspace.draft !== workspace.saved, busy: workspace.busy || workspace.checking || choosingDirectory, discard: () => basics.discard('workspace') })
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

  return <SettingsShell<Page> open title={text('settings.window.title')} projectName={name.saved} navigation={pages} activeId={page} onNavigate={changePage} onClose={close} closeLabel={text('settings.window.closeLabel')}
    footer={<><Button variant="outline" size="md" type="button" onClick={close}>{text('settings.close')}</Button></>}>
    {pendingNavigation !== undefined && <Modal open title={text('p3.settings.draft.title')} description={text('p3.settings.draft.description')} closeLabel={text('p3.settings.cancel')} onClose={() => setPendingNavigation(undefined)}
      footer={<><Button variant="outline" size="md" type="button" data-modal-autofocus onClick={() => setPendingNavigation(undefined)}>{text('p3.settings.cancel')}</Button><Button variant="primary" size="md" type="button" onClick={confirmNavigation}>{text('p3.settings.draft.discard')}</Button></>}>
      {navigationNotice && <p className="projects-ui__field-status" role="status">{navigationNotice}</p>}
    </Modal>}
    {runtimeNotice}
    {(page === 'memory' || page === 'usage') && <p className="projects-ui__settings-section-intro">{selectedPage.description}</p>}
    {navigationNotice && <p className="projects-ui__field-status" role="status">{navigationNotice}</p>}
    <div className="projects-ui__settings-content">
          {page === 'general' && <>
            <section className="dsp-form-section dsp-settings-section dsp-settings-basics" aria-labelledby="dsp-settings-basics-title">
              <h3 id="dsp-settings-basics-title" className="projects-ui__settings-section-heading">{text('p5.settings.simple.basics')}</h3>
              {(['name', 'workspace'] as const).map(field => {
                const state = basics.fields[field]
                const label = text(field === 'name' ? 'p3.settings.name.label' : 'p3.settings.workspace.title')
                return <form key={field} className="dsp-settings-form" onSubmit={event => { event.preventDefault(); if (field !== 'workspace' || !directoryPending.current) basics.save(field, true) }}>
                  <div className="dsp-field"><label htmlFor={`${fieldId}-${field}`}>{label}</label><span className={field === 'workspace' ? 'dsh-projects__workspace-picker' : undefined}>
                    {field === 'workspace' && pickWorkspaceDirectory !== undefined && <Button ref={directoryButton} variant="outline" size="sm" type="button" icon={<IconFolderOpenOutlineRegular size={16} />}
                      aria-disabled={workspace.busy || workspace.checking || choosingDirectory} aria-busy={choosingDirectory || undefined} onClick={() => { void chooseDirectory() }}>{text(choosingDirectory ? 'create.workspace.choosing' : 'create.workspace.choose')}</Button>}
                    <Input id={`${fieldId}-${field}`} ref={field === 'name' ? nameInput : workspaceInput} aria-label={text(field === 'name' ? 'p3.settings.name.label' : 'p3.settings.workspace.pathLabel')} aria-describedby={field === 'workspace' && directoryError ? `${fieldId}-workspace-error` : undefined} value={state.draft} required={field === 'name'} placeholder={field === 'workspace' ? text('p3.settings.workspace.placeholder') : undefined}
                    onChange={event => { basics.change(field, event.target.value); if (field === 'workspace') setDirectoryError('') }} onBlur={event => {
                      if (pendingNavigation !== undefined) return
                      if (field === 'workspace' && (directoryPending.current || directoryButton.current !== null && event.relatedTarget === directoryButton.current)) return
                      basics.save(field)
                    }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); basics.discard(field); if (field === 'workspace') setDirectoryError('') } }} />
                    </span>
                    {field === 'workspace' && directoryError && <span id={`${fieldId}-workspace-error`} className="projects-ui__field-error" role="alert">{directoryError}</span>}
                    {field === 'workspace' && <small>{text('p5.settings.simple.workspaceHelp')}</small>}
                  </div>
                  <div className="dsp-settings-inline-status">{(state.busy || state.notice || state.confirmed) && <span className="projects-ui__field-status" role="status">{state.busy ? text('p3.settings.saving') : state.notice || text('p5.settings.simple.saved')}</span>}
                    {state.checking && <span className="projects-ui__field-status" role="status">{text('p5.settings.simple.rechecking')}</span>}
                    {state.readNotice && <span className="projects-ui__field-status" role="status">{state.readNotice}</span>}
                    {!state.busy && !state.checking && state.blocked && readProject !== undefined && <Button variant="outline" size="sm" type="button" onClick={() => basics.recheck(field)}>{text('p5.settings.simple.recheck')}</Button>}
                    {!state.busy && !state.checking && (state.blocked || state.notice !== '' && state.draft !== state.saved) && <Button variant="outline" size="sm" type="button" onClick={() => basics.save(field, true)}>{text('p5.settings.simple.retry')}</Button>}
                  </div>
                </form>
              })}
            </section>
            <section className="dsp-form-section dsp-settings-section dsp-settings-models" aria-labelledby="dsp-settings-models-title">
              <h3 id="dsp-settings-models-title" className="projects-ui__settings-section-heading">{text('p5.settings.simple.models')}</h3>
              <div className="dsp-settings-model-row"><div className="dsp-settings-model-label">{text('p5.settings.simple.mainModel')}<p>{text('p5.settings.simple.mainModelScope')}</p></div>
                <div className="projects-ui__settings-model-control">{mainModelError !== undefined ? <ErrorState inline title={text('p3.settings.model.unknown')} diagnostic={{ label: text('p5.panel.errorDetails'), content: mainModelError.message }} /> : mainModelControl ?? (detail.project.mainSessionId !== undefined && <Button variant="outline" size="md" type="button" onClick={() => openSession(detail.project.mainSessionId!)}>{text('p3.settings.main.openModel')}</Button>)}</div>
              </div>
              <ExecutionDefaultsSettings translate={text} projectId={detail.project.id} actions={actions.executionDefaultsActions(detail.project.id)} registerUnsavedGuard={registerUnsavedGuard} />
            </section>
          </>}
          {page === 'memory' && <MemorySettings translate={text} initialMemoryId={initialMemoryId} projectId={detail.project.id} actions={actions.memoryActions(detail.project.id)} scopeOptions={{ session: detail.sessions.map(item => ({ id: item.id, label: item.title })) }} registerUnsavedGuard={registerUnsavedGuard} requestNavigate={requestNavigate} requirements={<ProjectInstructionsSettings translate={text} projectId={detail.project.id} actions={actions.projectInstructionsActions(detail.project.id)} registerUnsavedGuard={registerUnsavedGuard} />} />}
          {page === 'execution' && <>
            <section className="dsp-form-section dsp-settings-section projects-ui__settings-row"><label className="dsp-field dsp-settings-session-row">{text('p3.settings.execution.select')}<Select aria-label={text('p3.settings.execution.selectLabel')} value={sessionId} onValueChange={value => requestNavigate(() => setSessionId(value))}>{detail.sessions.map(item => <option key={item.id} value={item.id}>{item.role === 'main' ? text('project.conversation.main') : text('project.conversation.execution')} · {item.title}</option>)}</Select></label></section>
            <section className="dsp-form-section dsp-settings-section dsp-settings-location" aria-label={text('p5.settings.simple.location')}>
              <span className="dsp-settings-model-label">{text('p5.settings.simple.location')}</span>
              {environment?.sessionId === sessionId && environment.projectId === detail.project.id ? <p className="dsp-settings-saved-value">{environment.sessionDirectory ?? environment.message ?? text('p3.settings.execution.unreadable')}</p> : <>{environmentError ? <ErrorState inline title={environmentError} /> : <LoadingState label={text('p3.settings.execution.loading')} rows={1} />}</>}
              <p className="dsp-settings-description">{text('p5.settings.simple.locationHelp')}</p>
            </section>
            {session !== undefined && <SessionInstructionsSettings translate={text} key={session.id} projectId={detail.project.id} sessionId={session.id} sessionTitle={session.title} actions={actions.sessionInstructionsActions(detail.project.id, session.id)} registerUnsavedGuard={registerUnsavedGuard} />}
            <div className="dsp-settings-related"><Button variant="outline" size="md" type="button" onClick={() => changePage('memory')}>{text('p3.settings.requirements.open')}</Button></div>
          </>}
          {page === 'usage' && <div className="dsp-settings-usage"><UsagePanel translate={text} projectId={detail.project.id} actions={actions.usageActions} /></div>}
    </div>
  </SettingsShell>
}
