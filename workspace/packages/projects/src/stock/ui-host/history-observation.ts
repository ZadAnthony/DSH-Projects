/** Projects UI source: directory cuts and selected canonical records, never a prepared cold Session. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionLogOffset, SessionSeq, type SessionEvent, type SessionSeqCursor } from '@deepseek-ai/dsh-session'
import type { SessionPageRequest, SessionProjectionValues, SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ProjectDirectoryObservation } from '../read/index.ts'
import { ProjectSessionPersistence } from '../persistence/index.ts'
import { sameOwnedCreationHeader } from '../control/identity.ts'
import { transformProjectDispatchForRun } from '../request/records.ts'
import { transformProjectRawForRun } from '../recording/records.ts'
import type { ProjectRecordDirectory } from '../persistence/types.ts'
import type { ProjectionCheckpoint } from '@deepseek-ai/dsh-session-projection'
import { projectUiHistoryEvent, uiMetadataRecord } from './history-wire.ts'

export function uiHistoryWindow(directory: ProjectRecordDirectory, throughSeq: SessionSeqCursor, beforeSeq: number | undefined,
  maxMessages: number, turnWindow?: SessionPageRequest['turnWindow']): { from: number; to: number; hasMore: boolean } {
  const to = Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1)
  let messages = 0, turns = 0, from = 0
  for (let index = to - 1; index >= 0; index--) {
    const record = directory.records[index]!
    if (record.seq !== index) throw new Error('PROJECT_UI_DIRECTORY_SEQUENCE_GAP')
    if (turnWindow !== undefined && record.type === 'turn/start') {
      turns++
      if (messages >= turnWindow.minMessages && turns >= turnWindow.minTurns) { from = index; break }
    }
    if ((record.type !== 'user/message' && record.type !== 'assistant/message') || record.facts.surfaceOp !== 'append') continue
    messages++
    if (messages >= maxMessages) { from = Number(record.facts.sourceGroupStart ?? index); break }
  }
  return { from, to, hasMore: from > 0 }
}

/** A message window has an event bound, not a hard byte bound: one native surface may be arbitrarily large. */
export async function uiHistoryEvents(observation: ProjectDirectoryObservation, from: number, to: number): Promise<SessionWireEvent[]> {
  const result: SessionWireEvent[] = []
  let next = from
  while (next < to) {
    const metadata = uiMetadataRecord(observation.directory.records[next]!)
    if (metadata !== undefined) { result.push(metadata); next++; continue }
    let end = next + 1
    while (end < to && uiMetadataRecord(observation.directory.records[end]!) === undefined) end++
    for await (const event of observation.readRange(next, end)) {
      if (event.seq !== result.length + from) throw new Error('PROJECT_UI_HISTORY_SEQUENCE_GAP')
      result.push(projectUiHistoryEvent(event as unknown as SessionWireEvent))
    }
    if (result.length + from !== end) throw new Error('PROJECT_UI_HISTORY_RANGE_INCOMPLETE')
    next = end
  }
  return result
}

/** Restore native control values from bounded run-event segments at the authorized cut.
 * No UI checkpoint, wire snapshot cache, or long-lived Session is retained.
 * A cold projection request intentionally pays one streaming restoration pass.
 */
export async function uiHistoryProjections(ctx: Context, observation: ProjectDirectoryObservation, signal?: AbortSignal): Promise<{ asOfSeq: SessionSeqCursor; values: SessionProjectionValues }> {
  const { directory } = observation
  const cursor = directory.nextSeq === 0 ? -1 : SessionSeq(directory.nextSeq - 1)
  const registry = ctx.sessionProjections
  const live = ctx.get('sessions')?.get(directory.header.id)
  if (live !== undefined && Number(live.seq) === directory.nextSeq) {
    const snapshot = registry.snapshot(live)
    return { asOfSeq: snapshot.asOfSeq, values: snapshot.values as SessionProjectionValues }
  }
  const persistence = ctx.sessionPersistence as ProjectSessionPersistence
  let checkpoint: ProjectionCheckpoint = {}, events: SessionEvent[] = [], bytes = 0
  let snapshot: ReturnType<typeof registry.restore>['snapshot'] | undefined
  const fold = () => {
    const restored = registry.restore(checkpoint, events, SessionLogOffset(events[0]?.seq ?? 0), directory.header, directory.inheritedEventCount)
    checkpoint = restored.checkpoint; snapshot = restored.snapshot
    // The public restore contract uses the preceding event as its honest tail
    // anchor. Usable checkpoint rows skip it; every event is applied once.
    const anchor = events.at(-1)
    events = anchor === undefined ? [] : [anchor]
    bytes = anchor === undefined ? 0 : directory.records[anchor.seq]!.byteEnd - directory.records[anchor.seq]!.byteStart
  }
  const cold = await persistence.readForRun(directory.header.id,
    (event, original) => transformProjectRawForRun(transformProjectDispatchForRun(event, original), original),
    { through: observation.cut, ...(signal === undefined ? {} : { signal }), visit: event => {
      const row = directory.records[event.seq]!, size = row.byteEnd - row.byteStart
      if (events.length > (snapshot === undefined ? 0 : 1) && (events.length >= 128 || bytes + size > 256 * 1024)) fold()
      events.push(event); bytes += size
    } })
  try {
    if (!sameOwnedCreationHeader(cold.handle.header, directory.header) || cold.handle.inheritedEventCount !== directory.inheritedEventCount
      || cold.canonicalCount !== directory.nextSeq) throw new Error('PROJECT_UI_PROJECTION_SOURCE_CHANGED')
    const current = await persistence.recordDirectory(directory.header.id, { ...(signal === undefined ? {} : { signal }) })
    if (current.journalIdentity !== directory.journalIdentity) throw new Error('PROJECT_UI_PROJECTION_SOURCE_CHANGED')
    fold()
    if (snapshot!.asOfSeq !== cursor) throw new Error('PROJECT_UI_PROJECTION_CUT_CHANGED')
    await observation.revalidate()
    return snapshot! as { asOfSeq: SessionSeqCursor; values: SessionProjectionValues }
  } finally { await cold.handle.close() }
}
