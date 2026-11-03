/** 完整快照只保存在发送方和接收方各自的原生聊天记录。 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { matchesCommunicationInvocation } from './invocation-source.ts';
import { copyCommunicationAttachments } from './attachment-copy.ts';
import type {} from '../stock/read/index.ts';
import type {} from './events.ts';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import { communicationDirectoryEvents, communicationDeliveryMayMatch, communicationHolder, communicationInvocationMatches, factMayMatch, messagesOf, recipientRecordMayMatch } from './directory.ts';
import type { CommunicationDirectory, CommunicationDirectoryReader } from './directory.ts';
import { canonicalJson, communicationError, jsonFrozen, operationReference, snapshotCodec, validateLocator } from './contract.ts';
import type { CommunicationInvocationSource, CommunicationRecordLocator, CommunicationReplyToV1, CommunicationSessionIdentity, CommunicationSnapshotV1 } from './contract.ts';
export class CommunicationPreparedSaveError extends Error {
  constructor(
    readonly record: Extract<CommunicationRecordLocator, {
      kind: 'sender-prepared';
    }>,
    readonly persistence: 'failed' | 'unavailable',
    message: string) { super(message); this.name = 'CommunicationPreparedSaveError'; }
}
export interface CommunicationSenderObservation {
  readonly record?: Extract<CommunicationRecordLocator, { kind: 'sender-prepared' }>;
  readonly outcomes: readonly JsonValue[];
  readonly unavailable: readonly { readonly source: 'sender' | 'sender-outcome'; readonly reason: string }[];
}
export class CommunicationTranscript {
  constructor(private readonly ctx: Context, private readonly directory: CommunicationDirectoryReader) { }
  async appendPrepared(agent: Agent, invocationSource: CommunicationInvocationSource, snapshot: CommunicationSnapshotV1, signal?: AbortSignal): Promise<Extract<CommunicationRecordLocator, {
    kind: 'sender-prepared';
  }>> {
    signal?.throwIfAborted();
    this.assertInvocation(agent, invocationSource);
    if (snapshot.operationRef !== operationReference(invocationSource) || snapshot.sender.hostSessionId !== String(agent.id))
      throw communicationError('COMMUNICATION_INVOCATION_INVALID', 'Snapshot does not belong to its actual invocation');
    await copyCommunicationAttachments(this.ctx.projectsRead, snapshot, String(agent.id), { signal });
    signal?.throwIfAborted();
    const event = agent.session.append('projects/communication', {
      format: 'projects-communication-event/v1',
      phase: 'prepared',
      invocationSource,
      operationRef: snapshot.operationRef,
      snapshot: snapshotCodec.encode(snapshot)
    });
    const locator = jsonFrozen({
      kind: 'sender-prepared' as const,
      holder: { hostSessionId: String(agent.id), sessionCreatedAt: agent.session.header.createdAt },
      eventSeq: Number(event.seq),
      invocationSource
    });
    try {
      if (!await this.ctx.sessions.flush(agent.session))
        throw new CommunicationPreparedSaveError(locator, 'unavailable', 'Sender prepared record persistence is unavailable');
    }
    catch (error) {
      if (error instanceof CommunicationPreparedSaveError)
        throw error;
      throw new CommunicationPreparedSaveError(locator, 'failed', error instanceof Error ? error.message : String(error));
    }
    return locator;
  }
  async appendOutcome(agent: Agent, invocationSource: CommunicationInvocationSource, outcome: JsonValue): Promise<void> {
    this.assertInvocation(agent, invocationSource);
    agent.session.append('projects/communication', {
      format: 'projects-communication-event/v1',
      phase: 'outcome',
      invocationSource,
      operationRef: operationReference(invocationSource),
      outcome: jsonFrozen(outcome)
    });
    if (!await this.ctx.sessions.flush(agent.session))
      throw communicationError('COMMUNICATION_OUTCOME_SAVE_UNAVAILABLE', 'Sender outcome persistence is unconfirmed');
  }
  assertInvocation(agent: Agent, source: CommunicationInvocationSource): void {
    if (!matchesCommunicationInvocation(source, agent.session, agent.session.snapshotEvents()[source.startEventSeq]))
      throw communicationError('COMMUNICATION_INVOCATION_INVALID', 'Expected the actual own root/PTC tool start occurrence');
    const event = agent.session.snapshotEvents()[source.startEventSeq];
    if ((event?.type !== 'tool/call' && event?.type !== 'tool/ptc-dispatch-start') || event.data.name !== 'project_send_message')
      throw communicationError('COMMUNICATION_INVOCATION_INVALID', 'Communication must be bound to a real project_send_message start');
  }
  async readSnapshot(projectId: string, record: CommunicationRecordLocator, signal?: AbortSignal): Promise<CommunicationSnapshotV1 | undefined> {
    validateLocator(record);
    const directory = await this.directory(projectId, record.holder.hostSessionId, signal);
    if (!directory.readable || directory.sessionCreatedAt !== record.holder.sessionCreatedAt) return undefined;
    const snapshot = await this.snapshotFromDirectory(projectId, record, directory, signal);
    await directory.revalidate();
    return snapshot;
  }
  async findReceived(projectId: string, holder: CommunicationSessionIdentity, deliveryId: string, signal?: AbortSignal): Promise<CommunicationReplyToV1 | undefined> {
    const directory = await this.directory(projectId, holder.hostSessionId, signal);
    if (!directory.readable || directory.sessionCreatedAt !== holder.sessionCreatedAt) return undefined;
    for await (const event of communicationDirectoryEvents(directory, record => (record.type === 'user/message' || record.type === 'agent/inbox/spliced')
      && communicationDeliveryMayMatch(record, deliveryId), signal)) {
      for (const message of messagesOf(event)) {
        const source = message.source;
        if (source.kind !== 'project-delivery' || source.projectId !== projectId || source.deliveryId !== deliveryId) continue;
        const receivedAt = jsonFrozen({ kind: 'recipient-message' as const, holder, messageId: String(message.id) });
        if (source.communicationFormat !== undefined) {
          if (source.communicationFormat !== 'projects-communication/v1') throw communicationError('COMMUNICATION_FORMAT_UNSUPPORTED', 'Unsupported received communication format');
          const snapshot = snapshotCodec.decode(source.snapshot as JsonValue);
          if (snapshot.projectId !== projectId || snapshot.recipient.hostSessionId !== holder.hostSessionId || snapshot.deliveryId !== deliveryId) continue;
          await directory.revalidate();
          return jsonFrozen({ deliveryId, receivedAt, sender: snapshot.sender, format: 'projects-communication/v1' as const });
        }
        await directory.revalidate();
        return jsonFrozen({ deliveryId, receivedAt, sender: { sessionId: String(source.senderSessionId), hostSessionId: 'legacy-unresolved', role: 'execution' as const, title: '' }, format: 'legacy' as const });
      }
    }
    await directory.revalidate();
    return undefined;
  }
  async observeRecipient(projectId: string, record: Extract<CommunicationRecordLocator, { kind: 'recipient-message' }>): Promise<{
    readonly insertion: 'inserted' | 'not-observed' | 'unavailable';
    readonly persistence: 'flushed' | 'unknown';
    readonly admissionPersistence: 'flushed' | 'unknown';
    readonly consumption: 'consumed' | 'not-observed' | 'unknown';
  }> {
    try {
      const directory = await this.directory(projectId, record.holder.hostSessionId);
      if (!directory.readable || directory.sessionCreatedAt !== record.holder.sessionCreatedAt)
        return { insertion: 'unavailable', persistence: 'unknown', admissionPersistence: 'unknown', consumption: 'unknown' };
      let inserted = false, saved = false, consumed = false;
      for await (const event of communicationDirectoryEvents(directory, metadata => recipientRecordMayMatch(metadata, record.messageId))) {
        if (!messagesOf(event).some(message => message.id === record.messageId)) continue;
        saved = true;
        if (event.type === 'user/message' || event.type === 'agent/inbox/spliced') inserted = true;
        if (event.type === 'user/message') consumed = true;
      }
      await directory.revalidate();
      return { insertion: inserted ? 'inserted' : 'not-observed', persistence: saved ? 'flushed' : 'unknown',
        admissionPersistence: inserted ? 'flushed' : 'unknown', consumption: consumed ? 'consumed' : 'not-observed' };
    } catch { return { insertion: 'unavailable', persistence: 'unknown', admissionPersistence: 'unknown', consumption: 'unknown' }; }
  }
  /** 同次查询只捕获一次发送方范围并核对原调用；两个阶段的读取失败分别保留。 */
  async observeSenderFacts(projectId: string, source: CommunicationInvocationSource): Promise<CommunicationSenderObservation> {
    const unavailable: Array<{ source: 'sender' | 'sender-outcome'; reason: string }> = [];
    try {
      const directory = await this.directory(projectId, String(source.sessionId));
      if (!directory.readable || !await communicationInvocationMatches(directory, source)) return { outcomes: [], unavailable };
      const observe = async <T>(kind: 'sender' | 'sender-outcome', read: () => Promise<T>): Promise<T | undefined> => {
        try { return await read(); }
        catch (error) { unavailable.push({ source: kind, reason: error instanceof Error ? error.message : String(error) }); return undefined; }
      };
      const record = await observe('sender', async () => {
        for await (const event of communicationDirectoryEvents(directory, metadata => metadata.type === 'projects/communication'
          && factMayMatch(metadata, 'phase', 'prepared') && factMayMatch(metadata, 'operationRef', operationReference(source)))) {
          if (event.type === 'projects/communication' && event.data.phase === 'prepared' && event.data.operationRef === operationReference(source)
            && canonicalJson(event.data.invocationSource) === canonicalJson(source))
            return jsonFrozen({ kind: 'sender-prepared' as const, holder: communicationHolder(directory), eventSeq: Number(event.seq), invocationSource: source });
        }
        return undefined;
      });
      const outcomes = await observe('sender-outcome', async () => {
        const values: JsonValue[] = [];
        for await (const event of communicationDirectoryEvents(directory, metadata => metadata.type === 'projects/communication'
          && factMayMatch(metadata, 'phase', 'outcome') && factMayMatch(metadata, 'operationRef', operationReference(source)))) {
          if (event.type === 'projects/communication' && event.data.phase === 'outcome' && event.data.operationRef === operationReference(source)
            && canonicalJson(event.data.invocationSource) === canonicalJson(source)) values.push(jsonFrozen(event.data.outcome));
        }
        return values;
      }) ?? [];
      await directory.revalidate();
      return { ...(record === undefined ? {} : { record }), outcomes, unavailable };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { outcomes: [], unavailable: [{ source: 'sender', reason }, { source: 'sender-outcome', reason }] };
    }
  }
  async readPreparedForInvocation(projectId: string, source: CommunicationInvocationSource): Promise<{
    readonly record: Extract<CommunicationRecordLocator, { kind: 'sender-prepared' }>;
    readonly snapshot: CommunicationSnapshotV1;
  } | undefined> {
    const directory = await this.directory(projectId, String(source.sessionId));
    if (!directory.readable || !await communicationInvocationMatches(directory, source)) return undefined;
    for await (const event of communicationDirectoryEvents(directory, record => record.type === 'projects/communication'
      && factMayMatch(record, 'phase', 'prepared') && factMayMatch(record, 'operationRef', operationReference(source)))) {
      if (event.type !== 'projects/communication' || event.data.phase !== 'prepared' || event.data.operationRef !== operationReference(source)) continue;
      const record = jsonFrozen({ kind: 'sender-prepared' as const, holder: communicationHolder(directory), eventSeq: Number(event.seq), invocationSource: source });
      const snapshot = await this.snapshotFromDirectory(projectId, record, directory);
      if (snapshot !== undefined) { await directory.revalidate(); return { record, snapshot }; }
    }
    await directory.revalidate();
    return undefined;
  }
  private async snapshotFromDirectory(projectId: string, record: CommunicationRecordLocator, directory: CommunicationDirectory, signal?: AbortSignal): Promise<CommunicationSnapshotV1 | undefined> {
    if (record.kind === 'sender-prepared') {
      const event = await directory.readEvent(record.eventSeq);
      if (event?.type !== 'projects/communication' || event.data.phase !== 'prepared' || event.data.operationRef !== operationReference(record.invocationSource)
        || canonicalJson(event.data.invocationSource) !== canonicalJson(record.invocationSource)
        || !await communicationInvocationMatches(directory, record.invocationSource)) return undefined;
      const snapshot = snapshotCodec.decode(event.data.snapshot);
      return snapshot.projectId === projectId && snapshot.operationRef === event.data.operationRef && snapshot.sender.hostSessionId === record.holder.hostSessionId ? snapshot : undefined;
    }
    let fallback: ReturnType<typeof messagesOf>[number] | undefined;
    for await (const event of communicationDirectoryEvents(directory, metadata => recipientRecordMayMatch(metadata, record.messageId), signal)) {
      const message = messagesOf(event).find(message => message.id === record.messageId);
      if (message === undefined) continue;
      if (event.type === 'projects/communication') { fallback = message; break; }
      fallback ??= message;
    }
    const source = fallback?.source;
    if (source?.kind !== 'project-delivery' || source.communicationFormat !== 'projects-communication/v1' || source.projectId !== projectId) return undefined;
    const snapshot = snapshotCodec.decode(source.snapshot as JsonValue);
    return snapshot.recipient.hostSessionId === record.holder.hostSessionId ? snapshot : undefined;
  }
}
export function findRecipientMessage(events: readonly SessionEvent[], messageId: string) {
  for (const event of events) {
    if (event.type === 'user/message' && String(event.data.id) === messageId)
      return event.data;
    if (event.type === 'agent/inbox/spliced') {
      const message = event.data.inserted.find(message => String(message.id) === messageId);
      if (message !== undefined)
        return message;
    }
  }
  return undefined;
}
/** A saved receiver copy does not imply Inbox admission or consumption. */
export function findSavedRecipientMessage(events: readonly SessionEvent[], messageId: string) {
  for (const event of events) if (event.type === 'projects/communication' && event.data.phase === 'received' && String(event.data.message.id) === messageId) return event.data.message;
  return findRecipientMessage(events, messageId);
}
