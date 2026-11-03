import { durableMutationDetails, type DurableMutationEffect, type DurableMutationStage } from './metadata-errors.ts'
import type { NativeProjectSource } from './source-reference-types.ts'
import type { CommunicationSavedPartSource } from './communication/types.ts'

/** 共享记忆的浏览器安全合同；整体背景归看板，具体指示和反馈查原聊天。 */
export type MemoryType = 'rule' | 'preference' | 'background' | 'fact' | 'experience'
export type MemoryNature = 'confirmed' | 'verified' | 'unverified'

export type MemorySource =
  | NativeProjectSource
  | CommunicationSavedPartSource
  | { kind: 'file'; path: string; locator?: string }
  | { kind: 'settings'; changeId: string }

export type MemoryNativeSource = NativeProjectSource
/** 只兼容旧文件中的定位；不作为新保存来源或新用户决定依据。 */
export type LegacyMemorySource = { kind: 'record'; recordKind: string; recordId: string; revision: number }
export type StoredMemorySource = MemorySource | LegacyMemorySource

/** 每个条目按任一明确范围匹配；不从文字推断局部范围。 */
export type MemoryScope =
  | { kind: 'project' }
  | { kind: 'session'; sessionIds: string[] }
  | { kind: 'file'; paths: string[] }
  | { kind: 'topic'; topics: string[] }

export type LegacyMemoryScope = { kind: 'work'; workIds: string[] }
export type StoredMemoryScope = MemoryScope | LegacyMemoryScope

export const LEGACY_MEMORY_SCOPE_NOTICE = '该旧范围已退出当前适用；不自动扩大为项目或会话规则，也不进入当前索引和正文供给。可查看、撤回；编辑保存前须明确选择现行范围。'

export function isCurrentMemorySource(source: StoredMemorySource): source is MemorySource { return source.kind !== 'record' }

export interface MemoryDraft {
  title: string
  summary: string
  body: string
  type: MemoryType
  nature: MemoryNature
  scope: MemoryScope
  sources: MemorySource[]
}

export interface StoredMemoryDraft extends Omit<MemoryDraft, 'scope' | 'sources'> {
  scope: StoredMemoryScope
  sources: StoredMemorySource[]
}

export interface ProjectMemory extends StoredMemoryDraft {
  id: string
  projectId: string
  path: string
  revision: number
  /** 撤回后同标识恢复的实例身份；旧的未恢复记忆省略此字段。 */
  generation?: string
  createdAt: string
  updatedAt: string
  createdBy: string
  updatedBy: string
  /** 保留纠正前的定位，不复制旧正文。 */
  originSources: StoredMemorySource[]
  reconfirmedBy?: StoredMemorySource
}

export interface MemoryIndexEntry extends Omit<ProjectMemory, 'body' | 'sources' | 'originSources' | 'createdBy' | 'updatedBy' | 'createdAt' | 'reconfirmedBy'> {}

/** 当前主题入口及真实编辑/来源元信息；不含正文或摘要，不裁条款。 */
export type MemoryCurrentReference = Pick<ProjectMemory,
  'id' | 'projectId' | 'path' | 'title' | 'type' | 'nature' | 'scope' | 'revision' | 'generation' | 'updatedAt' | 'updatedBy' | 'sources' | 'originSources' | 'reconfirmedBy'>

/** 既有撤回文件的最小事实，不新增存储格式。 */
export interface MemoryWithdrawal {
  id: string
  sources: StoredMemorySource[]
  withdrawnAt: string
}

export interface MemoryMessageRelations {
  projectId: string
  /** 仅描述本次Memory读取；不改变原历史查询的status/分页。 */
  status: 'ok' | 'partial' | 'unavailable'
  relations: Array<{
    source: Extract<MemorySource, { kind: 'message' | 'native-event' }>
    current: MemoryCurrentReference[]
    historicalWithdrawals: MemoryWithdrawal[]
  }>
  issues: MemoryIssue[]
  guidance: string
}

export interface MemoryIssue {
  path: string
  message: string
}

export interface MemorySnapshot {
  projectId: string
  entries: MemoryIndexEntry[]
  /** 由当前正文元数据生成；即使磁盘索引失败也不用旧摘要冒充当前内容。 */
  index: string
  indexSynchronized: boolean
  issues: MemoryIssue[]
}

export interface SaveMemoryInput extends Omit<MemoryDraft, 'sources'> {
  /** 设置可原样保留该主题已有的历史来源；自动保存仍校验为现行来源。 */
  sources: StoredMemorySource[]
  /** 新建时省略则分配独立UUID文件名；显式主题仍校验，更新保持原路径。 */
  topic?: string
  id?: string
  expectedRevision?: number
  expectedGeneration?: string
  /** 仅在用户以新决定明确恢复已撤回内容时提供。 */
  reconfirmedBy?: MemorySource
}

export type MemoryWriteResult =
  | { kind: 'saved'; memory: ProjectMemory; bodySaved: true; indexSaved: true }
  | { kind: 'withdrawn'; id: string; bodyRemoved: true; indexSaved: true }
  | { kind: 'conflict'; current?: ProjectMemory; message: string }
  | { kind: 'failed'; stage: 'body' | 'withdrawal'; message: string }
  | { kind: 'partial'; operation: 'save' | 'withdraw'; id: string; bodySaved: boolean; bodyRemoved: boolean; indexSaved: boolean; message: string }

/** True flags are durable facts from this attempt; false means not confirmed, never read-back proof. */
export interface MemoryMutationConfirmedFacts {
  bodySaved: boolean
  withdrawalSaved: boolean
  bodyRemoved: boolean
  indexSaved: boolean
}

/** Structured exception DTO. Kept browser-safe and decoded without instanceof. */
export interface MemoryMutationFailure {
  code: 'projects/metadata-write-unconfirmed'
  owner: 'memory'
  operation: 'save' | 'withdraw'
  projectId: string
  id: string
  phase: 'body' | 'withdrawal' | 'body-removal' | 'index'
  stage: DurableMutationStage
  effect: Exclude<DurableMutationEffect, 'none'>
  confirmed: MemoryMutationConfirmedFacts
  message: string
}

export function memoryMutationFailure(error: unknown): MemoryMutationFailure | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const outer = error as Partial<MemoryMutationFailure> & { details?: Partial<MemoryMutationFailure> }
  const value = outer.owner === 'memory' ? outer : { ...outer.details, code: outer.code, message: outer.message }
  const durable = durableMutationDetails(error)
  if (durable === undefined || durable.effect === 'none' || value.code !== 'projects/metadata-write-unconfirmed' || value.owner !== 'memory'
    || !['save', 'withdraw'].includes(String(value.operation)) || typeof value.projectId !== 'string' || typeof value.id !== 'string'
    || !['body', 'withdrawal', 'body-removal', 'index'].includes(String(value.phase))
    || value.confirmed === null || typeof value.confirmed !== 'object'
    || !['bodySaved', 'withdrawalSaved', 'bodyRemoved', 'indexSaved'].every(key => typeof (value.confirmed as unknown as Record<string, unknown>)[key] === 'boolean')) return undefined
  return { code: value.code, owner: value.owner, operation: value.operation!, projectId: value.projectId, id: value.id,
    phase: value.phase!, stage: durable.stage, effect: durable.effect, confirmed: { bodySaved: value.confirmed.bodySaved, withdrawalSaved: value.confirmed.withdrawalSaved, bodyRemoved: value.confirmed.bodyRemoved, indexSaved: value.confirmed.indexSaved },
    message: typeof value.message === 'string' ? value.message : '共享记忆保存结果未确认；内容可能已更新，请核对当前内容，勿直接重做。' }
}

export interface MemoryContextTarget {
  projectId: string
  sessionId: string
  filePaths?: readonly string[]
  topics?: readonly string[]
}

export interface MemoryContext {
  projectId: string
  /** 现行范围的读取投影；不重写磁盘索引，不包含旧 work 的摘要。 */
  index: string
  entries: MemoryIndexEntry[]
  indexSynchronized: boolean
  /** 兼容旧消费方字段；D16 恒为空，所有类型正文均按需读取。 */
  provided: ProjectMemory[]
  issues: MemoryIssue[]
  /** 同次 owner 读取的来源与最小撤回事实；不增加正文常驻或版本库。 */
  currentReferences?: MemoryCurrentReference[]
  withdrawals?: MemoryWithdrawal[]
  availability?: 'available' | 'unreadable'
  /** 仅用于解释已供给历史；按主题合并，不保存旧摘要或正文。 */
  invalidations?: MemoryContextInvalidation[]
}

export interface MemoryContextInvalidation {
  id: string
  status: 'revised' | 'withdrawn' | 'unavailable'
  previousRevision?: number
  currentRevision?: number
  formerScope?: StoredMemoryScope
  sources: StoredMemorySource[]
  previouslyRead?: true
}

export interface MemorySettingsActions {
  list(): Promise<MemorySnapshot>
  read(id: string): Promise<ProjectMemory | undefined>
  save(input: SaveMemoryInput): Promise<MemoryWriteResult>
  withdraw(id: string, expectedRevision: number, expectedGeneration?: string): Promise<MemoryWriteResult>
  readSource?(source: StoredMemorySource): Promise<string>
}
