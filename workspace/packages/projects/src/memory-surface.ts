import type { Agent } from '@deepseek-ai/dsh-agent'
import { onProjectRequestPrepare } from './stock/request/harness.ts'
import type { PreparedRequestContext, RequestCurrentBlock, RequestHistoryProjection } from './stock/request/harness.ts'
import { latestProjectDispatch, readProjectMemoryCatalogState, type ProjectRequestPayloadStore } from './stock/request/records.ts'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { prepareMemoryIndexState, emptyMemoryIndexDelivery, markMemoryRead } from './memory-index-delivery.ts'
import type { MemoryIndexDeliveryState } from './memory-index-delivery.ts'
import type { ProjectMemoryService } from './memory-service.ts'
import type { MemoryContext, MemoryIndexEntry } from './memory-types.ts'
import type { ProjectMembership } from './records-types.ts'
import { renderMemoryContext } from './memory-context.ts'
import { combineProjectHistoryProjections, observedMemoryReads, projectReadEvidence } from './project-read-evidence.ts'
import { ProjectReadEvidenceModel } from './project-read-evidence-model.ts'
import type { ProjectRawPayloadReader } from './stock/recording/records.ts'
import type { WorkCurrentSupplyReader } from './work-current-representation.ts'

interface MemoryIndexSource {
  readonly kind: 'project-memory-index'
  readonly producer?: 'projects'
  readonly form: 'catalog'
  readonly projectId: string
  readonly delivery: 'full' | 'delta' | 'retained'
  readonly state: MemoryIndexDeliveryState
  readonly entries: MemoryIndexEntry[]
  readonly retired?: string[]
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'project-memory-index': MemoryIndexSource
    'project-supply-retired': { readonly kind: 'project-supply-retired'; readonly producer: 'projects'; readonly projectId: string }
  }
}
export interface PreparedMemorySurface {
  readonly current: MemoryContext
  readonly currentBlocks: readonly RequestCurrentBlock[]
  readonly historyProjection: RequestHistoryProjection
}

/** 每次只读 owner；实际供给来自 Projects dispatch，不认可未派发的 prepare 节点。 */
export function createProjectMemorySurface(agent: Agent, membership: ProjectMembership, memory: ProjectMemoryService): {
  prepare(signal?: AbortSignal, work?: WorkCurrentSupplyReader): Promise<PreparedMemorySurface>
  dispose(): void
} {
  const projectId = membership.project.id
  const target = { projectId, sessionId: membership.session.id }
  const request = { projectId, actor: { kind: 'session' as const, hostSessionId: membership.session.hostSessionId } }
  const reader = agent.ctx.get?.('projectsRead')
  const readEvidence = reader === undefined ? undefined : new ProjectReadEvidenceModel(projectId, agent.session.id, reader, agent.ctx.sessionPersistence as unknown as ProjectRawPayloadReader)
  return {
    async prepare(signal, work) {
      signal?.throwIfAborted()
      let current: MemoryContext
      try { current = await memory.context({ ...request, signal }, target) }
      catch (error) {
        signal?.throwIfAborted()
        current = { projectId, entries: [], provided: [], indexSynchronized: false, availability: 'unreadable',
          index: '当前共享记忆索引不可读；这不表示记忆为空，不能沿用旧索引或旧正文。',
          issues: [{ path: 'memory/', message: error instanceof Error ? error.message : String(error) }] }
      }
      signal?.throwIfAborted()
      const preparedEvidence = await readEvidence?.prepare(signal)
      // The inline compatibility fold is only for explicit legacy hosts which
      // have no Projects reader. Required references reject that synchronous path.
      const events = preparedEvidence === undefined ? agent.session.snapshotEvents() : []
      if (preparedEvidence?.issues.length) current = { ...current, issues: [...current.issues, ...preparedEvidence.issues.map(issue => ({ path: `read-evidence/${issue.seq}`, message: issue.message }))] }
      let state = await previousSupply(agent, projectId, signal) ?? emptyMemoryIndexDelivery()
      const reads = observedMemoryReads(projectId, events, preparedEvidence)
      for (const read of reads) state = markMemoryRead(state, read.id, read.revision)
      const candidate = prepareMemoryIndexState(state, current, reads)
      current = deepFreeze({ ...current, invalidations: candidate.invalidations ?? [] })
      // 读取事实由真实工具事件重建，不把“刚读过”写进 source 使未变目录移动。
      const suppliedState = { ...candidate, readRevisions: {} }
      const source: MemoryIndexSource = { kind: 'project-memory-index', producer: 'projects', form: 'catalog', projectId,
        delivery: 'full', state: suppliedState, entries: candidate.entries }
      const memoryBlock: RequestCurrentBlock = { producer: 'projects', key: `memory-index:${projectId}`,
        value: { content: [{ type: 'text', text: renderMemoryContext(current) }], source } }
      const projection = projectReadEvidence(projectId, events, current, { memoryBlock }, preparedEvidence, work)
      return deepFreeze({ current, currentBlocks: [memoryBlock],
        historyProjection: {
          projectCurrentness(history) {
            const projected = projection.projectCurrentness(history)
            return { ...projected, excludeMessageIds: history.flatMap(item => {
              const message = item.message
              return message.role === 'user' && message.id !== undefined && (!('currentBlock' in message) || message.currentBlock === undefined)
                && (message.source?.kind === 'project-memory-index' && message.source.projectId === projectId
                  || message.source?.kind === 'project-supply-retired' && message.source.projectId === projectId) ? [message.id] : []
            }) }
          },
          renderOmissions: projection.renderOmissions,
        } })
    },
    dispose() { readEvidence?.dispose() },
  }
}

/** 只消费最后一次真实派发的catalog；未派发的准备或append不成为供给状态。 */
async function previousSupply(agent: Agent, projectId: string, signal?: AbortSignal): Promise<MemoryIndexDeliveryState | undefined> {
  const dispatch = latestProjectDispatch(agent.session)
  if (dispatch === undefined) return
  return readProjectMemoryCatalogState(agent.session, dispatch, projectId, agent.ctx.sessionPersistence as unknown as ProjectRequestPayloadStore, signal)
}

/** 工作会话和 Bot 共用 Projects 真实每 attempt 准备端口。 */
export function installProjectMemorySurface(agent: Agent, membership: ProjectMembership, memory: ProjectMemoryService): () => void {
  if (membership.session.role !== 'main' && membership.session.role !== 'execution') return () => {}
  const surface = createProjectMemorySurface(agent, membership, memory)
  const dispose = onProjectRequestPrepare(agent, async (payload, previous): Promise<PreparedRequestContext> => {
    const prepared = await surface.prepare(payload.signal)
    return { ...previous, refresh: true, inputPolicy: 'identified-only',
      currentBlocks: [...(previous?.currentBlocks ?? []), ...prepared.currentBlocks], historyProjection: combineProjectHistoryProjections(previous?.historyProjection, prepared.historyProjection) }
  })
  return () => { dispose(); surface.dispose() }
}
