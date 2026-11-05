/** 项目模块共用的只读身份、原生来源与文件能力；不提供业务台账写入。 */
import type { NativeProjectSource, NativeProjectSourceItem, NativeProjectSourceRead } from './source-types.ts'
import type { Project, ProjectSession, ProjectSessionRole, ProjectSnapshot } from './records-types.ts'
import type { CommunicationVisibleBlock } from './communication/types.ts'

export type ProjectsCoreErrorCode = 'PROJECT_CORE_MISSING_PROJECT' | 'PROJECT_CORE_MISSING_SESSION'
  | 'PROJECT_CORE_FOREIGN_SOURCE' | 'PROJECT_CORE_UNAVAILABLE_SOURCE' | 'PROJECT_CORE_NOT_ORIGINAL_USER'
  | 'PROJECT_CORE_FILE_SCOPE_UNAVAILABLE'
export interface ProjectCoreProjectView {
  readonly project: Project
  readonly snapshot: ProjectSnapshot
  readonly projectRoot: string
  readonly projectFilesRoot: string
  readonly configuredWorkspace?: string
}
export interface ProjectCoreSessionScope extends ProjectCoreProjectView {
  readonly session: ProjectSession
  readonly hostSessionId: string
  readonly role: ProjectSessionRole
  readonly workingDirectory: string
  readonly workspaceRoot: string
}
export interface ProjectCoreToolScope extends ProjectCoreSessionScope {
  readonly invocationSources: readonly NativeProjectSource[]
}
export interface ProjectCoreSourceRead {
  readonly projectId: string
  readonly source: NativeProjectSource
  readonly readable: boolean
  readonly isUserDecision: boolean
  readonly producer?: string
  readonly text?: string
  readonly reason?: string
  readonly code?: NonNullable<NativeProjectSourceRead['code']>
  readonly nativeItems?: readonly NativeProjectSourceItem[]
  readonly partial?: true
  readonly limitations?: readonly string[]
}
export interface ProjectCoreOriginalUser {
  readonly source: Extract<NativeProjectSource, { readonly kind: 'message' | 'native-event' }>
  readonly quote: string
  readonly time: string
  readonly sessionId: string
  readonly visibleBlocks?: readonly CommunicationVisibleBlock[]
}
export interface ProjectCoreFileBytes { readonly data: Uint8Array; readonly absolutePath: string }
export interface ProjectCoreDirectoryItem { readonly name: string; readonly type: 'file' | 'directory' | 'other'; readonly size?: number }
export interface ProjectCoreDirectoryListing { readonly entries: readonly ProjectCoreDirectoryItem[]; readonly truncated: boolean }
export interface ProjectCoreSettingsUser { readonly projectId: string; readonly projectDirectory: string; readonly actorId: 'project-settings-user' }
