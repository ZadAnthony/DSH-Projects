import type { ToolBatchInput } from '@deepseek-ai/dsh-tools'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ProjectDriverPersistence } from '../request/dispatch.ts'

/** Private Projects delivery protocol; never adds capabilities to arbitrary executors. */
export const PROJECT_STREAM_TOOL_BATCH = Symbol('projects.stream-tool-batch')
export interface ProjectStreamingToolBatchInput extends ToolBatchInput {
  readonly [PROJECT_STREAM_TOOL_BATCH]: {
    readonly persistence: ProjectDriverPersistence
    readonly acceptContext: (context: UserMessage) => void
  }
}
export interface ProjectStreamingToolBatchResult {
  readonly kind: 'projects-streamed'
  readonly concluded: boolean
}
export function isProjectStreamingToolBatch(input: ToolBatchInput): input is ProjectStreamingToolBatchInput {
  return PROJECT_STREAM_TOOL_BATCH in input
}
