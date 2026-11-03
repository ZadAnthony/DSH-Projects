import type { LibraryOpenResult } from '../library-contract.ts'
import type { LibrarySelection } from './library/index.ts'

/** A visit origin is navigation context, never authorship or task ownership. */
export type ReadingOrigin =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'board' }
  | { readonly kind: 'library' }

export interface LibraryReading {
  readonly selection: LibrarySelection
  readonly sessionId: string
  readonly origin: ReadingOrigin
  readonly value?: LibraryOpenResult
  readonly loading?: boolean
  readonly error?: string
  readonly scrollTop: number
}

export interface ReadingHint {
  readonly reading: LibraryReading
  readonly mode: 'feedback' | 'source'
}
