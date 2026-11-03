import type { MemorySource, MemoryWriteResult } from './memory-types.ts'

export type MemoryRequestOperation = 'remember' | 'correct' | 'withdraw'
export type MemoryRequestSource = Extract<MemorySource, { kind: 'message' | 'native-event' }>
export type MemoryRequestContextSource = Exclude<MemorySource, { kind: 'settings' }>

/** 请求只携带原文定位；接纳时固定精确事件及上下文，队列与执行前核对由批处理 owner 负责。 */
export interface MemoryRequestInput {
  operation: MemoryRequestOperation
  source: MemoryRequestSource
  memoryId?: string
  contextSources?: readonly MemoryRequestContextSource[]
}

export interface MemoryExplicitRequest extends MemoryRequestInput {
  projectId: string
  contextSources: readonly MemoryRequestContextSource[]
}

export type MemoryRequestResult =
  | { kind: 'accepted'; requestId: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'failed'; message: string }

/** accepted 仅说明请求已保留，不表示记忆已生效。不得在此保存聊天正文副本。 */
export interface MemoryRequestPort {
  accept(request: MemoryExplicitRequest, signal?: AbortSignal): Promise<MemoryRequestResult>
}

export type MemoryChangeNotice = { kind: 'added' | 'updated'; memoryId: string }

/** 只把完整写入结果映射为轻提示；输入框挂载与传输归公共层。 */
export function memoryChangeNotice(result: MemoryWriteResult, previousMemoryId?: string): MemoryChangeNotice | undefined {
  if (result.kind === 'saved') return { kind: previousMemoryId === undefined ? 'added' : 'updated', memoryId: result.memory.id }
  if (result.kind === 'withdrawn') return { kind: 'updated', memoryId: result.id }
  return undefined
}
