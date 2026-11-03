/** Exact main input responsibility and short publication exclusion. */
import type { ProjectHostOwnership, ProjectMembership } from '../records-types.ts'
import type { MainAdmissionLease } from './types.ts'

interface MainState { unavailable?: true; epoch: number; leases: number; publishing?: Promise<void>; cancel?: (reason: string) => void }

/** Derives identity from committed Store caches; it owns no persistent membership. */
export class MainAdmissionCoordinator {
  private readonly states = new Map<string, MainState>()
  private closing = false
  constructor(private readonly current: (projectId: string, sessionId: string) => ProjectMembership | undefined,
    private readonly ownership: (hostSessionId: string) => ProjectHostOwnership | undefined,
    private readonly ready: (hostSessionId: string) => boolean = () => true) {}

  private state(projectId: string, sessionId: string): MainState {
    const key = `${projectId}/${sessionId}`
    let state = this.states.get(key)
    if (state === undefined) { state = { epoch: 0, leases: 0 }; this.states.set(key, state) }
    return state
  }

  /** Check exact identity before resume or a final synchronous mutation. */
  assertExact(hostSessionId: string, operation = 'input'): void {
    const owner = this.ownership(hostSessionId)
    if (owner === undefined) return
    if (owner.kind === 'preparation') throw new Error('Prepared Session is not accepting business input.')
    if (owner.session.role !== 'main') return
    const state = this.state(owner.project.id, owner.session.id)
    if (!this.ready(hostSessionId) || state.unavailable || this.closing || owner.kind !== 'current' || owner.carrier.closed !== undefined
      || ((owner.project.archived || owner.session.archived) && (operation === 'prompt' || operation === 'send:wake'))
      || state.publishing !== undefined) throw new Error(`Main Session is read-only or temporarily unavailable; current: ${this.current(owner.project.id, owner.session.id)?.session.hostSessionId ?? 'unavailable'}`)
  }

  /** Register accepted work synchronously; current work is never moved by publication. */
  acceptExact(hostSessionId: string, operation: string): MainAdmissionLease | undefined {
    this.assertExact(hostSessionId, operation)
    const owner = this.ownership(hostSessionId)
    if (owner === undefined || owner.kind === 'preparation' || owner.session.role !== 'main') return undefined
    this.invalidate(owner.project.id, owner.session.id, operation)
    const state = this.state(owner.project.id, owner.session.id)
    state.leases += 1
    let released = false
    return { projectId: owner.project.id, sessionId: owner.session.id, hostSessionId, epoch: state.epoch,
      assertCurrent: () => { if (released) throw new Error('Main operation lease was released.'); this.assertExact(hostSessionId, operation) },
      release: () => { if (released) return; released = true; state.leases -= 1 } }
  }

  /** Stable entry waits only for an already committing publication, before resolving its actual host. */
  async acceptCurrent(projectId: string, sessionId: string, operation: string): Promise<MainAdmissionLease> {
    const state = this.state(projectId, sessionId)
    if (state.publishing !== undefined) await state.publishing
    const current = this.current(projectId, sessionId)
    if (current === undefined) throw new Error('Current Project Session is unavailable.')
    const lease = this.acceptExact(current.session.hostSessionId, operation)
    if (lease !== undefined) return lease
    const hostSessionId = current.session.hostSessionId
    let released = false
    return { projectId, sessionId, hostSessionId, epoch: state.epoch,
      assertCurrent: () => { if (released || this.current(projectId, sessionId)?.session.hostSessionId !== hostSessionId) throw new Error('Session identity changed.') },
      release: () => { released = true } }
  }

  /** Capture activity identity without invalidating it. */
  capture(projectId: string, sessionId: string): { epoch: number; hostSessionId: string; leases: number } {
    const state = this.state(projectId, sessionId), current = this.current(projectId, sessionId)
    if (current === undefined) throw new Error('Current main is unavailable.')
    return { epoch: state.epoch, hostSessionId: current.session.hostSessionId, leases: state.leases }
  }

  /** Attach only the live attempt's synchronous invalidation callback. */
  bindAttempt(projectId: string, sessionId: string, cancel: (reason: string) => void): () => void {
    const state = this.state(projectId, sessionId)
    if (state.cancel !== undefined) throw new Error('Main already has an unsettled continuity attempt.')
    state.cancel = cancel
    return () => { if (state.cancel === cancel) delete state.cancel }
  }

  /** New input and control invalidate unpublished work before their first await. */
  invalidate(projectId: string, sessionId: string, reason: string): void {
    const state = this.state(projectId, sessionId)
    state.epoch += 1
    state.cancel?.(reason)
  }

  /** Serialize only final validation, durable CAS and local activation. */
  async withPublication<T>(projectId: string, sessionId: string, epoch: number, run: () => Promise<T>): Promise<T> {
    const state = this.state(projectId, sessionId)
    if (this.closing || state.publishing !== undefined || state.epoch !== epoch || state.leases !== 0) throw new Error('Main publication became stale or has accepted work.')
    const slot = Promise.withResolvers<void>()
    state.publishing = slot.promise
    try { return await run() }
    finally { delete state.publishing; slot.resolve() }
  }

  /** An unknown durable commit closes dependent routing until a Store-based reopen. */
  markUnavailable(projectId: string, sessionId: string): void { this.state(projectId, sessionId).unavailable = true }

  /** Shutdown prevents new attempts and synchronously invalidates the existing ones. */
  close(): void {
    this.closing = true
    for (const state of this.states.values()) { state.epoch += 1; state.cancel?.('shutdown') }
  }
}
