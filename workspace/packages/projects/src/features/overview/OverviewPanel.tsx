import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { RefreshButton } from '../../client/WorkflowControls.tsx'
import { formatUiDate } from '../../client/ui/date-format.ts'
import { Button, EmptyState, ErrorState, IconInfoOutlineRegular, LoadingState, projectCopy, Tooltip, type ProjectsTranslate } from '../../client/ui/index.ts'
import type {
  OverviewClientActions, OverviewContent, OverviewNavigation, OverviewRow, OverviewSourceView, OverviewView,
} from './contract.ts'
import css from './OverviewPanel.module.css'

export interface OverviewPanelProps {
  readonly projectId: string
  readonly actions: OverviewClientActions
  readonly translate?: ProjectsTranslate
  /** 宿主必须绑定当前项目并只查看来源；此回调不得发送消息或开始运行。 */
  readonly onNavigate?: (target: OverviewNavigation) => void
}

/** 读取面没有写入、模型、批准、停止或补救操作。 */
export function OverviewPanel({ projectId, actions, onNavigate, translate }: OverviewPanelProps): ReactNode {
  const copy = projectCopy(translate)
  const [view, setView] = useState<OverviewView>()
  const [error, setError] = useState<{ readonly projectId: string; readonly message: string }>()
  const [loading, setLoading] = useState(true)
  const epoch = useRef(0)
  const read = useCallback(async () => {
    const current = ++epoch.current
    setError(undefined); setLoading(true)
    try {
      const value = await actions.read({ projectId })
      if (current !== epoch.current) return
      if (value.projectId !== projectId) throw new Error(copy('p3.overview.wrongProject'))
      setView(value)
    } catch (error) {
      if (current === epoch.current) setError({ projectId, message: error instanceof Error ? error.message : String(error) })
    } finally { if (current === epoch.current) setLoading(false) }
  }, [projectId, actions, copy])
  useEffect(() => { void read(); return () => { epoch.current++ } }, [read])
  const currentView = view?.projectId === projectId ? view : undefined
  return <section className="dsh-overview-panel" aria-label={copy('p3.overview.title')} aria-busy={loading}>
    <header className="dsh-overview-heading"><h2>{copy('p3.overview.title')}</h2><RefreshButton translate={copy} ariaLabel={copy('p3.overview.refresh')} loading={loading} onClick={() => { void read() }} /></header>
    {loading && currentView === undefined && <LoadingState label={copy('p3.overview.loading')} rows={3} />}
    {loading && currentView !== undefined && <p className="dsh-overview-note" role="status">{copy('p3.overview.refreshingPrevious', { time: formatUiDate(currentView.loadedAt, copy) })}</p>}
    {error !== undefined && error.projectId === projectId && <ErrorState title={copy('p3.overview.readFailed')} description={copy('p3.overview.readRecovery')} diagnostic={{ label: copy('p3.overview.readFailed'), content: error.message }} retry={() => { void read() }} retryLabel={copy('p3.overview.refresh')} />}
    {error !== undefined && error.projectId === projectId && currentView !== undefined && <p className="dsh-overview-note" role="status">{copy('p3.overview.refreshFailedPrevious', { time: formatUiDate(currentView.loadedAt, copy) })}</p>}
    {currentView !== undefined && <OverviewBoard view={currentView} onNavigate={onNavigate} translate={translate} />}
  </section>
}

/** 概况与全文同属保存区块；旧区块不做截断或自动概括。 */
export function OverviewBoard({ view, onNavigate, translate }: { readonly view: OverviewView; readonly onNavigate?: OverviewPanelProps['onNavigate']; readonly translate?: ProjectsTranslate }): ReactNode {
  const copy = projectCopy(translate)
  const anchor = (id: string) => `overview-${view.projectId}-${id}`
  const runtimeDiagnostic = view.runtime.status !== 'available'
    ? { level: 'error' as const, label: copy('p3.overview.runtimeUnavailable'), content: `${view.projectId}：${view.runtime.status}：${view.runtime.message}` }
    : { level: 'info' as const, label: copy('p3.overview.runtimeUnknown'), content: view.runtime.value.filter(item => item.state === 'unknown')
      .map(item => `${view.projectId}/${item.sessionId}：${item.reason ?? copy('p3.overview.runtimeUnknownReason')}`).join('\n') }
  // Runtime facts stay in the owner response; unchanged diagnostics do not repeat on refresh.
  useEffect(() => {
    if (runtimeDiagnostic.content !== '') console[runtimeDiagnostic.level]('[dsh-projects]', runtimeDiagnostic.label, runtimeDiagnostic.content)
  }, [runtimeDiagnostic.level, runtimeDiagnostic.label, runtimeDiagnostic.content])
  return <div className={`dsh-overview-board ${css.board}`}>
    <div className="dsh-overview-meta"><span>{copy('p3.overview.readOnly')}</span>{view.document.updatedAt !== undefined && <span>{copy('p3.overview.updated')} <Timestamp copy={copy} value={view.document.updatedAt} /></span>}
      <Tooltip label={copy('p3.overview.readHelp', { time: formatUiDate(view.loadedAt, copy) })}><Button variant="ghost" size="sm" type="button" aria-label={copy('p3.overview.readHelpLabel')} icon={<IconInfoOutlineRegular size={16} />} /></Tooltip>
    </div>
    {view.project.status !== 'available' && <ErrorState title={copy('p3.overview.projectUnavailable')} description={copy('p3.overview.factsRecovery')} diagnostic={{ label: copy('p3.overview.projectUnavailable'), content: view.project.message }} inline><small>{copy('p3.overview.sourceReadAt')} <Timestamp copy={copy} value={view.project.readAt} /></small></ErrorState>}
    {view.blocks.length === 0 ? <EmptyState icon={<IconInfoOutlineRegular size={32} />} title={copy('p3.overview.empty')} description={copy('p3.overview.emptyHelp')} /> : <>
      {view.blocks.length > 1 && <nav className={css.contents} aria-label={copy('p3.overview.contents')}>
        <span className="dsh-overview-note">{copy('p3.overview.contents')}</span>
        <div>{view.blocks.map(({ block }) => <Button variant="outline" size="sm" type="button" key={block.id} onClick={event => {
          const heading = event.currentTarget.closest('.dsh-overview-board')?.querySelector<HTMLElement>(`[id="${anchor(block.id)}"]`)
          heading?.scrollIntoView({ block: 'start', behavior: 'auto' }); heading?.focus({ preventScroll: true })
        }}>{block.title}</Button>)}</div>
      </nav>}
      <div className="dsh-overview-content">{view.blocks.map(entry => <Block key={entry.block.id} entry={entry} headingId={anchor(entry.block.id)} onNavigate={onNavigate} copy={copy} />)}</div>
    </>}
  </div>
}

function Block({ entry: { block, sources }, headingId, onNavigate, copy }: { readonly entry: OverviewView['blocks'][number]; readonly headingId: string; readonly onNavigate?: OverviewPanelProps['onNavigate']; readonly copy: ProjectsTranslate }): ReactNode {
  const hasSummary = block.summary !== undefined && block.summary.trim() !== ''
  return <section className={`dsh-overview-block ${css.block}`} aria-labelledby={headingId}>
    <h3 id={headingId} tabIndex={-1}>{block.title}</h3>
    {hasSummary ? <div className={`dsh-overview-lead ${css.lead}`} aria-label={copy('p3.overview.summary')}><PlainText text={block.summary!} /></div> : <>
      <p className="dsh-overview-note">{copy('p3.overview.legacyContent')}</p><Content content={block.content} />
    </>}
    {sources.length === 0 && <p className="dsh-overview-note">{copy(hasContent(block.content) ? 'p3.overview.noSource' : 'p3.overview.noContentSource')}</p>}
    <SourceNotices sources={sources} copy={copy} />
    <details className={`dsh-overview-full ${css.full}`}>
      <summary>{copy('p3.overview.fullContentSources')}{sources.length > 0 && <span className={css.count}>{copy('p3.overview.sourceCount', { count: sources.length })}</span>}</summary>
      <div className={css.expanded}>
        {hasSummary && <div><h4>{copy('p3.overview.bodyHeading')}</h4><Content content={block.content} /></div>}
        {block.updatedAt !== undefined && <p className="dsh-overview-note">{copy('p3.overview.blockUpdated')} <Timestamp copy={copy} value={block.updatedAt} /></p>}
        {sources.length > 0 && <div className={css.sources}><h4>{copy('p3.overview.sourcesHeading')}</h4>{sources.map((source, index) => <Source key={index} value={source} format={block.content.type} onNavigate={onNavigate} copy={copy} />)}</div>}
      </div>
    </details>
  </section>
}

function PlainText({ text }: { readonly text: string }): ReactNode {
  return <div className={css.prose}>{text.split(/\n[ \t]*\n/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
}

function Content({ content }: { readonly content: OverviewContent }): ReactNode {
  if (content.type === 'text') return content.text === '' ? null : <div className="dsh-overview-summary"><PlainText text={content.text} /></div>
  if (content.type === 'list') return content.items.length === 0 ? null : <ul className={css.list}>{content.items.map((item, index) => <li key={index}>{item}</li>)}</ul>
  if (content.columns.length === 0 && content.rows.length === 0) return null
  return <div className={`dsh-overview-table ${css.table}`} tabIndex={0}><table><thead><tr>{content.columns.map((title, index) => <th key={index} scope="col">{title}</th>)}</tr></thead><tbody>{content.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody></table></div>
}

/** 来源失败及实际范围限制始终在首层，不能因全文收起而消失。 */
function SourceNotices({ sources, copy }: { readonly sources: readonly OverviewSourceView[]; readonly copy: ProjectsTranslate }): ReactNode {
  const notices = sources.filter(value => value.status !== 'available' || value.rows.length === 0 || (value.limitations?.length ?? 0) > 0 || value.rows.some(row => (row.limitations?.length ?? 0) > 0))
  if (notices.length === 0) return null
  return <aside className={`dsh-overview-source-notices ${css.notices}`} aria-label={copy('p3.overview.sourceIssues')}>{notices.map((value, index) => <div key={index}>
    {value.status !== 'available' && <ErrorState title={copy(`p3.overview.sourceStatus.${value.status}`)} description={value.message || copy('p3.overview.sourceNotRead')} diagnostic={value.diagnostic === undefined ? undefined : { label: copy('p3.overview.sourceNotRead'), content: value.diagnostic }} inline />}
    {value.status === 'available' && value.rows.length === 0 && <p className="dsh-overview-note">{value.label}：{copy('p3.overview.noSourceRows')}</p>}
    {[...new Set([...(value.limitations ?? []), ...value.rows.flatMap(row => row.limitations ?? [])])].map((limitation, i) => <p key={i} className="dsh-overview-note">{value.label}：{limitation}</p>)}
  </div>)}</aside>
}

function Source({ value, format, onNavigate, copy }: { readonly value: OverviewSourceView; readonly format: OverviewContent['type']; readonly onNavigate?: OverviewPanelProps['onNavigate']; readonly copy: ProjectsTranslate }): ReactNode {
  return <div className={`dsh-overview-source ${css.source}`}>
    <p className="dsh-overview-note">{copy('p3.overview.sourceLabel', { label: value.label })}</p>
    {value.status === 'available' && value.rows.length === 0 && <p className="dsh-overview-note">{copy('p3.overview.noSourceRows')}</p>}
    {value.status === 'available' && <Rows rows={value.rows} format={format} onNavigate={onNavigate} copy={copy} />}
    <p className="dsh-overview-note">{copy('p3.overview.sourceReadAt')} <Timestamp copy={copy} value={value.readAt} /></p>
  </div>
}

function Rows({ rows, format, onNavigate, copy }: { readonly rows: readonly OverviewRow[]; readonly format: OverviewContent['type']; readonly onNavigate?: OverviewPanelProps['onNavigate']; readonly copy: ProjectsTranslate }): ReactNode {
  if (rows.length === 0) return null
  if (format === 'table') {
    const columns = [...new Set(rows.flatMap(row => row.fields.map(field => field.label)))]
    return <div className={`dsh-overview-table ${css.table}`} tabIndex={0}><table><thead><tr><th>{copy('p3.overview.entry')}</th>{columns.map(column => <th key={column}>{column}</th>)}<th>{copy('p3.overview.originalDetails')}</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><th scope="row">{row.title}</th>{columns.map(column => <td key={column}>{row.fields.filter(field => field.label === column).map((field, index) => <div key={index}>{field.value}</div>)}</td>)}<td><RowLinks row={row} onNavigate={onNavigate} copy={copy} /><RowReading row={row} copy={copy} /></td></tr>)}</tbody></table></div>
  }
  const children = rows.map(row => <div className="dsh-overview-row" key={row.id}>
    <strong>{row.title}</strong><dl>{row.fields.map((field, index) => <div key={index}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl><RowLinks row={row} onNavigate={onNavigate} copy={copy} /><RowReading row={row} copy={copy} />
  </div>)
  return <>{children}</>
}

function RowReading({ row, copy }: { readonly row: OverviewRow; readonly copy: ProjectsTranslate }): ReactNode {
  return <>
    {row.ownerUpdatedAt !== undefined && <p className="dsh-overview-note">{copy('p3.overview.originalTime')} <Timestamp copy={copy} value={row.ownerUpdatedAt} /></p>}
    {(row.limitations ?? []).map((limitation, index) => <p className="dsh-overview-note" key={index}>{limitation}</p>)}
  </>
}

function RowLinks({ row, onNavigate, copy }: { readonly row: OverviewRow; readonly onNavigate?: OverviewPanelProps['onNavigate']; readonly copy: ProjectsTranslate }): ReactNode {
  return <div className="dsh-overview-links">{row.links.map((link, index) => onNavigate === undefined
    ? <span key={index}>{copy('p3.overview.navigationUnavailable', { label: link.label })}</span>
    : <Button variant="outline" size="sm" type="button" key={index} onClick={() => onNavigate(link.target)}>{link.label}</Button>)}</div>
}

function Timestamp({ value, copy }: { readonly value: string; readonly copy: ProjectsTranslate }): ReactNode {
  return <Tooltip label={value}><time dateTime={value} title={value}>{formatUiDate(value, copy)}</time></Tooltip>
}
function hasContent(content: OverviewContent): boolean { return content.type === 'text' ? content.text !== '' : content.type === 'list' ? content.items.length > 0 : content.columns.length > 0 || content.rows.length > 0 }
