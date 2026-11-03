/** 无正文通信事实codec与repository；物理提交只复用ProjectStore原子写队列。 */
import type { ProjectStore } from '../records.ts';
import type { CommunicationOperation, CommunicationOperationCollection } from './types.ts';
import { array, decodeCommunicationFailure, exact, jsonFrozen, object, text, validateEndpoint, validateInvocation, validateLocator } from './contract.ts';
export type {
  CommunicationInsertion,
  CommunicationPersistence,
  CommunicationTransportFacts,
  CommunicationOperationPhase,
  CommunicationOperation,
  CommunicationOperationCollection,
  CommunicationFailure,
  CommunicationSourceFailure,
} from './types.ts';

export function decodeOperation(value: unknown): CommunicationOperation {
  const raw = object(value, 'communication operation');
  exact(raw, [
    'format',
    'projectId',
    'operationRef',
    'invocationSource',
    'argumentsFormat',
    'argumentsDigest',
    'deliveryMode',
    'registeredAt',
    'updatedAt',
    'phase',
    'sender',
    'deliveryId',
    'recipient',
    'replyTo',
    'nativeMessageId',
    'snapshotDigest',
    'senderRecord',
    'recipientRecord',
    'senderPersistence',
    'attemptedAt',
    'transport',
    'failure'
  ]);
  if (raw.format !== 'projects-communication-operation/v1' || raw.argumentsFormat !== 'projects-communication-arguments/v1')
    throw new Error('Unsupported communication operation format');
  for (const key of ['projectId', 'operationRef', 'argumentsDigest', 'registeredAt', 'updatedAt'])
    text(raw[key], key);
  if (raw.deliveryMode !== undefined && raw.deliveryMode !== 'queued' && raw.deliveryMode !== 'direct')
    throw new Error('Invalid communication delivery mode');
  validateInvocation(raw.invocationSource);
  validateEndpoint(raw.sender);
  if (!['registered', 'preparation-failed', 'prepared', 'attempted', 'settled'].includes(String(raw.phase)))
    throw new Error('Invalid communication phase');
  for (const key of ['deliveryId', 'nativeMessageId', 'snapshotDigest', 'attemptedAt'])
    if (raw[key] !== undefined)
      text(raw[key], key);
  if (raw.recipient !== undefined)
    validateEndpoint(raw.recipient);
  if (raw.senderRecord !== undefined && validateLocator(raw.senderRecord).kind !== 'sender-prepared')
    throw new Error('Invalid sender record');
  if (raw.recipientRecord !== undefined && validateLocator(raw.recipientRecord).kind !== 'recipient-message')
    throw new Error('Invalid recipient record');
  if (raw.replyTo !== undefined) {
    const reply = object(raw.replyTo, 'reply');
    exact(reply, ['deliveryId', 'receivedAt', 'sender', 'format']);
    text(reply.deliveryId, 'reply delivery id');
    if (validateLocator(reply.receivedAt).kind !== 'recipient-message')
      throw new Error('Invalid reply receivedAt');
    validateEndpoint(reply.sender);
    if (reply.format !== 'legacy' && reply.format !== 'projects-communication/v1')
      throw new Error('Unsupported reply format');
  }
  persistence(raw.senderPersistence);
  const facts = object(raw.transport, 'transport');
  exact(facts, ['insertion', 'recipientPersistence', 'admissionPersistence', 'admissionTarget', 'wakeup', 'error']);
  if (facts.admissionTarget !== undefined && !['next-turn', 'next-step', 'unknown'].includes(String(facts.admissionTarget)))
    throw new Error('Invalid communication admission target');
  if (!['not-attempted', 'not-inserted', 'inserted', 'unknown'].includes(String(facts.insertion)))
    throw new Error('Invalid insertion');
  persistence(facts.recipientPersistence);
  if (facts.admissionPersistence !== undefined) persistence(facts.admissionPersistence);
  if (!['not-requested', 'requested', 'unknown'].includes(String(facts.wakeup)))
    throw new Error('Invalid wakeup');
  if (raw.failure !== undefined) decodeCommunicationFailure(raw.failure);
  if (facts.error !== undefined) {
    const error = object(facts.error, 'transport error');
    exact(error, ['code', 'message']);
    text(error.code, 'transport error code');
    text(error.message, 'transport error message');
  }
  const established = raw.deliveryId !== undefined;
  if (established !== (raw.recipient !== undefined && raw.nativeMessageId !== undefined && raw.snapshotDigest !== undefined && raw.recipientRecord !== undefined))
    throw new Error('Incomplete communication identity');
  if (['attempted', 'settled'].includes(String(raw.phase)) && (!established || raw.senderRecord === undefined || raw.senderPersistence !== 'flushed' || raw.attemptedAt === undefined))
    throw new Error('Attempt requires durable sender snapshot and fixed message');
  return jsonFrozen(raw) as unknown as CommunicationOperation;
}
function persistence(value: unknown): void {
  if (!['not-started', 'flushed', 'unavailable', 'failed', 'unknown'].includes(String(value)))
    throw new Error('Invalid persistence fact');
}
export function decodeOperationCollection(value: unknown): CommunicationOperationCollection {
  if (value === undefined)
    return jsonFrozen({ format: 'projects-communication-operations/v1', operations: [] });
  const raw = object(value, 'communication collection');
  exact(raw, ['format', 'operations']);
  if (raw.format !== 'projects-communication-operations/v1')
    throw new Error('Unsupported communication operation collection');
  const operations = array(raw.operations, 'operations').map(decodeOperation);
  if (new Set(operations.map(row => row.operationRef)).size !== operations.length)
    throw new Error('Duplicate operation identity');
  const deliveries = operations.flatMap(row => row.deliveryId === undefined ? [] : [row.deliveryId]);
  if (new Set(deliveries).size !== deliveries.length)
    throw new Error('Duplicate communication delivery identity');
  return jsonFrozen({ format: 'projects-communication-operations/v1', operations });
}
export class CommunicationOperationRepository {
  constructor(private readonly store: ProjectStore) { }
  list(projectId: string): Promise<readonly CommunicationOperation[]> { return this.store.listCommunicationOperations(projectId); }
  async get(projectId: string, operationRef: string): Promise<CommunicationOperation | undefined> { return (await this.list(projectId)).find(row => row.operationRef === operationRef); }
  async byDelivery(projectId: string, deliveryId: string): Promise<CommunicationOperation | undefined> { return (await this.list(projectId)).find(row => row.deliveryId === deliveryId); }
  register(operation: CommunicationOperation): Promise<{
    readonly created: boolean;
    readonly operation: CommunicationOperation;
  }> { return this.store.registerCommunicationOperation(decodeOperation(operation)); }
  update(operation: CommunicationOperation, expectedPrevious: CommunicationOperation): Promise<CommunicationOperation> {
    return this.store.updateCommunicationOperation(decodeOperation(operation), decodeOperation(expectedPrevious));
  }
}

/** Also accepts the stable error shape across owner boundaries; the current row is still codec checked. */
export function communicationOperationConflict(error: unknown): CommunicationOperation | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 'COMMUNICATION_OPERATION_CONFLICT' || !('current' in error)) return undefined;
  return decodeOperation(error.current);
}
