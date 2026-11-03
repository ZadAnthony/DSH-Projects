/** Browser-safe native source DTOs; no host reader or persistence implementation. */
import type { ScheduleManager } from './features/schedule/contract.ts'
import type { CommunicationSavedPartSource, CommunicationVisibleBlock, CommunicationVisibleRead } from './communication/types.ts'
import type { CommunicationContentDirectory } from './communication/content-types.ts'

/** A stored Project source whose original DSH event can be reopened without resuming its Agent. */
export type { NativeProjectSource, NativeEventSource, LegacyNativeProjectSource, NativeBodySelection } from './source-reference-types.ts'
import type { NativeProjectSource, NativeEventSource } from './source-reference-types.ts'

/** The actor shown for one visible native event. It deliberately does not promote an unknown source to a human user. */
export type NativeProjectSpeaker = "user" | "assistant" | "project-delivery" | "system" | "tool" | "unknown";

/** A safe, displayable attachment reference retained from a known native content block. */
export interface NativeProjectAttachment {
  readonly kind: "file" | "image";
  readonly attachmentId: string;
  readonly name?: string;
  readonly bytes?: number;
  readonly mediaType?: string;
}

/**
 * Safe producer facts for one visible native message. The reader intentionally
 * retains only project-delivery attribution fields instead of serializing an
 * arbitrary source object into the chat projection.
 */
export interface NativeProjectMessageSource {
  readonly kind: string;
  readonly projectId?: string;
  readonly deliveryId?: string;
  readonly senderSessionId?: string;
  readonly targetSessionId?: string;
  readonly intent?: string;
  readonly sessionId?: string;
  readonly scheduleId?: string;
  readonly occurrenceId?: string;
  readonly plannedAt?: string;
  readonly definitionRevision?: number;
  readonly trigger?: 'automatic' | 'manual';
  readonly requestId?: string;
  readonly requestedAt?: string;
  readonly requestedBy?: ScheduleManager;
  readonly acceptedRevision?: number;
  readonly goalId?: string;
  readonly revision?: number;
  readonly round?: number;
  readonly hostSessionId?: string;
  readonly run?: { readonly turn: number; readonly startSeq: number; readonly endSeq: number };
  readonly inputs?: readonly NativeProjectFailureInput[];
  readonly failedAt?: number;
  readonly reason?: { readonly code: string; readonly message: string };
  readonly sessionEntry?: { readonly kind: 'execution'; readonly sessionId: string; readonly hostSessionId: string };
  readonly sideEffects?: 'unknown';
}

/** 失败通知只公开原输入定位和已知身份，不投影任意source正文。 */
export interface NativeProjectFailureInput {
  readonly producer: 'user' | 'project-delivery' | 'goal';
  readonly source: Extract<NativeProjectSource, { kind: 'message' }>;
  readonly deliveryId?: string;
  readonly senderSessionId?: string;
  readonly targetSessionId?: string;
  readonly goalId?: string;
  readonly revision?: number;
  readonly round?: number;
}

/** One actual visible message or tool event shown around the requested source. */
export interface NativeProjectSourceItem {
  /** Whether this item is the requested source rather than nearby context. */
  readonly isTarget: boolean;
  readonly seq: number;
  readonly time: number;
  readonly kind: string;
  readonly role: "user" | "assistant" | "tool" | "system";
  readonly text: string;
  /** Ordered native visible data, before the compatibility text/attachment summary. */
  readonly visibleBlocks?: readonly CommunicationVisibleBlock[];
  readonly visibleComplete?: boolean;
  readonly hiddenExcluded?: CommunicationVisibleRead['hiddenExcluded'];
  readonly missingVisible?: CommunicationVisibleRead['missingVisible'];
  /** Producer identity retained from the actual message, such as `user` or `project-delivery`. */
  readonly sourceKind?: string;
  /** The same native locator the caller can pass to a precise Project source read. */
  readonly nativeSource?: NativeProjectSource;
  /** Stable body source. Its cursor is returned separately by read_content. */
  readonly bodySource?: NativeEventSource;
  readonly bodyRange?: { readonly unit: 'unicode-code-points'; readonly start: number; readonly end: number; readonly total: number };
  /** Finite navigation links: adjacent message/attempt versions or the same exact tool occurrence, not all group members. */
  readonly relatedSources?: readonly NativeEventSource[];
  readonly recordPhase?: string;
  readonly attemptId?: string;
  readonly savedPartSource?: CommunicationSavedPartSource;
  /** Exact references derived from this holder's saved communication, never reconstructed by the model. */
  readonly communicationParts?: readonly CommunicationSavedPartSource[];
  readonly communicationContent?: CommunicationContentDirectory;
  /** Durable message identity when this entry is a native message, including a tool result. */
  readonly messageId?: string;
  /** Durable tool-call identity when this entry is a tool call or its result. */
  readonly toolCallId?: string;
  /** Human, assistant, project relay, tool, or an explicitly unclassified visible producer. */
  readonly speaker?: NativeProjectSpeaker;
  /** Safe source attribution. Project relays retain their actual sender, project, and intent. */
  readonly source?: NativeProjectMessageSource;
  /** Known attachment entries; opaque/unknown blocks are never serialized here. */
  readonly attachments?: readonly NativeProjectAttachment[];
  /** Some native content existed but cannot be safely shown in this projection. */
  readonly partial?: true;
  /** Honest, user-displayable reasons for omitted native content. */
  readonly limitations?: readonly string[];
}

/** The bounded, source-faithful result of one Project source read. */
export interface NativeProjectSourceRead {
  readonly resolved: boolean;
  readonly hostSessionId: string;
  readonly items: readonly NativeProjectSourceItem[];
  readonly reason?: string;
  /** True when visible context is present but one or more blocks were deliberately omitted. */
  readonly partial?: true;
  readonly limitations?: readonly string[];
  readonly code?: 'not-found' | 'deleted' | 'unreadable' | 'invalid-source' | 'stale-source' | 'ambiguous-source';
}

/** Optional bounded visible-message context around the exact source. */
export interface NativeProjectSourceReadOptions {
  /** Number of visible entries immediately before the target range. Defaults to one. */
  readonly before?: number | undefined;
  /** Number of visible entries immediately after the target range. Defaults to one. */
  readonly after?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Projects target admission cut; source disposition remains Store-owned. */
  readonly assertAdmitting?: ((hostSessionId: string) => void) | undefined;
  readonly identity?: { readonly projectId: string; readonly sessionId: string };
  /** Internal body pager only; ordinary source reads retain a bounded excerpt and stable body reference. */
  readonly fullBody?: boolean;
}

