import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool, type ToolExecution, type ToolExecutionResult, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ProjectsCoreAccess } from './core-access.ts'
import { ProjectMemoryBatchOwner } from './memory-bot/index.ts'
import { MemoryBotStateConflictError, mutateMemoryBotStateWithin } from './memory-bot/state.ts'
import type { MemoryBatchInput, MemoryBatchRunResult, MemoryBatchSettlement, MemoryBotActivity, MemoryBotCorePort, MemoryBotCut, MemoryBotProject, SavedWorkCut } from './memory-bot/index.ts'
import type { MemoryRequestPort } from './memory-request.ts'
import type { ProjectMemoryService, MemoryAccessRequest } from './memory-service.ts'
import { installMemoryBotTools } from './memory-tools.ts'
import { completedToolValue } from './tool-result-retention.ts'
import { memoryBatchForModel } from './memory-source-model.ts'
import { createProjectMemorySurface } from './memory-surface.ts'
import type { MemoryWriteResult } from './memory-types.ts'
import type { MetadataSettlementWriter, ProjectStore } from './records.ts'
import type { ProjectMembership, ProjectCarrierMembership, ProjectSnapshot } from './records-types.ts'
import type { RootWriteScope } from './metadata-files.ts'
import { onProjectRequestPrepare } from './stock/request/harness.ts'
import type { ProjectInvocationPort } from './stock/project-ports.ts'
import type {} from './stock/read/index.ts'
import { MemoryPendingProjector } from './memory-bot/projection.ts'
import type { ProjectSessionPersistence } from './stock/persistence/index.ts'
import { MemoryReadModel, type MemoryReadIdentity } from './memory-bot/read-model.ts'
import { PROJECT_MEMORY_BOT_PROMPT } from './prompts/catalog.generated.ts'

export { PROJECT_MEMORY_BOT_PROMPT } from './prompts/catalog.generated.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'project-memory-batch': { kind: 'project-memory-batch'; projectId: string; batchId: string }
  }
}

const RESULT_TOOL = 'project_memory_batch_result'
/** 同一个集合同时约束实际执行与最终模型schema；late own-layer注册不能扩权。 */
const BOT_TOOLS = new Set(['project_memory_list', 'project_memory_read', 'project_memory_source', 'project_memory_save', 'project_memory_withdraw', RESULT_TOOL])

interface BatchDeclaration {
  status: 'complete' | 'no-change' | 'unresolved'
  requests: { request_id: string; status: 'applied' | 'no-change' | 'unresolved' }[]
}
interface WriteFact {
  callId: string
  requestIds: string[]
  projectId: string
  action: 'save' | 'withdraw'
  toolSucceeded: boolean
  retainedEffectAfterError: boolean
  memoryId?: string
  result: MemoryWriteResult
  previousMemoryId?: string
}
interface ActiveBatch {
  input: MemoryBatchInput
  startSeq: number
  messageId: string
  calls: Map<symbol, ToolExecution>
  callIds: Set<string>
  writes: WriteFact[]
  declarations: BatchDeclaration[]
  invalid: boolean
}
interface BotSlot { agent: Agent; membership: ProjectMembership; active?: ActiveBatch }

export interface ProjectMemoryRuntimePorts {
  ensureBot(projectId: string): Promise<Agent>
  /** Actual scheduler binding; a model-supplied call id is never provenance. */
  invocations: ProjectInvocationPort
  notify(projectId: string, changes: readonly { kind: 'added' | 'updated'; memoryId: string }[], batchId: string): void
  sourceTools?: {
    names: readonly string[]
    install(agent: Agent, resolveRequest: (exec: ToolRunContext) => Promise<MemoryAccessRequest>): () => void
  }
}

/** 只桥接真实宿主事实；队列、Memory正文与来源reader继续由原owner持有。 */
export class ProjectMemoryRuntime {
  readonly batches: ProjectMemoryBatchOwner
  readonly requests: MemoryRequestPort
  private readonly bots = new Map<string, BotSlot>()
  private readonly probes = new Map<string, { key: string; projector: MemoryPendingProjector; model: MemoryReadModel }>()
  private readonly consumed = new WeakSet<Promise<MemoryBatchSettlement>>()
  private readonly settlements = new Map<string, { batchId: string; writer: MetadataSettlementWriter }>()

  constructor(private readonly ctx: Context, private readonly store: ProjectStore,
    private readonly core: ProjectsCoreAccess, private readonly memory: ProjectMemoryService,
    private readonly ports: ProjectMemoryRuntimePorts) {
    const port: MemoryBotCorePort = {
      resolveProject: async projectId => {
        const view = await core.forProject(projectId)
        return { projectId: view.project.id, projectDirectory: view.projectRoot, archived: view.project.archived }
      },
      withStateWrite: async (project, purpose, transform, signal) => {
        // No ensureBot here: ordinary preparation must preserve the existing lazy Bot timing.
        const authorize = (fresh: ProjectSnapshot, activity: 'active' | 'settlement') => {
          const slot = [...this.bots.values()].find(value => value.membership.project.id === project.projectId)
          if (activity !== 'settlement' && fresh.project.archived) throw new Error('项目已归档，未接收新的记忆后台变换。')
          if (slot !== undefined) {
            const current = core.assertMetadataSession(fresh, { sessionId: slot.membership.session.id,
              hostSessionId: String(slot.agent.id), roles: ['memory'], activity })
            const header = current.carrier.ownedLifecycle?.rootHeader
            if (header !== undefined && header.createdAt !== slot.agent.session.header.createdAt) throw new Error('Memory Bot创建身份已变化。')
          }
        }
        const retained = purpose === 'settlement' ? this.settlements.get(project.projectId) : undefined
        if (purpose === 'settlement' && retained === undefined) throw new MemoryBotStateConflictError()
        // Mint before normal lock acquisition, but publish only after prepare is durable.
        const prepared = purpose === 'prepare' ? core.retainMetadataSettlement(project.projectId, fresh => authorize(fresh, 'settlement')) : undefined
        let batchId: string | undefined
        const action = (scope: RootWriteScope, fresh: ProjectSnapshot) => mutateMemoryBotStateWithin(scope, project.projectDirectory, project.projectId, latest => {
          const requests = new Set(latest.requests.map(request => request.requestId))
          const batches = new Set(latest.pendingBatches?.map(batch => batch.batchId) ?? [])
          // The original state owner still owns every terminal business rule.
          const result = transform(latest)
          if (purpose === 'accept') {
            const added = latest.requests.filter(request => !requests.has(request.requestId))
            core.assertMetadataSources(fresh, added.flatMap(request => [request.source, ...request.contextSources])
              .map(source => source.kind === 'communication-part' ? { kind: source.kind, hostSessionId: source.record.holder.hostSessionId } : source))
          } else if (purpose === 'prepare') {
            const selected = latest.pendingBatches?.find(batch => !batches.has(batch.batchId)) ?? latest.pendingBatches?.[0]
            if (selected !== undefined) core.assertMetadataSources(fresh, [
              ...selected.cuts.map(cut => ({ kind: 'carrier', projectId: project.projectId, sessionId: cut.sessionId, hostSessionId: cut.hostSessionId })),
              ...(selected.coverage?.sources ?? []).map(source => source.kind === 'communication-part'
                ? { kind: source.kind, hostSessionId: source.record.holder.hostSessionId } : source),
            ])
            batchId = selected?.batchId
          } else if (latest.lastResult?.batchId !== retained!.batchId) throw new MemoryBotStateConflictError()
          return result
        }, signal)
        try {
          const result = retained === undefined
            ? await core.withMetadataWrite(project.projectId, fresh => authorize(fresh, 'active'), action, signal)
            : await retained.writer.write(action, signal)
          if (prepared !== undefined && batchId !== undefined) {
            this.settlements.get(project.projectId)?.writer.release()
            this.settlements.set(project.projectId, { batchId, writer: prepared })
          } else prepared?.release()
          return result
        } catch (error) { prepared?.release(); throw error }
        finally {
          if (retained !== undefined) { retained.writer.release(); this.settlements.delete(project.projectId) }
        }
      },
      readSavedCuts: (project, cuts) => this.readSavedCuts(project, cuts),
      discardProbe: projectId => { this.probes.delete(projectId) },
      probePendingMemory: (project, processed) => this.probePendingMemory(project, processed),
      readPendingMemory: (project, processed, cuts, version) => this.readPendingMemory(project, processed, cuts, version),
      advanceProcessed: async (projectId, processed) => { await this.probes.get(projectId)?.model.advanceProcessed(processed) },
      validateFrozenSources: (project, cuts, signal) => this.validateFrozenSources(project, cuts, signal),
      readSource: async (project, source, signal) => {
        const bot = await this.bot(project.projectId)
        return memory.readSource({ projectId: project.projectId, actor: { kind: 'session', hostSessionId: String(bot.id) }, signal }, source, { before: 0, after: 0 })
      },
      pinSource: async (project, source, signal) => {
        const bot = await this.bot(project.projectId)
        const value = await memory.readSource({ projectId: project.projectId, actor: { kind: 'session', hostSessionId: String(bot.id) }, signal }, source, { before: 0, after: 0 })
        // 精确来源沿用本次读取；只有旧定位转换表示后才再读固定引用。
        const pinned = source.kind === 'message' || source.kind === 'tool'
          ? value.nativeItems?.find(item => item.isTarget)?.nativeSource ?? value.source ?? source
          : source
        if (pinned.kind === 'settings' || pinned.kind === 'record') throw new Error('该来源不是可冻结的请求上下文。')
        return { source: pinned, value: pinned === source ? value
          : await memory.readSource({ projectId: project.projectId, actor: { kind: 'session', hostSessionId: String(bot.id) }, signal }, pinned, { before: 0, after: 0 }) }
      },
      runFrozenBatch: (project, input, signal) => this.runFrozenBatch(project, input, signal),
      settled: (projectId, settlement) => this.notify(projectId, settlement),
    }
    this.batches = new ProjectMemoryBatchOwner(port)
    ctx.effect(() => () => this.probes.clear(), 'projects.memory-probe')
    this.requests = {
      accept: async (request, signal) => {
        // B.accept只等待durable接收与检查；不把工作tool的取消传给已接收批次。
        const result = await this.batches.accept(request, signal)
        if (result.kind === 'accepted') void this.batches.whenIdle(request.projectId)
          .then(settlement => { if (settlement !== undefined) this.notify(request.projectId, settlement) })
          .catch(error => this.report(error))
        return result
      },
    }
  }

  /** Drain the original batch owner before retiring its unused settlement authorities. */
  async close(): Promise<void> {
    try { await this.batches.close() }
    finally {
      for (const retained of this.settlements.values()) retained.writer.release()
      this.settlements.clear()
    }
  }

  activity(projectId: string, activity: MemoryBotActivity): void {
    void this.batches.activity(projectId, activity).then(check => {
      if (check.kind === 'started') this.consume(projectId, check.completion)
      else if (check.kind === 'failed') this.report(new Error(check.message))
    }).catch(error => this.report(error))
  }

  /** 必须在Agent setup最先安装，之后不能再装工作角色工具或prompt。 */
  installBot(agent: Agent, membership: ProjectMembership): () => void {
    if (membership.session.role !== 'memory' || String(agent.id) !== membership.session.hostSessionId
      || membership.session.projectId !== membership.project.id) throw new Error('Memory Bot绑定身份不一致。')
    if (this.bots.has(String(agent.id))) throw new Error('Memory Bot重复安装。')
    const slot: BotSlot = { agent, membership }
    const tools = new Set([...BOT_TOOLS, ...(this.ports.sourceTools?.names ?? [])])
    const memorySurface = createProjectMemorySurface(agent, membership, this.memory)
    const disposers: Array<() => unknown> = []
    this.bots.set(String(agent.id), slot)
    try {
      disposers.push(() => memorySurface.dispose())
      disposers.push(agent.ctx.effect(() => () => { if (this.bots.get(String(agent.id)) === slot) this.bots.delete(String(agent.id)) }))
      disposers.push(agent.ctx.tools.guard(exec => {
        if (!tools.has(exec.name)) return 'Memory Bot只可使用本批限定记忆及来源读取工具。'
        const active = slot.active
        if (active === undefined || exec.agent !== agent || agent.status !== 'running'
          || this.ctx.agents.get(agent.id) !== agent || this.ctx.agents.currentInitiator() !== agent
          || exec.parent !== undefined) return '记忆工具只能由当前Bot的真实批次调用。'
        const invocation = this.ports.invocations.get(exec as ToolRunContext)
        if (invocation === undefined || invocation.sessionId !== agent.id
          || invocation.sessionCreatedAt !== agent.session.header.createdAt
          || invocation.startEventSeq < active.startSeq || invocation.callId !== exec.callId
          || invocation.rootCallId !== exec.rootCallId) return '记忆工具没有本批真实调用来源。'
        const events = agent.session.snapshotEvents(SessionLogOffset(active.startSeq))
        const input = events.find(event => event.type === 'user/message' && String(event.data.id) === active.messageId)
        const call = events.find(event => event.seq === invocation.startEventSeq && event.type === 'tool/call'
          && event.data.callId === exec.callId && event.data.name === exec.name)
        if (input === undefined || call === undefined || call.seq <= input.seq) return '该工具调用不属于当前批次原生输入。'
        if (active.callIds.has(String(exec.callId))) { active.invalid = true; return '本批工具调用ID重复。' }
        active.callIds.add(String(exec.callId))
        active.calls.set(exec.token, exec)
        return undefined
      }))
      disposers.push(agent.ctx.tools.presentAs('native'))
      disposers.push(agent.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        const assembly = await next()
        return context.agent !== agent ? assembly : { ...assembly, tools: assembly.tools.filter(tool => tools.has(tool.name)) }
      }))
      disposers.push(onProjectRequestPrepare(agent, async (payload, previous) => {
        const active = slot.active
        if (active === undefined) throw new Error('Memory Bot没有可派发的实际批次。')
        if (active.input.frozen.kind !== 'explicit') {
          await this.validateFrozenSources({ projectId: membership.project.id }, active.input.frozen.cuts, payload.signal)
        }
        const current = await memorySurface.prepare(payload.signal)
        // Projects dispatch owns this selection; the append log is never truncated.
        return { ...previous, role: 'memory' as const, refresh: true as const, inputPolicy: 'identified-only' as const,
          currentBlocks: current.currentBlocks, historyProjection: current.historyProjection,
          historySeqs: agent.session.surface.nodes.filter(seq => seq >= active.startSeq) }
      }))
      disposers.push(agent.ctx.systemPrompt.section({ name: `projects:memory-bot:${membership.session.id}`,
        order: agent.ctx.systemPrompt.getSectionOrder('TEAM_POLICY'), text: PROJECT_MEMORY_BOT_PROMPT }))
      disposers.push(installMemoryBotTools(agent, {
        service: this.memory,
        resolveRequest: async exec => {
          const scope = await this.core.forTool(exec, 'project_memory')
          if (scope.project.id !== membership.project.id || scope.role !== 'memory'
            || scope.hostSessionId !== String(agent.id) || slot.active === undefined) throw new Error('当前Bot批次归属不可用。')
          return { projectId: scope.project.id, actor: { kind: 'session', hostSessionId: scope.hostSessionId } }
        },
      }))
      if (this.ports.sourceTools !== undefined) disposers.push(this.ports.sourceTools.install(agent, async exec => {
        const scope = await this.core.forTool(exec, 'project_memory')
        if (scope.project.id !== membership.project.id || scope.role !== 'memory' || scope.hostSessionId !== String(agent.id) || slot.active === undefined) throw new Error('当前Bot来源读取归属不可用。')
        return { projectId: scope.project.id, actor: { kind: 'session', hostSessionId: scope.hostSessionId }, signal: exec.signal }
      }))
      disposers.push(agent.ctx.tools.register(defineTool({
        name: RESULT_TOOL, description: 'Report this frozen batch only, once per effective request_id. Applied requires a successful matching save/withdraw whose request_ids served that request in this run; the runtime binds actual execution facts. Do not supply call ids or memory ids. After rereading current memory, no-change is valid even if a previous run saved but did not finish settlement. Missing or unresolved items do not complete the batch. No requests still requires an overall result.',
        parameters: {
          status: { type: 'string', required: true, enum: ['complete', 'no-change', 'unresolved'] },
          requests: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
            request_id: { type: 'string', required: true }, status: { type: 'string', required: true, enum: ['applied', 'no-change', 'unresolved'] },
          } } },
        }, output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: async (args, exec) => { exec.concludeTurn(); return JSON.parse(JSON.stringify(args)) as JsonValue },
      })))
      disposers.push(agent.ctx.on('tools/result', (exec, result) => this.toolResult(slot, exec, result)))
    } catch (error) {
      for (const dispose of disposers.toReversed()) dispose()
      this.bots.delete(String(agent.id))
      throw error
    }
    return () => { for (const dispose of disposers.toReversed()) dispose(); if (this.bots.get(String(agent.id)) === slot) this.bots.delete(String(agent.id)) }
  }

  private async bot(projectId: string): Promise<Agent> {
    const agent = await this.ports.ensureBot(projectId)
    const slot = this.bots.get(String(agent.id))
    if (slot?.agent !== agent || slot.membership.project.id !== projectId || slot.membership.session.role !== 'memory') throw new Error('真实Memory Bot未安装或项目归属不一致。')
    if (!agent.options.provider || !agent.options.model) throw new Error('Memory Bot缺少明确模型route，不能使用默认fallback。')
    return agent
  }

  private async selectedCuts(project: MemoryBotProject, expected?: readonly MemoryBotCut[]) {
    const memberships = (await this.store.listProjectCarriers(project.projectId)).filter(item => (item.session.role === 'main' || item.session.role === 'execution') && item.carrier.sourceLifecycle.kind === 'available')
    const selected = expected === undefined ? memberships : expected.map(cut => {
      const member = memberships.find(item => item.session.id === cut.sessionId && item.carrier.hostSessionId === cut.hostSessionId)
      if (member === undefined) throw new Error('冻结来源已删除、不可用或不属于当前工作会话。')
      return member
    })
    // Capture all live immutable cuts synchronously after membership preparation.
    return selected.map(member => {
      const live = this.ctx.sessions.get(SessionId(member.carrier.hostSessionId))
      const endSeq = expected?.find(cut => cut.hostSessionId === member.carrier.hostSessionId)?.endSeq ?? (live === undefined ? undefined : Number(live.seq) - 1)
      return { member, live, endSeq }
    })
  }

  private async withSavedCut<T>(project: MemoryBotProject, captured: Awaited<ReturnType<ProjectMemoryRuntime['selectedCuts']>>[number], action: (cut: SavedWorkCut) => T): Promise<T> {
    const { member, live, endSeq } = captured, persistence = this.ctx.sessionPersistence as ProjectSessionPersistence
    const id = SessionId(member.carrier.hostSessionId), directory = await persistence.recordDirectory(id)
    const actualEnd = endSeq ?? directory.nextSeq - 1
    if (!Number.isSafeInteger(actualEnd) || actualEnd < -1 || actualEnd >= directory.nextSeq) throw new Error('冻结cut超出真实原文前缀。')
    const receipt = await persistence.confirmThrough(id, actualEnd + 1, live === undefined ? {} : { session: live })
    if (receipt.proof !== 'writer-fsync' || receipt.nextSeq < actualEnd + 1 || receipt.journalIdentity !== directory.journalIdentity
      || receipt.owner.projectId !== project.projectId || receipt.owner.logicalSessionId !== member.session.id
      || member.carrier.header !== undefined && (member.carrier.header.createdAt !== receipt.header.createdAt || member.carrier.header.version !== receipt.header.version)) throw new Error('冻结来源的已保存owner或creation不匹配。')
    const events = []
    for await (const event of persistence.readCanonicalRange(id, 0, actualEnd + 1, { through: receipt })) events.push(event)
    await this.revalidateMemoryMembers(project, [member])
    return action({ sessionId: member.session.id, hostSessionId: member.carrier.hostSessionId, sessionCreatedAt: receipt.header.createdAt,
      formatVersion: receipt.header.version, role: member.session.role === 'main' ? 'main' : 'execution', endSeq: actualEnd, events })
  }

  private async readSavedCuts(project: MemoryBotProject, expected?: readonly MemoryBotCut[]): Promise<readonly SavedWorkCut[]> {
    const captured = await this.selectedCuts(project, expected), cuts: SavedWorkCut[] = []
    for (const item of captured) cuts.push(await this.withSavedCut(project, item, cut => cut))
    return cuts
  }

  private async readPendingMemory(project: MemoryBotProject, processed: readonly MemoryBotCut[], expected?: readonly MemoryBotCut[], projectionVersion: 1 | 2 = 2) {
    try {
      const members = await this.memoryMembers(project, expected)
      const model = await this.memoryModel(project, members, processed, projectionVersion)
      // Capture all acknowledged cuts before any durability barrier. Session.seq
      // is never accepted as proof that these bytes have been saved.
      const captured = []
      for (const member of members) {
        const identity = this.memoryIdentity(member), directory = await model.directory(identity)
        const endSeq = expected?.find(cut => cut.hostSessionId === identity.hostSessionId)?.endSeq ?? directory.nextSeq - 1
        captured.push({ member, identity, directory, endSeq })
      }
      const cuts: MemoryBotCut[] = [], persistence = this.ctx.sessionPersistence as ProjectSessionPersistence
      for (const item of captured) {
        const id = SessionId(item.identity.hostSessionId), live = this.ctx.sessions.get(id)
        const receipt = await persistence.confirmThrough(id, item.endSeq + 1, live === undefined ? {} : { session: live })
        if (receipt.proof !== 'writer-fsync' || receipt.nextSeq < item.endSeq + 1 || receipt.journalIdentity !== item.directory.journalIdentity
          || receipt.owner.projectId !== project.projectId || receipt.owner.logicalSessionId !== item.identity.sessionId
          || receipt.header.createdAt !== item.directory.header.createdAt) throw new Error('Memory frozen cut has no matching durable receipt.')
        await model.append(item.identity, item.directory, item.endSeq, receipt)
        cuts.push({ sessionId: item.identity.sessionId, hostSessionId: item.identity.hostSessionId, endSeq: item.endSeq })
      }
      await this.revalidateMemoryMembers(project, members)
      return { cuts, pending: model.projector.projection() }
    } catch (error) { this.probes.delete(project.projectId); throw error }
  }

  private async probePendingMemory(project: MemoryBotProject, processed: readonly MemoryBotCut[]) {
    try {
      const members = await this.memoryMembers(project)
      const model = await this.memoryModel(project, members, processed, 2)
      for (const member of members) {
        const identity = this.memoryIdentity(member), directory = await model.directory(identity)
        await model.append(identity, directory)
      }
      await this.revalidateMemoryMembers(project, members)
      const { visibleCharacters, completeTurns } = model.projector.statistics()
      return { visibleCharacters, completeTurns }
    } catch (error) { this.probes.delete(project.projectId); throw error }
  }

  private memoryIdentity(member: ProjectCarrierMembership): MemoryReadIdentity {
    return { sessionId: member.session.id, hostSessionId: member.carrier.hostSessionId, role: member.session.role === 'main' ? 'main' : 'execution',
      ...(member.carrier.header === undefined ? {} : { sessionCreatedAt: member.carrier.header.createdAt, formatVersion: member.carrier.header.version }) }
  }

  private async memoryMembers(project: Pick<MemoryBotProject, 'projectId'>, expected?: readonly MemoryBotCut[]) {
    const members = (await this.store.listProjectCarriers(project.projectId)).filter(item => (item.session.role === 'main' || item.session.role === 'execution') && item.carrier.sourceLifecycle.kind === 'available')
    if (expected === undefined) return members
    return expected.map(cut => {
      const member = members.find(item => item.session.id === cut.sessionId && item.carrier.hostSessionId === cut.hostSessionId)
      if (member === undefined) throw new Error('冻结来源已删除、不可用或不属于当前工作会话。')
      return member
    })
  }

  private memoryMembersKey(members: readonly ProjectCarrierMembership[]): string {
    return JSON.stringify(members.map(member => [member.session.id, member.carrier.hostSessionId, member.session.role, member.carrier.header]))
  }

  private async revalidateMemoryMembers(project: Pick<MemoryBotProject, 'projectId'>, members: readonly ProjectCarrierMembership[]): Promise<void> {
    const current = await this.memoryMembers(project, members.map(member => ({ sessionId: member.session.id, hostSessionId: member.carrier.hostSessionId, endSeq: -1 })))
    if (this.memoryMembersKey(current) !== this.memoryMembersKey(members) || current.some(member => member.project.archived)) throw new Error('Memory source ownership, creation or lifecycle changed during projection.')
  }

  private async memoryModel(project: MemoryBotProject, members: readonly ProjectCarrierMembership[], processed: readonly MemoryBotCut[], version: 1 | 2) {
    const key = this.memoryMembersKey(members)
    let cached = this.probes.get(project.projectId)
    if (cached?.key !== key || cached.model.version !== version) {
      const model = new MemoryReadModel(project.projectId, this.ctx.sessionPersistence as ProjectSessionPersistence, processed, version)
      cached = { key, model, projector: model.projector }
      this.probes.set(project.projectId, cached)
    } else await cached.model.advanceProcessed(processed)
    return cached.model
  }

  private async validateFrozenSources(project: Pick<MemoryBotProject, 'projectId'>, cuts: readonly MemoryBotCut[], signal: AbortSignal): Promise<void> {
    if (cuts.length === 0) return
    signal.throwIfAborted()
    const members = await this.memoryMembers(project, cuts), cached = this.probes.get(project.projectId)
    if (cached === undefined || cached.key !== this.memoryMembersKey(members)) throw new Error('Memory frozen source projection is no longer admitted.')
    for (const member of members) {
      signal.throwIfAborted()
      const directory = await cached.model.directory(this.memoryIdentity(member))
      const cut = cuts.find(cut => cut.hostSessionId === member.carrier.hostSessionId)!
      if (directory.nextSeq < cut.endSeq + 1) throw new Error('Memory frozen source cut is no longer available.')
    }
    await this.revalidateMemoryMembers(project, members)
    signal.throwIfAborted()
  }

  private async runFrozenBatch(project: MemoryBotProject, input: MemoryBatchInput, signal: AbortSignal): Promise<MemoryBatchRunResult> {
    const agent = await this.bot(project.projectId)
    const slot = this.bots.get(String(agent.id))!
    signal.throwIfAborted()
    if (slot.active !== undefined || agent.status !== 'idle') throw new Error('Memory Bot并未停稳，不能启动另一批。')
    const message = createUserMessage({ source: { kind: 'project-memory-batch', projectId: project.projectId, batchId: input.frozen.batchId }, content: [{ type: 'text', text: JSON.stringify(memoryBatchForModel(input)) }] })
    const active: ActiveBatch = { input, startSeq: Number(agent.session.seq), messageId: String(message.id), calls: new Map(), callIds: new Set(), writes: [], declarations: [], invalid: false }
    slot.active = active
    const abort = () => agent.cancel({ kind: 'user' }, { keepInbox: true })
    signal.addEventListener('abort', abort, { once: true })
    try {
      agent.send(message, 'next-turn', true)
      if (signal.aborted) abort()
      await agent.whenIdle()
      let durable = false
      try {
        durable = await this.ctx.sessions.flush(agent.session)
        if (!durable) this.report(new Error('Memory Bot原生日志flush未确认。'))
      } catch (error) { this.report(error) }
      const events = agent.session.snapshotEvents(SessionLogOffset(active.startSeq))
      const consumed = events.find(event => event.type === 'user/message' && String(event.data.id) === active.messageId)
      const started = consumed === undefined ? undefined : events.findLast(event => event.type === 'turn/start' && event.seq < consumed.seq)
      const ended = started?.type === 'turn/start' ? events.findLast(event => event.type === 'turn/end' && event.data.turn === started.data.turn) : undefined
      const reason = ended?.type === 'turn/end' ? ended.data.reason.kind : signal.aborted ? 'aborted' : 'interrupted'
      const outcome = this.outcome(project.projectId, active, reason)
      return durable ? outcome : { ...outcome, processing: active.writes.length > 0 ? 'partial' : 'failed', completedRequestIds: [] }
    } finally { signal.removeEventListener('abort', abort); if (slot.active === active) delete slot.active }
  }

  private toolResult(slot: BotSlot, exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined {
    const active = slot.active
    if (active === undefined) return
    if (!active.calls.has(exec.token)) {
      // 原生pre-execute拒绝也会产生真实失败结果，不能从本批write事实里过滤掉。
      if (exec.agent !== slot.agent || this.ctx.agents.currentInitiator() !== slot.agent) return
      const events = slot.agent.session.snapshotEvents(SessionLogOffset(active.startSeq))
      const input = events.find(event => event.type === 'user/message' && String(event.data.id) === active.messageId)
      if (input === undefined || !events.some(event => event.type === 'tool/call' && event.seq > input.seq
        && event.data.callId === exec.callId && event.data.name === exec.name)) return
    }
    if (exec.name === RESULT_TOOL) {
      if (result.isError) active.invalid = true
      else {
        const value = readDeclaration(result.value)
        if (value === undefined) active.invalid = true
        else active.declarations.push(value)
      }
    }
    if (exec.name === 'project_memory_save' || exec.name === 'project_memory_withdraw') {
      const action = exec.name === 'project_memory_save' ? 'save' : 'withdraw'
      const args = exec.arguments as { memory_id?: string; request_ids?: unknown }
      const requestIds = Array.isArray(args.request_ids) && args.request_ids.every(id => typeof id === 'string') ? [...args.request_ids] as string[] : []
      const completed = completedToolValue(exec) as MemoryWriteResult | undefined
      const value = result.isError
        ? completed ?? { kind: 'failed' as const, stage: action === 'save' ? 'body' as const : 'withdrawal' as const, message: result.error.message }
        : result.value as unknown as MemoryWriteResult
      const retainedEffectAfterError = result.isError && completed !== undefined && ['saved', 'withdrawn', 'partial', 'unknown'].includes(completed.kind)
      if (retainedEffectAfterError) active.invalid = true
      if (value.kind === 'saved' && value.memory.projectId !== slot.membership.project.id) active.invalid = true
      active.writes.push({ callId: String(exec.callId), requestIds, projectId: slot.membership.project.id, action, toolSucceeded: !result.isError, retainedEffectAfterError,
        ...(args.memory_id === undefined ? {} : { memoryId: args.memory_id, previousMemoryId: args.memory_id }), result: value })
    }
    return undefined
  }

  private outcome(projectId: string, active: ActiveBatch, nativeReason: MemoryBatchRunResult['nativeReason']): MemoryBatchRunResult {
    const completedRequestIds: string[] = []
    const declaration = active.declarations.length === 1 ? active.declarations[0] : undefined
    let complete = !active.invalid && declaration !== undefined && declaration.status !== 'unresolved'
    const counts = new Map<string, number>()
    for (const item of declaration?.requests ?? []) counts.set(item.request_id, (counts.get(item.request_id) ?? 0) + 1)
    const seen = new Set<string>()
    for (const item of declaration?.requests ?? []) {
      const request = active.input.requests.find(value => value.request.requestId === item.request_id)?.request
      if (seen.has(item.request_id) || counts.get(item.request_id) !== 1 || request === undefined) { complete = false; continue }
      seen.add(item.request_id)
      const action = request.operation === 'withdraw' ? 'withdraw' : 'save'
      // 关联来自本轮真实成功写动作；先前失败不否决后来合法成功的纠正。
      const applied = active.writes.some(write => {
        const id = write.result.kind === 'saved' ? write.result.memory.id : write.result.kind === 'withdrawn' ? write.result.id : undefined
        return write.toolSucceeded && write.requestIds.includes(item.request_id) && write.projectId === projectId && write.action === action && id !== undefined
          && (write.result.kind !== 'saved' || write.result.memory.projectId === projectId)
          && (write.memoryId === undefined || write.memoryId === id)
          && (request.memoryId === undefined || request.memoryId === id && request.memoryId === write.memoryId)
      })
      if (item.status === 'no-change') {
        // 保留的错误调用效果不能单独变成完成凭据；不改变普通失败／未执行的无变化声明。
        if (!applied && active.writes.some(write => write.retainedEffectAfterError && write.requestIds.includes(item.request_id))) complete = false
        else completedRequestIds.push(item.request_id)
      } else if (item.status === 'applied') {
        if (applied) completedRequestIds.push(item.request_id)
        else complete = false
      } else complete = false
    }
    if (active.input.requests.some(item => !completedRequestIds.includes(item.request.requestId))) complete = false
    if (declaration?.status === 'no-change' && active.writes.some(write => write.result.kind === 'saved' || write.result.kind === 'withdrawn')) complete = false
    const writes = active.writes.map(({ result, previousMemoryId }) => ({ result, ...(previousMemoryId === undefined ? {} : { previousMemoryId }) }))
    return { nativeReason, processing: complete ? 'complete' : active.writes.length > 0 || completedRequestIds.length > 0 ? 'partial' : 'failed', writes,
      completedRequestIds: nativeReason === 'completed' ? completedRequestIds : [] }
  }

  private consume(projectId: string, completion: Promise<MemoryBatchSettlement>): void {
    if (this.consumed.has(completion)) return
    this.consumed.add(completion)
    void completion.then(settlement => this.notify(projectId, settlement)).catch(error => this.report(error))
  }
  private readonly notified = new WeakSet<MemoryBatchSettlement>()
  private notify(projectId: string, settlement: MemoryBatchSettlement): void {
    if (this.notified.has(settlement)) return
    this.notified.add(settlement)
    if (settlement.status === 'completed' && settlement.changes.length > 0) this.ports.notify(projectId, settlement.changes, settlement.batchId)
  }
  private report(error: unknown): void { this.ctx.logger.warn(`projects memory batch: ${error instanceof Error ? error.message : String(error)}`) }
}

function readDeclaration(value: JsonValue): BatchDeclaration | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !['complete', 'no-change', 'unresolved'].includes(String(value.status)) || !Array.isArray(value.requests)) return undefined
  if (value.requests.some(item => typeof item !== 'object' || item === null || Array.isArray(item)
    || typeof item.request_id !== 'string' || !['applied', 'no-change', 'unresolved'].includes(String(item.status))
    || Object.keys(item).some(key => key !== 'request_id' && key !== 'status'))) return undefined
  return value as unknown as BatchDeclaration
}
