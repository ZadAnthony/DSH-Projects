import { canonicalJsonChunks } from './canonical-chunks.ts'
/** Browser-safe JSON codec and tool Schema for stable native record references. */
import type { ParameterPropertySpec } from '@deepseek-ai/dsh-tools'
import type { NativeBodySelection, NativeEventSource, NativeProjectSource } from './source-reference-types.ts'
export type * from './source-reference-types.ts'

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Native source must be an object')
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new TypeError('Native source contains an unsupported field')
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`Native source ${name} must be nonempty text`)
  return value
}
function integer(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || Object.is(value, -0)) throw new TypeError(`Native source ${name} must be an integer >= ${minimum}`)
  return value
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new TypeError('Native source digest must be sha256')
  return value
}
export function decodeNativeBodySelection(value: unknown): NativeBodySelection {
  const raw = object(value); exact(raw, ['stream', 'codec', 'digest', 'range'])
  if (raw.stream !== 'visible-blocks' && raw.stream !== 'tool-value' && raw.stream !== 'model-result') throw new TypeError('Unsupported native body stream')
  if (raw.codec !== 'canonical-json/v1') throw new TypeError('Unsupported native body codec')
  let range: NativeBodySelection['range']
  if (raw.range !== undefined) {
    const item = object(raw.range); exact(item, ['unit', 'start', 'end'])
    if (item.unit !== 'unicode-code-points') throw new TypeError('Unsupported native body range unit')
    const start = integer(item.start, 'range start'), end = integer(item.end, 'range end')
    if (end < start) throw new TypeError('Native body range is reversed')
    range = { unit: item.unit, start, end }
  }
  return { stream: raw.stream, codec: raw.codec, digest: digest(raw.digest), ...(range === undefined ? {} : { range }) }
}
/** Decode without dropping fields; unknown fields are errors at JSON/file/model boundaries. */
export function decodeNativeProjectSource(value: unknown): NativeProjectSource {
  const raw = object(value)
  if (raw.kind === 'message' || raw.kind === 'tool') {
    exact(raw, ['kind', 'hostSessionId', raw.kind === 'message' ? 'messageId' : 'toolCallId'])
    const hostSessionId = text(raw.hostSessionId, 'hostSessionId')
    return raw.kind === 'message' ? { kind: 'message', hostSessionId, messageId: text(raw.messageId, 'messageId') }
      : { kind: 'tool', hostSessionId, toolCallId: text(raw.toolCallId, 'toolCallId') }
  }
  exact(raw, ['kind', 'version', 'projectId', 'sessionId', 'hostSessionId', 'sessionCreatedAt', 'eventSpace', 'eventSeq', 'eventType', 'eventDigest', 'messageId', 'toolCallId', 'body'])
  if (raw.kind !== 'native-event' || raw.version !== 1) throw new TypeError('Unsupported native source version')
  const space = object(raw.eventSpace); exact(space, ['kind', 'formatVersion'])
  if (space.kind !== 'canonical') throw new TypeError('Native event space must be canonical')
  return { kind: 'native-event', version: 1, projectId: text(raw.projectId, 'projectId'), sessionId: text(raw.sessionId, 'sessionId'),
    hostSessionId: text(raw.hostSessionId, 'hostSessionId'), sessionCreatedAt: integer(raw.sessionCreatedAt, 'sessionCreatedAt'),
    eventSpace: { kind: 'canonical', formatVersion: integer(space.formatVersion, 'formatVersion', 1) },
    eventSeq: integer(raw.eventSeq, 'eventSeq'), eventType: text(raw.eventType, 'eventType'), eventDigest: digest(raw.eventDigest),
    ...(raw.messageId === undefined ? {} : { messageId: text(raw.messageId, 'messageId') }),
    ...(raw.toolCallId === undefined ? {} : { toolCallId: text(raw.toolCallId, 'toolCallId') }),
    ...(raw.body === undefined ? {} : { body: decodeNativeBodySelection(raw.body) }) }
}
export function decodeNativeEventSource(value: unknown): NativeEventSource {
  const source = decodeNativeProjectSource(value)
  if (source.kind !== 'native-event') throw new TypeError('An exact native-event source is required')
  return source
}
/** Stable JSON ordering used by mint, verification, source keys and durable serializers. */
export function canonicalSourceJson(value: unknown): string {
  const encode = (item: unknown): string => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) return JSON.stringify(item)
    if (Array.isArray(item)) return '[' + item.map(encode).join(',') + ']'
    if (typeof item !== 'object' || item === null || Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new TypeError('Expected lossless JSON')
    return '{' + Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => JSON.stringify(key) + ':' + encode(value)).join(',') + '}'
  }
  return encode(value)
}
export function encodeNativeProjectSource(value: NativeProjectSource): NativeProjectSource { return decodeNativeProjectSource(value) }
export function nativeProjectSourceKey(value: NativeProjectSource): string { return canonicalSourceJson(encodeNativeProjectSource(value)) }

const string: ParameterPropertySpec = { type: 'string' }
const number: ParameterPropertySpec = { type: 'integer', description: 'Nonnegative safe integer.' }
const hash: ParameterPropertySpec = { type: 'string', description: 'sha256: followed by 64 lowercase hexadecimal digits.' }
const required = (value: ParameterPropertySpec): ParameterPropertySpec => ({ ...value, required: true })
export function nativeBodySelectionParameter(): ParameterPropertySpec { return { type: 'object', additionalProperties: false, properties: {
  stream: { type: 'string', required: true, enum: ['visible-blocks', 'tool-value', 'model-result'] }, codec: { type: 'string', required: true, const: 'canonical-json/v1' }, digest: required(hash),
  range: { type: 'object', additionalProperties: false, properties: { unit: { type: 'string', required: true, const: 'unicode-code-points' }, start: required(number), end: required(number) } },
} } }
export function nativeEventSourceParameter(): ParameterPropertySpec { return { type: 'object', additionalProperties: false, properties: {
  kind: { type: 'string', required: true, const: 'native-event' }, version: { type: 'integer', required: true, const: 1 }, projectId: required(string), sessionId: required(string), hostSessionId: required(string), sessionCreatedAt: required(number),
  eventSpace: { type: 'object', required: true, additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'canonical' }, formatVersion: { type: 'integer', description: 'Positive canonical logical format version.', required: true } } },
  eventSeq: required(number), eventType: required(string), eventDigest: required(hash), messageId: string, toolCallId: string, body: nativeBodySelectionParameter(),
} } }
export function legacyNativeMessageSourceParameter(): ParameterPropertySpec { return { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'message' }, hostSessionId: required(string), messageId: required(string) } } }
export function legacyNativeToolSourceParameter(): ParameterPropertySpec { return { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'tool' }, hostSessionId: required(string), toolCallId: required(string) } } }
export function nativeProjectSourceParameter(): ParameterPropertySpec & { readonly oneOf: readonly [ParameterPropertySpec, ParameterPropertySpec, ParameterPropertySpec] } { return { oneOf: [nativeEventSourceParameter(), legacyNativeMessageSourceParameter(), legacyNativeToolSourceParameter()] } }

/** Byte-compatible strict canonical stream for host hashers and bounded readers. */
export function canonicalSourceJsonChunks(value: unknown): Generator<string> { return canonicalJsonChunks(value, 'source') }
