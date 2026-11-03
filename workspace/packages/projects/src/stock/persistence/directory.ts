import { createHash } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { nativeSourceDigest } from '../../native-source-host.ts'
import type { ProjectRecordLocator } from './types.ts'

export function rowDigest(bytes: Uint8Array): string { return 'sha256:' + createHash('sha256').update(bytes).digest('hex') }

/** A directory entry is a locator and small facts. It never retains event.data or a body closure. */
export function recordLocator(event: SessionEvent, byteStart: number, byteEnd: number, raw: Buffer): ProjectRecordLocator {
  const data = event.data as unknown as Record<string, unknown>
  const facts: Record<string, string | number | boolean> = {}
  const payload = data?.payload as Record<string, unknown> | undefined
  if (payload?.kind === 'projects-payload' && typeof payload.id === 'string') facts.payloadId = payload.id
  if (event.type === 'projects/tool-execution-final' || event.type === 'projects/tool-execution-return' && data.phase === 'canonical') {
    const isError = (data.result as Record<string, unknown> | undefined)?.isError
    if (typeof isError === 'boolean') facts.isError = isError
  }
  const nested = ['projects/assistant-progress-v2', 'projects/tool-raw-v2', 'projects/tool-execution-return-v2', 'projects/tool-execution-final-v2'].includes(event.type)
    && data.facts !== null && typeof data.facts === 'object' ? data.facts as Record<string, unknown> : undefined
  for (const key of ['turn', 'step', 'attempt', 'callId', 'rootCallId', 'callSeq', 'startEventSeq', 'eventSeq', 'eventType', 'name', 'attemptId', 'dispatchId', 'compactionId', 'prefixLength', 'purpose', 'invocationId', 'parentInvocationId', 'subCallId', 'parentCallId', 'operationRef', 'phase', 'origin', 'isError', 'fromIndex', 'toIndex', 'throughSeq', 'childId', 'childCreatedAt', 'target', 'start', 'removedCount', 'outcome', 'interrupted']) {
    const value = nested?.[key] ?? data?.[key]
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') facts[key] = value
  }
  const message = data?.message as Record<string, unknown> | undefined
  const id = typeof data?.id === 'string' ? data.id : typeof message?.id === 'string' ? message.id : undefined
  if (id !== undefined) facts.messageId = id
  if (typeof data?.role === 'string') facts.role = data.role
  const source = (data?.source ?? message?.source) as Record<string, unknown> | undefined
  if (typeof source?.kind === 'string') facts.sourceKind = source.kind
  if (typeof source?.form === 'string') facts.sourceForm = source.form
  for (const key of ['deliveryId', 'operationRef']) if (facts[key] === undefined && typeof source?.[key] === 'string') facts[key] = source[key] as string
  if (typeof (data?.reason as Record<string, unknown> | undefined)?.kind === 'string') facts.reasonKind = (data.reason as { kind: string }).kind
  if (event.surfaceOp === 'append') facts.surfaceOp = 'append'
  else if (event.surfaceOp !== undefined) { facts.surfaceOp = 'replace'; facts.surfaceStartSeq = Number(event.surfaceOp.startSeq); facts.surfaceEndSeq = Number(event.surfaceOp.endSeq) }
  if (event.sourceEventSeqs !== undefined) { let start = Number(event.seq); for (const seq of event.sourceEventSeqs) start = Math.min(start, Number(seq)); facts.sourceGroupStart = start }
  if (event.type === 'request/header') {
    const config = (data.header as { config?: Record<string, unknown> } | undefined)?.config
    for (const key of ['provider', 'model', 'reasoningEffort']) if (typeof config?.[key] === 'string') facts[key] = config[key] as string
  }
  if (event.type === 'model/selection') for (const key of ['provider', 'model', 'reasoningEffort']) if (typeof data[key] === 'string') facts[key] = data[key] as string
  if (event.type === 'tool/result') {
    const call = message?.toolCallId ?? source?.callId
    if (typeof call === 'string') facts.callId = call
    facts.outcomeUnknown = (data.error as { code?: string } | undefined)?.code === 'TOOL_OUTCOME_UNKNOWN'
    if (event.sourceEventSeqs?.length === 1) facts.startEventSeq = Number(event.sourceEventSeqs[0])
  }
  if (event.type === 'tool/ptc-dispatch') facts.outcomeUnknown = (data.error as { code?: string } | undefined)?.code === 'TOOL_OUTCOME_UNKNOWN'
  if (event.type === 'projects/communication') {
    const invocation = data.invocationSource as Record<string, unknown> | undefined
    for (const key of ['startEventSeq', 'callId', 'rootCallId']) if (typeof invocation?.[key] === 'string' || typeof invocation?.[key] === 'number') facts[key] = invocation[key] as string | number
  }
  const inboxMetadata = event.type === 'agent/inbox/spliced' ? Object.freeze({ inserted: Object.freeze((data.inserted as { id: string; source: { kind: string; form?: string; deliveryId?: string } }[]).map(message => Object.freeze({ id: String(message.id), sourceKind: message.source.kind, ...(typeof message.source.form === 'string' ? { sourceForm: message.source.form } : {}), ...(typeof message.source.deliveryId === 'string' ? { deliveryId: message.source.deliveryId } : {}) }))) }) : undefined
  return Object.freeze({ seq: Number(event.seq), type: event.type, time: event.time, byteStart, byteEnd,
    rawLineDigest: rowDigest(raw), eventDigest: nativeSourceDigest(event), facts: Object.freeze(facts),
    ...(event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: Object.freeze(event.sourceEventSeqs.map(Number)) }), ...(inboxMetadata === undefined ? {} : { inboxMetadata }) })
}
