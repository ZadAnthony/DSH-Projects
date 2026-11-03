/*!
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
// Finite request vocabulary adapted from the previously verified Projects 41.3 request planner; plugin-owned, not native augmentation.
import type { ContentBlock, ContextFormed, ContextSnapshotSection, MessageId, MessageSource, RequestMessage, ToolHistory, ToolUpdate, UserMessage, SystemMessage } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { EpochHeader, SessionEvent, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
/** Request-local policy; absence preserves the original compaction policy. */
export type RequestInputPolicy = 'identified-only'
/** Stable identity of one native current-context supply. */
export interface RequestCurrentBlockKey { readonly producer: string; readonly key: string }
declare module '@deepseek-ai/dsh-llm' {
  interface UserMessage { readonly currentBlock?: RequestCurrentBlockKey }
  interface MessageSourceMap { 'runtime-context': { kind: 'runtime-context' } & ContextFormed }
}
/** Current value; null is an owner-confirmed absence, never a read failure. */
export interface RequestCurrentBlock extends RequestCurrentBlockKey {
  readonly value: null | { readonly content: readonly ContentBlock[]; readonly source: MessageSource }
}
/** One read-only external history message; it never enters the native Inbox or surface. */
export interface RequestSourcedHistory {
  readonly message: Extract<RequestMessage, { readonly role: 'user' | 'assistant' | 'tool' }>
  readonly source: JsonValue
  readonly use: 'historical-evidence'
}
/** Durable prepared history survives exit before the first request. */
export interface RequestHistoryImport {
  readonly owner: string
  readonly attemptId: string
  readonly history: readonly RequestSourcedHistory[]
}
/** One input and its committed or prospective surface position during a pending preview. */
export interface RequestCandidateMessage {
  readonly message: RequestMessage
  readonly origin: { readonly kind: 'event'; readonly seq: SessionSeq; readonly surfaceIndex: number } | { readonly kind: 'literal'; readonly history?: { readonly source: JsonValue; readonly use: 'historical-evidence' } }
}
/** Exact structured body occurrence; selectors belong to its producer. */
export interface RequestOccurrenceRef { readonly messageId: MessageId; readonly selector: readonly (string | number)[] }
/** The complete identity permitting byte-identical body comparison. */
export interface RequestBodyIdentity { readonly source: JsonValue; readonly version: JsonValue; readonly range: JsonValue; readonly use: 'current-read' | 'historical-evidence' }
/** Body obtained from a complete, currently legal structured object. */
export interface RequestBodyOccurrence extends RequestOccurrenceRef { readonly seq: SessionSeq; readonly identity: RequestBodyIdentity; readonly body: string }
/** One omission valid only for this dispatch; subsequent requests must revalidate it. */
export interface RequestOmissionRelation { readonly omitted: RequestOccurrenceRef; readonly keeper: RequestOccurrenceRef; readonly identity: RequestBodyIdentity }
/** Content-only projection preserving source, role, identity and tool pairing. */
export interface RequestContentProjection { readonly messageId: MessageId; readonly content: readonly ContentBlock[] }
/** Producer-owned currentness and structured rendering, operating on frozen reads. */
export interface RequestHistoryProjection {
  /**
   * Apply frozen owner currentness to the selected legal messages before omission.
   * @param history - ordered current inputs before body omission.
   * @returns exact content changes, supplemental exclusions and provable complete occurrences.
   */
  projectCurrentness(history: readonly RequestCandidateMessage[]): {
    readonly overrides?: readonly RequestContentProjection[]
    readonly excludeMessageIds?: readonly MessageId[]
    readonly occurrences?: readonly RequestBodyOccurrence[]
    readonly contextSections?: readonly { readonly messageId: MessageId; readonly sections: readonly ContextSnapshotSection[] }[]
  }
  /**
   * Render only the named complete duplicate bodies, retaining their surrounding evidence.
   * @param history - inputs after currentness has been applied.
   * @param omitted - complete occurrences whose matching keeper is in this same input.
   * @returns content-only changes; original conversation roles and identities remain intact.
   */
  renderOmissions(history: readonly RequestCandidateMessage[], omitted: readonly RequestBodyOccurrence[]): readonly RequestContentProjection[]
}
/** Exact request ownership; retries have distinct one-based attempts. */
export type RequestDispatchOwner =
  | { readonly purpose: 'conversation'; readonly turn: number; readonly step: number; readonly attempt: number }
  | { readonly purpose: 'compaction'; readonly compactionId: Branded<'CompactionId'>; readonly attempt: number }
/** Input record interpreted under the dispatch's own preceding log prefix. */
export type RequestInputRecord =
  | { readonly kind: 'event'; readonly seq: SessionSeq; readonly content?: readonly ContentBlock[]; readonly currentnessContent?: readonly ContentBlock[] }
  | { readonly kind: 'literal'; readonly message: RequestMessage; readonly history?: { readonly source: JsonValue; readonly use: 'historical-evidence' } }
/** Routed envelope and whether historical declaration updates are actually used. */
export type RequestDispatchEnvelope =
  | { readonly kind: 'header'; readonly headerSeq: SessionSeq; readonly toolHistory: 'prefix' | 'current' }
  | { readonly kind: 'inline'; readonly header: EpochHeader; readonly toolHistory: 'prefix' | 'current' }
/** Mapping retains every raw surface position; literals have no replacement target. */
export interface RequestSurfaceMapping { readonly seq: SessionSeq; readonly surfaceIndex: number; readonly inputIndexes: readonly number[] }
/** A current block that actually occurs in the recorded input. */
export interface RequestDispatchedCurrentBlock extends RequestCurrentBlockKey { readonly inputIndex: number }
/** Required ordinary event; it does not change surface grammar or provider acceptance. */
export type RequestDispatchData = RequestDispatchOwner & {
  readonly envelope: RequestDispatchEnvelope
  readonly toolUpdate?: ToolUpdate
  readonly messages: readonly RequestInputRecord[]
  readonly currentBlocks: readonly RequestDispatchedCurrentBlock[]
  readonly omissions: readonly RequestOmissionRelation[]
  readonly surface: readonly RequestSurfaceMapping[]
  readonly inputPolicy?: RequestInputPolicy
}
export type RequestPendingEvent = {
  [K in 'system/message' | 'user/message' | 'request/header' | 'developer/message']: Omit<SessionEvent<K>, 'seq' | 'time'>
}['system/message' | 'user/message' | 'request/header' | 'developer/message']
export interface RequestDispatchPlanInput {
  readonly owner: RequestDispatchOwner
  readonly header: EpochHeader
  readonly headerSeq?: SessionSeq
/** Exact pending native admission; a plan carrying this field cannot be admitted. */
  readonly pending?: readonly RequestPendingEvent[]
  readonly toolHistory?: 'prefix' | 'current'
  readonly toolUpdate?: ToolUpdate
  readonly historySeqs?: readonly SessionSeq[]
  readonly sourcedHistory?: readonly RequestSourcedHistory[]
  readonly system?: SystemMessage
  readonly suffix?: readonly RequestMessage[]
  readonly currentBlocks?: readonly RequestCurrentBlock[]
  readonly historyProjection?: RequestHistoryProjection
  /** Final content-only changes chosen from this complete request. */
  readonly contentProjection?: readonly RequestContentProjection[]
  readonly inputPolicy?: RequestInputPolicy
  readonly allowNewOmissions?: 'front-change' | 'pressure'
}
/** Read-only candidate, including prospective current appends but no durable changes. */
export interface RequestDispatchCandidate {
  readonly baseRevision: SessionLogOffset
  readonly owner: RequestDispatchOwner
  readonly envelope: EpochHeader
  readonly toolHistory?: ToolHistory
  readonly toolUpdate?: ToolUpdate
  readonly messages: readonly RequestCandidateMessage[]
  readonly currentBlocks: readonly RequestDispatchedCurrentBlock[]
  readonly omissions: readonly RequestOmissionRelation[]
  readonly surface: readonly RequestSurfaceMapping[]
  readonly inputPolicy?: RequestInputPolicy
}
/** Candidate plus its exclusively owned, still-uncommitted current message appends. */
export interface RequestDispatchPlan extends RequestDispatchCandidate {
  /** Pending native events were evaluated; callers must commit them and plan again before dispatch. */
  readonly previewOnly?: true
  readonly appends: readonly { readonly inputIndex: number; readonly message: UserMessage }[]
  readonly records: readonly RequestInputRecord[]
  readonly dispatchEnvelope: RequestDispatchEnvelope
}
