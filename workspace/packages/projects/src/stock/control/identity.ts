import { isDeepStrictEqual } from 'node:util'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'

/** Compare the complete immutable creation metadata, never an id string alone. */
export function sameOwnedCreationHeader(a: SessionHeader, b: SessionHeader): boolean { return isDeepStrictEqual(a, b) }

/** The exact creation rollback retains queued input when coordination did not commit. */
export class PendingInputCoordinationError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'PendingInputCoordinationError' }
}
export interface OwnedSubagentMember {
  readonly header: SessionHeader
  readonly parentSessionId: SessionId
  readonly mode: 'one-shot' | 'continuable'
  readonly provider?: string
}
export interface OwnedRetirementOptions { retire(id: SessionId, handle: AgentHandle): Promise<void> }
export interface OwnedRetirement { readonly drained: Promise<readonly OwnedSubagentMember[]>; release(): void; commit(): void }
export interface OwnedQuiescence {
  readonly drained: Promise<readonly OwnedSubagentMember[]>
  stopKnown(): void
  release(): void
  handoffRetirement(id: SessionId, options: OwnedRetirementOptions): OwnedRetirement | undefined
}

/** A held kernel writer lease and local creation cut for one proven absent carrier. */
export interface ProjectAbsentCarrierProof { readonly id: SessionId; assertCurrent(): void; release(): Promise<void> }
