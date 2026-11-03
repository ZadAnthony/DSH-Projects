import { isDeepStrictEqual } from 'node:util'
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'
import type { RequestCandidateMessage, RequestCurrentBlock } from './stock/request/harness.ts'
import { MEMORY_CURRENT_AUTHORITY } from './memory-authority.ts'
import { renderMemoryIndex } from './memory-store.ts'
import type { MemoryIndexEntry } from './memory-types.ts'

type RecordValue = Record<string, unknown>
export interface MemoryRepresentationOptions { readonly memoryBlock: RequestCurrentBlock }

/** A keeper is the exact materialized block in this candidate, not a prior receipt. */
export function hasMemoryAuthorityKeeper(projectId: string, history: readonly RequestCandidateMessage[], expected: RequestCurrentBlock): boolean {
  const value = expected.value
  if (expected.producer !== 'projects' || expected.key !== `memory-index:${projectId}` || value === null) return false
  const source = record(value.source), block = value.content[0]
  if (source?.kind !== 'project-memory-index' || source.producer !== 'projects' || source.form !== 'catalog' || source.projectId !== projectId
    || value.content.length !== 1 || block?.type !== 'text' || !block.text.includes(MEMORY_CURRENT_AUTHORITY)) return false
  const candidates = history.filter(({ message }) => message.role === 'user' && 'currentBlock' in message
    && message.currentBlock?.producer === expected.producer && message.currentBlock.key === expected.key)
  const item = candidates[0]
  return candidates.length === 1 && item !== undefined && !(item.origin.kind === 'literal' && item.origin.history !== undefined)
    && item.message.role === 'user' && isDeepStrictEqual(item.message.source, value.source) && isDeepStrictEqual(item.message.content, value.content)
}

/** Request-only fields at known tool DTO positions; all other values are preserved. */
export function projectMemoryRepresentation(projectId: string, tool: string | undefined, input: unknown, authorityKeeper: boolean): unknown {
  const value = record(input)
  if (value === undefined) return input
  if (tool === 'project_memory_read' && authorityKeeper && value.guidance === MEMORY_CURRENT_AUTHORITY
    && (value.unavailable === true || value.projectId === projectId && typeof value.id === 'string' && Number.isSafeInteger(value.revision)
      && typeof value.body === 'string' && record(value.scope) !== undefined && Array.isArray(value.sources))) {
    const { guidance: _guidance, ...rest } = value
    return rest
  }
  if ((tool === 'project_history' || tool === 'project_read') && authorityKeeper) {
    const relations = record(value.currentMemory)
    if (relations?.projectId === projectId && ['ok', 'partial', 'unavailable'].includes(String(relations.status))
      && Array.isArray(relations.relations) && Array.isArray(relations.issues) && relations.guidance === MEMORY_CURRENT_AUTHORITY) {
      const { guidance: _guidance, ...rest } = relations
      return { ...value, currentMemory: rest }
    }
  }
  if (tool !== 'project_memory_list' || value.projectId !== projectId || typeof value.index !== 'string'
    || typeof value.indexSynchronized !== 'boolean' || !Array.isArray(value.issues) || !Array.isArray(value.entries)
    || Object.hasOwn(value, 'indexNotice') || !value.entries.every(item => indexEntry(item, projectId))) return input
  const entries = value.entries as MemoryIndexEntry[]
  if (!knownIndexTemplate(projectId) || value.index !== renderMemoryIndex(projectId, entries)) return input
  const { index: _index, ...rest } = value
  const projected = { ...rest, indexNotice: '完整目录条目保留在 entries；原条目状态标签为“当前有效”。索引用于选择正文；摘要不代表已读原文，也不授予操作权限。'
    + (entries.length === 0 ? '当前没有共享记忆。' : '') }
  const before = JSON.stringify(value), after = JSON.stringify(projected)
  return after.length < before.length && Buffer.byteLength(after) < Buffer.byteLength(before)
    && estimateContent([{ type: 'text', text: after }]) <= estimateContent([{ type: 'text', text: before }]) ? projected : input
}

function indexEntry(input: unknown, projectId: string): boolean {
  const value = record(input), scope = record(value?.scope)
  if (value?.projectId !== projectId || !['id', 'path', 'title', 'summary', 'updatedAt'].every(key => typeof value[key] === 'string')
    || !['rule', 'preference', 'background', 'fact', 'experience'].includes(String(value.type))
    || !['confirmed', 'verified', 'unverified'].includes(String(value.nature)) || !Number.isSafeInteger(value.revision) || scope === undefined) return false
  const fields: Record<string, string> = { session: 'sessionIds', file: 'paths', topic: 'topics', work: 'workIds' }
  const field = fields[String(scope.kind)]
  return scope.kind === 'project' || field !== undefined && Array.isArray(scope[field]) && (scope[field] as unknown[]).every(item => typeof item === 'string')
}

/** Fail closed if the renderer gains fixed semantics which this projection omits. */
function knownIndexTemplate(projectId: string): boolean {
  const intro = ['# 项目共享记忆索引', '', `项目：${projectId}`, '', '索引用于选择正文；摘要不代表已读原文，也不授予操作权限。', '']
  if (renderMemoryIndex(projectId, []) !== [...intro, '当前没有共享记忆。', ''].join('\n')) return false
  const probe: MemoryIndexEntry = { projectId, id: '__id', path: '__path', title: '__title', summary: '__summary',
    type: 'fact', nature: 'verified', scope: { kind: 'project' }, revision: 1, updatedAt: '__time' }
  return renderMemoryIndex(projectId, [probe]) === [...intro, '## __title', '- 标识：__id', '- 正文：__path',
    '- 类型：fact；性质：verified；状态：当前有效', '- 范围：{"kind":"project"}', '- 摘要：__summary', '- 正文更新：__time（修订 1）', ''].join('\n')
}
function record(value: unknown): RecordValue | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined }
