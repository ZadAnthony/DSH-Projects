import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { RefreshButton } from './WorkflowControls.tsx'
import { Button, ErrorState, IconChevronLeftOutlineRegular, LoadingState, projectCopy, StateDot, Tag, type ProjectsTranslate } from './ui/index.ts'
import type { ProjectConversationFilePage, ProjectConversationFileRequest, ReadConversationFile } from './workflow-navigation.ts'

/** Read-only native text paging for an actual file gesture from an embedded Project Chat. */
export interface ConversationFileReaderProps {
  readonly translate?: ProjectsTranslate
  readonly request: ProjectConversationFileRequest
  readonly readConversationFile: ReadConversationFile
  readonly onBack: () => void
  readonly backLabel: string
  readonly onFeedback?: (() => void) | undefined
  readonly feedbackLabel?: string | undefined
  readonly initialScrollTop?: number | undefined
  readonly onReadingScroll?: ((top: number) => void) | undefined
  readonly initialOffset?: number | undefined
  readonly onReadingPage?: ((offset: number) => void) | undefined
  /** Keep the page and its actual scroll position together when leaving/reopening the reader. */
  readonly onReadingPosition?: ((position: { readonly offset: number; readonly scrollTop: number }) => void) | undefined
}

/** Present only the returned text window; failed or unfinished reads never retain the old body. */
export function ConversationFileReader({ request, readConversationFile, onBack, backLabel,
  onFeedback, feedbackLabel, initialScrollTop = 0, onReadingScroll, initialOffset, onReadingPage, onReadingPosition, translate }: ConversationFileReaderProps): ReactNode {
  const copy = projectCopy(translate)
  const [position, setPosition] = useState({ requestId: request.id, offset: initialOffset ?? request.line ?? 1, previous: [] as number[] })
  const [reload, setReload] = useState(0)
  const [settled, setSettled] = useState<{ readonly requestId: number; readonly offset: number; readonly page?: ProjectConversationFilePage; readonly changed?: boolean; readonly error?: string }>()
  const [loading, setLoading] = useState(true)
  const body = useRef<HTMLDivElement>(null)
  const backButton = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => { backButton.current?.focus({ preventScroll: true }) }, [request.id])
  const readingPositions = useRef({ requestId: request.id, positions: new Map([[initialOffset ?? request.line ?? 1, initialScrollTop]]) })
  if (readingPositions.current.requestId !== request.id) readingPositions.current = {
    requestId: request.id, positions: new Map([[initialOffset ?? request.line ?? 1, initialScrollTop]]),
  }
  const restoredPage = useRef<ProjectConversationFilePage>()
  const lastRead = useRef<{ readonly requestId: number; readonly version: string }>()
  const offset = position.requestId === request.id ? position.offset : initialOffset ?? request.line ?? 1
  const current = settled?.requestId === request.id && settled.offset === offset ? settled : undefined
  const page = !loading ? current?.page : undefined
  const title = request.path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? request.path

  useEffect(() => {
    setPosition({ requestId: request.id, offset: initialOffset ?? request.line ?? 1, previous: [] })
  }, [request.id, request.line])

  useEffect(() => {
    const abort = new AbortController()
    setLoading(true)
    setSettled(undefined)
    void readConversationFile(request, { offset }, abort.signal).then(value => {
      if (abort.signal.aborted) return
      const changed = lastRead.current?.requestId === request.id && lastRead.current.version !== value.version
      lastRead.current = { requestId: request.id, version: value.version }
      setSettled({ requestId: request.id, offset, page: value, changed })
      setLoading(false)
    }, error => {
      if (abort.signal.aborted) return
      setSettled({ requestId: request.id, offset, error: error instanceof Error ? error.message : String(error) })
      setLoading(false)
    })
    return () => { abort.abort() }
  }, [request, offset, reload, readConversationFile])

  useEffect(() => {
    if (page === undefined || body.current === null || restoredPage.current === page) return
    body.current.scrollTop = readingPositions.current.positions.get(page.offset) ?? 0
    const scrollTop = body.current.scrollTop
    readingPositions.current.positions.set(page.offset, scrollTop)
    restoredPage.current = page
    onReadingPosition?.({ offset: page.offset, scrollTop })
    onReadingPage?.(page.offset)
    onReadingScroll?.(scrollTop)
  }, [page, request.id, onReadingPage, onReadingScroll, onReadingPosition])

  const navigate = (next: number, previous: number[]): void => {
    // The pagination buttons leave the DOM during a read; keep keyboard focus in the stable scroll region.
    body.current?.focus({ preventScroll: true })
    setLoading(true)
    setPosition({ requestId: request.id, offset: next, previous })
  }
  const previous = position.requestId === request.id ? position.previous : []
  return <section className="projects-library-reader" aria-label={copy('p3.library.readNamed', { name: title })} aria-busy={loading}>
    <header className="projects-library-readingheader">
      <Button ref={backButton} className="projects-library-back" variant="ghost" size="sm" type="button" icon={<IconChevronLeftOutlineRegular size={16} />} onClick={onBack}>{backLabel}</Button>
      <h2>{title}</h2>
      <div className="projects-library-heading"><small>{copy('p3.library.openedFrom', { session: request.role === 'main' ? copy('p3.library.mainSession') : request.sessionTitle })}{page === undefined ? '' : ` · ${readTimestamp(page.readAt)} ${copy('p3.library.readAtSuffix')}`}</small>
        <RefreshButton translate={copy} label={copy('p3.library.reread')} ariaLabel={copy('p3.library.rereadPage')} loading={loading} onClick={() => { setLoading(true); setReload(value => value + 1) }} />
      </div>
      {page !== undefined && <p className="projects-library-note" role="status">{page.lines === 0 ? copy('p3.library.noTextLines') : copy('p3.library.lineRange', { from: page.offset, to: page.offset + page.lines - 1 })}{copy(page.offset > 1 || !page.eof ? 'p3.library.partialPage' : 'p3.library.endOfFile')}</p>}
    </header>
    <div ref={body} className="projects-library-readingbody" tabIndex={0} role="region" aria-label={copy('p3.library.rawText')} onScroll={event => {
      if (page === undefined) return
      const scrollTop = event.currentTarget.scrollTop
      readingPositions.current.positions.set(page.offset, scrollTop)
      onReadingPosition?.({ offset: page.offset, scrollTop })
      onReadingScroll?.(scrollTop)
    }}>
      {loading ? <LoadingState label={copy('p3.library.readingFile')} rows={3} />
        : current?.error !== undefined ? <ErrorState title={copy('p3.library.conversationReadFailed')} diagnostic={{ label: copy('p5.panel.errorDetails'), content: current.error }} inline><small>{copy('p3.library.conversationReadFailedHelp')}</small></ErrorState>
          : page !== undefined ? <><pre className="projects-library-body" aria-label={copy('p3.library.rawText')}>{page.text}</pre>
            {current?.changed === true && <p className="projects-library-note" role="status"><StateDot state="warning" />{copy('p3.library.changedBetweenReads')}</p>}
            <nav className="projects-library-actions projects-library-pagination" aria-label={copy('p3.library.filePages')}>
              {page.offset > 1 && <Button variant="ghost" size="sm" type="button" onClick={() => navigate(1, [])}>{copy('p3.library.readBeginning')}</Button>}
              {previous.length > 0 && <Button variant="outline" size="sm" type="button" onClick={() => navigate(previous.at(-1)!, previous.slice(0, -1))}>{copy('p3.library.previousPage')}</Button>}
              {!page.eof && page.lines > 0 && <Button variant="outline" size="sm" type="button" onClick={() => navigate(page.offset + page.lines, [...previous, page.offset])}>{copy('p3.library.nextPage')}</Button>}
            </nav></> : <p role="status"><Tag tone="quiet">{copy('p3.library.conversationNotRead')}</Tag></p>}
      <details className="projects-library-readingdetails"><summary>{copy('p3.library.readDetails')}</summary><div className="projects-library-detailcontent">
        <code>{page?.absolutePath ?? request.path}</code>
        <p>{copy('p3.library.conversationOrigin', { session: request.role === 'main' ? copy('p3.library.mainSession') : request.sessionTitle })}</p>
        <p>{copy('p3.library.session')} <code>{request.sessionId}</code> · {copy('p3.library.originalChat')} <code>{request.hostSessionId}</code></p>
        {page !== undefined && <p>{page.bytes === undefined ? copy('p3.library.totalBytesUnknown') : copy('p3.library.totalBytes', { bytes: page.bytes })} · {copy('p3.library.nativeTextPage')}</p>}
        {page !== undefined && <p>{copy('p3.library.readVersion')} <code>{page.version}</code> · {copy('p3.library.pageSnapshotHelp')}</p>}
      </div></details>
    </div>
    <footer className="projects-library-readingfooter"><Button variant="outline" size="sm" type="button" onClick={onBack}>{backLabel}</Button>
      {onFeedback !== undefined && <Button variant="primary" size="sm" type="button" onClick={onFeedback}>{feedbackLabel ?? copy('p3.library.returnForFeedback')}</Button>}
    </footer>
  </section>
}

function readTimestamp(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { hour12: false })
}
