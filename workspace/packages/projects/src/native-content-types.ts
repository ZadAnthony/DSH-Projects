/** Browser-safe bounded native body reads; body and message-list cursors are distinct. */
import type { NativeEventSource } from './source-reference-types.ts'
import type { CommunicationFileBlock, CommunicationImageBlock } from './communication/types.ts'
export interface NativeContentRange {
  readonly unit: 'unicode-code-points'
  readonly start: number
  readonly end: number
  readonly total: number
}
/** A verified access entry, not delivery of the attachment body or unshown message text. */
export type NativeContentAttachmentAccess = {
  readonly block: CommunicationFileBlock | CommunicationImageBlock
  readonly descriptor_range: NativeContentRange
} & (
  | { readonly status: 'available'; readonly readonlyPath: string }
  | { readonly status: 'unavailable'; readonly reason: string }
)
export interface NativeContentRequest {
  readonly source: NativeEventSource
  readonly cursor?: string
  readonly limit?: number
}
export interface NativeContentPage {
  readonly format: 'projects-native-content/v1'
  readonly project_id: string
  readonly source: NativeEventSource
  readonly encoding: 'canonical-json'
  readonly text: string
  readonly range: NativeContentRange
  readonly selected_range: { readonly start: number; readonly end: number }
  readonly complete: boolean
  readonly end_of_content: boolean
  readonly end_of_selection: boolean
  readonly same_page_cursor: string
  readonly next_cursor?: string
  readonly attachments?: readonly NativeContentAttachmentAccess[]
  readonly attachment_access_notice?: string
}
