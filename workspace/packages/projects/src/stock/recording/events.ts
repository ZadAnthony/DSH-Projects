/** Projects-only original facts. Native events, their seqs and their writer stay native. */
import { expandAssistantStream, type AssistantStreamRecord, type ContentBlock, type LlmAttemptId } from '@deepseek-ai/dsh-llm'
import type { AgentCancelCause } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ProjectSchemaPersistence } from '../request/dispatch.ts'

export interface ProjectExecutionIdentity {
  startEventSeq: SessionSeq
  callId: string
  rootCallId: string
  name: string
  invocationId: string
  parentInvocationId?: string
}
export interface ProjectAssistantProgress {
  turn: number; step: number; attemptId: LlmAttemptId
  fromIndex: number; toIndex: number; stream: AssistantStreamRecord[]
}
export interface ProjectAssistantSettlement {
  attemptId: LlmAttemptId; eventType: 'assistant/message' | 'assistant/attempt'; eventSeq: SessionSeq
}
export type ProjectExecutionReturn = ProjectExecutionIdentity & (
  | { phase: 'value'; origin: 'body'; value: JsonValue }
  | { phase: 'rendered'; origin: 'body'; value: JsonValue; content: ContentBlock[] }
  | { phase: 'presentation-meta'; origin: 'body'; meta: JsonValue }
  | { phase: 'canonical'; origin: 'pipeline'; result: JsonValue; content: ContentBlock[] }
  | { phase: 'throw'; origin: 'body'; error: { message: string; name?: string } }
)
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'projects/assistant-progress': ProjectAssistantProgress
    'projects/assistant-settlement': ProjectAssistantSettlement
    'projects/tool-proposal': { turn: number; step: number; startEventSeq: SessionSeq; callId: string; name: string; rawArguments: string; parsedArguments: JsonValue }
    'projects/tool-execution-start': ProjectExecutionIdentity & { arguments: JsonValue }
    'projects/tool-execution-return': ProjectExecutionReturn
    'projects/tool-execution-final': ProjectExecutionIdentity & { result: JsonValue }
    'projects/agent-stop-request': { cause: AgentCancelCause; keepInbox: boolean; state: { kind: 'idle' | 'maintenance'; lastTurn: number } | { kind: 'running'; turn: number; step: number } }
  }
}

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Projects recording event requires an object')
  const data = value as Record<string, unknown>
  if (required.some(key => !Object.hasOwn(data, key)) || Object.keys(data).some(key => !required.includes(key) && !optional.includes(key))) throw new Error('Projects recording event has invalid fields')
  return data
}
const integer = (value: unknown, min = 0): boolean => Number.isSafeInteger(value) && (value as number) >= min
const text = (value: unknown): boolean => typeof value === 'string' && value.length > 0
const identityKeys = ['startEventSeq', 'callId', 'rootCallId', 'name', 'invocationId']
function identity(data: Record<string, unknown>): void {
  if (!integer(data.startEventSeq) || identityKeys.slice(1).some(key => !text(data[key])) || (data.parentInvocationId !== undefined && !text(data.parentInvocationId))) throw new Error('invalid Projects execution identity')
}
function content(value: unknown): void {
  if (!Array.isArray(value) || value.some(block => block === null || typeof block !== 'object' || !text(block.type))) throw new Error('invalid Projects tool content')
}
function result(value: unknown): void {
  const data = record(value, ['isError', 'content'], ['value', 'error', 'meta', 'additionalContexts', 'concludesTurn'])
  if (typeof data.isError !== 'boolean') throw new Error('invalid Projects tool result')
  content(data.content)
  if (data.isError ? !Object.hasOwn(data, 'error') : !Object.hasOwn(data, 'value')) throw new Error('Projects tool result is missing its outcome')
  if (data.isError) {
    if (Object.hasOwn(data, 'value')) throw new Error('Projects failed result cannot contain a successful value')
    const error = record(data.error, ['message'], ['info'])
    if (typeof error.message !== 'string') throw new Error('invalid Projects tool error')
  } else if (Object.hasOwn(data, 'error')) throw new Error('Projects successful result cannot contain an error')
  if (data.concludesTurn !== undefined && data.concludesTurn !== true) throw new Error('invalid Projects concludesTurn')
  if (data.additionalContexts !== undefined && !Array.isArray(data.additionalContexts)) throw new Error('invalid Projects result contexts')
}
function defineRecordingSchemas(persistence: ProjectSchemaPersistence): void {
  for (const type of ['projects/assistant-progress-v2', 'projects/tool-raw-v2', 'projects/tool-execution-return-v2', 'projects/tool-execution-final-v2'] as const) {
    persistence.registerProjectEventSchema(type, value => validateRawReference(type, value))
  }
  persistence.registerProjectEventSchema('projects/assistant-progress', value => {
    const data = record(value, ['turn', 'step', 'attemptId', 'fromIndex', 'toIndex', 'stream'])
    if (!integer(data.turn, 1) || !integer(data.step, 1) || !text(data.attemptId) || !integer(data.fromIndex) || !integer(data.toIndex) || (data.toIndex as number) <= (data.fromIndex as number) || !Array.isArray(data.stream)) throw new Error('invalid Projects assistant progress')
    if (expandAssistantStream(data.stream as AssistantStreamRecord[]).length !== (data.toIndex as number) - (data.fromIndex as number)) throw new Error('Projects stream range does not match its actual chunks')
  })
  persistence.registerProjectEventSchema('projects/assistant-settlement', value => {
    const data = record(value, ['attemptId', 'eventType', 'eventSeq'])
    if (!text(data.attemptId) || !['assistant/message', 'assistant/attempt'].includes(String(data.eventType)) || !integer(data.eventSeq)) throw new Error('invalid Projects assistant settlement')
  })
  persistence.registerProjectEventSchema('projects/tool-proposal', value => {
    const data = record(value, ['turn', 'step', 'startEventSeq', 'callId', 'name', 'rawArguments', 'parsedArguments'])
    if (!integer(data.turn, 1) || !integer(data.step, 1) || !integer(data.startEventSeq) || !text(data.callId) || !text(data.name) || typeof data.rawArguments !== 'string') throw new Error('invalid Projects tool proposal')
  })
  persistence.registerProjectEventSchema('projects/tool-execution-start', value => {
    const data = record(value, [...identityKeys, 'arguments'], ['parentInvocationId']); identity(data)
  })
  persistence.registerProjectEventSchema('projects/tool-execution-return', value => {
    const data = record(value, [...identityKeys, 'phase', 'origin'], ['parentInvocationId', 'value', 'result', 'content', 'meta', 'error']); identity(data)
    if (data.phase === 'value' && data.origin === 'body' && Object.hasOwn(data, 'value') && !['result', 'content', 'meta', 'error'].some(key => Object.hasOwn(data, key))) return
    if (data.phase === 'canonical' && data.origin === 'pipeline' && Object.hasOwn(data, 'result') && !['value', 'meta', 'error'].some(key => Object.hasOwn(data, key))) { result(data.result); content(data.content); return }
    if (data.phase === 'rendered' && data.origin === 'body' && Object.hasOwn(data, 'value') && !['result', 'meta', 'error'].some(key => Object.hasOwn(data, key))) { content(data.content); return }
    if (data.phase === 'presentation-meta' && data.origin === 'body' && Object.hasOwn(data, 'meta') && !['value', 'result', 'content', 'error'].some(key => Object.hasOwn(data, key))) return
    if (data.phase === 'throw' && data.origin === 'body' && !['value', 'result', 'content', 'meta'].some(key => Object.hasOwn(data, key))) {
      const error = record(data.error, ['message'], ['name'])
      if (typeof error.message === 'string' && (error.name === undefined || typeof error.name === 'string')) return
    }
    throw new Error('invalid Projects raw-return phase')
  })
  persistence.registerProjectEventSchema('projects/tool-execution-final', value => {
    const data = record(value, [...identityKeys, 'result'], ['parentInvocationId']); identity(data); result(data.result)
  })
  persistence.registerProjectEventSchema('projects/agent-stop-request', value => {
    const data = record(value, ['cause', 'keepInbox', 'state'])
    if (typeof data.keepInbox !== 'boolean') throw new Error('invalid Projects stop request')
    const cause = record(data.cause, ['kind'], ['reason'])
    if (!['user', 'parent', 'hook', 'disposed'].includes(String(cause.kind)) || (cause.kind === 'hook' ? typeof cause.reason !== 'string' : Object.hasOwn(cause, 'reason'))) throw new Error('invalid Projects stop cause')
    const state = data.state as Record<string, unknown>
    if (state?.kind === 'running') {
      record(state, ['kind', 'turn', 'step'])
      if (integer(state.turn, 1) && integer(state.step)) return
    } else if (state?.kind === 'idle' || state?.kind === 'maintenance') {
      record(state, ['kind', 'lastTurn'])
      if (integer(state.lastTurn)) return
    }
    throw new Error('invalid Projects stop state')
  })
}
const schemas = new Map<`projects/${string}`, (data: unknown) => void>()
defineRecordingSchemas({ registerProjectEventSchema: (type, validate) => { schemas.set(type, validate) } })
/** Shared by new-record decode and the canonical journal validator. */
export function validateProjectRecordingData(type: string, data: unknown): void {
  const validate = schemas.get(type as `projects/${string}`)
  if (validate === undefined) throw new Error('PROJECT_RECORDING_SCHEMA_UNAVAILABLE')
  validate(data)
}
const installed = new WeakSet<object>()
export function installProjectRecordingSchemas(persistence: ProjectSchemaPersistence): void {
  if (installed.has(persistence)) return
  for (const [type, validate] of schemas) persistence.registerProjectEventSchema(type, validate)
  installed.add(persistence)
}

/** Stable physical locator; callers retain the actual Projects event type. */
export function projectRecordingLocator(session: { id: string; header: { createdAt: number } }, event: SessionEvent): { sessionId: string; sessionCreatedAt: number; eventSeq: SessionSeq; eventType: string } {
  return { sessionId: session.id, sessionCreatedAt: session.header.createdAt, eventSeq: event.seq, eventType: event.type }
}

/** Group progress without replacing native settlements or inventing an absent tail. */
export function foldProjectAssistantProgress(events: readonly SessionEvent[]): ReadonlyMap<string, { progress: SessionEvent<'projects/assistant-progress'>[]; settlement?: SessionEvent<'projects/assistant-settlement'> }> {
  const attempts = new Map<string, { progress: SessionEvent<'projects/assistant-progress'>[]; settlement?: SessionEvent<'projects/assistant-settlement'> }>()
  for (const event of events) {
    if (event.type !== 'projects/assistant-progress' && event.type !== 'projects/assistant-settlement') continue
    const entry = attempts.get(event.data.attemptId) ?? { progress: [] }
    if (event.type === 'projects/assistant-progress') entry.progress.push(event)
    else entry.settlement = event
    attempts.set(event.data.attemptId, entry)
  }
  return attempts
}

function validateRawReference(type: string, value: unknown): void {
  const data = record(value, ['version', 'representation', 'payload', 'facts'])
  if (data.version !== 2 || !['recorded', 'legacy-derived'].includes(String(data.representation))) throw new Error('invalid Projects raw record reference')
  const payload = data.payload as Record<string, unknown>
  if (!payload || payload.version !== 1 || (data.representation === 'recorded'
    ? payload.kind !== 'projects-payload' || payload.codec !== 'projects-raw-record/v2'
    : payload.kind !== 'projects-legacy-record' || payload.codec !== 'projects-raw-record/v1')) throw new Error('invalid Projects raw record representation')
  const reference = payload.kind === 'projects-payload'
    ? record(payload, ['kind', 'version', 'codec', 'id', 'digest', 'bytes', 'owner'], ['inheritedFrom'])
    : record(payload, ['kind', 'version', 'codec', 'owner', 'seq', 'type', 'time', 'byteStart', 'byteEnd', 'rawLineDigest', 'eventDigest'])
  const owner = record(reference.owner, ['projectId', 'logicalSessionId', 'carrierId', 'createdAt'])
  if (['projectId', 'logicalSessionId', 'carrierId'].some(key => !text(owner[key])) || !integer(owner.createdAt)) throw new Error('invalid Projects raw record owner')
  const digest = (value: unknown) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
  if (payload.kind === 'projects-payload') {
    if (typeof payload.id !== 'string' || !/^[0-9a-f-]{36}$/.test(payload.id) || !digest(payload.digest) || !integer(payload.bytes)) throw new Error('invalid Projects raw payload reference')
    if (Object.hasOwn(payload, 'inheritedFrom')) {
      const inherited = record(payload.inheritedFrom, ['carrierId', 'createdAt', 'seq', 'eventDigest', 'payloadDigest'])
      if (!text(inherited.carrierId) || !integer(inherited.createdAt) || !integer(inherited.seq) || !digest(inherited.eventDigest) || !digest(inherited.payloadDigest)) throw new Error('invalid Projects raw inherited locator')
    }
  } else if (!integer(payload.seq) || payload.type !== type.replace(/-v2$/, '') || !Number.isSafeInteger(payload.time) || !integer(payload.byteStart) || !integer(payload.byteEnd)
    || (payload.byteEnd as number) <= (payload.byteStart as number) || !digest(payload.rawLineDigest) || !digest(payload.eventDigest)) throw new Error('invalid Projects raw legacy reference')
  const progress = type === 'projects/assistant-progress-v2'
  const raw = type === 'projects/tool-raw-v2'
  const returned = type === 'projects/tool-execution-return-v2'
  const facts = record(data.facts, progress ? ['turn', 'step', 'attemptId', 'fromIndex', 'toIndex']
    : raw ? ['callSeq', 'invocationId', 'phase', 'name', 'callId'] : returned ? [...identityKeys, 'phase', 'origin'] : [...identityKeys, 'isError'],
    progress ? [] : raw ? ['parentInvocationId'] : returned ? ['parentInvocationId', 'isError'] : ['parentInvocationId'])
  if (progress) {
    if (!integer(facts.turn, 1) || !integer(facts.step, 1) || !text(facts.attemptId) || !integer(facts.fromIndex) || !integer(facts.toIndex) || (facts.toIndex as number) <= (facts.fromIndex as number)) throw new Error('invalid Projects progress reference facts')
  } else if (raw) {
    if (!integer(facts.callSeq) || !text(facts.invocationId) || !text(facts.name) || !text(facts.callId) || !['start', 'return', 'throw'].includes(String(facts.phase)) || facts.parentInvocationId !== undefined && !text(facts.parentInvocationId)) throw new Error('invalid Projects tool raw reference facts')
  } else {
    identity(facts)
    if (returned) {
      const canonical = facts.phase === 'canonical'
      if (!['value', 'rendered', 'presentation-meta', 'canonical', 'throw'].includes(String(facts.phase)) || facts.origin !== (canonical ? 'pipeline' : 'body')
        || (canonical ? typeof facts.isError !== 'boolean' : Object.hasOwn(facts, 'isError'))) throw new Error('invalid Projects return reference facts')
    } else if (typeof facts.isError !== 'boolean') throw new Error('invalid Projects final reference facts')
  }
}
