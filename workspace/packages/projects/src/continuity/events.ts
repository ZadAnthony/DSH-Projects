/** Required finite continuity facts share the Projects journal and cold decoder. */
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { ProjectSchemaPersistence } from '../stock/request/dispatch.ts'
import { parseSessionManagerDecision } from './manager-parser.ts'
import type { EvaluationEnvelope, SessionManagerDecision } from './types.ts'

export interface MainContinuityEvent {
  readonly envelope: EvaluationEnvelope
  readonly phase: 'evaluation-start' | 'decision' | 'settled'
  readonly outcome?: string
  readonly decision?: SessionManagerDecision
  readonly detail?: string
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap { 'projects/main-continuity': MainContinuityEvent }
}
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Continuity fact must be an object')
  const data = value as Record<string, unknown>
  if (required.some(key => !Object.hasOwn(data, key)) || Object.keys(data).some(key => !required.includes(key) && !optional.includes(key))) throw new Error('Invalid continuity fact fields')
  return data
}
function integer(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) >= 0 }
function nonempty(value: unknown): boolean { return typeof value === 'string' && value.length > 0 }
function validateContinuityEvent(value: unknown): void {
  const data = object(value, ['envelope', 'phase'], ['outcome', 'decision', 'detail'])
  const envelope = object(data.envelope, ['attemptId', 'projectId', 'mainSessionId', 'hostSessionId', 'header', 'turn', 'epoch', 'sessionRevision', 'configurationRevision', 'startedAt'])
  if (!['attemptId', 'projectId', 'mainSessionId', 'hostSessionId'].every(key => nonempty(envelope[key]))
    || !['epoch', 'sessionRevision', 'startedAt'].every(key => integer(envelope[key])) || typeof envelope.configurationRevision !== 'string') throw new Error('Invalid continuity evaluation identity')
  const header = envelope.header as Record<string, unknown>
  const turn = object(envelope.turn, ['hostSessionId', 'sessionCreatedAt', 'turnStartSeq', 'turnEndSeq'])
  if (!header || typeof header !== 'object' || Array.isArray(header) || header.id !== envelope.hostSessionId
    || !integer(header.createdAt) || header.version !== SESSION_FORMAT_VERSION || turn.hostSessionId !== envelope.hostSessionId
    || turn.sessionCreatedAt !== header.createdAt || !integer(turn.turnStartSeq) || !integer(turn.turnEndSeq)
    || (turn.turnEndSeq as number) <= (turn.turnStartSeq as number)) throw new Error('Invalid continuity native turn identity')
  if (data.phase === 'decision') {
    if (data.outcome !== undefined || data.detail !== undefined) throw new Error('Decision fact cannot claim a settled outcome')
    const decision = data.decision as SessionManagerDecision | undefined
    parseSessionManagerDecision(JSON.stringify(decision), decision?.evidence ?? [])
  } else if (data.phase === 'settled') {
    if (!nonempty(data.outcome) || data.decision !== undefined || data.detail !== undefined && typeof data.detail !== 'string') throw new Error('Invalid continuity settlement')
  } else if (data.phase !== 'evaluation-start' || data.decision !== undefined || data.outcome !== undefined || data.detail !== undefined) throw new Error('Invalid continuity phase')
}
const installed = new WeakSet<object>()
/** Install before any source is opened, using a stable validator identity. */
export function installContinuityEventSchemas(persistence: ProjectSchemaPersistence): void {
  if (installed.has(persistence)) return
  persistence.registerProjectEventSchema('projects/main-continuity', validateContinuityEvent)
  installed.add(persistence)
}
