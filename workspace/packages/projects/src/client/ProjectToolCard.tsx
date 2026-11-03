import { useState, type ReactNode } from 'react'
import { Button, DisclosureRow, ErrorState, IconCodeOutlineRegular, JsonBlock, MarkdownText, StateDot, Tag, ToolCard } from './ui/index.ts'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectNavigationTarget } from '../public-types.ts'

/** Plain action supplied by the Projects controller and layout owner. */
export interface ProjectToolCardInjected {
  readonly openTarget: (projectId: string, target: ProjectNavigationTarget) => Promise<void>
}

type ProjectToolCardProps =
  & PropsRuntime<'tool.call.toolview'>
  & PropsLocale<'projects'>
  & InjectFace<ProjectToolCardInjected>

interface ProjectToolResult {
  readonly projectId: string
  readonly targets: readonly ProjectNavigationTarget[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseTarget(value: unknown): ProjectNavigationTarget | undefined {
  if (!isRecord(value) || typeof value.kind !== 'string') return undefined
  if ((value.kind === 'main' || value.kind === 'execution') && typeof value.sessionId === 'string') {
    return { kind: value.kind, sessionId: value.sessionId }
  }
  return undefined
}

/** Parse only the frozen, single-text JSON result emitted by Projects collaboration tools. */
function projectToolResult(content: ToolResultNode['content']): ProjectToolResult | undefined {
  if (content.length !== 1 || content[0]?.type !== 'text') return undefined
  let decoded: unknown
  try {
    decoded = JSON.parse(content[0].text)
  } catch {
    return undefined
  }
  if (!isRecord(decoded) || typeof decoded.projectId !== 'string' || !Array.isArray(decoded.targets)) return undefined
  const targets: ProjectNavigationTarget[] = []
  const seen = new Set<string>()
  for (const value of decoded.targets) {
    const target = parseTarget(value)
    if (target === undefined) return undefined
    const key = `${target.kind}:${target.sessionId}`
    if (!seen.has(key)) {
      seen.add(key)
      targets.push(target)
    }
  }
  return { projectId: decoded.projectId, targets }
}

type ResultState = 'read' | 'saved' | 'withdrawn' | 'partial' | 'incomplete' | 'failed' | 'conflict' | 'unavailable' | 'unknown' | 'stopped' | 'noCurrentRun'
type ResultRow = { target: 'project' | 'session' | 'projectFiles' | 'references'; id?: string; state: ResultState; message?: string }
interface ResultSummary {
  state: ResultState
  rows?: ResultRow[]
  id?: string
  message?: string
  request?: 'sent' | 'not-sent' | 'unknown'
  facts?: { key: 'bodySaved' | 'withdrawalSaved' | 'bodyRemoved' | 'indexSaved'; confirmed: boolean }[]
}

/** Only the specified tools' result DTO fields are authoritative; never inspect user bodies. */
function knownResult(toolName: string, content: ToolResultNode['content']): ResultSummary | undefined {
  if (content.length !== 1 || content[0]?.type !== 'text') return undefined
  let value: unknown
  try { value = JSON.parse(content[0].text) } catch { return undefined }
  if (!isRecord(value)) return undefined
  const unconfirmed = (item: Record<string, unknown>): boolean => item.kind === 'unknown'
    && item.code === 'projects/metadata-write-unconfirmed'
    && typeof item.stage === 'string' && ['write', 'file-sync', 'rename', 'directory-sync', 'remove', 'source-publication'].includes(item.stage)
    && typeof item.effect === 'string' && ['published-durability-unknown', 'durable'].includes(item.effect) && typeof item.message === 'string'
  const batch = (rows: ResultRow[], success: 'read' | 'saved'): ResultSummary => {
    const confirmed = rows.filter(row => row.state === success).length
    const states = new Set(rows.map(row => row.state))
    return { rows, state: confirmed === rows.length ? success : confirmed > 0 ? 'partial'
      : states.size === 1 ? rows[0]!.state : 'incomplete' }
  }
  if (toolName === 'project_instructions_read' || toolName === 'project_instructions_save') {
    if (typeof value.projectId !== 'string' || !Array.isArray(value.results) || value.results.length === 0) return undefined
    const success = toolName === 'project_instructions_read' ? 'read' : 'saved'
    const rows: ResultRow[] = []
    for (const item of value.results) {
      if (!isRecord(item) || !isRecord(item.target)) return undefined
      const target = item.target
      if (target.kind !== 'project' && !(target.kind === 'session' && typeof target.session_id === 'string')) return undefined
      const instructions = (body: unknown): boolean => isRecord(body) && typeof body.instructions === 'string' && Number.isInteger(body.revision)
      const state = item.kind === success && instructions(item.value) ? success
        : item.kind === 'conflict' && success === 'saved' && instructions(item.current) ? 'conflict'
          : (item.kind === 'unavailable' || item.kind === 'failed') && typeof item.message === 'string' ? item.kind
            : unconfirmed(item) ? 'unknown' : undefined
      if (state === undefined) return undefined
      rows.push({ target: target.kind, ...(target.kind === 'session' ? { id: target.session_id as string } : {}), state,
        ...(typeof item.message === 'string' ? { message: item.message } : {}) })
    }
    return batch(rows, success)
  }
  if (toolName === 'project_stop_execution') {
    if (typeof value.requestedSessionId !== 'string' || typeof value.message !== 'string'
      || typeof value.request !== 'string' || !['sent', 'not-sent', 'unknown'].includes(value.request)) return undefined
    const state = value.kind === 'stopped' || value.kind === 'failed' ? value.kind
      : value.kind === 'unconfirmed' ? 'unknown' : value.kind === 'no-current-run' ? 'noCurrentRun' : undefined
    return state === undefined ? undefined : { state, id: value.requestedSessionId, message: value.message,
      request: value.request as ResultSummary['request'] }
  }
  if (toolName === 'project_memory_save' || toolName === 'project_memory_withdraw') {
    if (unconfirmed(value)) {
      const confirmed = isRecord(value.confirmed) ? value.confirmed : {}
      const keys = toolName === 'project_memory_save' ? ['bodySaved', 'indexSaved'] as const
        : ['withdrawalSaved', 'bodyRemoved', 'indexSaved'] as const
      return { state: 'unknown', message: value.message as string, ...(typeof value.id === 'string' ? { id: value.id } : {}),
        facts: keys.filter(key => typeof confirmed[key] === 'boolean').map(key => ({ key, confirmed: confirmed[key] as boolean })) }
    }
    if (value.kind === 'saved' && toolName === 'project_memory_save' && isRecord(value.memory)
      && value.bodySaved === true && value.indexSaved === true) return { state: 'saved' }
    if (value.kind === 'withdrawn' && toolName === 'project_memory_withdraw' && typeof value.id === 'string'
      && value.bodyRemoved === true && value.indexSaved === true) return { state: 'withdrawn', id: value.id }
    if ((value.kind === 'conflict' || value.kind === 'failed') && typeof value.message === 'string') {
      return { state: value.kind, message: value.message }
    }
    if (value.kind === 'partial' && typeof value.id === 'string' && typeof value.message === 'string'
      && value.operation === (toolName === 'project_memory_save' ? 'save' : 'withdraw')
      && typeof value.bodySaved === 'boolean' && typeof value.bodyRemoved === 'boolean' && typeof value.indexSaved === 'boolean') {
      return { state: 'partial', id: value.id, message: value.message,
        facts: (value.operation === 'save' ? ['bodySaved', 'indexSaved'] as const : ['bodyRemoved', 'indexSaved'] as const)
          .map(key => ({ key, confirmed: value[key] as boolean })) }
    }
    return undefined
  }
  if (['project_library_add', 'project_library_remove', 'project_overview_put_block', 'project_overview_remove_block', 'project_overview_reorder'].includes(toolName)) {
    return unconfirmed(value) ? { state: 'unknown', message: value.message as string } : undefined
  }
  if (toolName === 'project_library_list' && isRecord(value.projectFiles) && isRecord(value.references)) {
    const rows: ResultRow[] = []
    for (const target of ['projectFiles', 'references'] as const) {
      const part = value[target] as Record<string, unknown>
      const state = part.status === (target === 'projectFiles' ? 'directory' : 'ready') && Array.isArray(part.entries) ? 'read'
        : part.status === 'unavailable' && typeof part.message === 'string' ? 'unavailable' : undefined
      if (state === undefined) return undefined
      rows.push({ target, state, ...(typeof part.message === 'string' ? { message: part.message } : {}) })
    }
    return batch(rows, 'read')
  }
  if (toolName === 'project_library_open' && value.status === 'unavailable' && isRecord(value.location)
    && isRecord(value.target) && typeof value.message === 'string' && typeof value.reason === 'string') {
    return { state: 'unavailable', message: value.message }
  }
  if (toolName === 'project_memory_read' && value.unavailable === true) return { state: 'unavailable' }
  return undefined
}

function resultTone(state?: ResultState) {
  return state === 'saved' || state === 'withdrawn' ? 'success' : state === 'failed' ? 'danger'
    : state === 'partial' || state === 'incomplete' || state === 'conflict' || state === 'unavailable' || state === 'unknown' ? 'warning' : 'neutral'
}

function ResultFacts({ summary, t }: { summary: ResultSummary; t: ProjectToolCardProps['t'] }): ReactNode {
  const counts = new Map<ResultState, number>()
  for (const row of summary.rows ?? []) counts.set(row.state, (counts.get(row.state) ?? 0) + 1)
  return <div role="status">
    {summary.id !== undefined && <p><code>{summary.id}</code></p>}
    {summary.request !== undefined && <p>{t('tool.card.fact.stopRequest')}：{t(summary.request === 'sent' ? 'tool.card.request.sent'
      : summary.request === 'not-sent' ? 'tool.card.request.notSent' : 'tool.card.result.unknown')}</p>}
    {summary.message !== undefined && <p>{summary.message}</p>}
    {counts.size > 0 && <p>{[...counts].map(([state, count]) => <Tag key={state} tone={resultTone(state)}>
      {t('tool.card.resultCount', { state: t(`tool.card.result.${state}`), count: String(count) })}
    </Tag>)}</p>}
    {summary.rows !== undefined && <ul>{summary.rows.map((row, index) => <li key={index}>
      <span>{row.target === 'session' ? t('tool.card.target.session', { id: row.id! }) : t(`tool.card.target.${row.target}`)}</span>{' '}
      <Tag tone={resultTone(row.state)}>{t(`tool.card.result.${row.state}`)}</Tag>
      {row.message !== undefined && <p>{row.message}</p>}
    </li>)}</ul>}
    {summary.facts !== undefined && <ul>{summary.facts.map(fact => <li key={fact.key}>
      {t(`tool.card.fact.${fact.key}`)}：{t(fact.confirmed ? 'tool.card.fact.confirmed' : 'tool.card.result.unknown')}
    </li>)}</ul>}
  </div>
}

function contentText(content: ToolResultNode['content']): string {
  return content.map(item => item.type === 'text' ? item.text : JSON.stringify(item) ?? '').join('\n\n')
}

/** JsonBlock has a 20k cap; full raw source remains available for every payload. */
function ToolContent({ label, text, className, t }: {
  readonly label: string; readonly text: string; readonly className?: string; readonly t: ProjectToolCardProps['t'];
}): ReactNode {
  const [rawOpen, setRawOpen] = useState(false)
  let payload: unknown
  let json = false
  try {
    payload = JSON.parse(text)
    json = JSON.stringify(payload, null, 2).length <= 20_000
  } catch { /* Plain text and incomplete input retain their exact original representation. */ }
  return <section className="projects-ui__tool-card-section">
    {json ? <JsonBlock label={label} payload={payload} defaultOpen truncatedLabel={() => ''} />
      : <><h4 className="projects-ui__tool-card-section-label">{label}</h4><div className="projects-ui__tool-card-payload">
        <MarkdownText text={text} variant="compact" labels={{ code: { copyLabel: t('p3.cards.copy'), copiedLabel: t('p3.cards.copied') }, footnotes: t('p3.cards.footnotes') }} />
      </div></>}
    <DisclosureRow icon={<IconCodeOutlineRegular />} title={t('p3.cards.rawContent')} open={rawOpen} expandable
      expandOnRowClick onToggle={() => setRawOpen(value => !value)}>
      <pre className={["projects-ui__tool-card-raw", className].filter(Boolean).join(' ')}>{text}</pre>
    </DisclosureRow>
  </section>
}

function targetKey(target: ProjectNavigationTarget): string {
  return `${target.kind}:${target.sessionId}`
}

function targetLabel(target: ProjectNavigationTarget, t: ProjectToolCardProps['t']): string {
  switch (target.kind) {
    case 'main': return t('tool.card.openMain')
    case 'execution': return t('tool.card.openExecution')
  }
}

/**
 * Project tools are fixed plain-text JSON calls, so their keyed view owns every
 * lifecycle state rather than replacing the generic view with an empty result.
 */
export function ProjectsToolCard({ block, openTarget, phase, t, toolName }: ProjectToolCardProps): ReactNode {
  const [opening, setOpening] = useState<string>()
  const [failed, setFailed] = useState(false)
  const result = phase === 'result' && !block.isError ? projectToolResult(block.content) : undefined

  const open = async (target: ProjectNavigationTarget): Promise<void> => {
    if (result === undefined) return
    const key = targetKey(target)
    setOpening(key)
    setFailed(false)
    try {
      await openTarget(result.projectId, target)
    } catch {
      setFailed(true)
    } finally {
      setOpening(undefined)
    }
  }

  if (phase === 'preparing') {
    return <ToolCard title={t('tool.card.title', { name: toolName })} running
      className="dsh-project-feedback" data-dsh-projects-tool-card="" data-state="preparing"
      status={<span role="status"><StateDot state="ongoing" />{t('tool.card.preparing')}</span>} />
  }

  if (phase === 'start') {
    return <ToolCard title={t('tool.card.title', { name: toolName })} running
      className="dsh-project-feedback" data-dsh-projects-tool-card="" data-state="running"
      status={<span role="status"><StateDot state="ongoing" />{t('tool.card.running')}</span>}>
      <ToolContent label={t('tool.card.input')} text={block.argsRaw === '' ? t('tool.card.emptyInput') : block.argsRaw} className="dsh-projects-tool-card__body" t={t} />
    </ToolCard>
  }

  const output = contentText(block.content)
  const input = block.call?.argsRaw
  if (block.isError) {
    return <ToolCard title={t('tool.card.title', { name: toolName })}
      className="dsh-project-feedback" data-dsh-projects-tool-card="" data-state="error"
      status={<span role="alert"><Tag tone="danger">{t('tool.card.failed')}</Tag></span>}
      persistent={<>
        {block.error?.reason === undefined || block.error.reason === ''
          ? null
          : <p className="dsh-projects-tool-card__error">{block.error.reason}</p>}
        {block.error?.code === undefined || block.error.code === ''
          ? null
          : <p className="dsh-projects-tool-card__error">{t('tool.card.errorCode', { value: block.error.code })}</p>}
      </>}>
      {input !== undefined && <ToolContent label={t('tool.card.input')} text={input === '' ? t('tool.card.emptyInput') : input} t={t} />}
      <ToolContent label={t('tool.card.output')} text={output === '' ? t('tool.card.emptyError') : output} className="dsh-projects-tool-card__body dsh-projects-tool-card__body--error" t={t} />
    </ToolCard>
  }

  const summary = knownResult(toolName, block.content)
  const exceptional = resultTone(summary?.state) === 'warning' || resultTone(summary?.state) === 'danger'
  return <ToolCard title={t('tool.card.title', { name: toolName })}
    className="dsh-project-feedback" data-dsh-projects-tool-card="" data-state="result" data-result={summary?.state ?? 'returned'}
    status={<Tag tone={resultTone(summary?.state)}>{summary === undefined ? t('tool.card.returned') : t(`tool.card.result.${summary.state}`)}</Tag>}
    persistent={<>{exceptional && summary !== undefined && <ResultFacts summary={summary} t={t} />}
      {failed && <ErrorState title={t('tool.card.openError')} inline />}</>}
    actions={result === undefined || result.targets.length === 0 ? undefined : (
        <div className="dsh-projects-tool-card__actions">
          {result.targets.map(target => {
            const key = targetKey(target)
            return (
              <Button
                key={key}
                variant="outline"
                size="sm"
                disabled={opening !== undefined}
                onClick={() => { void open(target) }}
              >
                {opening === key ? t('tool.card.opening') : targetLabel(target, t)}
              </Button>
            )
          })}
        </div>
      )}>
    {summary !== undefined && !exceptional && <ResultFacts summary={summary} t={t} />}
    {input !== undefined && <ToolContent label={t('tool.card.input')} text={input === '' ? t('tool.card.emptyInput') : input} t={t} />}
    <ToolContent label={t('tool.card.output')} text={output === '' ? t('tool.card.emptyOutput') : output} className="dsh-projects-tool-card__body" t={t} />
  </ToolCard>
}
