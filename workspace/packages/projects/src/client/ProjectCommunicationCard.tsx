/** Communication views read the saved chat copy, independently of short tool receipts. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, DisclosureRow, ErrorState, IconCodeOutlineRegular, IconPaperPlaneOutlineRegular, LoadingState, StateDot, Tag, ToolCard } from './ui/index.ts'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MessageImageLoader } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ProjectCommunicationRead, ProjectCommunicationSnapshot,
  ProjectCommunicationNavigation, ProjectCommunicationFile, ProjectCommunicationRecord, ProjectNavigationTarget,
  ReadProjectCommunicationRequest, ResolveProjectCommunicationNavigationRequest, ResolveProjectCommunicationFileRequest,
} from '../public-types.ts'
import { ProjectsToolCard } from './ProjectToolCard.tsx'

export interface ProjectCommunicationInvocationQuery {
  readonly holderHostSessionId: string
  readonly callId: string
  readonly phase: 'preparing' | 'start' | 'result'
  readonly eventSeq?: number | undefined
}

/** Exact saved-copy holder for a communication attachment; paths never identify its owner. */
export interface ProjectCommunicationFileContext {
  readonly projectId: string
  readonly record: ProjectCommunicationRecord
  readonly attachmentId?: string | undefined
}

type OpenCommunicationFile = (path: string, context: ProjectCommunicationFileContext) => void | Promise<void>

export interface ProjectCommunicationInjected {
  /** Own holder-log notifications refresh prepared/final saved copies while a card is resident. */
  subscribeCommunicationChanges?: (holderHostSessionId: string, refresh: () => void) => () => void
  /** Resolve from this holder's actual log; duplicate call IDs without exact coordinates must remain unresolved. */
  resolveCommunicationInvocation: (request: ProjectCommunicationInvocationQuery, signal: AbortSignal) => Promise<ReadProjectCommunicationRequest | undefined>
  readCommunication: (request: ReadProjectCommunicationRequest, signal: AbortSignal) => Promise<ProjectCommunicationRead>
  resolveCommunicationNavigation: (request: ResolveProjectCommunicationNavigationRequest, signal?: AbortSignal) => Promise<ProjectCommunicationNavigation>
  resolveCommunicationFile: (request: ResolveProjectCommunicationFileRequest, signal?: AbortSignal) => Promise<ProjectCommunicationFile>
  openTarget: (projectId: string, target: ProjectNavigationTarget) => Promise<void>
  openCommunicationFile: (path: string, context: ProjectCommunicationFileContext) => Promise<void>
}
type Locale = PropsLocale<'projects'>
type Actions = InjectFace<ProjectCommunicationInjected>
type SenderProps = PropsRuntime<'tool.call.toolview'> & Locale & Actions
export interface ProjectCommunicationMessagePresentation {
  readonly sessionId: string
  readonly message: { readonly source: unknown; readonly messageId?: string | undefined }
  readonly loadImage: MessageImageLoader
  readonly openFile?: ((path: string) => void | Promise<void>) | undefined
  readonly renderOriginal: () => ReactNode
}
type RecipientProps = ProjectCommunicationMessagePresentation & Locale & Actions

type Saved = Extract<ProjectCommunicationRead, { kind: 'communication' }>

function useSaved(request: ReadProjectCommunicationRequest | undefined, read: Actions['readCommunication'], revision?: number) {
  const key = JSON.stringify(request)
  const [state, setState] = useState<{ key: string | undefined; value?: ProjectCommunicationRead; failed?: boolean }>(() => ({ key: undefined }))
  const refresh = useRef<() => void>(() => {})
  useEffect(() => {
    if (request === undefined) return
    const controller = new AbortController()
    let reading = false
    let requested = false
    refresh.current = () => {
      requested = true
      if (reading) return
      reading = true
      void (async () => {
        do {
          requested = false
          try {
            const value = await read(request, controller.signal)
            if (!controller.signal.aborted) setState({ key, value })
          } catch {
            if (!controller.signal.aborted) setState({ key, failed: true })
          }
          // Holder output can change while this saved copy is being read. Publish
          // the completed read first, then coalesce its later fact refreshes.
        } while (requested && !controller.signal.aborted)
        reading = false
      })()
    }
    return () => { controller.abort(); refresh.current = () => {} }
  }, [key, read])
  useEffect(() => { refresh.current() }, [key, read, revision])
  return state.key === key ? state : { key: undefined }
}

function Link({ saved, target, label, resolveCommunicationNavigation, openTarget, t }: {
  saved: Saved; target: ResolveProjectCommunicationNavigationRequest['target']; label: string
} & Actions & Locale) {
  const [link, setLink] = useState<ProjectCommunicationNavigation>()
  const [opening, setOpening] = useState(false)
  const [failure, setFailure] = useState<string>()
  const describeFailure = (error: unknown) => error instanceof Error ? error.message : typeof error === 'string' ? error : t('communication.sourceReadError')
  const request = useMemo(() => ({ projectId: saved.projectId, record: saved.record, target }), [saved.projectId, saved.record, JSON.stringify(target)])
  useEffect(() => {
    const controller = new AbortController()
    setLink(undefined); setFailure(undefined)
    void resolveCommunicationNavigation(request, controller.signal).then(value => { if (!controller.signal.aborted) setLink(value) }, error => {
      if (!controller.signal.aborted) setFailure(describeFailure(error))
    })
    return () => { controller.abort() }
  }, [request, resolveCommunicationNavigation])
  const open = async () => {
    setOpening(true); setFailure(undefined)
    try {
      const current = await resolveCommunicationNavigation(request)
      setLink(current)
      if (current.kind === 'available') await openTarget(current.projectId, { ...current.target, focusEventSeq: current.eventSeq, ...current.messageId === undefined ? {} : { focusMessageId: current.messageId } })
    } catch (error) { setFailure(describeFailure(error)) } finally { setOpening(false) }
  }
  return <span className="dsh-projects-communication__link">
    <Button variant="ghost" size="sm" disabled={opening || failure === undefined && link?.kind !== 'available'} aria-busy={opening} onClick={() => { void open() }}>
      {label}{link?.kind === 'unavailable' ? ` · ${t('communication.sourceUnavailable')}` : ''}
    </Button>
    {link?.kind === 'unavailable' && <span className="dsh-projects-communication__hint">{link.reason}</span>}
    {failure !== undefined && <ErrorState role="status" title={t('communication.sourceReadError')} description={failure === t('communication.sourceReadError') ? undefined : failure} inline />}
  </span>
}

function File({ attachmentId, name, saved, openFile, resolveCommunicationFile, t }: {
  attachmentId: string; name: string; saved: Saved; openFile: OpenCommunicationFile
} & Pick<Actions, 'resolveCommunicationFile'> & Locale) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  const open = async () => {
    setBusy(true); setFailure(undefined)
    try {
      const entry = await resolveCommunicationFile({ projectId: saved.projectId, record: saved.record, attachmentId })
      if (entry.kind === 'available') await openFile(entry.path, { projectId: saved.projectId, record: saved.record, attachmentId })
      else setFailure(entry.reason)
    } catch { setFailure(t('communication.attachmentUnavailable')) } finally { setBusy(false) }
  }
  return <div className="dsh-projects-communication__attachment">
    <Button variant="outline" size="sm" disabled={busy} aria-busy={busy} onClick={() => { void open() }}>{t('communication.openFile', { name })}</Button>
    {failure !== undefined && <ErrorState role="status" title={failure} inline />}
  </div>
}

function Image({ attachment, loadImage, t }: {
  attachment: Parameters<MessageImageLoader>[0]; loadImage: MessageImageLoader
} & Locale) {
  const [value, setValue] = useState<{ url?: string; failed?: boolean }>({})
  useEffect(() => {
    let live = true
    void loadImage(attachment).then(url => { if (live) setValue({ url }) }, () => { if (live) setValue({ failed: true }) })
    return () => { live = false }
  }, [attachment, loadImage])
  if (value.failed) return <p role="status">{t('communication.attachmentUnavailable')}</p>
  if (value.url === undefined) return <LoadingState label={t('communication.loadingAttachment')} />
  return <a className="dsh-projects-communication__imageLink" href={value.url} target="_blank" rel="noreferrer" aria-label={t('communication.openImage')}>
    <img className="dsh-projects-communication__image" src={value.url} alt={attachment.name ?? t('communication.image')} />
  </a>
}

type Visible = ProjectCommunicationSnapshot['contextParts'][number]['blocks'][number]
function Blocks({ blocks, saved, loadImage, openFile, actions, t }: {
  blocks: readonly Visible[]; saved: Saved; loadImage: MessageImageLoader; openFile: OpenCommunicationFile; actions: Actions
} & Locale): ReactNode {
  return blocks.map((block, index) => {
    switch (block.type) {
      case 'text': return <pre key={index} className="dsh-projects-communication__text">{block.text}</pre>
      case 'file': return <File key={index} saved={saved} attachmentId={String(block.attachment.attachmentId)} name={block.attachment.name} openFile={openFile} resolveCommunicationFile={actions.resolveCommunicationFile} t={t} />
      case 'image': return <Image key={index} attachment={block.attachment} loadImage={loadImage} t={t} />
      case 'quoted-tool-call': return <section className="dsh-projects-communication__quoted" key={index}><strong>{t('communication.quotedCall', { name: block.name })}</strong><pre className="dsh-projects-communication__text">{block.arguments}</pre></section>
      case 'quoted-tool-result': return <section className="dsh-projects-communication__quoted" data-error={block.isError} key={index}><strong>{t(block.isError ? 'communication.quotedError' : 'communication.quotedResult')}</strong>
        {block.error !== undefined && <pre className="dsh-projects-communication__text">{[block.error.name, block.error.code, block.error.reason].filter(value => value !== undefined).join('\n')}</pre>}
        <Blocks blocks={block.content} saved={saved} loadImage={loadImage} openFile={openFile} actions={actions} t={t} />
      </section>
    }
  })
}

function Content({ saved, loadImage, openFile, actions, t }: {
  saved: Saved; loadImage: MessageImageLoader; openFile: OpenCommunicationFile; actions: Actions
} & Locale) {
  const snapshot = saved.snapshot
  const parts = (items: ProjectCommunicationSnapshot['contextParts']) => items.map(part => <section key={part.id} className="dsh-projects-communication__part">
    <div className="dsh-projects-communication__partHeader">
      <span>{t(`communication.speaker.${part.originalSpeaker}`)}</span>
      <time dateTime={new Date(part.originTime).toISOString()}>{new Date(part.originTime).toLocaleString()}</time>
      <Link saved={saved} target={{ kind: 'part-origin', partId: part.id }} label={t('communication.source')} {...actions} t={t} />
    </div>
    <Blocks blocks={part.blocks} saved={saved} loadImage={loadImage} openFile={openFile} actions={actions} t={t} />
  </section>)
  return <div className="dsh-projects-communication__content">
    <div className="dsh-projects-communication__routing">
      <Link saved={saved} target={{ kind: 'sender' }} label={t('communication.from', { name: snapshot.sender.title })} {...actions} t={t} />
      <Link saved={saved} target={{ kind: 'recipient' }} label={t('communication.to', { name: snapshot.recipient.title })} {...actions} t={t} />
      {snapshot.replyTo !== undefined && <Link saved={saved} target={{ kind: 'reply' }} label={t('communication.replyTo')} {...actions} t={t} />}
    </div>
    {snapshot.agentMessage !== undefined && <section className="dsh-projects-communication__body"><h4>{t('communication.agentMessage')}</h4><pre className="dsh-projects-communication__text">{snapshot.agentMessage}</pre></section>}
    {snapshot.userMessageParts.length > 0 && <section className="dsh-projects-communication__original"><h4>{t('communication.userMessages')}</h4>{parts(snapshot.userMessageParts)}</section>}
    {snapshot.contextParts.length > 0 && <details className="dsh-projects-communication__context"><summary>{t('communication.context', { count: snapshot.contextParts.length })}</summary>{parts(snapshot.contextParts)}</details>}
    <div className="dsh-projects-communication__identity"><span>{t('communication.id', { id: snapshot.deliveryId })}</span></div>
  </div>
}

function Facts({ saved, t }: { saved: Saved } & Locale) {
  return <div className="dsh-projects-communication__facts" data-result={saved.result} role="status">
    <p className="dsh-projects-communication__result"><Tag tone={saved.result === 'delivered' ? 'success' : 'warning'}>{t(`communication.result.${saved.result}`)}</Tag></p>
    {saved.facts !== undefined && <div className="dsh-projects-communication__factGrid">
      <p>{t(`communication.insertion.${saved.facts.insertion}`)}</p>
      <p>{t('communication.senderSave', { value: t(`communication.persistence.${saved.facts.senderPersistence}`) })}</p>
      <p>{t('communication.recipientSave', { value: t(`communication.persistence.${saved.facts.recipientPersistence}`) })}</p>
      {saved.facts.admissionPersistence !== undefined && <p>{t('p3.cards.communication.admissionSave', { value: t(`communication.persistence.${saved.facts.admissionPersistence}`) })}</p>}
      <p>{t(`communication.wakeup.${saved.facts.wakeup}`)}</p>
    </div>}
    <p>{t('p3.cards.communication.readingUnconfirmed')}</p>
    <p>{t('p3.cards.communication.completionUnconfirmed')}</p>
    {saved.failure !== undefined && <p className="dsh-project-feedback__error">{saved.failure.message}</p>}
    {saved.facts?.error !== undefined && <p className="dsh-project-feedback__error">{saved.facts.error.message}</p>}
  </div>
}

/** Delivery and each persistence barrier remain separate, including known effects. */
function PersistentFacts({ saved, t }: { saved: Saved } & Locale) {
  const facts = saved.facts
  const persistenceIssue = (value: string | undefined) => value === 'failed' || value === 'unavailable' || value === 'unknown'
  const hasPersistenceIssue = facts !== undefined && [facts.senderPersistence, facts.recipientPersistence, facts.admissionPersistence].some(persistenceIssue)
  const exceptional = saved.result !== 'delivered' || hasPersistenceIssue || facts?.insertion === 'unknown'
    || facts?.wakeup === 'unknown' || saved.failure !== undefined || facts?.error !== undefined
  if (!exceptional) return null
  return <div className="projects-ui__tool-card-exception" role="status">
    {hasPersistenceIssue && <p><Tag tone="warning">{t('p3.cards.communication.persistenceIssue')}</Tag></p>}
    {facts !== undefined && <>
      {persistenceIssue(facts.senderPersistence) && <p>{t('communication.senderSave', { value: t(`communication.persistence.${facts.senderPersistence}`) })}</p>}
      {persistenceIssue(facts.recipientPersistence) && <p>{t('communication.recipientSave', { value: t(`communication.persistence.${facts.recipientPersistence}`) })}</p>}
      {persistenceIssue(facts.admissionPersistence) && facts.admissionPersistence !== undefined && <p>{t('p3.cards.communication.admissionSave', { value: t(`communication.persistence.${facts.admissionPersistence}`) })}</p>}
      {facts.insertion === 'unknown' && <p>{t('communication.insertion.unknown')}</p>}
      {facts.wakeup === 'unknown' && <p>{t('communication.wakeup.unknown')}</p>}
    </>}
    {saved.failure !== undefined && <p className="dsh-project-feedback__error">{saved.failure.message}</p>}
    {facts?.error !== undefined && <p className="dsh-project-feedback__error">{facts.error.message}</p>}
  </div>
}

/** Native disclosure retains the complete invocation and saved receipt, without a char cap. */
function Receipt({ value, t }: { value: unknown } & Locale) {
  const [open, setOpen] = useState(false)
  return <DisclosureRow title={t('communication.toolReceipt')} icon={<IconCodeOutlineRegular />} open={open} expandable expandOnRowClick onToggle={() => setOpen(previous => !previous)}>
    <pre className="projects-ui__tool-card-raw">{JSON.stringify(value, null, 2)}</pre>
  </DisclosureRow>
}

function savedTitle(saved: Saved | undefined, fallback: string, t: Locale['t']): string {
  return saved === undefined ? fallback : t('p3.cards.communication.route', { from: saved.snapshot.sender.title, to: saved.snapshot.recipient.title })
}

function DeliveryStatus({ saved, t }: { saved: Saved } & Locale) {
  return <Tag tone={saved.result === 'delivered' ? 'success' : saved.result === 'not-delivered' ? 'danger' : 'warning'}>{t(`p3.cards.communication.result.${saved.result}`)}</Tag>
}

export function ProjectCommunicationCard(props: SenderProps) {
  const { phase, block, sessionId, readCommunication, resolveCommunicationInvocation, t, loadImage } = props
  const [revision, setRevision] = useState(0)
  useEffect(() => props.subscribeCommunicationChanges?.(String(sessionId), () => { setRevision(value => value + 1) }), [sessionId, props.subscribeCommunicationChanges])
  const eventSeq = phase === 'result' ? block.seq : undefined
  const key = JSON.stringify([sessionId, props.callId, phase, eventSeq])
  const [located, setLocated] = useState<{ readonly key: string; readonly request?: ReadProjectCommunicationRequest; readonly failed?: boolean }>()
  useEffect(() => {
    if (phase === 'preparing') return
    const abort = new AbortController()
    void resolveCommunicationInvocation({ holderHostSessionId: String(sessionId), callId: props.callId, phase, eventSeq }, abort.signal).then(request => {
      if (!abort.signal.aborted) setLocated({ key, ...(request === undefined ? {} : { request }) })
    }, () => { if (!abort.signal.aborted) setLocated({ key, failed: true }) })
    return () => { abort.abort() }
  }, [key, resolveCommunicationInvocation, revision])
  const state = useSaved(located?.key === key ? located.request : undefined, readCommunication, revision)
  if (state.value?.kind === 'legacy') return <ProjectsToolCard {...props} />
  const saved = state.value?.kind === 'communication' ? state.value : undefined
  return <ToolCard title={savedTitle(saved, t('communication.sent'), t)} icon={<IconPaperPlaneOutlineRegular />}
    className="dsh-project-feedback" data-dsh-projects-communication="sender" data-state={phase === 'result' ? block.isError ? 'error' : 'settled' : phase}
    running={phase !== 'result'} status={saved === undefined ? <span role="status"><StateDot state={phase !== 'result' ? 'ongoing' : 'warning'} />{t(phase === 'result' ? 'p3.cards.communication.result.unknown' : 'communication.preparing')}</span> : <DeliveryStatus saved={saved} t={t} />}
    persistent={<>
    {phase === 'result' && block.isError && <p className="dsh-project-feedback__error" role="status">{t('communication.toolStopped')}</p>}
    {saved === undefined ? <p className="dsh-project-feedback__status" role="status">{t(state.failed || located?.key === key && located.failed ? 'communication.readError' : state.value?.kind === 'unsupported' ? 'communication.unsupported' : state.value?.kind === 'unavailable' ? 'communication.unavailable' : phase === 'result' ? 'communication.noPreparedRecord' : 'communication.preparing')}</p>
      : <PersistentFacts saved={saved} t={t} />}
    </>}>
    {saved !== undefined && <>
      <Content saved={saved} loadImage={loadImage} openFile={props.openCommunicationFile} actions={props} t={t} />
      <Facts saved={saved} t={t} />
    </>}
    {phase === 'start' && <Receipt value={{ input: block.argsRaw, saved }} t={t} />}
    {phase === 'result' && <Receipt value={{ input: block.call?.argsRaw, content: block.content, error: block.error, saved }} t={t} />}
  </ToolCard>
}

export function ProjectCommunicationMessage(props: RecipientProps) {
  const { message, sessionId, readCommunication, loadImage, t } = props
  const openFile = props.openFile ?? props.openCommunicationFile
  const source = message.source as { communicationFormat?: unknown } | null
  const legacy = source?.communicationFormat === undefined
  const supported = source?.communicationFormat === 'projects-communication/v1'
  const request = useMemo<ReadProjectCommunicationRequest | undefined>(() => !supported || message.messageId === undefined ? undefined
    : { holderHostSessionId: String(sessionId), locator: { kind: 'recipient', messageId: String(message.messageId) } }, [supported, sessionId, message.messageId])
  const [revision, setRevision] = useState(0)
  useEffect(() => props.subscribeCommunicationChanges?.(String(sessionId), () => { setRevision(value => value + 1) }), [sessionId, props.subscribeCommunicationChanges])
  const state = useSaved(request, readCommunication, revision)
  if (legacy || state.value?.kind === 'legacy') return props.renderOriginal()
  const saved = state.value?.kind === 'communication' ? state.value : undefined
  return <ToolCard title={savedTitle(saved, t('communication.received'), t)} icon={<IconPaperPlaneOutlineRegular />}
    className="dsh-project-feedback" data-dsh-projects-communication="recipient"
    status={saved === undefined ? undefined : <DeliveryStatus saved={saved} t={t} />}
    persistent={<>
    {saved === undefined ? <p className="dsh-project-feedback__status" role="status">{t(!supported || state.value?.kind === 'unsupported' ? 'communication.unsupported' : state.failed || message.messageId === undefined ? 'communication.readError' : state.value?.kind === 'unavailable' ? 'communication.unavailable' : 'communication.loading')}</p>
      : <PersistentFacts saved={saved} t={t} />}
    </>}>
    {saved !== undefined && <><Content saved={saved} loadImage={loadImage} openFile={openFile} actions={props} t={t} />
      <Facts saved={saved} t={t} /><Receipt value={saved} t={t} /></>}
  </ToolCard>
}
