/** UI-only chat projection. The exact saved item and its body/source retain their own meaning. */
import { communicationVisibleText } from './communication/visible-reader.ts';
import { communicationSavedContents } from './communication/saved-parts.ts';
import { snapshotCodec } from './communication/contract.ts';
import { codePointLength, sliceCodePoints } from './canonical-chunks.ts';
import type { CommunicationSnapshotV1, CommunicationVisibleBlock } from './communication/types.ts';
import type { NativeProjectSourceItem, RetainedNativeDirectory, PreparedNativeProjectDirectory, NativeProjectVisibleEvent } from './source-reader.ts';
import { projectRecordSemanticType } from './stock/recording/records.ts';

type Directory = Extract<RetainedNativeDirectory, { readable: true }>;
export interface ProjectChatGroup {
  readonly entries: readonly NativeProjectVisibleEvent[];
  readonly seqs: readonly number[];
  readonly latestSeq: number;
  readonly messageId?: string;
  readonly attemptId?: string;
}
const partialTypes = new Set(['assistant/attempt', 'assistant/progress', 'projects/assistant-progress']);
export function projectChatGroups(preparation: PreparedNativeProjectDirectory, metadata: readonly NativeProjectVisibleEvent[]): ProjectChatGroup[] {
  const messages = new Map<string, NativeProjectVisibleEvent[]>(), standalone: ProjectChatGroup[] = [];
  const attempts = new Map<string, { seq: number; attemptId?: string }>();
  const finalAttempts = new Set<string>();
  const attemptFor = (seq: number) => {
    const locator = preparation.bySeq.get(seq)!;
    return preparation.projection.settlements.get(`${projectRecordSemanticType(locator.type)}:${seq}`)
      ?? (typeof locator.facts.attemptId === 'string' ? locator.facts.attemptId : undefined);
  };
  for (const locator of preparation.records) if (projectRecordSemanticType(locator.type) === 'assistant/message') {
    const attempt = attemptFor(locator.seq); if (attempt !== undefined) finalAttempts.add(attempt);
  }
  for (const entry of metadata) {
    const item = entry.item, locator = preparation.bySeq.get(item.seq)!;
    const ordinary = item.kind === 'assistant/message'
      || (item.kind === 'user/message' || item.kind === 'agent/inbox/spliced') && item.role === 'user'
        && (item.sourceKind === 'user' || item.sourceKind === 'project-delivery');
    const communication = (item.kind === 'tool/call' || item.kind === 'tool/ptc-dispatch-start')
      && locator.facts.name === 'project_send_message' && (preparation.rootRecords.get(item.seq) ?? []).some(seq => {
        const record = preparation.bySeq.get(seq)!; return record.type === 'projects/communication' && record.facts.phase === 'prepared';
      });
    if (!ordinary && !communication) continue;
    if (item.messageId === undefined) standalone.push({ entries: [entry], seqs: [item.seq], latestSeq: item.seq });
    else { const values = messages.get(item.messageId) ?? []; values.push(entry); messages.set(item.messageId, values); }
  }
  for (const [messageId, entries] of messages) {
    const seqs = entries.map(entry => entry.item.seq);
    const latestSeq = seqs.reduce((left, right) => {
      const a = preparation.bySeq.get(left)!, b = preparation.bySeq.get(right)!;
      return b.time > a.time || b.time === a.time && right > left ? right : left;
    });
    const attemptId = attemptFor(latestSeq);
    standalone.push({ entries, seqs, latestSeq, messageId, ...(attemptId === undefined ? {} : { attemptId }) });
  }
  for (const locator of preparation.records) {
    if (!partialTypes.has(projectRecordSemanticType(locator.type))) continue;
    const attemptId = attemptFor(locator.seq); if (attemptId !== undefined && finalAttempts.has(attemptId)) continue;
    const key = attemptId === undefined ? `event:${locator.seq}` : `attempt:${attemptId}`;
    const previous = attempts.get(key);
    if (previous === undefined || previous.seq < locator.seq) attempts.set(key, { seq: locator.seq, ...(attemptId === undefined ? {} : { attemptId }) });
  }
  for (const { seq, attemptId } of attempts.values()) standalone.push({ entries: [], seqs: [seq], latestSeq: seq, ...(attemptId === undefined ? {} : { attemptId }) });
  return standalone;
}

function plain(blocks: readonly CommunicationVisibleBlock[] | undefined): CommunicationVisibleBlock[] {
  return (blocks ?? []).filter(block => block.type === 'text' || block.type === 'file' || block.type === 'image');
}
function endpoint(value: CommunicationSnapshotV1['sender']) {
  return { sessionId: value.sessionId, ...(value.title.trim() === '' ? {} : { title: value.title }) };
}

/** A verified communication catalogue supplies its holder; no text/JSON guessing is used. */
async function communicationSnapshot(directory: Directory, item: NativeProjectSourceItem): Promise<{ snapshot: CommunicationSnapshotV1; sent: boolean } | undefined> {
  const saved = item.communicationContent?.contents[0]?.source;
  if (saved === undefined) return undefined;
  const record = saved.record;
  let snapshot: CommunicationSnapshotV1;
  if (record.kind === 'sender-prepared') {
    const event = (await directory.readDecodedEvent(record.eventSeq))?.semantic;
    if (event?.type !== 'projects/communication' || event.data.phase !== 'prepared') return undefined;
    snapshot = snapshotCodec.decode(event.data.snapshot);
  } else {
    const event = (await directory.readDecodedEvent(item.seq))?.semantic;
    const messages = event?.type === 'user/message' ? [event.data] : event?.type === 'agent/inbox/spliced' ? event.data.inserted : [];
    const message = messages.find(value => String(value.id) === item.messageId);
    const source = message?.source as unknown as { kind?: string; communicationFormat?: string; snapshot?: never } | undefined;
    if (source?.kind !== 'project-delivery' || source.communicationFormat !== 'projects-communication/v1' || source.snapshot === undefined) return undefined;
    snapshot = snapshotCodec.decode(source.snapshot);
  }
  if (snapshot.projectId !== directory.projectId || snapshot.deliveryId !== saved.deliveryId) return undefined;
  return { snapshot, sent: record.kind === 'sender-prepared' };
}

export async function projectChatItem(directory: Directory, item: NativeProjectSourceItem): Promise<NativeProjectSourceItem | undefined> {
  let blocks = plain(item.visibleBlocks), kind: NonNullable<NativeProjectSourceItem['chat']>['kind'] = partialTypes.has(item.kind) ? 'incomplete-reply' : 'message';
  let communication: NonNullable<NativeProjectSourceItem['chat']>['communication'];
  if (item.sourceKind === 'project-delivery' || item.communicationContent !== undefined) {
    const saved = await communicationSnapshot(directory, item);
    if (saved !== undefined) {
      blocks = [];
      const parts: { group: 'agent' | 'user-message'; speaker: CommunicationSnapshotV1['userMessageParts'][number]['originalSpeaker']; range: { unit: 'unicode-code-points'; start: number; end: number } }[] = [];
      let textEnd = 0;
      for (const part of communicationSavedContents(saved.snapshot)) {
        if (part.group === 'context') continue;
        const visible = plain(part.blocks);
        if (visible.length === 0) continue;
        const start = textEnd + (blocks.length === 0 ? 0 : 1), end = start + codePointLength(communicationVisibleText(visible));
        parts.push({ group: part.group, speaker: part.speaker, range: { unit: 'unicode-code-points', start, end } });
        blocks.push(...visible); textEnd = end;
      }
      kind = 'communication';
      communication = { direction: saved.sent ? 'sent' : 'received', sender: endpoint(saved.snapshot.sender), recipient: endpoint(saved.snapshot.recipient), savedPhase: saved.sent ? 'prepared' : 'received', parts };
    } else if (item.sourceKind !== 'project-delivery' || item.communicationContent !== undefined) return undefined;
    else {
      const event = (await directory.readDecodedEvent(item.seq))?.semantic;
      const messages = event?.type === 'user/message' ? [event.data] : event?.type === 'agent/inbox/spliced' ? event.data.inserted : [];
      const message = messages.find(value => String(value.id) === item.messageId);
      const source = message?.source as unknown as { communicationFormat?: unknown } | undefined;
      if (source?.communicationFormat !== undefined) throw new Error('PROJECT_CHAT_COMMUNICATION_SOURCE_UNAVAILABLE');
      kind = 'communication'; // Legacy readable relay: preserve its original text and unknown routing.
    }
  } else if (item.role !== 'assistant' && !(item.role === 'user' && item.sourceKind === 'user')) return undefined;
  if (!blocks.some(block => block.type !== 'text' || block.text.trim() !== '')) return undefined;
  const text = communicationVisibleText(blocks), total = codePointLength(text);
  return { ...item, chat: { kind, text, visibleBlocks: blocks,
    ...(blocks.some(block => block.type === 'file' || block.type === 'image') ? { hasAttachments: true as const } : {}),
    excerpt: { unit: 'unicode-code-points', start: 0, end: total, total }, ...(communication === undefined ? {} : { communication }) } };
}

/** Excerpts are explicit chat coordinates; raw text/bodySource are separately bounded by their owner. */
export function boundChatItem(item: NativeProjectSourceItem, limit = 4096, start = 0): NativeProjectSourceItem {
  if (item.chat === undefined) return item;
  const total = codePointLength(item.chat.text);
  if (total <= limit && start === 0) return item;
  const { visibleBlocks: _blocks, ...chat } = item.chat;
  const end = Math.min(total, start + limit);
  return { ...item, chat: { ...chat, text: sliceCodePoints(chat.text, start, end), excerpt: { unit: 'unicode-code-points', start, end, total } } };
}
