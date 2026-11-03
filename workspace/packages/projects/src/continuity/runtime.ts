/** One post-flush evaluation and its actual preparation/publication responsibility. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ProjectTurnSettled } from '../stock/request/harness.ts'
import type { ProjectStore } from '../records.ts'
import type { ProjectMembership } from '../records-types.ts'
import type { EvaluationEnvelope, MainCarrierSwitchResult, SessionManagerDecision } from './types.ts'
import type { MainAdmissionCoordinator } from './admission.ts'
import type { MainContinuityHistory } from './history.ts'
import type { MainHistoryWindow } from './history-types.ts'
import type { MainSessionManager } from './manager.ts'
import type { PreparedMainCarrier } from './native.ts'

interface ContinuityPorts {
  current(hostSessionId: string): ProjectMembership | undefined
  configuration(agent: Agent, membership: ProjectMembership): Promise<string>
  safe(agent: Agent): Promise<() => void>
  ensureManager(projectId: string): Promise<Agent>
  prepare(envelope: EvaluationEnvelope, agent: Agent, window: MainHistoryWindow, signal: AbortSignal, assertValid: () => void): Promise<PreparedMainCarrier>
  activate(prepared: PreparedMainCarrier): Promise<void>
  abandon(envelope: EvaluationEnvelope, prepared: PreparedMainCarrier): Promise<void>
}
/** One actual native notification, not a message or a retryable evaluation. */
interface SettledTurnReceipt {
  readonly fact: ProjectTurnSettled
  readonly projectId: string
  readonly mainSessionId: string
  readonly header: EvaluationEnvelope['header']
  readonly turn: EvaluationEnvelope['turn']
  readonly epoch: number
}
interface Attempt {
  readonly agent: Agent
  readonly envelope: EvaluationEnvelope
  readonly abort: AbortController
  done: Promise<void>
  committed: boolean
  readonly settlements: Promise<unknown>[]
}
import { isMainBusinessInput } from './business-input.ts'

import type {} from './events.ts'

/** Store owns publication, native services own execution, this owner joins their finite attempt. */
export class MainContinuityRuntime {
  private readonly attempts = new Map<string, Attempt>()
  private readonly records = new Map<Promise<void>, string>()
  private readonly pendingTurns = new Map<string, SettledTurnReceipt>()
  private readonly latestTurns = new Map<string, number>()
  private readonly suspendedProjects = new Set<string>()
  private closing = false
  constructor(private readonly ctx: Context, private readonly store: ProjectStore, readonly admission: MainAdmissionCoordinator,
    private readonly history: MainContinuityHistory, private readonly manager: MainSessionManager,
    private readonly timeoutMs: number, private readonly ports: ContinuityPorts) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error('Session manager timeout must be a positive platform-supported millisecond integer.')
  }

  /** Receive only a real post-flush fact; the main reply never waits for evaluation. */
  onSettledTurn(fact: ProjectTurnSettled): 'scheduled' | 'excluded' | 'duplicate' | 'deferred' {
    if (this.closing || fact.signal.aborted || fact.reason.kind !== 'completed' || !fact.consumedInputs.some(input => isMainBusinessInput(input.source.kind))) return 'excluded'
    const membership = this.ports.current(String(fact.agent.id))
    if (membership?.session.role !== 'main' || membership.session.archived || membership.project.archived || this.suspendedProjects.has(membership.project.id)) return 'excluded'
    const key = `${membership.project.id}/${membership.session.id}`
    const turn = { hostSessionId: String(fact.agent.id), sessionCreatedAt: fact.agent.session.header.createdAt,
      turnStartSeq: Number(fact.startSeq), turnEndSeq: Number(fact.endSeq) }
    const turnOwner = `${turn.hostSessionId}/${turn.sessionCreatedAt}`
    if ((this.latestTurns.get(turnOwner) ?? -1) >= turn.turnStartSeq) return 'duplicate'
    this.latestTurns.set(turnOwner, turn.turnStartSeq)
    const capture = this.admission.capture(membership.project.id, membership.session.id)
    const receipt: SettledTurnReceipt = { fact, projectId: membership.project.id, mainSessionId: membership.session.id,
      header: fact.agent.session.header, turn, epoch: capture.epoch }
    const previous = this.attempts.get(key)
    if (previous !== undefined) {
      // A newer real normal turn supersedes an older unstarted receipt. Keep
      // its original epoch/header/cut until the original owner actually joins.
      this.pendingTurns.set(key, receipt)
      this.cancelAttempt(previous, 'A newer normal main turn completed.')
      return 'deferred'
    }
    return this.start(receipt) ? 'scheduled' : 'excluded'
  }

  /** Start only an unchanged postflush receipt; never rebase an old fact to a new activity epoch. */
  private start(receipt: SettledTurnReceipt): boolean {
    const { fact, projectId, mainSessionId, header, turn, epoch } = receipt
    const membership = this.ports.current(turn.hostSessionId)
    if (this.closing || this.suspendedProjects.has(projectId) || membership?.project.id !== projectId
      || membership.session.id !== mainSessionId || membership.session.role !== 'main'
      || membership.project.archived || membership.session.archived
      || this.ctx.agents.get(fact.agent.id) !== fact.agent || fact.agent.session.header.id !== header.id
      || fact.agent.session.header.createdAt !== header.createdAt
      || this.latestTurns.get(`${turn.hostSessionId}/${turn.sessionCreatedAt}`) !== turn.turnStartSeq) return false
    const captured = this.admission.capture(projectId, mainSessionId)
    if (captured.epoch !== epoch || captured.hostSessionId !== turn.hostSessionId) return false
    const key = `${projectId}/${mainSessionId}`
    if (this.attempts.has(key)) return false
    const envelope: EvaluationEnvelope = { attemptId: `main-continuity-${randomUUID()}`, projectId,
      mainSessionId, hostSessionId: turn.hostSessionId, header, turn, epoch,
      // This is the first evaluation start. Original retirement may have
      // changed the Store revision, but never the receipt's causal epoch/cut.
      sessionRevision: membership.session.revision, configurationRevision: '', startedAt: Date.now() }
    const abort = new AbortController()
    const attempt: Attempt = { agent: fact.agent, envelope, abort, done: Promise.resolve(), committed: false, settlements: [] }
    this.attempts.set(key, attempt)
    const cancel = (reason: string): void => { this.cancelAttempt(attempt, reason) }
    const unbind = this.admission.bindAttempt(envelope.projectId, envelope.mainSessionId, cancel)
    const timeout = setTimeout(() => this.cancelAttempt(attempt, 'Session manager evaluation timed out.', true), this.timeoutMs)
    attempt.done = this.run(attempt).finally(() => {
      clearTimeout(timeout); unbind()
      if (this.attempts.get(key) !== attempt) return
      this.attempts.delete(key)
      const pending = this.pendingTurns.get(key)
      this.pendingTurns.delete(key)
      if (pending !== undefined) this.start(pending)
    })
    // Keep the real rejection for close/suspend, while background work also
    // reports it immediately without creating an unhandled rejection.
    void attempt.done.catch(error => { this.ctx.logger.warn('projects: main continuity settlement failed', error) })
    return true
  }

  private assertValid(attempt: Attempt): void {
    attempt.abort.signal.throwIfAborted()
    const captured = this.admission.capture(attempt.envelope.projectId, attempt.envelope.mainSessionId)
    if (captured.epoch !== attempt.envelope.epoch || captured.hostSessionId !== attempt.envelope.hostSessionId || captured.leases !== 0) throw new Error('Main evaluation became stale.')
  }

  private cancelAttempt(attempt: Attempt, reason: string, afterCommit = false): void {
    if (attempt.abort.signal.aborted || attempt.committed && !afterCommit) return
    attempt.abort.abort(new Error(reason))
  }

  private async run(attempt: Attempt): Promise<void> {
    const { envelope, agent, abort } = attempt
    let outcome = 'failed', detail: string | undefined
    try {
      const member = this.ports.current(String(agent.id))
      if (member === undefined) throw new Error('Current main disappeared.')
      const revision = await this.ports.configuration(agent, member)
      Object.assign(envelope, { configurationRevision: revision })
      this.assertValid(attempt)
      agent.session.append('projects/main-continuity', { envelope, phase: 'evaluation-start' })
      if (!await this.ctx.sessions.flush(agent.session)) throw new Error('Evaluation start flush is unavailable.')
      await waitForMainIdle(agent, abort.signal); this.assertValid(attempt)
      const window = await this.history.managerInput(envelope.projectId, envelope.mainSessionId, envelope.turn, abort.signal)
      this.assertValid(attempt)
      const bot = await this.ports.ensureManager(envelope.projectId)
      this.assertValid(attempt)
      const decision = await this.manager.evaluate({ envelope, window, agent: bot, signal: abort.signal,
        onSettlement: settlement => { attempt.settlements.push(settlement) } })
      this.assertValid(attempt)
      agent.session.append('projects/main-continuity', { envelope, phase: 'decision', decision })
      if (decision.decision === 'keep') { outcome = 'keep'; return }
      const result = await this.requestSwitch(envelope, decision)
      outcome = result.kind
      detail = result.kind === 'committed' ? `current=${result.hostSessionId};activated=${result.activated}` : result.reason
    } catch (error) { outcome = abort.signal.aborted ? 'cancelled' : 'failed'; detail = error instanceof Error ? error.message : String(error) }
    finally {
      // evaluate() may reject cancellation before its original Bot/read owner
      // stops. The same attempt retains that physical responsibility; a fresh
      // receipt cannot enter the manager slot until this join finishes.
      const settlements = await Promise.allSettled(attempt.settlements)
      for (const settled of settlements) if (settled.status === 'rejected') {
        const failure = settled.reason instanceof Error ? settled.reason.message : String(settled.reason)
        if (!abort.signal.aborted) outcome = 'failed'
        if (failure !== detail) detail = `${detail === undefined ? '' : detail + '; '}Manager original settlement: ${failure}`
      }
      agent.session.append('projects/main-continuity', { envelope, phase: 'settled', outcome, ...(detail === undefined ? {} : { detail }) })
      const recording = this.ctx.sessions.flush(agent.session).then(confirmed => {
        if (!confirmed) throw new Error('Continuity settlement flush is unavailable.')
      }).finally(() => { this.records.delete(recording) })
      this.records.set(recording, envelope.projectId)
      await recording
    }
  }

  /** Consume only a live program-bound attempt; model output cannot select another identity. */
  async requestSwitch(envelope: EvaluationEnvelope, decision: SessionManagerDecision): Promise<MainCarrierSwitchResult> {
    const attempt = this.attempts.get(`${envelope.projectId}/${envelope.mainSessionId}`)
    if (attempt?.envelope !== envelope || decision.decision !== 'switch') return { kind: 'stale', reason: 'Evaluation no longer owns this main.' }
    let prepared: PreparedMainCarrier | undefined
    try {
      this.assertValid(attempt)
      await this.ports.safe(attempt.agent)
      this.assertValid(attempt)
      const window = await this.history.select(envelope.projectId, envelope.mainSessionId, envelope.turn, attempt.abort.signal)
      this.assertValid(attempt)
      prepared = await this.ports.prepare(envelope, attempt.agent, window, attempt.abort.signal, () => this.assertValid(attempt))
      this.assertValid(attempt)
      const member = this.ports.current(envelope.hostSessionId)
      if (member === undefined || await this.ports.configuration(attempt.agent, member) !== envelope.configurationRevision) throw new Error('Main configuration changed during preparation.')
      const assertResponsibilitiesSettled = await this.ports.safe(attempt.agent)
      this.assertValid(attempt)
      const assertPublicationValid = () => { this.assertValid(attempt); assertResponsibilitiesSettled() }
      const actual = prepared
      const result = await this.admission.withPublication(envelope.projectId, envelope.mainSessionId, envelope.epoch, async () => {
        assertPublicationValid()
        try {
          const committed = await this.store.publishMainCarrier({ projectId: envelope.projectId, sessionId: envelope.mainSessionId,
            attemptId: envelope.attemptId, expectedRevision: actual.revision, expectedOldHeader: envelope.header, preparedHeader: actual.header,
            assertValid: assertPublicationValid })
          if (committed.kind !== 'updated') throw new Error('Main publication revision conflicted.')
          actual.revision = committed.session.revision
          attempt.committed = true
        } catch (commitError) {
          let snapshot
          try { snapshot = await this.store.getSnapshot(envelope.projectId) }
          catch {
            this.admission.markUnavailable(envelope.projectId, envelope.mainSessionId)
            attempt.committed = true // Unknown is retained; it must never enter private-root abandonment.
            throw new Error('Main publication result is unknown; dependent routing is unavailable.', { cause: commitError })
          }
          const session = snapshot.sessions.find(row => row.id === envelope.mainSessionId)
          const committed = session?.mainPreparations?.find(row => row.attemptId === envelope.attemptId)
          const current = session?.carriers?.find(row => row.isCurrent)
          if (committed?.state !== 'committed' || committed.toHeader?.id !== actual.header.id
            || committed.toHeader.createdAt !== actual.header.createdAt || current?.header?.id !== actual.header.id
            || current.header.createdAt !== actual.header.createdAt) throw commitError
          actual.revision = session!.revision
          attempt.committed = true
        }
        try {
          await this.ports.activate(actual)
          if (attempt.abort.signal.aborted) actual.handle.agent.cancel({ kind: 'user' }, { keepInbox: true })
          return { kind: 'committed' as const, hostSessionId: String(actual.header.id), activated: true }
        } catch { return { kind: 'committed' as const, hostSessionId: String(actual.header.id), activated: false } }
      })
      return result
    } catch (error) {
      if (prepared !== undefined && !attempt.committed) await this.ports.abandon(envelope, prepared)
      return { kind: attempt.abort.signal.aborted ? 'stale' : 'failed', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Invalidate unpublished work; explicit controls may also stop pending activation without undoing commit. */
  invalidate(projectId: string, mainSessionId: string, reason: string, afterCommit = false): void {
    this.pendingTurns.delete(`${projectId}/${mainSessionId}`)
    this.admission.invalidate(projectId, mainSessionId, reason)
    const attempt = this.attempts.get(`${projectId}/${mainSessionId}`)
    if (attempt !== undefined && afterCommit) this.cancelAttempt(attempt, reason, true)
  }

  /** Close admission before independently waiting for actual owner settlement. */
  async close(): Promise<void> {
    this.closing = true; this.pendingTurns.clear(); this.admission.close()
    for (const attempt of this.attempts.values()) this.cancelAttempt(attempt, 'shutdown', true)
    const settled = await Promise.allSettled([...this.attempts.values()].map(attempt => attempt.done).concat([...this.records.keys()]))
    const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) throw new AggregateError(failures, 'Main continuity shutdown recording was not confirmed.')
  }

  /** Join this Project's original attempts; no new evaluation is created. */
  async suspend(projectId: string): Promise<void> {
    this.suspendedProjects.add(projectId)
    for (const [key, receipt] of this.pendingTurns) if (receipt.projectId === projectId) this.pendingTurns.delete(key)
    const attempts = [...this.attempts.values()].filter(attempt => attempt.envelope.projectId === projectId)
    for (const attempt of attempts) this.invalidate(projectId, attempt.envelope.mainSessionId, 'project lifecycle', true)
    const recordings = [...this.records].filter(([, owner]) => owner === projectId).map(([recording]) => recording)
    const settled = await Promise.allSettled(attempts.map(attempt => attempt.done).concat(recordings))
    const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) throw new AggregateError(failures, 'Main continuity suspension recording was not confirmed.')
  }

  /** Reopen only future normal-turn evaluation after the original lifecycle owner releases its cut. */
  resume(projectId: string): void { this.suspendedProjects.delete(projectId) }
}

/** The attempt owns this waiter, not the main's independent activity or writer. */
async function waitForMainIdle(agent: Agent, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const idle = agent.whenIdle()
  let removeAbort = (): void => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    removeAbort = () => signal.removeEventListener('abort', abort)
    if (signal.aborted) abort()
  })
  // Both late idle success and failure remain observed without cancelling main.
  try { await Promise.race([idle, cancelled]) }
  finally { removeAbort() }
}
