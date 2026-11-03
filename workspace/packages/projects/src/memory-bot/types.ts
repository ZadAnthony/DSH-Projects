import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { MemoryExplicitRequest, MemoryRequestContextSource } from '../memory-request.ts'
import type { MemorySource, MemoryWriteResult } from '../memory-types.ts'
import type { NativeProjectMessageSource, NativeProjectSourceItem, NativeProjectSpeaker } from '../source-reader.ts'

export interface MemoryBotCut {
  sessionId: string
  hostSessionId: string
  endSeq: number
}

/** core先冻结完整前缀，再flush确认；live snapshot或Query合成结尾不是已保存cut。 */
export interface SavedWorkCut extends MemoryBotCut {
  role: 'main' | 'execution' | 'memory'
  sessionCreatedAt?: number
  formatVersion?: number
  events: readonly SessionEvent[]
}

export interface MemoryBotMessage {
  source: Extract<MemorySource, { kind: 'message' | 'native-event' }>
  sessionId: string
  seq: number
  identity: string
  text: string
  role: 'user' | 'assistant'
  time: number
  speaker: NativeProjectSpeaker
  /** 实际producer；source字段仍只作为精确原文定位，不代表用户认可。 */
  producer?: NativeProjectMessageSource
  partial?: true
  limitations?: readonly string[]
  /** Only the new suffix of one streaming attempt is counted. */
  visibleRange?: { start: number; end: number }
  inputState?: 'accepted' | 'consumed' | 'superseded' | 'withdrawn'
  consumedSource?: MemorySource
}

export interface MemoryBotProjection {
  visibleCharacters: number
  completeTurns: number
  messages: readonly MemoryBotMessage[]
  /** 已处理cut前的有限交流，只解释新正文，不计入本批新增或再次整理。 */
  context?: readonly MemoryBotMessage[]
  changes?: readonly { source: MemorySource; previousSource: MemorySource; status: 'superseded' | 'withdrawn' }[]
}

export interface FrozenMemorySource {
  source: MemoryRequestContextSource
  /** Hash of the exact, zero-neighbour source value; never a second chat body. */
  digest: string
}
export interface QueuedMemoryRequest extends MemoryExplicitRequest {
  requestId: string
  attempted?: true
  frozenOriginal?: FrozenMemorySource
  frozenContext?: FrozenMemorySource[]
}
export interface MemoryBatchCoverage {
  /** Finite manifest for this batch only. Processed history is reconstructed from cuts. */
  sources: readonly MemorySource[]
  digest: string
}
export interface FrozenMemoryBatch {
  batchId: string
  kind?: 'ordinary' | 'explicit'
  /** Untagged historical batches retain the original unlinked settlement representation. */
  projectionVersion?: 2
  cuts: readonly MemoryBotCut[]
  requestIds: readonly string[]
  coverage?: MemoryBatchCoverage
  /** v1 retained facts need reconstruction from the original immutable prefix. */
  legacy?: true
}

/** 这里只存定位与结果事实，不能存原消息、模型摘要或可重放write列表。 */
export interface MemoryBotState {
  version: 1 | 2
  projectId: string
  processed: MemoryBotCut[]
  requests: QueuedMemoryRequest[]
  frozen?: FrozenMemoryBatch
  /** Incomplete ordinary and explicit batches may coexist; no write commands are stored. */
  pendingBatches?: FrozenMemoryBatch[]
  lastResult?: {
    batchId: string
    status: MemoryBatchSettlement['status']
    nativeReason: string
    writes: { kind: MemoryWriteResult['kind']; id?: string; revision?: number }[]
    completedRequestIds: string[]
  }
}

export interface MemoryBotProject {
  projectId: string
  projectDirectory: string
  archived: boolean
}

/** 与现有source owner兼容的当前来源事实；不将Agent转述升级为原用户决定。 */
export interface MemoryBotSourceRead {
  projectId: string
  readable: boolean
  isUserDecision: boolean
  text?: string
  reason?: string
  nativeItems?: readonly NativeProjectSourceItem[]
  partial?: true
  limitations?: readonly string[]
}

export interface MemoryBatchInput {
  frozen: FrozenMemoryBatch
  pending: MemoryBotProjection
  /** Compatibility field stays empty; bodies must be obtained with the read tool. */
  requests: readonly {
    request: QueuedMemoryRequest
    original: MemoryBotSourceRead
    context: readonly { source: MemoryRequestContextSource; value: MemoryBotSourceRead }[]
  }[]
}

/** 必须由真实native终态和实际service写结果构造，不能解析Bot的一句“完成”代替。 */
export interface MemoryBatchRunResult {
  nativeReason: SessionEvent<'turn/end'>['data']['reason']['kind']
  processing: 'complete' | 'partial' | 'failed'
  writes: readonly { result: MemoryWriteResult; previousMemoryId?: string }[]
  completedRequestIds: readonly string[]
}

export interface MemoryBotCorePort {
  resolveProject(projectId: string): Promise<MemoryBotProject>
  /** Production Core reauthorizes the fresh project/real Bot in the same short metadata scope. */
  withStateWrite?<T>(project: MemoryBotProject, purpose: 'accept' | 'prepare' | 'settlement', transform: (latest: MemoryBotState) => T, signal?: AbortSignal): Promise<T>
  /** 指定cuts时必须返回完全相同的已保存前缀，来源删除时如实失败。 */
  readSavedCuts(project: MemoryBotProject, cuts?: readonly MemoryBotCut[]): Promise<readonly SavedWorkCut[]>
  /** Candidate statistics only; never establishes a durable batch or advances processed cuts. */
  /** Release disposable derived state at lifecycle boundaries, without executing work. */
  discardProbe?(projectId: string): void
  probePendingMemory?(project: MemoryBotProject, processed: readonly MemoryBotCut[]): Promise<Pick<MemoryBotProjection, 'visibleCharacters' | 'completeTurns'>>
  /** Serial durable folds avoid retaining every carrier's independently decoded journal. */
  readPendingMemory?(project: MemoryBotProject, processed: readonly MemoryBotCut[], cuts?: readonly MemoryBotCut[], projectionVersion?: 1 | 2): Promise<{ cuts: readonly MemoryBotCut[]; pending: MemoryBotProjection }>
  /** Compact only an already committed ordinary batch; this is disposable cache maintenance, never new work. */
  advanceProcessed?(projectId: string, processed: readonly MemoryBotCut[]): Promise<void>
  /** Revalidate only frozen ownership/creation/generation and cut availability; never replace its input. */
  validateFrozenSources?(project: MemoryBotProject, cuts: readonly MemoryBotCut[], signal: AbortSignal): Promise<void>
  readSource(project: MemoryBotProject, source: MemoryRequestContextSource, signal: AbortSignal): Promise<MemoryBotSourceRead>
  pinSource?(project: MemoryBotProject, source: MemoryRequestContextSource, signal: AbortSignal): Promise<{ source: MemoryRequestContextSource; value: MemoryBotSourceRead }>
  /** 此Promise实际终止并保存真实结果后才能resolve；abort不是停止确认。 */
  runFrozenBatch(project: MemoryBotProject, input: MemoryBatchInput, signal: AbortSignal): Promise<MemoryBatchRunResult>
  settled?(projectId: string, settlement: MemoryBatchSettlement): void
}

export type MemoryBotActivity =
  | { kind: 'work-start' | 'visible-progress' | 'natural-end' }
  | { kind: 'tool-completed'; canceled?: boolean }
  | { kind: 'stop' | 'open' | 'restore' | 'bot' }

export interface MemoryBatchSettlement {
  batchId: string
  status: 'completed' | 'partial' | 'failed' | 'interrupted'
  /** 只在整批完整成功时提供，partial的已生效事实保留在outcome。 */
  changes: readonly { kind: 'added' | 'updated'; memoryId: string }[]
  outcome?: MemoryBatchRunResult
  error?: string
}

export type MemoryBatchCheck =
  | { kind: 'started'; batchId: string; completion: Promise<MemoryBatchSettlement> }
  | { kind: 'skipped'; reason: 'unsupported-activity' | 'closed' | 'archived' | 'busy' | 'below-threshold' }
  | { kind: 'failed'; message: string }
