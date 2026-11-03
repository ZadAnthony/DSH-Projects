/** Main-carrier evaluation identities and results; storage remains in its existing owners. */
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { SourceRef } from '../records-types.ts'

/** Exact durable turn identity, independent of display turn numbering. */
export interface SettledTurnKey {
  readonly hostSessionId: string
  readonly sessionCreatedAt: number
  readonly turnStartSeq: number
  readonly turnEndSeq: number
}

/** Program-bound scope of one background decision. */
export interface EvaluationEnvelope {
  readonly attemptId: string
  readonly projectId: string
  readonly mainSessionId: string
  readonly hostSessionId: string
  readonly header: SessionHeader
  readonly turn: SettledTurnKey
  readonly epoch: number
  readonly sessionRevision: number
  readonly configurationRevision: string
  readonly startedAt: number
}

/** Strict final JSON produced by the read-only session manager. */
export interface SessionManagerDecision {
  readonly decision: 'keep' | 'switch'
  readonly reason: string
  readonly continuation: 'same_work' | 'other_work' | null
  readonly evidence: readonly SourceRef[]
}

/** One exact accepted operation; release never moves already accepted native work. */
export interface MainAdmissionLease {
  readonly projectId: string
  readonly sessionId: string
  readonly hostSessionId: string
  readonly epoch: number
  assertCurrent(): void
  release(): void
}

/** Actual publication outcome; a committed relation is never rolled back. */
export type MainCarrierSwitchResult =
  | { readonly kind: 'committed'; readonly hostSessionId: string; readonly activated: boolean }
  | { readonly kind: 'stale' | 'failed'; readonly reason: string }
