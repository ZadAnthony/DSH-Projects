/** Exact physical carrier identity captured before asynchronous input work. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { FileUploadService } from '@deepseek-ai/dsh-client-file-upload/client'

export interface CarrierAddress {
  readonly projectId: string
  readonly logicalSessionId: string
  readonly hostSessionId: string
  readonly sessionCreatedAt: number
  readonly carrierEpoch: number
}

export type UploadArguments = Parameters<FileUploadService['upload']>

export interface ProjectDraftPorts {
  /** Resolves this binding, never the latest selected session. */
  resolveCarrier(binding: SessionBinding): CarrierAddress
  /** Checks exact creation and epoch, including permanent deletion. */
  isCurrent(address: CarrierAddress): boolean
  /** Projects attachment owner; never a root upload receipt. */
  upload?(address: CarrierAddress, data: UploadArguments[1], name?: UploadArguments[2],
    signal?: UploadArguments[3], onProgress?: UploadArguments[4]): ReturnType<FileUploadService['upload']>
}

export interface CarrierLease {
  readonly address: CarrierAddress
  readonly ctx: Context
  readonly signal: AbortSignal
  assertCurrent(): void
  release(): void
}

export function sameCarrier(left: CarrierAddress, right: CarrierAddress): boolean {
  return left.projectId === right.projectId && left.logicalSessionId === right.logicalSessionId
    && left.hostSessionId === right.hostSessionId && left.sessionCreatedAt === right.sessionCreatedAt
    && left.carrierEpoch === right.carrierEpoch
}

export function logicalDraftKey(address: Pick<CarrierAddress, 'projectId' | 'logicalSessionId'>): string {
  return JSON.stringify([address.projectId, address.logicalSessionId])
}

export function freezeCarrier(address: CarrierAddress): CarrierAddress {
  if (!address.projectId || !address.logicalSessionId || !address.hostSessionId
    || !Number.isFinite(address.sessionCreatedAt) || !Number.isSafeInteger(address.carrierEpoch) || address.carrierEpoch < 0) {
    throw new Error('PROJECT_INPUT_INVALID_CARRIER: a confirmed physical creation and carrier epoch are required')
  }
  return Object.freeze({ ...address })
}
