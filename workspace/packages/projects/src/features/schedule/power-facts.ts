import type { ScheduleRecoveryWindow } from './contract.ts'

/**
 * Host-only synchronous facts in the schedule UTC clock domain. Notifications
 * are hints. Native epoch/window facts do not claim an exact resume instant.
 * A baseline is fixed within one verified clock segment. A new segment never
 * repairs the ordering of the old segment or authorizes replay of old work.
 */
export interface DarwinSchedulePowerFact {
  kind: 'known'; observedAt: string; available: boolean; provenance: 'darwin-kernel'
  epoch: number; baselineEpoch: number; baselineAt: string; recoveryWindow?: ScheduleRecoveryWindow
}
export interface ScheduleClockBoundary { at: string; baselineEpoch?: number }
export type SchedulePowerFact =
  | { kind: 'known'; observedAt: string; available: boolean; recoveredAt?: string; provenance: 'controlled-fixture' }
  | DarwinSchedulePowerFact
  | { kind: 'unknown'; observedAt?: string; reason: string }
export interface SchedulePowerFacts { readSync(): SchedulePowerFact; dispose(): void }
export function unknownSchedulePowerFacts(): SchedulePowerFacts {
  return { readSync: () => ({ kind: 'unknown', reason: '本机恢复事实尚未连接。' }), dispose() {} }
}
