import type { Context } from "@deepseek-ai/cordis";
import { BlockAssembler, expandAssistantStream, type AssistantStreamRecord } from "@deepseek-ai/dsh-llm";
import { decodeNativeProjectSource } from "./native-source.ts";
import { mintNativeProjectSource, nativeSourceDigest } from "./native-source-host.ts";
import type { NativeEventSource } from "./source-reference-types.ts";
import { SessionId } from "@deepseek-ai/dsh-session";
import { isAppendSurfaceEvent } from "@deepseek-ai/dsh-session/surface";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';
import type { ProjectDirectoryObservation } from './stock/read/index.ts';
import { decodeProjectRecord, projectRecordSemanticType, type DecodedProjectRecord } from './stock/recording/records.ts';
import type { ProjectRawPayloadReader } from './stock/recording/records.ts';
import type { ProjectRecordLocator } from './stock/persistence/types.ts';
import { isProjectVisibleLocator, projectQuerySkeleton } from './query-directory.ts';

import type { ProjectSessionSource, ProjectSessionSourceLifecycle } from "./records-types.ts";
import { managerSchema, utcTimeSchema } from './features/schedule/validation.ts'
import { communicationVisibleText, projectCommunicationVisibleBlocks } from './communication/visible-reader.ts'
import { canonicalJson, jsonFrozen, operationReference, snapshotCodec, validateInvocation } from './communication/contract.ts'
import { buildCommunicationContentDirectory } from './communication/content.ts'
import type { CommunicationRecordLocator, CommunicationSnapshotV1 } from './communication/types.ts'
import type { CommunicationVisibleBlock, CommunicationVisibleRead } from './communication/types.ts'
import { isMainBusinessInput } from './continuity/business-input.ts'
import { canonicalCodePointLength, sliceCodePoints } from './canonical-chunks.ts'
import { AsyncLocalStorage } from 'node:async_hooks'

export type * from './source-types.ts'
import type { NativeProjectSource, NativeProjectSpeaker, NativeProjectAttachment, NativeProjectMessageSource, NativeProjectFailureInput, NativeProjectSourceItem, NativeProjectSourceRead, NativeProjectSourceReadOptions } from './source-types.ts'

/** One visible event plus its stable log position, shared by exact reads and Project history queries. */
export interface NativeProjectVisibleEvent {
  readonly eventIndex: number;
  readonly item: NativeProjectSourceItem;
}

interface ReadableEvent extends NativeProjectVisibleEvent {
  readonly messageId?: string;
  readonly toolCallId?: string;
}

interface EventEnvelope {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: unknown;
}

interface ContentProjection {
  readonly text: string;
  readonly attachments: readonly NativeProjectAttachment[];
  readonly limitations: readonly string[];
  readonly blocks: readonly CommunicationVisibleBlock[];
  readonly hiddenExcluded: CommunicationVisibleRead['hiddenExcluded'];
  readonly missingVisible: CommunicationVisibleRead['missingVisible'];
}

interface NativeProjectionPreparation {
  // recordLocator preserves every field used here. PTC records and the two
  // assistant settlement target types are unchanged by raw-record decoding.
  readonly settlements: ReadonlyMap<string, string>;
  readonly ptcStarts: ReadonlyMap<number, number>;
}


/**
 * Projects one native event prefix into displayable messages and tools.
 *
 * This is deliberately the single projection consumed by exact source reads
 * and bounded Project history. It excludes model-only context, system and
 * developer instructions, reasoning, and unknown raw blocks.
 */
/** Lightweight locators only: text/blocks are intentionally absent until selection. */
export function scanNativeProjectVisibleEvents(hostSessionId: string, events: readonly SessionEvent[], signal?: AbortSignal, preparation?: NativeProjectionPreparation): readonly NativeProjectVisibleEvent[] {
  return [...iterateNativeEntries(hostSessionId, events, signal, true, undefined, preparation)];
}

/** Stream one visible body at a time, without hashing or materializing unrelated body metadata. */
export function* iterateNativeProjectVisibleEvents(hostSessionId: string, events: readonly SessionEvent[], signal?: AbortSignal): Generator<NativeProjectVisibleEvent> {
  yield* iterateNativeEntries(hostSessionId, events, signal, false);
}

/** Render only selected locators; relations retain their exact finite neighbouring sources. */
export function selectNativeProjectVisibleEvents(hostSessionId: string, events: readonly SessionEvent[], select: (entry: NativeProjectVisibleEvent) => boolean,
  signal?: AbortSignal, sessionCreatedAt?: number,
  identity?: { readonly projectId: string; readonly sessionId: string; readonly formatVersion: number }, canonicalEvents?: ReadonlyMap<number, SessionEvent>, canonicalLocators?: ReadonlyMap<number, ProjectRecordLocator>, preparation?: NativeProjectionPreparation): readonly NativeProjectVisibleEvent[] {
  return [...iterateSelectedNativeProjectVisibleEvents(hostSessionId, events, select, signal, sessionCreatedAt, identity, canonicalEvents, canonicalLocators, preparation)];
}

/** Streaming selection also lets bounded legacy multi-target reads release each original body immediately. */
export function* iterateSelectedNativeProjectVisibleEvents(hostSessionId: string, events: readonly SessionEvent[], select: (entry: NativeProjectVisibleEvent) => boolean,
  signal?: AbortSignal, sessionCreatedAt?: number,
  identity?: { readonly projectId: string; readonly sessionId: string; readonly formatVersion: number }, canonicalEvents?: ReadonlyMap<number, SessionEvent>, canonicalLocators?: ReadonlyMap<number, ProjectRecordLocator>, preparation?: NativeProjectionPreparation): Generator<NativeProjectVisibleEvent> {
  const metadata = scanNativeProjectVisibleEvents(hostSessionId, events, signal, preparation);
  const selected = new Set(metadata.filter(select).map(entry => entryKey(entry as ReadableEvent)));
  if (selected.size === 0) return;
  const locators = nativeRelationLocators(metadata, hostSessionId, events, sessionCreatedAt, identity);
  const relations = nativeSourceRelations(locators, events, signal, sessionCreatedAt, identity, preparation?.ptcStarts);
  const mint = (source: NativeRelationSource): NativeEventSource => mintProjectedSource({ ...identity!, hostSessionId, sessionCreatedAt: sessionCreatedAt! }, events[source.eventSeq]!, canonicalEvents, canonicalLocators, {
    ...(source.messageId === undefined ? {} : { messageId: source.messageId }), ...(source.toolCallId === undefined ? {} : { toolCallId: source.toolCallId }) });
  for (const entry of iterateSelectedNativeProjectBodyEvents(hostSessionId, events, selected, signal, sessionCreatedAt, identity, canonicalEvents, canonicalLocators, preparation)) {
    const source = entry.item.nativeSource;
    if (source?.kind !== 'native-event') { yield entry; continue; }
    const related = relations.get(relationKey(source));
    yield related === undefined ? entry : { ...entry, item: { ...entry.item, relatedSources: related.map(mint) } };
  }
}

/** Selected visible bodies and canonical source metadata, shared before navigation is attached. */
function* iterateSelectedNativeProjectBodyEvents(hostSessionId: string, events: readonly SessionEvent[], selected: ReadonlySet<string>,
  signal?: AbortSignal, sessionCreatedAt?: number,
  identity?: { readonly projectId: string; readonly sessionId: string; readonly formatVersion: number }, canonicalEvents?: ReadonlyMap<number, SessionEvent>, canonicalLocators?: ReadonlyMap<number, ProjectRecordLocator>, preparation?: NativeProjectionPreparation): Generator<NativeProjectVisibleEvent> {
  for (const entry of iterateNativeEntries(hostSessionId, events, signal, false, selected, preparation)) {
    yield withNativeProjectBodySource(entry, hostSessionId, events, sessionCreatedAt, identity, canonicalEvents, canonicalLocators);
  }
}

function withNativeProjectBodySource(entry: NativeProjectVisibleEvent, hostSessionId: string, events: readonly SessionEvent[], sessionCreatedAt?: number,
  identity?: { readonly projectId: string; readonly sessionId: string; readonly formatVersion: number }, canonicalEvents?: ReadonlyMap<number, SessionEvent>, canonicalLocators?: ReadonlyMap<number, ProjectRecordLocator>, communicationRecords?: Iterable<SessionEvent>): NativeProjectVisibleEvent {
  const saved = sessionCreatedAt === undefined ? entry : withSavedCommunicationEntries(entry, hostSessionId, sessionCreatedAt, events, communicationRecords);
  if (identity === undefined || sessionCreatedAt === undefined) return saved;
  const nativeSource = mintProjectedSource({ ...identity, hostSessionId, sessionCreatedAt }, events[entry.eventIndex]!, canonicalEvents, canonicalLocators, {
    ...(saved.item.messageId === undefined ? {} : { messageId: saved.item.messageId }), ...(saved.item.toolCallId === undefined ? {} : { toolCallId: saved.item.toolCallId }) });
  const value = saved.item.visibleBlocks ?? [], total = canonicalCodePointLength(value);
  return { ...saved, item: { ...saved.item, nativeSource,
    bodySource: { ...nativeSource, body: { stream: 'visible-blocks', codec: 'canonical-json/v1', digest: nativeSourceDigest(value) } },
    bodyRange: { unit: 'unicode-code-points', start: 0, end: total, total } } };
}

/** A query skeleton supplies shape only; source identity always comes from a canonical record or owner directory. */
function mintProjectedSource(identity: { readonly projectId: string; readonly sessionId: string; readonly hostSessionId: string; readonly sessionCreatedAt: number; readonly formatVersion: number },
  event: SessionEvent, canonicalEvents?: ReadonlyMap<number, SessionEvent>, canonicalLocators?: ReadonlyMap<number, ProjectRecordLocator>,
  subject: { readonly messageId?: string; readonly toolCallId?: string } = {}): NativeEventSource {
  const canonical = canonicalEvents?.get(Number(event.seq));
  if (canonical !== undefined) return mintNativeProjectSource(identity, canonical, canonical, subject);
  const locator = canonicalLocators?.get(Number(event.seq));
  if (locator !== undefined) return decodeNativeProjectSource({ kind: 'native-event', version: 1, projectId: identity.projectId, sessionId: identity.sessionId,
    hostSessionId: identity.hostSessionId, sessionCreatedAt: identity.sessionCreatedAt, eventSpace: { kind: 'canonical', formatVersion: identity.formatVersion },
    eventSeq: locator.seq, eventType: locator.type, eventDigest: locator.eventDigest, ...subject }) as NativeEventSource;
  if (canonicalEvents !== undefined || canonicalLocators !== undefined) throw new Error('PROJECT_QUERY_CANONICAL_RECORD_UNAVAILABLE');
  return mintNativeProjectSource(identity, event, event, subject);
}

type NativeRelationSource = Pick<NativeEventSource, 'kind' | 'hostSessionId' | 'eventSeq' | 'eventType' | 'messageId' | 'toolCallId'>;
interface NativeRelationEntry { readonly eventIndex: number; readonly item: Pick<NativeProjectSourceItem, 'messageId' | 'toolCallId' | 'attemptId'> & { readonly nativeSource?: NativeRelationSource } }

function nativeRelationLocators(metadata: readonly NativeProjectVisibleEvent[], hostSessionId: string, events: readonly SessionEvent[], sessionCreatedAt?: number,
  identity?: { readonly projectId: string; readonly sessionId: string; readonly formatVersion: number }): readonly NativeRelationEntry[] {
  if (identity === undefined || sessionCreatedAt === undefined) return [];
  return metadata.map(entry => { const event = events[entry.eventIndex]!; return { eventIndex: entry.eventIndex, item: { ...(entry.item.messageId === undefined ? {} : { messageId: entry.item.messageId }), ...(entry.item.toolCallId === undefined ? {} : { toolCallId: entry.item.toolCallId }), ...(entry.item.attemptId === undefined ? {} : { attemptId: entry.item.attemptId }), nativeSource: {
    kind: 'native-event' as const, hostSessionId, eventSeq: event.seq, eventType: event.type,
    ...(entry.item.messageId === undefined ? {} : { messageId: entry.item.messageId }), ...(entry.item.toolCallId === undefined ? {} : { toolCallId: entry.item.toolCallId }) } } }; });
}

export function projectVisibleNativeEvents(hostSessionId: string, events: readonly SessionEvent[], signal?: AbortSignal, sessionCreatedAt?: number,
  identity?: { readonly projectId: string; readonly sessionId: string; readonly formatVersion: number }): readonly NativeProjectVisibleEvent[] {
  return selectNativeProjectVisibleEvents(hostSessionId, events, () => true, signal, sessionCreatedAt, identity);
}

function* iterateNativeEntries(hostSessionId: string, events: readonly SessionEvent[], signal: AbortSignal | undefined, metadataOnly: boolean,
  selected?: ReadonlySet<string>, preparation?: NativeProjectionPreparation): Generator<ReadableEvent> {
  const localSettlements = preparation === undefined ? new Map<string, string>() : undefined;
  const settlements = preparation?.settlements ?? localSettlements!;
  const lastProgress = new Map<string, number>();
  for (const [eventIndex, event] of events.entries()) {
    if (event === undefined) continue;
    signal?.throwIfAborted();
    const envelope: EventEnvelope = event, data = record(envelope.data);
    if (envelope.type === 'assistant/progress' || envelope.type === 'projects/assistant-progress') lastProgress.set(typeof data?.attemptId === 'string' ? `${envelope.type}:${data.attemptId}` : `event:${eventIndex}`, eventIndex);
    if (localSettlements !== undefined && envelope.type === 'projects/assistant-settlement' && typeof data?.eventSeq === 'number' && typeof data.eventType === 'string' && typeof data.attemptId === 'string') {
      const key = `${data.eventType}:${data.eventSeq}`; if (!localSettlements.has(key)) localSettlements.set(key, data.attemptId);
    }
  }
  const inboxState: Record<string, unknown[]> = { 'next-turn': [], 'next-step': [] };
  const progresses = new Map<string, ProgressProjection>();
  const renderProgress = selected === undefined ? undefined : new Set([...selected].map(key => {
    const eventIndex = Number(key.slice(0, key.indexOf(':'))), event = events[eventIndex];
    const envelope: EventEnvelope | undefined = event, data = record(envelope?.data);
    return (envelope?.type === 'assistant/progress' || envelope?.type === 'projects/assistant-progress') && typeof data?.attemptId === 'string' ? `${envelope.type}:${data.attemptId}` : `event:${eventIndex}`;
  }));
  const renderThrough = new Map<string, number>();
  if (selected !== undefined) for (const locator of selected) {
    const eventIndex = Number(locator.slice(0, locator.indexOf(':'))), event = events[eventIndex], data = record(event?.data);
    const type = String(event?.type);
    if ((type === 'assistant/progress' || type === 'projects/assistant-progress') && typeof data?.attemptId === 'string') {
      const key = `${type}:${data.attemptId}`;
      renderThrough.set(key, Math.max(eventIndex, renderThrough.get(key) ?? -1));
    }
  }
  const wanted = (entry: ReadableEvent) => selected === undefined || selected.has(entryKey(entry));
  for (const [eventIndex, event] of events.entries()) {
    if (event === undefined) continue;
    signal?.throwIfAborted();
    const meta = readableEvent(hostSessionId, event, eventIndex, true);
    if (meta !== undefined && wanted(meta)) {
      let entry = metadataOnly ? meta : readableEvent(hostSessionId, event, eventIndex)!;
      const attemptId = settlements.get(`${event.type}:${event.seq}`);
      if (event.type === 'assistant/message' && attemptId !== undefined) entry = { ...entry, item: { ...entry.item, attemptId } };
      yield entry;
    }
    if (event.type === 'agent/inbox/spliced') {
      const data = record(event.data);
      for (const message of Array.isArray(data?.inserted) ? data.inserted : []) {
        const item = itemFromMessage(hostSessionId, event, message, event.type, true);
        if (item === undefined) continue;
        const candidate = { eventIndex, ...(item.messageId === undefined ? {} : { messageId: item.messageId }), item: { ...item, recordPhase: Number(data?.removedCount ?? 0) > 0 ? 'edited' : 'accepted' } };
        if (wanted(candidate)) yield metadataOnly ? candidate : { ...candidate, item: { ...itemFromMessage(hostSessionId, event, message, event.type)!, recordPhase: candidate.item.recordPhase } };
      }
      const target = typeof data?.target === 'string' ? data.target : '', state = inboxState[target];
      if (state !== undefined && typeof data?.start === 'number') {
        const inserted = Array.isArray(data.inserted) ? data.inserted : [];
        const removed = state.splice(data.start, Number(data.removedCount ?? 0), ...inserted);
        if (inserted.length === 0) for (const message of removed) {
          const id = messageIdOf(message);
          if (id === undefined || itemFromMessage(hostSessionId, event, message, event.type, true) === undefined) continue;
          const recordPhase = data.outcome === 'canceled' ? 'canceled' : 'claimed';
          const text = canonicalJson({ target, messageId: id, operation: recordPhase });
          const candidate: ReadableEvent = { eventIndex, messageId: id, item: { isTarget: false, seq: event.seq, time: event.time, kind: event.type, role: 'system', speaker: 'system', sourceKind: 'inbox', source: { kind: 'inbox' }, messageId: id, text: metadataOnly ? '' : text, ...(metadataOnly ? {} : { visibleBlocks: [{type:'text' as const,text}], visibleComplete:true }), recordPhase } };
          if (wanted(candidate)) yield candidate;
        }
      }
    }
    const extra = recordedOperationItem(hostSessionId, event, eventIndex, progresses, metadataOnly, selected, renderProgress);
    const type = String(event.type);
    if (type === 'assistant/progress' || type === 'projects/assistant-progress') {
      const data = record(event.data), key = typeof data?.attemptId === 'string' ? `${type}:${data.attemptId}` : `event:${eventIndex}`;
      if (renderThrough.size > 0 && renderThrough.get(key) === eventIndex) {
        const state = progresses.get(key);
        if (state !== undefined) state.assembler = undefined;
      }
      if (lastProgress.get(key) === eventIndex) progresses.delete(key);
    }
    if (extra !== undefined && wanted(extra)) {
      const attemptId = settlements.get(`${event.type}:${event.seq}`);
      yield event.type === 'assistant/attempt' && attemptId !== undefined ? { ...extra, item: { ...extra.item, attemptId } } : extra;
    }
  }
}

/**
 * Relations are navigation links, not a copied group membership table. Message
 * versions and attempts use their immediate neighbours (at most two per key).
 * A tool chain additionally points at its exact call occurrence, never merely
 * a reused callId. Proposal records participate without becoming chat entries.
 */
function nativeSourceRelations(entries: readonly NativeRelationEntry[], events: readonly SessionEvent[], signal?: AbortSignal,
  sessionCreatedAt?: number, identity?: { readonly projectId: string; readonly sessionId: string; readonly formatVersion: number }, ptcStarts = nativePtcResultStarts(events)): ReadonlyMap<string, readonly NativeRelationSource[]> {
  const messages = new Map<string, NativeRelationSource[]>(), attempts = new Map<string, NativeRelationSource[]>();
  const tools = new Map<number, NativeRelationSource[]>(), links = new Map<string, Map<string, NativeRelationSource>>();
  const append = <K,>(groups: Map<K, NativeRelationSource[]>, key: K, source: NativeRelationSource) => {
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [source]); else group.push(source);
  };
  const link = (source: NativeRelationSource, other: NativeRelationSource | undefined) => {
    if (other === undefined || source.eventSeq === other.eventSeq) return;
    const key = relationKey(source), target = relationKey(other);
    let related = links.get(key);
    if (related === undefined) { related = new Map(); links.set(key, related); }
    related.set(target, other);
  };
  const occurrence = (root: number, callId: string | undefined): boolean => {
    const start = events[root];
    if (start?.type !== 'tool/call' && start?.type !== 'tool/ptc-dispatch-start') return false;
    const data = record(start.data);
    return callId !== undefined && (start.type === 'tool/call' ? data?.callId : data?.subCallId) === callId;
  };
  for (const entry of entries) {
    signal?.throwIfAborted();
    const source = entry.item.nativeSource, event = events[entry.eventIndex];
    if (source?.kind !== 'native-event' || event === undefined) continue;
    const root = nativeCallStart(event, ptcStarts);
    if (root !== undefined) {
      if (occurrence(root, entry.item.toolCallId)) append(tools, root, source);
      continue;
    }
    if (entry.item.messageId !== undefined) append(messages, entry.item.messageId, source);
    if (entry.item.attemptId !== undefined) append(attempts, entry.item.attemptId, source);
  }
  if (identity !== undefined && sessionCreatedAt !== undefined) for (const proposal of events) {
    if (proposal === undefined) continue;
    signal?.throwIfAborted();
    const envelope: EventEnvelope = proposal, data = record(envelope.data);
    if (envelope.type !== 'projects/tool-proposal' || typeof data?.startEventSeq !== 'number' || typeof data.callId !== 'string'
      || !tools.has(data.startEventSeq) || !occurrence(data.startEventSeq, data.callId)) continue;
    const hostSessionId = tools.get(data.startEventSeq)![0]!.hostSessionId;
    append(tools, data.startEventSeq, { kind: 'native-event', hostSessionId, eventSeq: proposal.seq, eventType: proposal.type, toolCallId: data.callId });
  }
  const neighbours = (group: readonly NativeRelationSource[]) => {
    for (const [index, source] of group.entries()) { signal?.throwIfAborted(); link(source, group[index - 1]); link(source, group[index + 1]); }
  };
  for (const group of messages.values()) neighbours(group);
  for (const group of attempts.values()) neighbours(group);
  for (const [root, group] of tools) {
    group.sort((left, right) => left.eventSeq - right.eventSeq);
    neighbours(group);
    const call = group.find(source => source.eventSeq === root);
    for (const source of group) link(source, call);
    if (call !== undefined) link(call, group.find(source => source.eventType === 'projects/tool-proposal'));
  }
  return new Map([...links].map(([key, related]) => [key, [...related.values()]]));
}

function relationKey(source: NativeRelationSource): string {
  return JSON.stringify([source.eventSeq, source.messageId, source.toolCallId]);
}

/** A settled PTC subcall names its one still-open start, never all uses of a subCallId. */
function nativePtcResultStarts(events: readonly SessionEvent[]): ReadonlyMap<number, number> {
  const pending = new Map<string, { seq: number; remaining: number; ambiguous: boolean }>(), starts = new Map<number, number>();
  for (const event of events) {
    if (event === undefined || event.type !== 'tool/ptc-dispatch-start' && event.type !== 'tool/ptc-dispatch') continue;
    const data = record(event.data), keys = ['rootCallId', 'parentCallId', 'subCallId', 'name'] as const;
    if (keys.some(key => typeof data?.[key] !== 'string')) continue;
    const key = JSON.stringify(keys.map(key => data![key]));
    if (event.type === 'tool/ptc-dispatch-start') {
      const group = pending.get(key);
      if (group === undefined) pending.set(key, { seq: event.seq, remaining: 1, ambiguous: false });
      else { group.remaining++; group.ambiguous = true; }
    } else {
      const group = pending.get(key);
      if (group === undefined) continue;
      if (!group.ambiguous) starts.set(event.seq, group.seq);
      if (--group.remaining === 0) pending.delete(key);
    }
  }
  return starts;
}

function nativeCallStart(event: SessionEvent, ptcStarts?: ReadonlyMap<number, number>): number | undefined {
  const envelope: EventEnvelope = event, data = record(envelope.data);
  if (envelope.type === 'tool/call' || envelope.type === 'tool/ptc-dispatch-start') return event.seq;
  if (['tool/execution-start', 'tool/execution-return', 'projects/tool-execution-start', 'projects/tool-execution-return', 'projects/tool-execution-final'].includes(envelope.type)) return typeof data?.startEventSeq === 'number' ? data.startEventSeq : undefined;
  if (event.type === 'tool/result' && event.sourceEventSeqs?.length === 1) return event.sourceEventSeqs[0];
  if (event.type === 'tool/ptc-dispatch') return ptcStarts?.get(event.seq);
  return undefined;
}

/** Store-owned retained identity lookup shared by every Projects source consumer. */
export type ProjectSessionSourceReader = (hostSessionId: string, projectId?: string) => Promise<ProjectSessionSource | undefined>;

export type RetainedNativePrefix =
  | { readable: true; header: import('@deepseek-ai/dsh-session').SessionHeader; projectId: string; sessionId: string; formatVersion: number; hostSessionId: string; sourceRevision: number; canonicalEvents?: ReadonlyMap<number, SessionEvent>; canonicalLocators?: ReadonlyMap<number, ProjectRecordLocator>; selectedSeqs?: ReadonlySet<number>; projectionPreparation?: NativeProjectionPreparation; events: readonly SessionEvent[]; endSeq: number; source: 'live' | 'prepared'; sessionCreatedAt: number; inheritedEventCount: number }
  | { readable: false; hostSessionId: string; reason: string };

export type RetainedNativeDirectory =
  | ({ readonly readable: true; readonly header: import('@deepseek-ai/dsh-session').SessionHeader; readonly projectId: string; readonly sessionId: string;
      readonly formatVersion: number; readonly hostSessionId: string; readonly sourceRevision: number; readonly sessionCreatedAt: number;
      readonly inheritedEventCount: number; readonly endSeq: number;
      readonly readDecodedEvent: (seq: number) => Promise<DecodedProjectRecord | undefined> } & ProjectDirectoryObservation)
  | { readonly readable: false; readonly hostSessionId: string; readonly reason: string };

/** Short-lived shape/index preparation for one captured directory and effective cut. No bodies or fold state. */
export interface PreparedNativeProjectDirectory {
  readonly directory: Extract<RetainedNativeDirectory, { readable: true }>;
  readonly nextSeq: number;
  readonly records: readonly ProjectRecordLocator[];
  readonly bySeq: ReadonlyMap<number, ProjectRecordLocator>;
  readonly events: readonly SessionEvent[];
  readonly foldEvents?: readonly SessionEvent[];
  readonly projection: NativeProjectionPreparation;
  readonly rootRecords: ReadonlyMap<number, readonly number[]>;
}

export function prepareNativeProjectDirectory(directory: Extract<RetainedNativeDirectory, { readable: true }>, signal?: AbortSignal,
  forFold = false): PreparedNativeProjectDirectory {
  const records = directory.directory.records.filter(record => record.seq < directory.cut.nextSeq);
  const bySeq = new Map<number, ProjectRecordLocator>(), rootRecords = new Map<number, number[]>();
  const events: SessionEvent[] = new Array(directory.cut.nextSeq), foldEvents: SessionEvent[] | undefined = forFold ? new Array(directory.cut.nextSeq) : undefined;
  for (const locator of records) {
    signal?.throwIfAborted();
    bySeq.set(locator.seq, locator);
    const visible = isProjectVisibleLocator(locator) || locator.type === 'projects/assistant-settlement';
    if (visible || forFold) {
      const skeleton = projectQuerySkeleton(locator);
      if (visible) events[locator.seq] = skeleton;
      if (foldEvents !== undefined) foldEvents[locator.seq] = skeleton;
    }
    if ((locator.type === 'projects/tool-proposal' || locator.type === 'projects/communication') && typeof locator.facts.startEventSeq === 'number') {
      const root = locator.facts.startEventSeq, related = rootRecords.get(root);
      if (related === undefined) rootRecords.set(root, [locator.seq]); else related.push(locator.seq);
    }
  }
  return { directory, nextSeq: directory.cut.nextSeq, records, bySeq, events, ...(foldEvents === undefined ? {} : { foldEvents }), rootRecords,
    projection: { settlements: directorySettlements(records), ptcStarts: nativePtcResultStarts(events) } };
}

function directoryPreparation(directory: Extract<RetainedNativeDirectory, { readable: true }>, signal?: AbortSignal,
  preparation?: PreparedNativeProjectDirectory, forFold = false): PreparedNativeProjectDirectory {
  if (preparation === undefined) return prepareNativeProjectDirectory(directory, signal, forFold);
  if (preparation.directory !== directory || preparation.nextSeq !== directory.cut.nextSeq || forFold && preparation.foldEvents === undefined) throw new Error('PROJECT_QUERY_PREPARATION_SCOPE_MISMATCH');
  return preparation;
}

/** A retained authorization and writer-confirmed metadata cut, with exact body reads. */
export async function readRetainedProjectNativeDirectory(ctx: Context, projectId: string, hostSessionId: string,
  readSessionSource: ProjectSessionSourceReader, options: Pick<NativeProjectSourceReadOptions, 'signal' | 'assertAdmitting'> = {}): Promise<RetainedNativeDirectory> {
  const unavailable = (reason: string): RetainedNativeDirectory => ({ readable: false, hostSessionId, reason });
  options.signal?.throwIfAborted();
  const before = await readSessionSource(hostSessionId, projectId);
  if (before === undefined || before.projectId !== projectId) return unavailable('来源会话不属于当前项目。');
  if (before.role !== 'main' && before.role !== 'execution') return unavailable('来源不是项目工作会话。');
  if (before.sourceLifecycle.kind !== 'available') return unavailable(projectSourceUnavailableReason(before.sourceLifecycle.kind));
  const read = ctx.get('projectsRead');
  if (read === undefined) return unavailable('Projects目录读取服务不可用。');
  options.assertAdmitting?.(hostSessionId);
  try {
    return await read.withDirectory(SessionId(hostSessionId), async observation => {
      const { directory, cut } = observation;
      if (directory.owner.projectId !== projectId || directory.owner.logicalSessionId !== before.id) throw new Error('持久来源归属不一致。');
      const operations = new AsyncLocalStorage<{ active: boolean }>();
      const validate = async () => {
        options.signal?.throwIfAborted(); await observation.revalidate();
        const after = await readSessionSource(hostSessionId, projectId);
        if (after?.projectId !== projectId || after.id !== before.id || after.revision !== before.revision || after.sourceLifecycle.kind !== 'available'
          || after.role !== before.role) throw new Error('来源会话归属或版本已变化。');
        options.assertAdmitting?.(hostSessionId);
      };
      const assertCurrent = () => { options.signal?.throwIfAborted(); options.assertAdmitting?.(hostSessionId); };
      const revalidate = async () => {
        assertCurrent();
        await validate();
        assertCurrent();
      };
      // Captured metadata may outlive its initial callback. Keep each admitted
      // record/body operation in the read owner's drain set without selecting a new cut.
      const operation = <T,>(action: () => Promise<T>): Promise<T> => observation.withOperation(async () => {
        assertCurrent();
        const inherited = operations.getStore();
        if (inherited?.active) {
          const result = await action();
          assertCurrent();
          if (!inherited.active) await validate();
          return result;
        }
        await validate();
        const scope = { active: true };
        try {
          const result = await operations.run(scope, action);
          assertCurrent(); await validate(); assertCurrent();
          return result;
        } finally { scope.active = false; }
      });
      const readEvent = (seq: number) => operation(() => observation.readEvent(seq));
      const readDecodedEvent = (seq: number) => operation(async () => {
        assertCurrent();
        const event = await observation.readEvent(seq); if (event === undefined) return undefined;
        const persistence = ctx.get('sessionPersistence') as unknown as ProjectRawPayloadReader | undefined;
        if (projectRecordSemanticType(event.type) !== event.type && persistence?.readPayload === undefined) throw new Error('PROJECT_QUERY_PAYLOAD_READER_UNAVAILABLE');
        const decoded = await decodeProjectRecord(event, persistence!, options.signal === undefined ? {} : { signal: options.signal });
        assertCurrent(); return decoded;
      });
      await revalidate();
      return { ...observation, readable: true as const, header: directory.header, projectId, sessionId: before.id,
        formatVersion: directory.header.version, hostSessionId, sourceRevision: before.revision, sessionCreatedAt: directory.header.createdAt,
        inheritedEventCount: Number(directory.inheritedEventCount), endSeq: cut.nextSeq - 1, revalidate, withOperation: operation, readEvent, readDecodedEvent,
        readRange: async function* (from: number, to: number) {
          await revalidate();
          try { for await (const event of observation.readRange(from, to)) yield event; }
          finally { await revalidate(); }
        },
      };
    }, options.signal === undefined ? {} : { signal: options.signal });
  } catch (error) { options.signal?.throwIfAborted(); return unavailable(error instanceof Error ? error.message : '原生来源不可读。'); }
}

/** Select by canonical seq first, then materialize only this projection and its actual dependencies. */
export async function projectNativeDirectoryPrefix(directory: Extract<RetainedNativeDirectory, { readable: true }>, selectedSeqs: ReadonlySet<number>, signal?: AbortSignal,
  progressAlreadyVerified = false, prepared?: PreparedNativeProjectDirectory): Promise<Extract<RetainedNativePrefix, { readable: true }>> {
  return directory.withOperation(() => materializeNativeDirectoryPrefix(directory, selectedSeqs, signal, progressAlreadyVerified, prepared));
}

/** A decoded overlay belongs only to the exact read which obtained its records. */
async function materializeNativeDirectoryPrefix(directory: Extract<RetainedNativeDirectory, { readable: true }>, selectedSeqs: ReadonlySet<number>, signal?: AbortSignal,
  progressAlreadyVerified = false, prepared?: PreparedNativeProjectDirectory, decodedRecords?: ReadonlyMap<number, DecodedProjectRecord>): Promise<Extract<RetainedNativePrefix, { readable: true }>> {
  const preparation = directoryPreparation(directory, signal, prepared), { records, bySeq } = preparation;
  const selected = new Set(selectedSeqs);
  const events: SessionEvent[] = preparation.events.slice(), canonicalEvents = new Map<number, SessionEvent>();
  // Metadata shape is sufficient for message/operation relations. A skeleton is
  // never used as the original for a digest or exposed to a Session consumer.
  const ptcStarts = preparation.projection.ptcStarts;
  const progressKey = (locator: ProjectRecordLocator) => JSON.stringify([projectRecordSemanticType(locator.type), locator.facts.attemptId]);
  const progressThrough = new Map<string, { selected: number; through: number }>();
  for (const seq of selectedSeqs) {
    const locator = bySeq.get(seq); if (locator === undefined) continue;
    const type = projectRecordSemanticType(locator.type), facts = locator.facts;
    if (!progressAlreadyVerified && (type === 'assistant/progress' || type === 'projects/assistant-progress')) {
      const key = progressKey(locator), previous = progressThrough.get(key);
      if (previous === undefined || previous.selected < seq) progressThrough.set(key, { selected: seq, through: seq });
    }
    // Earlier queue identities are complete directory metadata. A cancellation
    // needs those ids/producers, never the superseded original message bodies.
    const root = typeof facts.startEventSeq === 'number' ? facts.startEventSeq : type === 'tool/call' || type === 'tool/ptc-dispatch-start' ? seq : ptcStarts.get(seq);
    if (root !== undefined) {
      selected.add(root);
      for (const seq of preparation.rootRecords.get(root) ?? []) selected.add(seq);
    }
  }
  // The latest selected prefix subsumes earlier ones of the same attempt. Add
  // its immediate proof neighbour with two metadata passes, never one pass per prefix.
  if (progressThrough.size > 0) {
    for (const locator of records) {
      const limit = progressThrough.get(progressKey(locator));
      if (limit !== undefined && limit.through === limit.selected && locator.seq > limit.selected) limit.through = locator.seq;
    }
    for (const locator of records) {
      const limit = progressThrough.get(progressKey(locator));
      if (limit !== undefined && locator.seq <= limit.through) selected.add(locator.seq);
    }
  }
  // A settlement's directory facts bind the reply without reading its body.
  // Only that attempt's prior streams are needed to prove its visible predecessor.
  if (!progressAlreadyVerified) {
    const attempts = selectedDirectoryAttempts(bySeq, selectedSeqs, preparation.projection.settlements);
    if (attempts.size > 0) for (const locator of records) {
      const type = projectRecordSemanticType(locator.type), attempt = locator.facts.attemptId;
      if ((type === 'assistant/progress' || type === 'projects/assistant-progress') && typeof attempt === 'string'
        && locator.seq <= (attempts.get(attempt) ?? -1)) selected.add(locator.seq);
    }
  }
  for (const seq of [...selected].sort((a, b) => a - b)) {
    if (!bySeq.has(seq)) continue;
    signal?.throwIfAborted(); const decoded = decodedRecords?.get(seq) ?? await directory.readDecodedEvent(seq);
    if (decoded === undefined) throw new Error('PROJECT_QUERY_SELECTED_RECORD_UNAVAILABLE');
    events[seq] = decoded.semantic; canonicalEvents.set(seq, decoded.canonical);
  }
  return { readable: true, header: directory.header, projectId: directory.projectId, sessionId: directory.sessionId, formatVersion: directory.formatVersion,
    hostSessionId: directory.hostSessionId, sourceRevision: directory.sourceRevision, events, canonicalEvents, canonicalLocators: bySeq, selectedSeqs, projectionPreparation: preparation.projection,
    endSeq: directory.endSeq, source: 'prepared', sessionCreatedAt: directory.sessionCreatedAt, inheritedEventCount: directory.inheritedEventCount };
}

function selectedDirectoryAttempts(records: ReadonlyMap<number, ProjectRecordLocator>, selectedSeqs: ReadonlySet<number>, settlements: ReadonlyMap<string, string>): ReadonlyMap<string, number> {
  const attempts = new Map<string, number>();
  for (const seq of selectedSeqs) {
    const locator = records.get(seq); if (locator === undefined) continue;
    const attempt = directoryAttemptId(locator, settlements);
    if (attempt !== undefined) {
      attempts.set(attempt, Math.max(locator.seq, attempts.get(attempt) ?? -1));
    }
  }
  return attempts;
}

function directorySettlements(records: readonly ProjectRecordLocator[]): ReadonlyMap<string, string> {
  const settlements = new Map<string, string>();
  for (const locator of records) if (locator.type === 'projects/assistant-settlement' && typeof locator.facts.eventSeq === 'number'
    && typeof locator.facts.eventType === 'string' && typeof locator.facts.attemptId === 'string') {
    const key = `${locator.facts.eventType}:${locator.facts.eventSeq}`;
    if (!settlements.has(key)) settlements.set(key, locator.facts.attemptId);
  }
  return settlements;
}

function directoryAttemptId(locator: ProjectRecordLocator, settlements: ReadonlyMap<string, string>): string | undefined {
  const settled = settlements.get(`${projectRecordSemanticType(locator.type)}:${locator.seq}`);
  return settled ?? (typeof locator.facts.attemptId === 'string' ? locator.facts.attemptId : undefined);
}

export async function selectNativeProjectVisibleDirectoryEvents(directory: Extract<RetainedNativeDirectory, { readable: true }>, selectedSeqs: ReadonlySet<number>, signal?: AbortSignal, preparation?: PreparedNativeProjectDirectory): Promise<readonly NativeProjectVisibleEvent[]> {
  const prefix = await projectNativeDirectoryPrefix(directory, selectedSeqs, signal, false, preparation);
  return selectNativeProjectVisibleEvents(prefix.hostSessionId, prefix.events, entry => selectedSeqs.has(entry.item.seq), signal, prefix.sessionCreatedAt,
    { projectId: prefix.projectId, sessionId: prefix.sessionId, formatVersion: prefix.formatVersion }, prefix.canonicalEvents, prefix.canonicalLocators, prefix.projectionPreparation);
}

/** One query's shared lightweight relations; group body reads never rebuild the whole relation table. */
export interface PreparedNativeProjectDirectoryRelations {
  readonly preparation: PreparedNativeProjectDirectory;
  readonly metadata: NativeProjectVisibleEvent[];
  readonly metadataBySeq: ReadonlyMap<number, readonly NativeProjectVisibleEvent[]>;
  decorate(): (item: NativeProjectSourceItem) => NativeProjectSourceItem;
}
export function prepareNativeProjectDirectoryRelations(preparation: PreparedNativeProjectDirectory, signal?: AbortSignal): PreparedNativeProjectDirectoryRelations {
  const directory = preparation.directory;
  const metadata = [...scanNativeProjectVisibleEvents(directory.hostSessionId, preparation.foldEvents ?? preparation.events, signal, preparation.projection)];
  return { preparation, metadata, metadataBySeq: directoryMetadataBySeq(metadata), decorate: () => {
    // A progress predecessor may be verified by more than one selected group.
    const unique = new Map(metadata.map(entry => [entryKey(entry as ReadableEvent), entry]));
    return directoryRelationDecorator(directory, preparation, [...unique.values()], signal);
  } };
}
function directoryMetadataBySeq(metadata: readonly NativeProjectVisibleEvent[]): ReadonlyMap<number, readonly NativeProjectVisibleEvent[]> {
  const result = new Map<number, NativeProjectVisibleEvent[]>();
  for (const entry of metadata) { const entries = result.get(entry.item.seq); if (entries === undefined) result.set(entry.item.seq, [entry]); else entries.push(entry); }
  return result;
}
function directoryRelationDecorator(directory: Extract<RetainedNativeDirectory, { readable: true }>, preparation: PreparedNativeProjectDirectory,
  metadata: NativeProjectVisibleEvent[], signal?: AbortSignal): (item: NativeProjectSourceItem) => NativeProjectSourceItem {
  const identity = { projectId: directory.projectId, sessionId: directory.sessionId, formatVersion: directory.formatVersion };
  const sourceIdentity = { ...identity, hostSessionId: directory.hostSessionId, sessionCreatedAt: directory.sessionCreatedAt };
  const events = preparation.foldEvents ?? preparation.events;
  metadata.sort((left, right) => left.eventIndex - right.eventIndex);
  const relations = nativeSourceRelations(nativeRelationLocators(metadata, directory.hostSessionId, events, directory.sessionCreatedAt, identity), events,
    signal, directory.sessionCreatedAt, identity, preparation.projection.ptcStarts);
  return item => {
    const { relatedSources: _related, ...rest } = item, source = item.nativeSource;
    if (source?.kind !== 'native-event') return item;
    const related = relations.get(relationKey(source));
    return { ...rest, ...(related === undefined ? {} : { relatedSources: related.map(ref => mintProjectedSource(sourceIdentity, events[ref.eventSeq]!, undefined, preparation.bySeq,
      { ...(ref.messageId === undefined ? {} : { messageId: ref.messageId }), ...(ref.toolCallId === undefined ? {} : { toolCallId: ref.toolCallId }) })) }) };
  };
}

/** Query-local streaming fold. The consumer retains bounded DTOs, never these original bodies. */
export async function visitNativeProjectVisibleDirectoryEvents(directory: Extract<RetainedNativeDirectory, { readable: true }>, selectedSeqs: ReadonlySet<number>,
  visit: (entry: NativeProjectVisibleEvent) => void, signal?: AbortSignal, prepared?: PreparedNativeProjectDirectory, sharedRelations?: PreparedNativeProjectDirectoryRelations): Promise<(item: NativeProjectSourceItem) => NativeProjectSourceItem> {
  return directory.withOperation(() => visitNativeProjectVisibleDirectoryEventsWithinOperation(directory, selectedSeqs, visit, signal, prepared, sharedRelations));
}
async function visitNativeProjectVisibleDirectoryEventsWithinOperation(directory: Extract<RetainedNativeDirectory, { readable: true }>, selectedSeqs: ReadonlySet<number>,
  visit: (entry: NativeProjectVisibleEvent) => void, signal?: AbortSignal, prepared?: PreparedNativeProjectDirectory, sharedRelations?: PreparedNativeProjectDirectoryRelations): Promise<(item: NativeProjectSourceItem) => NativeProjectSourceItem> {
  const preparation = directoryPreparation(directory, signal, prepared, true), { records, bySeq: locators } = preparation;
  if (sharedRelations !== undefined && sharedRelations.preparation !== preparation) throw new Error('PROJECT_QUERY_PREPARATION_SCOPE_MISMATCH');
  const events = preparation.foldEvents!;
  const identity = { projectId: directory.projectId, sessionId: directory.sessionId, formatVersion: directory.formatVersion };
  const sourceIdentity = { ...identity, hostSessionId: directory.hostSessionId, sessionCreatedAt: directory.sessionCreatedAt };
  const metadata = sharedRelations?.metadata ?? [...scanNativeProjectVisibleEvents(directory.hostSessionId, events, signal, preparation.projection)];
  const metadataBySeq = sharedRelations?.metadataBySeq ?? directoryMetadataBySeq(metadata);
  const settlements = preparation.projection.settlements, attempts = selectedDirectoryAttempts(locators, selectedSeqs, settlements);
  const progress = (type: string) => type === 'assistant/progress' || type === 'projects/assistant-progress';
  const key = (locator: ProjectRecordLocator) => typeof locator.facts.attemptId === 'string'
    ? `${projectRecordSemanticType(locator.type)}:${locator.facts.attemptId}` : `event:${locator.seq}`;
  const next = new Set<number>(), seenNext = new Set<string>();
  if (attempts.size > 0) for (const locator of records) {
    const type = projectRecordSemanticType(locator.type), attempt = directoryAttemptId(locator, settlements);
    if ((!progress(type) && type !== 'assistant/attempt') || attempt === undefined || !attempts.has(attempt)
      || locator.seq <= attempts.get(attempt)!) continue;
    const group = `${type}:${attempt}`;
    if (!seenNext.has(group)) { seenNext.add(group); next.add(locator.seq); }
  }
  const hasSelectedProgress = [...selectedSeqs].some(seq => { const locator = locators.get(seq); return locator !== undefined && (progress(projectRecordSemanticType(locator.type)) || projectRecordSemanticType(locator.type) === 'assistant/attempt'); });
  const needed = attempts.size === 0 && !hasSelectedProgress ? [] : records.filter(locator => {
    const type = projectRecordSemanticType(locator.type);
    return (progress(type) || type === 'assistant/attempt') && (selectedSeqs.has(locator.seq)
      || locator.seq <= (attempts.get(directoryAttemptId(locator, settlements) ?? '') ?? -1) || next.has(locator.seq));
  });
  const handled = new Set(needed.map(locator => locator.seq));
  const last = new Map(needed.filter(locator => progress(projectRecordSemanticType(locator.type))).map(locator => [key(locator), locator.seq]));
  const selected = new Set(needed.filter(locator => selectedSeqs.has(locator.seq)).map(locator => `${locator.seq}:${projectRecordSemanticType(locator.type)}:assistant:`));
  const progresses = new Map<string, ProgressProjection>();
  for (const locator of needed) {
    signal?.throwIfAborted();
    const decoded = await directory.readDecodedEvent(locator.seq);
    if (decoded === undefined) throw new Error('PROJECT_QUERY_SELECTED_RECORD_UNAVAILABLE');
    let entry = recordedOperationItem(directory.hostSessionId, decoded.semantic, locator.seq, progresses,
      projectRecordSemanticType(locator.type) === 'assistant/attempt' && !selectedSeqs.has(locator.seq), selected);
    if (last.get(key(locator)) === locator.seq) progresses.delete(key(locator));
    if (entry === undefined) continue;
    const attemptId = directoryAttemptId(locator, settlements);
    if (attemptId !== undefined) entry = { ...entry, item: { ...entry.item, attemptId } };
    // Navigation keeps only facts proven by the same visible/gap state machine.
    metadata.push({ eventIndex: entry.eventIndex, item: { isTarget: false, seq: entry.item.seq, time: entry.item.time,
      kind: entry.item.kind, role: entry.item.role, text: '', ...(entry.item.attemptId === undefined ? {} : { attemptId: entry.item.attemptId }) } });
    if (!selectedSeqs.has(locator.seq)) continue;
    const nativeSource = mintProjectedSource(sourceIdentity, decoded.semantic, undefined, locators);
    const blocks = entry.item.visibleBlocks ?? [], total = canonicalCodePointLength(blocks);
    visit({ ...entry, item: { ...entry.item, nativeSource,
      bodySource: { ...nativeSource, body: { stream: 'visible-blocks', codec: 'canonical-json/v1', digest: nativeSourceDigest(blocks) } },
      bodyRange: { unit: 'unicode-code-points', start: 0, end: total, total } } });
  }
  for (const seq of [...selectedSeqs].sort((a, b) => a - b)) {
    if (handled.has(seq) || !locators.has(seq)) continue;
    const selectedMetadata = metadataBySeq.get(seq) ?? [];
    if (selectedMetadata.length === 0) continue;
    for (const entry of await projectNativeDirectoryRecord(directory, seq, selectedMetadata, preparation, signal)) visit(entry);
  }
  // Shared group visits already run inside the caller's single admitted operation;
  // its final validation owns publication, not each selected message body.
  if (sharedRelations === undefined) await directory.revalidate();
  // Group queries decorate their retained candidates once after the last bounded body read.
  return sharedRelations === undefined ? directoryRelationDecorator(directory, preparation, metadata, signal) : item => item;
}

/** Project one ordinary record using its already-prepared queue and occurrence
 * metadata. No whole-directory overlay or second visibility scan is needed. */
async function projectNativeDirectoryRecord(directory: Extract<RetainedNativeDirectory, { readable: true }>, seq: number,
  metadata: readonly NativeProjectVisibleEvent[], preparation: PreparedNativeProjectDirectory, signal?: AbortSignal): Promise<readonly NativeProjectVisibleEvent[]> {
  const locator = preparation.bySeq.get(seq)!;
  const selected = new Set([seq]), facts = locator.facts, type = projectRecordSemanticType(locator.type);
  const root = typeof facts.startEventSeq === 'number' ? facts.startEventSeq : type === 'tool/call' || type === 'tool/ptc-dispatch-start' ? seq : preparation.projection.ptcStarts.get(seq);
  if (root !== undefined) { selected.add(root); for (const related of preparation.rootRecords.get(root) ?? []) selected.add(related); }
  const canonical = new Map<number, SessionEvent>(), events: SessionEvent[] = [], communicationRecords: SessionEvent[] = [];
  for (const position of [...selected].sort((a, b) => a - b)) {
    if (!preparation.bySeq.has(position)) continue;
    signal?.throwIfAborted(); const decoded = await directory.readDecodedEvent(position);
    if (decoded === undefined) throw new Error('PROJECT_QUERY_SELECTED_RECORD_UNAVAILABLE');
    canonical.set(position, decoded.canonical); events[position] = decoded.semantic; communicationRecords.push(decoded.semantic);
  }
  const event = events[seq]!, keys = new Set(metadata.map(entry => entryKey(entry as ReadableEvent))), entries: ReadableEvent[] = [];
  const direct = readableEvent(directory.hostSessionId, event, seq);
  if (direct !== undefined) {
    const attemptId = preparation.projection.settlements.get(`${event.type}:${event.seq}`);
    entries.push(attemptId === undefined || event.type !== 'assistant/message' ? direct : { ...direct, item: { ...direct.item, attemptId } });
  }
  if (event.type === 'agent/inbox/spliced') {
    for (const message of event.data.inserted) {
      const item = itemFromMessage(directory.hostSessionId, event, message, event.type);
      if (item !== undefined) entries.push({ eventIndex: seq, ...(item.messageId === undefined ? {} : { messageId: item.messageId }),
        item: { ...item, recordPhase: Number(event.data.removedCount ?? 0) > 0 ? 'edited' : 'accepted' } });
    }
    for (const entry of metadata) if (entry.item.recordPhase === 'claimed' || entry.item.recordPhase === 'canceled') {
      const text = canonicalJson({ target: event.data.target, messageId: entry.item.messageId, operation: entry.item.recordPhase });
      entries.push({ ...entry, item: { ...entry.item, text, visibleBlocks: [{ type: 'text', text }], visibleComplete: true } });
    }
  }
  const extra = recordedOperationItem(directory.hostSessionId, event, seq, new Map());
  if (extra !== undefined) entries.push(extra);
  const identity = { projectId: directory.projectId, sessionId: directory.sessionId, formatVersion: directory.formatVersion };
  return entries.filter(entry => keys.has(entryKey(entry))).map(entry => withNativeProjectBodySource(entry, directory.hostSessionId, events,
    directory.sessionCreatedAt, identity, canonical, preparation.bySeq, communicationRecords));
}

/** Exact/body reads use locators and a finite visible window rather than a full prefix. */
export async function readNativeProjectSourceFromDirectory(directory: Extract<RetainedNativeDirectory, { readable: true }>, input: NativeProjectSource,
  options: NativeProjectSourceReadOptions = {}): Promise<NativeProjectSourceRead> {
  try { return await directory.withOperation(() => readDirectorySource(directory, input, options)); }
  catch (error) { options.signal?.throwIfAborted(); return unresolved(input, error instanceof Error ? error.message : '原始正文当前不可读。', 'unreadable'); }
}

async function readDirectorySource(directory: Extract<RetainedNativeDirectory, { readable: true }>, input: NativeProjectSource,
  options: NativeProjectSourceReadOptions): Promise<NativeProjectSourceRead> {
  let source: NativeProjectSource;
  try { source = decodeNativeProjectSource(input); } catch (error) { return unresolved(input, String(error), 'invalid-source'); }
  const preparation = prepareNativeProjectDirectory(directory, options.signal), { records } = preparation;
  const targetSeqs = new Set<number>();
  if (source.kind === 'native-event') targetSeqs.add(source.eventSeq);
  else for (const locator of records) {
    if (source.kind === 'message' ? locator.facts.messageId === source.messageId || locator.inboxMetadata?.inserted.some(message => message.id === source.messageId)
      : locator.facts.callId === source.toolCallId || locator.facts.subCallId === source.toolCallId) targetSeqs.add(locator.seq);
  }
  if (targetSeqs.size === 0) return unresolved(source, '原始记录不存在或不在普通可见范围。', 'not-found');
  const before = boundedContextCount(options.before, 'before', 1), after = boundedContextCount(options.after, 'after', 1);
  const first = Math.min(...targetSeqs), last = Math.max(...targetSeqs), window = new Set(targetSeqs);
  const decodedRecords = new Map<number, DecodedProjectRecord>();
  const decoded = async (seq: number) => {
    options.signal?.throwIfAborted();
    let record = decodedRecords.get(seq);
    if (record === undefined) {
      record = await directory.readDecodedEvent(seq);
      if (record === undefined) throw new Error('PROJECT_QUERY_SELECTED_RECORD_UNAVAILABLE');
      decodedRecords.set(seq, record);
    }
    return record;
  };
  const visibleCounts = new Map<number, number>();
  for (const entry of scanNativeProjectVisibleEvents(directory.hostSessionId, preparation.events, options.signal, preparation.projection)) {
    visibleCounts.set(entry.item.seq, (visibleCounts.get(entry.item.seq) ?? 0) + 1);
  }
  const progressKey = (locator: ProjectRecordLocator) => `${projectRecordSemanticType(locator.type)}:${typeof locator.facts.attemptId === 'string' ? locator.facts.attemptId : `event:${locator.seq}`}`;
  const groups = new Map<string, ProjectRecordLocator[]>();
  for (const locator of records) {
    const type = projectRecordSemanticType(locator.type);
    if (type !== 'assistant/progress' && type !== 'projects/assistant-progress') continue;
    const key = progressKey(locator), group = groups.get(key);
    if (group === undefined) groups.set(key, [locator]); else group.push(locator);
  }
  const positions = new Map<string, number>(), progresses = new Map<string, ProgressProjection>();
  const countVisible = async (locator: ProjectRecordLocator): Promise<number> => {
    const type = projectRecordSemanticType(locator.type);
    if (type === 'assistant/progress' || type === 'projects/assistant-progress') {
      const key = progressKey(locator), group = groups.get(key)!;
      let position = positions.get(key) ?? 0;
      // Before-windows may start at the newest prefix. Replay its attempt once
      // in canonical order; later candidates reuse only this query's fold facts.
      while (position < group.length && group[position]!.seq <= locator.seq) {
        const row = group[position++]!, record = await decoded(row.seq);
        const entry = recordedOperationItem(directory.hostSessionId, record.semantic, row.seq, progresses, true);
        visibleCounts.set(row.seq, entry === undefined ? 0 : 1);
      }
      positions.set(key, position);
    } else if (type === 'assistant/attempt' && !visibleCounts.has(locator.seq)) {
      const record = await decoded(locator.seq);
      visibleCounts.set(locator.seq, recordedOperationItem(directory.hostSessionId, record.semantic, locator.seq, progresses, true) === undefined ? 0 : 1);
    }
    return visibleCounts.get(locator.seq) ?? 0;
  };
  for (const [direction, count] of [[-1, before], [1, after]] as const) {
    if (count === 0) continue;
    let needed = count;
    const candidates = records.filter(record => isProjectVisibleLocator(record) && (direction < 0 ? record.seq < first : record.seq > last));
    if (direction < 0) candidates.reverse();
    for (const locator of candidates) {
      window.add(locator.seq);
      needed -= await countVisible(locator);
      if (needed <= 0) break;
    }
  }
  const prefix = await materializeNativeDirectoryPrefix(directory, window, options.signal, false, preparation, decodedRecords);
  const result = readNativeProjectSourceFromPrefix(prefix, source, options);
  await directory.revalidate(); return result;
}

/** Schedule observations use the same retained identity/cut and a real prefix, never prepared synthetic endings. */
export async function readRetainedProjectNativePrefix(ctx: Context, projectId: string, hostSessionId: string,
  readSessionSource: ProjectSessionSourceReader, options: Pick<NativeProjectSourceReadOptions, 'signal' | 'assertAdmitting'> = {}): Promise<RetainedNativePrefix> {
  const unavailable = (reason: string): RetainedNativePrefix => ({ readable: false, hostSessionId, reason });
  options.signal?.throwIfAborted();
  const before = await readSessionSource(hostSessionId, projectId);
  if (before === undefined || before.projectId !== projectId) return unavailable('来源会话不属于当前项目。');
  if (before.role !== 'main' && before.role !== 'execution') return unavailable('来源不是项目工作会话。');
  if (before.sourceLifecycle.kind !== 'available') return unavailable(projectSourceUnavailableReason(before.sourceLifecycle.kind));
  options.assertAdmitting?.(hostSessionId);
  let result: Extract<RetainedNativePrefix, { readable: true }>;
  try {
    const projectsRead = ctx.get('projectsRead');
    if (projectsRead === undefined) return unavailable('Projects只读服务不可用。');
    result = await projectsRead.withPrefix(SessionId(hostSessionId), prefix => {
      if (prefix.owner.projectId !== projectId || prefix.owner.logicalSessionId !== before.id) throw new Error('持久来源归属不一致。');
      return { readable: true as const, header: prefix.header, projectId, sessionId: before.id, formatVersion: prefix.header.version,
        hostSessionId, sourceRevision: before.revision, events: prefix.events, endSeq: prefix.events.length - 1, source: prefix.source,
        sessionCreatedAt: prefix.header.createdAt, inheritedEventCount: prefix.inheritedEventCount };
    }, options.signal === undefined ? {} : { signal: options.signal });
  } catch (error) { options.signal?.throwIfAborted(); return unavailable(error instanceof Error ? error.message : '原生来源不可读。'); }
  const after = await readSessionSource(hostSessionId, projectId);
  options.signal?.throwIfAborted();
  if (after === undefined || after.projectId !== projectId || after.id !== before.id) return unavailable('来源会话归属已变化。');
  if (after.role !== 'main' && after.role !== 'execution') return unavailable('来源不是项目工作会话。');
  if (after.sourceLifecycle.kind !== 'available') return unavailable(projectSourceUnavailableReason(after.sourceLifecycle.kind));
  if (after.revision !== before.revision) return unavailable('来源会话已变化，请重新读取。');
  options.assertAdmitting?.(hostSessionId);
  return result;
}

export function projectSourceUnavailableReason(kind: Exclude<ProjectSessionSourceLifecycle["kind"], "available">): string {
  switch (kind) {
    case "deleting": return "来源会话删除处理中。";
    case "partial": return "来源会话删除部分完成，原聊天不可读取。";
    case "deleted": return "来源会话已删除。";
  }
}

/** Resolve a stable reference against one real durable prefix; never read another version on mismatch. */
export function readNativeProjectSourceFromPrefix(prefix: Extract<RetainedNativePrefix, { readable: true }>, input: NativeProjectSource,
  options: NativeProjectSourceReadOptions = {}): NativeProjectSourceRead {
  let source: NativeProjectSource;
  try { source = decodeNativeProjectSource(input); } catch (error) { return unresolved(input, String(error), 'invalid-source'); }
  const before = boundedContextCount(options.before, 'before', 1), after = boundedContextCount(options.after, 'after', 1);
  if (source.hostSessionId !== prefix.hostSessionId) return unresolved(source, '来源Session不匹配。', 'invalid-source');
  const identity = prefix.projectId.length > 0 && prefix.sessionId.length > 0 ? { projectId: prefix.projectId, sessionId: prefix.sessionId, formatVersion: prefix.formatVersion } : undefined;
  const metadata = scanNativeProjectVisibleEvents(prefix.hostSessionId, prefix.events, options.signal, prefix.projectionPreparation);
  const entries = metadata.filter(entry => prefix.selectedSeqs === undefined || prefix.selectedSeqs.has(entry.item.seq)).map(entry => ({ ...entry,
    ...(entry.item.messageId === undefined ? {} : { messageId: entry.item.messageId }), ...(entry.item.toolCallId === undefined ? {} : { toolCallId: entry.item.toolCallId }) }));
  let targets: readonly ReadableEvent[];
  if (source.kind === 'native-event') {
    if (source.projectId !== prefix.projectId || source.sessionId !== prefix.sessionId || source.sessionCreatedAt !== prefix.sessionCreatedAt) return unresolved(source, '来源归属或Session创建身份不匹配。', 'invalid-source');
    if (source.eventSpace.formatVersion !== prefix.formatVersion) return unresolved(source, '当前reader无法映射该canonical事件代际；请按原生消息/调用身份重新定位。', 'stale-source');
    const event = prefix.canonicalEvents?.get(source.eventSeq) ?? prefix.events[source.eventSeq];
    if (event === undefined) return unresolved(source, '该精确事件不在当前已保存前缀。', 'not-found');
    if (event.type !== source.eventType || nativeSourceDigest(event) !== source.eventDigest) return unresolved(source, '精确事件身份或内容已变化，未改读其他版本。', 'stale-source');
    targets = entries.filter(entry => entry.item.seq === source.eventSeq && (source.messageId === undefined || entry.item.messageId === source.messageId)
      && (source.toolCallId === undefined || entry.item.toolCallId === source.toolCallId));
    if (source.eventType === 'projects/tool-proposal' && source.messageId === undefined) {
      const data = record(event.data);
      if (typeof data?.callId === 'string' && typeof data.name === 'string' && typeof data.rawArguments === 'string'
        && (source.toolCallId === undefined || source.toolCallId === data.callId)) {
        const visibleBlocks: CommunicationVisibleBlock[] = [
          { type: 'quoted-tool-call', toolCallId: data.callId, name: data.name, arguments: data.rawArguments },
          { type: 'text', text: canonicalJson({ parsedArguments: data.parsedArguments }) },
        ];
        const nativeSource = mintNativeProjectSource({ projectId: prefix.projectId, sessionId: prefix.sessionId, hostSessionId: prefix.hostSessionId,
          sessionCreatedAt: prefix.sessionCreatedAt, formatVersion: prefix.formatVersion }, event, event, { toolCallId: data.callId });
        const total = canonicalCodePointLength(visibleBlocks);
        const relatedSources = nativeSourceRelations(nativeRelationLocators(metadata, prefix.hostSessionId, prefix.events, prefix.sessionCreatedAt, identity), prefix.events, options.signal, prefix.sessionCreatedAt, identity, prefix.projectionPreparation?.ptcStarts).get(relationKey(nativeSource))?.map(ref => mintProjectedSource({ ...identity!, hostSessionId: prefix.hostSessionId, sessionCreatedAt: prefix.sessionCreatedAt }, prefix.events[ref.eventSeq]!, prefix.canonicalEvents, prefix.canonicalLocators, { ...(ref.messageId === undefined ? {} : { messageId: ref.messageId }), ...(ref.toolCallId === undefined ? {} : { toolCallId: ref.toolCallId }) }));
        targets = [{ eventIndex: Number(event.seq), toolCallId: data.callId, item: { isTarget: false, seq: event.seq, time: event.time, kind: source.eventType,
          role: 'tool', speaker: 'tool', sourceKind: 'tool', source: { kind: 'tool' }, toolCallId: data.callId, recordPhase: 'proposed',
          text: communicationVisibleText(visibleBlocks), visibleBlocks, visibleComplete: true, nativeSource,
          ...(relatedSources === undefined ? {} : { relatedSources }),
          bodySource: { ...nativeSource, body: { stream: 'visible-blocks', codec: 'canonical-json/v1', digest: nativeSourceDigest(visibleBlocks) } },
          bodyRange: { unit: 'unicode-code-points', start: 0, end: total, total } } }];
      }
    }

  } else {
    targets = entries.filter(entry => source.kind === 'message' ? entry.item.sourceKind !== 'inbox' && entry.item.messageId === source.messageId : entry.item.toolCallId === source.toolCallId);
    if (source.kind === 'message' && targets.length > 1) {
      const consumed = targets.filter(entry => entry.item.kind === 'user/message' || entry.item.kind === 'assistant/message' || entry.item.kind === 'tool/result');
      // Legacy message locators name the original consumed-message domain. Queue
      // edit events use their own exact sources and cannot replace that domain.
      if (consumed.length === 1) targets = consumed;
      else return unresolved(source, '旧消息定位对应多个消费记录或仅有多个排队版本；请用查询返回的精确source分别读取。', 'ambiguous-source');
    }
    if (source.kind === 'tool') {
      const ptcStarts = prefix.projectionPreparation?.ptcStarts ?? nativePtcResultStarts(prefix.events);
      const starts = targets.filter(item => item.item.kind === 'tool/call' || item.item.kind === 'tool/ptc-dispatch-start');
      const results = targets.filter(item => item.item.kind === 'tool/result' || item.item.kind === 'tool/ptc-dispatch');
      const root = starts[0]?.item.seq;
      const conflicting = root !== undefined && targets.some(item => { const event = prefix.events[item.eventIndex]; const linked = event === undefined ? undefined : nativeCallStart(event, ptcStarts); return linked !== undefined && linked !== root; });
      if (starts.length > 1 || results.length > 1 || conflicting) return unresolved(source, '旧工具定位对应多个真实调用occurrence，无法确定所指。请使用精确source。', 'ambiguous-source');
    }
  }
  if (targets.length === 0) return unresolved(source, '原始记录不存在或不在普通可见范围。', source.kind === 'native-event' ? 'unreadable' : 'not-found');
  const selectedMetadata = withAdjacentContext(entries, targets, before, after, options.signal);
  const itemKey = (item: NativeProjectSourceItem) => `${item.seq}:${item.kind}:${item.role}:${item.messageId ?? item.toolCallId ?? ''}`;
  const selectedKeys = new Set(selectedMetadata.map(itemKey));
  const targetKeys = new Set(targets.map(entry => itemKey(entry.item)));
  const selected: NativeProjectSourceItem[] = [];
  for (const entry of iterateSelectedNativeProjectVisibleEvents(prefix.hostSessionId, prefix.events, entry => selectedKeys.has(itemKey(entry.item)), options.signal, prefix.sessionCreatedAt, identity, prefix.canonicalEvents, prefix.canonicalLocators, prefix.projectionPreparation)) {
    const item = { ...entry.item, isTarget: targetKeys.has(itemKey(entry.item)) };
    // Native body validation below needs its one full exact target. Legacy tool
    // locators may name many facts, so bound each before rendering the next.
    selected.push(options.fullBody || source.kind === 'native-event' ? item : boundNativeProjectSourceItem(item));
  }
  // Proposals are exact tool-chain navigation records, not ordinary chat list entries.
  for (const target of targets) if (target.item.kind === 'projects/tool-proposal') selected.push({ ...target.item, isTarget: true });
  selected.sort((left, right) => left.seq - right.seq);
  if (source.kind === 'native-event' && source.body !== undefined) {
    if (source.body.stream === 'tool-value') return unresolved(source, '原始工具value按原owner保存，不自动向普通聊天读取开放。', 'unreadable');
    const event = prefix.events[source.eventSeq]!, data = record(event.data);
    if (source.body.stream === 'model-result' && !(['tool/result', 'tool/ptc-dispatch', 'projects/tool-execution-final'].includes(projectRecordSemanticType(source.eventType)) || ['tool/execution-return', 'projects/tool-execution-return'].includes(projectRecordSemanticType(source.eventType)) && data?.phase === 'canonical')) return unresolved(source, '该原始事件没有model-result正文流。', 'invalid-source');
    const actual = selected.filter(item => item.isTarget);
    if (actual.length !== 1 || nativeSourceDigest(actual[0]!.visibleBlocks ?? []) !== source.body.digest) return unresolved(source, '正文流或内容版本不匹配。', 'stale-source');
    const total = actual[0]!.bodyRange?.total ?? canonicalCodePointLength(actual[0]!.visibleBlocks ?? []);
    if (source.body.range !== undefined && source.body.range.end > total) return unresolved(source, '正文范围超出该版本的真实内容。', 'invalid-source');
  }
  if (!selected.some(item => item.isTarget)) return unresolved(source, '原始记录不存在或不在普通可见范围。', source.kind === 'native-event' ? 'unreadable' : 'not-found');
  const items = options.fullBody || source.kind !== 'native-event' ? selected : selected.map(item => boundNativeProjectSourceItem(item));
  const limitations = uniqueLimitations(items.flatMap(item => item.limitations ?? []));
  return { resolved: true, hostSessionId: prefix.hostSessionId, items,
    ...(limitations.length === 0 ? {} : { partial: true, limitations }) };
}

/** Large records keep their original body reference instead of pretending a truncated block is original. */
export function boundNativeProjectSourceItem(item: NativeProjectSourceItem, limit = 4096): NativeProjectSourceItem {
  const total = item.bodyRange?.total ?? canonicalCodePointLength(item.visibleBlocks ?? []);
  if (total <= limit) return item;
  const { visibleBlocks: _blocks, ...rest } = item;
  return { ...rest, text: sliceCodePoints(item.text, 0, limit), partial: true,
    bodyRange: { unit: 'unicode-code-points', start: 0, end: 0, total },
    limitations: uniqueLimitations([...(item.limitations ?? []), '这里只提供有限原文摘录；完整有序内容沿bodySource续读。']) };
}

interface ProgressProjection {
  expectedIndex: number;
  valid: boolean;
  assembler?: BlockAssembler | undefined;
  blocks: Map<number, { kind: string; present: boolean; closed: boolean }>;
}
function recordedOperationItem(_hostSessionId: string, event: SessionEvent, eventIndex: number, progresses: Map<string, ProgressProjection>, metadataOnly = false,
  selected?: ReadonlySet<string>, renderProgress?: ReadonlySet<string>): ReadableEvent | undefined {
  const envelope: EventEnvelope = event, data = record(envelope.data);
  const progress = envelope.type === 'assistant/progress' || envelope.type === 'projects/assistant-progress';
  if (envelope.type === 'assistant/attempt' || progress) {
    const key = progress && typeof data?.attemptId === 'string' ? `${envelope.type}:${data.attemptId}` : `event:${eventIndex}`;
    let state = progresses.get(key);
    if (state === undefined) { state = { expectedIndex: 0, valid: true, blocks: new Map(), ...(metadataOnly || renderProgress !== undefined && !renderProgress.has(key) ? {} : { assembler: new BlockAssembler() }) }; if (progress) progresses.set(key, state); }
    if (!state.valid) return undefined;
    try {
      if (!Array.isArray(data?.stream)) { state.valid = false; return undefined; }
      const chunks = expandAssistantStream(data.stream as AssistantStreamRecord[]);
      if (progress && (data.fromIndex !== state.expectedIndex || data.toIndex !== state.expectedIndex + chunks.length)) { state.valid = false; return undefined; }
      for (const timed of chunks) {
        const chunk = timed.chunk;
        if (!['block-start', 'text-delta', 'reasoning-delta', 'tool-call-delta', 'block-end', 'usage', 'finish'].includes(chunk.type)) { state.valid = false; return undefined; }
        state.assembler?.push(chunk);
        if ('index' in chunk) {
          let block = state.blocks.get(chunk.index);
          if (block === undefined && (chunk.type === 'block-start' || chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta' || chunk.type === 'block-end')) {
            block = { kind: chunk.type === 'block-start' ? chunk.blockType : chunk.type === 'block-end' ? chunk.block.type : chunk.type === 'text-delta' ? 'text' : chunk.type === 'reasoning-delta' ? 'reasoning' : 'tool-call', present: false, closed: false };
            state.blocks.set(chunk.index, block);
          }
          if (block !== undefined && !block.closed) {
            if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') block.present ||= chunk.text.trim() !== '';
            if (chunk.type === 'block-end') { block.kind = chunk.block.type; block.present = (chunk.block.type === 'text' || chunk.block.type === 'reasoning') && chunk.block.text.trim() !== ''; block.closed = true; }
          }
        }
      }
      state.expectedIndex += chunks.length;
    } catch { state.valid = false; return undefined; }
    if (![...state.blocks.values()].some(block => block.kind === 'text' && block.present)) return undefined;
    const meta: ReadableEvent = { eventIndex, item: { isTarget: false, seq: event.seq, time: event.time, kind: envelope.type, role: 'assistant', speaker: 'assistant', sourceKind: 'model', source: { kind: 'model' }, text: '',
      recordPhase: progress ? 'saved-prefix' : 'attempt-settled', ...(typeof data?.attemptId === 'string' ? { attemptId: data.attemptId } : {}), partial: true,
      limitations: [progress ? '仅为该attempt截至此事件已保存的输出；后续尾部未知。' : '这是未成为成功答复的attempt已有可见内容。'] } };
    if (metadataOnly || selected !== undefined && !selected.has(entryKey(meta))) return meta;
    const projection = projectCommunicationVisibleBlocks(state.assembler!.interruptedBlocks());
    return { ...meta, item: { ...meta.item, text: communicationVisibleText(projection.blocks), visibleBlocks: projection.blocks,
      visibleComplete: projection.missingVisible.length === 0, hiddenExcluded: projection.hiddenExcluded, missingVisible: projection.missingVisible } };
  }
  if (!['tool/execution-start', 'tool/execution-return', 'projects/tool-execution-start', 'projects/tool-execution-return', 'projects/tool-execution-final', 'agent/stop-request', 'projects/agent-stop-request'].includes(envelope.type)) return undefined;
  if (envelope.type === 'agent/stop-request' || envelope.type === 'projects/agent-stop-request') {
    if (selected !== undefined && !selected.has(`${eventIndex}:${envelope.type}:system:`)) return undefined;
    const text = metadataOnly ? '' : canonicalJson({ cause: data?.cause, keepInbox: data?.keepInbox, state: data?.state });
    return { eventIndex, item: { isTarget: false, seq: event.seq, time: event.time, kind: envelope.type, role: 'system', speaker: 'system', sourceKind: 'control', source: { kind: 'control' },
      text, ...(metadataOnly ? {} : { visibleBlocks: [{ type: 'text' as const, text }] }), visibleComplete: true, recordPhase: 'stop-requested' } };
  }
  const callId = typeof data?.callId === 'string' ? data.callId : undefined;
  if (callId === undefined) return undefined;
  if (data?.phase === 'presentation-meta') return undefined;
  const start = envelope.type === 'tool/execution-start' || envelope.type === 'projects/tool-execution-start';
  const final = envelope.type === 'projects/tool-execution-final';
  if (metadataOnly) return { eventIndex, toolCallId: callId, item: { isTarget: false, seq: event.seq, time: event.time, kind: envelope.type, role: 'tool', speaker: 'tool', sourceKind: 'tool', source: { kind: 'tool' }, toolCallId: callId, text: '', recordPhase: start ? 'body-started' : final ? 'model-final' : data?.phase === 'canonical' ? 'canonical-returned' : data?.phase === 'rendered' ? 'body-rendered' : data?.phase === 'throw' ? 'body-threw' : 'value-returned' } };
  if (selected !== undefined && !selected.has(`${eventIndex}:${envelope.type}:tool:${callId}`)) return undefined;
  const projection = final ? projectCommunicationVisibleBlocks(record(data?.result)?.content, true)
    : data?.phase === 'canonical' || data?.phase === 'rendered' ? projectCommunicationVisibleBlocks(data.content, true) : undefined;
  const content = start
    ? [{ type: 'quoted-tool-call' as const, toolCallId: callId, name: typeof data?.name === 'string' ? data.name : '', arguments: canonicalJson(data?.arguments) }]
    : projection !== undefined ? projection.blocks
    : data?.phase === 'throw' ? [{ type: 'text' as const, text: `[工具执行异常]\n${String(record(data.error)?.message ?? '')}` }]
    : [{ type: 'text' as const, text: '原始工具value已记录；该私有结构不自动进入普通聊天读取。' }];
  return { eventIndex, item: { isTarget: false, seq: event.seq, time: event.time, kind: envelope.type, role: 'tool', speaker: 'tool', sourceKind: 'tool', source: { kind: 'tool' },
    toolCallId: callId, text: communicationVisibleText(content), visibleBlocks: content, visibleComplete: (projection?.missingVisible.length ?? 0) === 0,
    ...(projection === undefined ? {} : { hiddenExcluded: projection.hiddenExcluded, missingVisible: projection.missingVisible }),
    ...((projection?.missingVisible.length ?? 0) > 0 ? { partial: true as const, limitations: ['一段工具可见内容无法显示。'] } : {}),
    recordPhase: start ? 'body-started' : final ? 'model-final' : data?.phase === 'canonical' ? 'canonical-returned' : data?.phase === 'rendered' ? 'body-rendered' : data?.phase === 'throw' ? 'body-threw' : 'value-returned' } };
}

/** Native content is publishable only while the same retained source revision remains available. */
export async function readRetainedProjectSource(
  ctx: Context,
  projectId: string,
  source: NativeProjectSource,
  readSessionSource: ProjectSessionSourceReader,
  options: NativeProjectSourceReadOptions = {},
): Promise<NativeProjectSourceRead> {
  options.signal?.throwIfAborted();
  const before = await readSessionSource(source.hostSessionId, projectId);
  if (before === undefined || before.projectId !== projectId) return unresolved(source, "来源会话不属于当前项目。", "invalid-source");
  if (before.role !== "main" && before.role !== "execution") return unresolved(source, "来源不是项目工作会话。", "unreadable");
  if (before.sourceLifecycle.kind !== "available") return unresolved(source, projectSourceUnavailableReason(before.sourceLifecycle.kind), before.sourceLifecycle.kind === "deleted" ? "deleted" : "unreadable");
  options.assertAdmitting?.(source.hostSessionId);
  const directory = await readRetainedProjectNativeDirectory(ctx, projectId, source.hostSessionId, readSessionSource, options);
  if (!directory.readable) return unresolved(source, directory.reason, 'unreadable');
  const native = await readNativeProjectSourceFromDirectory(directory, source, options);
  const after = await readSessionSource(source.hostSessionId, projectId);
  options.signal?.throwIfAborted();
  if (after === undefined || after.projectId !== projectId || after.id !== before.id) return unresolved(source, "来源会话归属已变化。");
  if (after.role !== "main" && after.role !== "execution") return unresolved(source, "来源不是项目工作会话。");
  if (after.sourceLifecycle.kind !== "available") return unresolved(source, projectSourceUnavailableReason(after.sourceLifecycle.kind), after.sourceLifecycle.kind === "deleted" ? "deleted" : "unreadable");
  if (after.revision !== before.revision) return unresolved(source, "来源会话已变化，请重新读取。");
  options.assertAdmitting?.(source.hostSessionId);
  return native;
}

/**
 * Reads one Project source through its retained directory and exact canonical records.
 *
 * The caller owns Project membership and source authorization. This function only
 * reads the exact native Session log and never creates or resumes an Agent.
 */
export function readNativeProjectSource(
  ctx: Context,
  source: NativeProjectSource,
  signal?: AbortSignal,
): Promise<NativeProjectSourceRead>;
export function readNativeProjectSource(
  ctx: Context,
  source: NativeProjectSource,
  options?: NativeProjectSourceReadOptions,
): Promise<NativeProjectSourceRead>;
export async function readNativeProjectSource(
  ctx: Context,
  source: NativeProjectSource,
  signalOrOptions?: AbortSignal | NativeProjectSourceReadOptions,
): Promise<NativeProjectSourceRead> {
  const options = normalizeReadOptions(signalOrOptions);
  const before = boundedContextCount(options.before, "before", 1);
  const after = boundedContextCount(options.after, "after", 1);
  options.signal?.throwIfAborted();
  try {
    const projectsRead = ctx.get('projectsRead');
    if (projectsRead === undefined) return unresolved(source, 'Projects只读服务不可用。', 'unreadable');
    return await projectsRead.withDirectory(SessionId(source.hostSessionId), async observation => {
      const { directory, cut } = observation;
      const identity = source.kind === 'native-event' ? { projectId: source.projectId, sessionId: source.sessionId } : options.identity;
      if (identity !== undefined && (identity.projectId !== directory.owner.projectId || identity.sessionId !== directory.owner.logicalSessionId)) return unresolved(source, '来源归属不匹配。', 'invalid-source');
      const retained: Extract<RetainedNativeDirectory, { readable: true }> = { ...observation, readable: true, header: directory.header,
        projectId: directory.owner.projectId, sessionId: directory.owner.logicalSessionId, formatVersion: directory.header.version,
        hostSessionId: String(directory.header.id), sourceRevision: observation.sourceRevision, sessionCreatedAt: directory.header.createdAt,
        inheritedEventCount: Number(directory.inheritedEventCount), endSeq: cut.nextSeq - 1,
        readDecodedEvent: async seq => { const event = await observation.readEvent(seq); if (event === undefined) return undefined;
          return decodeProjectRecord(event, ctx.get('sessionPersistence') as unknown as ProjectRawPayloadReader, options.signal === undefined ? {} : {signal:options.signal}); },
      };
      return readNativeProjectSourceFromDirectory(retained, source, { ...options, before, after });
    }, options.signal === undefined ? {} : {signal:options.signal});
  } catch (error: unknown) {
    if (sessionWasNotFound(error)) return unresolved(source, "session not found");
    throw error;
  }
}

function normalizeReadOptions(value: AbortSignal | NativeProjectSourceReadOptions | undefined): NativeProjectSourceReadOptions {
  if (value === undefined) return {};
  if (isAbortSignal(value)) return { signal: value };
  return value;
}

function isAbortSignal(value: AbortSignal | NativeProjectSourceReadOptions): value is AbortSignal {
  return "aborted" in value && "addEventListener" in value && !("before" in value) && !("after" in value) && !("signal" in value);
}

function boundedContextCount(value: number | undefined, name: string, fallback: number): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > 10) {
    throw new RangeError(`${name} must be an integer between 0 and ${10}`);
  }
  return normalized;
}

function withAdjacentContext(
  entries: readonly ReadableEvent[],
  targets: readonly ReadableEvent[],
  beforeCount: number,
  afterCount: number,
  signal?: AbortSignal,
): NativeProjectSourceItem[] {
  let firstTarget = Infinity, lastTarget = -Infinity;
  for (const target of targets) { firstTarget = Math.min(firstTarget, target.eventIndex); lastTarget = Math.max(lastTarget, target.eventIndex); }
  const before: ReadableEvent[] = [];
  const after: ReadableEvent[] = [];
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (entry.eventIndex < firstTarget && beforeCount > 0) {
      before.push(entry);
      if (before.length > beforeCount) before.shift();
    }
    if (entry.eventIndex > lastTarget && after.length < afterCount) after.push(entry);
  }
  const targetKeys = new Set(targets.map(entryKey));
  const selected = new Map<string, ReadableEvent>();
  for (const entry of [...before, ...targets, ...after]) {
    signal?.throwIfAborted();
    selected.set(entryKey(entry), entry);
  }
  return [...selected.values()]
    .sort((left, right) => left.eventIndex - right.eventIndex)
    .map((entry) => ({ ...entry.item, isTarget: targetKeys.has(entryKey(entry)) }));
}

function entryKey(entry: ReadableEvent): string {
  return `${entry.eventIndex}:${entry.item.kind}:${entry.item.role}:${entry.item.messageId ?? entry.item.toolCallId ?? ""}`;
}

/** Derive stable saved refs from an actual native holder and recorded occurrence. */
function withSavedCommunicationEntries(entry: NativeProjectVisibleEvent, hostSessionId: string, sessionCreatedAt: number, events: readonly SessionEvent[], communicationRecords?: Iterable<SessionEvent>): NativeProjectVisibleEvent {
  if (!Number.isSafeInteger(sessionCreatedAt) || sessionCreatedAt < 0) return entry;
  let saved: { snapshot: CommunicationSnapshotV1; locator: CommunicationRecordLocator } | undefined;
  try {
    const event = events[entry.eventIndex];
    if (entry.item.messageId !== undefined && event !== undefined) {
      const messages = event.type === 'agent/inbox/spliced' ? event.data.inserted : event.type === 'user/message' ? [event.data] : [];
      const message = messages.find(message => String(message.id) === entry.item.messageId);
      const source = record(message?.source);
      if (source?.kind === 'project-delivery' && source.communicationFormat === 'projects-communication/v1') {
        const snapshot = snapshotCodec.decode(source.snapshot as never);
        if (snapshot.recipient.hostSessionId === hostSessionId && snapshot.deliveryId === source.deliveryId && snapshot.projectId === source.projectId) saved = {
          snapshot, locator: { kind: 'recipient-message', holder: { hostSessionId, sessionCreatedAt }, messageId: entry.item.messageId },
        };
      }
    }
    if (saved === undefined && (event?.type === 'tool/call' || event?.type === 'tool/ptc-dispatch-start') && record(event.data)?.name === 'project_send_message') {
      for (const prepared of communicationRecords ?? events) {
        if (prepared === undefined) continue;
        const preparedEvent: EventEnvelope = prepared, preparedData = record(preparedEvent.data);
        if (!['tool/project-communication', 'projects/communication'].includes(preparedEvent.type) || preparedData?.phase !== 'prepared') continue;
        const invocation = validateInvocation(preparedData.invocationSource);
        if (String(invocation.sessionId) !== hostSessionId || invocation.sessionCreatedAt !== sessionCreatedAt || Number(invocation.startEventSeq) !== Number(event.seq)
          || preparedData.operationRef !== operationReference(invocation)) continue;
        if (event.type === 'tool/call' ? event.data.name !== 'project_send_message' || event.data.callId !== invocation.callId || invocation.rootCallId !== invocation.callId
          : event.data.name !== 'project_send_message' || event.data.subCallId !== invocation.callId || event.data.rootCallId !== invocation.rootCallId) continue;
        const snapshot = snapshotCodec.decode(preparedData.snapshot as never);
        if (snapshot.sender.hostSessionId !== hostSessionId || snapshot.operationRef !== preparedData.operationRef) continue;
        saved = { snapshot, locator: { kind: 'sender-prepared', holder: { hostSessionId, sessionCreatedAt }, eventSeq: Number(prepared.seq), invocationSource: invocation } };
        break;
      }
    }
    if (saved === undefined) return entry;
    const { snapshot, locator } = saved;
    const directory = buildCommunicationContentDirectory(snapshot, locator);
    return { ...entry, item: { ...entry.item,
      communicationParts: jsonFrozen(directory.contents.map(item => item.source)),
      communicationContent: directory,
    } };
  } catch { return entry; }
}

function readableEvent(hostSessionId: string, event: SessionEvent, eventIndex: number, metadataOnly = false): ReadableEvent | undefined {
  switch (event.type) {
    case "user/message":
      if (!appendOriginOrLegacy(event)) return undefined;
      return messageReadableEvent(hostSessionId, event, eventIndex, event.data, metadataOnly);
    case "assistant/message":
    case "tool/result":
      if (!appendOriginOrLegacy(event)) return undefined;
      return messageReadableEvent(hostSessionId, event, eventIndex, event.data.message, metadataOnly);
    case "tool/call":
    case 'tool/ptc-dispatch-start':
      return toolCallReadableEvent(hostSessionId, event as unknown as EventEnvelope, eventIndex, metadataOnly);
    case 'tool/ptc-dispatch': {
      const data = record(event.data);
      const item = itemFromMessage(hostSessionId, event as unknown as EventEnvelope,
        { role: 'tool', content: data?.content, isError: data?.isError, source: { kind: 'tool', callId: data?.subCallId } }, event.type, metadataOnly);
      return item === undefined ? undefined : { eventIndex, item, ...(typeof data?.subCallId === 'string' ? { toolCallId: data.subCallId } : {}) };
    }
    default:
      return undefined;
  }
}

function appendOriginOrLegacy(event: SessionEvent): boolean {
  // 旧日志没有 surface 标记；当前明确的 replacement 仅改模型输入，不是第二份人类原文。
  return (event as { readonly surfaceOp?: unknown }).surfaceOp === undefined || isAppendSurfaceEvent(event);
}

function toolCallReadableEvent(hostSessionId: string, event: EventEnvelope, eventIndex: number, metadataOnly = false): ReadableEvent | undefined {
  const data = record(event.data);
  const callId = typeof data?.callId === "string" ? data.callId : typeof data?.subCallId === 'string' ? data.subCallId : undefined;
  const name = typeof data?.name === "string" ? data.name : undefined;
  const argumentsText = typeof data?.arguments === "string" ? data.arguments : event.type === 'tool/ptc-dispatch-start' ? metadataOnly ? '' : canonicalJson(data?.arguments) : undefined;
  if (callId === undefined || name === undefined || argumentsText === undefined) return undefined;
  const nativeSource: NativeProjectSource = { kind: "tool", hostSessionId, toolCallId: callId };
  return {
    eventIndex,
    item: {
      isTarget: false,
      seq: event.seq,
      time: event.time,
      kind: event.type,
      role: "tool",
      text: metadataOnly ? '' : `[工具调用：${name}]\n${argumentsText}`,
      ...(metadataOnly ? {} : { visibleBlocks: [{ type: 'quoted-tool-call' as const, toolCallId: callId, name, arguments: argumentsText }] }),
      visibleComplete: true,
      sourceKind: "tool",
      nativeSource,
      toolCallId: callId,
      speaker: "tool",
      recordPhase: "scheduled",
      source: { kind: "tool" },
    },
    toolCallId: callId,
  };
}

function messageReadableEvent(
  hostSessionId: string,
  event: SessionEvent,
  eventIndex: number,
  message: unknown,
  metadataOnly = false,
): ReadableEvent | undefined {
  const item = itemFromMessage(hostSessionId, event as unknown as EventEnvelope, message, event.type, metadataOnly);
  const messageId = messageIdOf(message);
  const toolCallId = toolCallIdOf(message);
  if (item === undefined || messageId === undefined) return undefined;
  return {
    eventIndex,
    item: { ...item, recordPhase: event.type === 'user/message' ? 'consumed' : event.type === 'assistant/message' ? (record(event.data)?.interrupted === true ? 'interrupted' : 'message-settled') : 'model-result',
      ...(typeof record(event.data)?.attemptId === 'string' ? { attemptId: String(record(event.data)?.attemptId) } : {}) },
    messageId,
    ...(toolCallId === undefined ? {} : { toolCallId }),
  };
}

function itemFromMessage(
  hostSessionId: string,
  event: EventEnvelope,
  message: unknown,
  kind: string,
  metadataOnly = false,
): NativeProjectSourceItem | undefined {
  const messageRecord = record(message);
  if (messageRecord === undefined) return undefined;
  const role = messageRecord.role;
  if (role !== "user" && role !== "assistant" && role !== "tool") return undefined;
  const rawSource = record(messageRecord.source);
  const source = messageSource(messageRecord);
  if (role === "user" && isModelOnlyContext(rawSource)) return undefined;
  const projection: ContentProjection = metadataOnly ? { text: '', blocks: [], attachments: [], limitations: [], hiddenExcluded: [], missingVisible: [] } : messageContent(messageRecord);
  const messageId = messageIdOf(message);
  const toolCallId = toolCallIdOf(message);
  const nativeSource: NativeProjectSource = toolCallId === undefined
    ? { kind: "message", hostSessionId, messageId: messageId ?? "" }
    : { kind: "tool", hostSessionId, toolCallId };
  if (nativeSource.kind === "message" && nativeSource.messageId.length === 0) return undefined;
  // A visible tool failure is readable content, not a missing source.
  const limitations = projection.limitations;
  const error = role === 'tool' ? record(record(event.data)?.error) : undefined;
  const visibleBlocks: readonly CommunicationVisibleBlock[] = role === 'tool' && toolCallId !== undefined
    ? [{ type: 'quoted-tool-result', toolCallId, ...(messageId === undefined ? {} : { messageId }), isError: messageRecord.isError === true,
      ...(error === undefined ? {} : { error: Object.fromEntries(['name','code','reason'].flatMap(key => typeof error[key] === 'string' ? [[key,error[key]]] : [])) }),
      content: projection.blocks as never }]
    : projection.blocks;
  const speaker = speakerFor(role, source?.kind);
  return {
    isTarget: false,
    seq: event.seq,
    time: event.time,
    kind,
    role,
    text: projection.text,
    ...(metadataOnly ? {} : { visibleBlocks }),
    visibleComplete: projection.missingVisible.length === 0,
    ...(projection.hiddenExcluded.length ? { hiddenExcluded: projection.hiddenExcluded } : {}),
    ...(projection.missingVisible.length ? { missingVisible: projection.missingVisible } : {}),
    ...(source === undefined ? {} : { sourceKind: source.kind, source }),
    nativeSource,
    ...(messageId === undefined ? {} : { messageId }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
    speaker,
    ...(projection.attachments.length === 0 ? {} : { attachments: projection.attachments }),
    ...(limitations.length === 0 ? {} : { partial: true as const, limitations }),
  };
}

function messageSource(message: Record<string, unknown>): NativeProjectMessageSource | undefined {
  const raw = record(message.source);
  const kind = typeof raw?.kind === "string" ? raw.kind : undefined;
  if (kind === undefined) return undefined;
  const source: NativeProjectMessageSource = { kind };
  if (['agent-message', 'subagent-settled', 'user-question-reply', 'skill-invocation', 'schedule', 'webhook'].includes(kind)) return structuredClone(raw) as unknown as NativeProjectMessageSource;
  if (kind === 'goal') return {
    ...source,
    ...stringFields(raw, ['goalId']),
    ...numberFields(raw, ['revision']),
    ...numberFields(raw, ['round']),
  };
  if (kind === 'project-execution-failure') {
    const run = record(raw?.run), reason = record(raw?.reason), entry = record(raw?.sessionEntry);
    return {
      ...source,
      ...stringFields(raw, ['projectId']),
      ...stringFields(raw, ['sessionId']),
      ...stringFields(raw, ['hostSessionId']),
      ...(typeof run?.turn !== 'number' || typeof run.startSeq !== 'number' || typeof run.endSeq !== 'number'
        ? {} : { run: { turn: run.turn, startSeq: run.startSeq, endSeq: run.endSeq } }),
      ...(Array.isArray(raw?.inputs) ? { inputs: raw.inputs.flatMap(failureInput) } : {}),
      ...numberFields(raw, ['failedAt']),
      ...(typeof reason?.code !== 'string' || typeof reason.message !== 'string'
        ? {} : { reason: { code: reason.code, message: reason.message } }),
      ...(entry?.kind !== 'execution' || typeof entry.sessionId !== 'string' || typeof entry.hostSessionId !== 'string'
        ? {} : { sessionEntry: { kind: 'execution', sessionId: entry.sessionId, hostSessionId: entry.hostSessionId } }),
      ...(raw?.sideEffects === 'unknown' ? { sideEffects: 'unknown' } : {}),
    };
  }
  if (kind === 'project-schedule') {
    let manual: Partial<NativeProjectMessageSource> = {}
    if (raw?.trigger === 'automatic') manual = { trigger: 'automatic' }
    else if (raw?.trigger === 'manual') {
      const manager = managerSchema.safeParse(raw.requestedBy)
      if (manager.success && typeof raw.requestId === 'string' && raw.requestId.length > 0
        && typeof raw.requestedAt === 'string' && raw.requestedAt === raw.plannedAt && utcTimeSchema.safeParse(raw.requestedAt).success
        && typeof raw.acceptedRevision === 'number' && Number.isSafeInteger(raw.acceptedRevision) && raw.acceptedRevision > 0
        && typeof raw.definitionRevision === 'number' && raw.acceptedRevision <= raw.definitionRevision) {
        manual = { trigger: 'manual', requestId: raw.requestId, requestedAt: raw.requestedAt,
          requestedBy: manager.data, acceptedRevision: raw.acceptedRevision }
      }
    }
    return { ...source, ...manual,
    ...stringFields(raw, ['projectId']),
    ...stringFields(raw, ['sessionId']),
    ...stringFields(raw, ['scheduleId']),
    ...stringFields(raw, ['occurrenceId']),
    ...stringFields(raw, ['plannedAt']),
    ...(typeof raw?.definitionRevision === 'number' ? { definitionRevision: raw.definitionRevision } : {}),
    };
  }
  if (kind !== "project-delivery") return source;
  return {
    ...source,
    ...stringFields(raw, ['projectId']),
    ...stringFields(raw, ['deliveryId']),
    ...stringFields(raw, ['senderSessionId']),
    ...stringFields(raw, ['targetSessionId']),
    ...stringFields(raw, ['intent']),
  };
}

function stringFields<K extends string>(value: Record<string, unknown> | undefined, keys: readonly K[]): Partial<Record<K, string>> {
  const result: Partial<Record<K,string>> = {};
  for (const key of keys) { const field = value?.[key]; if (typeof field === 'string') result[key] = field; }
  return result;
}
function numberFields<K extends string>(value: Record<string, unknown> | undefined, keys: readonly K[]): Partial<Record<K, number>> {
  const result: Partial<Record<K,number>> = {};
  for (const key of keys) { const field = value?.[key]; if (typeof field === 'number' && Number.isFinite(field)) result[key] = field; }
  return result;
}

function failureInput(value: unknown): NativeProjectFailureInput[] {
  const input = record(value), source = record(input?.source);
  if (input?.producer !== 'user' && input?.producer !== 'project-delivery' && input?.producer !== 'goal') return [];
  if (source?.kind !== 'message' || typeof source.hostSessionId !== 'string' || typeof source.messageId !== 'string') return [];
  return [{ producer: input.producer, source: { kind: 'message', hostSessionId: source.hostSessionId, messageId: source.messageId },
    ...(input.producer === 'project-delivery' ? {
      ...stringFields(input, ['deliveryId']),
      ...stringFields(input, ['senderSessionId']),
      ...stringFields(input, ['targetSessionId']),
    } : {}),
    ...(input.producer === 'goal' ? {
      ...stringFields(input, ['goalId']),
      ...numberFields(input, ['revision']),
      ...numberFields(input, ['round']),
    } : {}),
  }];
}

function isModelOnlyContext(source: Record<string, unknown> | undefined): boolean {
  if (source === undefined) return false;
  if (typeof source.kind === 'string' && isMainBusinessInput(source.kind)) return false;
  return source.kind === "runtime-context" || source.kind === "agent-instructions" || typeof source.form === "string";
}

function speakerFor(
  role: "user" | "assistant" | "tool",
  sourceKind: string | undefined,
): NativeProjectSpeaker {
  if (role === "assistant") return "assistant";
  if (role === "tool") return "tool";
  if (sourceKind === "user") return "user";
  if (sourceKind === "project-delivery") return "project-delivery";
  if (sourceKind === "project-execution-failure") return "system";
  return "unknown";
}

function messageIdOf(message: unknown): string | undefined {
  const id = record(message)?.id;
  return typeof id === "string" ? id : undefined;
}

function toolCallIdOf(message: unknown): string | undefined {
  const messageRecord = record(message);
  const sourceCallId = record(messageRecord?.source)?.callId;
  if (typeof sourceCallId === "string") return sourceCallId;
  const toolCallId = messageRecord?.toolCallId;
  return typeof toolCallId === "string" ? toolCallId : undefined;
}

function messageContent(message: Record<string, unknown>): ContentProjection {
  const projection = projectCommunicationVisibleBlocks(message.content, message.role === 'tool');
  const attachments = projection.blocks.flatMap(block => block.type === 'file' || block.type === 'image'
    ? [attachmentEntry(block.type, block.attachment)].filter((item): item is NativeProjectAttachment => item !== undefined) : []);
  const limitations = projection.missingVisible.map(item => item.code === 'UNSUPPORTED_BLOCK' ? '一段未支持内容无法显示' : '一段可见内容无法显示');
  return { text: communicationVisibleText(projection.blocks) || '[没有可显示的内容]', attachments,
    limitations: uniqueLimitations(limitations), blocks: projection.blocks, hiddenExcluded: projection.hiddenExcluded, missingVisible: projection.missingVisible };
}

function attachmentEntry(kind: "file" | "image", raw: unknown): NativeProjectAttachment | undefined {
  const attachment = record(raw);
  if (attachment === undefined) return undefined;
  const attachmentId = typeof attachment?.attachmentId === "string" ? attachment.attachmentId : undefined;
  if (attachmentId === undefined) return undefined;
  const name = typeof attachment.name === "string" ? attachment.name : undefined;
  const bytes = typeof attachment.bytes === "number" && Number.isSafeInteger(attachment.bytes) && attachment.bytes >= 0
    ? attachment.bytes
    : undefined;
  const mediaType = typeof attachment.mediaType === "string" ? attachment.mediaType : undefined;
  return {
    kind,
    attachmentId,
    ...(name === undefined ? {} : { name }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(mediaType === undefined ? {} : { mediaType }),
  };
}

function uniqueLimitations(limitations: readonly string[]): string[] {
  return [...new Set(limitations)];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function unresolved(source: NativeProjectSource, reason: string, code: NonNullable<NativeProjectSourceRead["code"]> = "not-found"): NativeProjectSourceRead {
  return { resolved: false, hostSessionId: source.hostSessionId, items: [], reason, code };
}

function sessionWasNotFound(error: unknown): boolean {
  return error instanceof SessionPersistenceNotFoundError;
}
