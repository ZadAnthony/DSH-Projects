/** Pure stock announcement validator used by the shared durable turn Definition. */
import type {} from '@deepseek-ai/dsh-workspace-changes/types'
export function isChangesEvent(value: unknown): value is { turn: number } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && 'turn' in value && typeof value.turn === 'number' && Number.isSafeInteger(value.turn) && value.turn >= 1
}
