/** 一次现有原生Inbox发送，分别保留插入、flush和wakeup事实。 */
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { jsonFrozen, snapshotCodec } from './contract.ts';
import type { ProjectControlPort } from '../stock/project-ports.ts';
import { copyCommunicationAttachments } from './attachment-copy.ts';
import type {} from '../stock/read/index.ts';
import type {} from './events.ts';
import { renderCommunicationContent } from './content.ts';
import type { CommunicationEndpoint, CommunicationMessageSourceV1, CommunicationSnapshotV1 } from './contract.ts';
import type { CommunicationTransportFacts } from './records.ts';
import type { CommunicationDeliveryMode } from './types.ts';
export interface CommunicationNativeInputDependencies {
  readonly control: Pick<ProjectControlPort, 'deliverPreparedInput'> & Partial<Pick<ProjectControlPort, 'inspect'>>;
  assertTarget(target: CommunicationEndpoint): void;
  canDrive(hostSessionId: string): boolean;
}
export class NativeInputPort {
  constructor(private readonly ctx: Context, private readonly deps: CommunicationNativeInputDependencies) { }
  prepare(snapshot: CommunicationSnapshotV1): UserMessage {
    const source: CommunicationMessageSourceV1 = {
      kind: 'project-delivery',
      communicationFormat: 'projects-communication/v1',
      projectId: snapshot.projectId,
      deliveryId: snapshot.deliveryId,
      operationRef: snapshot.operationRef,
      senderSessionId: snapshot.sender.sessionId,
      senderHostSessionId: snapshot.sender.hostSessionId,
      targetSessionId: snapshot.recipient.sessionId,
      targetHostSessionId: snapshot.recipient.hostSessionId,
      snapshot
    };
    return jsonFrozen(createUserMessage({ source, content: renderCommunicationContent(snapshot) }));
  }
  async send(target: CommunicationEndpoint, message: UserMessage, signal: AbortSignal, assertCurrent: () => void, mode: CommunicationDeliveryMode = 'queued'): Promise<CommunicationTransportFacts> {
    let entered = false;
    try {
      signal.throwIfAborted(); assertCurrent(); this.deps.assertTarget(target);
      if (message.source.kind !== 'project-delivery' || !('snapshot' in message.source)) throw new TypeError('Communication requires its frozen receiver snapshot');
      const snapshot = snapshotCodec.decode(message.source.snapshot as never);
      if (snapshot.recipient.hostSessionId !== target.hostSessionId) throw new TypeError('Receiver physical carrier changed');
      await copyCommunicationAttachments(this.ctx.projectsRead, snapshot, target.hostSessionId, { fromSender: true, signal });
      signal.throwIfAborted(); assertCurrent(); this.deps.assertTarget(target);
      entered = true;
      const facts = await this.deps.control.deliverPreparedInput(SessionId(target.hostSessionId), message, {
        target: mode === 'direct' ? 'next-step' : 'next-turn', wakeup: this.deps.canDrive(target.hostSessionId), signal,
        prepare: session => {
          signal.throwIfAborted(); assertCurrent(); this.deps.assertTarget(target);
          if (String(session.id) !== target.hostSessionId) throw new TypeError('Receiver journal identity changed');
          session.append('projects/communication', { format: 'projects-communication-event/v1', phase: 'received', message });
        },
      });
      const admissionTarget = facts.insertion === 'not-inserted' ? 'unknown' : await this.observedAdmission(target.hostSessionId, message);
      return jsonFrozen({
        insertion: facts.insertion,
        recipientPersistence: facts.copyPersistence,
        admissionPersistence: facts.persistence,
        admissionTarget,
        wakeup: facts.wakeup === true ? 'requested' : facts.wakeup === false ? 'not-requested' : 'unknown',
        ...(facts.error === undefined ? {} : { error: { code: 'COMMUNICATION_RECIPIENT_INPUT_FAILED', message: facts.error } }),
      });
    } catch (error) {
      if (entered) return jsonFrozen({ insertion: 'unknown', recipientPersistence: 'unknown', admissionPersistence: 'unknown', wakeup: 'unknown',
        error: { code: 'COMMUNICATION_RECIPIENT_INPUT_UNCONFIRMED', message: errorText(error) } });
      return refused(signal.aborted ? 'COMMUNICATION_CANCELLED_BEFORE_SEND' : 'COMMUNICATION_TARGET_UNAVAILABLE', errorText(error));
    }
  }
  /** One target's existing control projection; never infer admission from requested mode. */
  private async observedAdmission(hostSessionId: string, message: UserMessage): Promise<'next-turn' | 'next-step' | 'unknown'> {
    try {
      const inspected = await this.deps.control.inspect?.(SessionId(hostSessionId));
      const inserted = inspected?.events.find(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(value => value.id === message.id));
      return inserted?.type === 'agent/inbox/spliced' ? inserted.data.target : 'unknown';
    } catch { return 'unknown'; }
  }
}
function refused(code: string, message: string): CommunicationTransportFacts {
  return {
    insertion: 'not-inserted',
    recipientPersistence: 'not-started',
    wakeup: 'not-requested',
    error: { code, message }
  };
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
