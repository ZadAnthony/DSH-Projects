/** Browser-safe Projects UI DTOs. Every write captures a physical Session id. */
import type {
  SessionCancelRequest, SessionPromptRequest, SessionRenameRequest, SessionSelectModelRequest,
  SessionUpdateQueueRequest,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { PromptContentPart, FileAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import type { WorkspaceChangedFile } from '@deepseek-ai/dsh-workspace-changes/types'
import type { JobKillRequest } from '@deepseek-ai/dsh-api-job-controller/types'
import type { WorkspaceFileRange, WorkspaceByteReadOptions } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { CommandSubmitAttachment } from '@deepseek-ai/dsh-commands/types'
import type { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'

/** Selectable native permission data copied structurally at the Projects wire boundary. */
export interface ProjectUiPermissionOption { value: string; name: string; description?: string }
export interface ProjectUiPermissionCatalog {
  options: ProjectUiPermissionOption[]
  defaultOptions: ProjectUiPermissionOption[]
  defaultPreset: string
}
export interface ProjectUiAgentPresetRow {
  readonly id: string
  readonly isDefault: boolean
  readonly name?: string
  readonly description?: string
  readonly broken?: string
}
export interface ProjectUiAgentPresetRoster { readonly presets: readonly ProjectUiAgentPresetRow[] }

/** Read-only graph publication state shared with the Projects root presentation. */
export interface ProjectUiConfigurationStatus {
  readonly warnings: readonly string[]
  readonly revision: number
  readonly publication: {
    readonly status: 'published' | 'unchanged' | 'failed'
    readonly presetId: string
    readonly generation?: string
    readonly error?: string
  } | null
}

/** ReaderDomain must carry this field; Host schemas retain it. */
export interface ProjectUiCarrierAddress {
  readonly projectId: string
  readonly logicalSessionId: string
  readonly hostSessionId: string
  readonly sessionCreatedAt: number
  readonly carrierEpoch: number
}
/** Projection-only reads retain the Reader's adopted native creation identity. */
export interface ProjectUiProjectionsRequest {
  readonly sessionId: SessionId
  readonly expectedCreatedAt?: number
}

export interface ProjectUiAccess {
  readonly readonly?: boolean
  readonly carrier?: ProjectUiCarrierAddress
}
export type ProjectUiPromptRequest = SessionPromptRequest & ProjectUiAccess
export type ProjectUiCancelRequest = SessionCancelRequest & ProjectUiAccess
export type ProjectUiUpdateQueueRequest = SessionUpdateQueueRequest & ProjectUiAccess
export type ProjectUiSelectModelRequest = SessionSelectModelRequest & ProjectUiAccess
export type ProjectUiRenameRequest = SessionRenameRequest & ProjectUiAccess
export interface ProjectUiTarget extends ProjectUiAccess { readonly sessionId: SessionId }
export interface ProjectUiQueryRequest extends ProjectUiTarget { readonly query: string }
export interface ProjectUiCommandRequest extends ProjectUiTarget {
  readonly line: string
  readonly attachments: readonly CommandSubmitAttachment[]
}
/** Projects owns this JSON wire shape; native upload's internal DTO is not a public generator export. */
export interface ProjectUiUploadRequest extends ProjectUiTarget {
  readonly data: string
  readonly name?: string
}
/** Projects-owned upload receipt shape; authority remains the real native backend receipt. */
export interface ProjectUiUploadValue {
  readonly receiptId: Branded<'file-upload-receipt-id'>
  readonly file: FileAttachmentRef
}
export interface ProjectUiQuestionRequest extends ProjectUiTarget { readonly callId: ToolCallId }
export interface ProjectUiQuestionAnswerRequest extends ProjectUiQuestionRequest { readonly answer: AskUserQuestionAnswer }
export interface ProjectUiPlanRequest extends ProjectUiTarget { readonly active: boolean }
export type ProjectUiPendingInteraction = {
  readonly sessionId: SessionId
  readonly requestId: string
} & ({
  readonly kind: 'approval'
  readonly toolName: string
  readonly callId?: ToolCallId
  readonly reason?: string
  readonly displayReason?: { readonly en: string; readonly [locale: string]: string }
} | {
  readonly kind: 'question'
  readonly questions: readonly AskUserQuestionItem[]
  readonly wait?: { readonly callId: ToolCallId; readonly timed?: boolean }
})
export type ProjectUiInteractionFrame =
  | { readonly type: 'baseline'; readonly items: readonly ProjectUiPendingInteraction[] }
  | { readonly type: 'pending'; readonly item: ProjectUiPendingInteraction }
  | { readonly type: 'settled'; readonly sessionId: SessionId; readonly requestId: string }
export type ProjectUiInteractionResponse = ProjectUiTarget & { readonly requestId: string } & (
  | { readonly kind: 'approval'; readonly outcome: ApprovalOutcome }
  | { readonly kind: 'question'; readonly answer: AskUserQuestionAnswer }
  | { readonly kind: 'dismiss' }
  | { readonly kind: 'timeout' }
)

export interface ProjectUiFileRequest extends ProjectUiTarget { readonly path: string }
export interface ProjectUiFileReadRequest extends ProjectUiFileRequest { readonly range: WorkspaceFileRange }
export interface ProjectUiFileBytesRequest extends ProjectUiFileRequest { readonly options: WorkspaceByteReadOptions }

/** Exact native address shape owned by Projects' wire boundary. */
export interface ProjectUiSubagentAddress {
  readonly parentSessionId: SessionId
  readonly childSessionId: SessionId
  readonly mode: 'one-shot' | 'continuable' | 'unknown'
}
export interface ProjectUiSubagentPromptRequest extends ProjectUiAccess {
  readonly requestId: Branded<'session-request-id'>
  readonly parentSessionId: SessionId
  readonly childSessionId: SessionId
  readonly mode: 'continuable'
  readonly delivery: 'queue' | 'steer'
  readonly content: readonly PromptContentPart[]
  readonly clientTimeZone?: string
}
export interface ProjectUiSubagentPromptReceipt { readonly messageId: MessageId }
export interface ProjectUiSubagentInterruptReceipt { readonly accepted: true }
export interface ProjectUiSubagentInterruptRequest extends ProjectUiAccess {
  readonly childSessionId: SessionId
  readonly parentSessionId: SessionId
  readonly mode: 'continuable'
}
export interface ProjectUiSubagentInfo {
  readonly address: ProjectUiSubagentAddress
  readonly sessionCreatedAt: number
}

export type ProjectUiJobKillRequest = JobKillRequest & ProjectUiAccess

export interface ProjectUiAgentPresetSelectRequest extends ProjectUiTarget { readonly preset: string }

export interface ProjectUiChangesRequest extends ProjectUiTarget { readonly seq: number }
export interface ProjectUiChangesDiffRequest extends ProjectUiChangesRequest { readonly index: number }
export interface ProjectUiChangesSummary {
  readonly turn: number
  readonly files: readonly WorkspaceChangedFile[]
  readonly total: number
  readonly added: number
  readonly deleted: number
}
