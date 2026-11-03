import { isDeepStrictEqual } from 'node:util'
import type { MemoryContext, MemoryContextInvalidation, MemoryCurrentReference, MemoryIndexEntry, StoredMemorySource } from './memory-types.ts'

export type MemoryIndexProjection = Pick<MemoryContext, 'projectId' | 'index' | 'entries' | 'indexSynchronized' | 'issues'
  | 'currentReferences' | 'withdrawals' | 'availability' | 'invalidations'>
export type MemoryObservedRead = Pick<MemoryCurrentReference, 'id' | 'revision' | 'generation' | 'scope' | 'sources'>

/** 仅记录已实际供给的主题元信息；原生 dispatch 拥有是否已供给的事实。 */
export interface MemoryIndexDeliveryState {
  projectId?: string
  index: string
  entries: MemoryIndexEntry[]
  readRevisions: Record<string, number>
  status: string
  references?: MemoryCurrentReference[]
  invalidations?: MemoryContextInvalidation[]
}

export function emptyMemoryIndexDelivery(): MemoryIndexDeliveryState {
  return { index: '', entries: [], readRevisions: {}, status: '' }
}

/** 实际正文调用与索引可见分开；未知主题不创建追踪事项。 */
export function markMemoryRead(state: MemoryIndexDeliveryState, id: string, revision: number): MemoryIndexDeliveryState {
  if (!state.entries.some(entry => entry.id === id)) return state
  return { ...state, readRevisions: { ...state.readRevisions, [id]: revision } }
}

/** 只准备当前供给状态；完整目录由 surface 渲染，实际供给仍由 dispatch 确认。 */
export function prepareMemoryIndexState(state: MemoryIndexDeliveryState, current: MemoryIndexProjection,
  observedReads: readonly MemoryObservedRead[] = []): MemoryIndexDeliveryState {
  if (state.projectId !== undefined && state.projectId !== current.projectId) throw new Error('索引供给状态不能跨项目复用。')
  const entries = current.entries.filter(entry => entry.scope.kind !== 'work').map(indexEntry)
  if (entries.some(entry => entry.projectId !== current.projectId)) throw new Error('索引条目不属于当前项目。')
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const references = structuredClone(current.currentReferences ?? [])
  const invalidations = memoryInvalidations(state, current, observedReads)
  const status = JSON.stringify({ synchronized: current.indexSynchronized, issues: current.issues,
    availability: current.availability ?? 'available', references, invalidations })
  const next: MemoryIndexDeliveryState = {
    projectId: current.projectId, index: current.index, entries,
    readRevisions: Object.fromEntries(Object.entries(state.readRevisions).filter(([id]) => byId.has(id))),
    references, invalidations, status,
  }
  return next
}

/** 同主题最小说明跨无关更新延续；当前 owner 的合法恢复优先于历史 marker。 */
export function memoryInvalidations(state: MemoryIndexDeliveryState, current: MemoryIndexProjection,
  observedReads: readonly MemoryObservedRead[] = []): MemoryContextInvalidation[] {
  const available = current.availability !== 'unreadable'
  const entries = new Map(current.entries.map(entry => [entry.id, entry]))
  const references = new Map((current.currentReferences ?? []).map(reference => [reference.id, reference]))
  const previousReferences = new Map((state.references ?? []).map(reference => [reference.id, reference]))
  const withdrawals = new Map((current.withdrawals ?? []).map(marker => [marker.id, marker]))
  const previous = new Map(state.entries.map(entry => [entry.id, entry]))
  // 此数组仅本次由真实工具事件重建，不放进供给state或另建读取台账。
  const reads = new Map(observedReads.map(read => [read.id, read]))
  const ids = new Set([...previous.keys(), ...(state.invalidations ?? []).map(item => item.id), ...withdrawals.keys(), ...reads.keys()])
  const result: MemoryContextInvalidation[] = []
  for (const id of [...ids].sort()) {
    const entry = entries.get(id), old = previous.get(id)
    const prior = state.invalidations?.find(item => item.id === id)
    const reference = references.get(id), previousReference = previousReferences.get(id)
    const marker = withdrawals.get(id), read = reads.get(id)
    // A retained former observation is one revision/scope tuple. Replaying an
    // older read may add read/source facts, but cannot replace that tuple.
    const hasFormer = prior?.previousRevision !== undefined || prior?.formerScope !== undefined
    if (available && entry !== undefined) {
      const suppliedChanged = old !== undefined && (!isDeepStrictEqual(old, entry)
        || (previousReference !== undefined && reference !== undefined && !isDeepStrictEqual(previousReference, reference)))
      const readChanged = read !== undefined && (read.revision !== entry.revision || read.generation !== entry.generation || !isDeepStrictEqual(read.scope, entry.scope))
      const revised = suppliedChanged || readChanged
      if (!revised && prior?.status !== 'revised') continue
      const former = suppliedChanged ? old : prior?.status === 'revised' && hasFormer ? undefined : readChanged ? read : undefined
      result.push({ id, status: 'revised',
        ...(former?.revision === undefined ? prior?.previousRevision === undefined ? {} : { previousRevision: prior.previousRevision }
          : { previousRevision: former.revision }),
        currentRevision: entry.revision,
        ...(read === undefined && state.readRevisions[id] === undefined && !prior?.previouslyRead ? {} : { previouslyRead: true as const }),
        ...(former?.scope === undefined ? prior?.formerScope === undefined ? {} : { formerScope: structuredClone(prior.formerScope) }
          : { formerScope: structuredClone(former.scope) }),
        sources: revised ? uniqueSources([...(prior?.sources ?? []), ...(suppliedChanged ? previousReference?.originSources ?? [] : []),
          ...(suppliedChanged ? previousReference?.sources ?? [] : []), ...(readChanged ? read.sources : [])])
          : structuredClone(prior?.sources ?? []),
      })
      continue
    }
    if (old === undefined && prior === undefined && marker === undefined && read === undefined) continue
    const former = old ?? (hasFormer ? undefined : read)
    result.push({ id, status: available && marker !== undefined ? 'withdrawn' : 'unavailable',
      ...(read === undefined && state.readRevisions[id] === undefined && !prior?.previouslyRead ? {} : { previouslyRead: true as const }),
      ...(former === undefined ? prior?.previousRevision === undefined ? {} : { previousRevision: prior.previousRevision }
        : { previousRevision: former.revision }),
      ...(former?.scope === undefined ? prior?.formerScope === undefined ? {} : { formerScope: structuredClone(prior.formerScope) }
        : { formerScope: structuredClone(former.scope) }),
      sources: uniqueSources([...(marker?.sources ?? []), ...(prior?.sources ?? []),
        ...(previousReference?.originSources ?? []), ...(previousReference?.sources ?? []), ...(read?.sources ?? [])]),
    })
  }
  return result
}

function uniqueSources(sources: readonly StoredMemorySource[]): StoredMemorySource[] {
  return [...new Map(sources.map(source => [JSON.stringify(source), structuredClone(source)])).values()]
}

function indexEntry(entry: MemoryIndexEntry): MemoryIndexEntry {
  const { id, projectId, path, revision, generation, title, summary, type, nature, scope, updatedAt } = entry
  return { id, projectId, path, revision, ...(generation === undefined ? {} : { generation }), title, summary, type, nature, scope: structuredClone(scope), updatedAt }
}
