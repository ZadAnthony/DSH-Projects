/** Retained native scopes consume the exact Project-owned Host waterfall requests. */
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertClientEventListener, RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type { ProjectUiInteractionFrame, ProjectUiInteractionResponse, ProjectUiPendingInteraction, ProjectUiTarget } from '../../ui-host/types.ts'
import type { FullProjectClientRemotePort } from './contracts.ts'

type ApprovalListener = TypertClientEventListener<'approval/request'>
type QuestionListener = TypertClientEventListener<'user-questions/request'>
interface Pending { readonly item: ProjectUiPendingInteraction; readonly lifetime: AbortController }
interface Retained {
  readonly binding: SessionBinding
  readonly target: ProjectUiTarget
  readonly pending: Map<string, Pending>
  references: number
  lifetime?: AbortController
  stream?: RemoteStreamHandle<ProjectUiInteractionFrame, never>
  task?: Promise<void>
}

function questionAbort(): Error & { code: string } {
  return Object.assign(new Error('Projects question request is no longer live'), { name: 'UserQuestionError', code: 'ASK_ABORTED' })
}

export interface ProjectInteractionSessions { binding(id: SessionId): SessionBinding | undefined }
export type ProjectInteractionSubmission =
  | { readonly status: 'submitting' | 'settled'; readonly requestId: string }
  | { readonly status: 'failed'; readonly requestId: string; readonly item: ProjectUiPendingInteraction; readonly response: ProjectUiInteractionResponse; readonly error: unknown }

export class ProjectNativeInteractions {
  readonly approvals = new Set<ApprovalListener>()
  readonly questions = new Set<QuestionListener>()
  private sessions: ProjectInteractionSessions | undefined
  private readonly retained = new Map<SessionId, Retained>()
  private readonly tasks = new Set<Promise<void>>()
  private started = false
  private disposed = false
  constructor(
    private readonly full: FullProjectClientRemotePort,
    private readonly capture: (id: SessionId) => ProjectUiTarget,
    private readonly reader: boolean,
    private readonly failed: (error: unknown) => void,
    private readonly submission?: (state: ProjectInteractionSubmission) => void,
  ) {}

  attachSessions(sessions: ProjectInteractionSessions): void {
    if (this.sessions !== undefined && this.sessions !== sessions) throw new Error('Projects interaction Session owner is already attached')
    this.sessions = sessions
  }

  retain(id: SessionId): () => void {
    if (this.disposed) throw new Error('Projects interaction owner is disposed')
    if (this.reader) return () => {}
    const binding = this.sessions?.binding(id)
    if (binding === undefined) throw new Error(`Projects interaction has no retained native binding: ${id}`)
    let record = this.retained.get(id)
    if (record !== undefined && record.binding !== binding) throw new Error('Projects interaction binding generation changed before release')
    if (record === undefined) {
      record = { binding, target: structuredClone(this.capture(id)), references: 0, pending: new Map() }
      if (record.target.sessionId !== id || record.target.readonly === true) throw new Error('Projects interaction requires the exact live writable carrier')
      this.retained.set(id, record)
    }
    const owned = record
    owned.references++
    if (this.started && owned.lifetime === undefined) this.open(owned)
    let released = false
    return () => {
      if (released) return
      released = true
      if (--owned.references !== 0) return
      this.retained.delete(id)
      this.close(owned)
    }
  }

  start(): void {
    if (this.disposed || this.reader) return
    this.started = true
    for (const record of this.retained.values()) if (record.lifetime === undefined) this.open(record)
  }
  restart(): void {
    for (const record of this.retained.values()) { this.close(record); if (this.started) this.open(record) }
  }

  private open(record: Retained): void {
    const lifetime = new AbortController()
    record.lifetime = lifetime
    const task = (async () => {
      let stream: RemoteStreamHandle<ProjectUiInteractionFrame, never> | undefined
      try {
        stream = this.full.uiInteractions(record.target, lifetime.signal)
        record.stream = stream
        for await (const frame of stream) {
          if (lifetime.signal.aborted || record.lifetime !== lifetime) break
          if (frame.type === 'baseline') {
            const ids = new Set(frame.items.map(item => item.requestId))
            for (const [id, pending] of record.pending) if (!ids.has(id)) { pending.lifetime.abort(); record.pending.delete(id) }
            for (const item of frame.items) this.pending(record, item)
          } else if (frame.type === 'pending') this.pending(record, frame.item)
          else {
            if (frame.sessionId !== record.binding.sessionId) throw new Error('Projects interaction settlement has a different Session identity')
            record.pending.get(frame.requestId)?.lifetime.abort()
            record.pending.delete(frame.requestId)
            this.submission?.({ status: 'settled', requestId: frame.requestId })
          }
        }
        if (!lifetime.signal.aborted) throw new Error('Projects interaction stream ended while its native Session remained retained')
      } catch (error) {
        if (!lifetime.signal.aborted) this.failed(error)
      } finally {
        stream?.dispose()
        if (record.lifetime === lifetime) this.close(record)
      }
    })()
    record.task = task
    this.track(task)
  }

  private pending(record: Retained, item: ProjectUiPendingInteraction): void {
    if (item.sessionId !== record.binding.sessionId) throw new Error('Projects interaction request has a different Session identity')
    if (record.pending.has(item.requestId)) return
    const pending = { item: structuredClone(item), lifetime: new AbortController() }
    record.pending.set(item.requestId, pending)
    this.track(this.answer(record, pending).catch(error => { if (!pending.lifetime.signal.aborted) this.failed(error) }))
  }

  private async answer(record: Retained, pending: Pending): Promise<void> {
    const { item, lifetime } = pending
    const signal = lifetime.signal
    // Freeze the exact request target before entering any listener or waiting for its answer.
    const target = structuredClone(this.capture(item.sessionId))
    if (target.sessionId !== record.binding.sessionId || target.readonly === true) throw new Error('Projects interaction lost its writable carrier')
    let response: Parameters<FullProjectClientRemotePort['uiRespondInteraction']>[0]
    try {
      if (item.kind === 'approval') {
        const listeners = [...this.approvals]
        const request: Parameters<ApprovalListener>[0] = { agent: record.binding.ctx, toolName: item.toolName, signal,
          ...(item.callId === undefined ? {} : { callId: item.callId }), ...(item.reason === undefined ? {} : { reason: item.reason }),
          ...(item.displayReason === undefined ? {} : { displayReason: item.displayReason }) }
        const call = (index: number): Promise<ApprovalOutcome> => {
          signal.throwIfAborted()
          const listener = listeners[index]
          return listener === undefined ? Promise.resolve('unavailable') : Promise.resolve(listener.call(record.binding.ctx, request, () => call(index + 1)))
        }
        response = { ...target, requestId: item.requestId, kind: 'approval', outcome: await call(0) }
      } else {
        const listeners = [...this.questions]
        const request: Parameters<QuestionListener>[0] = { agent: record.binding.ctx, questions: structuredClone([...item.questions]), signal,
          ...(item.wait === undefined ? {} : { wait: structuredClone(item.wait) }) }
        const call = (index: number): Promise<AskUserQuestionAnswer> => {
          signal.throwIfAborted()
          const listener = listeners[index]
          return listener === undefined ? Promise.reject(questionAbort()) : Promise.resolve(listener.call(record.binding.ctx, request, () => call(index + 1)))
        }
        response = { ...target, requestId: item.requestId, kind: 'question', answer: await call(0) }
      }
    } catch (error) {
      if (signal.aborted) return
      const timedOut = error instanceof Error && 'code' in error && error.code === 'ASK_TIMED_OUT'
      response = { ...target, requestId: item.requestId, kind: timedOut ? 'timeout' : 'dismiss' }
    }
    if (signal.aborted || record.pending.get(item.requestId) !== pending) return
    this.submission?.({ status: 'submitting', requestId: item.requestId })
    try {
      const result = await this.full.uiRespondInteraction(response)
      if (!result.ok) throw result.error
      this.submission?.({ status: 'settled', requestId: item.requestId })
    } catch (error) {
      if (!signal.aborted) this.submission?.({ status: 'failed', requestId: item.requestId, item: structuredClone(item), response: structuredClone(response), error })
      throw error
    }
    // accepted=false means the Host already settled this exact request. Never invent an answer.
  }

  private track(task: Promise<void>): void {
    this.tasks.add(task)
    void task.finally(() => { this.tasks.delete(task) }).catch(() => {})
  }
  private close(record: Retained): void {
    record.lifetime?.abort(); record.lifetime = undefined
    record.stream?.dispose(); record.stream = undefined
    for (const pending of record.pending.values()) pending.lifetime.abort()
    record.pending.clear()
  }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const record of this.retained.values()) this.close(record)
    this.retained.clear(); this.approvals.clear(); this.questions.clear()
    await Promise.allSettled([...this.tasks])
  }
}
