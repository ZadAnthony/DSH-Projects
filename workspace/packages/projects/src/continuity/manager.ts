import { currentProjectDispatchCapture } from '../stock/request/records.ts'
import { installBotCompaction } from '../stock/request/bot-compaction.ts'
/** One finite evaluation on a real, isolated session-manager Agent. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { onProjectRequestPrepare, onProjectTurnSettled, measureProjectRequestCandidate, type PreparedRequestContext, type RequestContentProjection, type RequestDispatchCandidate } from '../stock/request/harness.ts'
import type { ProjectsRuntimePorts } from '../stock/project-ports.ts'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-token-meter'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'
import type { ProjectsCoreAccess } from '../core-access.ts'
import type { ProjectMembership, SourceRef } from '../records-types.ts'
import { decodeNativeProjectSource, nativeProjectSourceKey } from '../native-source.ts'
import type { MainHistoryCapacity, MainHistoryWindow } from './history-types.ts'
import { assertManagerJsonBudget, fitManagerInput, managerInputSources, MANAGER_INPUT_POINTS, type MainManagerInput } from './manager-input.ts'
import type { EvaluationEnvelope, SessionManagerDecision } from './types.ts'
import { MAIN_SESSION_MANAGER_PROMPT } from './prompt.ts'
import { isMainBusinessInput } from './business-input.ts'
import { visibleSourceItemText } from '../model-visible-content.ts'
import { deliveredManagerSources, managerReadDelivery, ManagerHistoryResultPages, parseSessionManagerDecision, SessionManagerEvaluationError } from './manager-parser.ts'
import { installMainManagerTools, MAIN_SESSION_MANAGER_TOOLS, type MainManagerContextPorts, type MainManagerHistoryReader, type MainManagerObservations } from './manager-tools.ts'
export { SessionManagerEvaluationError } from './manager-parser.ts'
export type { MainManagerContextPorts, MainManagerHistoryReader, MainManagerObservations } from './manager-tools.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'project-session-evaluation': { readonly kind: 'project-session-evaluation'; readonly projectId: string; readonly attemptId: string }
  }
}

interface ObservedTurnStart { readonly seq: number; readonly turn: number }
interface ObservedInput {
  readonly seq: number
  readonly start?: ObservedTurnStart
  readonly sources: readonly SourceRef[]
}
interface ObservedEnd { readonly seq: number; readonly reason: SessionEvent<'turn/end'>['data']['reason'] }
interface ObservedAssistant { readonly seq: number; readonly content: readonly ContentBlock[] }
interface PendingToolCall { readonly seq: number; readonly turn: number; readonly name: string }
interface ObservedSettlement { readonly turn: number; readonly startSeq: number; readonly endSeq: number }
interface ActiveEvaluation {
  readonly envelope: EvaluationEnvelope
  readonly window: MainManagerInput
  readonly startSeq: number
  readonly sources: Map<string, SourceRef>
  readonly calls: Set<symbol>
  readonly readBodies: Set<string>
  readonly readDeliveries: Set<string>
  readonly historyPages: ManagerHistoryResultPages
  readonly callSeqs: Set<number>
  readonly pendingCalls: Map<string, PendingToolCall>
  readonly historySeqs: SessionSeq[]
  readonly inputReplacements: Set<SessionSeq>
  inputCount: number
  readPoints: number
  openTurn?: ObservedTurnStart
  input?: ObservedInput
  end?: ObservedEnd
  settled?: ObservedSettlement
  nativeError?: { readonly turn: number; readonly error: unknown }
  finalAssistant?: ObservedAssistant
  messageId?: string
  observations?: MainManagerObservations
  cancelled: boolean
  rejectCancellation(error: SessionManagerEvaluationError): void
}
interface ManagerSlot { readonly agent: Agent; readonly membership: ProjectMembership; active?: ActiveEvaluation; disposed: boolean }

/** Business/evaluation admissions share an Inbox with native Harness notices. */
function isManagerInput(kind: string): boolean { return kind === 'project-session-evaluation' || isMainBusinessInput(kind) }

/** Installs only the dedicated manager Harness; runtime retains Agent creation, route and switching. */
export class MainSessionManager {
  private readonly slots = new Map<string, ManagerSlot>()

  constructor(private readonly ctx: Context, private readonly core: ProjectsCoreAccess,
    private readonly history: (projectId: string, mainSessionId: string) => MainManagerHistoryReader,
    private readonly context: MainManagerContextPorts,
    _fitHistory: (window: MainHistoryWindow, capacity: MainHistoryCapacity, signal?: AbortSignal) => Promise<MainHistoryWindow>,
    private readonly ports: ProjectsRuntimePorts) {}

  /** Install before work or Memory scopes and return immediately from the runtime's role branch.
   * @param agent - The exact project-owned hidden manager Agent.
   * @param membership - Its persisted session-manager membership.
   * @returns Disposer; disposal cancels unpublished work and removes all registrations.
   */
  install(agent: Agent, membership: ProjectMembership): () => void {
    if (membership.session.role !== 'session-manager' || membership.session.projectId !== membership.project.id
      || membership.session.hostSessionId !== String(agent.id)) throw new SessionManagerEvaluationError('unavailable', '会话管理Bot实际归属不一致。')
    if (this.slots.has(String(agent.id))) throw new SessionManagerEvaluationError('unavailable', '会话管理Bot不可重复安装。')
    const slot: ManagerSlot = { agent, membership, disposed: false }, disposers: Array<() => unknown> = []
    this.slots.set(String(agent.id), slot)
    const dispose = () => {
      if (slot.disposed) return
      slot.disposed = true
      if (slot.active !== undefined) this.cancel(slot, slot.active, '会话管理Bot已卸载。')
      if (this.slots.get(String(agent.id)) === slot) this.slots.delete(String(agent.id))
    }
    try {
      disposers.push(agent.ctx.effect(() => dispose))
      disposers.push(agent.ctx.tools.guard(exec => {
        if (!MAIN_SESSION_MANAGER_TOOLS.has(exec.name)) return '会话管理Bot只允许读取本主会话历史及必要公共背景。'
        const active = slot.active
        if (active === undefined || active.cancelled || slot.disposed || exec.agent !== agent || exec.parent !== undefined
          || agent.status !== 'running' || this.ctx.agents.get(agent.id) !== agent || this.ctx.agents.currentInitiator() !== agent) return '此工具不属于当前真实会话管理评估。'
        const input = active.input, call = active.pendingCalls.get(String(exec.callId))
        if (input?.start === undefined || call === undefined || call.name !== exec.name || call.seq <= input.seq || call.turn !== input.start.turn
          || this.ports.invocations.get(exec)?.startEventSeq !== call.seq) return '工具调用不属于本次评估原生输入。'
        active.pendingCalls.delete(String(exec.callId))
        if (active.callSeqs.has(call.seq)) return '本次评估工具调用原始位置重复。'
        active.callSeqs.add(call.seq); active.calls.add(exec.token)
        return undefined
      }))
      disposers.push(agent.ctx.tools.presentAs('native'))
      disposers.push(agent.ctx.systemPrompt.section({ name: `projects:session-manager:${membership.session.id}`,
        order: agent.ctx.systemPrompt.getSectionOrder('TEAM_POLICY'), text: MAIN_SESSION_MANAGER_PROMPT, complete: true, interpolate: false }))
      disposers.push(agent.ctx.systemPrompt.suppressRuntimeContext())
      disposers.push(agent.ctx.on('system-prompt/assemble', async (_assembly, input, next) => {
        const assembly = await next()
        return input.agent !== agent ? assembly : { ...assembly, contexts: [], tools: assembly.tools.filter(tool => MAIN_SESSION_MANAGER_TOOLS.has(tool.name)).map(tool =>
          tool.name === 'project_history' ? { ...tool, description: '本会话管理评估仅可读取绑定的稳定主会话及其合法历史carrier，不能读取执行会话、其它项目或Bot日志；公共背景中的引用不扩权。' + tool.description } : tool) }
      }))
      disposers.push(onProjectRequestPrepare(agent, async (payload, _previous) => {
        const active = this.active(slot)
        payload.signal?.throwIfAborted()
        return { role: 'manager' as const, refresh: true as const, inputPolicy: 'identified-only' as const,
          currentBlocks: [], sourcedHistory: [],
          ...(payload.purpose !== 'compaction' && this.replacedInput(active, agent.session) ? { currentRequirements: this.checkpoint(active) } : {}),
          projectCandidate: this.projectCandidate(slot, active, payload.purpose === 'compaction'),
          historySeqs: active.historySeqs.filter(seq => agent.session.surface.nodes.includes(seq) && agent.session.eventAt(seq)?.type !== 'system/message') }
      }))
      installBotCompaction(agent.ctx, agent, { name: 'Manager', checkpoint: () => this.checkpoint(this.active(slot), 'compaction') })
      disposers.push(agent.ctx.on('session/event', (session, event) => {
        const active = slot.active
        if (session !== agent.session || active === undefined || active.cancelled || event.seq < active.startSeq) return
        this.observe(active, event, session)
      }))
      disposers.push(onProjectTurnSettled(agent, fact => {
        const active = slot.active
        if (fact.agent !== agent || fact.signal.aborted || active === undefined || active.cancelled) return
        const admitted = fact.consumedInputs.filter(input => isManagerInput(input.source.kind))
        const input = active.input, end = active.end, consumed = admitted[0]
        if (input?.start === undefined || end === undefined || fact.turn !== input.start.turn || fact.startSeq !== input.start.seq
          || fact.endSeq !== end.seq || fact.reason.kind !== 'completed' || end.reason.kind !== 'completed' || admitted.length !== 1
          || consumed === undefined || String(consumed.messageId) !== active.messageId || consumed.eventSeq !== input.seq
          || consumed.source.kind !== 'project-session-evaluation' || consumed.source.projectId !== active.envelope.projectId
          || consumed.source.attemptId !== active.envelope.attemptId) return
        active.settled = { turn: fact.turn, startSeq: fact.startSeq, endSeq: fact.endSeq }
      }))
      disposers.push(agent.ctx.on('agent/error', fact => {
        const active = slot.active
        if (fact.agent !== agent || active === undefined || active.cancelled) return
        const turn = active.input?.start?.turn ?? active.openTurn?.turn
        if (fact.turn === turn) active.nativeError ??= { turn: fact.turn, error: fact.error }
      }))
      disposers.push(installMainManagerTools(agent, exec => this.authorize(slot, exec), this.context))
      disposers.push(agent.ctx.on('tools/result', (exec, result) => {
        const active = slot.active
        if (active === undefined) return
        const accepted = active.calls.delete(exec.token)
        const pending = active.pendingCalls.get(String(exec.callId))
        if (pending !== undefined && this.ports.invocations.get(exec)?.startEventSeq === pending.seq) active.pendingCalls.delete(String(exec.callId))
        if (active.cancelled || !accepted || result.isError) return
        for (const delivery of managerReadDelivery(result.content)) if (!active.readDeliveries.has(delivery.key)) {
          active.readDeliveries.add(delivery.key); active.readPoints += delivery.points
        }
        if (exec.name !== 'project_history' || active.readPoints > MANAGER_INPUT_POINTS) return
        const content = [...result.content, ...active.historyPages.collect(result.content)]
        this.addSources(active, deliveredManagerSources(content))
        this.rememberReads(active, content)
      }))
    } catch (error) { for (const release of disposers.toReversed()) release(); dispose(); throw error }
    return () => { dispose(); for (const release of disposers.toReversed()) release() }
  }

  /** Run once; cancellation returns promptly while the real Agent independently finishes its log/usage.
   * @param input - Program-bound envelope, finite source window, actual hidden Agent and outer deadline signal.
   * @returns Only a strict completed-and-durable final decision. No retry, creation or switch is performed.
   */
  async evaluate(input: { readonly envelope: EvaluationEnvelope; readonly window: MainManagerInput; readonly agent: Agent; readonly signal: AbortSignal;
    /** The original run, including actual slot release; prompt cancellation does not settle this receipt. */
    readonly onSettlement?: (settlement: Promise<SessionManagerDecision>) => void }): Promise<SessionManagerDecision> {
    const { envelope, window, agent, signal } = input, slot = this.slots.get(String(agent.id))
    if (signal.aborted) throw new SessionManagerEvaluationError('cancelled', '本次会话管理评估已取消。')
    if (slot?.agent !== agent || slot.disposed || slot.membership.project.id !== envelope.projectId || !agent.options.provider || !agent.options.model
      || this.ctx.agents.get(agent.id) !== agent) throw new SessionManagerEvaluationError('unavailable', '实际会话管理Bot或明确模型route不可用。')
    if (slot.active !== undefined || agent.status !== 'idle') throw new SessionManagerEvaluationError('busy', '会话管理Bot上次活动尚未停稳。')
    let rejectCancellation!: (error: SessionManagerEvaluationError) => void
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCancellation = reject })
    const active: ActiveEvaluation = { envelope, window, startSeq: Number(agent.session.seq), sources: new Map(), calls: new Set(), readBodies: new Set(),
      readDeliveries: new Set(), historyPages: new ManagerHistoryResultPages(MANAGER_INPUT_POINTS), callSeqs: new Set(),
      pendingCalls: new Map(), historySeqs: [], inputReplacements: new Set(), inputCount: 0, readPoints: 0, cancelled: false, rejectCancellation }
    slot.active = active
    const abort = () => this.cancel(slot, active, '本次会话管理评估已取消。')
    signal.addEventListener('abort', abort, { once: true })
    const settlement = this.run(slot, active, signal).finally(() => { if (slot.active === active) delete slot.active })
    input.onSettlement?.(settlement)
    if (signal.aborted) abort()
    try { return await Promise.race([settlement, cancelled]) }
    catch (error) {
      if (error instanceof SessionManagerEvaluationError) throw error
      throw new SessionManagerEvaluationError(signal.aborted ? 'cancelled' : 'failed', error instanceof Error ? error.message : String(error), { cause: error })
    } finally { signal.removeEventListener('abort', abort) }
  }

  private async run(slot: ManagerSlot, active: ActiveEvaluation, signal: AbortSignal): Promise<SessionManagerDecision> {
    const { agent } = slot, { envelope, window } = active
    const observations = await this.context.observations(envelope, signal)
    signal.throwIfAborted(); this.active(slot)
    active.observations = observations
    const content = this.renderInput(active, window)
    assertManagerJsonBudget(content, MANAGER_INPUT_POINTS)
    const message = createUserMessage({ source: { kind: 'project-session-evaluation', projectId: envelope.projectId, attemptId: envelope.attemptId },
      content })
    active.messageId = String(message.id)
    agent.send(message, 'next-turn', true)
    if (signal.aborted || active.cancelled) this.cancel(slot, active, '本次会话管理评估已取消。')
    await agent.whenIdle()
    signal.throwIfAborted(); this.active(slot)
    if (!await this.ctx.sessions.flush(agent.session)) throw new SessionManagerEvaluationError('failed', '会话管理Bot原生日志flush未确认。')
    signal.throwIfAborted(); this.active(slot)
    const { input, end, settled, nativeError, finalAssistant: final } = active
    this.assertReadBudget(active)
    if (nativeError !== undefined) throw new SessionManagerEvaluationError('failed',
      `会话管理Bot原生轮结算失败：${nativeError.error instanceof Error ? nativeError.error.message : String(nativeError.error)}`, { cause: nativeError.error })
    if (active.inputCount !== 1 || input?.start === undefined || end === undefined || end.seq <= input.seq
      || end.reason.kind !== 'completed') throw new SessionManagerEvaluationError('failed', `本次评估没有唯一实际输入及正常完成的原生turn（inputs=${active.inputCount}, input=${input?.seq ?? 'missing'}, start=${input?.start?.seq ?? 'missing'}, end=${end?.seq ?? 'missing'}, reason=${end?.reason.kind ?? 'missing'}）。`)
    if (settled === undefined || settled.turn !== input.start.turn || settled.startSeq !== input.start.seq || settled.endSeq !== end.seq) {
      throw new SessionManagerEvaluationError('failed', '本次会话管理评估未取得准确原生轮的持久结算通知。')
    }
    if (final === undefined || final.seq <= input.seq || final.seq >= end.seq || final.content.length === 0
      || final.content.some(block => block.type !== 'text' && block.type !== 'reasoning')) throw new SessionManagerEvaluationError('invalid-output', '本次评估缺少最终assistant单一JSON。')
    return parseSessionManagerDecision(final.content.map(block => block.type === 'text' ? block.text : '').join(''), [...active.sources.values()])
  }

  private observe(active: ActiveEvaluation, event: SessionEvent, session?: import('@deepseek-ai/dsh-session').Session): void {
    switch (event.type) {
      case 'turn/start':
        active.openTurn = { seq: event.seq, turn: event.data.turn }
        break
      case 'user/message':
        // A native checkpoint is context, never another evaluation admission or
        // an original-source receipt. Only its correlated replacement may carry
        // this evaluation's identity after the original admission is shadowed.
        if (event.data.source.kind === 'compact-checkpoint') {
          if (session === undefined || !this.observeReplacement(active, event, session)) break
        }
        active.historySeqs.push(event.seq)
        if (!isManagerInput(event.data.source.kind)) break
        active.inputCount += 1
        if (String(event.data.id) === active.messageId && active.input === undefined
          && event.data.source.kind === 'project-session-evaluation' && event.data.source.projectId === active.envelope.projectId
          && event.data.source.attemptId === active.envelope.attemptId) active.input = {
          seq: event.seq, start: active.openTurn, sources: this.inputSources(event.data.content),
        }
        break
      case 'assistant/message':
        active.historySeqs.push(event.seq)
        if (active.input !== undefined && event.seq > active.input.seq && event.data.turn === active.input.start?.turn && active.end === undefined) {
          active.finalAssistant = { seq: event.seq, content: event.data.message.content }
        }
        break
      case 'tool/result':
      case 'system/message':
      case 'developer/message':
        active.historySeqs.push(event.seq)
        break
      case 'tool/call':
        active.pendingCalls.set(String(event.data.callId), { seq: event.seq, turn: event.data.turn, name: event.data.name })
        break
      case 'turn/end':
        if (active.input !== undefined && event.data.turn === active.input.start?.turn && event.seq > active.input.seq && active.end === undefined) {
          active.end = { seq: event.seq, reason: event.data.reason }
        }
        if (active.openTurn?.turn === event.data.turn) delete active.openTurn
        break
      case 'projects/request-dispatch':
      case 'projects/request-dispatch-v2': {
        if (active.input === undefined) break
        const payload = event.type === 'projects/request-dispatch' ? event.data : session === undefined ? undefined : currentProjectDispatchCapture(session, event)
        if (payload === undefined) throw new Error('PROJECT_MANAGER_DISPATCH_CAPTURE_UNAVAILABLE')
        // Deduplication can refer only to original text in THIS actual request.
        // The separate delivery ledger remains cumulative across replacements.
        active.readBodies.clear()
        for (const message of payload.request.messages) {
          if (message.role === 'user' && String(message.id) === active.messageId
            && message.source?.kind === 'project-session-evaluation' && message.source.attemptId === active.envelope.attemptId) {
            this.addSources(active, this.inputSources(message.content))
            this.rememberReads(active, message.content)
          }
          if (message.role === 'tool' && !message.isError) this.rememberReads(active, message.content)
        }
        break
      }
      default:
        // Other merge-extensible technical events have no evaluation facts.
        break
    }
  }

  private inputSources(content: readonly ContentBlock[]): SourceRef[] {
    try {
      const value: unknown = JSON.parse(content.filter(block => block.type === 'text').map(block => block.text).join(''))
      return typeof value === 'object' && value !== null && 'sources' in value && Array.isArray(value.sources)
        ? value.sources.map(decodeNativeProjectSource) : []
    } catch (error) {
      this.ctx.logger.warn(`会话管理Bot实际输入来源不可解析：${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  private projectCandidate(slot: ManagerSlot, active: ActiveEvaluation, compaction: boolean): NonNullable<PreparedRequestContext['projectCandidate']> {
    return async input => {
      if (this.active(slot) !== active) throw new SessionManagerEvaluationError('cancelled', '本次会话管理评估已失效。')
      this.assertReadBudget(active)
      const capacity = input.contextWindow
      if (capacity === undefined || !Number.isSafeInteger(capacity) || capacity <= 0 || !Number.isSafeInteger(input.reservedOutputTokens)
        || input.reservedOutputTokens < 0) throw new SessionManagerEvaluationError('failed', '实际会话管理请求的容量或计量能力不可用。')
      const message = input.candidate.messages.find(item => item.message.role === 'user' && String(item.message.id) === active.messageId)?.message
      // Native summarization may select a prefix without the admission; after
      // replacement, the conversation uses its exact program-held contract.
      if (message?.id === undefined) {
        if (!compaction && !this.replacedInput(active, slot.agent.session)) throw new SessionManagerEvaluationError('failed', '实际会话管理请求缺少本次评估输入。')
        const overrides = backgroundReadProjections(active, input.candidate, slot.agent.session)
        const measured = measureProjectRequestCandidate(slot.agent, projectCandidate(input.candidate, overrides), { images: input.imageRequestPricing })
        if (measured.inputTokens === undefined || !Number.isFinite(measured.inputTokens) || measured.inputTokens < 0
          || measured.inputTokens > capacity - input.reservedOutputTokens) throw new SessionManagerEvaluationError('failed', '实际会话管理最小合法请求仍超出容量；保持旧入口。')
        return overrides
      }
      const messageId = message.id
      // Check the entire cumulative candidate before token metering/serialization.
      assertManagerJsonBudget(input.candidate.messages, MANAGER_INPUT_POINTS * 3)
      const background = backgroundReadProjections(active, input.candidate, slot.agent.session)
      const fits = (window: MainManagerInput) => {
        input.signal.throwIfAborted()
        const overrides = [...background, { messageId, content: this.renderInput(active, window) }]
        const measurement = measureProjectRequestCandidate(slot.agent, projectCandidate(input.candidate, overrides), { images: input.imageRequestPricing })
        if (measurement.inputTokens === undefined || !Number.isFinite(measurement.inputTokens) || measurement.inputTokens < 0) throw new SessionManagerEvaluationError('failed', '实际会话管理完整请求不可计量。')
        return measurement.inputTokens <= capacity - input.reservedOutputTokens
      }
      let fitted = active.window
      if (!fits(fitted)) {
        fitted = fitManagerInput(active.window, 0)
        if (!fits(fitted)) throw new SessionManagerEvaluationError('failed', '实际会话管理最小合法请求仍超出容量；保持旧入口。')
        let low = 0, high = MANAGER_INPUT_POINTS
        while (low < high) { const middle = Math.ceil((low + high) / 2), candidate = fitManagerInput(active.window, middle); if (fits(candidate)) { low = middle; fitted = candidate } else high = middle - 1 }
      }
      input.signal.throwIfAborted()
      if (this.active(slot) !== active) throw new SessionManagerEvaluationError('cancelled', '本次会话管理评估已失效。')
      return [...background, { messageId, content: this.renderInput(active, fitted) }]
    }
  }

  private replacedInput(active: ActiveEvaluation, session: Session): boolean {
    return active.input !== undefined && !session.surface.nodes.includes(active.input.seq as SessionSeq)
      && session.surface.nodes.some(seq => active.inputReplacements.has(seq))
  }

  private observeReplacement(active: ActiveEvaluation, event: SessionEvent<'user/message'>, session: Session): boolean {
    if (event.data.source.kind !== 'compact-checkpoint' || typeof event.surfaceOp !== 'object' || event.surfaceOp.op !== 'replace' || active.input?.start === undefined) return false
    const compactionId = event.data.source.compactionId
    const related = event.sourceEventSeqs?.map(seq => session.eventAt(seq)) ?? []
    const summary = related.find(item => item?.type === 'compaction/summary' && item.data.compactionId === compactionId)
    const start = related.find(item => item?.type === 'compaction/start' && item.data.compactionId === compactionId)
    if (summary?.type !== 'compaction/summary' || start?.type !== 'compaction/start' || start.seq < active.startSeq
      || start.data.turn !== active.input.start.turn || summary.data.shadowedRange.start !== event.surfaceOp.startSeq
      || summary.data.shadowedRange.end !== event.surfaceOp.endSeq) return false
    if (summary.data.shadowedSeqs.some(seq => seq === active.input!.seq || active.inputReplacements.has(seq))) active.inputReplacements.add(event.seq)
    return true
  }

  private checkpoint(active: ActiveEvaluation, purpose: 'evaluation' | 'compaction' = 'evaluation'): string {
    return 'Continue only this finite Manager evaluation. Preserve its exact identity, allowed read routes and original source locators. A compacted summary is context, not a new original source, read receipt, admission or permission. Reread a locator when its original text is no longer present; the cumulative read budget is not reset. '
      + (purpose === 'compaction' ? 'Preserve these facts for the same evaluation after compaction; do not decide keep/switch in this auxiliary request.\n' : 'Return only the required final decision JSON.\n')
      + JSON.stringify({ evaluation: active.envelope, admissionMessageId: active.messageId,
        background: { history: { tool: 'project_history', session_ids: [active.envelope.mainSessionId] },
          board: 'project_overview_read', memoryIndex: 'project_memory_list', memoryBody: 'project_memory_read' } })
  }

  private renderInput(active: ActiveEvaluation, window: MainManagerInput) {
    const { envelope, observations } = active
    const value = { evaluation: envelope, history: window, observations, sources: managerInputSources(window),
      background: { history: { tool: 'project_history', session_ids: [envelope.mainSessionId] }, board: 'project_overview_read', memoryIndex: 'project_memory_list', memoryBody: 'project_memory_read' } }
    assertManagerJsonBudget(value, MANAGER_INPUT_POINTS)
    return [{ type: 'text' as const, text: JSON.stringify(value) }]
  }

  private active(slot: ManagerSlot): ActiveEvaluation {
    if (slot.disposed || slot.active === undefined || slot.active.cancelled) throw new SessionManagerEvaluationError('cancelled', '本次会话管理评估已失效。')
    return slot.active
  }

  private async authorize(slot: ManagerSlot, exec: ToolRunContext) {
    const active = this.active(slot)
    if (!MAIN_SESSION_MANAGER_TOOLS.has(exec.name) || exec.agent !== slot.agent || !active.calls.has(exec.token) || exec.parent !== undefined) throw new Error('工具不属于当前会话管理评估。')
    const scope = await this.core.forTool(exec, exec.name)
    exec.signal.throwIfAborted()
    if (this.active(slot) !== active || scope.role !== 'session-manager' || scope.project.id !== active.envelope.projectId
      || scope.hostSessionId !== String(slot.agent.id) || scope.session.id !== slot.membership.session.id) throw new Error('会话管理Bot读取归属已失效。')
    return { projectId: scope.project.id, hostSessionId: scope.hostSessionId, history: this.history(scope.project.id, active.envelope.mainSessionId),
      retain: (value: unknown) => {
        const bounded = this.deduplicateRead(active, value)
        assertManagerJsonBudget(bounded, 24_576)
        const additions = managerReadDelivery([{ type: 'text', text: JSON.stringify(bounded) }])
          .filter(delivery => !active.readDeliveries.has(delivery.key)).reduce((sum, delivery) => sum + delivery.points, 0)
        if (active.readPoints + additions > MANAGER_INPUT_POINTS) throw new Error('本次会话管理补读累计已达有限预算。')
        return bounded
      } }
  }

  private assertReadBudget(active: ActiveEvaluation): void {
    if (active.readPoints > MANAGER_INPUT_POINTS) throw new SessionManagerEvaluationError('failed', '本次会话管理补读累计已达有限预算。')
  }

  private deduplicateRead(active: ActiveEvaluation, value: unknown): unknown {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
    const raw = value as Record<string, unknown>
    if (Array.isArray(raw.items)) return { ...raw, items: raw.items.map(item => {
      if (typeof item !== 'object' || item === null || !active.readBodies.has(readKey(item as Record<string, unknown>))) return item
      const { text: _text, visibleBlocks: _blocks, ...entry } = item as Record<string, unknown>
      return { ...entry, text: '', already_delivered: true, limitation: 'This exact source excerpt was already delivered in this evaluation; use its existing content.' }
    }) }
    if (raw.format === 'projects-native-content/v1') {
      const source = rangedBodySource(raw)
      if (source === undefined) return value
      if (active.readBodies.has(bodyKey(source, raw.text))) return { status: 'already-delivered', source: raw.source, range: raw.range,
        ...(raw.selected_range === undefined ? {} : { selected_range: raw.selected_range }),
        ...(raw.same_page_cursor === undefined ? {} : { same_page_cursor: raw.same_page_cursor }),
        ...(raw.next_cursor === undefined ? {} : { next_cursor: raw.next_cursor }),
        complete: false, guidance: 'This exact native body range was already delivered in this evaluation; no new body receipt. Preserve the original source/cursor to continue.' }
      return { ...raw, delivered_source: source }
    }
    return value
  }

  private rememberReads(active: ActiveEvaluation, content: readonly ContentBlock[]): void {
    for (const block of content) {
      if (block.type !== 'text') continue
      let raw: Record<string, unknown>
      try { raw = JSON.parse(block.text) as Record<string, unknown> } catch { continue }
      if (raw === null || typeof raw !== 'object') continue
      if (Array.isArray(raw.items)) for (const item of raw.items) if (item !== null && typeof item === 'object' && (visibleSourceItemText(item)?.length ?? 0) > 0) active.readBodies.add(readKey(item))
      if (raw.format === 'projects-native-content/v1' && typeof raw.text === 'string' && raw.text.length > 0) {
        const source = rangedBodySource(raw); if (source !== undefined) active.readBodies.add(bodyKey(source, raw.text))
      }
      const history = raw.history as MainManagerInput | undefined
      if (Array.isArray(history?.currentInputs) && Array.isArray(history.replies)) for (const message of [...history.currentInputs, ...history.replies.flatMap(turn => turn.reply === undefined ? [] : [turn.reply])]) {
        for (const excerpt of message.content) active.readBodies.add(bodyKey(excerpt.source, excerpt.text))
      }
    }
  }

  private addSources(active: ActiveEvaluation, sources: readonly SourceRef[]): void {
    for (const source of sources) {
      if (source.kind === 'native-event' && (source.projectId !== active.envelope.projectId || source.sessionId !== active.envelope.mainSessionId)) continue
      active.sources.set(nativeProjectSourceKey(source), source)
    }
  }

  private cancel(slot: ManagerSlot, active: ActiveEvaluation, message: string): void {
    if (active.cancelled) return
    active.cancelled = true
    active.rejectCancellation(new SessionManagerEvaluationError('cancelled', message))
    try { slot.agent.cancel({ kind: 'user' }, { keepInbox: false }) }
    catch (error) { this.ctx.logger.warn(`会话管理Bot取消未完成：${error instanceof Error ? error.message : String(error)}`) }
  }
}

function projectCandidate(candidate: RequestDispatchCandidate, overrides: readonly RequestContentProjection[]): RequestDispatchCandidate {
  const content = new Map(overrides.map(override => [override.messageId, override.content]))
  return { ...candidate, messages: candidate.messages.map(item => {
    const replacement = item.message.id === undefined ? undefined : content.get(item.message.id)
    return replacement === undefined ? item : { ...item, message: { ...item.message, content: replacement } }
  }) }
}

/** Keepers exist in this exact candidate; no receipt survives as a body substitute. */
function backgroundReadProjections(active: ActiveEvaluation, candidate: RequestDispatchCandidate, session: Session): RequestContentProjection[] {
  const selected = new Set(active.historySeqs)
  const keepers = new Map<string, { messageId: string; toolCallId: string }>(), overrides: RequestContentProjection[] = []
  for (const { message, origin } of candidate.messages) {
    if (origin.kind !== 'event' || !selected.has(origin.seq) || message.role !== 'tool') continue
    const result = session.eventAt(origin.seq)
    if (result?.type !== 'tool/result' || result.data.message.id !== message.id || result.sourceEventSeqs?.length !== 1) continue
    const callSeq = result.sourceEventSeqs[0]!, call = session.eventAt(callSeq)
    if (!active.callSeqs.has(callSeq) || call?.type !== 'tool/call' || call.data.callId !== message.toolCallId) continue
    const id = String(message.toolCallId), name = call.data.name
    if ((name !== 'project_memory_read' && name !== 'project_overview_read') || message.isError || message.id === undefined
      || message.content.length !== 1 || message.content[0]?.type !== 'text'
      || managerReadDelivery(message.content).some(delivery => !active.readDeliveries.has(delivery.key))) continue
    const source = record(message.source)
    if (source?.kind !== 'tool' || source.callId !== id) continue
    let value: Record<string, unknown> | undefined
    try { value = record(JSON.parse(message.content[0].text)) } catch { continue }
    if (value === undefined) continue
    const key = backgroundBodyKey(name, value, active.envelope.projectId)
    if (key === undefined) continue
    const keeper = keepers.get(key)
    if (keeper === undefined) { keepers.set(key, { messageId: String(message.id), toolCallId: id }); continue }
    // A repeated native message identity is not another body occurrence we can safely override.
    if (keeper.messageId === String(message.id)) continue
    const reference = { ...keeper, notice: 'Exact same body is retained in the earlier tool result in THIS request. This reference preserves a separate successful owner read; it is not a new body receipt.' }
    let projected: Record<string, unknown>
    if (name === 'project_memory_read') {
      const { body: _body, ...metadata } = value
      projected = { ...metadata, body_reference: { ...reference, field: 'body' } }
    } else {
      const document = record(value.document)!, blocks = document.blocks as Record<string, unknown>[]
      projected = { ...value, document: { ...document, blocks: blocks.map((block, index) => {
        const { content: _content, ...metadata } = block
        return { ...metadata, content_reference: { ...reference, field: `document.blocks[${index}].content`, content_type: record(block.content)!.type } }
      }) } }
    }
    const text = JSON.stringify(projected)
    if (text.length >= message.content[0].text.length || Buffer.byteLength(text) >= Buffer.byteLength(message.content[0].text)
      || estimateContent([{ type: 'text', text }]) > estimateContent(message.content)) continue
    overrides.push({ messageId: message.id, content: [{ type: 'text', text }] })
  }
  return overrides
}

/** Unknown, partial, paged, failed or differently versioned results remain complete. */
function backgroundBodyKey(name: string, value: Record<string, unknown>, projectId: string): string | undefined {
  if (value.projectId !== projectId) return
  if (name === 'project_memory_read') {
    const fields = ['title', 'summary', 'body', 'type', 'nature', 'scope', 'sources', 'id', 'projectId', 'path', 'revision', 'generation',
      'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'originSources', 'reconfirmedBy', 'guidance', 'limitation']
    if (Object.keys(value).some(key => !fields.includes(key)) || typeof value.body !== 'string' || value.body.length === 0
      || !['id', 'path', 'title', 'summary', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'].every(key => typeof value[key] === 'string')
      || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || value.generation !== undefined && typeof value.generation !== 'string'
      || !['rule', 'preference', 'background', 'fact', 'experience'].includes(String(value.type)) || !['confirmed', 'verified', 'unverified'].includes(String(value.nature))
      || !['project', 'session', 'file', 'topic'].includes(String(record(value.scope)?.kind)) || !Array.isArray(value.sources) || !Array.isArray(value.originSources)) return
    return name + ':' + JSON.stringify(value)
  }
  if (Object.keys(value).some(key => !['projectId', 'status', 'document', 'readAt'].includes(key)) || value.status !== 'available' || typeof value.readAt !== 'string') return
  const document = record(value.document)
  if (document?.projectId !== projectId || document.schemaVersion !== 2 || !Array.isArray(document.blocks) || document.blocks.length === 0
    || Object.keys(document).some(key => !['schemaVersion', 'projectId', 'blocks', 'updatedAt', 'updatedBySessionId'].includes(key))) return
  for (const raw of document.blocks) {
    const block = record(raw), content = record(block?.content)
    if (block === undefined || content === undefined || Object.keys(block).some(key => !['id', 'title', 'content', 'sources', 'updatedAt', 'updatedBySessionId'].includes(key))
      || !['id', 'title', 'updatedAt', 'updatedBySessionId'].every(key => typeof block[key] === 'string') || !Array.isArray(block.sources)) return
    if (content.type === 'text' && (Object.keys(content).length !== 2 || typeof content.text !== 'string')
      || content.type === 'list' && (Object.keys(content).length !== 2 || !Array.isArray(content.items) || !content.items.every(item => typeof item === 'string'))
      || content.type === 'table' && (Object.keys(content).length !== 3 || !Array.isArray(content.columns) || !content.columns.every(item => typeof item === 'string')
        || !Array.isArray(content.rows) || !content.rows.every(row => Array.isArray(row) && row.length === (content.columns as unknown[]).length && row.every(item => typeof item === 'string')))
      || !['text', 'list', 'table'].includes(String(content.type))) return
  }
  return name + ':' + JSON.stringify({ projectId, status: value.status, document })
}
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined }

function readKey(item: Record<string, unknown>): string {
  return JSON.stringify({ source: item.nativeSource, text: visibleSourceItemText(item), visibleBlocks: item.visibleBlocks, excerpt: item.excerpt, bodyRange: item.bodyRange })
}
function bodyKey(source: SourceRef, text: unknown): string { return nativeProjectSourceKey(source) + ':' + String(text) }
function rangedBodySource(page: Record<string, unknown>): SourceRef | undefined {
  try {
    const source = decodeNativeProjectSource(page.source), range = page.range as {start?: number; end?: number} | undefined
    if (source.kind !== 'native-event' || source.body === undefined || typeof range?.start !== 'number' || typeof range.end !== 'number') return
    return { ...source, body: { ...source.body, range: { unit: 'unicode-code-points', start: range.start, end: range.end } } }
  } catch { return }
}
