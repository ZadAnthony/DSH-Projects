/** Explicit Session-addressed adapter for the stock Agent-scoped waterfalls. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import type { ProjectUiInteractionFrame, ProjectUiInteractionResponse, ProjectUiPendingInteraction } from './types.ts'

interface Pending {
  readonly item: ProjectUiPendingInteraction
  readonly agent: Agent
  readonly resolve: (value: ApprovalOutcome | AskUserQuestionAnswer) => void
  readonly reject: (error: unknown) => void
  readonly unlisten: () => void
}
interface Listener { readonly sessionId: SessionId; readonly readonly: boolean; push(frame: ProjectUiInteractionFrame): void }

export class PrivateSessionInteractions {
  private readonly pending = new Map<string, Pending>()
  private readonly listeners = new Set<Listener>()
  private readonly disposers: (() => void)[]
  constructor(private readonly ctx: Context, private readonly assertWrite: (id: SessionId) => Promise<void>) {
    this.disposers = [
      ctx.on('approval/request', async (request, next) => {
        const agent = request.agent as Agent
        if (!this.canAnswer(agent)) return next()
        await this.assertWrite(agent.id)
        if (!this.canAnswer(agent)) return next()
        return this.wait(agent, { kind: 'approval', sessionId: agent.id, requestId: randomUUID(),
          toolName: request.toolName, ...(request.callId === undefined ? {} : { callId: request.callId }),
          ...(request.reason === undefined ? {} : { reason: request.reason }),
          ...(request.displayReason === undefined ? {} : { displayReason: request.displayReason }) }, request.signal) as Promise<ApprovalOutcome>
      }, { global: true }),
      ctx.on('user-questions/request', async (request, next) => {
        const agent = request.agent as Agent | undefined
        if (agent === undefined || !this.canAnswer(agent)) return next()
        await this.assertWrite(agent.id)
        if (!this.canAnswer(agent)) return next()
        return this.wait(agent, { kind: 'question', sessionId: agent.id, requestId: randomUUID(),
          questions: structuredClone(request.questions), ...(request.wait === undefined ? {} : { wait: structuredClone(request.wait) }) }, request.signal) as Promise<AskUserQuestionAnswer>
      }, { global: true }),
    ]
  }
  private canAnswer(agent: Agent): boolean {
    return scopeOf(agent.ctx) === agent && this.ctx.agents.get(agent.id) === agent
      && [...this.listeners].some(listener => listener.sessionId === agent.id && !listener.readonly)
  }
  private broadcast(frame: ProjectUiInteractionFrame, sessionId: SessionId): void {
    for (const listener of this.listeners) if (listener.sessionId === sessionId) listener.push(frame)
  }
  private wait(agent: Agent, item: ProjectUiPendingInteraction, signal?: AbortSignal): Promise<ApprovalOutcome | AskUserQuestionAnswer> {
    return new Promise((resolve, reject) => {
      const abort = () => this.settle(item.requestId, item.kind === 'approval' ? 'cancelled' : undefined,
        item.kind === 'question' ? new UserQuestionError('Question request was withdrawn.', 'ASK_ABORTED', { cause: signal?.reason }) : undefined)
      this.pending.set(item.requestId, { item, agent, resolve, reject,
        unlisten: () => signal?.removeEventListener('abort', abort) })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) { abort(); return }
      this.broadcast({ type: 'pending', item }, agent.id)
    })
  }
  private settle(id: string, value?: ApprovalOutcome | AskUserQuestionAnswer, error?: unknown): void {
    const request = this.pending.get(id)
    if (request === undefined) return
    this.pending.delete(id); request.unlisten()
    this.broadcast({ type: 'settled', sessionId: request.item.sessionId, requestId: id }, request.item.sessionId)
    if (error !== undefined) request.reject(error)
    else request.resolve(value!)
  }
  subscribe(id: SessionId, readonly: boolean, push: (frame: ProjectUiInteractionFrame) => void): () => void {
    const listener = { sessionId: id, readonly, push }
    this.listeners.add(listener)
    push({ type: 'baseline', items: [...this.pending.values()].filter(value => value.item.sessionId === id).map(value => value.item) })
    return () => {
      this.listeners.delete(listener)
      if ([...this.listeners].some(value => value.sessionId === id && !value.readonly)) return
      for (const request of [...this.pending.values()]) if (request.item.sessionId === id) {
        this.settle(request.item.requestId, request.item.kind === 'approval' ? 'cancelled' : undefined,
          request.item.kind === 'question' ? new UserQuestionError('Answering Client disconnected.', 'ASK_ABORTED') : undefined)
      }
    }
  }
  async respond(response: ProjectUiInteractionResponse): Promise<{ readonly accepted: boolean }> {
    if (response.readonly) throw new Error('PROJECT_READ_ONLY: Reader interactions cannot mutate a Session')
    await this.assertWrite(response.sessionId)
    const pending = this.pending.get(response.requestId)
    if (pending === undefined) return { accepted: false }
    if (pending.item.sessionId !== response.sessionId || this.ctx.agents.get(response.sessionId) !== pending.agent) {
      throw new Error('PROJECT_INTERACTION_SCOPE: request does not belong to the exact live carrier')
    }
    if (response.kind === 'dismiss') {
      this.settle(response.requestId, pending.item.kind === 'approval' ? 'cancelled' : undefined,
        pending.item.kind === 'question' ? new UserQuestionError('Question dismissed.', 'ASK_ABORTED') : undefined)
    } else if (response.kind === 'timeout') {
      if (pending.item.kind !== 'question' || pending.item.wait?.timed !== true) throw new Error('PROJECT_INTERACTION_KIND: request is not a timed question')
      this.settle(response.requestId, undefined, new UserQuestionError('Question answer window elapsed.', 'ASK_TIMED_OUT'))
    } else if (response.kind === 'approval' && pending.item.kind === 'approval') {
      if (!['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(response.outcome)) throw new Error('PROJECT_INTERACTION_OUTCOME')
      this.settle(response.requestId, response.outcome)
    } else if (response.kind === 'question' && pending.item.kind === 'question') {
      const ids = new Set(response.answer.answers.map(answer => answer.id))
      if (ids.size !== response.answer.answers.length || ids.size !== pending.item.questions.length
        || !pending.item.questions.every(question => ids.has(question.id))) {
        throw new UserQuestionError('Answer must name each question exactly once.', 'BAD_ANSWER')
      }
      this.settle(response.requestId, structuredClone(response.answer))
    } else throw new Error('PROJECT_INTERACTION_KIND: response does not match pending request')
    return { accepted: true }
  }
  close(): void {
    for (const dispose of this.disposers) dispose()
    for (const pending of [...this.pending.values()]) this.settle(pending.item.requestId,
      pending.item.kind === 'approval' ? 'cancelled' : undefined,
      pending.item.kind === 'question' ? new UserQuestionError('Projects UI closed.', 'ASK_ABORTED') : undefined)
    this.listeners.clear()
  }
}
