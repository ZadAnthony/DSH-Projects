import type { Session, SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ProjectSessionOwner } from './codec.ts'

export interface ProjectPayloadOwner extends ProjectSessionOwner { readonly carrierId: SessionId; readonly createdAt: number }
export interface ProjectPayloadReference {
  readonly kind: 'projects-payload'; readonly version: 1; readonly codec: string
  readonly id: string; readonly digest: string; readonly bytes: number; readonly owner: ProjectPayloadOwner
  readonly inheritedFrom?: { readonly carrierId: SessionId; readonly createdAt: number; readonly seq: number; readonly eventDigest: string; readonly payloadDigest: string }
}
export interface ProjectLegacyRecordReference {
  readonly kind: 'projects-legacy-record'; readonly version: 1; readonly codec: string
  readonly owner: ProjectPayloadOwner; readonly seq: number; readonly type: string; readonly time: number
  readonly byteStart: number; readonly byteEnd: number; readonly rawLineDigest: string; readonly eventDigest: string
}
export type ProjectPayloadRef = ProjectPayloadReference | ProjectLegacyRecordReference
export interface ProjectRecordLocator {
  readonly seq: number; readonly type: string; readonly time: number
  readonly byteStart: number; readonly byteEnd: number; readonly rawLineDigest: string; readonly eventDigest: string
  readonly facts: Readonly<Record<string, string | number | boolean>>
  readonly sourceEventSeqs?: readonly number[]
  readonly inboxMetadata?: { readonly inserted: readonly { readonly id: string; readonly sourceKind: string; readonly sourceForm?: string; readonly deliveryId?: string }[] }
}
export interface ProjectRecordDirectory {
  readonly header: SessionHeader; readonly owner: ProjectSessionOwner; readonly inheritedEventCount: SessionLogOffset
  readonly revision: string; readonly journalIdentity: string; readonly nextSeq: number; readonly byteEnd: number
  readonly records: readonly ProjectRecordLocator[]
}
/** A fact about an owner-confirmed prefix, never an authorization or an event body. */
export interface CommittedRange {
  readonly header: SessionHeader; readonly owner: ProjectSessionOwner; readonly inheritedEventCount: SessionLogOffset
  readonly journalIdentity: string; readonly epoch: string; readonly nextSeq: number; readonly byteEnd: number
  readonly commitId: string; readonly revision: string; readonly proof: 'writer-fsync'
}
export interface ProjectRangeOptions { readonly signal?: AbortSignal; readonly through?: CommittedRange }
export type ProjectRunTransform = (event: SessionEvent, original: ProjectLegacyRecordReference) => SessionEvent
/** Synchronous run-event consumption at an issued exact cut, without retaining a complete seed. */
export interface ProjectRunVisitorOptions extends ProjectRangeOptions {
  readonly through: CommittedRange
  readonly visit: (event: SessionEvent) => void
}
export interface ProjectWriterRoute {
  readonly session: Session
  fail(error: unknown): void
  acknowledgeThrough(targetNext: number, signal?: AbortSignal): Promise<void>
  confirmThrough(targetNext: number, signal?: AbortSignal): Promise<CommittedRange>
}
