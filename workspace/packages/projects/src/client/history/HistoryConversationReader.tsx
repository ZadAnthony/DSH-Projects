/** Bounded chat context, independent of the host's full-conversation Reader. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ProjectDetail, ProjectHistoryReadResult } from '../../public-types.ts'
import type { NativeEventSource, NativeProjectSource, NativeProjectSourceItem } from '../../source-types.ts'
import { historyRecordReadingProjection } from '../../history-display-summary.ts'
import { ProjectReplyLinkTextBoundary } from '../ProjectReplySessionLinks.tsx'
import {
  Button, EmptyState, ErrorState, IconChevronLeftOutlineRegular,
  LoadingState, MarkdownDelegateProvider, MarkdownText, type ProjectsTranslate,
} from '../ui/index.ts'
import { formatUiDate } from '../ui/date-format.ts'

export function HistoryTextMatch({ text, keyword = '' }: { readonly text: string; readonly keyword?: string }): ReactNode {
  const needle = keyword.trim().toLocaleLowerCase()
  if (needle === '') return text
  const lower = text.toLocaleLowerCase(), parts: ReactNode[] = []
  let at = 0, found = lower.indexOf(needle)
  while (found >= 0) {
    parts.push(text.slice(at, found), <mark key={found}>{text.slice(found, found + needle.length)}</mark>)
    at = found + needle.length
    found = lower.indexOf(needle, at)
  }
  parts.push(text.slice(at))
  return <>{parts}</>
}

function owner(detail: ProjectDetail, source: NativeProjectSource) {
  return source.kind === 'native-event'
    ? detail.sessions.find(session => session.id === source.sessionId && session.projectId === detail.project.id)
    : detail.sessions.find(session => session.hostSessionId === source.hostSessionId
      || session.carriers?.some(carrier => carrier.hostSessionId === source.hostSessionId))
}

function canonicalAssistant(item: NativeProjectSourceItem): boolean {
  const chat = item.chat
  return chat?.kind === 'message' && item.role === 'assistant'
    && item.nativeSource?.kind === 'native-event' && item.nativeSource.eventType === 'assistant/message'
    && item.recordPhase === 'message-settled' && item.visibleComplete === true
    && chat.excerpt.start === 0 && chat.excerpt.end === chat.excerpt.total
}

function CommunicationText({ item, t, keyword }: { readonly item: NativeProjectSourceItem; readonly t: ProjectsTranslate; readonly keyword?: string }): ReactNode {
  const chat = item.chat!, parts = chat.communication?.parts
  if (parts === undefined || parts.length === 0) return <>
    <p className="dsh-projects__history-meta">{t('project.history.communicationIdentityUnknown')}</p>
    <HistoryTextMatch text={chat.text} keyword={item.isTarget ? keyword : undefined} />
  </>
  const points = Array.from(chat.text)
  return parts.map((part, index) => {
    const start = Math.max(part.range.start, chat.excerpt.start), end = Math.min(part.range.end, chat.excerpt.end)
    if (start >= end) return null
    const speaker = part.speaker === 'unknown' ? t('communication.speaker.unknown') : t(`project.history.speaker.${part.speaker}`)
    return <section key={`${part.group}:${part.range.start}:${index}`}>
      <p className="dsh-projects__history-meta">{t(part.group === 'agent' ? 'project.history.communicationNote' : 'project.history.communicationForwarded', { speaker })}</p>
      <HistoryTextMatch text={points.slice(start - chat.excerpt.start, end - chat.excerpt.start).join('')} keyword={item.isTarget ? keyword : undefined} />
    </section>
  })
}

function ChatText({ item, detail, t, keyword }: {
  readonly item: NativeProjectSourceItem; readonly detail: ProjectDetail; readonly t: ProjectsTranslate; readonly keyword?: string
}): ReactNode {
  const chat = item.chat!, canonical = canonicalAssistant(item)
  const session = item.nativeSource === undefined ? undefined : owner(detail, item.nativeSource)
  const legalRole = session?.role === 'main' || session?.role === 'execution' ? session.role : undefined
  const active = canonical && legalRole !== undefined && item.nativeSource?.kind === 'native-event'
    && item.nativeSource.projectId === detail.project.id
  const projection = useMemo(() => active ? { text: chat.text, textOnly: false }
    : historyRecordReadingProjection(chat.text, {
      sessionLink: t('project.history.sessionLink'), incompleteReference: t('project.history.incompleteReference'), image: t('project.history.imageAlternative'),
    }, chat.kind === 'incomplete-reply' || item.partial === true || chat.excerpt.end < chat.excerpt.total), [chat.text, chat.kind, chat.excerpt.end, chat.excerpt.total, item.partial, active, t])
  const labels = useMemo(() => ({ code: { copyLabel: t('p3.library.markdownCopy'), copiedLabel: t('p3.library.markdownCopied') }, footnotes: t('p3.library.markdownFootnotes') }), [t])
  if (chat.kind === 'communication') return <div className="dsh-projects__history-chat-text"><CommunicationText item={item} t={t} keyword={keyword} /></div>
  // User text retains its literal content, including legal JSON.
  if (item.role === 'user' || chat.excerpt.start !== 0)
    return <div className="dsh-projects__history-chat-text"><HistoryTextMatch text={chat.text} keyword={item.isTarget ? keyword : undefined} /></div>
  const body = projection.textOnly ? projection.text : <MarkdownDelegateProvider><MarkdownText text={projection.text} labels={labels} /></MarkdownDelegateProvider>
  return <div className="dsh-projects__history-chat-text" data-project-history-reading="">
    <ProjectReplyLinkTextBoundary text={chat.text} enabledSettled={active}
      source={active && legalRole !== undefined ? { originProjectId: detail.project.id, role: legalRole } : undefined}>
      {body}
    </ProjectReplyLinkTextBoundary>
  </div>
}

function Speaker({ item, detail, t }: { readonly item: NativeProjectSourceItem; readonly detail: ProjectDetail; readonly t: ProjectsTranslate }): ReactNode {
  const communication = item.chat?.communication
  const title = (endpoint: { readonly sessionId: string; readonly title?: string }): string => endpoint.title?.trim()
    || detail.sessions.find(session => session.id === endpoint.sessionId && session.projectId === detail.project.id)?.title
    || t('p3.history.originalConversation')
  if (communication !== undefined) return <>
    <span>{t('project.history.speaker.project-delivery')}</span>
    <span>{t('project.history.communicationRoute', {
      from: title(communication.sender), to: title(communication.recipient),
    })}</span>
  </>
  if (item.chat?.kind === 'communication') return <span>{t('project.history.speaker.project-delivery')}</span>
  return <span>{t(item.speaker === 'user' || item.role === 'user' ? 'project.history.speaker.user' : 'project.history.speaker.assistant')}</span>
}

type ReadChatPage = (source: NativeProjectSource, start: number, signal: AbortSignal) => Promise<ProjectHistoryReadResult>

function sameSource(expected: NativeProjectSource, actual: NativeProjectSource | undefined): boolean {
  if (actual === undefined || expected.kind !== actual.kind || expected.hostSessionId !== actual.hostSessionId) return false
  if (expected.kind === 'native-event' && actual.kind === 'native-event') return expected.projectId === actual.projectId
    && expected.sessionId === actual.sessionId && expected.sessionCreatedAt === actual.sessionCreatedAt
    && expected.eventSeq === actual.eventSeq && expected.eventType === actual.eventType && expected.eventDigest === actual.eventDigest
    && expected.version === actual.version && expected.eventSpace.kind === actual.eventSpace.kind && expected.eventSpace.formatVersion === actual.eventSpace.formatVersion
    && expected.messageId === actual.messageId && expected.toolCallId === actual.toolCallId
    && expected.body?.stream === actual.body?.stream && expected.body?.codec === actual.body?.codec && expected.body?.digest === actual.body?.digest
    && expected.body?.range?.start === actual.body?.range?.start && expected.body?.range?.end === actual.body?.range?.end
  if (expected.kind === 'message' && actual.kind === 'message') return expected.messageId === actual.messageId
  return expected.kind === 'tool' && actual.kind === 'tool' && expected.toolCallId === actual.toolCallId
}

type ViewAttachments = (source: NativeEventSource, opener: HTMLElement) => void

function ChatMessage({ item, detail, t, readPage, keyword, onViewAttachments }: {
  readonly item: NativeProjectSourceItem; readonly detail: ProjectDetail; readonly t: ProjectsTranslate; readonly readPage: ReadChatPage; readonly keyword?: string; readonly onViewAttachments?: ViewAttachments
}): ReactNode {
  const [continuation, setContinuation] = useState<{ text: string; end: number; total: number }>()
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState(false)
  const abort = useRef<AbortController>()
  useEffect(() => {
    setContinuation(undefined); setBusy(false); setFailure(false)
    return () => { abort.current?.abort() }
  }, [item])
  const original = item.chat!, chat = continuation === undefined ? original : { ...original, text: continuation.text,
    excerpt: { ...original.excerpt, end: continuation.end, total: continuation.total } }
  const incomplete = chat.excerpt.start > 0 || chat.excerpt.end < chat.excerpt.total
  const next = async (): Promise<void> => {
    if (busy || item.nativeSource === undefined || chat.excerpt.end >= chat.excerpt.total) return
    const controller = new AbortController(); abort.current?.abort(); abort.current = controller
    setBusy(true); setFailure(false)
    try {
      const response = await readPage(item.nativeSource, chat.excerpt.end, controller.signal)
      if (controller.signal.aborted) return
      const target = response.items.find(value => value.isTarget && value.chat !== undefined && sameSource(item.nativeSource!, value.nativeSource))
      const more = target?.chat
      if (!response.found || response.status === 'unavailable' || more === undefined || more.kind !== original.kind
        || more.excerpt.start !== chat.excerpt.end || more.excerpt.end <= more.excerpt.start || more.excerpt.total !== chat.excerpt.total
        || Array.from(more.text).length !== more.excerpt.end - more.excerpt.start) throw new Error('History continuation did not match the exact source and range')
      setContinuation({ text: chat.text + more.text, end: more.excerpt.end, total: more.excerpt.total })
    } catch (error) {
      if (controller.signal.aborted) return
      console.error('[dsh-projects] history continuation failed', error); setFailure(true)
    } finally { if (!controller.signal.aborted) setBusy(false) }
  }
  const visibleItem = continuation === undefined ? item : { ...item, chat }
  return <article className={`dsh-projects__history-message${item.role === 'user' && chat.kind !== 'communication' ? ' dsh-projects__history-message--user' : ''}${item.isTarget ? ' dsh-projects__history-message--target' : ''}`}
    data-history-target={item.isTarget || undefined}>
    <header className="dsh-projects__history-message-meta">
      <Speaker item={item} detail={detail} t={t} />
      <time dateTime={new Date(item.time).toISOString()}>{formatUiDate(item.time, t)}</time>
      {item.isTarget && <span className="dsh-projects__history-target-label">{t('project.history.selectedMessage')}</span>}
    </header>
    {chat.kind === 'incomplete-reply' && <p className="dsh-projects__history-record-notice" role="status">{t('project.history.savedReplyFragment')}</p>}
    {chat.communication !== undefined && <p className="dsh-projects__history-meta">{t(chat.communication.savedPhase === 'received' ? 'project.history.communicationReceived' : 'project.history.communicationSaved')}</p>}
    <ChatText item={visibleItem} detail={detail} t={t} keyword={keyword} />
    {onViewAttachments !== undefined && item.nativeSource?.kind === 'native-event'
      && (chat.hasAttachments === true || chat.visibleBlocks?.some(block => block.type === 'file' || block.type === 'image')
        || item.attachments?.some(attachment => attachment.kind === 'file' || attachment.kind === 'image')) && <Button variant="ghost" size="sm" onClick={event => {
        if (item.nativeSource?.kind === 'native-event') onViewAttachments(item.nativeSource, event.currentTarget)
      }}>{t('project.history.viewAttachments')}</Button>}
    {incomplete && <p className="dsh-projects__history-meta" role="status">{t('p3.history.bodyRange', {
      start: String(chat.excerpt.start + 1), end: String(chat.excerpt.end), total: String(chat.excerpt.total),
    })}</p>}
    {chat.excerpt.end < chat.excerpt.total && item.nativeSource !== undefined && <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void next() }}>{t(busy ? 'project.history.readingMore' : 'project.history.readMoreText')}</Button>}
    {failure && <ErrorState inline title={t('project.history.moreUnavailable')} retry={() => { void next() }} retryLabel={t('list.retry')} />}
  </article>
}

export function HistoryConversationReader({ source, result, loading, failed, detail, t, onBack, onRetry, onEnter, readPage, keyword, onViewAttachments }: {
  readonly source: NativeProjectSource
  readonly result?: ProjectHistoryReadResult
  readonly loading?: boolean
  readonly failed?: boolean
  readonly keyword?: string
  readonly detail: ProjectDetail
  readonly t: ProjectsTranslate
  readonly onBack: () => void
  readonly onRetry: () => void
  readonly onEnter: (sessionId: string) => Promise<void>
  readonly readPage: ReadChatPage
  readonly onViewAttachments?: ViewAttachments
}): ReactNode {
  const [entering, setEntering] = useState(false), [enterFailed, setEnterFailed] = useState(false)
  const generation = useRef(0)
  useEffect(() => { generation.current++; setEntering(false); setEnterFailed(false); return () => { generation.current++ } }, [source, result])
  const session = owner(detail, source)
  const invalid = detail.unavailableSources.find(item => item.hostSessionId === source.hostSessionId)
  const readable = !loading && !failed && invalid === undefined && result?.status !== 'unavailable' && result?.found === true
    && result.items.some(item => item.isTarget && item.chat !== undefined)
  const target = readable ? result?.items.find(item => item.isTarget && item.chat !== undefined) : undefined
  const messages = readable ? result!.items.filter(item => item.chat !== undefined) : []
  const tools = readable ? result!.items.filter(item => item.chat === undefined && item.role === 'tool') : []
  // UI result limitations describe real missing coverage; raw per-event exclusions keep their original meaning.
  const restrictions = readable ? [...new Set(result!.limitations)] : []
  const enter = async (): Promise<void> => {
    if (session === undefined || entering) return
    const request = ++generation.current
    setEntering(true); setEnterFailed(false)
    try { await onEnter(session.id) }
    catch (error) {
      if (request !== generation.current || error !== null && typeof error === 'object' && 'name' in error && error.name === 'AbortError') return
      console.error('[dsh-projects] history session navigation failed', error); setEnterFailed(true)
    } finally { if (request === generation.current) setEntering(false) }
  }
  return <section className="dsh-projects__history-context" aria-label={t('project.history.contextTitle')}>
    <nav className="dsh-projects__history-context-actions" aria-label={t('project.history.contextActions')}>
      <Button variant="ghost" size="sm" icon={<IconChevronLeftOutlineRegular size={14} />} onClick={onBack}>{t('project.history.backToSearch')}</Button>
      {readable && session !== undefined && (session.role === 'main' || session.role === 'execution') && <Button variant="outline" size="sm" disabled={entering} onClick={() => { void enter() }}>{t('project.history.enterSession')}</Button>}
    </nav>
    {loading ? <LoadingState label={t('project.history.readingContext')} />
      : failed || invalid !== undefined || result?.status === 'unavailable' ? <ErrorState title={invalid === undefined ? t('project.history.contextUnavailable') : t(`project.sources.${invalid.kind}`)} retry={onRetry} retryLabel={t('list.retry')} />
      : !readable ? <EmptyState title={t('project.history.contextMissing')} /> : <>
        <header className="dsh-projects__history-context-heading">
          <h3>{session?.title ?? t('p3.history.originalConversation')}</h3>
          <p className="dsh-projects__history-meta">{formatUiDate(target!.time, t)} · {t('project.history.readonlyContext')}</p>
        </header>
        {result!.status === 'partial' && <p className="dsh-projects__history-meta" role="status">{t('project.history.partial')}</p>}
        {enterFailed && <ErrorState inline title={t('project.history.enterFailed')} retry={() => { void enter() }} retryLabel={t('list.retry')} />}
        <div className="dsh-projects__history-thread">{messages.map(item => <ChatMessage key={`${item.seq}:${item.kind}:${item.messageId ?? ''}`} item={item} detail={detail} t={t} readPage={readPage} keyword={keyword} onViewAttachments={onViewAttachments} />)}</div>
        {tools.length > 0 && <details className="dsh-projects__history-process">
          <summary>{t('project.history.toolDetails', { count: String(tools.length) })}</summary>
          {tools.map(item => <article key={`${item.seq}:${item.kind}`}>
            <time>{formatUiDate(item.time, t)}</time>
            <pre>{item.text}</pre>
          </article>)}
        </details>}
        {(result!.status === 'partial' || restrictions.length > 0) && <details className="dsh-projects__history-record-details">
          <summary>{t('project.history.readingRange')}</summary>
          {restrictions.map((limitation, index) => <p key={index} className="dsh-projects__history-meta">{limitation}</p>)}
        </details>}
      </>}
  </section>
}
