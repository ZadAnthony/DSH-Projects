/** Projects' Session UI needs journal positions, not forensic request snapshots. */
import type {
  SessionFollowFrame, SessionHistoryRecord, SessionPage, SessionWireEvent,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ProjectRecordLocator } from '../persistence/types.ts'

export const PROJECT_UI_LOG_METADATA = 'projects/ui-log-metadata'
const rawReferenceTypes = new Set(['projects/assistant-progress-v2', 'projects/tool-raw-v2', 'projects/tool-execution-return-v2', 'projects/tool-execution-final-v2'])
const rawLegacyTypes = new Set(['projects/assistant-progress', 'projects/tool-raw', 'projects/tool-execution-return', 'projects/tool-execution-final'])
const rawTypes = new Set([...rawReferenceTypes, ...rawLegacyTypes])
const metadataTypes = new Set(['projects/request-dispatch', 'projects/auxiliary-dispatch', 'projects/request-dispatch-v2', 'projects/auxiliary-dispatch-v2', ...rawTypes])

/** These payloads have no native Conversation renderer; locate them without reading their bodies. */
export function uiMetadataRecord(record: ProjectRecordLocator): SessionWireEvent | undefined {
  if (!metadataTypes.has(record.type)) return undefined
  return { type: PROJECT_UI_LOG_METADATA, seq: record.seq as SessionWireEvent['seq'], time: record.time, ignorable: true,
    data: { version: 1, originalType: record.type,
      omitted: rawTypes.has(record.type) ? 'raw-evidence-body-available-through-source-reader' : 'request-and-context-snapshots-not-needed-for-session-ui',
      ...Object.fromEntries(Object.entries(record.facts).filter(([key]) => ['dispatchId', 'turn', 'step', 'attempt', 'prefixLength', 'purpose', 'compactionId',
        'attemptId', 'fromIndex', 'toIndex', 'callSeq', 'startEventSeq', 'callId', 'rootCallId', 'name', 'invocationId', 'parentInvocationId', 'phase', 'origin', 'isError'].includes(key))) } }
}

/** Preserve a dense journal without presenting a partial durable dispatch as the original event. */
export function projectUiHistoryEvent(event: SessionWireEvent): SessionWireEvent {
  if (!metadataTypes.has(event.type)) return event
  const original = event.data
  if (original === null || typeof original !== 'object' || Array.isArray(original)) {
    throw new Error('PROJECT_UI_INVALID_DISPATCH: request metadata must be an object')
  }
  const metadata: Record<string, JsonValue> = {
    version: 1,
    originalType: event.type,
    omitted: rawTypes.has(event.type) ? 'raw-evidence-body-available-through-source-reader' : 'request-and-context-snapshots-not-needed-for-session-ui',
  }
  // Location indexing consumes turn/step even for otherwise unclaimed log events.
  // The other scalar identifiers preserve the original forensic lookup position.
  for (const key of ['dispatchId', 'turn', 'step', 'attempt', 'prefixLength', 'purpose', 'compactionId']) {
    const value = original[key]
    if (typeof value === 'string' || typeof value === 'number') metadata[key] = value
  }
  if (rawTypes.has(event.type)) {
    const facts = rawReferenceTypes.has(event.type) ? original.facts : original
    if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) throw new Error('PROJECT_UI_INVALID_RAW_REFERENCE')
    for (const key of ['turn', 'step', 'attemptId', 'fromIndex', 'toIndex', 'callSeq', 'startEventSeq', 'callId', 'rootCallId', 'name', 'invocationId', 'parentInvocationId', 'phase', 'origin', 'isError']) {
      const value = facts[key]
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') metadata[key] = value
    }
    if (rawLegacyTypes.has(event.type) && (event.type === 'projects/tool-execution-final'
      || event.type === 'projects/tool-execution-return' && original.phase === 'canonical')) {
      const result = original.result
      if (result !== null && typeof result === 'object' && !Array.isArray(result) && typeof result.isError === 'boolean') metadata.isError = result.isError
    }
  }
  return { type: PROJECT_UI_LOG_METADATA, seq: event.seq, time: event.time, ignorable: true, data: metadata }
}

function recordsForUi(records: readonly SessionHistoryRecord[]): readonly SessionHistoryRecord[] {
  if (!records.some(record => metadataTypes.has(record.event.type))) return records
  return records.map(record => {
    const event = projectUiHistoryEvent(record.event)
    if (event === record.event) return record
    return { type: 'event' as const, event }
  })
}

/** All opening snapshots, backwards pages and live deltas use the same wire contract. */
export function projectUiHistoryFrame(frame: SessionFollowFrame): SessionFollowFrame {
  if (frame.type === 'assistant-stream') return frame
  if (frame.type === 'snapshot') {
    const records = recordsForUi(frame.records)
    return records === frame.records ? frame : { ...frame, records }
  }
  const event = projectUiHistoryEvent(frame.event)
  return event === frame.event ? frame : { type: 'event', event }
}

export function projectUiHistoryPage(page: SessionPage): SessionPage {
  const records = recordsForUi(page.records)
  return records === page.records ? page : { ...page, records }
}
