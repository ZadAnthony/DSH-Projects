import type { LibraryOpenResult } from '../library-contract.ts'
import type { LibrarySelection } from './library/index.ts'
import type { ProjectConversationFileRequest } from './workflow-navigation.ts'

/** 正文与矮窗外层是同一次阅读位置；旧消费者省略外层时仍从零开始。 */
export interface ReadingScrollPosition {
  readonly scrollTop: number
  readonly outerScrollTop?: number | undefined
  /** Markdown and exact source have different geometry; keep their actual paired positions. */
  readonly presentation?: TextReadingPresentation | undefined
}

export type TextReadingView = 'reading' | 'raw'
export interface TextReadingPresentation {
  readonly view: TextReadingView
  readonly positions: Partial<Record<TextReadingView, {
    readonly scrollTop: number
    readonly outerScrollTop: number
  }>>
}

export interface ConversationReading extends ReadingScrollPosition {
  readonly request: ProjectConversationFileRequest
  readonly offset: number
}

/** A visit origin is navigation context, never authorship or task ownership. */
export type ReadingOrigin =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'board' }
  | { readonly kind: 'library' }

export interface LibraryReading extends ReadingScrollPosition {
  readonly selection: LibrarySelection
  readonly sessionId: string
  readonly origin: ReadingOrigin
  readonly value?: LibraryOpenResult
  readonly loading?: boolean
  readonly error?: string
}

export interface ReadingHint {
  readonly reading: LibraryReading
  readonly mode: 'feedback' | 'source'
}
