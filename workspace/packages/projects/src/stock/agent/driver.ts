import {preparedProjectImagePricing,preparedProjectConfigurationGeneration} from '../model/capture.ts'
/*!
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Adapted from DeepSeek DSH 639ed015397290b3745d163aafe02ffee4aa3f84
packages/core/agent-loop/src/agent.ts
*/
// MIT; adapted from DeepSeek DSH 639ed015397290b3745d163aafe02ffee4aa3f84 packages/core/agent-loop/src/agent.ts
/**
 * Default Agent driver over queued turns and step-boundary input. Every request
 * is derived from the session log.
 * @module dsh-agent-loop/agent
 */

import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
  PreStepDecision,
  RequestErrorAction,
} from '@deepseek-ai/dsh-agent'
import { agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, LlmCallConfig, PreparedLlmCall } from '@deepseek-ai/dsh-llm'
import {
  LlmError,
  boundContextSummary,
  createAssistantMessage,
  createDeveloperMessage,
  createSystemMessage,
  createUserMessage,
  errorChain,
} from '@deepseek-ai/dsh-llm'
import { assertNever, deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { EpochHeader, RequestContext, Session, SessionId, SessionSeq, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { canonicalHeader, headerEquals, SessionLogOffset, ToolCallRecovery } from '@deepseek-ai/dsh-session'
import { joinContextSections, renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { Context } from '@deepseek-ai/cordis'
import { ReactLoopInbox } from './inbox.ts'
import { RuntimeContextProjection } from '../request/runtime-context.ts'
import { AssistantStreamAttempt } from './assistant-stream.ts'
import { SystemPromptProjection } from '../request/runtime-context.ts'
import { commitProjectDispatch, bindCapturedProjectRequest, prepareProjectRequest, bindProjectRequestHooks, type ProjectDriverPersistence, type ProjectRequestHooks } from '../request/dispatch.ts'
import { planRequestDispatch, commitRequestPlan } from '../request/projection.ts'
import { latestProjectDispatch, dispatchFacts, type ProjectRequestPayloadStore, type ProjectRequestPayload } from '../request/records.ts'
import { nativeSourceDigest } from '../../native-source-host.ts'
import { prepareRuntimeCurrentBlocks, withRuntimeRequestProjection } from '../request/runtime-current.ts'
import { emitProjectTurnSettled, emitProjectCancelRequested, emitProjectInboxClaimed, type PreparedRequestContext } from '../request/harness.ts'
import { withProjectCallIdentity } from '../model/capture.ts'
import { projectRecordingPolicy } from '../recording/index.ts'
import { projectStreamRecording } from '../recording/index.ts'
import { executeToolCalls } from '../tools/native-scheduler-rc2.ts'
import { assertPrivateUiInputPublication } from '../ui-host/attachments.ts'

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

type StepEndReason = Extract<TurnEndReason, { kind: 'completed' | 'max-tokens' }>

type PreparedStep =
  | { kind: 'reject' }
  | {
    kind: 'enter'
    messages: UserMessage[]
    startsRequestSeries?: true
    assembly: PromptAssembly
  }

/** Remove adapter-derived values before plugins propose the next request config. */
function requestProposal(header: EpochHeader): LlmCallConfig {
  if (header.adapterDefaults === undefined) return header.config
  const proposal = { ...header.config }
  if (header.adapterDefaults.reasoningEffort === true) delete proposal.reasoningEffort
  if (header.adapterDefaults.maxTokens === true) delete proposal.maxTokens
  return proposal
}

// MIT; notice contract adapted from DeepSeek DSH 1f81c047fc48fa190a683e469daa699857e9afe8
// packages/core/agent/src/model-selection.ts. Cold recovery has no native selection listener.
function requestModelSwitchMessages(messages: UserMessage[], previous: LlmCallConfig | undefined, selected: LlmCallConfig): UserMessage[] {
  if (previous === undefined || previous.provider === selected.provider && previous.model === selected.model) return messages
  const sameProvider = previous.provider === selected.provider
  const from = sameProvider ? previous.model : `${previous.provider}/${previous.model}`
  const to = sameProvider ? selected.model : `${selected.provider}/${selected.model}`
  const text = `[model changed: assistant turns above this point were generated by ${from}; the session continues with ${to}]`
  const summary = boundContextSummary(`${from} → ${to}`)
  // Keep the native listener's exact message identity when its owner is installed later.
  if (messages.some(message => message.source.kind === 'model-selection'
    && message.source.form === 'notice' && message.source.summary === summary
    && message.content.length === 1 && message.content[0]?.type === 'text' && message.content[0].text === text)) return messages
  return [...messages, createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'model-selection', form: 'notice', summary },
  })]
}

/**
 * Read the cause `cancel()` passed when aborting a loop-owned signal, copying
 * only the fields `turn/end` records. The live reason stays the caller's
 * object, and Node's fetch assigns a `stack` onto it that `Session.append`
 * would either log or reject as data JSON cannot hold.
 * @param signal - a turn or maintenance signal this loop owns.
 * @returns the copied cause, or undefined while the signal is still live.
 */
function abortedCancelCause(signal: AbortSignal): AgentCancelCause | undefined {
  if (!signal.aborted) return undefined
  // `cancel()` is the only aborter of the signals this loop owns.
  const cause = signal.reason as AgentCancelCause
  switch (cause.kind) {
    case 'user':
    case 'parent':
    case 'disposed':
      return { kind: cause.kind }
    case 'hook':
      return { kind: 'hook', reason: cause.reason }
    /* v8 ignore next -- cancel accepts the closed AgentCancelCause union */
    default:
      return assertNever(cause)
  }
}

/** Drives one session through turn and step boundaries. */
export class ProjectAgent implements Agent {
  readonly inbox: ReactLoopInbox
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  readonly scope: Scope
  readonly ctx: Context

  /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
  private readonly dispatch: AgentEventDispatch

  /** Whether this loop instance has appended its initial/resume request anchor. */
  private requestHeaderLogged = false
  /** Latest header appended by this driver; its first request always logs an anchor. */
  private requestHeaderSeq: SessionSeq | undefined
  /** Surface generation at attachment or the preceding built request. */
  private requestSurfaceGeneration: number
  private readonly runtimeContext: RuntimeContextProjection
  /** Process-local revision of assistant frames for this attached Session. */
  private assistantStreamRevision = 0
  private assistantAttemptCounter = 0
  private readonly systemPrompt: SystemPromptProjection
  private persistenceHalted = false
  private requestAttempt = 0
  /** A claimed input stays owned until its user/message admission or an explicit discard. */
  private claimedInputs?: Record<InboxTarget, UserMessage[]>
  private recordingStop = false
  private cancelRevision = 0
  private wakeInvalidationRevision = 0
  private drivingPolicy: () => boolean = () => true
  setDrivingPolicy(policy: () => boolean): () => void {
    const previous = this.drivingPolicy; this.drivingPolicy = policy
    return () => { if (this.drivingPolicy === policy) this.drivingPolicy = previous }
  }
  isAcceptingInput(): boolean { return !this.persistenceHalted }

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
    private readonly persistence: ProjectDriverPersistence,
    private readonly requestHooks?: ProjectRequestHooks,
    private readonly maxParallelToolCalls = 4,
  ) {
    bindProjectRequestHooks(this, requestHooks)
    this.requestSurfaceGeneration = session.surface.contentGeneration
    this.dispatch = agentEvents(loopCtx, this)
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx
    this.inbox = new ReactLoopInbox(this.ctx.sessionProjections, session, this.dispatch, () => { this.claimedInputs = undefined })
    /* v8 ignore next -- the loop registers its own turnBoundary unit, so the key is always present */
    const lastTurn = this.loopCtx.sessionProjections.stateOf(session, 'turnBoundary')?.lastTurn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.runtimeContext = new RuntimeContextProjection(this.ctx, session)
    this.systemPrompt = new SystemPromptProjection(session)
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /** Commit a phase and publish its externally visible status transition. */
  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  haltPersistence(): void {
    this.persistenceHalted = true
    this.cancel({ kind: 'disposed' }, { keepInbox: true })
  }

  /** Lifecycle owner closes input admission before draining the exact writer. */
  retire(options: { keepInbox?: boolean } = {}): void {
    this.persistenceHalted = true
    this.cancel({ kind: 'disposed' }, options)
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    this.persistence.assertHealthy()
    if (this.persistenceHalted) throw new Error('Project driver is no longer accepting input')
    // Waking input cannot join an aborted activity, so it starts the next turn.
    // Captured before the insertion so a reentrant cancel from a splice observer cannot reclassify it.
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  /**
   * Admit waking input with its pre-insertion cancellation classification.
   * @param message - identified input to queue before its durability barrier.
   * @param target - preferred boundary; input arriving after abort starts a new turn.
   * @returns a one-shot wake to call only after successful persistence and current admission checks.
   */
  sendWithDeferredWake(message: UserMessage, target: InboxTarget): () => void {
    this.persistence.assertHealthy()
    if (this.persistenceHalted) throw new Error('Project driver is no longer accepting input')
    const wakingAfterAbort = this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const latchesWake = this.phase.kind === 'maintenance' || wakingAfterAbort
    const cancelRevision = this.cancelRevision
    const wakeInvalidationRevision = this.wakeInvalidationRevision
    this.inbox.splice(wakingAfterAbort ? 'next-turn' : target, Infinity, 0, [message])
    let requested = false
    return () => {
      if (requested) return
      requested = true
      this.persistence.assertHealthy()
      if (this.persistenceHalted) throw new Error('Project driver is no longer accepting input')
      // Preserving Stop retains a previously latched wake, but cannot turn
      // an earlier ordinary admission into fresh post-Stop input.
      if (latchesWake
        ? wakeInvalidationRevision !== this.wakeInvalidationRevision
        : cancelRevision !== this.cancelRevision) return
      this.wakeDriver(wakingAfterAbort)
    }
  }

  followup(input: UserMessage): void {
    assertPrivateUiInputPublication(this.loopCtx, this, input)
    this.send(input, 'next-turn', true)
  }

  steer(input: UserMessage): void {
    assertPrivateUiInputPublication(this.loopCtx, this, input)
    this.send(input, 'next-step', true)
  }

  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    this.cancelRevision++
    if (!options.keepInbox || cause.kind === 'disposed') this.wakeInvalidationRevision++
    if (!this.recordingStop && projectRecordingPolicy(this) !== undefined) {
      this.recordingStop = true
      try {
        const state = this.phase.kind === 'running' ? { kind: 'running' as const, turn: this.phase.turn, step: this.phase.step } : { kind: this.phase.kind, lastTurn: this.phase.lastTurn }
        this.session.append('projects/agent-stop-request', { cause: structuredClone(cause), keepInbox: options.keepInbox === true, state })
      } catch (error) { this.persistence.fail(error); throw error }
      finally { this.recordingStop = false }
    }
    emitProjectCancelRequested({agent:this,cause})
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        const cause = abortedCancelCause(maintenance.abort.signal)
        if (cause?.kind !== 'disposed' && maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  /**
   * Start one driver, or latch its wake behind maintenance or an aborted
   * activity. A wake sent while idle always opens its turn boundary, even
   * when its message was cleared; only a latched replay is suppressed when
   * the queue no longer holds the wake.
   * @param wakeAfterAbort - the {@link send} classification, captured before
   *   the inbox insertion so a reentrant cancel cannot reclassify it.
   */
  private wakeDriver(wakeAfterAbort = false): void {
    if (this.persistenceHalted || !this.drivingPolicy()) return
    if (this.phase.kind !== 'idle') {
      // Maintenance and aborted drivers cannot deliver the wake: latch it for
      // replay at convergence. Live drivers claim queued work themselves;
      // disposal never latches, so teardown waits on no model turn.
      const reason = abortedCancelCause(this.phase.abort.signal)
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    })
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
    if (projectRecordingPolicy(this) !== undefined) this.persistence.assertHealthy()
  }

  /** Report one failure at its live boundary, then preserve it for driver containment. */
  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {}
    } catch (_error) {
      // Reported failures and cancellation are contained at the driver boundary.
    } finally {
      /* v8 ignore next -- kick owns a running phase until this driver boundary */
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  private async preStep(target: InboxTarget, position: { turn: number; step: number }): Promise<PreparedStep> {
    /* v8 ignore next -- private callers establish the running phase before proposing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": pre-step outside running phase`)
    const signal = this.phase.abort.signal
    if (!this.drivingPolicy()) return {kind:'reject'}
    this.claimedInputs = {
      'next-step': [...this.inbox.nextStep],
      'next-turn': target === 'next-turn' ? this.inbox.nextTurn.slice(0, 1) : [],
    }
    const claimed = this.inbox.claim(target, position.turn)
    for (const message of claimed) emitProjectInboxClaimed({agent:this,message,turn:position.turn})
    const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
    signal.throwIfAborted()
    const sections = renderContextSections(assembly)
    const context = this.runtimeContext.project(joinContextSections(sections), sections)
    const decision = await this.dispatch.waterfall(
      'agent/pre-step', { messages: claimed, ...position, signal },
      (): Promise<PreStepDecision> => Promise.resolve<PreStepDecision>({
        kind: 'enter',
        messages: context === undefined ? claimed : [...claimed, context],
      }),
    )
    signal.throwIfAborted()
    if (decision.kind === 'reject') return decision
    return { ...decision, assembly }
  }

  /** Preserve the original queue boundary without waking the stopped driver. */
  private restoreClaimedInputs(): void {
    const claimed = this.claimedInputs
    if (claimed === undefined) return
    for (const target of ['next-step', 'next-turn'] as const) {
      // A synchronous observer may explicitly clear the remaining input.
      if (this.claimedInputs !== claimed) return
      const messages = claimed[target]
      claimed[target] = []
      if (messages.length > 0) this.inbox.splice(target, 0, 0, messages)
    }
    this.claimedInputs = undefined
  }

  private admitClaimedInput(message: UserMessage): void {
    if (this.claimedInputs === undefined) return
    for (const target of ['next-step', 'next-turn'] as const) {
      this.claimedInputs[target] = this.claimedInputs[target].filter(input => input.id !== message.id)
    }
  }

  /** Whether the assembled tool schemas differ from the logged request header's. */
  private toolsChanged(tools: PromptAssembly['tools']): boolean {
    const baseline = this.session.requestHeader()
    if (baseline === undefined) return false
    return !headerEquals(baseline, canonicalHeader({ ...baseline, tools: [...tools] }))
  }

  /** Open one turn before claiming its first proposed step. */
  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    const phase = this.phase
    if (!this.drivingPolicy()) return false
    const { signal } = phase.abort
    signal.throwIfAborted()
    const turn = phase.turn + 1
    let turnStartSeq!: SessionSeq
    try {
      turnStartSeq = this.session.append('turn/start', { turn }).seq
    } catch (error: unknown) {
      this.throwError(error)
    }
    phase.turn = turn
    let turnEnds: TurnEndReason | null = null
    let target: InboxTarget = 'next-turn'
    try {
      while (true) {
        signal.throwIfAborted()
        const step = phase.step + 1
        const decision = await this.preStep(target, { turn, step })
        if (decision.kind === 'reject') {
          turnEnds = { kind: 'blocked' }
          return false
        }
        if (turnEnds && decision.messages.length === 0) break
        // A removed waking message or an enter decision rewritten to empty
        // still owns the initial turn boundary, but it spends no model call.
        if (phase.step === 0 && decision.messages.length === 0) {
          turnEnds = { kind: 'completed' }
          return false
        }
        signal.throwIfAborted()
        this.session.append('step/start', { turn, step })
        phase.step = step
        const toolRecovery = new ToolCallRecovery()
        const stopRecovery = this.ctx.on('session/event', (session, event) => {
          if (session === this.session) toolRecovery.observe(event)
        })
        try {
          // max-tokens is sticky: once any step hits the ceiling, later steps
          // that complete normally must not downgrade the turn outcome.
          const stepEnd = await this.step(decision, turnStartSeq)
          // max-tokens stays sticky: a later completed step must not
          // downgrade the turn outcome.
          if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
        } catch (error: unknown) {
          try {
            for (const event of toolRecovery.results()) {
              this.session.append('tool/result', event.data, {
                surfaceOp: 'append',
                ...event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs },
              })
            }
          } catch (recoveryError: unknown) {
            throw new AggregateError([error, recoveryError], 'Step failed and its pending tool results could not be recorded', { cause: error })
          }
          throw error
        } finally {
          stopRecovery()
          this.session.append('step/end', { turn, step })
        }
        signal.throwIfAborted()
        if (turnEnds && this.inbox.nextStep.length === 0) {
          await this.dispatch.serial('agent/turn-stopping', { turn, signal })
          signal.throwIfAborted()
        }
        if (turnEnds && this.inbox.nextStep.length === 0) break
        target = 'next-step'
      }
    } catch (error: unknown) {
      // A cause is present exactly while the signal is aborted.
      const cause = abortedCancelCause(signal)
      if (cause !== undefined) {
        turnEnds = { kind: 'aborted', reason: cause }
        this.restoreClaimedInputs()
        throw error
      }
      // Every failure is structured: an `LlmError` keeps its facts, anything
      // else flattens to `errorChain` text under the `UNKNOWN` code.
      turnEnds = {
        kind: 'error',
        error: error instanceof LlmError
          ? error.failure
          : { message: errorChain(error), code: 'UNKNOWN' },
      }
      this.throwError(error)
    } finally {
      this.claimedInputs = undefined
      try {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
        const turnEnd = this.session.append('turn/end', { turn, reason: turnEnds! })
        await this.persistence.flush()
        if (turnEnds?.kind === 'completed' || turnEnds?.kind === 'max-tokens') {
          this.session.append('projects/turn-settled', { turn, throughSeq: this.session.seq - 1 })
          await this.persistence.flush()
        }
        const consumedInputs = this.session.snapshotEvents(SessionLogOffset(turnStartSeq + 1), SessionLogOffset(turnEnd.seq)).flatMap(event => event.type === 'user/message' && event.data.currentBlock === undefined && event.data.source.kind !== 'runtime-context' ? [{messageId:event.data.id,source:event.data.source,eventSeq:event.seq}] : [])
        emitProjectTurnSettled({agent:this,signal,turn,startSeq:turnStartSeq,endSeq:turnEnd.seq,reason:turnEnds!,consumedInputs})
      } catch (error: unknown) {
        this.throwError(error)
      }
    }
    // Stop may arrive while the completed turn's durable barriers drain.
    // Leave its preserved queue idle; kick replays only an explicit fresh wake.
    if (signal.aborted || !this.inbox.hasPending) return false
    phase.abort = new AbortController()
    // A fresh controller makes a latch set on the old one stale: the live driver claims the queue itself.
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  private async step(decision: Extract<PreparedStep, { kind: 'enter' }>, turnStartSeq: SessionSeq): Promise<StepEndReason | null> {
    /* v8 ignore next -- private callers establish the running phase before executing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": step outside running phase`)
    const { turn, step, abort: { signal } } = this.phase
    signal.throwIfAborted()

    let firstAttempt = true
    while (true) {
      this.persistence.assertHealthy()
      const attempt = ++this.requestAttempt
      const lease = await this.requestHooks?.beforePrepare?.({agent:this,turn,step,attempt,signal})
      try {
      const { config, preparedCall } = await this.prepareRequest(turn, step, signal)
      const prepared = await prepareProjectRequest(this.requestHooks, { agent: this, turn, step, attempt, signal, purpose:'conversation',config,context:preparedCall?.context })
      const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
      signal.throwIfAborted()
      const admissionStartSeq = this.session.seq
      const renderedPrompt = [renderPrompt(assembly), prepared.currentRequirements].filter(Boolean).join('\n\n')
      const sections = renderContextSections(assembly)
      const startsRequestSeries = firstAttempt && decision.startsRequestSeries === true
      const commits = this.systemPrompt.project(renderedPrompt, {
        inHistory: false,
        startsSeries: startsRequestSeries
          || this.requestSurfaceGeneration !== this.session.surface.contentGeneration
          || (preparedCall?.toolUpdate === undefined && this.toolsChanged(assembly.tools)),
      })
      for (const { message, intent } of commits) {
        this.session.append('system/message', { turn, step, message }, intent)
      }
      if (firstAttempt) {
        const messages = requestModelSwitchMessages(decision.messages, this.session.requestHeader()?.config, config)
        for (const message of messages) {
          // The pre-step candidate may have crossed async configuration work.
          // Admit the snapshot from this exact attempt's fresh assembly below.
          if (message.source.kind === 'runtime-context') continue
          signal.throwIfAborted()
          this.session.append('user/message', message, { surfaceOp: 'append' })
          this.admitClaimedInput(message)
        }
      }
      // Runtime sections enter the same current-object planner as product blocks.
      firstAttempt = false
      const previousDispatch = latestProjectDispatch(this.session)
      const priorPromptDigest = previousDispatch === undefined ? undefined : dispatchFacts(previousDispatch).systemContentDigest
      const frontChanged = (priorPromptDigest!==undefined&&priorPromptDigest!==nativeSourceDigest(createSystemMessage(renderedPrompt).content)) || this.toolsChanged(assembly.tools)
      const envelope = this.commitRequestEnvelope(config, preparedCall, assembly.tools, { turn, step }, startsRequestSeries, signal)
      const selected = prepared.historySeqs === undefined ? prepared.role === 'work' ? undefined : this.session.surface.nodes.filter(seq=>seq>=turnStartSeq) : prepared.historySeqs
      const planning = {
        owner:{purpose:'conversation' as const,turn,step,attempt},header:this.session.requestHeader()!,
        ...this.requestHeaderSeq===undefined?{}:{headerSeq:this.requestHeaderSeq},
        ...selected===undefined?{}:{historySeqs:[...new Set([...selected,...this.session.surface.nodes.filter(seq=>seq>=admissionStartSeq)])]},
        sourcedHistory:prepared.sourcedHistory,
        system:createSystemMessage(renderedPrompt),
        currentBlocks:[...(prepared.currentBlocks??[]),...prepareRuntimeCurrentBlocks(this.session,sections)],
        historyProjection:withRuntimeRequestProjection(prepared.historyProjection,sections),
        inputPolicy:prepared.inputPolicy,toolUpdate:preparedCall?.toolUpdate,
        ...frontChanged?{allowNewOmissions:'front-change' as const}:{},
      }
      let plan=planRequestDispatch(this.session,planning)
      if(prepared.projectCandidate){
        const projection=await prepared.projectCandidate({candidate:plan,signal,contextWindow:preparedCall?.context?.contextWindow,reservedOutputTokens:config.maxTokens??0,imageRequestPricing:preparedCall!==undefined&&preparedProjectConfigurationGeneration(preparedCall)!==undefined?preparedProjectImagePricing(preparedCall):this.loopCtx.llm.imageRequestPricing(config.provider,config.model)})
        if(projection.length>0||this.session.seq!==plan.baseRevision) plan=planRequestDispatch(this.session,{...planning,contentProjection:projection})
      }
      const context=commitRequestPlan(this.session,plan)
      const candidate={...envelope,messages:plan.messages.map(item=>item.message),...plan.toolHistory===undefined?{}:{toolHistory:plan.toolHistory}}
      let captured: ProjectRequestPayload | undefined
      const dispatch = commitProjectDispatch(this.session, candidate, { turn, step, attempt },context,lease?.preset,this.loopCtx.sessionPersistence as unknown as ProjectRequestPayloadStore, value => { captured = value })
      await this.persistence.flush()
      if (captured === undefined) throw new Error('PROJECT_REQUEST_CAPTURE_UNAVAILABLE')
      const request = bindCapturedProjectRequest(captured.request, this.session, signal)
      const live = new AssistantStreamAttempt(
        this.session.id,
        ++this.assistantAttemptCounter,
        () => ++this.assistantStreamRevision,
        turn,
        step,
        (frame) => { this.dispatch.emit('agent/assistant-stream', { frame }) },
        projectStreamRecording(this, this.persistence, error => { this.persistence.fail(error); this.haltPersistence() }),
      )
      let started = false
      try {
        await withProjectCallIdentity(this,{dispatchId:dispatch.data.dispatchId,attemptId:live.attemptId,role:prepared.role,turn,step,attempt},async()=>{
        const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
        signal.throwIfAborted()
        live.start()
        started = true
        for await (const chunk of stream) {
          signal.throwIfAborted()
          live.push(chunk)
          await live.checkpoint()
        }
        })
        signal.throwIfAborted()
      } catch (error: unknown) {
        if (live.recordingError !== undefined) {
          if (started && !live.ended) live.abandon()
          throw live.recordingError
        }
        if (!started) throw error
        try {
          if (signal.aborted) {
            const content = live.interruptedBlocks()
            if (content.length > 0) {
              await live.settle('assistant/message', () => this.session.append('assistant/message', {
                turn,
                step,
                message: createAssistantMessage({
                  content,
                  source: {
                    provider: request.provider,
                    model: request.model,
                    ...live.replayState === undefined ? {} : { replayState: live.replayState },
                  },
                }),
                interrupted: true,
                ...live.usage === undefined ? {} : { usage: live.usage },
                stream: live.stream,
              }, { surfaceOp: 'append' }).seq)
            } else {
              await live.settle(
                'assistant/attempt',
                () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq,
              )
            }
          } else {
            await live.settle(
              'assistant/attempt',
              () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq,
            )
          }
        } catch (settlementError: unknown) {
          throw new AggregateError(
            [error, settlementError],
            'Assistant stream failed and its durable settlement was rejected',
            { cause: error },
          )
        }
        throw error
      }
      try {
        const finish = live.finish
        if (finish.kind === 'error' || finish.kind === 'aborted') {
          await live.settle(
            'assistant/attempt',
            () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq,
          )
          const action = await this.dispatch.waterfall(
            'agent/request-error', {
              turn,
              step,
              provider: request.provider,
              failure: finish.failure,
              retryPolicy: preparedCall?.retryPolicy,
              signal,
            },
            () => Promise.resolve<RequestErrorAction>(undefined),
          )
          signal.throwIfAborted()
          if (action?.kind !== 'retry') {
            throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
          }
          continue
        }

        const message = createAssistantMessage({
          content: live.blocks(),
          source: {
            provider: request.provider,
            model: request.model,
            ...live.replayState !== undefined ? { replayState: live.replayState } : {},
          },
        })
        await live.settle(
          'assistant/message',
          () => this.session.append('assistant/message', {
            turn,
            step,
            message,
            ...live.usage === undefined ? {} : { usage: live.usage },
            stream: live.stream,
          }, { surfaceOp: 'append' }).seq,
        )
        if (finish.kind === 'max-tokens') return { kind: 'max-tokens' }

        const toolCalls = message.content.filter(block => block.type === 'tool-call')
        if (toolCalls.length === 0) return { kind: 'completed' }
        const { concluded } = await executeToolCalls(
          this.loopCtx, turn, step, toolCalls, signal,
          context => this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context]),
          this.maxParallelToolCalls, this.persistence,
        )
        return concluded ? { kind: 'completed' } : null
      } catch (error: unknown) {
        if (!live.ended) live.abandon()
        throw error
      }
      } finally { try { await this.persistence.flush() } finally { await lease?.[Symbol.asyncDispose]() } }
    }
  }

  /** Resolve request config and bind its adapter before admitting model-visible input. */
  private async prepareRequest(
    turn: number,
    step: number,
    signal: AbortSignal,
  ): Promise<{ config: LlmCallConfig; preparedCall?: PreparedLlmCall }> {
    const { session } = this

    // A loop instance starts from its declared route, restoring only an explicit
    // effort owned by that exact model. Later steps re-resolve marked defaults.
    const persistedHeader = session.requestHeader()
    const persistedConfig = persistedHeader?.config
    const route = { provider: this.options.provider ?? '', model: this.options.model ?? '' }
    const persistedReasoningEffort = persistedConfig?.provider === route.provider
      && persistedConfig.model === route.model
      && persistedHeader?.adapterDefaults?.reasoningEffort !== true
      ? persistedConfig.reasoningEffort
      : undefined
    const reasoningEffort = this.options.reasoningEffort ?? persistedReasoningEffort
    const maxTokens = this.options.maxTokens
    const seedConfig = deepFreeze(structuredClone(
      this.requestHeaderLogged
        // oxlint-disable-next-line typescript/no-non-null-assertion -- the instance logged the header it now folds
        ? requestProposal(persistedHeader!)
        : {
          ...route,
          ...reasoningEffort === undefined ? {} : { reasoningEffort },
          ...maxTokens === undefined ? {} : { maxTokens },
        },
    ))
    const proposedConfig = await this.dispatch.waterfall(
      'agent/request', { turn, step, signal },
      () => Promise.resolve(seedConfig),
    )
    signal.throwIfAborted()
    if (!proposedConfig.provider || !proposedConfig.model) {
      throw new Error(`agent "${this.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall`)
    }
    let config: LlmCallConfig
    let preparedCall: PreparedLlmCall | undefined
    try {
      preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal)
      config = preparedCall.config
    } catch (error: unknown) {
      // Middleware may serve an unregistered route; terminal dispatch still requires an adapter.
      if (!(error instanceof LlmError) || error.code !== 'NO_ADAPTER') throw error
      config = proposedConfig
    }
    signal.throwIfAborted()
    return { config, ...preparedCall === undefined ? {} : { preparedCall } }
  }

  /** Record route, declaration and context changes; the planner alone owns request history. */
  private commitRequestEnvelope(
    config: LlmCallConfig,
    preparedCall: PreparedLlmCall | undefined,
    tools: GenerateOptions['tools'] & object,
    position: { turn: number; step: number },
    startsRequestSeries: boolean,
    signal: AbortSignal,
  ): Omit<GenerateOptions, 'messages' | 'toolHistory'> {
    const { session } = this
    const surfaceGeneration = session.surface.contentGeneration
    const header = canonicalHeader({
      config,
      ...preparedCall === undefined ? {} : { adapterDefaults: preparedCall.adapterDefaults },
      ...tools.length > 0 ? { tools } : {},
    })
    const baseline = this.session.requestHeader()
    const startsSeries = startsRequestSeries
      || this.requestSurfaceGeneration !== surfaceGeneration
    let headerSeq: SessionSeq | undefined
    if (!this.requestHeaderLogged) {
      // Compaction during the first resumed pre-step must still mark a new series.
      headerSeq = this.session.append('request/header', {
        header,
        reason: baseline === undefined ? 'initial' : 'resume',
        ...startsSeries ? { startsSeries: true } : {},
      }).seq
      this.requestHeaderLogged = true
    } else if (baseline === undefined || !headerEquals(baseline, header)) {
      headerSeq = this.session.append('request/header', {
        header,
        reason: 'change',
        ...startsSeries ? { startsSeries: true } : {},
      }).seq
    } else if (startsSeries) {
      this.requestHeaderSeq = this.session.append('request/header', { header, reason: 'series' }).seq
    }
    if (headerSeq !== undefined) this.requestHeaderSeq = headerSeq
    if (baseline !== undefined && headerSeq !== undefined) {
      const previousNames = new Set(baseline.tools?.map(tool => tool.name))
      const currentNames = new Set(tools.map(tool => tool.name))
      const additions = tools.filter(tool => !previousNames.has(tool.name))
        .map(tool => ({ type: 'tool-addition' as const, toolName: tool.name }))
      const removals = (baseline.tools ?? []).filter(tool => !currentNames.has(tool.name))
        .map(tool => ({ type: 'tool-removal' as const, toolName: tool.name }))
      if (additions.length > 0 || removals.length > 0) {
        session.append('developer/message', {
          ...position,
          message: createDeveloperMessage({ source: { kind: 'tool-registry' }, content: [...additions, ...removals] }),
          ...additions.length > 0 ? { headerSeq } : {},
        }, { surfaceOp: 'append' })
      }
    }
    this.requestSurfaceGeneration = surfaceGeneration

    const contextWindow = preparedCall?.context?.contextWindow
    const systemPromptUpdate = preparedCall?.systemPromptUpdate
    const requestContext: RequestContext = {
      provider: config.provider,
      model: config.model,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...systemPromptUpdate === undefined ? {} : { systemPromptUpdate },
    }
    const previousContext = session.requestContext()
    if (previousContext?.provider !== requestContext.provider
      || previousContext.model !== requestContext.model
      || previousContext.contextWindow !== requestContext.contextWindow
      || previousContext.systemPromptUpdate !== requestContext.systemPromptUpdate) {
      session.append('request/context', requestContext)
    }
    signal.throwIfAborted()

    // canonicalHeader is shallow; append logs a detached snapshot, not these local values.
    deepFreeze(header)
    return Object.freeze({
      ...header.config,
      ...header.tools !== undefined ? { tools: header.tools } : {},
      sessionId: this.session.id,
      signal,
    })
  }
}
