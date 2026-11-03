/** Host-only source minting; JSON validation and serialization remain in the shared codec. */
import { createHash } from 'node:crypto'
import { decodeNativeEventSource } from './native-source.ts'
import { canonicalJsonChunks } from './canonical-chunks.ts'
import type { NativeEventSource } from './source-reference-types.ts'

export function nativeSourceDigest(value: unknown): string { const hash = createHash('sha256'); for (const chunk of canonicalJsonChunks(value)) hash.update(chunk); return 'sha256:' + hash.digest('hex') }
export function mintNativeProjectSource(identity: { readonly projectId: string; readonly sessionId: string; readonly hostSessionId: string; readonly sessionCreatedAt: number; readonly formatVersion: number },
  event: { readonly seq: number; readonly type: string }, rawEvent: unknown,
  subject: { readonly messageId?: string; readonly toolCallId?: string } = {}): NativeEventSource {
  const raw = rawEvent as { data?: { representation?: unknown; payload?: { kind?: unknown } } } | null
  if (raw?.data?.representation === 'legacy-derived' && raw.data.payload?.kind === 'projects-legacy-record') throw new Error('PROJECT_DERIVED_RECORD_IS_NOT_CANONICAL')
  return decodeNativeEventSource({ kind: 'native-event', version: 1, projectId: identity.projectId, sessionId: identity.sessionId,
    hostSessionId: identity.hostSessionId, sessionCreatedAt: identity.sessionCreatedAt, eventSpace: { kind: 'canonical', formatVersion: identity.formatVersion },
    eventSeq: event.seq, eventType: event.type, eventDigest: nativeSourceDigest(rawEvent), ...subject })
}
export function mintNativeEventSource(input: { readonly projectId: string; readonly sessionId: string; readonly hostSessionId: string; readonly sessionCreatedAt: number; readonly formatVersion: number;
  readonly event: { readonly seq: number; readonly type: string }; readonly messageId?: string; readonly toolCallId?: string }): NativeEventSource {
  return mintNativeProjectSource(input, input.event, input.event, { ...(input.messageId === undefined ? {} : { messageId: input.messageId }), ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }) })
}
