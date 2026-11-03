/** MIT stock present-event validators; native action routes stay outside this private module. */
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'

export function isPresentedFile(value: unknown): value is { path: string; description?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { path, description } = value as Record<string, unknown>
  return typeof path === 'string' && path.trim().length > 0
    && (description === undefined || typeof description === 'string')
}

export function isPresentedData(value: unknown): value is { turn: number; callId: ToolCallId; files: unknown[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { turn, callId, files } = value as Record<string, unknown>
  return typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 1
    && typeof callId === 'string' && callId.length > 0 && Array.isArray(files)
}

export function basename(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? path : path.slice(at + 1)
}
