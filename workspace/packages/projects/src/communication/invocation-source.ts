/** Projects-owned invocation identity; the stock Tools package does not define it.
 * Preserves the 41.3 persisted fields without adding an export to native DSH.
 */
import type { Session, SessionEvent, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'

export interface ToolInvocationSource {
  readonly sessionId: SessionId
  readonly sessionCreatedAt: number
  readonly startEventSeq: SessionSeq
  readonly callId: ToolCallId
  readonly rootCallId: ToolCallId
}

/** Identity is the exact own root/PTC start, including creation and physical carrier. */
export function matchesCommunicationInvocation(source: ToolInvocationSource, session: Pick<Session, 'id' | 'header' | 'inheritedEventCount'>, event: SessionEvent | undefined): boolean {
  if (source.sessionId !== session.id || source.sessionCreatedAt !== session.header.createdAt
    || source.startEventSeq < session.inheritedEventCount || event?.seq !== source.startEventSeq) return false
  if (event.type === 'tool/call') return event.data.callId === source.callId && source.rootCallId === source.callId && event.data.name === 'project_send_message'
  if (event.type === 'tool/ptc-dispatch-start') return event.data.subCallId === source.callId && event.data.rootCallId === source.rootCallId && event.data.name === 'project_send_message'
  return false
}
