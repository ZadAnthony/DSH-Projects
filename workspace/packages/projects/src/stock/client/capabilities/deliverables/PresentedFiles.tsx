/** Stock delivery-file cards over one exact private FileReader callback. */
import { useEffect, useRef, useState } from 'react'
import { Button, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ProjectPresentedFilesPorts } from './index.ts'
import { PresentedFileCard } from './PresentedFileCard.tsx'
import { presentedForClosing, type PresentedPath } from './turn-deliverables.ts'
import type { NS } from './locales.ts'
import css from './Deliverables.module.css'

export interface PresentedFilesInjected {
  openPresentedFile: (path: string) => ReturnType<ProjectPresentedFilesPorts['openFile']>
  openPresentedOriginal: (path: string) => Promise<void>
}

type PresentedFilesProps = PropsRuntime<'conversation.chat.turnTail'> & PropsLocale<typeof NS> & PresentedFilesInjected

/** Keep the stock four-file fold and path order; metadata is derived only from durable events. */
export function PresentedFilesTail(props: PresentedFilesProps) {
  const files = presentedForClosing(props)
  return files.length === 0 ? null : <PresentedFiles {...props} files={files} />
}

function PresentedFiles({ files, sessionId, useSessions, openPresentedFile, openPresentedOriginal, t }: PresentedFilesProps & { files: readonly PresentedPath[] }) {
  const [expanded, setExpanded] = useState(false)
  const cwd = useSessions(value => value.byId[sessionId]?.cwd)
  const collapsible = files.length > 4
  const visible = collapsible && !expanded ? files.slice(0, 4) : files
  return <div className={css.root} data-project-presented-files>
    <div className={css.presented} data-presented-files-row data-single={files.length === 1 ? true : undefined}>
      {visible.map(file => <PrivatePresentedCard key={`${sessionId}:${file.seq}:${file.index}:${file.path}`}
        file={file} sessionId={sessionId} cwd={cwd} openPresentedFile={openPresentedFile} openPresentedOriginal={openPresentedOriginal} t={t} />)}
    </div>
    <p className={css.hostStatus}>{t('presented.openHelp')}</p>
    {collapsible && <button type="button" className={css.toggle} aria-expanded={expanded}
      aria-label={t(expanded ? 'presented.collapseAria' : 'presented.expandAria', { count: files.length })}
      onClick={() => { setExpanded(value => !value) }}>
      <span>{t(expanded ? 'presented.collapse' : 'presented.all', { count: files.length })}</span>
      {expanded ? <IconChevronUpOutlineRegular /> : <IconChevronDownOutlineRegular />}
    </button>}
  </div>
}

function PrivatePresentedCard({ file, sessionId, cwd, openPresentedFile, openPresentedOriginal, t }: {
  file: PresentedPath
  sessionId: SessionId
  cwd: string | undefined
} & PresentedFilesInjected & PropsLocale<typeof NS>) {
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [native, setNative] = useState<{ readonly phase: 'opening' | 'opened' | 'error'; readonly reason?: string }>()
  const nativeInFlight = useRef(false)
  const active = useRef(true)
  const inFlight = useRef(false)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const preview = async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setPending(true)
    setFailure(undefined)
    try {
      await openPresentedFile(file.path)
    } catch (error) {
      if (active.current) setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      inFlight.current = false
      if (active.current) setPending(false)
    }
  }
  const openOriginal = async (): Promise<void> => {
    if (nativeInFlight.current) return
    nativeInFlight.current = true
    setNative({ phase: 'opening' })
    try {
      await openPresentedOriginal(file.path)
      if (active.current) setNative({ phase: 'opened' })
    } catch (error) {
      const reason = error instanceof Error || typeof error === 'object' && error !== null && 'message' in error
        ? String(error.message) : String(error)
      if (active.current) setNative({ phase: 'error', reason })
    } finally { nativeInFlight.current = false }
  }
  return <div data-presented-session={sessionId} data-presented-seq={file.seq} data-presented-index={file.index}>
    <PresentedFileCard file={file} cwd={cwd} phase={failure === undefined ? pending ? 'opening' : undefined : 'error'}
      onPreview={() => { void preview() }} actions={<Button type="button" variant="ghost" size="sm" disabled={native?.phase === 'opening'} aria-busy={native?.phase === 'opening'}
        aria-label={t('presented.openButton', { name: file.path })} title={t('presented.openHelp')}
        onClick={() => { void openOriginal() }}>{t(native?.phase === 'opening' ? 'presented.nativeOpening' : 'presented.open')}</Button>} t={t} />
    {failure !== undefined && <p className={css.previewError} role="alert">{failure}</p>}
    {native !== undefined && <p className={native.phase === 'error' ? css.previewError : css.hostStatus}
      role={native.phase === 'error' ? 'alert' : 'status'}>{t(native.phase === 'error' ? 'presented.nativeError'
        : native.phase === 'opening' ? 'presented.nativeOpening' : 'presented.nativeOpened', { reason: native.reason ?? '' })}</p>}
  </div>
}
