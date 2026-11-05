import { useMemo, type ReactNode } from 'react'
import { Button, MarkdownText, type MarkdownLabels, type ProjectsTranslate } from './ui/index.ts'
import type { TextReadingView } from './workflow-reading.ts'

/**
 * File identity comes from the actual read path. Library maps .md to text/markdown;
 * .markdown uses the native binary fallback, so it still needs strict UTF-8 decoding
 * before it can enter this text-only presentation. Other text/code stays exact source.
 */
export function isMarkdownFile(path: string, mediaType?: string): boolean {
  return /\.(?:md|markdown)$/i.test(path.replaceAll('\\', '/'))
    && (mediaType === undefined || mediaType.startsWith('text/') || mediaType === 'application/octet-stream')
}

/** One explicit view choice; switching never reads another page or rewrites file content. */
export function TextReadingControls({ view, onChange, copy }: {
  readonly view: TextReadingView
  readonly onChange: (view: TextReadingView) => void
  readonly copy: ProjectsTranslate
}): ReactNode {
  return <div className="projects-library-viewmode" role="group" aria-label={copy('p3.library.viewMode')}>
    <Button variant={view === 'reading' ? 'outline' : 'ghost'} size="sm" type="button" aria-pressed={view === 'reading'} onClick={() => onChange('reading')}>{copy('p3.library.readingView')}</Button>
    <Button variant={view === 'raw' ? 'outline' : 'ghost'} size="sm" type="button" aria-pressed={view === 'raw'} onClick={() => onChange('raw')}>{copy('p3.library.rawView')}</Button>
  </div>
}

/** The host renderer owns Markdown grammar, URL/HTML safety, images and code/table chrome. */
export function TextReadingContent({ text, view, copy }: {
  readonly text: string
  readonly view: TextReadingView
  readonly copy: ProjectsTranslate
}): ReactNode {
  const labels = useMemo<MarkdownLabels>(() => ({
    code: {
      copyLabel: copy('p3.library.markdownCopy'), copiedLabel: copy('p3.library.markdownCopied'),
      toolbarLabels: { codeLabel: copy('p3.library.markdownCode'), wrapLabel: copy('p3.library.markdownWrap'), unwrapLabel: copy('p3.library.markdownUnwrap') },
    },
    footnotes: copy('p3.library.markdownFootnotes'),
  }), [copy])
  return view === 'raw'
    ? <pre className="projects-library-body" aria-label={copy('p3.library.rawText')}>{text}</pre>
    : <div className="projects-library-document" aria-label={copy('p3.library.readingView')}><MarkdownText text={text} labels={labels} /></div>
}
