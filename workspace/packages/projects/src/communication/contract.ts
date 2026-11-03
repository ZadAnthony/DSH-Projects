/** 通信快照codec与host专用身份摘要；跨face纯类型使用types.ts。 */
import { createHash } from 'node:crypto';
import { canonicalJsonChunks as encodedChunks, codePointLength, sliceCodePoints } from '../canonical-chunks.ts';
import { decodeNativeProjectSource } from '../native-source.ts';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type {
  CommunicationEndpoint,
  CommunicationFailure,
  CommunicationSourceFailure,
  CommunicationInvocationSource,
  CommunicationPartV1,
  CommunicationRecordLocator,
  CommunicationSendArgs,
  CommunicationSnapshotCodec,
  CommunicationSnapshotV1,
  CommunicationSource,
} from './types.ts';
export type * from './types.ts';

export class CommunicationError extends Error {
  constructor(readonly code: string, message: string, readonly details?: JsonValue) {
    super(message);
    this.name = 'CommunicationError';
  }
}
export function communicationError(code: string, message: string, details?: JsonValue): CommunicationError {
  return new CommunicationError(code, message, details);
}
/** P3缺项只允许有限字段和已知缺项码；绝不复制任意error.details到索引。 */
export function decodeCommunicationSourceFailures(value: unknown): readonly CommunicationSourceFailure[] {
  const failures = array(value, 'source failures');
  if (failures.length === 0) throw communicationError('COMMUNICATION_FORMAT_INVALID', 'Source failures must identify at least one selected source');
  for (const failure of failures) {
    const item = object(failure, 'source failure');
    exact(item, ['group', 'index', 'source', 'missing']);
    if (item.group !== 'user-message' && item.group !== 'context') throw communicationError('COMMUNICATION_FORMAT_INVALID', 'Invalid source failure group');
    integer(item.index, 'source failure index');
    validateSource(item.source);
    const missing = array(item.missing, 'source failure missing');
    if (missing.length === 0) throw communicationError('COMMUNICATION_FORMAT_INVALID', 'Source failure must identify a missing item');
    for (const entry of missing) {
      const detail = object(entry, 'source missing item');
      exact(detail, ['code', 'blockIndex']);
      if (!['SOURCE_UNAVAILABLE', 'MISSING_BLOCK', 'UNSUPPORTED_BLOCK', 'ATTACHMENT_UNAVAILABLE', 'PARTIAL_RANGE'].includes(String(detail.code))) {
        throw communicationError('COMMUNICATION_FORMAT_INVALID', 'Unsupported source missing code');
      }
      if (detail.blockIndex !== undefined) integer(detail.blockIndex, 'source missing block index');
    }
  }
  return jsonFrozen(failures) as unknown as readonly CommunicationSourceFailure[];
}

export function decodeCommunicationFailure(value: unknown): CommunicationFailure {
  const failure = object(value, 'communication failure');
  exact(failure, ['code', 'message', 'sourceFailures']);
  text(failure.code, 'failure code');
  text(failure.message, 'failure message');
  if (failure.sourceFailures !== undefined) {
    if (failure.code !== 'COMMUNICATION_SOURCES_INCOMPLETE') throw communicationError('COMMUNICATION_FORMAT_INVALID', 'Source failures belong only to P3 source preparation errors');
    decodeCommunicationSourceFailures(failure.sourceFailures);
  }
  return jsonFrozen(failure) as unknown as CommunicationFailure;
}

export function jsonFrozen<T>(value: T): T {
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw communicationError('COMMUNICATION_FORMAT_INVALID', 'Expected JSON value');
  const copy: T = JSON.parse(encoded);
  const freeze = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value))
      return;
    for (const item of Object.values(value))
      freeze(item);
    Object.freeze(value);
  };
  freeze(copy);
  return copy;
}
/** Check the discarded JSON encoding without copying any body strings. */
export function validateJsonSerialization(value: unknown): void {
  const active = new Set<object>();
  const visit = (input: unknown, key: string): void => {
    if (input !== null && (typeof input === 'object' || typeof input === 'function' || typeof input === 'bigint')) {
      const toJSON = (input as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === 'function') input = Reflect.apply(toJSON, input, [key]);
    }
    if (input instanceof Number) input = Number(input);
    else if (input instanceof String) input = String(input);
    else if (input instanceof Boolean) input = Boolean.prototype.valueOf.call(input);
    else if (input instanceof BigInt) input = BigInt.prototype.valueOf.call(input);
    if (typeof input === 'bigint') throw new TypeError('Do not know how to serialize a BigInt');
    if (input === null || typeof input !== 'object') return;
    if (active.has(input)) throw new TypeError('Converting circular structure to JSON');
    active.add(input);
    if (Array.isArray(input)) for (let index = 0, length = input.length; index < length; index++) visit(input[index], String(index));
    else for (const childKey of Object.keys(input)) visit((input as Record<string, unknown>)[childKey], childKey);
    active.delete(input);
  };
  visit(value, '');
}
export function canonicalJson(value: unknown): string {
  let result = '';
  for (const chunk of canonicalJsonChunks(value)) result += chunk;
  return result;
}
/** Exact existing canonical bytes, emitted without cloning or escaping the whole body. */
export function* canonicalJsonChunks(value: unknown): Generator<string> {
  try { yield* encodedChunks(value, 'communication'); }
  catch (error) {
    if (error instanceof TypeError && error.message === 'Expected lossless JSON') throw communicationError('COMMUNICATION_FORMAT_INVALID', 'Expected lossless JSON');
    throw error;
  }
}
export function countCanonicalJsonPoints(value: unknown): number {
  let total = 0;
  for (const chunk of canonicalJsonChunks(value)) total += codePointLength(chunk);
  return total;
}
/** Retain only this bounded range while counting and validating the complete canonical stream. */
export function canonicalJsonWindow(value: unknown, start: number, end: number): { text: string; total: number } {
  const selected: string[] = [];
  let total = 0;
  for (const chunk of canonicalJsonChunks(value)) {
    const length = codePointLength(chunk);
    if (total < end && total + length > start) selected.push(sliceCodePoints(chunk, Math.max(0, start - total), Math.min(length, end - total)));
    total += length;
  }
  return { text: selected.join(''), total };
}
export function digestJson(value: unknown): string {
  const hash = createHash('sha256');
  for (const chunk of canonicalJsonChunks(value)) hash.update(chunk);
  return 'sha256:' + hash.digest('hex');
}
export function operationReference(source: CommunicationInvocationSource): string {
  return 'communication-op-v1:' + digestJson(source).slice('sha256:'.length);
}
export function canonicalSendArgs(args: CommunicationSendArgs): {
  readonly format: 'projects-communication-arguments/v1';
  readonly digest: string;
} {
  return {
    format: 'projects-communication-arguments/v1',
    digest: digestJson({
      target_session_id: args.target_session_id ?? null,
      reply_to_delivery_id: args.reply_to_delivery_id ?? null,
      message: args.message ?? null,
      user_message_refs: args.user_message_refs ?? [],
      context_refs: args.context_refs ?? [],
      // Preserve the exact pre-mode digest for omitted/explicit queued calls.
      ...(args.delivery_mode === 'direct' ? { delivery_mode: 'direct' } : {}),
    })
  };
}
export function validateSendArgs(value: unknown): CommunicationSendArgs {
  const raw = object(value, 'send arguments');
  exact(raw, ['target_session_id', 'reply_to_delivery_id', 'message', 'user_message_refs', 'context_refs', 'delivery_mode']);
  if (raw.delivery_mode !== undefined && raw.delivery_mode !== 'queued' && raw.delivery_mode !== 'direct')
    throw communicationError('COMMUNICATION_ARGUMENTS_INVALID', 'delivery_mode must be queued or direct');
  for (const key of ['target_session_id', 'reply_to_delivery_id'])
    if (raw[key] !== undefined)
      text(raw[key], key);
  if ((raw.target_session_id === undefined) === (raw.reply_to_delivery_id === undefined))
    throw communicationError('COMMUNICATION_ARGUMENTS_INVALID', 'Exactly one of target_session_id and reply_to_delivery_id is required');
  if (raw.message !== undefined && typeof raw.message !== 'string')
    throw communicationError('COMMUNICATION_ARGUMENTS_INVALID', 'message must be a string');
  for (const key of ['user_message_refs', 'context_refs'])
    if (raw[key] !== undefined)
      for (const source of array(raw[key], key))
        validateSource(source);
  if (!(typeof raw.message === 'string' && raw.message.trim().length > 0) && !(Array.isArray(raw.user_message_refs) && raw.user_message_refs.length) && !(Array.isArray(raw.context_refs) && raw.context_refs.length))
    throw communicationError('COMMUNICATION_ARGUMENTS_INVALID', 'At least one actual content item is required');
  return jsonFrozen(raw) as unknown as CommunicationSendArgs;
}
export const snapshotCodec: CommunicationSnapshotCodec = {
  encode(snapshot) { return jsonFrozen(validateSnapshot(snapshot)) as unknown as JsonValue; },
  decode(value) { return jsonFrozen(validateSnapshot(value)); },
  identity(snapshot) { return digestJson(validateSnapshot(snapshot)); },
};
export function validateSnapshot(value: unknown): CommunicationSnapshotV1 {
  const raw = object(value, 'communication snapshot');
  exact(raw, [
    'format',
    'snapshotVersion',
    'projectId',
    'deliveryId',
    'operationRef',
    'sender',
    'recipient',
    'createdAt',
    'replyTo',
    'agentMessage',
    'userMessageParts',
    'contextParts'
  ]);
  if (raw.format !== 'projects-communication/v1' || raw.snapshotVersion !== 1)
    throw communicationError('COMMUNICATION_FORMAT_UNSUPPORTED', 'Unsupported communication snapshot format');
  for (const key of ['projectId', 'deliveryId', 'operationRef', 'createdAt'])
    text(raw[key], key);
  validateEndpoint(raw.sender);
  validateEndpoint(raw.recipient);
  if (raw.agentMessage !== undefined && typeof raw.agentMessage !== 'string')
    throw communicationError('COMMUNICATION_FORMAT_INVALID', 'agentMessage must be a string');
  const ids = new Set<string>();
  for (const key of ['userMessageParts', 'contextParts'])
    for (const part of array(raw[key], key)) {
      validatePart(part);
      const id = (part as CommunicationPartV1).id;
      if (ids.has(id))
        throw communicationError('COMMUNICATION_FORMAT_INVALID', 'Duplicate communication part id');
      ids.add(id);
      if (key === 'userMessageParts' && (part as CommunicationPartV1).originalSpeaker !== 'user')
        throw communicationError('COMMUNICATION_FORMAT_INVALID', 'userMessageParts must retain verified human-user identity');
    }
  if (raw.replyTo !== undefined) {
    const reply = object(raw.replyTo, 'replyTo');
    exact(reply, ['deliveryId', 'receivedAt', 'sender', 'format']);
    text(reply.deliveryId, 'reply delivery id');
    validateLocator(reply.receivedAt);
    validateEndpoint(reply.sender);
    if (object(reply.receivedAt, 'receivedAt').kind !== 'recipient-message' || (reply.format !== 'legacy' && reply.format !== 'projects-communication/v1'))
      throw communicationError('COMMUNICATION_FORMAT_INVALID', 'Invalid reply evidence');
  }
  return raw as unknown as CommunicationSnapshotV1;
}
export function validateInvocation(value: unknown): CommunicationInvocationSource {
  const raw = object(value, 'invocationSource');
  exact(raw, ['sessionId', 'sessionCreatedAt', 'startEventSeq', 'callId', 'rootCallId']);
  for (const key of ['sessionId', 'callId', 'rootCallId'])
    text(raw[key], key);
  integer(raw.sessionCreatedAt, 'sessionCreatedAt');
  integer(raw.startEventSeq, 'startEventSeq');
  return raw as unknown as CommunicationInvocationSource;
}
export function validateEndpoint(value: unknown): CommunicationEndpoint {
  const raw = object(value, 'endpoint');
  exact(raw, ['sessionId', 'hostSessionId', 'role', 'title']);
  text(raw.sessionId, 'sessionId');
  text(raw.hostSessionId, 'hostSessionId');
  if (raw.role !== 'main' && raw.role !== 'execution')
    throw communicationError('COMMUNICATION_FORMAT_INVALID', 'Invalid work-session role');
  if (typeof raw.title !== 'string')
    throw communicationError('COMMUNICATION_FORMAT_INVALID', 'Invalid title');
  return raw as unknown as CommunicationEndpoint;
}
export function validateLocator(value: unknown): CommunicationRecordLocator {
  const raw = object(value, 'record locator');
  const holder = object(raw.holder, 'holder');
  exact(holder, ['hostSessionId', 'sessionCreatedAt']);
  text(holder.hostSessionId, 'holder.hostSessionId');
  integer(holder.sessionCreatedAt, 'holder.sessionCreatedAt');
  if (raw.kind === 'sender-prepared') {
    exact(raw, ['kind', 'holder', 'eventSeq', 'invocationSource']);
    integer(raw.eventSeq, 'eventSeq');
    validateInvocation(raw.invocationSource);
  }
  else if (raw.kind === 'recipient-message') {
    exact(raw, ['kind', 'holder', 'messageId']);
    text(raw.messageId, 'messageId');
  }
  else
    throw communicationError('COMMUNICATION_FORMAT_INVALID', 'Unknown record locator kind');
  return raw as unknown as CommunicationRecordLocator;
}
export function validateSource(value: unknown): CommunicationSource {
  const raw = object(value, 'source');
  if (raw.kind === 'native-event') return decodeNativeProjectSource(raw);
  if (raw.kind === 'message') {
    exact(raw, ['kind', 'hostSessionId', 'messageId']);
    text(raw.hostSessionId, 'hostSessionId');
    text(raw.messageId, 'messageId');
  }
  else if (raw.kind === 'tool') {
    exact(raw, ['kind', 'hostSessionId', 'toolCallId']);
    text(raw.hostSessionId, 'hostSessionId');
    text(raw.toolCallId, 'toolCallId');
  }
  else if (raw.kind === 'communication-part') {
    exact(raw, ['kind', 'holder', 'record', 'deliveryId', 'snapshotVersion', 'partId']);
    validateLocator(raw.record);
    const holder = object(raw.holder, 'source holder');
    exact(holder, ['hostSessionId', 'sessionCreatedAt']);
    text(holder.hostSessionId, 'hostSessionId');
    integer(holder.sessionCreatedAt, 'sessionCreatedAt');
    text(raw.deliveryId, 'deliveryId');
    text(raw.partId, 'partId');
    if (raw.snapshotVersion !== 1)
      throw communicationError('COMMUNICATION_FORMAT_UNSUPPORTED', 'Unsupported saved part version');
  }
  else
    throw communicationError('COMMUNICATION_FORMAT_INVALID', 'Unknown source kind');
  return raw as unknown as CommunicationSource;
}
function validatePart(value: unknown): void {
  const raw = object(value, 'part');
  exact(raw, [
    'id',
    'selectedBy',
    'originalSpeaker',
    'producer',
    'origin',
    'originEventSeq',
    'originTime',
    'acquiredFrom',
    'version',
    'sourceChain',
    'blocks'
  ]);
  text(raw.id, 'part id');
  integer(raw.originEventSeq, 'originEventSeq');
  integer(raw.originTime, 'originTime');
  if (!['user', 'assistant', 'project-delivery', 'system', 'tool', 'unknown'].includes(String(raw.originalSpeaker)))
    throw communicationError('COMMUNICATION_FORMAT_INVALID', 'Invalid originalSpeaker');
  const selected = object(raw.selectedBy, 'selectedBy');
  exact(selected, ['group', 'index']);
  integer(selected.index, 'selectedBy.index');
  if (selected.group !== 'user-message' && selected.group !== 'context')
    throw communicationError('COMMUNICATION_FORMAT_INVALID', 'Invalid selectedBy group');
  const producer = object(raw.producer, 'producer');
  exact(producer, [
    'kind',
    'projectId',
    'deliveryId',
    'senderSessionId',
    'targetSessionId',
    'sessionId',
    'scheduleId',
    'occurrenceId',
    'goalId',
    'revision',
    'round'
  ]);
  for (const [key, value] of Object.entries(producer))
    if (['revision', 'round'].includes(key))
      integer(value, key);
    else
      text(value, key);
  const origin = validateSource(raw.origin);
  if (origin.kind === 'communication-part')
    throw communicationError('COMMUNICATION_FORMAT_INVALID', 'Part origin must be native');
  validateSource(raw.acquiredFrom);
  for (const source of array(raw.sourceChain, 'sourceChain'))
    validateSource(source);
  const version = object(raw.version, 'part version');
  exact(version, ['sessionCreatedAt', 'prefixEventCount', 'contentDigest']);
  integer(version.sessionCreatedAt, 'sessionCreatedAt');
  integer(version.prefixEventCount, 'prefixEventCount');
  text(version.contentDigest, 'contentDigest');
  for (const block of array(raw.blocks, 'blocks'))
    validateVisibleBlock(block);
}
function validateVisibleBlock(value: unknown, plainOnly = false): void {
  const raw = object(value, 'visible block');
  if (raw.type === 'text') {
    exact(raw, ['type', 'text']);
    if (typeof raw.text !== 'string')
      throw communicationError('COMMUNICATION_FORMAT_INVALID', 'Invalid text block');
    return;
  }
  if (raw.type === 'file' || raw.type === 'image') {
    exact(raw, raw.type === 'image' ? ['type', 'attachment', 'offloaded'] : ['type', 'attachment']);
    const ref = object(raw.attachment, 'attachment');
    text(ref.attachmentId, 'attachmentId');
    if (raw.offloaded !== undefined && raw.offloaded !== true)
      throw communicationError('COMMUNICATION_FORMAT_INVALID', 'Invalid image offloaded flag');
    return;
  }
  if (!plainOnly && raw.type === 'quoted-tool-call') {
    exact(raw, ['type', 'toolCallId', 'name', 'arguments']);
    text(raw.toolCallId, 'toolCallId');
    text(raw.name, 'name');
    if (typeof raw.arguments !== 'string')
      throw communicationError('COMMUNICATION_FORMAT_INVALID', 'Invalid quoted arguments');
    return;
  }
  if (!plainOnly && raw.type === 'quoted-tool-result') {
    exact(raw, ['type', 'toolCallId', 'messageId', 'isError', 'error', 'content']);
    text(raw.toolCallId, 'toolCallId');
    if (raw.messageId !== undefined)
      text(raw.messageId, 'messageId');
    if (typeof raw.isError !== 'boolean')
      throw communicationError('COMMUNICATION_FORMAT_INVALID', 'Invalid quoted isError');
    if (raw.error !== undefined) {
      const error = object(raw.error, 'tool error');
      exact(error, ['name', 'code', 'reason']);
      for (const value of Object.values(error))
        if (typeof value !== 'string')
          throw communicationError('COMMUNICATION_FORMAT_INVALID', 'Invalid quoted error');
    }
    ;
    for (const part of array(raw.content, 'quoted content'))
      validateVisibleBlock(part, true);
    return;
  }
  throw communicationError('COMMUNICATION_FORMAT_UNSUPPORTED', 'Unsupported visible block type');
}
export function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw communicationError('COMMUNICATION_FORMAT_INVALID', 'Expected object: ' + label);
  return value as Record<string, unknown>;
}
export function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const unknown = Object.keys(value).filter(key => !keys.includes(key));
  if (unknown.length)
    throw communicationError('COMMUNICATION_ARGUMENTS_INVALID', 'Unsupported fields: ' + unknown.join(', '));
}
export function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw communicationError('COMMUNICATION_FORMAT_INVALID', 'Expected nonempty string: ' + label);
  return value;
}
export function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw communicationError('COMMUNICATION_FORMAT_INVALID', 'Expected nonnegative integer: ' + label);
  return value;
}
export function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value))
    throw communicationError('COMMUNICATION_FORMAT_INVALID', 'Expected array: ' + label);
  return value;
}
