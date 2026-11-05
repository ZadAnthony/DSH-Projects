import { useEffect, useRef, useState } from 'react'
import type { ProjectDetail } from '../public-types.ts'
import type { ProjectsPanelActions } from './controller.ts'
import type { ProjectsTranslate } from './ui/copy.ts'

type Field = 'name' | 'workspace'
interface FieldState { draft: string; saved: string; revision: number; version: number; busy: boolean; checking: boolean; blocked: boolean; notice: string; readNotice: string; confirmed: boolean }
const fieldValue = (detail: ProjectDetail, field: Field): string => field === 'name' ? detail.project.name : detail.project.workspace?.path ?? ''

/** Name and workspace mutate one project revision; serialize their real writes. */
export function useProjectBasicsDraft(detail: ProjectDetail, updateProject: ProjectsPanelActions['updateProject'], text: ProjectsTranslate, onWorkspaceSaved: () => void, readProject?: (projectId: string) => Promise<ProjectDetail>) {
  const create = (field: Field): FieldState => ({ draft: fieldValue(detail, field), saved: fieldValue(detail, field), revision: detail.project.revision, version: 0, busy: false, checking: false, blocked: false, notice: '', readNotice: '', confirmed: false })
  const fields = useRef({ name: create('name'), workspace: create('workspace') })
  const authority = useRef(detail)
  const mounted = useRef(true)
  const queue = useRef(Promise.resolve())
  const [, redraw] = useState(0)
  const render = (): void => { if (mounted.current) redraw(value => value + 1) }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const accept = (next: ProjectDetail, own: boolean, expectedRevision = authority.current.project.revision): void => {
    if (next.project.revision < authority.current.project.revision) return
    const previousRevision = expectedRevision
    const checking = fields.current.name.checking || fields.current.workspace.checking
    authority.current = next
    for (const field of ['name', 'workspace'] as const) {
      const state = fields.current[field], wasClean = state.draft === state.saved
      // Rechecking never adopts over the checked draft or another explicitly edited field,
      // including input deliberately changed back to the previous saved value.
      const preserveDraft = state.checking || checking && state.version > 0 && !state.confirmed
      state.saved = fieldValue(next, field)
      if (wasClean && !state.busy && !preserveDraft) { state.draft = state.saved; state.revision = next.project.revision }
      else if (own && state.revision === previousRevision) state.revision = next.project.revision
    }
  }
  useEffect(() => {
    if (detail.project.revision < authority.current.project.revision) return
    accept(detail, false); render()
  }, [detail.project])
  const change = (field: Field, value: string): void => {
    const state = fields.current[field]
    if (state.draft === state.saved) state.revision = authority.current.project.revision
    state.draft = value; state.version++; state.confirmed = false; state.readNotice = ''
    render()
  }
  const discard = (field: Field): void => {
    const state = fields.current[field]
    state.draft = state.saved; state.revision = authority.current.project.revision; state.version++; state.blocked = false; state.notice = ''; state.readNotice = ''; state.confirmed = false
    render()
  }
  const save = (field: Field, explicit = false): void => {
    const state = fields.current[field]
    if (state.busy || state.checking || (!explicit && state.blocked)) return
    const submitted = state.draft.trim(), version = state.version
    if (submitted === state.saved && !state.blocked) {
      if (state.draft !== submitted) { state.draft = submitted; render() }
      return
    }
    if (field === 'name' && submitted === '') { state.notice = text('p5.settings.name.required'); state.blocked = true; render(); return }
    state.busy = true; state.notice = ''; state.readNotice = ''; state.confirmed = false
    render()
    queue.current = queue.current.then(async () => {
      if (!mounted.current) return
      try {
        const expectedRevision = state.revision
        const result = await updateProject({ projectId: detail.project.id, expectedRevision,
          ...(field === 'name' ? { name: submitted } : { workspace: submitted === '' ? null : { path: submitted } }) })
        if (!mounted.current) return
        if (result.project.id !== detail.project.id) throw new Error(text('p3.memory.error.saveProject'))
        const current = result.project.revision >= authority.current.project.revision
        accept(result, true, expectedRevision)
        state.revision = result.project.revision; state.blocked = false
        if (state.version === version && current) { state.draft = fieldValue(result, field); state.confirmed = true }
        else state.notice = text(field === 'name' ? 'p5.settings.name.submittedSaved' : 'p5.settings.simple.workspaceSubmittedSaved')
        if (field === 'workspace') onWorkspaceSaved()
      } catch (error) {
        if (!mounted.current) return
        const failure = projectSaveFailure(error, detail.project.id)
        state.blocked = true
        if (failure.current !== undefined) {
          accept(failure.current, false); state.revision = failure.current.project.revision
          state.notice = text(field === 'name' ? 'p5.settings.name.conflict' : 'p5.settings.workspace.conflict', { value: fieldValue(failure.current, field) || text('p3.settings.workspace.internal') })
        } else state.notice = text(field === 'name'
          ? failure.unknown ? 'p5.settings.name.saveUnconfirmed' : 'p5.settings.name.saveFailed'
          : failure.unknown ? 'p5.settings.workspace.saveUnconfirmed' : 'p5.settings.workspace.saveFailed')
      } finally { state.busy = false; render() }
    })
  }
  const recheck = (field: Field): void => {
    const state = fields.current[field]
    if (readProject === undefined || state.busy || state.checking || !state.blocked) return
    state.checking = true; state.readNotice = ''; render()
    queue.current = queue.current.then(async () => {
      if (!mounted.current) return
      try {
        const result = await readProject(detail.project.id)
        if (!mounted.current) return
        if (result.project.id !== detail.project.id) throw new Error(text('p3.memory.error.saveProject'))
        accept(result, false)
        // A deliberate read rebases only this field's next explicit write, never its draft.
        state.revision = authority.current.project.revision
        if (state.draft === state.saved) { state.blocked = false; state.notice = ''; state.confirmed = true }
        else state.readNotice = text(field === 'name' ? 'p5.settings.name.checked' : 'p5.settings.workspace.checked', { value: state.saved || text('p3.settings.workspace.internal') })
      } catch {
        if (mounted.current) state.readNotice = text('p5.settings.simple.recheckFailed')
      } finally { state.checking = false; render() }
    })
  }
  return { fields: fields.current, change, discard, save, recheck }
}

/** Serialized Remote failures retain the draft and any uncertainty about side effects. */
function projectSaveFailure(error: unknown, projectId: string): { current?: ProjectDetail; unknown: boolean } {
  const failure = error as { code?: string; details?: { current?: ProjectDetail; effect?: string } } | null
  const current = failure?.code === 'projects/update-conflict' ? failure.details?.current : undefined
  return { ...(current?.project.id === projectId ? { current } : {}),
    unknown: failure?.code === 'projects/update-unconfirmed' || failure?.details?.effect === 'published-durability-unknown' }
}
