import type { ProjectDetail, ProjectNativeSourceRead, ProjectNavigationTarget } from '../public-types.ts'
import type { NativeProjectSource } from '../source-types.ts'

/** One actual file gesture; opening it does not declare authorship or create a Library reference. */
export interface ProjectConversationFileRequest {
  readonly id: number
  readonly projectId: string
  readonly sessionId: string
  readonly hostSessionId: string
  readonly role: 'main' | 'execution'
  readonly sessionTitle: string
  readonly path: string
  readonly line?: number | undefined
  /** Project screen lifetime, independent of the originating Chat's visible mount. */
  readonly signal: AbortSignal
}

/** An actual bounded native text page, without claims about complete file bytes or authorship. */
export interface ProjectConversationFilePage {
  readonly absolutePath: string
  readonly version: string
  readonly bytes?: number | undefined
  readonly offset: number
  readonly text: string
  readonly lines: number
  readonly eof: boolean
  readonly readAt: string
}

/** Read one native file page in the original Session's filesystem scope. */
export type ReadConversationFile = (
  request: ProjectConversationFileRequest,
  options?: { readonly offset?: number | undefined },
  signal?: AbortSignal,
) => Promise<ProjectConversationFilePage>

/**
 * Derive chat coordinates only from an exact successful source read.
 * Historical carriers remain precise read-only sources rather than current-chat coordinates.
 */
export function projectSourceNavigation(
  detail: ProjectDetail,
  source: NativeProjectSource,
  read: Pick<ProjectNativeSourceRead, 'items'>,
): ProjectNavigationTarget | undefined {
  const item = read.items.find(row => {
    if (!row.isTarget) return false
    if (row.nativeSource !== undefined && row.nativeSource.hostSessionId !== source.hostSessionId) return false
    if (source.kind === 'message') return row.messageId === source.messageId
      || row.nativeSource?.kind === 'message' && row.nativeSource.messageId === source.messageId
    if (source.kind === 'tool') return row.toolCallId === source.toolCallId
      || row.nativeSource?.kind === 'tool' && row.nativeSource.toolCallId === source.toolCallId
    const actual = row.nativeSource?.kind === 'native-event' ? row.nativeSource : row.bodySource
    return actual !== undefined && row.seq === source.eventSeq && actual.hostSessionId === source.hostSessionId
      && actual.projectId === source.projectId && actual.sessionId === source.sessionId
      && actual.sessionCreatedAt === source.sessionCreatedAt && actual.eventSeq === source.eventSeq
      && actual.eventType === source.eventType && actual.eventDigest === source.eventDigest
      && actual.eventSpace.formatVersion === source.eventSpace.formatVersion
      && (source.messageId === undefined || row.messageId === source.messageId)
      && (source.toolCallId === undefined || row.toolCallId === source.toolCallId)
  })
  if (item === undefined) return undefined
  const exact = item.nativeSource?.kind === 'native-event' ? item.nativeSource
    : item.bodySource ?? (source.kind === 'native-event' ? source : undefined)
  const session = detail.sessions.find(row => row.hostSessionId === source.hostSessionId
    || row.carriers?.some(carrier => carrier.hostSessionId === source.hostSessionId))
  if (session === undefined || detail.unavailableSources.some(row => row.hostSessionId === source.hostSessionId)) return undefined
  if (session.role !== 'main' && session.role !== 'execution') return undefined
  if (session.hostSessionId === source.hostSessionId) {
    const carrier = session.carriers?.find(row => row.isCurrent && row.hostSessionId === session.hostSessionId)
    if (exact !== undefined && (exact.hostSessionId !== source.hostSessionId || exact.projectId !== detail.project.id
      || exact.sessionId !== session.id || carrier !== undefined && carrier.sessionCreatedAt !== exact.sessionCreatedAt)) return undefined
    return { kind: session.role, sessionId: session.id, focusEventSeq: item.seq,
      ...(item.messageId === undefined ? {} : { focusMessageId: item.messageId }) }
  }
  if (exact === undefined || exact.hostSessionId !== source.hostSessionId
    || exact.projectId !== detail.project.id || exact.sessionId !== session.id) return undefined
  return { kind: session.role, sessionId: session.id, source: exact }
}
