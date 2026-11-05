import { projectCopy, type ProjectsTranslate } from '../../client/ui/copy.ts'
import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { RefreshButton } from '../../client/WorkflowControls.tsx'
import { Button, ErrorState, LoadingState, Modal, Select, Textarea } from '../../client/ui/index.ts'
import { applySettingsDraftDiscards, useSettingsDraftGuard, type RegisterSettingsDraftGuard } from '../../client/settings-drafts.ts'
import { settingsUnknownErrorText } from './types.ts'
import type {
  ExecutionDefaultsActions, ExecutionDefaultsView, ModelCatalogModel, ModelSelection, ProjectInstructions, ProjectInstructionsActions, SessionInstructions,
  SessionInstructionsActions,
} from './types.ts'

interface DraftProps { readonly registerUnsavedGuard?: RegisterSettingsDraftGuard; readonly translate?: ProjectsTranslate }
export interface ExecutionDefaultsSettingsProps extends DraftProps { projectId: string; actions: ExecutionDefaultsActions }
export interface ProjectInstructionsSettingsProps extends DraftProps { projectId: string; actions: ProjectInstructionsActions }
export interface SessionInstructionsSettingsProps extends DraftProps {
  projectId: string
  sessionId: string
  sessionTitle: string
  actions: SessionInstructionsActions
}

export function ExecutionDefaultsSettings(props: ExecutionDefaultsSettingsProps): ReactNode {
  return <ExecutionDefaultsForm key={props.projectId} {...props} />
}

function ExecutionDefaultsForm({ projectId, actions, registerUnsavedGuard, translate }: ExecutionDefaultsSettingsProps): ReactNode {
  const copy = projectCopy(translate)
  const [view, setView] = useState<ExecutionDefaultsView>()
  const [selection, setSelectionValue] = useState<ModelSelection | null>(null)
  const selectionDraftVersion = useRef(0)
  const setSelection = (value: ModelSelection | null): void => { selectionDraftVersion.current++; setSelectionValue(value) }
  const [compareSaved, setCompareSaved] = useState(false)
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const savingNow = useRef(false)
  const pendingSelection = useRef<{ selection: ModelSelection | null }>()
  const [readPending, setReadPending] = useState(true)
  const [readError, setReadError] = useState<string>()
  const readSequence = useRef(0)
  const busy = saving || readPending
  const [confirmRefresh, setConfirmRefresh] = useState(false)
  const mounted = useRef(true)
  const currentActions = useRef(actions)
  currentActions.current = actions
  const discard = (): void => { setSelection(view?.defaults.selection ?? null); setCompareSaved(false) }
  const draftState = { dirty: view !== undefined && JSON.stringify(selection) !== JSON.stringify(view.defaults.selection), busy, discard }
  useSettingsDraftGuard(registerUnsavedGuard, 'execution-default-model', draftState)
  const read = async (): Promise<void> => {
    const sequence = ++readSequence.current
    setReadPending(true); setReadError(undefined)
    try {
      const next = await currentActions.current.read()
      if (next.defaults.projectId !== projectId) throw new Error(copy('p5.settings.execution.defaultsWrongProject'))
      if (mounted.current && sequence === readSequence.current) { setView(next); setSelection(next.defaults.selection); setCompareSaved(false) }
    } catch (error) {
      if (mounted.current && sequence === readSequence.current) setReadError(errorText(error))
    } finally { if (mounted.current && sequence === readSequence.current) setReadPending(false) }
  }
  useEffect(() => {
    mounted.current = true; void read()
    return () => { mounted.current = false; readSequence.current++ }
  }, [])
  const requestRefresh = (): void => {
    if (draftState.busy) return
    if (draftState.dirty) setConfirmRefresh(true)
    else void read()
  }
  const confirmDiscardRefresh = (): void => {
    if (!applySettingsDraftDiscards([draftState])) return
    flushSync(() => setConfirmRefresh(false)); void read()
  }
  const routes = view?.catalog.kind === 'available'
    ? view.catalog.catalog.groups.flatMap(group => group.models.map(model => ({ provider: group.id, providerName: group.name, model }))) : []
  const selected = routes.find(route => selection?.provider === route.provider && selection.model === route.model.id)
  const savedSelection = view?.defaults.selection
  const saved = routes.find(route => savedSelection?.provider === route.provider && savedSelection.model === route.model.id)
  const savedLabel = savedSelection == null ? copy('p5.settings.execution.inheritDsh') : `${saved?.providerName ?? savedSelection.provider} / ${saved?.model.name ?? savedSelection.model}${savedSelection.reasoningEffort === undefined ? '' : ` · ${saved?.model.reasoning?.efforts.find(item => item.id === savedSelection.reasoningEffort)?.name ?? savedSelection.reasoningEffort}`}`
  const save = async (submitted: ModelSelection | null, expectedRevision = view?.defaults.revision): Promise<void> => {
    if (view === undefined || expectedRevision === undefined || readPending || savingNow.current) return
    const submittedVersion = selectionDraftVersion.current
    savingNow.current = true; setSaving(true); setNotice('')
    let savedRevision: number | undefined
    try {
      const result = await currentActions.current.save(submitted, expectedRevision)
      if (!mounted.current) return
      if (result.kind !== 'unavailable' && (result.kind === 'saved' ? result.value : result.current).projectId !== projectId) throw new Error(copy('p5.settings.execution.resultWrongProject'))
      if (result.kind === 'saved') {
        savedRevision = result.value.revision
        setView(previous => previous === undefined ? previous : { ...previous, defaults: result.value, status: { kind: submitted === null ? 'inherit' : 'available' } })
        if (selectionDraftVersion.current === submittedVersion || pendingSelection.current !== undefined && JSON.stringify(pendingSelection.current.selection) === JSON.stringify(result.value.selection)) {
          pendingSelection.current = undefined
          setSelection(result.value.selection); setCompareSaved(false); setNotice(copy('p5.settings.simple.saved'))
        } else if (pendingSelection.current !== undefined) { setCompareSaved(false) }
        else { setCompareSaved(true); setNotice(copy('p5.settings.execution.submittedSaved')) }
      } else if (result.kind === 'conflict') {
        // Availability belongs to the defaults/catalog pair returned by one real read.
        const next = await currentActions.current.read()
        if (!mounted.current) return
        if (next.defaults.projectId !== projectId) throw new Error(copy('p5.settings.execution.defaultsWrongProject'))
        setView(next); setCompareSaved(true); setReadError(undefined); setNotice(copy('p5.settings.execution.conflict'))
      } else {
        console.error('[dsh-projects]', copy('p5.panel.errorDetails'), result.message)
        setCompareSaved(true); setNotice(copy('p5.settings.execution.saveUnavailable'))
      }
    } catch (error) { if (mounted.current) {
      console.error('[dsh-projects]', copy('p5.panel.errorDetails'), error)
      setCompareSaved(true); setNotice(settingsUnknownErrorText(error) === undefined ? copy('p5.settings.execution.saveFailed') : copy('p5.settings.metadataUnconfirmed'))
    } }
    finally {
      savingNow.current = false
      const queued = pendingSelection.current
      pendingSelection.current = undefined
      if (mounted.current && savedRevision !== undefined && queued !== undefined) void save(queued.selection, savedRevision)
      else if (mounted.current) setSaving(false)
    }
  }
  const choose = (next: ModelSelection | null): void => {
    if (JSON.stringify(next) === JSON.stringify(selection)) return
    setSelection(next)
    if (savingNow.current) pendingSelection.current = { selection: next }
    else void save(next)
  }
  return <section className="projects-feature-settings dsp-theme dsp-form-section dsp-settings-model-row" aria-label={copy('p5.settings.simple.executionModel')}>
    {confirmRefresh && <Modal open title={copy('p3.memory.unsaved.title')} description={copy('p3.memory.unsaved.description')} closeLabel={copy('create.cancel')} onClose={() => setConfirmRefresh(false)}
      footer={<><Button variant="outline" size="md" type="button" data-modal-autofocus onClick={() => setConfirmRefresh(false)}>{copy('create.cancel')}</Button><Button variant="primary" size="md" type="button" onClick={confirmDiscardRefresh}>{copy('p3.memory.unsaved.discard')}</Button></>} />}
    <div className="dsp-settings-model-label">{copy('p5.settings.simple.executionModel')}<p>{copy('p5.settings.simple.executionModelScope')}</p></div>
    <div>
      {readError !== undefined && <ErrorState inline title={copy('wholeRead.defaults.failed')} diagnostic={{ label: copy('p5.panel.errorDetails'), content: readError }} />}
      {readPending && <LoadingState label={copy('p5.settings.execution.loading')} rows={1} />}
      {view?.catalog.kind === 'unavailable' && <ErrorState inline title={copy('p5.settings.execution.catalogUnavailable')} diagnostic={{ label: copy('p5.panel.errorDetails'), content: view.catalog.message }} />}
      {view?.catalog.kind === 'available' && view.catalog.catalog.failures.map(item => <ErrorState inline key={item.id} title={item.name} description={copy('p5.settings.execution.catalogUnavailable')} diagnostic={{ label: copy('p5.panel.errorDetails'), content: item.message }} />)}
      {view?.status.kind === 'unavailable' && <ErrorState inline title={copy('p5.settings.execution.savedUnavailable')} description={unavailableDefaultReason(view, copy)} diagnostic={{ label: copy('p5.panel.errorDetails'), content: view.status.message }} />}
      {compareSaved && view !== undefined && <section aria-label={copy('p5.settings.execution.savedLabel')}><p className="dsp-settings-description">{copy('p5.settings.savedRevisionPrefix')}{' '}{view.defaults.revision}{copy('p5.common.closeParenthesis')}</p><p className="dsp-settings-saved-value">{savedLabel}</p></section>}
      <div className="dsp-settings-form dsp-settings-model-grid">
        <label className="dsp-field">{copy('p5.settings.execution.modelField')}<Select disabled={view === undefined || readPending} aria-label={copy('p5.settings.execution.modelLabel')} value={selection === null ? '' : routeKey(selection.provider, selection.model)} onValueChange={value => {
          if (value === '') { choose(null); return }
          const route = routes.find(item => routeKey(item.provider, item.model.id) === value)
          if (route !== undefined) choose({ provider: route.provider, model: route.model.id })
        }}>
          <option value="">{copy('p5.settings.execution.inheritDsh')}</option>
          {selection !== null && selected === undefined && <option disabled value={routeKey(selection.provider, selection.model)}>{selection.provider} / {selection.model}{copy('p5.common.currentlyUnavailable')}</option>}
          {view?.catalog.kind === 'available' && view.catalog.catalog.groups.map(group => <optgroup key={group.id} label={group.name}>
            {group.models.map(model => <option key={model.id} value={routeKey(group.id, model.id)}>{model.name}</option>)}
          </optgroup>)}
        </Select></label>
        {selected?.model.reasoning !== undefined && <label className="dsp-field">{copy('p5.settings.execution.reasoning')}<Select disabled={view === undefined || readPending} aria-label={copy('p5.settings.execution.reasoning')} value={selection?.reasoningEffort ?? ''} onValueChange={value => {
          if (selection !== null) choose({ provider: selection.provider, model: selection.model, ...(value === '' ? {} : { reasoningEffort: value }) })
        }}>
          <option value="">{copy('p5.settings.execution.inheritModel')}{defaultEffortName(selected.model)}</option>
          {selection?.reasoningEffort !== undefined && !selected.model.reasoning.efforts.some(item => item.id === selection.reasoningEffort) && <option disabled value={selection.reasoningEffort}>{selection.reasoningEffort}{copy('p5.settings.execution.unsupportedSuffix')}</option>}
          {selected.model.reasoning.efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
        </Select></label>}
        {(notice || saving) && <p className="projects-ui__field-status" role="status">{saving ? copy('p3.settings.saving') : notice}</p>}
        {!saving && (draftState.dirty || compareSaved) && <div className="dsp-settings-actions"><Button variant="outline" size="sm" type="button" onClick={discard}>{copy('p3.memory.cancelEdit')}</Button><Button variant="primary" size="sm" type="button" onClick={() => { void save(selection) }}>{copy('p5.settings.simple.retry')}</Button></div>}
      </div>
      <RefreshButton translate={copy} disabled={busy} loading={readPending} label={copy('p5.settings.execution.refresh')} onClick={requestRefresh} />
    </div>
  </section>
}

export function SessionInstructionsSettings(props: SessionInstructionsSettingsProps): ReactNode {
  return <InstructionsForm key={`${props.projectId}/${props.sessionId}`} {...props} />
}
export function ProjectInstructionsSettings(props: ProjectInstructionsSettingsProps): ReactNode {
  return <InstructionsForm key={props.projectId} {...props} />
}

/** Keep the originating form's focus only until its success removes the action. */
function captureFormFocus(form: HTMLFormElement | null): () => boolean {
  if (form === null) return () => false
  const document = form.ownerDocument
  let pending = true, ownsFocus = form.contains(document.activeElement)
  const moved = (event: FocusEvent): void => {
    if (event.target instanceof Node && event.target !== document.body && event.target !== document.documentElement && !form.contains(event.target)) ownsFocus = false
  }
  const pointer = (event: PointerEvent): void => { if (event.target instanceof Node && !form.contains(event.target)) ownsFocus = false }
  if (ownsFocus) { document.addEventListener('focusin', moved); document.addEventListener('pointerdown', pointer) }
  return () => {
    if (!pending) return false
    pending = false
    document.removeEventListener('focusin', moved); document.removeEventListener('pointerdown', pointer)
    const focused = document.activeElement
    return ownsFocus && (focused === null || focused === document.body || focused === document.documentElement || form.contains(focused))
  }
}

const instructionTiming = "p5.settings.instructions.timing"
type InstructionsProps = ProjectInstructionsSettingsProps & { sessionId?: string; sessionTitle?: string; actions: ProjectInstructionsActions | SessionInstructionsActions }
function InstructionsForm({ projectId, sessionId, sessionTitle, actions, registerUnsavedGuard , translate}: InstructionsProps): ReactNode {
  const copy = projectCopy(translate)
  const project = sessionId === undefined
  const [value, setValue] = useState<ProjectInstructions | SessionInstructions>()
  const [instructions, setInstructionsText] = useState('')
  const instructionDraftVersion = useRef(0)
  const setInstructions = (text: string): void => { instructionDraftVersion.current++; setInstructionsText(text) }
  const [compareSaved, setCompareSaved] = useState(false)
  const [unconfirmed, setUnconfirmed] = useState(false)
  const [notice, setNoticeText] = useState('')
  const setNotice = setNoticeText
  const textarea = useRef<HTMLTextAreaElement>(null)
  const pendingFocus = useRef<() => boolean>()
  const focusCaptures = useRef(new Set<() => boolean>())
  useEffect(() => () => { for (const finish of focusCaptures.current) finish(); focusCaptures.current.clear() }, [])
  const savingNow = useRef(false)
  const [busy, setBusy] = useState(false)
  const [readPending, setReadPending] = useState(true)
  const readSequence = useRef(0)
  const [confirmRefresh, setConfirmRefresh] = useState(false)
  const mounted = useRef(true)
  const currentActions = useRef(actions)
  currentActions.current = actions
  const discard = (): void => { setInstructions(value?.instructions ?? ''); setCompareSaved(false); setUnconfirmed(false); setNotice('') }
  const draftState = { dirty: value !== undefined && instructions !== value.instructions, busy, discard }
  useLayoutEffect(() => {
    const finish = pendingFocus.current, target = textarea.current
    if (finish === undefined || busy || draftState.dirty || target === null) return
    pendingFocus.current = undefined; focusCaptures.current.delete(finish)
    if (finish() && target.isConnected && target.closest('[hidden], [inert], [aria-hidden="true"]') === null) target.focus()
  })
  useSettingsDraftGuard(registerUnsavedGuard, project ? 'project-instructions' : `session-instructions:${sessionId}`, draftState)
  const validate = (next: ProjectInstructions | SessionInstructions): void => {
    if (next.projectId !== projectId || (!project && (!('sessionId' in next) || next.sessionId !== sessionId))) throw new Error(copy("p5.settings.instructions.wrongScope"))
  }
  const read = async (): Promise<void> => {
    const sequence = ++readSequence.current
    setBusy(true); setReadPending(true)
    try {
      const next = await currentActions.current.read()
      validate(next)
      if (mounted.current && sequence === readSequence.current) { setValue(next); setInstructions(next.instructions); setNotice(''); setUnconfirmed(false); setCompareSaved(false) }
    } catch (error) {
      if (mounted.current && sequence === readSequence.current) {
        console.error('[dsh-projects]', copy('p5.panel.errorDetails'), error)
        setValue(undefined); setInstructions(''); setNotice(copy('p5.settings.instructions.readUnavailable', { value: project ? copy('list.title') : copy('project.overview.title') }))
      }
    } finally { if (mounted.current && sequence === readSequence.current) { setBusy(false); setReadPending(false) } }
  }
  useEffect(() => {
    mounted.current = true
    void read()
    return () => { mounted.current = false; readSequence.current++ }
  }, [])
  const save = async (text: string): Promise<void> => {
    if (value === undefined || busy || savingNow.current) return
    const submittedVersion = instructionDraftVersion.current
    const finishFocus = captureFormFocus(textarea.current?.closest('form') ?? null)
    focusCaptures.current.add(finishFocus)
    savingNow.current = true
    setBusy(true); setNotice('')
    try {
      const result = await currentActions.current.save(text, value.revision)
      if (!mounted.current) return
      if (result.kind === 'unavailable') { setNotice(copy("p5.settings.instructions.notSaved", { value: project ? copy("list.title") : copy("project.overview.title") }) + result.message); return }
      const next = result.kind === 'saved' ? result.value : result.current
      validate(next); setValue(next); setUnconfirmed(false)
      if (result.kind === 'conflict') {
        setCompareSaved(true); setNotice(copy("p5.settings.instructions.conflict", { value: project ? copy("list.title") : copy("project.overview.title") }))
      } else if (instructionDraftVersion.current === submittedVersion) {
        pendingFocus.current = finishFocus
        setInstructions(next.instructions); setCompareSaved(false)
        setNotice(copy('p5.settings.simple.saved'))
      } else {
        setCompareSaved(true); setNotice(copy("p5.settings.instructions.submittedSaved", { value: project ? copy("list.title") : copy("project.overview.title") }))
      }
    } catch (error) { if (mounted.current) {
      console.error('[dsh-projects]', copy('p5.panel.errorDetails'), error)
      const unknown = settingsUnknownErrorText(error) === undefined ? undefined : copy('p5.settings.metadataUnconfirmed')
      setUnconfirmed(unknown !== undefined)
      setNotice(unknown ?? copy('p5.settings.instructions.saveUnconfirmed', { value: project ? copy('list.title') : copy('project.overview.title') }))
    } }
    finally {
      if (pendingFocus.current !== finishFocus) { finishFocus(); focusCaptures.current.delete(finishFocus) }
      savingNow.current = false; if (mounted.current) setBusy(false)
    }
  }
  const requestRefresh = (): void => {
    if (draftState.busy) return
    if (draftState.dirty) setConfirmRefresh(true)
    else void read()
  }
  const confirmDiscardRefresh = (): void => {
    if (!applySettingsDraftDiscards([draftState])) return
    flushSync(() => setConfirmRefresh(false)); void read()
  }
  const title = project ? copy("p3.memory.requirements") : copy("p5.settings.instructions.conversationTitle")
  return <section className="projects-feature-settings dsp-theme dsp-form-section" aria-label={project ? copy("tool.card.target.project") : copy("p5.settings.instructions.conversationLabel")}>
    {confirmRefresh && <Modal open title={copy("p3.memory.unsaved.title")} description={copy("p3.memory.unsaved.description")} closeLabel={copy("create.cancel")} onClose={() => setConfirmRefresh(false)}
      footer={<><Button variant="outline" size="md" type="button" data-modal-autofocus onClick={() => setConfirmRefresh(false)}>{copy("create.cancel")}</Button><Button variant="primary" size="md" type="button" onClick={confirmDiscardRefresh}>{copy("p3.memory.unsaved.discard")}</Button></>} />}
    <header className="dsp-settings-object-heading"><div><h3>{title}</h3><p>{project ? copy('p5.settings.instructions.projectDescription') : copy('p5.settings.instructions.conversationDescription', { value: sessionTitle ?? sessionId })}</p></div></header>
    <p className="dsp-settings-description">{copy(instructionTiming)}</p>
    {notice && <p className="projects-ui__field-status" role="status">{notice}</p>}
    {compareSaved && value !== undefined && <section aria-label={copy('p5.settings.instructions.savedLabel', { value: project ? copy('list.title') : copy('project.overview.title') })}><p className="dsp-settings-description">{copy('p5.settings.savedRevisionPrefix')}{' '}{value.revision}{copy('p5.common.closeParenthesis')}</p><div className="dsp-settings-saved-prose">{value.instructions || (project ? copy('p5.settings.instructions.projectEmpty') : copy('p5.settings.instructions.conversationEmpty'))}</div></section>}
    <form className="dsp-settings-form dsp-settings-direct-instructions" onSubmit={event => { event.preventDefault(); void save(instructions) }}>
      <label className="dsp-field">{project ? copy('p5.settings.instructions.projectField') : copy('p5.settings.instructions.conversationField')}<Textarea ref={textarea} disabled={value === undefined || readPending} aria-label={project ? copy('p5.settings.instructions.projectField') : copy('p5.settings.instructions.conversationField')} rows={7} value={instructions} onChange={event => setInstructions(event.target.value)} />{(unconfirmed || draftState.dirty) && <small>{unconfirmed ? copy('p3.memory.writeUnconfirmed') : copy('p3.memory.unsaved')}</small>}</label>
      {(draftState.dirty || unconfirmed || busy && value !== undefined) && <div className="dsp-settings-actions"><Button variant="outline" size="md" type="button" disabled={busy} onClick={() => { discard(); textarea.current?.focus() }}>{copy('p3.memory.cancelEdit')}</Button><Button variant="primary" size="md" type="submit" disabled={value === undefined || busy}>{busy ? copy('p3.settings.saving') : project ? copy('p5.settings.instructions.saveProject') : copy('p5.settings.instructions.saveConversation')}</Button></div>}
    </form>
    <RefreshButton translate={copy} disabled={busy} loading={busy} label={project ? copy('p5.settings.instructions.reloadProject') : copy('p5.settings.instructions.reloadConversation')} onClick={requestRefresh} />

    <details className="dsp-settings-help"><summary>{copy("p5.settings.instructions.scopeTitle")}</summary><p>{copy("p5.settings.instructions.scopeHelp")}</p><p>{copy("p5.settings.instructions.noModelStart")}</p></details>
  </section>
}

function routeKey(provider: string, model: string): string { return JSON.stringify([provider, model]) }
/** Availability reasons come from the same structured read as the saved selection. */
function unavailableDefaultReason(view: ExecutionDefaultsView, copy: ProjectsTranslate): string | undefined {
  if (view.catalog.kind === 'unavailable') return copy('p5.settings.execution.catalogUnavailable')
  const selection = view.defaults.selection
  if (selection === null) return undefined
  const catalog = view.catalog.catalog
  const model = catalog.groups.find(group => group.id === selection.provider)?.models.find(item => item.id === selection.model)
  if (model === undefined || !catalog.routableProviders.includes(selection.provider)) return copy('p5.settings.execution.modelUnavailable')
  if (selection.reasoningEffort !== undefined && !model.reasoning?.efforts.some(item => item.id === selection.reasoningEffort)) return copy('p5.settings.execution.reasoningUnavailable')
  return undefined
}
function defaultEffortName(model: ModelCatalogModel): string {
  const id = model.reasoning?.defaultEffort
  if (id === undefined) return ''
  const effort = model.reasoning?.efforts.find(item => item.id === id)
  return `（${effort?.name ?? id}）`
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
