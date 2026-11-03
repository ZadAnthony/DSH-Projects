/** File identity, Sidebar preview, and contributed native actions for one delivery. */
import type { ReactNode } from 'react'
import { resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import { Button, FileTypeIcon, fileExtension } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { basename, type PresentedPath } from './turn-deliverables.ts'
import type { NS } from './locales.ts'
import css from './Deliverables.module.css'

function cardDescription(description: string | undefined, fallback: string): string {
  const trimmed = description?.replace(/\s*(?:\([^()]*\)|（[^（）]*）)\s*$/u, '').trim()
  return trimmed === undefined || trimmed === '' ? fallback : trimmed
}

/** Local paths are literal filenames, not URLs with search or fragment components. */
export function isHtmlFile(path: string): boolean {
  return /\.(?:html?|xhtml)$/iu.test(path)
}

/**
 * Render independent file actions without nesting buttons inside a clickable card.
 * @param props - durable file metadata, Sidebar preview, Host capabilities, gesture status, and localized copy.
 * @returns the file card and its anchored action menu.
 */
export function PresentedFileCard({ file, cwd, phase, onPreview, actions, t }: {
  file: PresentedPath
  cwd: string | undefined
  phase: 'opening' | 'error' | undefined
  onPreview: () => void
  actions: ReactNode
} & PropsLocale<typeof NS>) {
  const name = basename(file.path)
  const metadata = fileExtension(name).toUpperCase() || t('presented.file')
  const contentLabel = t(isHtmlFile(file.path) ? 'presented.source' : 'presented.content')
  const contentAria = t(isHtmlFile(file.path) ? 'presented.sourceButton' : 'presented.contentButton', { name: file.path })
  const status = phase === undefined
    ? cardDescription(file.description, metadata)
    : t(`presented.${phase}`)
  return <div className={css.file} data-presented-file>
    <button type="button" className={css.cardPreview} title={resolveWorkspacePath(cwd, file.path)}
      aria-label={contentAria} disabled={phase === 'opening'} aria-busy={phase === 'opening'} onClick={onPreview} />
    <span className={css.fileIcon}><FileTypeIcon path={file.path} size={20} /></span>
    <div className={css.fileBody}>
      <div className={css.details}>
        <span className={css.fileName}>{name}</span>
        <span className={css.description} data-presented-description role={phase === undefined ? undefined : 'status'}
          data-error={phase === 'error' ? true : undefined}>
          <span className={css.secondaryText}>
            {status}
          </span>
          <span className={css.previewHint}>{contentLabel}</span>
        </span>
      </div>
      <div className={css.actions}><Button type="button" variant="ghost" size="sm" aria-label={contentAria}
        disabled={phase === 'opening'} aria-busy={phase === 'opening'} onClick={onPreview}>{contentLabel}</Button>{actions}</div>
    </div>
  </div>
}
