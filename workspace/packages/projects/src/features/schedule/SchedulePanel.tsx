import * as React from 'react'
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type {
  ManualRunAdmissionResult, ProjectSchedule, SaveScheduleInput, ScheduleRule, ScheduleRunRef, ScheduleRunStatus, ScheduleRunView,
  ScheduleSession, ScheduleSettingsActions, ScheduleSnapshot, ScheduleSource, ScheduleTimeView, ScheduleWriteResult,
} from './contract.ts'
import { RefreshButton } from '../../client/WorkflowControls.tsx'
import { ActionMenu, Button, Checkbox, EmptyState, ErrorState, Feedback, IconChevronRightOutlineRegular, Input, LoadingState, Modal, Select, Switch, Tag, Textarea } from '../../client/ui/index.ts'
import { projectCopy, type ProjectsTranslate } from '../../client/ui/copy.ts'
import { formatUiDate } from '../../client/ui/date-format.ts'
import { scheduleInputFailure, type ScheduleInputField } from './input-errors.ts'
import { draftForDuration, secondsForDuration, type DurationDraft, type DurationUnit } from './duration-draft.ts'

export interface SchedulePanelProps {
  readonly projectId: string
  /** 仅初始查看范围，不改变后端调用者权限。 */
  readonly initialSessionId?: string
  readonly initialScheduleId?: string
  readonly initialCreate?: boolean
  readonly onDirtyChange?: (dirty: boolean) => void
  readonly onOpenSession?: (sessionId: string) => void
  readonly actions: ScheduleSettingsActions
  /** 只请求宿主打开已记录的来源；不会发送消息或开始运行。 */
  readonly onOpenSource?: (source: ScheduleSource) => void
  readonly translate?: ProjectsTranslate
}

export interface ScheduleOverviewProps {
  readonly projectId: string
  /** Reload owner data while preserving the invoking controls and filter. */
  readonly refreshRevision?: number
  readonly actions: Pick<ScheduleSettingsActions, 'read'>
  readonly onManage: (sessionId?: string, scheduleId?: string, create?: boolean) => void
  readonly translate?: ProjectsTranslate
}

export function SchedulePanel(props: SchedulePanelProps): ReactNode {
  return <SchedulePanelProject key={props.projectId} {...props} />
}

type RuleDraft =
  | { readonly kind: 'at'; readonly date: string; readonly time: string; readonly timeZone: string }
  | { readonly kind: 'after'; readonly duration: DurationDraft; readonly timeZone: string }
  | { readonly kind: 'every'; readonly duration: DurationDraft; readonly timeZone: string }
  | { readonly kind: 'daily'; readonly time: string; readonly timeZone: string }
  | { readonly kind: 'weekly'; readonly time: string; readonly timeZone: string; readonly weekdays: readonly number[] }
  | { readonly kind: 'cron'; readonly expression: string; readonly timeZone: string }

interface ScheduleEditor {
  readonly projectId: string
  readonly mode: 'create' | 'edit'
  readonly id?: string
  readonly expectedRevision?: number
  readonly sessionId: string
  readonly title: string
  readonly prompt: string
  readonly rule: RuleDraft
  readonly enabled: boolean
}

type ScheduleFormField = 'schedule-title' | 'schedule-prompt' | 'rule-date' | 'rule-time' | 'rule-after-seconds'
  | 'rule-every-seconds' | 'rule-weekdays' | 'rule-cron' | 'rule-time-zone'
class ScheduleFormError extends Error {
  constructor(readonly field: ScheduleFormField, message: string) { super(message) }
}

function SchedulePanelProject({ projectId, actions, initialSessionId, initialScheduleId, initialCreate, onDirtyChange, onOpenSource, onOpenSession, translate }: SchedulePanelProps): ReactNode {
  const text = projectCopy(translate)
  const copy = text
  const [snapshot, setSnapshot] = useState<ScheduleSnapshot>()
  const [readAt, setReadAt] = useState<string>()
  const [confirmedUpdates, setConfirmedUpdates] = useState(false)
  const [loading, setLoading] = useState(true)
  const [readError, setReadError] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [noticeVersion, setNoticeVersion] = useState(0)
  const [writeNotice, setWriteNotice] = useState<string>()
  const [fieldError, setFieldError] = useState<ScheduleFormError>()
  const [selectedId, setSelectedId] = useState(initialScheduleId)
  const [editor, setEditor] = useState<ScheduleEditor>()
  const [baseline, setBaseline] = useState('')
  const [pendingNavigation, setPendingNavigation] = useState<{ run: () => void }>()
  const [busy, setBusy] = useState(false)
  const [manualResult, setManualResult] = useState<ManualRunAdmissionResult>()
  const operationBusy = useRef(false)
  const active = useRef(true)
  const readEpoch = useRef(0)
  const initialized = useRef(false)
  const actionsRef = useRef(actions); actionsRef.current = actions
  const dirtyCallback = useRef(onDirtyChange); dirtyCallback.current = onDirtyChange
  const dirty = editor !== undefined && JSON.stringify(editor) !== baseline
  useEffect(() => { dirtyCallback.current?.(dirty) }, [dirty])
  useEffect(() => () => { dirtyCallback.current?.(false) }, [])

  const clearDraft = (): void => { setEditor(undefined); setBaseline(''); setPendingNavigation(undefined); setFieldError(undefined) }
  const startEditor = (value: ScheduleEditor): void => { setEditor(value); setBaseline(JSON.stringify(value)); setPendingNavigation(undefined); setFieldError(undefined) }
  const navigate = (run: () => void): void => {
    if (operationBusy.current) return
    if (dirty) { setPendingNavigation({ run }); return }
    clearDraft(); run()
  }
  const refresh = async (): Promise<void> => {
    const request = ++readEpoch.current
    if (active.current) { setLoading(true); setReadError(undefined) }
    try {
      const value = await actionsRef.current.read()
      if (!active.current || request !== readEpoch.current) return
      if (value.projectId !== projectId) throw new Error(copy("p5.schedule.returnedProjectMismatch"))
      setSnapshot(value); setReadAt(new Date().toISOString()); setConfirmedUpdates(false)
      if (!initialized.current) {
        initialized.current = true
        if (initialCreate) {
          const target = value.targets.find(item => item.id === initialSessionId) ?? (initialSessionId === undefined ? value.targets[0] : undefined)
          if (target !== undefined) startEditor(newEditor(projectId, target))
        } else if (initialScheduleId === undefined) {
          setSelectedId(value.schedules.find(item => initialSessionId === undefined || item.schedule.sessionId === initialSessionId)?.schedule.id
            ?? value.runs.find(item => initialSessionId === undefined || item.link.sessionId === initialSessionId)?.link.scheduleId)
        }
      }
    } catch (error) {
      if (active.current && request === readEpoch.current) setReadError(errorText(error))
    } finally { if (active.current && request === readEpoch.current) setLoading(false) }
  }
  useEffect(() => {
    active.current = true; void refresh()
    return () => { active.current = false; readEpoch.current++ }
  // 项目切换由外层 key 重建，当前绑定经 ref 读取；旧项目回执不会进入新项目。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const beginCreate = (): void => {
    if (snapshot === undefined || snapshot.targets.length === 0) return
    const target = snapshot.targets.find(item => item.id === snapshot.schedules.find(row => row.schedule.id === selectedId)?.schedule.sessionId)
      ?? snapshot.targets.find(item => item.id === initialSessionId) ?? snapshot.targets[0]!
    navigate(() => { setActionError(undefined); setNotice(undefined); setWriteNotice(undefined); startEditor(newEditor(projectId, target)) })
  }
  const beginEdit = (schedule: ProjectSchedule): void => {
    setActionError(undefined); setNotice(undefined); setWriteNotice(undefined); startEditor(editorForSchedule(projectId, schedule))
  }
  const select = (id: string): void => navigate(() => { setSelectedId(id); setActionError(undefined); setNotice(undefined); setWriteNotice(undefined); setManualResult(undefined) })
  const openSession = onOpenSession === undefined ? undefined : (id: string): void => navigate(() => onOpenSession(id))
  const openSource = onOpenSource === undefined ? undefined : (source: ScheduleSource): void => navigate(() => onOpenSource(source))

  const write = async (operation: () => Promise<ScheduleWriteResult>, savedText: string, validateSave = false): Promise<void> => {
    if (operationBusy.current) return
    operationBusy.current = true; setBusy(true); setActionError(undefined); setNotice(undefined); setWriteNotice(undefined); setFieldError(undefined); setManualResult(undefined)
    try {
      const result = await operation()
      if (!active.current) return
      if (result.kind === 'conflict') { setActionError(conflictText(result, copy)); void refresh(); return }
      if (result.kind === 'saved' && result.schedule.projectId !== projectId) throw new Error(copy("p3.memory.error.saveProject"))
      const text = writeResultText(result, savedText, copy)
      if (result.kind === 'failed') setActionError(text)
      else {
        if (result.effects?.configuration !== 'unconfirmed') {
          setSnapshot(previous => {
            if (previous === undefined) return previous
            if (result.kind === 'removed') return { ...previous, schedules: previous.schedules.filter(row => row.schedule.id !== result.id) }
            const exists = previous.schedules.some(row => row.schedule.id === result.schedule.id)
            const saved = { schedule: result.schedule, time: { kind: 'future' as const }, timeUnconfirmed: true as const }
            return { ...previous, schedules: exists ? previous.schedules.map(row => row.schedule.id === result.schedule.id ? saved : row) : [...previous.schedules, saved] }
          })
          setConfirmedUpdates(true)
        }
        setNotice(text); setNoticeVersion(value => value + 1)
        if (result.pendingInputIntegration !== 'applied' || result.effects?.configuration === 'unconfirmed'
          || result.effects?.pending.kind === 'unconfirmed' || result.effects?.nativeSaved === 'unconfirmed') setWriteNotice(text)
        if (result.kind === 'saved') setSelectedId(result.schedule.id)
        // 保存中表单和目录保持锁定，旧回执不能丢弃之后的新输入。
        if (result.effects?.configuration !== 'unconfirmed') clearDraft()
      }
      void refresh()
    } catch (error) {
      if (active.current) {
        const failure = validateSave ? scheduleInputFailure(error) : undefined
        if (failure !== undefined) setFieldError(new ScheduleFormError(inputFieldName(failure.field), copy(
          failure.code === 'invalid_time_zone' ? 'p5.schedule.invalidTimeZone'
            : failure.code === 'invalid_prompt' ? 'p5.schedule.invalidTitle'
            : failure.code === 'not_future' ? 'p5.schedule.futureDateRequired'
            : failure.code === 'time_out_of_range' ? 'p5.schedule.noNextTime'
            : failure.code === 'frequency_too_high' ? 'p5.schedule.minimumInterval'
            : failure.field === 'expression' ? 'p5.schedule.invalidCron'
            : failure.field === 'date' ? 'p5.schedule.invalidDateTime' : 'p5.schedule.invalidRule')))
        else setActionError(copy("p5.schedule.operationUnconfirmedPrefix") + errorText(error) + copy("p5.schedule.verifySettingsSuffix"))
      }
    } finally { operationBusy.current = false; if (active.current) setBusy(false) }
  }
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (editor === undefined || operationBusy.current) return
    try { const input = inputForEditor(editor, copy); await write(() => actionsRef.current.save(input), copy("p5.schedule.settingsSaved"), true) }
    catch (error) {
      if (!active.current) return
      if (error instanceof ScheduleFormError) setFieldError(error)
      else setActionError(copy("p5.schedule.operationUnconfirmedPrefix") + errorText(error) + copy("p5.schedule.verifySettingsSuffix"))
    }
  }
  const runNow = async (schedule: ProjectSchedule): Promise<void> => {
    if (operationBusy.current) return
    operationBusy.current = true; setBusy(true); setActionError(undefined); setNotice(copy("p5.schedule.submittingRun")); setWriteNotice(undefined); setManualResult(undefined)
    const input = { scheduleId: schedule.id, expectedRevision: schedule.revision, requestId: crypto.randomUUID() }
    try {
      const result = await actionsRef.current.runNow(input)
      if (!active.current) return
      if (result.projectId !== projectId || result.scheduleId !== schedule.id || result.requestId !== input.requestId) throw new Error(copy("p5.schedule.returnedRequestMismatch"))
      setNotice(undefined); setManualResult(result)
      if (result.kind === 'conflict') setActionError(copy("p5.schedule.changedBeforeRun"))
      void refresh()
    } catch (error) {
      if (active.current) { setNotice(undefined); setActionError(copy("p5.schedule.runUnconfirmedPrefix") + errorText(error) + copy("p5.schedule.checkBeforeRetrySuffix")) }
    } finally { operationBusy.current = false; if (active.current) setBusy(false) }
  }
  const selected = snapshot?.schedules.find(row => row.schedule.id === selectedId)
  const runs = sortedRuns((snapshot?.runs ?? []).filter(run => run.link.scheduleId === selectedId))
  const removed = selected === undefined && runs.length > 0
  const target = snapshot?.targets.find(item => item.id === (editor?.sessionId ?? selected?.schedule.sessionId ?? runs[0]?.link.sessionId))
  const cancelled = (): void => { setNotice(copy("p5.schedule.editCancelled")); setNoticeVersion(value => value + 1) }
  const cancelEditor = (): void => {
    if (!operationBusy.current && !busy && snapshot !== undefined) { clearDraft(); cancelled() }
  }
  const requestCloseEditor = (): void => {
    if (snapshot !== undefined) navigate(cancelled)
  }
  const retained = snapshot !== undefined && (loading || readError !== undefined) ? copy(confirmedUpdates ? 'wholeRead.schedule.retainedAfterWrite' : 'wholeRead.schedule.retained', { at: formatUiDate(readAt, copy) }) : undefined
  return <section className="dsh-schedule-panel" aria-label={copy("p5.schedule.settings")} aria-busy={busy || loading}>
    <header className="dsh-schedule-header"><div><h2>{copy("p5.schedule.arrangements")}</h2><p>{copy("p5.schedule.originalSessionExplanation")}</p></div><RefreshButton translate={copy} onClick={() => { void refresh() }} loading={loading} disabled={busy} ariaLabel={copy("p5.schedule.refresh")} /></header>
    {loading && <LoadingState label={copy("p5.schedule.loading")} rows={snapshot === undefined ? 3 : 0} />}
    {editor === undefined && readError !== undefined && <ErrorState title={copy("p5.schedule.readFailed", { value: readError })} description={retained} retry={() => { void refresh() }} retryLabel={copy("list.retry")} />}
    {editor === undefined && readError === undefined && retained !== undefined && <p className="dsh-schedule-note" role="status">{retained}</p>}
    {editor === undefined && actionError !== undefined && <ErrorState title={actionError} retry={() => { void refresh() }} retryLabel={copy("list.retry")} />}
    {busy && notice !== undefined ? <LoadingState label={notice} /> : notice !== undefined && <Feedback key={noticeVersion} text={notice} tone={writeNotice === undefined ? 'success' : 'warning'} onDone={() => setNotice(undefined)} />}
    {editor === undefined && writeNotice !== undefined && <section className="dsh-schedule-notice" role="status" aria-label={copy("p5.schedule.settingsReceipt")}><Tag tone="warning">{copy("p5.schedule.notFullyConfirmed")}</Tag><p>{writeNotice}</p></section>}
    {snapshot !== undefined && <><Availability copy={copy} snapshot={snapshot} /><div className="dsh-schedule-workspace">
      <nav className="dsh-schedule-directory" aria-label={copy("p5.schedule.projectSchedules")}><Button variant={editor === undefined ? 'primary' : 'outline'} size="sm" type="button" disabled={busy || snapshot.targets.length === 0} onClick={beginCreate}>{copy("p5.schedule.add")}</Button>
        <ScheduleDirectory snapshot={snapshot} selectedId={editor?.mode === 'create' ? undefined : selectedId} busy={busy} onSelect={select} text={text}
          onEnabled={(schedule, enabled) => { void write(() => actionsRef.current.setEnabled(schedule.id, enabled, schedule.revision), copy("p5.schedule.savedEnabledPrefix") + (enabled ? copy("p5.schedule.enabledFragment") : copy("p5.schedule.disabledFragment")) + copy("p5.common.punctuationTemplate3")) }}
          onEdit={schedule => navigate(() => { setSelectedId(schedule.id); beginEdit(schedule) })}
          onRun={schedule => { setSelectedId(schedule.id); void runNow(schedule) }}
          onRemove={schedule => { setSelectedId(schedule.id); void write(() => actionsRef.current.remove(schedule.id, schedule.revision), copy("p5.schedule.settingsSaved")) }} compact />
        {snapshot.targets.length === 0 && <p className="dsh-schedule-note">{copy("p5.schedule.noManageableTarget")}</p>}
      </nav>
      <div className="dsh-schedule-reading" aria-label={copy("p5.schedule.details")}>
        <header className="dsh-schedule-detail-heading"><div className="dsh-schedule-section-heading"><h3>{editor?.mode === 'create' ? copy("p5.schedule.add") : selected?.schedule.title ?? (removed ? copy("p5.schedule.removed") : copy("p5.schedule.select"))}</h3>{editor === undefined && selected !== undefined && <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => navigate(() => beginEdit(selected.schedule))}>{copy('p3.schedule.edit')}</Button>}</div>{target !== undefined && <p>{copy("p5.schedule.belongsToPrefix")}{sessionLabel(target, copy)}</p>}</header>
        {manualResult !== undefined && <ManualRunResult copy={copy} result={manualResult} onOpenSource={openSource} onOpenSession={openSession} />}
        {editor?.mode !== 'create' && <RunHistory runs={runs} onOpenSource={openSource} onOpenSession={openSession} text={text} />}
        {removed && <p>{copy("p5.schedule.removedExplanation")}</p>}
        {editor === undefined && (selected !== undefined ? <section className="dsh-schedule-future" aria-label={copy("p5.schedule.futureArrangements")}><div className="dsh-schedule-section-heading"><h3>{copy("p5.schedule.futureArrangements")}</h3><ScheduleEnabled copy={copy} enabled={selected.schedule.enabled} /></div>
            <p>{ruleLabel(selected.schedule.rule, copy)}</p><FutureTime copy={copy} row={selected} snapshot={snapshot} />
            <p className="dsh-schedule-note">{copy("p5.schedule.disableEffects")}</p>
            <details className="dsh-schedule-details"><summary>{copy("p5.schedule.taskContent")}</summary><p className="dsh-schedule-prompt">{selected.schedule.prompt}</p></details>
            <details className="dsh-schedule-details"><summary>{copy("p5.schedule.sourcesAndUpdates")}</summary><p className="dsh-schedule-note">{copy("p5.schedule.createdAtPrefix")}{' '}<Timestamp copy={copy} value={selected.schedule.createdAt} />{copy("p5.schedule.updatedAtFragment")}{' '}<Timestamp copy={copy} value={selected.schedule.updatedAt} />{copy("p5.schedule.revisionFragment")}{' '}{selected.schedule.revision}{copy("p5.common.period")}</p>{selected.schedule.enabledSince !== undefined && <p className="dsh-schedule-note">{copy("p5.schedule.lastEnabledPrefix")}<Timestamp copy={copy} value={selected.schedule.enabledSince} />{copy("p5.schedule.notStartedSuffix")}</p>}<ScheduleSources copy={copy} title={copy("p5.schedule.creationSources")} sources={selected.schedule.createdBy.sources} onOpenSource={openSource} /><ScheduleSources copy={copy} title={copy("p5.schedule.updateSources")} sources={selected.schedule.updatedBy.sources} onOpenSource={openSource} /></details>
            <p className="dsh-schedule-note">{copy("p5.schedule.removeEffects")}</p>
          </section> : !removed && <EmptyState title={copy("p5.schedule.selectOrAdd")} />)}
      </div></div></>}
    {snapshot === undefined && manualResult !== undefined && <ManualRunResult copy={copy} result={manualResult} onOpenSource={openSource} onOpenSession={openSession} />}
    {editor !== undefined && <Modal open className="dsh-schedule-modal" contentClassName="dsh-schedule-modal-content" title={editor.mode === 'create' ? copy("p5.schedule.add") : copy("p5.schedule.edit")} closeLabel={copy("p3.memory.cancelEdit")} onClose={requestCloseEditor}>
      {loading && <LoadingState label={copy("p5.schedule.loading")} />}
      {readError !== undefined && <ErrorState title={copy("p5.schedule.readFailed", { value: readError })} description={retained} retry={() => { void refresh() }} retryLabel={copy("list.retry")}><p>{copy("p5.schedule.draftRetained")}</p></ErrorState>}
      {readError === undefined && retained !== undefined && <p className="dsh-schedule-note" role="status">{retained}</p>}
      {writeNotice !== undefined && <section className="dsh-schedule-notice" role="status" aria-label={copy("p5.schedule.settingsReceipt")}><Tag tone="warning">{copy("p5.schedule.notFullyConfirmed")}</Tag><p>{writeNotice}</p></section>}
      {actionError !== undefined && <ErrorState title={actionError} retry={() => { void refresh() }} retryLabel={copy("list.retry")} inline />}
      <ScheduleForm editor={editor} targets={snapshot?.targets ?? []} busy={busy || snapshot === undefined} fieldError={fieldError} onChange={value => { setEditor(value); setFieldError(undefined) }} onCancel={cancelEditor} onSave={save} text={text} />
    </Modal>}
    {pendingNavigation !== undefined && <Modal open title={copy("p5.schedule.unsavedChanges")} description={copy("p5.schedule.unsavedNavigationDescription")} closeLabel={copy("create.discard.keep")} onClose={() => setPendingNavigation(undefined)} footer={<><Button variant="outline" size="md" type="button" data-modal-autofocus onClick={() => setPendingNavigation(undefined)}>{copy("create.discard.keep")}</Button><Button variant="primary" size="md" type="button" onClick={() => { const next = pendingNavigation.run; clearDraft(); next() }}>{copy("p5.schedule.discardAndContinue")}</Button></>} />}
  </section>
}

export function ScheduleOverview(props: ScheduleOverviewProps): ReactNode { return <ScheduleOverviewProject key={props.projectId} {...props} /> }
function ScheduleOverviewProject({ projectId, actions, onManage, translate, refreshRevision }: ScheduleOverviewProps): ReactNode {
  const text = projectCopy(translate)
  const [snapshot, setSnapshot] = useState<ScheduleSnapshot>()
  const [readAt, setReadAt] = useState<string>()
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [sessionFilter, setSessionFilter] = useState('')
  const controls = useRef<HTMLDivElement>(null)
  const clickedControl = useRef<HTMLButtonElement>()
  const managementOpener = useRef<HTMLButtonElement>()
  const latest = useRef(actions); latest.current = actions
  const manage: ScheduleOverviewProps['onManage'] = (sessionId, scheduleId, create) => {
    managementOpener.current = clickedControl.current
    onManage(sessionId, scheduleId, create)
  }
  useLayoutEffect(() => {
    const opener = managementOpener.current
    if (loading || opener === undefined || opener.isConnected) return
    managementOpener.current = undefined
    // The host Modal restores the original control. Only replace that target
    // when refreshed data removed it and the user has not focused elsewhere.
    if (opener.ownerDocument.activeElement === opener.ownerDocument.body) {
      controls.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    }
  }, [loading, snapshot])
  useEffect(() => {
    let active = true; setLoading(true); setError('')
    void latest.current.read().then(value => {
      if (value.projectId !== projectId) throw new Error(text("p5.schedule.projectMismatch"))
      if (active) { setSnapshot(value); setReadAt(new Date().toISOString()) }
    }).catch(error => { if (active) setError(text("p5.schedule.unavailablePrefix") + errorText(error)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [projectId, refresh, refreshRevision])
  return <section aria-label={text("p5.schedule.overview")} className="dsh-schedule-panel dsh-schedule-overview"
    onClickCapture={event => { clickedControl.current = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') ?? undefined : undefined }}>
    <header className="dsh-schedule-header"><h3>{text("p3.history.schedule.tab")}{' '}<small>{!loading && error === '' ? snapshot?.schedules.length ?? '' : ''}</small></h3><div ref={controls} className="dsh-schedule-toolbar"><Button variant="outline" size="sm" type="button" disabled={snapshot === undefined || snapshot.targets.length === 0} onClick={() => manage(sessionFilter || undefined, undefined, true)}>{text("p5.schedule.add")}</Button><RefreshButton translate={text} onClick={() => setRefresh(value => value + 1)} loading={loading} ariaLabel={text("p5.schedule.refreshArrangements")} /></div></header>
    {error !== '' && <ErrorState title={error} retry={() => setRefresh(value => value + 1)} retryLabel={text("list.retry")} />}
    {loading && <LoadingState label={text("p5.schedule.loading")} rows={snapshot === undefined ? 3 : 0} />}
    {snapshot !== undefined && (loading || error !== '') && <p className="dsh-schedule-note" role="status">{text('wholeRead.schedule.retained', { at: formatUiDate(readAt, text) })}</p>}
    {snapshot !== undefined && <><Availability copy={text} snapshot={snapshot} />
      <label className="projects-ui__field dsh-schedule-filterbar">{text("p5.schedule.session")}<Select aria-label={text("p5.schedule.scheduledTaskSession")} value={sessionFilter} onValueChange={setSessionFilter}><option value="">{text("p5.schedule.allSessions")}</option>{snapshot.targets.map(target => <option key={target.id} value={target.id}>{sessionLabel(target, text)}</option>)}</Select></label>
      <ScheduleDirectory snapshot={snapshot} sessionFilter={sessionFilter} text={text} onEdit={schedule => manage(schedule.sessionId, schedule.id)} onSelect={id => { const schedule = snapshot.schedules.find(row => row.schedule.id === id)?.schedule; const run = snapshot.runs.find(run => run.link.scheduleId === id); manage(schedule?.sessionId ?? run?.link.sessionId, id) }} />
      <p className="dsh-schedule-note">{text("p5.schedule.originalSessionExplanation")}</p>
    </>}
  </section>
}

function Availability({ snapshot , copy}: { readonly snapshot: ScheduleSnapshot ; readonly copy: ProjectsTranslate }): ReactNode {
  return <><div className="dsh-schedule-availability"><span className="dsh-schedule-caption">{copy("p5.schedule.automaticStatus")}</span><p>{automaticDispatchText(snapshot, copy)}{copy("p5.common.period")}</p></div><details className="dsh-schedule-details dsh-schedule-conditions"><summary>{copy("p5.schedule.requirements")}</summary><p>{copy("p5.schedule.requirementsDescription")}</p><p>{copy("p5.schedule.retryPolicy")}</p></details>{snapshot.projectArchived && <p>{copy("p5.schedule.archivedProjectEffects")}</p>}</>
}
function ScheduleDirectory({ snapshot, sessionFilter = '', selectedId, onSelect, compact = false, busy = false, text, onEnabled, onEdit, onRun, onRemove }: {
  readonly snapshot: ScheduleSnapshot; readonly sessionFilter?: string; readonly selectedId?: string; readonly onSelect: (id: string) => void; readonly compact?: boolean; readonly busy?: boolean
  readonly text: ProjectsTranslate
  readonly onEnabled?: (schedule: ProjectSchedule, enabled: boolean) => void
  readonly onEdit?: (schedule: ProjectSchedule) => void
  readonly onRun?: (schedule: ProjectSchedule) => void
  readonly onRemove?: (schedule: ProjectSchedule) => void
}): ReactNode {
  const rows = snapshot.schedules.filter(row => sessionFilter === '' || row.schedule.sessionId === sessionFilter)
  const knownIds = new Set(snapshot.schedules.map(row => row.schedule.id))
  const removed = sortedRuns(snapshot.runs.filter(run => !knownIds.has(run.link.scheduleId) && (sessionFilter === '' || run.link.sessionId === sessionFilter)))
  const ids = [...new Set([...snapshot.targets.map(target => target.id), ...rows.map(row => row.schedule.sessionId)])]
  return <><div className="dsh-schedule-groups">{ids.map(id => {
    const group = rows.filter(row => row.schedule.sessionId === id)
    if (group.length === 0) return null
    const target = snapshot.targets.find(target => target.id === id)
    return <section className="dsh-schedule-group" key={id}>{group.map(row => {
      const run = sortedRuns(snapshot.runs.filter(run => run.link.scheduleId === row.schedule.id))[0]
      const schedule = row.schedule
      return <div className="dsh-schedule-item-row" key={schedule.id} data-selected={selectedId === schedule.id || undefined}>
        <Button variant="ghost" size="sm" className="dsh-schedule-item" type="button" aria-current={selectedId === schedule.id ? 'true' : undefined} disabled={busy} onClick={() => onSelect(schedule.id)}>
          <span className="dsh-schedule-item-heading"><strong>{schedule.title}</strong><IconChevronRightOutlineRegular className="dsh-schedule-item-chevron" size={16} aria-hidden="true" /></span>
          <span className="dsh-schedule-item-session">{target === undefined ? text('p3.schedule.targetUnavailable') : sessionLabel(target, text)}</span>
          <FutureTime copy={text} row={row} snapshot={snapshot} compact />
          {!compact && <span className="dsh-schedule-recent" data-status={run?.status}>{run === undefined ? text("p5.schedule.noRunsShort") : <><Timestamp copy={text} value={run.link.plannedAt} /> · {runLabel(run, text)}</>}</span>}
          {run?.note !== undefined && (run.status === 'delivery-failed' || run.status === 'execution-failed' || run.status === 'unknown') && <span className="dsh-schedule-note">{run.note}</span>}
        </Button>
        <div className="dsh-schedule-item-actions">
          {onEnabled === undefined ? <><ScheduleEnabled copy={text} enabled={schedule.enabled} />{onEdit !== undefined && <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => onEdit(schedule)}>{text('p3.schedule.manage')}</Button>}</>
            : <Switch label={text(schedule.enabled ? 'p3.schedule.disable' : 'p3.schedule.enable', { title: schedule.title })} checked={schedule.enabled} disabled={busy} onChange={enabled => onEnabled(schedule, enabled)} />}
          {onEnabled !== undefined && <ActionMenu label={text('p3.schedule.more', { title: schedule.title })} disabled={busy} items={[
            ...(onEdit === undefined ? [] : [{ id: 'edit', label: text('p3.schedule.edit') }]),
            ...(onRun === undefined ? [] : [{ id: 'run', label: text('p3.schedule.run'), disabled: snapshot.projectArchived || target === undefined || target.archived }]),
            ...(onRemove === undefined ? [] : [{ id: 'remove', label: text('p3.schedule.remove'), danger: true }]),
          ]} onSelect={action => { if (action === 'edit') onEdit?.(schedule); else if (action === 'run') onRun?.(schedule); else if (action === 'remove') onRemove?.(schedule) }} />}
        </div>
      </div>
    })}</section>
  })}{rows.length === 0 && <EmptyState title={text("p5.schedule.noSchedules")} />}</div>
    {removed.length > 0 && <details className="dsh-schedule-details dsh-schedule-removed"><summary>{text("p5.schedule.removedHistoryPrefix")}{removed.length}{text("p5.common.closeParenthesis")}</summary>{[...new Set(removed.map(run => run.link.scheduleId))].map(id => {
      const run = removed.find(run => run.link.scheduleId === id)!
      return <Button variant="ghost" size="sm" className="dsh-schedule-item dsh-schedule-item--removed" key={id} type="button" aria-current={selectedId === id ? 'true' : undefined} disabled={busy} onClick={() => onSelect(id)}><span className="dsh-schedule-item-heading"><strong>{text("p5.schedule.removed")}</strong><IconChevronRightOutlineRegular className="dsh-schedule-item-chevron" size={16} aria-hidden="true" /></span><span className="dsh-schedule-note">{snapshot.targets.find(target => target.id === run.link.sessionId)?.title ?? text("p5.schedule.originalSessionUnavailable")}</span><span className="dsh-schedule-recent" data-status={run.status}><Timestamp copy={text} value={run.link.plannedAt} /> · {runLabel(run, text)}</span></Button>
    })}</details>}
  </>
}
function FutureTime({ row, snapshot, compact = false , copy}: { readonly row: ScheduleSnapshot['schedules'][number] & { readonly timeUnconfirmed?: true }; readonly snapshot: ScheduleSnapshot; readonly compact?: boolean ; readonly copy: ProjectsTranslate }): ReactNode {
  const target = snapshot.targets.find(target => target.id === row.schedule.sessionId)
  const unavailable = target === undefined
  const archived = snapshot.projectArchived || target?.archived
  const text = archived ? copy("p5.schedule.archivedTriggerEffects")
    : unavailable ? copy("p5.schedule.sessionTriggerUnconfirmed") : !row.schedule.enabled ? copy("p5.schedule.futureTriggersDisabled") : undefined
  if (text !== undefined) return compact ? <span className="dsh-schedule-next-summary">{text}</span> : <p className="dsh-schedule-next">{text}</p>
  if (row.timeUnconfirmed) return compact ? <span className="dsh-schedule-next-summary">{copy('wholeRead.schedule.timeUnconfirmed')}</span> : <p className="dsh-schedule-next">{copy('wholeRead.schedule.timeUnconfirmed')}</p>
  if (compact) return <span className="dsh-schedule-next-summary">{row.time.kind === 'future' ? <>{copy("p5.schedule.nextRun")}{' '}{row.time.nextAt === undefined ? copy("p5.schedule.timeNotReturned") : <Timestamp copy={copy} value={row.time.nextAt} timeZone={row.schedule.rule.timeZone} />}</> : row.time.kind === 'expired-once' ? copy("p5.schedule.oneTimeExpiredShort") : copy("p5.schedule.noFutureTimesShort")} · {row.schedule.rule.timeZone}</span>
  return <NextTime copy={copy} time={row.time} timeZone={row.schedule.rule.timeZone} />
}
function NextTime({ time, timeZone, copy}: { readonly time: ScheduleTimeView; readonly timeZone: string; readonly copy: ProjectsTranslate }): ReactNode {
  if (time.kind === 'future') return <p className="dsh-schedule-next"><span className="dsh-schedule-caption">{copy("p5.schedule.nextRunPreview")}</span>{time.nextAt === undefined ? copy("p5.schedule.nextTimeNotReturned") : <><Timestamp copy={copy} value={time.nextAt} timeZone={timeZone} /> · {timeZone}</>}</p>
  return <p className="dsh-schedule-next">{time.kind === 'expired-once' ? copy("p5.schedule.oneTimeExpired") : copy("p5.schedule.noFutureTimes")}</p>
}
function ScheduleEnabled({ enabled , copy}: { readonly enabled: boolean ; readonly copy: ProjectsTranslate }): ReactNode { return <Tag tone={enabled ? 'success' : 'neutral'}>{enabled ? copy("p5.schedule.enabled") : copy("p5.schedule.disabled")}</Tag> }
function ScheduleSources({ title, sources, onOpenSource , copy}: { readonly title: string; readonly sources: readonly ScheduleSource[]; readonly onOpenSource: SchedulePanelProps['onOpenSource'] ; readonly copy: ProjectsTranslate }): ReactNode {
  return <div className="dsh-schedule-sources"><strong>{title}</strong>{sources.length === 0 ? <p className="dsh-schedule-note">{copy("p5.schedule.noSourceLocation")}</p> : sources.map((source, index) => <div key={index}><span>{sourceLabel(source, copy)}</span>{onOpenSource !== undefined && (source.kind === 'message' || source.kind === 'tool' || source.kind === 'native-event') && <Button variant="ghost" size="sm" type="button" onClick={() => onOpenSource(source)}>{copy("project.sources.open")}</Button>}</div>)}</div>
}
function RunLocation({ sessionId, refs, onOpenSource, onOpenSession , copy}: {
  readonly sessionId: string; readonly refs: readonly ScheduleRunRef[]; readonly onOpenSource: SchedulePanelProps['onOpenSource']; readonly onOpenSession: SchedulePanelProps['onOpenSession']
; readonly copy: ProjectsTranslate }): ReactNode {
  const sources = refs.filter((ref): ref is Extract<ScheduleRunRef, { kind: 'message' | 'tool' }> => ref.kind === 'message' || ref.kind === 'tool')
  return <div className="dsh-schedule-toolbar">{sources.map((source, index) => onOpenSource !== undefined && <Button variant="ghost" size="sm" key={index} type="button" onClick={() => onOpenSource(source)}>{sources.length === 1 ? copy("p5.schedule.viewRunSource") : copy("p5.schedule.viewSourceNumber", { value: source.kind === 'message' ? copy("p5.schedule.inputMessage") : copy("p5.schedule.toolCall"), value1: index + 1 })}</Button>)}{onOpenSession !== undefined && <Button variant="ghost" size="sm" type="button" onClick={() => onOpenSession(sessionId)}>{copy("p5.schedule.openOriginalSession")}</Button>}{sources.length === 0 && <span className="dsh-schedule-note">{copy("p5.schedule.noDirectRunSource")}</span>}</div>
}
function ManualRunResult({ result, onOpenSource, onOpenSession , copy}: {
  readonly result: ManualRunAdmissionResult; readonly onOpenSource: SchedulePanelProps['onOpenSource']; readonly onOpenSession: SchedulePanelProps['onOpenSession']
; readonly copy: ProjectsTranslate }): ReactNode {
  const refs: ScheduleRunRef[] = result.link?.refs ?? (result.native !== undefined && result.hostSessionId !== undefined ? [{ kind: 'message', hostSessionId: result.hostSessionId, messageId: result.native.messageId }] : [])
  return <section className="dsh-schedule-notice dsh-schedule-receipt" aria-label={copy("p5.schedule.admissionReceipt")} role="status"><h3>{copy("p5.schedule.admissionReceipt")}</h3><p>{copy("p5.schedule.admissionReceiptDescription")}</p><p>{manualResultText(result, copy)}</p><p>{copy("p5.schedule.runLinkSavedPrefix")}{persistenceLabel(result.runLinkSaved, copy)}{copy("p5.schedule.sessionInputSavedFragment")}{persistenceLabel(result.nativeSaved, copy)}{copy("p5.common.period")}</p>{result.requestedAt !== undefined && <p>{copy("p5.schedule.requestTimePrefix")}<Timestamp copy={copy} value={result.requestedAt} /></p>}<p>{copy("p5.schedule.taskOutcomeUnconfirmed")}</p>{result.sessionId !== undefined && <RunLocation copy={copy} sessionId={result.sessionId} refs={refs} onOpenSource={onOpenSource} onOpenSession={onOpenSession} />}</section>
}
function RunHistory({ runs, onOpenSource, onOpenSession, text }: {
  readonly runs: readonly ScheduleRunView[]; readonly onOpenSource: SchedulePanelProps['onOpenSource']; readonly onOpenSession: SchedulePanelProps['onOpenSession']
  readonly text: ProjectsTranslate
}): ReactNode {
  const card = (run: ScheduleRunView): ReactNode => <article className="dsh-schedule-run" data-status={run.status} key={run.link.id}>
    <header><span>{text(run.link.trigger === 'manual' ? 'p3.schedule.manualRequestedAt' : 'p3.schedule.plannedAt')}<Timestamp copy={text} value={run.link.plannedAt} /></span><Tag className="dsh-schedule-run-tag" tone={runTone(run)}><span className="dsh-schedule-run-status">{runLabel(run, text)}</span></Tag><small>{run.link.trigger === 'manual' ? text("p5.schedule.manualRun") : text("p5.schedule.automaticSchedule")}</small></header>
    {run.note !== undefined && <p className="dsh-schedule-note">{run.note}</p>}
    <p className="dsh-schedule-note">{text('p3.schedule.processingStartedAt')}{run.native?.timing?.processingStartedAt == null ? text('p5.common.unknown') : <Timestamp copy={text} value={run.native.timing.processingStartedAt} />}</p>
    <p className="dsh-schedule-note">{text('p3.schedule.observedAt')}<Timestamp copy={text} value={run.link.observedAt} /></p>
    <RunLocation copy={text} sessionId={run.link.sessionId} refs={run.link.refs} onOpenSource={onOpenSource} onOpenSession={onOpenSession} />
  </article>
  return <section className="dsh-schedule-history" aria-label={text("p5.schedule.runLinksAndStatus")}><h3>{text('p3.schedule.history')}</h3>{runs.length === 0 ? <p className="dsh-schedule-note">{text("p5.schedule.noRuns")}</p> : <div className="dsh-schedule-list">{runs.map(card)}</div>}<p className="dsh-schedule-note">{text("p5.schedule.runHistoryExplanation")}</p></section>
}
function runTone(run: ScheduleRunView): 'neutral' | 'warning' | 'danger' | 'success' {
  if (run.native?.discarded && !run.native.claimed || run.native?.end === 'completed') return 'neutral'
  if (run.status === 'achieved') return 'success'
  if (run.status === 'delivery-failed' || run.status === 'execution-failed' || run.status === 'not-achieved') return 'danger'
  return run.status === 'unknown' || run.status === 'waiting-permission' ? 'warning' : 'neutral'
}
function sortedRuns(runs: readonly ScheduleRunView[]): ScheduleRunView[] {
  const compare = (left: string, right: string): number => { const delta = Date.parse(right) - Date.parse(left); return Number.isFinite(delta) ? delta : right.localeCompare(left) }
  return [...runs].sort((left, right) => compare(left.link.observedAt, right.link.observedAt) || compare(left.link.plannedAt, right.link.plannedAt))
}
function runLabel(run: ScheduleRunView, copy: ProjectsTranslate = projectCopy()): string {
  if (run.native?.discarded && !run.native.claimed) return copy("p5.schedule.unstartedInputCancelled")
  if (run.native?.end === 'completed') return copy("p5.schedule.turnEnded")
  return runStatusLabel(run.status, copy)
}

function ScheduleForm({
  editor, targets, busy, fieldError, onChange, onCancel, onSave, text,
}: {
  readonly editor: ScheduleEditor
  readonly targets: readonly ScheduleSession[]
  readonly busy: boolean
  readonly fieldError?: ScheduleFormError | undefined
  readonly onChange: (editor: ScheduleEditor) => void
  readonly onCancel: () => void
  readonly onSave: (event: FormEvent) => Promise<void>
  readonly text: ProjectsTranslate
}): ReactNode {
  const errorId = useId()
  const form = useRef<HTMLFormElement>(null)
  useLayoutEffect(() => {
    if (fieldError === undefined) return
    const selector = fieldError.field === 'rule-weekdays' ? '.dsh-schedule-weekdays input[type="checkbox"]' : `[name="${fieldError.field}"]`
    form.current?.querySelector<HTMLElement>(selector)?.focus()
  }, [fieldError])
  const setRule = (rule: RuleDraft): void => onChange({ ...editor, rule })
  const target = targets.find(candidate => candidate.id === editor.sessionId)
  return <form ref={form} className="dsh-schedule-form" onSubmit={event => { void onSave(event) }}>
    <fieldset disabled={busy}>
      <legend className="dsh-schedule-form-legend">{editor.mode === 'create' ? text("p5.schedule.add") : text("p5.schedule.edit")}</legend>
      <div className="dsh-schedule-form-section">
      {editor.mode === 'create' ? <label className="projects-ui__field">{text("p5.schedule.session")}<Select aria-label={text("p5.schedule.session")} name="schedule-target" disabled={busy} required value={editor.sessionId} onValueChange={sessionId => onChange({ ...editor, sessionId })}>
          {!targets.some(candidate => candidate.id === editor.sessionId) && <option value={editor.sessionId}>{text("p5.schedule.originalTargetUnavailable")}</option>}{targets.map(candidate => <option key={candidate.id} value={candidate.id}>{sessionLabel(candidate, text)}</option>)}
        </Select>
      </label> : <p className="dsh-schedule-note">{text("p5.schedule.sessionPrefix")}{target === undefined ? editor.sessionId : sessionLabel(target, text)}{text("p5.schedule.sessionUnchangedSuffix")}</p>}
      <label className="projects-ui__field">{text("p5.schedule.name")}<Input name="schedule-title" data-modal-autofocus required value={editor.title} {...fieldErrorProps("schedule-title", fieldError, errorId)} onChange={event => onChange({ ...editor, title: event.target.value })} /><FieldError field="schedule-title" error={fieldError} id={errorId} /></label>
      <label className="projects-ui__field">{text("p5.schedule.taskForOriginalSession")}<Textarea name="schedule-prompt" required rows={5} value={editor.prompt} {...fieldErrorProps("schedule-prompt", fieldError, errorId)} onChange={event => onChange({ ...editor, prompt: event.target.value })} /><FieldError field="schedule-prompt" error={fieldError} id={errorId} /></label>
      </div>
      <RuleFields copy={text} rule={editor.rule} disabled={busy} onChange={setRule} error={fieldError} errorId={errorId} />
      <div className="dsh-schedule-check"><Switch label={text("p5.schedule.enableFutureTriggers")} checked={editor.enabled} disabled={busy} onChange={enabled => onChange({ ...editor, enabled })} /><span>{text("p5.schedule.enableFutureTriggers")}</span>{editor.enabled && <input type="hidden" name="schedule-enabled" value="on" />}</div>
      <p className="dsh-schedule-note">{text("p5.schedule.editEffects")}</p><div className="dsh-schedule-toolbar dsh-schedule-form-actions"><Button variant="outline" size="md" type="button" onClick={onCancel}>{text('p3.schedule.cancel')}</Button><Button variant="primary" size="md" type="submit">{text(busy ? 'p3.schedule.saving' : 'p3.schedule.save')}</Button></div>
    </fieldset>
  </form>
}

function RuleFields({ rule, disabled, onChange, copy, error, errorId }: { readonly rule: RuleDraft; readonly disabled: boolean; readonly onChange: (rule: RuleDraft) => void; readonly copy: ProjectsTranslate; readonly error: ScheduleFormError | undefined; readonly errorId: string }): ReactNode {
  const changeKind = (kind: RuleDraft['kind']): void => onChange(defaultRule(kind, rule.timeZone))
  return <section className="dsh-schedule-rule" aria-label={copy("p5.schedule.rules")}>
    <h4>{copy("p5.schedule.executionRules")}</h4>
    <label className="projects-ui__field">{copy("p5.schedule.ruleType")}<Select aria-label={copy("p5.schedule.ruleType")} name="rule-kind" disabled={disabled} value={rule.kind} onValueChange={value => changeKind(value as RuleDraft['kind'])}>
      <option value="at">{copy("p5.schedule.specificDateTime")}</option><option value="after">{copy("p5.schedule.oneTimeDelay")}</option><option value="every">{copy("p5.schedule.fixedInterval")}</option>
      <option value="daily">{copy("p5.schedule.daily")}</option><option value="weekly">{copy("p5.schedule.weekly")}</option><option value="cron">{copy("p5.schedule.cronExpression")}</option>
    </Select></label>
    {rule.kind === 'at' && <div className="dsh-schedule-row"><label className="projects-ui__field">{copy("p5.schedule.date")}<Input name="rule-date" type="date" required value={rule.date} {...fieldErrorProps("rule-date", error, errorId)} onChange={event => onChange({ ...rule, date: event.target.value })} /><FieldError field="rule-date" error={error} id={errorId} /></label><TimeInput copy={copy} value={rule.time} onChange={time => onChange({ ...rule, time })} error={error} errorId={errorId} /></div>}
    {rule.kind === 'after' && <DurationInput name="rule-after-seconds" label={copy("p5.schedule.delayAmount")} value={rule.duration} onChange={duration => onChange({ ...rule, duration })} copy={copy} disabled={disabled} error={error} errorId={errorId} />}
    {rule.kind === 'every' && <DurationInput name="rule-every-seconds" label={copy("p5.schedule.intervalAmount")} value={rule.duration} onChange={duration => onChange({ ...rule, duration })} copy={copy} disabled={disabled} error={error} errorId={errorId} />}
    {rule.kind === 'daily' && <TimeInput copy={copy} value={rule.time} onChange={time => onChange({ ...rule, time })} error={error} errorId={errorId} />}
    {rule.kind === 'weekly' && <><TimeInput copy={copy} value={rule.time} onChange={time => onChange({ ...rule, time })} error={error} errorId={errorId} /><fieldset className="dsh-schedule-weekdays" {...fieldErrorProps("rule-weekdays", error, errorId)}><legend>{copy("p5.schedule.weekdays")}</legend>{weekdays.map(({ value, label }) => <React.Fragment key={value}><Checkbox className="dsh-schedule-check" label={copy(label)} checked={rule.weekdays.includes(value)} disabled={disabled} onChange={checked => onChange({ ...rule, weekdays: checked ? [...rule.weekdays, value].sort((left, right) => left - right) : rule.weekdays.filter(day => day !== value) })} />{rule.weekdays.includes(value) && <input type="hidden" name={`rule-weekday-${value}`} value="on" />}</React.Fragment>)}<FieldError field="rule-weekdays" error={error} id={errorId} /></fieldset></>}
    {rule.kind === 'cron' && <label className="projects-ui__field">{copy("p5.schedule.cronExpression")}<Input name="rule-cron" required value={rule.expression} {...fieldErrorProps("rule-cron", error, errorId)} onChange={event => onChange({ ...rule, expression: event.target.value })} /><FieldError field="rule-cron" error={error} id={errorId} /></label>}
    <label className="projects-ui__field">{copy("p5.schedule.timeZone")}<Input name="rule-time-zone" required value={rule.timeZone} {...fieldErrorProps("rule-time-zone", error, errorId)} onChange={event => onChange({ ...rule, timeZone: event.target.value })} placeholder={copy("p5.schedule.timeZoneExample")} /><FieldError field="rule-time-zone" error={error} id={errorId} /></label>
    {(rule.kind === 'at' || rule.kind === 'daily' || rule.kind === 'weekly') && <>
      <small>{copy("p5.schedule.timeZoneExplanation")}</small>
      <details className="dsh-schedule-details"><summary>{copy("p5.schedule.timeInputHelp")}</summary><p className="dsh-schedule-note">{copy("p5.schedule.timeInputExplanation")}</p></details>
    </>}
  </section>
}

function TimeInput({ value, onChange, copy, error, errorId }: { readonly value: string; readonly onChange: (time: string) => void; readonly copy: ProjectsTranslate; readonly error: ScheduleFormError | undefined; readonly errorId: string }): ReactNode {
  return <label className="projects-ui__field">{copy("p5.schedule.time")}<Input name="rule-time" type="time" step="0.001" required value={value} {...fieldErrorProps("rule-time", error, errorId)} onChange={event => onChange(event.target.value)} /><FieldError field="rule-time" error={error} id={errorId} /></label>
}

function DurationInput({ name, label, value, onChange, copy, disabled, error, errorId }: { readonly name: "rule-after-seconds" | "rule-every-seconds"; readonly label: string; readonly value: DurationDraft; readonly onChange: (value: DurationDraft) => void; readonly copy: ProjectsTranslate; readonly disabled: boolean; readonly error: ScheduleFormError | undefined; readonly errorId: string }): ReactNode {
  return <div className="dsh-schedule-row"><label className="projects-ui__field">{label}<Input name={name} inputMode="decimal" value={value.amount} {...fieldErrorProps(name, error, errorId)} onChange={event => onChange({ ...value, amount: event.target.value })} /><FieldError field={name} error={error} id={errorId} /></label><label className="projects-ui__field">{copy('p5.schedule.durationUnit')}<Select name={name.replace('-seconds', '-unit')} aria-label={`${label} · ${copy('p5.schedule.durationUnit')}`} disabled={disabled} value={value.unit} onValueChange={unit => onChange({ ...value, unit: unit as DurationUnit })}>
    <option value="seconds">{copy('p5.schedule.durationSeconds')}</option><option value="minutes">{copy('p5.schedule.durationMinutes')}</option><option value="hours">{copy('p5.schedule.durationHours')}</option><option value="days">{copy('p5.schedule.durationDays')}</option>
  </Select></label></div>
}

function fieldErrorProps(field: ScheduleFormField, error: ScheduleFormError | undefined, id: string): { 'aria-invalid'?: true; 'aria-describedby'?: string } {
  return error?.field === field ? { 'aria-invalid': true, 'aria-describedby': id } : {}
}
function FieldError({ field, error, id }: { readonly field: ScheduleFormField; readonly error: ScheduleFormError | undefined; readonly id: string }): ReactNode {
  return error?.field === field ? <span id={id} className="projects-ui__field-error" role="alert">{error.message}</span> : null
}
function inputFieldName(field: ScheduleInputField): ScheduleFormField {
  const fields: Record<ScheduleInputField, ScheduleFormField> = { title: 'schedule-title', timeZone: 'rule-time-zone', expression: 'rule-cron',
    date: 'rule-date', time: 'rule-time', weekdays: 'rule-weekdays', afterSeconds: 'rule-after-seconds', everySeconds: 'rule-every-seconds' }
  return fields[field]
}

function newEditor(projectId: string, target: ScheduleSession): ScheduleEditor {
  return { projectId, mode: 'create', sessionId: target.id, title: '', prompt: '', rule: defaultRule('daily', browserTimeZone()), enabled: true }
}

function editorForSchedule(projectId: string, schedule: ProjectSchedule): ScheduleEditor {
  return {
    projectId, mode: 'edit', id: schedule.id, expectedRevision: schedule.revision, sessionId: schedule.sessionId,
    title: schedule.title, prompt: schedule.prompt, rule: draftForRule(schedule.rule), enabled: schedule.enabled,
  }
}

function defaultRule(kind: RuleDraft['kind'], timeZone: string): RuleDraft {
  const zone = timeZone.trim() || browserTimeZone()
  switch (kind) {
    case 'at': return { kind, date: '', time: '09:00:00', timeZone: zone }
    case 'after': return { kind, duration: draftForDuration(3600), timeZone: zone }
    case 'every': return { kind, duration: draftForDuration(3600), timeZone: zone }
    case 'daily': return { kind, time: '09:00:00', timeZone: zone }
    case 'weekly': return { kind, time: '09:00:00', timeZone: zone, weekdays: [1] }
    case 'cron': return { kind, expression: '0 9 * * *', timeZone: zone }
  }
}

function draftForRule(rule: ScheduleRule): RuleDraft {
  switch (rule.kind) {
    case 'at': return { ...rule, time: displayTime(rule.time) }
    case 'after': return { kind: rule.kind, duration: draftForDuration(rule.afterSeconds), timeZone: rule.timeZone }
    case 'every': return { kind: rule.kind, duration: draftForDuration(rule.everySeconds), timeZone: rule.timeZone }
    case 'daily': return { ...rule, time: displayTime(rule.time) }
    case 'weekly': return { ...rule, time: displayTime(rule.time), weekdays: [...rule.weekdays] }
    case 'cron': return { ...rule }
  }
}

function inputForEditor(editor: ScheduleEditor, copy: ProjectsTranslate = projectCopy()): SaveScheduleInput {
  const title = editor.title.trim()
  if (title === '') throw new ScheduleFormError("schedule-title", copy("p5.schedule.titleRequired"))
  if (editor.prompt.trim() === '') throw new ScheduleFormError("schedule-prompt", copy("p5.schedule.promptRequired"))
  return {
    ...(editor.id === undefined ? {} : { id: editor.id, expectedRevision: editor.expectedRevision }),
    sessionId: editor.sessionId, title, prompt: editor.prompt, rule: ruleForSave(editor.rule, copy), enabled: editor.enabled,
  }
}

function ruleForSave(rule: RuleDraft, copy: ProjectsTranslate = projectCopy()): ScheduleRule {
  const timeZone = rule.timeZone.trim()
  if (timeZone === '') throw new ScheduleFormError("rule-time-zone", copy("p5.schedule.timeZoneRequired"))
  switch (rule.kind) {
    case 'at':
      if (rule.date === '') throw new ScheduleFormError("rule-date", copy("p5.schedule.dateRequired"))
      return { kind: rule.kind, date: rule.date, time: normalizedTime(rule.time, copy), timeZone }
    case 'after': return { kind: rule.kind, afterSeconds: durationForSave(rule.duration, "rule-after-seconds", copy("p5.schedule.delaySeconds"), copy), timeZone }
    case 'every': return { kind: rule.kind, everySeconds: durationForSave(rule.duration, "rule-every-seconds", copy("p5.schedule.intervalSeconds"), copy), timeZone }
    case 'daily': return { kind: rule.kind, time: normalizedTime(rule.time, copy), timeZone }
    case 'weekly':
      if (rule.weekdays.length === 0) throw new ScheduleFormError("rule-weekdays", copy("p5.schedule.weekdayRequired"))
      return { kind: rule.kind, time: normalizedTime(rule.time, copy), timeZone, weekdays: [...rule.weekdays] }
    case 'cron':
      if (rule.expression.trim() === '') throw new ScheduleFormError("rule-cron", copy("p5.schedule.cronRequired"))
      return { kind: rule.kind, expression: rule.expression.trim(), timeZone }
  }
}

/** 只补齐秒数并保留已有 1–3 位毫秒，不解析 Date，因此不会把本地日期或时间改写成 UTC。 */
function normalizedTime(value: string, copy: ProjectsTranslate = projectCopy()): string {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?$/.exec(value.trim())
  if (match === null) throw new ScheduleFormError("rule-time", copy("p5.schedule.timeFormatRequired"))
  const hour = Number(match[1]); const minute = Number(match[2]); const second = Number(match[3] ?? '0')
  if (hour > 23 || minute > 59 || second > 59) throw new ScheduleFormError("rule-time", copy("p5.schedule.timeOutOfRange"))
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}${match[4] ?? ''}`
}

function displayTime(value: string): string { try { return normalizedTime(value) } catch { return value } }
function durationForSave(value: DurationDraft, field: ScheduleFormField, label: string, copy: ProjectsTranslate = projectCopy()): number {
  const parsed = secondsForDuration(value)
  if (parsed === undefined) throw new ScheduleFormError(field, copy("p5.schedule.positiveIntegerRequired", { value: label }))
  return parsed
}
function browserTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}
function automaticDispatchText(snapshot: ScheduleSnapshot, copy: ProjectsTranslate = projectCopy()): string {
  if (snapshot.automaticDispatch === 'not-connected') return copy("p5.schedule.notConnected")
  const fact = snapshot.automaticAvailability
  const state = fact?.kind === 'available' ? copy("p5.schedule.availableAtLastCheck") : fact?.kind === 'unavailable' ? copy("p5.schedule.unavailableAtLastCheck") : copy("p5.schedule.localAvailabilityUnconfirmed")
  return [copy("p5.schedule.connected"), state, fact?.observedAt === undefined ? undefined : copy("p5.schedule.checkedAt", { value: formatUiDate(fact.observedAt, copy, { seconds: true }) }),
    fact?.reason].filter(Boolean).join(copy("p5.common.semicolon"))
}
function writeResultText(result: Exclude<ScheduleWriteResult, { kind: 'conflict' }>, savedText: string, copy: ProjectsTranslate = projectCopy()): string {
  const sentenceBoundary = copy('p5.common.sentenceBoundary')
  const effects = result.effects
  const configuration = effects?.configuration ?? (result.kind === 'failed' ? 'unconfirmed' : 'confirmed')
  let text = configuration === 'confirmed'
    ? (result.kind === 'removed' ? copy("p5.schedule.removedHistoryRetained") : savedText)
    : configuration === 'unchanged' ? copy("p5.schedule.settingsUnchanged") : copy("p5.schedule.saveUnconfirmed")
  const pending = effects?.pending
  if (pending?.kind === 'applied') {
    const changes = [
      ...(pending.updatedMessageIds.length > 0 ? [copy("p5.schedule.pendingContentUpdated")] : []),
      ...(pending.removedMessageIds.length > 0 ? [copy("p5.schedule.pendingRunCancelled")] : []),
    ]
    text += sentenceBoundary + (changes.length > 0 ? changes.join(copy("p5.common.semicolon")) + copy("p5.common.period") : copy("p5.schedule.pendingInputsChecked"))
  } else if (pending?.kind === 'unchanged') {
    text += sentenceBoundary + (copy("p5.schedule.noPendingAdjustments"))
  } else if (pending?.kind === 'unconfirmed' || result.pendingInputIntegration === 'partial') {
    text += sentenceBoundary + (copy("p5.schedule.pendingAdjustmentsUnconfirmed"))
  } else if (result.pendingInputIntegration === 'applied') {
    text += sentenceBoundary + (copy("p5.schedule.pendingInputsProcessed"))
  } else {
    text += sentenceBoundary + (copy("p5.schedule.pendingAdjustmentNotConnected"))
  }
  if (effects?.nativeSaved === 'unconfirmed') text += sentenceBoundary + (copy("p5.schedule.pendingChangesSaveUnconfirmed"))
  if (result.kind === 'failed') text += sentenceBoundary + (copy("p5.schedule.operationIncompletePrefix") + result.error + copy("p5.common.period"))
  return text + sentenceBoundary + copy("p5.schedule.activeWorkUnaffected")
}
function manualResultText(result: ManualRunAdmissionResult, copy: ProjectsTranslate = projectCopy()): string {
  const sentenceBoundary = copy('p5.common.sentenceBoundary')
  let text = result.kind === 'conflict' ? copy("p5.schedule.changedAtSubmission")
    : result.admission === 'enqueued'
      ? copy("p5.schedule.enqueueConfirmedAtSubmission")
      : result.admission === 'not-enqueued' ? copy("p5.schedule.notEnqueuedAtSubmission")
        : copy("p5.schedule.enqueueUnconfirmedAtSubmission")
  if (result.kind === 'existing') text += sentenceBoundary + (copy("p5.schedule.existingRequest"))
  if (result.error !== undefined) text += sentenceBoundary + (copy("p5.schedule.submissionNotePrefix") + result.error + copy("p5.common.period"))
  return text
}
function persistenceLabel(value: ManualRunAdmissionResult['nativeSaved'], copy: ProjectsTranslate = projectCopy()): string {
  return value === 'confirmed' ? copy("tool.card.fact.confirmed") : value === 'unconfirmed' ? copy("p5.schedule.unconfirmed") : copy("p5.schedule.saveNotRequired")
}
function conflictText(result: Extract<ScheduleWriteResult, { kind: 'conflict' }>, copy: ProjectsTranslate = projectCopy()): string { return result.current === undefined ? copy("p5.schedule.changedOrMissing") : copy("p5.schedule.updatedElsewhere") }
function errorText(error: unknown): string { return typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error) }
function sessionLabel(session: ScheduleSession, copy: ProjectsTranslate = projectCopy()): string { return  copy("p5.common.punctuationTemplate4", { value: session.title, value1: session.role === 'main' ? copy("project.conversation.main") : copy("project.conversation.execution"), value2: session.archived ? copy("p5.schedule.archivedFragment") : '' }) }
function ruleLabel(rule: ScheduleRule, copy: ProjectsTranslate = projectCopy()): string {
  switch (rule.kind) {
    case 'at': return copy("p5.schedule.specificDateTimeSummary", { value: rule.date, value1: rule.time, value2: rule.timeZone })
    case 'after':
    case 'every': {
      const { amount, unit } = draftForDuration(rule.kind === 'after' ? rule.afterSeconds : rule.everySeconds)
      const units = { seconds: 'p5.schedule.durationSeconds', minutes: 'p5.schedule.durationMinutes', hours: 'p5.schedule.durationHours', days: 'p5.schedule.durationDays' } as const
      return copy(rule.kind === 'after' ? 'p5.schedule.oneTimeDelayDurationSummary' : 'p5.schedule.fixedIntervalDurationSummary', { amount, unit: copy(units[unit]), timeZone: rule.timeZone })
    }
    case 'daily': return copy("p5.schedule.dailySummary", { value: rule.time, value1: rule.timeZone })
    case 'weekly': return copy("p5.schedule.weeklySummary", { value: rule.weekdays.map(day => weekdayLabel(day, copy)).join(copy("p5.common.listSeparator")), value1: rule.time, value2: rule.timeZone })
    case 'cron': return copy("p5.common.punctuationTemplate5", { value: rule.expression, value1: rule.timeZone })
  }
}
function sourceLabel(source: ScheduleSource, copy: ProjectsTranslate = projectCopy()): string {
  switch (source.kind) {
    case 'native-event': return copy("p5.schedule.originalEvent", { value: source.eventType, value1: source.eventSeq })
    case 'message': return copy("p5.schedule.originalMessage")
    case 'tool': return copy("p5.schedule.originalToolCall")
    case 'settings': return copy("p5.schedule.settingsChange")
    case 'record': return copy("p5.schedule.historicalProjectRecord")
  }
}
function runStatusLabel(status: ScheduleRunStatus, copy: ProjectsTranslate = projectCopy()): string {
  switch (status) {
    case 'unknown': return copy("p5.schedule.statusUnknown")
    case 'queued': return copy("p5.schedule.statusQueued")
    case 'processing': return copy("p5.schedule.statusProcessing")
    case 'waiting-permission': return copy("p5.schedule.statusWaitingPermission")
    case 'delivery-failed': return copy("p5.schedule.statusDeliveryFailed")
    case 'execution-failed': return copy("tool.card.failed")
    case 'not-achieved': return copy("p5.schedule.statusNotAchieved")
    case 'achieved': return copy("p5.schedule.statusAchieved")
  }
}
function Timestamp({ value, timeZone = browserTimeZone(), copy }: { readonly value: string; readonly timeZone?: string; readonly copy: ProjectsTranslate }): ReactNode {
  return <time dateTime={value} title={`${value} · ${timeZone}`}>{formatUiDate(value, copy, { timeZone, seconds: true })}</time>
}

function weekdayLabel(day: number, copy: ProjectsTranslate): string | number {
  const key = weekdays.find(item => item.value === day)?.label
  return key === undefined ? day : copy(key)
}

const weekdays = [
  { value: 1, label: "p5.schedule.monday" }, { value: 2, label: "p5.schedule.tuesday" }, { value: 3, label: "p5.schedule.wednesday" }, { value: 4, label: "p5.schedule.thursday" },
  { value: 5, label: "p5.schedule.friday" }, { value: 6, label: "p5.schedule.saturday" }, { value: 7, label: "p5.schedule.sunday" },
] as const
