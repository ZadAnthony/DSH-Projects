import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type {
  ProjectUsageActions, ProjectUsageQuery, ProjectUsageResult, UsageGroup, UsageMetric,
  UsageMetricKey, UsageMetrics, UsageSession,
} from './contract.ts'
import { Button, EmptyState, ErrorState, Input, LoadingState, Select, Tooltip } from '../../client/ui/index.ts'
import { projectCopy, type ProjectsTranslate } from '../../client/ui/copy.ts'
import { formatUiDate } from '../../client/ui/date-format.ts'

export interface UsagePanelProps { readonly projectId: string; readonly actions: ProjectUsageActions; readonly translate?: ProjectsTranslate }

/** 独立设置内容；挂载与宿主桥接由核心负责。 */
export function UsagePanel(props: UsagePanelProps): ReactNode {
  return <UsagePanelProject key={props.projectId} {...props} />
}

function UsagePanelProject({ projectId, actions, translate }: UsagePanelProps): ReactNode {
  const text = projectCopy(translate)
  const [query, setQuery] = useState<ProjectUsageQuery>({ projectId })
  const scopeKey = usageQueryKey(query)
  const [snapshot, setSnapshot] = useState<{ readonly scopeKey: string; readonly value: ProjectUsageResult }>()
  const result = snapshot?.scopeKey === scopeKey ? snapshot.value : undefined
  const [readState, setReadState] = useState({ scopeKey, busy: true, error: '' })
  const busy = readState.scopeKey !== scopeKey || readState.busy
  const error = readState.scopeKey === scopeKey ? readState.error : ''
  const [rangeError, setRangeError] = useState('')
  const refreshRead = useRef<(() => void) | undefined>(undefined)
  const [session, setSession] = useState('')
  const [model, setModel] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    let active = true
    let reading = false
    let refreshPending = false
    let abort: AbortController | undefined
    const refresh = (): void => {
      if (!active) return
      // Notifications invalidate this scope; they do not replace an admitted
      // read. Remember one follow-up while it runs, regardless of burst size.
      if (reading) { refreshPending = true; return }
      reading = true
      refreshPending = false
      abort = new AbortController()
      setReadState({ scopeKey, busy: true, error: '' })
      setSnapshot(previous => previous?.scopeKey === scopeKey ? previous : undefined)
      void latest.current.query(query, abort.signal).then(value => {
        if (!active) return
        if (value.projectId !== projectId) throw new Error(text("p5.usage.projectMismatch"))
        if (usageQueryKey(value.query) !== scopeKey) throw new Error(text('wholeRead.usage.scopeMismatch'))
        setSnapshot({ scopeKey, value })
        setReadState({ scopeKey, busy: false, error: '' })
      }).catch(() => { if (active) setReadState({ scopeKey, busy: false, error: text("p5.usage.readUnavailable") }) })
        .finally(() => { reading = false; if (active && refreshPending) refresh() })
    }
    refreshRead.current = refresh
    refresh()
    return () => {
      active = false
      refreshPending = false
      if (refreshRead.current === refresh) refreshRead.current = undefined
      abort?.abort()
    }
  }, [projectId, scopeKey])
  useEffect(() => {
    let active = true
    const unsubscribe = latest.current.subscribe?.(projectId, () => { if (active) refreshRead.current?.() })
    return () => { active = false; unsubscribe?.() }
  }, [projectId, actions.subscribe])

  // 选项在当前项目内累积，避免筛选后丢失切换其它会话的入口。
  const options = useRef<ProjectUsageResult['options']>({ sessions: [], models: [] })
  if (result !== undefined) {
    options.current = {
      sessions: result.options.sessions,
      models: [...new Map([...options.current.models, ...result.options.models]
        .map(route => [JSON.stringify([route.provider, route.model]), route])).values()],
    }
  }
  const apply = (event: FormEvent): void => {
    event.preventDefault()
    const fromTime = from ? new Date(from).getTime() : undefined
    const toTime = to ? new Date(to).getTime() : undefined
    if ((fromTime !== undefined && !Number.isFinite(fromTime)) || (toTime !== undefined && !Number.isFinite(toTime))
      || (fromTime !== undefined && toTime !== undefined && fromTime >= toTime)) {
      setRangeError(text("p5.usage.invalidTimeRange")); return
    }
    setRangeError('')
    const route = options.current.models.find(item => JSON.stringify([item.provider, item.model]) === model)
    const nextQuery: ProjectUsageQuery = { projectId, ...(session ? { sessionId: session } : {}),
      ...(model === 'unattributed' ? { model: 'unattributed' as const } : route === undefined ? {} : { model: route }),
      ...(fromTime === undefined ? {} : { from: fromTime }), ...(toTime === undefined ? {} : { to: toTime }),
    }
    if (usageQueryKey(nextQuery) === scopeKey) refreshRead.current?.()
    else setQuery(nextQuery)
  }
  return <section className="dsh-usage-panel" aria-label={text("p5.usage.projectUsage")} aria-busy={busy}>

    <header className="dsh-usage-heading">
      <h2>{text('p3.usage.title')}</h2>
      <p className="dsh-usage-note">{text('p3.usage.description')}</p>
    </header>
    {result && (busy || error !== '') && <p className="dsh-usage-note" role="status">{text('wholeRead.usage.retained', { at: time(result.refreshedAt, text) })}</p>}
    {result && <UsageSummary result={result} text={text} />}
    {result && <UsageScope text={text} result={result} />}
    <form className="dsh-usage-filters" onSubmit={apply}>
      <label className="projects-ui__field">{text("project.overview.title")}{' '}<Select aria-label={text("project.overview.title")} value={session} onValueChange={setSession}>
        <option value="">{text("p5.schedule.allSessions")}</option>
        {options.current.sessions.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </Select></label>
      <label className="projects-ui__field">{text("p5.usage.model")}{' '}<Select aria-label={text("p5.usage.model")} value={model} onValueChange={setModel}>
        <option value="">{text("p5.usage.allModels")}</option><option value="unattributed">{text("p5.usage.modelBreakdownUnavailable")}</option>
        {options.current.models.map(route => <option key={JSON.stringify([route.provider, route.model])}
          value={JSON.stringify([route.provider, route.model])}>{route.provider} / {route.model}</option>)}
      </Select></label>
      <label className="projects-ui__field">{text("p5.usage.startLocalTime")}{' '}<Input aria-label={text("p5.usage.startTime")} type="datetime-local" value={from} onChange={event => setFrom(event.target.value)} /></label>
      <label className="projects-ui__field">{text("p5.usage.endExclusive")}{' '}<Input aria-label={text("p5.usage.endTime")} type="datetime-local" value={to} onChange={event => setTo(event.target.value)} /></label>
      {rangeError && <p className="projects-ui__field-error" role="alert">{rangeError}</p>}
      <div className="dsh-usage-filter-actions"><Button variant="primary" size="md" type="submit" disabled={busy}>{text("p5.usage.applyFilters")}</Button>
        <Button variant="ghost" size="md" type="button" disabled={busy} onClick={() => refreshRead.current?.()}>{text("p5.usage.refresh")}</Button></div>
    </form>
    {error && <ErrorState title={error} retry={() => refreshRead.current?.()} retryLabel={text("list.retry")} />}
    {busy && <LoadingState label={text("p5.usage.loadingNative")} />}
    {result && <UsageResult result={result} text={text} />}
  </section>
}

function usageQueryKey(query: ProjectUsageQuery): string {
  return JSON.stringify([query.projectId, query.sessionId ?? null,
    typeof query.model === 'object' ? [query.model.provider, query.model.model] : query.model ?? null,
    query.from ?? null, query.to ?? null])
}

function UsageScope({ result , text}: { readonly result: ProjectUsageResult ; readonly text: ProjectsTranslate }): ReactNode {
  const hasReported = Object.values(result.tokens).some(metric => metric.reported !== null)
  const session = result.query.sessionId === undefined ? text('p5.usage.projectSources')
    : result.options.sessions.find(item => item.id === result.query.sessionId)?.title ?? result.query.sessionId
  const model = result.query.model === undefined ? text('p5.usage.allModels') : result.query.model === 'unattributed'
    ? text('p5.usage.modelBreakdownUnavailable') : `${result.query.model.provider} / ${result.query.model.model}`
  return <section className="dsh-usage-scope" aria-label={text("p5.usage.scopeAndReporting")} role="status">
      <div className="dsh-usage-scope-heading"><strong>{!hasReported ? text("p5.usage.unknown") : result.coverage.status === 'partial' ? text("p5.usage.partiallyAvailable") : text("p5.usage.reported")}</strong><span>{text("p3.overview.blockUpdated")}{' '}{time(result.refreshedAt, text)}</span></div>
      {result.coverage.status !== 'reported' && <p className="dsh-usage-note">{text('p5.usage.incompleteReports')}</p>}
      <p className="dsh-usage-range">{text('p5.usage.scopePrefix')}{session}{text('p5.common.semicolon')}{model}{text('p5.common.semicolon')}{time(result.query.from, text)}{' '}{text('p5.usage.rangeTo')}{' '}{time(result.query.to, text)}{text('p5.usage.endExclusiveSuffix')}</p>
  </section>
}

function UsageSummary({ result, text }: { readonly result: ProjectUsageResult; readonly text: ProjectsTranslate }): ReactNode {
  const hasReported = Object.values(result.tokens).some(metric => metric.reported !== null)
  const primary = ['totalTokens', 'cacheReadTokens', 'outputTokens'] as const
  return <section className="dsh-usage-summary" aria-label={text('p3.usage.summary')}>
    <dl className="dsh-usage-primary-metrics">{primary.map(key => <div key={key}>
      <dt>{text(`p3.usage.metric.${key}`)}</dt>
      <dd>{result.tokens[key].reported === null ? <span aria-label={text('p3.usage.uncollected')}>—</span> : formatNumber(result.tokens[key].reported)}</dd>
      {metricPartial(result.tokens[key]) && result.tokens[key].reported !== null && <small>{text('p3.usage.partial')}</small>}
    </div>)}</dl>
    {!hasReported && <p className="dsh-usage-note dsh-usage-empty">{text('p3.usage.empty')}</p>}
    <UsageBreakdown result={result} text={text} />
    <p className="dsh-usage-cost">{text('p5.usage.costNotProvided')}</p>
  </section>
}

/** Session rows are disjoint physical sources, including attributed child carriers.
 * The aggregate and source/model/date tables are alternative views, never additional summands. */
function UsageBreakdown({ result, text }: { readonly result: ProjectUsageResult; readonly text: ProjectsTranslate }): ReactNode {
  const roles = ['main', 'execution', 'memory', 'session-manager'] as const
  const groups = roles.map(role => {
    const metrics = result.sessions.filter(row => row.role === role).map(row => row.tokens.totalTokens)
    const reported = metrics.flatMap(metric => metric.reported === null ? [] : [metric.reported])
    return { role, value: reported.length === 0 ? null : reported.reduce((sum, value) => sum + value, 0) }
  })
  const total = result.tokens.totalTokens.reported
  const groupedTotal = groups.reduce((sum, group) => sum + (group.value ?? 0), 0)
  const available = total !== null && total > 0 && Number.isSafeInteger(groupedTotal) && groupedTotal === total
  const partial = result.coverage.status !== 'reported' || metricPartial(result.tokens.totalTokens)
  return <section className="dsh-usage-breakdown" aria-label={text('p3.usage.breakdown')}>
    <p className="dsh-usage-note">{text(partial ? 'p3.usage.share.partial' : 'p3.usage.share.reported')}</p>
    {available && <svg className="dsh-usage-stack" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label={text('p3.usage.breakdown')}>{groups.map((group, index) => group.value !== null && group.value > 0 && <rect key={group.role} data-role={group.role} x={groups.slice(0, index).reduce((sum, previous) => sum + (previous.value ?? 0), 0) / total * 100} y={0} width={group.value / total * 100} height={8} />)}</svg>}
    {!available && <p className="dsh-usage-note">{text(total === 0 ? 'p3.usage.share.zero' : total === null ? 'p3.usage.share.unavailable' : 'p3.usage.share.unattributed')}</p>}
    <ul className="dsh-usage-legend">{groups.map(group => <li key={group.role} data-role={group.role}>
      <span className="dsh-usage-legend-label"><span className="dsh-usage-swatch" aria-hidden="true" />{text(`p3.usage.role.${group.role}`)}</span>
      <span>{group.value === null ? '—' : formatNumber(group.value)}{available && group.value !== null ? ` · ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(group.value / total * 100)}%` : ''}</span>
    </li>)}</ul>
  </section>
}

function metricPartial(metric: UsageMetric): boolean { return metric.unknownTurns > 0 || metric.unknownAuxiliaryRequests > 0 || metric.unknownSources > 0 }

function UsageResult({ result, text }: { readonly result: ProjectUsageResult; readonly text: ProjectsTranslate }): ReactNode {
  return <>
    <details className="dsh-usage-details dsh-usage-totals">
      <summary>{text('p3.usage.allMetrics')}</summary>
      <Metrics text={text} tokens={result.tokens} />
    </details>
    <GroupTable title={text("p5.usage.bySessionSource")} columnTitle={text("p5.usage.column.sessionSource")} rows={result.sessions} text={text} />
    <GroupTable title={text("p5.usage.byRequestSource")} columnTitle={text("p5.usage.column.requestSource")} rows={result.sources} text={text} />
    <GroupTable title={text("p5.usage.byModel")} columnTitle={text("p5.usage.model")} rows={result.models} text={text} />
    <GroupTable title={text("p5.usage.byUtcDate")} columnTitle={text("p5.usage.column.utcDate")} rows={result.periods} text={text} utcDates />
  </>
}

/** 会话标题可消费同一次查询的会话行，避免另造用量累计。 */
export function UsageSessionSummary({ session, sessions, scope = 'current-query', loading = false, failed = false, translate }: {
  readonly session?: UsageSession | undefined;
  readonly sessions?: readonly UsageSession[] | undefined;
  readonly scope?: 'current-query' | 'session-history';
  readonly loading?: boolean;
  readonly failed?: boolean;
  readonly translate?: ProjectsTranslate;
}): ReactNode {
  const text = projectCopy(translate)
  const rows = sessions ?? (session === undefined ? [] : [session])
  if (rows.length === 0) return <span role="status" aria-busy={loading || undefined}>{text(loading
    ? "p5.usage.loadingNative" : failed ? "p5.usage.readUnavailable" : "p5.usage.usageAndCostUnknown")}</span>
  const metrics = rows.map(row => row.tokens.totalTokens)
  const values = metrics.flatMap(metric => metric.reported === null ? [] : [metric.reported])
  const total = values.reduce((sum, value) => sum + value, 0)
  if (!Number.isSafeInteger(total)) throw new Error(text("p5.usage.totalOutOfRange"))
  const metric: UsageMetric = {
    reported: values.length === 0 ? null : total,
    unknownTurns: metrics.reduce((sum, item) => sum + item.unknownTurns, 0),
    unknownAuxiliaryRequests: metrics.reduce((sum, item) => sum + item.unknownAuxiliaryRequests, 0),
    unknownSources: metrics.reduce((sum, item) => sum + item.unknownSources, 0),
  }
  return <Tooltip portal label={text("p5.usage.summaryTooltip", { value: scope === 'session-history' ? text("p5.usage.entireSessionHistory") : text("p5.usage.currentFilterScope"), value1: time(Math.max(...rows.map(row => row.observedAt)), text) })}><span aria-busy={loading || undefined}>{text("p5.usage.reportedTokensPrefix")}{formatUsageMetric(metric, text)}{' '}{text("p5.usage.costUnknownSuffix")}{loading
    ? ` · ${text("p5.usage.summaryRefreshing")}` : failed ? text("p5.common.temporarilyUnreadableSuffix") : ''}</span></Tooltip>
}

const labels: Readonly<Record<UsageMetricKey, Parameters<ProjectsTranslate>[0]>> = {
  totalTokens: "p5.usage.totalTokens", uncachedInputTokens: "p5.usage.uncachedInput", outputTokens: "p3.usage.metric.outputTokens",
  cacheReadTokens: "p3.usage.metric.cacheReadTokens", cacheWriteTokens: "p5.usage.cacheWrite", reasoningTokens: "p5.usage.reasoningIncludedInOutput",
}
function Metrics({ tokens , text}: { readonly tokens: UsageMetrics ; readonly text: ProjectsTranslate }): ReactNode {
  return <dl className="dsh-usage-metrics">{Object.entries(labels).map(([key, label]) =>
    <div key={key}><dt>{text(label)}</dt><dd>{formatUsageMetric(tokens[key as UsageMetricKey], text)}</dd></div>)}</dl>
}
function GroupTable({ title, columnTitle, rows, text, utcDates = false }: { readonly title: string; readonly columnTitle: string; readonly rows: readonly UsageGroup[]; readonly text: ProjectsTranslate; readonly utcDates?: boolean }): ReactNode {
  return <details className="dsh-usage-details dsh-usage-group" aria-label={title}>
    <summary>{title}</summary>
    {rows.length === 0 ? <EmptyState title={text('p3.usage.empty')} /> : <div className="dsh-usage-table" role="region" aria-label={text("p5.usage.groupDetails", { value: title })} tabIndex={0}><table>
      <thead><tr><th scope="col">{columnTitle}</th>{Object.values(labels).map(label => <th key={label} scope="col">{text(label)}</th>)}</tr></thead>
      <tbody>{rows.map(row => <tr key={row.key}><th scope="row"><span className="dsh-usage-row-label">{utcDates && /^\d{4}-\d{2}-\d{2}$/.test(row.label) ? formatUiDate(row.label, text, { dateOnly: true, timeZone: 'UTC' }) : row.label}{'source' in row && row.source === 'unavailable' && <small className="dsh-usage-row-status">{text('p5.usage.unreadable')}</small>}</span></th>
        {Object.keys(labels).map(key => <td key={key}>{formatUsageMetric(row.tokens[key as UsageMetricKey], text)}</td>)}</tr>)}</tbody>
    </table></div>}
  </details>
}
export function formatUsageMetric(metric: UsageMetric, text: ProjectsTranslate = projectCopy()): string {
  return metric.reported === null ? text("p5.common.unknown") :  `${formatNumber(metric.reported)}${metric.unknownTurns > 0 || metric.unknownAuxiliaryRequests > 0 || metric.unknownSources > 0 ? text("p5.usage.partialSuffix") : ''}`
}
function formatNumber(value: number): string { return value.toLocaleString('zh-CN') }
function time(value: number | undefined, text: ProjectsTranslate = projectCopy()): string {
  return value === undefined ? text("p5.usage.unbounded") : formatUiDate(value, text, { seconds: true })
}
