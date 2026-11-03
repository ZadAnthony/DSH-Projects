import type { RootWriteScope } from './metadata-contract.ts'
import type { NativeProjectSource } from './source-types.ts'

export type LibraryTarget =
  | { readonly kind: 'file' | 'directory'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }

export type LibraryFileLocation =
  | { readonly kind: 'project-file'; readonly relativePath: string }
  /** Optional UI reading position inside a directory reference; omission still names the reference root. */
  | { readonly kind: 'reference'; readonly entryId: string; readonly relativePath?: string }

/** 仅为实际位置入口；不是文件之外的成果或提交对象。 */
export interface LibraryEntry {
  readonly id: string
  readonly projectId: string
  readonly name: string
  readonly description: string
  readonly target: LibraryTarget
  readonly ownership: 'project' | 'workspace' | 'external'
  readonly addedBySessionId: string
  readonly sources: readonly NativeProjectSource[]
  readonly sourceLimitations?: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** 可信根由核心提供；Library 不更改 Session cwd 或绕过宿主文件能力。 */
export interface LibraryScope {
  readonly projectId: string
  readonly sessionId: string
  readonly hostSessionId: string
  readonly projectRoot: string
  readonly projectFilesRoot: string
  readonly workingDirectory: string
  readonly workspaceRoot?: string
}

export interface LibrarySessionRequest {
  /** Internal real-tool carrier, never a model-selectable routing field. UI omission uses current. */
  readonly hostSessionId?: string
  readonly projectId: string
  readonly sessionId: string
}

export interface LibraryListRequest extends LibrarySessionRequest {
  readonly directory?: string
}

export interface LibraryAddRequest extends LibrarySessionRequest {
  readonly name: string
  readonly description?: string
  readonly target: LibraryTarget
  readonly sources?: readonly NativeProjectSource[]
}

export interface LibraryEntryRequest extends LibrarySessionRequest {
  readonly entryId: string
}

export interface LibraryOpenRequest extends LibrarySessionRequest {
  readonly location: LibraryFileLocation
}

export interface LibraryDirectoryItem {
  readonly name: string
  readonly type: 'file' | 'directory' | 'other'
  readonly size?: number
}

export interface LibraryNativeFiles {
  readBytes(input: { readonly hostSessionId: string; readonly path: string; readonly signal?: AbortSignal }): Promise<{
    readonly data: Uint8Array
    readonly absolutePath: string
  }>
  /** 外部引用沿用宿主 workspaceFiles.list 的真实目录限制。 */
  listDirectory(input: { readonly hostSessionId: string; readonly path: string; readonly signal?: AbortSignal }): Promise<{
    readonly entries: readonly LibraryDirectoryItem[]
    readonly truncated: boolean
  }>
  /** 核心按可信 projectFilesRoot 在 DSH 执行世界内限定并列目录。 */
  listProjectDirectory(input: { readonly scope: LibraryScope; readonly relativePath: string; readonly signal?: AbortSignal }): Promise<{
    readonly absolutePath: string
    readonly entries: readonly LibraryDirectoryItem[]
    readonly truncated: boolean
  }>
}

export type LibraryFailureReason = 'missing' | 'permissionDenied' | 'tooLarge' | 'unsupported' | 'readFailed'

export type LibraryProjectFiles =
  | { readonly status: 'directory'; readonly relativePath: string; readonly absolutePath: string; readonly entries: readonly LibraryDirectoryItem[]; readonly truncated: boolean; readonly readAt: string }
  | { readonly status: 'unavailable'; readonly relativePath: string; readonly reason: LibraryFailureReason; readonly message: string; readonly readAt: string }

export interface LibraryListing {
  readonly projectFiles: LibraryProjectFiles
  readonly references:
    | { readonly status: 'ready'; readonly entries: readonly LibraryEntry[] }
    | { readonly status: 'unavailable'; readonly message: string }
}

interface LibraryOpenedLocation {
  readonly location: LibraryFileLocation
  readonly name: string
  readonly target: LibraryTarget
}

export type LibraryOpenResult = LibraryOpenedLocation & (
  | { readonly status: 'file'; readonly absolutePath: string; readonly base64: string; readonly mediaType: string; readonly byteLength: number; readonly sha256: string; readonly readAt: string }
  | { readonly status: 'directory'; readonly entries: readonly LibraryDirectoryItem[]; readonly truncated: boolean; readonly readAt: string }
  | { readonly status: 'url'; readonly url: string; readonly availability: 'notChecked' }
  | { readonly status: 'unavailable'; readonly reason: LibraryFailureReason; readonly message: string; readonly readAt: string }
)

export interface LibraryCorePort {
  /** 以原项目/source owner 为准；已永久失效的项目或会话不得再取得 scope。 */
  resolveScope(request: LibrarySessionRequest, signal?: AbortSignal): Promise<LibraryScope>
  verifySources(scope: LibraryScope, sources: readonly NativeProjectSource[], signal?: AbortSignal): Promise<void>
  /** Production Core revalidates current carrier/lifecycle and retained sources in the shared metadata transaction. */
  withMetadataWrite<T>(request: LibrarySessionRequest, prepared: LibraryScope, sources: readonly NativeProjectSource[], action: (scope: RootWriteScope) => Promise<T>, signal?: AbortSignal): Promise<T>
}

/** 仅供原项目删除事务持有；不是另一份持久删除状态。 */
export interface LibraryProjectDeletion {
  readonly drained: Promise<void>
  /** 原 source 永久提交确认后调用；调用方须先确认 drained 成功。 */
  commit(): void
  /** 仅在原 source 确认未提交时解除本次临时停止接纳。 */
  release(): void
}

export interface LibraryClientActions {
  list(request: LibraryListRequest, signal?: AbortSignal): Promise<LibraryListing>
  add(request: LibraryAddRequest): Promise<LibraryEntry>
  open(request: LibraryOpenRequest, signal?: AbortSignal): Promise<LibraryOpenResult>
  remove(request: LibraryEntryRequest): Promise<void>
}
