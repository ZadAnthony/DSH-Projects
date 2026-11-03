/** Browser-safe saved communication content/continuation DTOs. */
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { CommunicationPartV1, CommunicationRecordLocator, CommunicationSavedPartSource } from './types.ts'
import type { CommunicationFileBlock, CommunicationImageBlock } from './types.ts'
export interface CommunicationAttachmentAccess { readonly block: CommunicationFileBlock | CommunicationImageBlock; readonly readonlyPath: string }

export interface CommunicationContentBudget {
  readonly maxInlineTokens?: number
  estimate(content: readonly ContentBlock[]): number
  /** This execution's canonical successful spill notice, supplied only by the actual retention owner. */
  recoveryContent?(): readonly ContentBlock[] | undefined
}
export interface CommunicationContentRequest {
  readonly record: CommunicationRecordLocator
  readonly snapshot_version: 1
  readonly delivery_id: string
  /** $agent selects the Agent-authored string; all other IDs are saved complete original parts. */
  readonly part_id: string
  readonly cursor?: string
  /** Maximum Unicode code points in this page; defaults to 4096, at most 16384. */
  readonly limit?: number
}
export interface CommunicationContentRange {
  readonly unit: 'unicode-code-points'
  readonly start: number
  readonly end: number
  readonly total: number
}
export interface CommunicationContentPage {
  readonly format: 'projects-communication-content/v1'
  readonly project_id: string
  readonly record: CommunicationRecordLocator
  readonly delivery_id: string
  readonly snapshot_version: 1
  readonly snapshot_identity: string
  readonly part_id: string
  readonly original_speaker: string
  readonly source_chain: CommunicationPartV1['sourceChain']
  /** Concatenate text in range order, then JSON.parse to recover the exact saved string/blocks. */
  readonly encoding: 'canonical-json'
  readonly text: string
  readonly range: CommunicationContentRange
  readonly complete: boolean
  readonly end_of_content: boolean
  readonly same_page_cursor: string
  readonly next_cursor?: string
  readonly attachments: readonly CommunicationAttachmentAccess[]
}
export interface CommunicationContentDirectoryItem {
  readonly part_id: string
  readonly group: 'agent' | 'user-message' | 'context'
  readonly original_speaker: string
  /** Canonical visible-block identity; the cursor separately binds its exact serialized read stream. */
  readonly content_digest: string
  readonly source: CommunicationSavedPartSource
  readonly range: CommunicationContentRange
  readonly read_content: { readonly action: 'read_content' } & CommunicationContentRequest
}
export interface CommunicationContentDirectory {
  readonly format: 'projects-communication-directory/v1'
  readonly delivery_id: string
  readonly snapshot_version: 1
  readonly contents: readonly CommunicationContentDirectoryItem[]
}
