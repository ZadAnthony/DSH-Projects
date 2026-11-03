import type { Agent } from '@deepseek-ai/dsh-agent'
import {onProjectRequestPrepare,readRequestSourcedHistory,prepareProjectRequestMeter} from './stock/request/harness.ts'
import type {PreparedRequestContext} from './stock/request/harness.ts'
import type { ContextSnapshotSection, LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { RequestContentProjection, RequestCurrentBlock, RequestDispatchCandidate, RequestHistoryProjection, RequestSourcedHistory } from './stock/request/harness.ts'
import { joinContextSections } from '@deepseek-ai/dsh-system-prompt'
import type { OverviewContext } from './features/overview/contract.ts'
import { renderProjectInstructions, renderSessionInstructions } from './features/settings/service.ts'
import type { PreparedProjectInstructions, PreparedSessionInstructions, ProjectInstructionContext, SessionInstructionContext } from './features/settings/types.ts'
import { createProjectMemorySurface } from './memory-surface.ts'
import type { ProjectMemoryService } from './memory-service.ts'
import { projectIdentityAvailable, projectIdentityContext, projectInvocationInputsContext, projectOverviewContextParts, projectRuntimeConfigContext, projectRuntimeLifecycleContext } from './project-context.ts'
import { combineProjectHistoryProjections } from './project-read-evidence.ts'
import type { ProjectInvocationInput } from './public-types.ts'
import type { ProjectMembership, ProjectSnapshot } from './records-types.ts'
import { prepareCommunicationRequest } from './communication/request.ts'
import type { CommunicationRequestAccess, PreparedCommunicationRequest } from './communication/request.ts'
import { prepareMainHistoryRequestProjection, type MainHistoryImportFitter } from './continuity/history-request.ts'
import { communicationError, jsonFrozen } from './communication/contract.ts'
import { prepareScheduleRequestContext } from './features/schedule/request-context.ts'
import type { WorkCurrentSupply } from './work-current-representation.ts'

interface ProjectRequestSource {
  readonly kind: 'project-request-context'
  readonly producer: 'projects'
  readonly form: 'snapshot'
  readonly sections: readonly ContextSnapshotSection[]
  readonly projectId: string
  readonly sessionId: string
  readonly object?: { readonly kind: 'identity' | 'runtime' | 'overview'; readonly key: string }
  readonly scope?: { readonly projectId: string; readonly sessionId?: string }
  readonly status?: 'available' | 'unreadable'
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'project-request-context': ProjectRequestSource }
}
export interface ProjectRequestContextOptions {
  readonly communication?: CommunicationRequestAccess
  readonly mainHistory?: MainHistoryImportFitter
  readonly memory: ProjectMemoryService
  readonly projectFilesRoot: string
  readSnapshot(): Promise<ProjectSnapshot>
  readOverview(): Promise<OverviewContext>
  prepareProjectInstructions(signal?: AbortSignal): Promise<PreparedProjectInstructions>
  prepareSessionInstructions(signal?: AbortSignal): Promise<PreparedSessionInstructions>
  invocationInputs(snapshot: ProjectSnapshot | undefined): readonly ProjectInvocationInput[]
}

/** 完整owner读取后只返回当次数据；位置、退休和实际供给由原生dispatch拥有。 */
export function installProjectRequestContext(agent: Agent, membership: ProjectMembership, options: ProjectRequestContextOptions): () => void {
  const { project, session } = membership
  const memory = createProjectMemorySurface(agent, membership, options.memory)
  let projectInstructions: ProjectInstructionContext = { projectId: project.id, available: false, message: '本次请求尚未准备。' }
  let sessionInstructions: SessionInstructionContext = { projectId: project.id, sessionId: session.id, available: false, message: '本次请求尚未准备。' }
  // 固定职责、工具规范及SDK先于可变补充；后续原生输出约束和宿主尾段保留原顺序。
  const instructionOrder = agent.ctx.systemPrompt.getSectionOrder('TOOLS_SDK') + 1
  const disposers = [
    agent.ctx.systemPrompt.section({ name: `projects:project-instructions:${project.id}`, order: instructionOrder,
      interpolate: false, text: () => instructionBlock(projectInstructions, false) }),
    agent.ctx.systemPrompt.section({ name: `projects:instructions:${session.id}`, order: instructionOrder + 1,
      interpolate: false, text: () => instructionBlock(sessionInstructions, true) }),
    onProjectRequestPrepare(agent, async (payload, previous) => {
      payload.signal?.throwIfAborted()
      // This reader belongs to this exact prepare, including auxiliary/retry requests.
      let workSupply: WorkCurrentSupply | undefined
      const [snapshotRead, overviewRead, projectRead, sessionRead, memoryRead] = await Promise.allSettled([
        options.readSnapshot(), options.readOverview(),
        options.prepareProjectInstructions(payload.signal).then(value => structuredClone(value.get())),
        options.prepareSessionInstructions(payload.signal).then(value => structuredClone(value.get())),
        memory.prepare(payload.signal, () => workSupply),
      ])
      payload.signal?.throwIfAborted()
      const snapshot = snapshotRead.status === 'fulfilled' ? structuredClone(snapshotRead.value) : undefined
      projectInstructions = projectRead.status === 'fulfilled' ? projectRead.value
        : { projectId: project.id, available: false, message: failureText(projectRead.reason) }
      sessionInstructions = sessionRead.status === 'fulfilled' ? sessionRead.value
        : { projectId: project.id, sessionId: session.id, available: false, message: failureText(sessionRead.reason) }
      const board: OverviewContext = overviewRead.status === 'fulfilled' ? structuredClone(overviewRead.value)
        : { projectId: project.id, status: 'unreadable', message: failureText(overviewRead.reason), readAt: '' }
      if (memoryRead.status === 'rejected') throw memoryRead.reason
      const imported = options.mainHistory === undefined ? [] : readRequestSourcedHistory(agent.session)
      const identityKey = `identity:${project.id}:${session.id}`
      // Native dispatch sorts keys; keep stable configuration/lifecycle before changing turn inputs.
      const runtimeKey = (part: 'config' | 'lifecycle' | 'turn-inputs') => `runtime:${part}:${project.id}:${session.id}`
      const snapshotAvailable = projectIdentityAvailable(snapshot, session)
      const invocationInputs = options.invocationInputs(snapshot)
      const block = (key: string, kind: 'identity' | 'runtime' | 'overview', text: string, status: 'available' | 'unreadable'): RequestCurrentBlock => ({
        producer: 'projects', key, value: { content: [{ type: 'text', text }], source: {
          kind: 'project-request-context', producer: 'projects', form: 'snapshot', projectId: project.id, sessionId: session.id,
          object: { kind, key }, scope: kind === 'overview' ? { projectId: project.id } : { projectId: project.id, sessionId: session.id },
          status, sections: [{ name: key, text }],
        } },
      })
      // 这是本producer的完整当前集合；缺失看板区块只在owner成功读取后确认退出。
      const currentBlocks = [
        block(identityKey, 'identity', projectIdentityContext(snapshot, session, options.projectFilesRoot), snapshotAvailable ? 'available' : 'unreadable'),
        block(runtimeKey('config'), 'runtime', projectRuntimeConfigContext(runtimeConditions(agent, payload.config)), 'available'),
        block(runtimeKey('lifecycle'), 'runtime', projectRuntimeLifecycleContext(snapshot), snapshot === undefined ? 'unreadable' : 'available'),
        block(runtimeKey('turn-inputs'), 'runtime', projectInvocationInputsContext(snapshot, invocationInputs), snapshot === undefined ? 'unreadable' : 'available'),
        ...prepareScheduleRequestContext(agent, { projectId: project.id, sessionId: session.id }, payload.purpose === 'conversation' ? payload.turn : undefined),
        ...projectOverviewContextParts(board).map(part => block(part.key, 'overview', part.text, part.status)),
        ...memoryRead.value.currentBlocks,
      ]
      workSupply = { currentBlocks, invocationInputs: { key: runtimeKey('turn-inputs'), value: invocationInputs }, instructions: [
        ...(projectInstructions.available && projectInstructions.value !== undefined ? [{
          sectionName: `projects:project-instructions:${project.id}`, sectionText: instructionBlock(projectInstructions, false), value: projectInstructions.value,
        }] : []),
        ...(sessionInstructions.available && sessionInstructions.value !== undefined ? [{
          sectionName: `projects:instructions:${session.id}`, sectionText: instructionBlock(sessionInstructions, true), value: sessionInstructions.value,
        }] : []),
      ] }
      const communication = options.communication === undefined ? undefined : await prepareCommunicationRequest(agent, project.id, options.communication, payload.signal)
      return { ...previous, refresh: true as const, inputPolicy: 'identified-only' as const,
        sourcedHistory: imported,
        projectCandidate: prepareProjectCandidateProjection(agent, project.id, {
          ...(communication === undefined ? {} : { communication }),
          ...(options.mainHistory === undefined ? {} : { history: { imported, fit: options.mainHistory } }),
          ...(previous?.projectCandidate === undefined ? {} : { previous: previous.projectCandidate }),
        }),
        currentBlocks: [...(previous?.currentBlocks ?? []), ...currentBlocks],
        historyProjection: combineProjectHistoryProjections(previous?.historyProjection,
          legacyProjectProjection(project.id, session.id), memoryRead.value.historyProjection,
          ...(communication === undefined ? [] : [communication.historyProjection])) }
    }),
  ]
  return () => { for (const dispose of disposers.toReversed()) dispose(); memory.dispose() }
}

/** Fit producer-owned representations against one complete request, including final auxiliary suffixes. */
export function prepareProjectCandidateProjection(agent: Agent, projectId: string, options: {
  readonly communication?: PreparedCommunicationRequest
  readonly history?: { readonly imported: readonly RequestSourcedHistory[]; readonly fit: MainHistoryImportFitter }
  readonly previous?: NonNullable<PreparedRequestContext['projectCandidate']>
}): NonNullable<PreparedRequestContext['projectCandidate']> {
  return async input => {
    const overrides = new Map<import('@deepseek-ai/dsh-llm').MessageId, RequestContentProjection>()
    const apply = (changes: readonly RequestContentProjection[]) => { for (const change of changes) overrides.set(change.messageId, change) }
    const candidate = (): RequestDispatchCandidate => ({ ...input.candidate, messages: input.candidate.messages.map(item => {
      const change = item.message.id === undefined ? undefined : overrides.get(item.message.id)
      return change === undefined ? item : { ...item, message: { ...item.message, content: change.content } }
    }) })
    if (options.previous !== undefined) apply(await options.previous(input))
    const producers: { minimum: NonNullable<PreparedRequestContext['projectCandidate']>; fit: NonNullable<PreparedRequestContext['projectCandidate']>; first?: number }[] = []
    if (options.communication !== undefined) producers.push({ minimum: options.communication.minimum, fit: options.communication.fit })
    if (options.history !== undefined && options.history.imported.length > 0) producers.push({
      minimum: prepareMainHistoryRequestProjection(agent, options.history.imported, options.history.fit, { representation: 'minimum' }),
      fit: prepareMainHistoryRequestProjection(agent, options.history.imported, options.history.fit),
    })
    for (const producer of producers) {
      const changes = await producer.minimum({ ...input, candidate: candidate() })
      if (changes.length === 0) continue
      producer.first = Math.min(...changes.map(change => input.candidate.messages.findIndex(item => item.message.id === change.messageId)))
      apply(changes)
    }
    const active = producers.filter(producer => producer.first !== undefined).sort((a, b) => a.first! - b.first!)
    if (active.length === 0) return jsonFrozen([...overrides.values()])
    const meter = agent.ctx.get('tokenMeter'), window = input.contextWindow
    if (meter === undefined || window === undefined || !Number.isSafeInteger(window) || window <= 0 || !Number.isSafeInteger(input.reservedOutputTokens) || input.reservedOutputTokens < 0) throw communicationError('PROJECT_REQUEST_CAPACITY_UNKNOWN', 'The actual complete Project request capacity cannot be measured')
    const measure = prepareProjectRequestMeter(agent, input.candidate.envelope, { images: input.imageRequestPricing })
    const fits = () => {
      input.signal.throwIfAborted()
      const result = measure(candidate()).inputTokens
      if (result === undefined || !Number.isFinite(result) || result < 0) throw communicationError('PROJECT_REQUEST_CAPACITY_UNKNOWN', 'The actual complete Project request cannot be measured')
      return result <= window - input.reservedOutputTokens
    }
    if (!fits()) throw communicationError('PROJECT_REQUEST_CAPACITY_INSUFFICIENT', 'The actual complete request cannot retain all producer minimum manifests')
    for (const producer of active) apply(await producer.fit({ ...input, candidate: candidate() }))
    if (!fits()) throw communicationError('PROJECT_REQUEST_CAPACITY_INSUFFICIENT', 'The final complete request exceeds its actual input capacity')
    return jsonFrozen([...overrides.values()])
  }
}

function instructionBlock(context: ProjectInstructionContext | SessionInstructionContext, local: boolean): string {
  const body = local ? renderSessionInstructions(context as SessionInstructionContext) : renderProjectInstructions(context)
  if (body.length === 0) return ''
  const scope = local ? { projectId: context.projectId, sessionId: (context as SessionInstructionContext).sessionId } : { projectId: context.projectId }
  const source = context.available && context.value !== undefined ? '以下为用户补充的保存原文，用于本项目要求与具体分工，不覆盖开发者内置职责、边界和工作标准；承载位置不产生新授权'
    : '以下为系统读取状态，来源为当前指令设置读取；不是用户保存原文，也不表示指令已清空'
  return `${local ? '当前单会话用户补充指令' : '当前项目用户补充指令/共享约定'}（适用对象：${JSON.stringify(scope)}；${source}）：\n${body}`
}
function runtimeConditions(agent: Agent, config?: LlmCallConfig): Readonly<Record<string, unknown>> {
  const route = config ?? agent.options
  return {
    model: { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort },
    ...(agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd }),
    configuredToolSchemaNames: agent.ctx.tools.schemas(agent).map(tool => tool.name).sort(),
    resourceLimits: { ...(route.maxTokens === undefined ? {} : { maxOutputTokens: route.maxTokens }), otherLimits: '仅提供实际已知配置；未列出的容量或资源限制未知。' },
    permissions: '所列工具名来自当前会话范围配置；最终tools、DSH策略和逐次工具检查决定实际能力，本次动作仍须有授权。',
  }
}
function failureText(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** 只投影可识别旧供给；混合runtime保留其它DSH段，不改原append日志或自然抄本。 */
function legacyProjectProjection(projectId: string, sessionId: string): RequestHistoryProjection {
  const retired = new Set([`projects:context:${sessionId}`, `projects:overview:${sessionId}`,
    `projects:instructions:${sessionId}`, `projects:project-instructions:${projectId}`])
  return {
    projectCurrentness(history) {
      const overrides: { messageId: import('@deepseek-ai/dsh-llm').MessageId; content: { type: 'text'; text: string }[] }[] = []
      const excludeMessageIds: import('@deepseek-ai/dsh-llm').MessageId[] = []
      const contextSections: { messageId: import('@deepseek-ai/dsh-llm').MessageId; sections: readonly ContextSnapshotSection[] }[] = []
      for (const { message } of history) {
        if (message.role !== 'user' || message.id === undefined || 'currentBlock' in message && message.currentBlock !== undefined) continue
        const source = message.source
        if (source?.kind === 'project-request-context' && source.projectId === projectId && source.sessionId === sessionId) {
          excludeMessageIds.push(message.id); continue
        }
        if (source?.kind !== 'runtime-context' || source.form !== 'snapshot' || !Array.isArray(source.sections)) continue
        const sections = source.sections.filter(section => !retired.has(section.name))
        if (sections.length === source.sections.length) continue
        if (sections.length === 0) excludeMessageIds.push(message.id)
        else {
          overrides.push({ messageId: message.id, content: [{ type: 'text', text: joinContextSections(sections) }] })
          contextSections.push({ messageId: message.id, sections })
        }
      }
      return { overrides, excludeMessageIds, contextSections }
    },
    renderOmissions: () => [],
  }
}
