/** Compact stock changed-file result card, with a real private comparison preview. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import { Button, FileTypeIcon, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconAction, IconCloseOutlineRegular } from '../../../../client/ui/index.ts'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { changesForClosing, basename } from '../deliverables/turn-deliverables.ts'
import { FileDiff } from './FileDiff.tsx'
import type { ProjectChangesScope } from './reads.ts'
import type { ChangesSummary } from './types.ts'
import type { NS } from './locales.ts'
import css from './ChangedFiles.module.css'
import diffCss from './FileDiff.module.css'

export interface ChangedFilesInjected { createChangesScope: (seq: number) => ProjectChangesScope }
type TailProps = PropsRuntime<'conversation.chat.turnTail'> & PropsLocale<typeof NS> & ChangedFilesInjected
const COLLAPSED_ROWS = 4
const GROUPED = new Intl.NumberFormat('en-US')

/** Consume the one shared durable deliverables Definition; never infer changes from reply prose. */
export function ChangedFilesTail(props: TailProps) {
  const announcement = changesForClosing(props)
  return announcement === null ? null
    : <ChangedFilesOwner key={`${props.sessionId}:${announcement.seq}`} {...props} announcementSeq={announcement.seq} />
}

function ChangedFilesOwner({ announcementSeq, createChangesScope, ...props }: TailProps & { announcementSeq: number }) {
  const [scope, setScope] = useState<ProjectChangesScope>()
  useEffect(() => {
    const value = createChangesScope(announcementSeq)
    setScope(value)
    void value.loadSummary().catch(() => {})
    return () => { value.dispose() }
  }, [announcementSeq, createChangesScope])
  return scope === undefined ? null : <ChangedFilesRead {...props} scope={scope} />
}

function ChangedFilesRead({ scope, sessionId, useSessions, t }: Omit<TailProps, 'createChangesScope'> & { scope: ProjectChangesScope }) {
  const state = useSyncExternalStore(scope.state.subscribe, scope.state.getSnapshot, scope.state.getSnapshot)
  const cwd = useSessions(value => value.byId[sessionId]?.cwd)
  if (state.stale) return null
  if (state.summary === 'loading' || state.summary === undefined) return <p role="status">{t('diff.loading')}</p>
  if (state.summary === 'missing') return <p data-changes-summary-missing>{t('diff.missing')}</p>
  if (state.summary === 'error') return <p role="alert">{t('diff.error')} <Button size="sm" onClick={() => { void scope.loadSummary().catch(() => {}) }}>{t('presented.retry')}</Button></p>
  return state.summary.files.length === 0 ? null : <ChangedFiles changes={state.summary} cwd={cwd} scope={scope} t={t} />
}

/** Preserve native file order, counts, binary/oversized metadata, and the four-row fold. */
export function ChangedFiles({ changes, cwd, scope, t }: { changes: ChangesSummary; cwd: string | undefined; scope: ProjectChangesScope } & PropsLocale<typeof NS>) {
  const [expanded, setExpanded] = useState(false)
  const [selected, setSelected] = useState<number>()
  const card = useRef<HTMLDivElement>(null), header = useRef<HTMLButtonElement>(null), opener = useRef<HTMLButtonElement | null>(null)
  const openPreview = (index: number, button: HTMLButtonElement): void => { opener.current = button; setSelected(index) }
  const closePreview = (): void => {
    setSelected(undefined)
    const target = opener.current?.isConnected === true && card.current?.contains(opener.current) === true ? opener.current : header.current
    opener.current = null
    if (target?.isConnected === true) target.focus()
  }
  const single = changes.total === 1 ? changes.files[0] : undefined
  const foldable = changes.files.length > COLLAPSED_ROWS
  const rows = foldable && !expanded ? changes.files.slice(0, COLLAPSED_ROWS) : changes.files
  const counts = (added: number, deleted: number) => <><span className={css.added}>{t('changes.added', { count: GROUPED.format(added) })}</span><span className={css.deleted}>{t('changes.deleted', { count: GROUPED.format(deleted) })}</span></>
  const stat = (file: ChangesSummary['files'][number]) => file.binary === true ? t('changes.binary') : file.oversized === true ? t('changes.oversized') : counts(file.added, file.deleted)
  return <div ref={card} className={css.card} data-changed-files data-single={single !== undefined || undefined} data-changes-session={scope.sessionId} data-changes-seq={scope.seq}>
    <button ref={header} type="button" className={css.header} aria-label={single === undefined ? t('changes.openReview') : t('changes.viewDiff', { name: single.display })}
      title={single === undefined ? undefined : resolveWorkspacePath(cwd, single.path)} onClick={event => { openPreview(0, event.currentTarget) }}>
      <span className={css.tile}><FileTypeIcon {...single === undefined ? { kind: 'code' as const } : { path: single.path }} size={20} /></span>
      <span className={css.titles}><span className={css.title}>{single === undefined ? t('changes.title', { count: String(changes.total) }) : t('changes.singleTitle', { name: basename(single.path) })}</span>
        <span className={css.stat}><span className={css.statCounts}>{single === undefined ? counts(changes.added, changes.deleted) : stat(single)}</span><span className={css.previewHint}>{t('changes.openReview')}</span></span>
      </span>
    </button>
    {single === undefined && <ul className={css.list}>{rows.map((file, index) => <li key={`${index}:${file.path}`}>
      <button type="button" className={css.row} aria-label={t('changes.viewDiff', { name: file.display })}
        title={resolveWorkspacePath(cwd, file.path)} onClick={event => { openPreview(index, event.currentTarget) }}>
        <span className={css.path}>{file.display}</span><span className={css.counts}>{stat(file)}</span>
      </button>
    </li>)}</ul>}
    {changes.total > changes.files.length && <p className={diffCss.note} data-changes-partial>{t('changes.partial', { shown: String(changes.files.length), total: String(changes.total) })}</p>}
    {foldable && <button type="button" className={css.toggle} aria-expanded={expanded}
      aria-label={t(expanded ? 'changes.collapseAria' : 'changes.expandAria', { count: String(changes.files.length) })}
      onClick={() => { setExpanded(value => !value) }}><span>{t(expanded ? 'changes.collapse' : 'changes.all', { count: String(changes.files.length) })}</span>
      {expanded ? <IconChevronUpOutlineRegular /> : <IconChevronDownOutlineRegular />}</button>}
    {selected !== undefined && changes.files[selected] !== undefined && <ChangedFilePreview key={selected} scope={scope} index={selected}
      display={resolveWorkspacePath(cwd, changes.files[selected]!.path)} close={closePreview} t={t} />}
  </div>
}

function ChangedFilePreview({ scope, index, display, close, t }: { scope: ProjectChangesScope; index: number; display: string; close: () => void } & PropsLocale<typeof NS>) {
  const state = useSyncExternalStore(scope.state.subscribe, scope.state.getSnapshot, scope.state.getSnapshot)
  const [opening, setOpening] = useState(false)
  const [failure, setFailure] = useState<string>()
  useEffect(() => { void scope.loadDiff(index).catch(() => {}) }, [scope, index])
  const active = useRef(true), inFlight = useRef(false)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const open = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setOpening(true); setFailure(undefined)
    try { await scope.openFile(index) }
    catch (error) { if (active.current) setFailure(error instanceof Error ? error.message : String(error)) }
    finally { inFlight.current = false; if (active.current) setOpening(false) }
  }
  if (state.stale) return null
  return <section className={diffCss.root} data-project-changes-preview>
    <div className={`${diffCss.header} ${css.previewHeader}`}><span className={css.previewPath} data-changes-preview-path>{display}</span>
      <Button size="sm" disabled={opening} aria-label={t('review.openFileAria', { name: display })} onClick={() => { void open() }}>{t('review.openFile')}</Button>
      <IconAction aria-label={t('changes.close')} title={t('changes.close')} icon={<IconCloseOutlineRegular size={16} />} onClick={close} />
    </div>
    {failure !== undefined && <p className={diffCss.status} role="alert">{failure}</p>}
    <FileDiff state={state.diffs[index]} split={false} wrap={false} t={t} retry={() => { void scope.loadDiff(index).catch(() => {}) }} />
  </section>
}
