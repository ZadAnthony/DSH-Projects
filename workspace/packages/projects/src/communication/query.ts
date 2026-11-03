/** 只读合并运输证据；查询不修复记录、不继续投递。 */
import type { ProjectStore } from '../records.ts';
import { jsonFrozen } from './contract.ts';
import type { CommunicationOperationRepository } from './records.ts';
import type { CommunicationTranscript } from './transcript.ts';
export interface CommunicationQueryLocator {
  readonly operationRef?: string;
  readonly deliveryId?: string;
}
export class CommunicationQuery {
  constructor(
    private readonly repository: CommunicationOperationRepository,
    private readonly transcript: CommunicationTranscript,
    private readonly store: ProjectStore) { }
  async read(projectId: string, locator: CommunicationQueryLocator) {
    if ((locator.operationRef === undefined) === (locator.deliveryId === undefined))
      throw new Error('Exactly one operationRef or deliveryId is required');
    const operation = locator.operationRef === undefined ? await this.repository.byDelivery(projectId, locator.deliveryId!) : await this.repository.get(projectId, locator.operationRef);
    if (operation === undefined) {
      const legacy = locator.deliveryId === undefined ? undefined : await this.store.getDelivery(projectId, locator.deliveryId);
      return jsonFrozen({
        found: legacy !== undefined,
        project_id: projectId,
        ...(legacy === undefined ? {
          result: 'unknown',
          reason: 'No operation record is available; this does not prove no delivery occurred.'
        } : {
          format: 'legacy',
          legacy,
          reason: 'Historical observations are retained as recorded; they do not prove a model read or an actual reply.'
        })
      });
    }
    // 删除封口可拒绝新的日志读取；它不抹掉原操作，也不能让已接纳发送的结算失败。
    // 只降级可选原生证据，参数和repository错误仍由其真实owner返回。
    const unavailable: Array<{ source: 'recipient' | 'sender' | 'sender-outcome'; reason: string }> = [];
    const observe = async <T>(source: 'recipient' | 'sender' | 'sender-outcome', read: () => Promise<T>): Promise<T | undefined> => {
      try { return await read(); }
      catch (error) { unavailable.push({ source, reason: error instanceof Error ? error.message : String(error) }); return undefined; }
    };
    const recipientRecord = operation.recipientRecord;
    const observed = recipientRecord === undefined ? undefined : await observe('recipient', () => this.transcript.observeRecipient(projectId, recipientRecord));
    // 已确认的持久事实在源/目标删除后继续有效；缺日志不能证明未发生。
    const sender = await this.transcript.observeSenderFacts(projectId, operation.invocationSource);
    unavailable.push(...sender.unavailable);
    const senderObserved = sender.record, outcomes = sender.outcomes;
    let transport = operation.transport;
    for (const value of outcomes) {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        continue;
      const candidate = value.transport;
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate))
        continue;
      if (['not-attempted', 'not-inserted', 'inserted', 'unknown'].includes(String(candidate.insertion)) && ['not-started', 'flushed', 'unavailable', 'failed', 'unknown'].includes(String(candidate.recipientPersistence)) && ['not-requested', 'requested', 'unknown'].includes(String(candidate.wakeup)))
        transport = candidate as unknown as typeof transport;
    }
    const insertion = operation.transport.insertion === 'inserted' || transport.insertion === 'inserted' || observed?.insertion === 'inserted' ? 'inserted' : transport.insertion;
    const persistence = operation.transport.recipientPersistence === 'flushed' || transport.recipientPersistence === 'flushed' || observed?.persistence === 'flushed' ? 'flushed' : transport.recipientPersistence;
    // Before separate receiver-copy events existed, the recorded successful
    // recipient barrier followed the native Inbox insertion itself. Preserve
    // that already established fact when those older logs are later deleted.
    const legacyAdmission = transport.admissionPersistence === undefined && transport.insertion === 'inserted' && transport.recipientPersistence === 'flushed';
    const admissionPersistence = operation.transport.admissionPersistence === 'flushed' || transport.admissionPersistence === 'flushed' || observed?.admissionPersistence === 'flushed' || legacyAdmission ? 'flushed' : transport.admissionPersistence ?? 'unknown';
    const requestedDeliveryMode = operation.deliveryMode ?? 'queued';
    const recordedTarget = operation.transport.admissionTarget;
    const admissionTarget = recordedTarget === 'next-turn' || recordedTarget === 'next-step' ? recordedTarget : transport.admissionTarget ?? 'unknown';
    const deliveryModeStatus = requestedDeliveryMode === 'direct'
      ? admissionTarget === 'next-step' ? 'fulfilled' : admissionTarget === 'next-turn' ? 'partial' : 'unknown'
      : admissionTarget === 'next-turn' ? 'fulfilled' : 'unknown';
    const facts = {
      ...transport,
      insertion,
      recipientPersistence: persistence,
      admissionPersistence,
      requestedDeliveryMode,
      admissionTarget,
      deliveryModeStatus,
      consumption: observed?.consumption ?? 'unknown',
      ...(recipientRecord === undefined ? {} : { consumerHostSessionId: recipientRecord.holder.hostSessionId }),
      senderPersistence: senderObserved === undefined ? operation.senderPersistence : 'flushed'
    };
    const delivered = insertion === 'inserted' && facts.recipientPersistence === 'flushed' && facts.admissionPersistence === 'flushed';
    const directUnconfirmed = delivered && requestedDeliveryMode === 'direct' && deliveryModeStatus !== 'fulfilled';
    if (directUnconfirmed && facts.error === undefined) facts.error = {
      code: deliveryModeStatus === 'partial' ? 'COMMUNICATION_DIRECT_ADMITTED_QUEUED' : 'COMMUNICATION_DIRECT_ADMISSION_UNKNOWN',
      message: deliveryModeStatus === 'partial'
        ? 'Communication was saved and admitted to next-turn; requested direct/next-step delivery was not fulfilled. The admitted message is retained; query this operation, do not resend.'
        : 'Communication was saved, but its actual Inbox target is unknown; direct delivery is not confirmed. Query this operation, do not resend.',
    };
    return jsonFrozen({
      found: true,
      format: 'projects-communication-query/v1',
      project_id: projectId,
      operation_ref: operation.operationRef,
      ...(operation.deliveryId === undefined ? {} : { delivery_id: operation.deliveryId }),
      operation,
      facts,
      result: delivered && !directUnconfirmed ? 'delivered' : operation.phase === 'registered' ? 'preparation-interrupted' : operation.phase === 'preparation-failed' ? 'not-delivered' : operation.attemptedAt === undefined ? 'not-delivered' : insertion === 'not-inserted' ? 'not-delivered' : 'unknown',
      evidence: {
        recipient: observed ?? 'not-established',
        durableOutcomes: outcomes.length,
        ...(unavailable.length === 0 ? {} : { unavailable }),
        ...(senderObserved === undefined ? {} : { senderRecord: senderObserved })
      },
      ...(operation.recipient === undefined ? {} : { target: operation.recipient }),
      ...(operation.replyTo === undefined ? {} : { reply_to_delivery_id: operation.replyTo.deliveryId })
    });
  }
}
