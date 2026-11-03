/**
 * Data-only compatibility helpers for the plugin's private Schedule domain.
 * The Projects scheduler owns Project targets; no native Schedule producer is
 * installed in the private graph. Callers hold the lifecycle cut and serialize
 * these operations with their own accepted work. Never pass the root domain.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import {
  isRecurringScheduleRecord, resolveRecurringOccurrence, scheduleDomain,
  type ScheduleTask,
} from '@deepseek-ai/dsh-schedule'
import { instant } from '../../features/schedule/timing.ts'
import { withProjectsScheduleDomain } from '../native-storage.ts'

export interface SchedulePurgeResult {
  complete: boolean
  removed: string[]
  alreadyAbsent: boolean
  failure?: string
}

/** Advance only the selected native cursor beyond restore; never enqueue or wake. */
export function sourceScheduleTaskAfterBoundary(task: ScheduleTask, boundaryAt: string): ScheduleTask | undefined {
  const boundary = canonicalBoundary(boundaryAt)
  if (task.status !== 'active' || instant(task.record.scheduledAt) > instant(boundary)) return undefined
  const occurrence = isRecurringScheduleRecord(task.record)
    ? resolveRecurringOccurrence(task.record, instant(boundary)) : undefined
  const nextScheduledAt = occurrence?.nextScheduledAt
  // rc.2's public task schema has no lifecycle non-delivery field. Preserve its
  // receipts exactly; advancing a cursor is not a fabricated delivery receipt.
  return {
    ...task,
    status: nextScheduledAt === undefined ? 'inactive' : 'active',
    record: { ...task.record, scheduledAt: nextScheduledAt ?? occurrence?.occurrenceAt ?? task.record.scheduledAt },
  }
}

/** Caller owns the private domain and its serial slot; no service is registered. */
export async function prepareSourceScheduleRestore(
  domain: Domain<typeof scheduleDomain>, sessionIds: readonly SessionId[], boundaryAt: string,
): Promise<void> {
  canonicalBoundary(boundaryAt)
  const selected = new Set(sessionIds)
  const tasks = domain.table('tasks')
  const entries = [...tasks.entries()]
  assertIdentities(entries)
  for (const [key, task] of entries) {
    if (!selected.has(task.sessionId)) continue
    const next = sourceScheduleTaskAfterBoundary(task, boundaryAt)
    if (next !== undefined) await tasks.put(key, next)
  }
}

/** Exact rows only; partial deletes remain visible, and no producer is started. */
export async function purgeScheduleRows(
  domain: Domain<typeof scheduleDomain>, sessionIds: readonly SessionId[],
): Promise<SchedulePurgeResult> {
  const result: SchedulePurgeResult = { complete: false, removed: [], alreadyAbsent: false }
  try {
    const selected = new Set(sessionIds)
    const tasks = domain.table('tasks')
    const entries = [...tasks.entries()]
    assertIdentities(entries)
    const targets = entries.filter(([, task]) => selected.has(task.sessionId))
    result.alreadyAbsent = targets.length === 0
    for (const [key] of targets) {
      try { await tasks.delete(key); result.removed.push(key) }
      catch (error) { result.failure = joinFailure(result.failure, error) }
    }
    const remaining = [...tasks.entries()]
    assertIdentities(remaining)
    result.complete = result.failure === undefined && !remaining.some(([, task]) => selected.has(task.sessionId))
    if (!result.complete) result.failure ??= 'schedule: selected rows remain after purge'
  } catch (error) { result.failure = joinFailure(result.failure, error) }
  return result
}

/** Open only the caller's private facility; root/native producer use is rejected. */
export async function purgeSessionSchedules(ctx: Context, dataRoot: string, sessionIds: readonly SessionId[], signal?: AbortSignal): Promise<SchedulePurgeResult> {
  const result: SchedulePurgeResult = { complete: false, removed: [], alreadyAbsent: false }
  try {
    await withProjectsScheduleDomain(ctx, dataRoot, async domain => {
      Object.assign(result, await purgeScheduleRows(domain, sessionIds))
    }, signal)
  } catch (error) { result.failure = joinFailure(result.failure, error) }
  if (result.failure !== undefined) result.complete = false
  return result
}

function canonicalBoundary(value: string): string {
  if (new Date(instant(value)).toISOString() !== value) throw new Error('schedule: restore boundary must be a canonical UTC millisecond instant')
  return value
}
function assertIdentities(entries: readonly (readonly [string, ScheduleTask])[]): void {
  for (const [key, task] of entries) if (key !== task.record.id) throw new Error('schedule: stored task key differs from its record identity')
}
function joinFailure(previous: string | undefined, error: unknown): string {
  return [previous, error instanceof Error ? error.message : String(error)].filter(Boolean).join('; ')
}
