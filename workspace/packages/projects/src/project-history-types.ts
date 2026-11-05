/** Browser-safe history requests, results and membership facts. */
import type { NativeEventSource, NativeProjectSource, NativeProjectSourceItem, NativeProjectSpeaker } from './source-types.ts'
import type { CommunicationSavedPartSource } from './communication/types.ts'

export type ProjectHistoryStatus = "ok" | "partial" | "unavailable";
export type ProjectHistorySpeaker = NativeProjectSpeaker;
/** Shared UI copy also defines the conservative width of an unnamed summary link. */
export const PROJECT_HISTORY_SESSION_LINK_COPY = ['会话链接', 'Session link'] as const;
export const PROJECT_HISTORY_PARTIAL_PREVIEW_COPY = ['回复片段，打开原文查看', 'Reply fragment. Open the original to read.'] as const;
/** Presentation parts; an unlabeled canonical link is localized by the UI, never resolved by title. */
export type ProjectHistoryDisplaySummary = readonly (string | { readonly kind: 'session-link' | 'partial-preview' })[];

/** Current Project ownership facts supplied by the core runtime. */
export interface ProjectHistoryMembership {
  readonly id: string;
  readonly hostSessionId: string;
  readonly role: string;
  readonly title: string;
  readonly carrierIndex?: number;
  readonly carrierSequence?: number;
  readonly sessionCreatedAt?: number;
}

/** The core owns the membership lookup; this reader never infers membership from a native log. */
export type ProjectHistoryMembershipResolver = (
  projectId: string,
) => Promise<readonly ProjectHistoryMembership[]>;

/** A bounded, literal native-history query. Times are normalized epoch milliseconds by the caller. */
export interface ProjectHistorySearchRequest {
  /** Project session record IDs, not arbitrary native Session IDs. Omission selects the current Project membership. */
  readonly sessionIds?: readonly string[];
  readonly hostSessionIds?: readonly string[];
  /** Inclusive lower time bound in epoch milliseconds. */
  readonly fromTime?: number;
  /** Inclusive upper time bound in epoch milliseconds. */
  readonly toTime?: number;
  readonly speaker?: ProjectHistorySpeaker;
  readonly producer?: string;
  readonly recordKinds?: readonly string[];
  /** Native event append/record time. It is not an unknown producer occurrence time. */
  readonly timeField?: 'recorded';
  /** Literal case-insensitive text match; this reader does not use an index, model, or semantic search. */
  readonly keyword?: string;
  readonly limit?: number;
  /** Opaque continuation from an earlier page of the same fixed query. */
  readonly cursor?: string;
}

/** Exact native source lookup plus a bounded visible-message context window. */
export interface ProjectHistoryReadRequest {
  readonly source: NativeProjectSource | CommunicationSavedPartSource;
  readonly before?: number;
  readonly after?: number;
}

/** A message candidate retains one real matching event; the group's other versions stay independently readable. */
export interface ProjectHistorySearchItem extends NativeProjectSourceItem {
  readonly session: ProjectHistoryMembership;
  /** Bounded UI-only projection; never original text or a source/match coordinate space. */
  readonly displaySummary?: ProjectHistoryDisplaySummary;
  readonly excerpt?: { readonly unit: 'unicode-code-points'; readonly start: number; readonly end: number; readonly total: number };
  readonly match?: { readonly method: 'literal-case-insensitive'; readonly field: 'text'; readonly start: number; readonly end: number };
  readonly messageGroup?: {
    readonly hostSessionId: string;
    readonly messageId: string;
    readonly versionCount: number;
    readonly latestRecordedTime: number;
    readonly latestSource: NativeEventSource;
    readonly latestRecordPhase?: string;
    readonly representativeIsLatest: boolean;
    /** Same-cut event list, continued with search; never a durable source or a body cursor. */
    readonly versionsCursor: string;
  };
  /** Only the expanded version list: whether this exact event satisfies the parent search. */
  readonly matchesSearch?: boolean;
}

export interface ProjectHistoryUnavailableSource {
  readonly hostSessionId: string;
  readonly kind: "deleting" | "partial" | "deleted";
  readonly sourceRevision: number;
}

export interface ProjectHistorySearchResult {
  readonly unavailableSources?: readonly ProjectHistoryUnavailableSource[];
  readonly status: ProjectHistoryStatus;
  readonly items: readonly ProjectHistorySearchItem[];
  readonly limitations: readonly string[];
  readonly nextCursor?: string;
  readonly timeField?: 'recorded';
  readonly matching?: 'literal-case-insensitive';
  readonly code?: string;
  readonly view?: 'messages' | 'message-versions' | 'events';
}

export interface ProjectHistoryReadResult {
  readonly status: ProjectHistoryStatus;
  /** False is an honest exact-source miss; it never falls back to a summary or restarts a scan. */
  readonly found: boolean;
  readonly items: readonly NativeProjectSourceItem[];
  readonly limitations: readonly string[];
  readonly reason?: string;
  readonly code?: string;
  readonly coverage?: readonly { readonly sessionId: string; readonly hostSessionId: string; readonly firstSeq?: number; readonly lastSeq?: number }[];
}

