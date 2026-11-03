/** Browser-safe shared source Schemas; communication snapshots keep their existing locator protocol. */
import type { ParameterPropertySpec } from '@deepseek-ai/dsh-tools';
import { nativeEventSourceParameter, legacyNativeMessageSourceParameter, legacyNativeToolSourceParameter } from '../native-source.ts';
export function communicationHolderSchema(): ParameterPropertySpec {
  return { type: 'object', additionalProperties: false, properties: {
    hostSessionId: { type: 'string', required: true },
    sessionCreatedAt: { type: 'integer', required: true },
  } };
}
export function communicationInvocationSchema(): ParameterPropertySpec {
  return { type: 'object', additionalProperties: false, properties: {
    sessionId: { type: 'string', required: true },
    sessionCreatedAt: { type: 'integer', required: true },
    startEventSeq: { type: 'integer', required: true },
    callId: { type: 'string', required: true },
    rootCallId: { type: 'string', required: true },
  } };
}
export function communicationRecordSchema(): ParameterPropertySpec {
  return { oneOf: [
    { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', const: 'sender-prepared', required: true },
      holder: { ...communicationHolderSchema(), required: true },
      eventSeq: { type: 'integer', required: true },
      invocationSource: { ...communicationInvocationSchema(), required: true },
    } },
    { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', const: 'recipient-message', required: true },
      holder: { ...communicationHolderSchema(), required: true },
      messageId: { type: 'string', required: true },
    } },
  ] };
}
export function communicationSavedPartSourceParameter(): ParameterPropertySpec {
  return { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', const: 'communication-part', required: true },
    holder: { ...communicationHolderSchema(), required: true }, record: { ...communicationRecordSchema(), required: true },
    deliveryId: { type: 'string', required: true }, snapshotVersion: { type: 'integer', const: 1, required: true }, partId: { type: 'string', required: true },
  } };
}
export function communicationSourceParameter(allowTool = true): ParameterPropertySpec {
  return { oneOf: allowTool ? [nativeEventSourceParameter(), legacyNativeMessageSourceParameter(), legacyNativeToolSourceParameter(), communicationSavedPartSourceParameter()]
    : [nativeEventSourceParameter(), legacyNativeMessageSourceParameter(), communicationSavedPartSourceParameter()] };
}
