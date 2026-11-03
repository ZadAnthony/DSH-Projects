/** Read-only main-history selection, delivery and bound-reader values. */
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { RequestSourcedHistory } from '../stock/request/harness.ts'
import type { ProjectStore } from '../records.ts'
import type { ProjectsCoreAccess } from '../core-access.ts'
import type { ProjectHistoryReader, ProjectHistoryContentRequest, ProjectHistoryContentPage } from '../project-history.ts'
import type { ProjectHistorySearchRequest, ProjectHistorySearchResult, ProjectHistoryReadRequest, ProjectHistoryReadResult } from '../project-history-types.ts'
import type { CommunicationContentBudget } from '../communication/content-types.ts'
import type { NativeProjectSourceItem, NativeProjectMessageSource } from '../source-types.ts'
import type { SourceRef } from '../records-types.ts'
import type { SettledTurnKey } from './types.ts'

/** Exact existing services; the selector does not own a log, cache or Agent. */
export interface MainContinuityHistoryOptions {
  readonly store: ProjectStore
  readonly core: ProjectsCoreAccess
  readonly history: ProjectHistoryReader
}

/** One recorded carrier, including an unavailable carrier rather than omitting it. */
export interface MainHistoryCarrier {
  readonly sequence: number
  readonly hostSessionId: string
  readonly isCurrent: boolean
  readonly header?: SessionHeader
  readonly status: 'available' | 'deleting' | 'partial' | 'deleted' | 'unreadable'
  readonly reason?: string
  readonly read: { readonly sessionIds: readonly string[]; readonly hostSessionIds: readonly string[] }
}

/** Store-derived main history; availability names source disposition, not a body-read receipt. */
export interface MainHistoryDirectory {
  readonly projectId: string
  readonly mainSessionId: string
  readonly currentHostSessionId: string
  readonly previousCarrier?: MainHistoryCarrier
  readonly carriers: readonly MainHistoryCarrier[]
  readonly limitations: readonly string[]
}

/** Original visible content plus known producer route fields from its real native record. */
export interface MainHistoryItem extends NativeProjectSourceItem {
  /** Known original producer facts; unknown route fields remain absent. */
  readonly producer: NativeProjectMessageSource & { readonly provider?: string; readonly model?: string }
}

/** A normally completed native turn with at least one actually consumed business input. */
export interface MainHistoryTurn {
  readonly key: SettledTurnKey
  readonly carrierSequence: number
  readonly header?: SessionHeader
  readonly items: readonly MainHistoryItem[]
  readonly sources: readonly SourceRef[]
  /** Completeness of this selected turn's visible original records, not a model-quality claim. */
  readonly complete: boolean
}

/** A real unfinished/non-normal turn; it is never counted toward the three-turn window. */
export interface MainHistoryUnsettledTurn {
  readonly hostSessionId: string
  readonly sessionCreatedAt: number
  readonly carrierSequence: number
  readonly turnStartSeq: number
  readonly turnEndSeq?: number
  readonly reason: string
  readonly items: readonly MainHistoryItem[]
  readonly sources: readonly SourceRef[]
}

/** A scheduled/started tool occurrence whose model-facing result is not durably present. */
export interface MainHistoryOperation {
  readonly hostSessionId: string
  readonly callId: string
  readonly startSeq: number
  readonly status: 'unknown' | 'returned-not-delivered'
  readonly executionStarted: boolean
  readonly observedAt: { readonly sessionCreatedAt: number; readonly endSeq: number; readonly sourceRevision: number }
  readonly sources: readonly SourceRef[]
  readonly read: readonly { readonly source: SourceRef; readonly before: 0; readonly after: 0 }[]
}

/** Selected turns stay intact when capacity causes partial delivery; source receipts track delivered bodies. */
export interface MainHistoryWindow {
  readonly requestedTurns: 3
  readonly turns: readonly MainHistoryTurn[]
  readonly selectionComplete: boolean
  readonly unsettledTurns: readonly MainHistoryUnsettledTurn[]
  readonly operations: readonly MainHistoryOperation[]
  readonly pendingInputs: readonly MainHistoryItem[]
  readonly directory: MainHistoryDirectory
  readonly sources: readonly SourceRef[]
  readonly sourcedHistory: readonly RequestSourcedHistory[]
  readonly limitations: readonly string[]
  /** True only when all selected original visible bodies were delivered and selection had no gaps. */
  readonly complete: boolean
}

/** Main-scoped reader; saved communication authorization follows its holder, never part origin. */
export interface MainHistoryReader {
  /** Search only this stable main and its recorded carriers. */
  search(request: ProjectHistorySearchRequest, signal?: AbortSignal,
    captureSamePage?: (read: (signal?: AbortSignal) => Promise<ProjectHistorySearchResult>) => void): Promise<ProjectHistorySearchResult>
  /** Read an exact allowed source, with the existing bounded adjacent context rules. */
  read(request: ProjectHistoryReadRequest, signal?: AbortSignal): Promise<ProjectHistoryReadResult>
  /** Continue the same allowed native/saved body using its existing range/cursor protocol. */
  readContent(request: ProjectHistoryContentRequest, budget: CommunicationContentBudget, signal?: AbortSignal): Promise<ProjectHistoryContentPage>
}

/** The caller measures the entire actual request, including wrappers, tools and current context. */
export interface MainHistoryDelivery {
  readonly sources: readonly SourceRef[]
  readonly complete: boolean
  readonly limitations: readonly string[]
}

/** Durable import delivery can be fitted without fabricating original turn objects after reopening. */
export interface MainHistoryImportedDelivery extends MainHistoryDelivery {
  readonly sourcedHistory: readonly RequestSourcedHistory[]
}

/** The caller measures the entire actual request, including wrappers, tools and current context. */
export interface MainHistoryCapacity {
  /** Shared request composition first asks each owner for its legal minimum before final metering. */
  readonly representation?: 'minimum'
  /** Return whether this exact sourced-history candidate fits the caller's actual prepared request. */
  fits(history: readonly RequestSourcedHistory[], delivery: MainHistoryDelivery): Promise<boolean>
}
