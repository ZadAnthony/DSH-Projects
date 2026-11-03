/** Published stock workspace change values, transported by Projects private ports. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceChangesSummary, WorkspaceFileDiff } from '@deepseek-ai/dsh-workspace-changes/types'

export type ChangesSummary = Pick<WorkspaceChangesSummary, 'turn' | 'files' | 'total' | 'added' | 'deleted'>
export type ChangesDiff = WorkspaceFileDiff

export interface ProjectChangedFilesPorts {
  readonly summary: (sessionId: SessionId, seq: number, signal?: AbortSignal) => Promise<ChangesSummary | undefined>
  readonly diff: (sessionId: SessionId, seq: number, index: number, signal?: AbortSignal) => Promise<ChangesDiff | undefined>
  /** Original Session and original path route to the real Projects unified FileReader. */
  readonly openFile: (sessionId: SessionId, path: string, options?: { readonly line?: number }) => void | Promise<void>
}
