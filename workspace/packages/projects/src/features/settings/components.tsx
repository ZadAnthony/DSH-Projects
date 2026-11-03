import { projectCopy, type ProjectsTranslate } from '../../client/ui/copy.ts'
import React, { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { RefreshButton } from '../../client/WorkflowControls.tsx'
import { Button, ErrorState, Feedback, LoadingState, Modal, Select, Textarea } from '../../client/ui/index.ts'
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

function ExecutionDefaultsForm({ projectId, actions, registerUnsavedGuard , translate}: ExecutionDefaultsSettingsProps): ReactNode {
  const copy = projectCopy(translate)
  const [view, setView] = useState<ExecutionDefaultsView>()
  const [selection, setSelectionValue] = useState<ModelSelection | null>(null)
  const selectionDraftVersion = useRef(0)
  const setSelection = (value: ModelSelection | null): void => { selectionDraftVersion.current++; setSelectionValue(value) }
  const [compareSaved, setCompareSaved] = useState(false)
  const [editing, setEditing] = useState(false)
  const [notice, setNoticeText] = useState('')
  const [feedback, setFeedback] = useState<{ text: string; id: number }>()
  const feedbackSequence = useRef(0)
  const setNotice = (text: string): void => { setNoticeText(text); setFeedback(undefined) }
  const showFeedback = (text: string): void => { setFeedback({ text, id: ++feedbackSequence.current }) }
  const [saving, setSaving] = useState(false)
  const [readPending, setReadPending] = useState(true)
  const [readError, setReadError] = useState<string>()
  const readSequence = useRef(0)
  const busy = saving || readPending
  const [confirmRefresh, setConfirmRefresh] = useState(false)
  const mounted = useRef(true)
  const currentActions = useRef(actions)
  currentActions.current = actions
  const discard = (): void => { setSelection(view?.defaults.selection ?? null); setEditing(false); setCompareSaved(false) }
  const draftState = { dirty: editing && JSON.stringify(selection) !== JSON.stringify(view?.defaults.selection ?? null), busy, discard }
  useSettingsDraftGuard(registerUnsavedGuard, 'execution-default-model', draftState)
  const read = async (): Promise<void> => {
    const sequence = ++readSequence.current
    setReadPending(true); setReadError(undefined)
    try {
      const next = await currentActions.current.read()
      if (next.defaults.projectId !== projectId) throw new Error(copy("p5.settings.execution.defaultsWrongProject"))
      if (mounted.current && sequence === readSequence.current) { setView(next); setSelection(next.defaults.selection); setEditing(false); setCompareSaved(false) }
    } catch (error) {
      if (mounted.current && sequence === readSequence.current) setReadError(errorText(error))
    } finally { if (mounted.current && sequence === readSequence.current) setReadPending(false) }
  }
  useEffect(() => {
    mounted.current = true
    void read()
    return () => { mounted.current = false; readSequence.current++ }
  }, [])
  const refresh = (): void => { void read() }
  const requestRefresh = (): void => {
    if (draftState.busy) return
    if (draftState.dirty) setConfirmRefresh(true)
    else refresh()
  }
  const confirmDiscardRefresh = (): void => {
    if (!applySettingsDraftDiscards([draftState])) return
    flushSync(() => setConfirmRefresh(false)); refresh()
  }
  const routes = view?.catalog.kind === 'available'
    ? view.catalog.catalog.groups.flatMap(group => group.models.map(model => ({ provider: group.id, providerName: group.name, model }))) : []
  const selected = routes.find(route => selection?.provider === route.provider && selection.model === route.model.id)
  const savedSelection = view?.defaults.selection
  const saved = routes.find(route => savedSelection?.provider === route.provider && savedSelection.model === route.model.id)
  const savedLabel = savedSelection == null ? copy("p5.settings.execution.inheritDsh") : `${saved?.providerName ?? savedSelection.provider} / ${saved?.model.name ?? savedSelection.model}${savedSelection.reasoningEffort === undefined ? '' : ` · ${saved?.model.reasoning?.efforts.find(item => item.id === savedSelection.reasoningEffort)?.name ?? savedSelection.reasoningEffort}`}`
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (view === undefined || busy) return
    const submittedVersion = selectionDraftVersion.current
    setSaving(true); setNotice('')
    try {
      const result = await currentActions.current.save(selection, view.defaults.revision)
      if (!mounted.current) return
      if (result.kind !== 'unavailable' && (result.kind === 'saved' ? result.value : result.current).projectId !== projectId) throw new Error(copy("p5.settings.execution.resultWrongProject"))
      if (result.kind === 'saved') {
        setView(previous => previous === undefined ? previous : { ...previous, defaults: result.value, status: { kind: selection === null ? 'inherit' : 'available' } })
        if (selectionDraftVersion.current === submittedVersion) {
          setSelection(result.value.selection); setEditing(false); setCompareSaved(false)
          showFeedback(copy("p5.settings.execution.saved"))
        } else {
          setCompareSaved(true); setNotice(copy("p5.settings.execution.submittedSaved"))
        }
      } else if (result.kind === 'conflict') {
        // Availability belongs to the defaults/catalog pair returned by the same read.
        const next = await currentActions.current.read()
        if (!mounted.current) return
        if (next.defaults.projectId !== projectId) throw new Error(copy("p5.settings.execution.defaultsWrongProject"))
        setView(next); setCompareSaved(true); setReadError(undefined)
        setNotice(copy("p5.settings.execution.conflict"))
      } else setNotice(result.message)
    } catch (error) { if (mounted.current) setNotice(settingsUnknownErrorText(error) === undefined ? errorText(error) : copy('p5.settings.metadataUnconfirmed')) }
    finally { if (mounted.current) setSaving(false) }
  }

  return <section className="projects-feature-settings dsp-theme dsp-form-section" aria-label={copy("p5.settings.execution.title")}>
    {confirmRefresh && <Modal open title={copy("p3.memory.unsaved.title")} description={copy("p3.memory.unsaved.description")} closeLabel={copy("create.cancel")} onClose={() => setConfirmRefresh(false)}
      footer={<><Button variant="outline" size="md" type="button" data-modal-autofocus onClick={() => setConfirmRefresh(false)}>{copy("create.cancel")}</Button><Button variant="primary" size="md" type="button" onClick={confirmDiscardRefresh}>{copy("p3.memory.unsaved.discard")}</Button></>} />}
    {feedback !== undefined && <Feedback key={feedback.id} text={feedback.text} tone="success" onDone={() => setFeedback(undefined)} />}
    <header className="dsp-settings-object-heading"><div><h3>{copy("p5.settings.execution.title")}</h3><p>{copy("p5.settings.execution.scope")}</p></div>
      {!editing && <Button variant="ghost" size="sm" type="button" disabled={view === undefined || busy} onClick={() => { setEditing(true); setNotice('') }}>{copy("p5.settings.execution.edit")}</Button>}
    </header>
    <p className="dsp-settings-description">{copy("p5.settings.execution.inheritHelp")}</p>
    {notice && <p className="projects-ui__field-status" role="status">{notice}</p>}
    {readError !== undefined && <ErrorState inline title={copy('wholeRead.defaults.failed')} description={readError} />}
    {readPending && <LoadingState label={copy("p5.settings.execution.loading")} rows={1} />}
    {view?.catalog.kind === 'unavailable' && <ErrorState inline title={copy("p5.settings.execution.catalogUnavailable")} description={view.catalog.message} />}
    {view?.catalog.kind === 'available' && view.catalog.catalog.failures.map(item => <ErrorState inline key={item.id} title={item.name} description={item.message} />)}
    {view?.status.kind === 'unavailable' && <ErrorState inline title={copy("p5.settings.execution.savedUnavailable")} description={view.status.message} />}
    {editing && compareSaved && view !== undefined && <section aria-label={copy("p5.settings.execution.savedLabel")}><p className="dsp-settings-description">{copy("p5.settings.savedRevisionPrefix")}{' '}{view.defaults.revision}{copy("p5.common.closeParenthesis")}</p><p className="dsp-settings-saved-value">{savedLabel}</p></section>}
    {!editing ? <div className="dsp-settings-saved-value">{view === undefined ? null : savedLabel}</div> :
    <form className="dsp-settings-form" onSubmit={event => { void save(event) }}><fieldset disabled={view === undefined || busy}>
      <label className="dsp-field">{copy("p5.settings.execution.modelField")}<Select aria-label={copy("p5.settings.execution.modelLabel")} value={selection === null ? '' : routeKey(selection.provider, selection.model)} onValueChange={value => {
        if (value === '') { setSelection(null); return }
        const route = routes.find(item => routeKey(item.provider, item.model.id) === value)
        if (route !== undefined) setSelection({ provider: route.provider, model: route.model.id })
      }}>
        <option value="">{copy("p5.settings.execution.inheritDsh")}</option>
        {selection !== null && selected === undefined && <option disabled value={routeKey(selection.provider, selection.model)}>{selection.provider} / {selection.model}{copy("p5.common.currentlyUnavailable")}</option>}
        {routes.map(route => <option key={routeKey(route.provider, route.model.id)} value={routeKey(route.provider, route.model.id)}>{route.providerName} / {route.model.name}</option>)}
      </Select></label>
      {selected?.model.reasoning !== undefined && <label className="dsp-field">{copy("p5.settings.execution.reasoning")}<Select aria-label={copy("p5.settings.execution.reasoning")} value={selection?.reasoningEffort ?? ''} onValueChange={value => {
        if (selection === null) return
        setSelection({ provider: selection.provider, model: selection.model, ...(value === '' ? {} : { reasoningEffort: value }) })
      }}>
        <option value="">{copy("p5.settings.execution.inheritModel")}{defaultEffortName(selected.model)}</option>
        {selection?.reasoningEffort !== undefined && !selected.model.reasoning.efforts.some(item => item.id === selection.reasoningEffort)
          && <option disabled value={selection.reasoningEffort}>{selection.reasoningEffort}{copy("p5.settings.execution.unsupportedSuffix")}</option>}
        {selected.model.reasoning.efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
      </Select></label>}
      <div className="dsp-settings-actions"><Button variant="outline" size="md" type="button" onClick={discard}>{copy("p3.memory.cancelEdit")}</Button><Button variant="primary" size="md" type="submit">{saving ? copy("p3.settings.saving") : copy("p5.settings.execution.save")}</Button></div>
    </fieldset></form>}
    <RefreshButton translate={copy} disabled={busy} loading={readPending} label={copy("p5.settings.execution.refresh")} onClick={requestRefresh} />
  </section>
}

export function SessionInstructionsSettings(props: SessionInstructionsSettingsProps): ReactNode {
  return <InstructionsForm key={`${props.projectId}/${props.sessionId}`} {...props} />
}
export function ProjectInstructionsSettings(props: ProjectInstructionsSettingsProps): ReactNode {
  return <InstructionsForm key={props.projectId} {...props} />
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
  const [editing, setEditing] = useState(false)
  const [notice, setNoticeText] = useState('')
  const [feedback, setFeedback] = useState<{ text: string; id: number }>()
  const feedbackSequence = useRef(0)
  const setNotice = (text: string): void => { setNoticeText(text); setFeedback(undefined) }
  const showFeedback = (text: string): void => { setFeedback({ text, id: ++feedbackSequence.current }) }
  const [busy, setBusy] = useState(false)
  const [confirmRefresh, setConfirmRefresh] = useState(false)
  const mounted = useRef(true)
  const currentActions = useRef(actions)
  currentActions.current = actions
  const discard = (): void => { setInstructions(value?.instructions ?? ''); setEditing(false); setCompareSaved(false) }
  const draftState = { dirty: editing && instructions !== value?.instructions, busy, discard }
  useSettingsDraftGuard(registerUnsavedGuard, project ? 'project-instructions' : `session-instructions:${sessionId}`, draftState)
  const validate = (next: ProjectInstructions | SessionInstructions): void => {
    if (next.projectId !== projectId || (!project && (!('sessionId' in next) || next.sessionId !== sessionId))) throw new Error(copy("p5.settings.instructions.wrongScope"))
  }
  const read = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await currentActions.current.read()
      validate(next)
      if (mounted.current) { setValue(next); setInstructions(next.instructions); setNotice(''); setEditing(false); setUnconfirmed(false); setCompareSaved(false) }
    } catch (error) {
      if (mounted.current) { setValue(undefined); setInstructions(''); setNotice(copy("p5.settings.instructions.readFailed", { value: project ? copy("list.title") : copy("project.overview.title") }) + errorText(error)) }
    } finally { if (mounted.current) setBusy(false) }
  }
  useEffect(() => {
    mounted.current = true
    void read()
    return () => { mounted.current = false }
  }, [])
  const save = async (text: string): Promise<void> => {
    if (value === undefined || busy) return
    const submittedVersion = instructionDraftVersion.current
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
        setInstructions(next.instructions); setEditing(false); setCompareSaved(false)
        showFeedback(copy("p5.common.punctuationTemplate6", { value: next.instructions === '' ? copy("p5.settings.instructions.clearedPrefix") : copy("tool.card.result.saved"), value1: project ? copy("tool.card.target.project") : copy("p5.settings.instructions.conversationPersistent"), value2: copy(instructionTiming) }))
      } else {
        setCompareSaved(true); setNotice(copy("p5.settings.instructions.submittedSaved", { value: project ? copy("list.title") : copy("project.overview.title") }))
      }
    } catch (error) { if (mounted.current) {
      const unknown = settingsUnknownErrorText(error) === undefined ? undefined : copy('p5.settings.metadataUnconfirmed')
      setUnconfirmed(unknown !== undefined)
      setNotice(unknown ?? copy("p5.settings.instructions.notSaved", { value: project ? copy("list.title") : copy("project.overview.title") }) + errorText(error))
    } }
    finally { if (mounted.current) setBusy(false) }
  }
  const requestRefresh = (): void => {
    if (draftState.busy) return
    if (editing && draftState.dirty) setConfirmRefresh(true)
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
    {feedback !== undefined && <Feedback key={feedback.id} text={feedback.text} tone="success" onDone={() => setFeedback(undefined)} />}
    <header className="dsp-settings-object-heading"><div><h3>{title}</h3><p>{project ? copy("p5.settings.instructions.projectDescription") : copy("p5.settings.instructions.conversationDescription", { value: sessionTitle ?? sessionId })}</p></div>
      {!editing && <Button variant="ghost" size="sm" type="button" disabled={value === undefined || busy} onClick={() => { setEditing(true); setNotice('') }}>{project ? copy("p5.settings.instructions.editShared") : copy("p5.settings.instructions.editConversation")}</Button>}
    </header>
    <p className="dsp-settings-description">{copy(instructionTiming)}</p>
    {notice && <p className="projects-ui__field-status" role="status">{notice}</p>}
    {editing && compareSaved && value !== undefined && <section aria-label={copy("p5.settings.instructions.savedLabel", { value: project ? copy("list.title") : copy("project.overview.title") })}><p className="dsp-settings-description">{copy("p5.settings.savedRevisionPrefix")}{' '}{value.revision}{copy("p5.common.closeParenthesis")}</p><div className="dsp-settings-saved-prose">{value.instructions || (project ? copy("p5.settings.instructions.projectEmpty") : copy("p5.settings.instructions.conversationEmpty"))}</div></section>}
    {!editing ? <div className="dsp-settings-saved-prose">{value === undefined ? <p>{copy("p5.settings.instructions.textNotLoaded")}</p> : <p>{value.instructions || (project ? copy("p5.settings.instructions.projectEmpty") : copy("p5.settings.instructions.conversationEmpty"))}</p>}</div> :
    <form className="dsp-settings-form" onSubmit={event => { event.preventDefault(); void save(instructions) }}><fieldset disabled={value === undefined || busy}>
      <label className="dsp-field">{project ? copy("p5.settings.instructions.projectField") : copy("p5.settings.instructions.conversationField")}<Textarea aria-label={project ? copy("p5.settings.instructions.projectField") : copy("p5.settings.instructions.conversationField")} rows={7} value={instructions} onChange={event => setInstructions(event.target.value)} /><small>{unconfirmed ? copy("p3.memory.writeUnconfirmed") : draftState.dirty ? copy("p3.memory.unsaved") : copy("p3.memory.editing")}</small></label>
      <div className="dsp-settings-actions"><Button variant="outline" size="md" type="button" onClick={discard}>{copy("p3.memory.cancelEdit")}</Button><Button variant="primary" size="md" type="submit">{busy ? copy("p3.settings.saving") : project ? copy("p5.settings.instructions.saveProject") : copy("p5.settings.instructions.saveConversation")}</Button>
        <Button variant="ghost" size="md" type="button" onClick={() => { void save('') }}>{copy("p5.settings.instructions.clearSave")}</Button></div>
    </fieldset></form>}
    {(!editing || unconfirmed) && <RefreshButton translate={copy} disabled={busy} loading={busy} label={project ? copy("p5.settings.instructions.reloadProject") : copy("p5.settings.instructions.reloadConversation")} onClick={requestRefresh} />}
    <details className="dsp-settings-help"><summary>{copy("p5.settings.instructions.scopeTitle")}</summary><p>{copy("p5.settings.instructions.scopeHelp")}</p><p>{copy("p5.settings.instructions.noModelStart")}{copy(instructionTiming)}</p></details>
  </section>
}

function routeKey(provider: string, model: string): string { return JSON.stringify([provider, model]) }
function defaultEffortName(model: ModelCatalogModel): string {
  const id = model.reasoning?.defaultEffort
  if (id === undefined) return ''
  const effort = model.reasoning?.efforts.find(item => item.id === id)
  return `（${effort?.name ?? id}）`
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
