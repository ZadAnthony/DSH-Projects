/** Query-only metadata shapes. These are never Session seeds or canonical records. */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectRecordLocator } from './stock/persistence/types.ts'
import { isMainBusinessInput } from './continuity/business-input.ts'
import { projectRecordSemanticType } from './stock/recording/records.ts'

export const projectVisibleRecordTypes: ReadonlySet<string> = new Set([
  'user/message', 'assistant/message', 'tool/result', 'tool/call', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch',
  'agent/inbox/spliced', 'assistant/attempt', 'assistant/progress', 'projects/assistant-progress',
  'tool/execution-start', 'tool/execution-return', 'projects/tool-execution-start', 'projects/tool-execution-return',
  'projects/tool-execution-final', 'agent/stop-request', 'projects/agent-stop-request',
])
export function isProjectVisibleLocator(locator: ProjectRecordLocator): boolean {
  const type = projectRecordSemanticType(locator.type), source = locator.facts.sourceKind
  if (!projectVisibleRecordTypes.has(type) || locator.facts.surfaceOp === 'replace') return false
  if (type === 'user/message' && !visibleProducer(source, locator.facts.sourceForm)) return false
  if (type === 'agent/inbox/spliced' && locator.inboxMetadata !== undefined && locator.inboxMetadata.inserted.length > 0
    && !locator.inboxMetadata.inserted.some(message => visibleProducer(message.sourceKind, message.sourceForm))) return false
  return !(type === 'tool/execution-return' || type === 'projects/tool-execution-return') || locator.facts.phase !== 'presentation-meta'
}

function visibleProducer(kind: unknown, form: unknown): boolean { return typeof kind !== 'string' || isMainBusinessInput(kind) || !(kind === 'runtime-context' || kind === 'agent-instructions' || typeof form === 'string') }

/** Only structural fields needed by the existing projection are represented. */
export function projectQuerySkeleton(locator: ProjectRecordLocator): SessionEvent {
  const type = projectRecordSemanticType(locator.type), facts = locator.facts
  const sourceKind = typeof facts.sourceKind === 'string' ? facts.sourceKind : type === 'assistant/message' ? 'model' : 'user'
  const message = { role: type === 'assistant/message' ? 'assistant' : type === 'tool/result' ? 'tool' : 'user',
    id: facts.messageId, source: { kind: sourceKind, ...(facts.sourceForm === undefined ? {} : { form: facts.sourceForm }), ...(facts.callId === undefined ? {} : { callId: facts.callId }) }, content: [] }
  const data: Record<string, unknown> = { ...facts }
  if (type === 'user/message') Object.assign(data, message)
  if (type === 'assistant/message' || type === 'tool/result') data.message = message
  if (type === 'tool/call' || type === 'tool/ptc-dispatch-start') data.arguments = ''
  if (type === 'agent/inbox/spliced') data.inserted = (locator.inboxMetadata?.inserted ?? []).map(item => ({ id: item.id, role: 'user', source: { kind: item.sourceKind, ...(item.sourceForm === undefined ? {} : { form: item.sourceForm }) }, content: [] }))
  if (type === 'turn/end') data.reason = { kind: facts.reasonKind }
  return { type, seq: locator.seq, time: locator.time, data,
    ...(facts.surfaceOp === undefined ? {} : { surfaceOp: facts.surfaceOp }),
    ...(locator.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: locator.sourceEventSeqs }),
  } as unknown as SessionEvent
}
