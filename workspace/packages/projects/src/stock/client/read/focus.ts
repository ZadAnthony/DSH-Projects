/** Exact source focus. A nearby event is never a successful location. */
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionFace, SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatSnapshot } from '../compat/chat/client/contract/snapshot.ts'
import type { ChatNode } from '../compat/chat/client/contract/chat-nodes.ts'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { NativeProjectSource, NativeProjectSourceRead, NativeProjectSourceItem, NativeEventSource } from '../../../source-types.ts'
import { assertProjectFileBinding, sameProjectFileBinding, type ProjectFileBinding } from './file-reader.ts'
import { canonicalSourceJson } from '../../../native-source.ts'
import { projectSha256 } from './sha256.ts'

export interface ProjectFocusRequest {
  readonly binding: ProjectFileBinding
  /** Explicit public native generation when live and read domains show the same carrier. */
  readonly nativeBinding?: SessionBinding
  readonly source: NativeProjectSource
  /** The exact backend read result, not a client-generated excerpt. */
  readonly read: NativeProjectSourceRead
}
export interface ProjectFocusTarget {
  readonly nodeKey: string
  readonly callId?: string
  readonly turn?: number
  readonly answerStep?: number
}
export interface ProjectFocusView {
  readonly binding: ProjectFileBinding
  readonly nativeBinding: SessionBinding
  readonly session: SessionFace
  readonly current: () => boolean
  readonly snapshot: () => ChatSnapshot
  readonly reveal: (target: ProjectFocusTarget, signal: AbortSignal) => Promise<void>
  readonly events: SessionBinding['eventSource']
  readonly clear?: () => void
}
export type ProjectFocusState = { readonly phase: 'idle' | 'loading' | 'focused' | 'failed'; readonly reason?: string }

function fail(reason: string): never { throw new Error(`PROJECT_SOURCE_FOCUS_FAILED: ${reason}`) }
/** Same lossless canonical event digest minted by the backend, computed on browser bytes. */
export async function projectNativeEventDigest(event: unknown): Promise<string> {
  return 'sha256:' + projectSha256(new TextEncoder().encode(canonicalSourceJson(event)))
}
function exactSource(request: ProjectFocusRequest): { item: NativeProjectSourceItem; exact: NativeEventSource } {
  assertProjectFileBinding(request.binding)
  const { source, read, binding } = request
  if (!read.resolved || read.hostSessionId !== binding.hostSessionId || source.hostSessionId !== binding.hostSessionId) fail(read.reason ?? 'source was not resolved in the original session')
  const candidates = read.items.filter(item => item.isTarget)
  const item = source.kind === 'message' ? candidates.find(item => item.messageId === source.messageId)
    : source.kind === 'tool' ? candidates.find(item => item.toolCallId === source.toolCallId)
      : candidates.find(item => item.seq === source.eventSeq)
  if (item === undefined) fail('the exact requested source is absent')
  const exact = item.nativeSource?.kind === 'native-event' ? item.nativeSource : item.bodySource
  if (exact === undefined || exact.projectId !== binding.projectId || exact.sessionId !== binding.sessionId
    || exact.hostSessionId !== binding.hostSessionId || exact.sessionCreatedAt !== binding.sessionCreatedAt) fail('source identity no longer matches the Project carrier')
  if (source.kind === 'native-event' && (source.eventSeq !== exact.eventSeq || source.eventType !== exact.eventType
    || source.eventDigest !== exact.eventDigest || source.sessionCreatedAt !== exact.sessionCreatedAt
    || source.projectId !== exact.projectId || source.sessionId !== exact.sessionId
    || source.eventSpace.formatVersion !== exact.eventSpace.formatVersion
    || source.messageId !== undefined && source.messageId !== (exact.messageId ?? item.messageId)
    || source.toolCallId !== undefined && source.toolCallId !== (exact.toolCallId ?? item.toolCallId))) fail('source coordinates changed')
  if (item.seq !== exact.eventSeq) fail('backend target and exact event position disagree')
  return { item, exact }
}

function callStart(event: { readonly type: string; readonly data: unknown }, callId: string): boolean {
  const data = event.data as { readonly callId?: string; readonly subCallId?: string }
  return event.type === 'tool/call' && data.callId === callId
    || event.type === 'tool/ptc-dispatch-start' && data.subCallId === callId
}

function containsCall(block: ToolCallBlock, callId: string): boolean {
  return block.callId === callId || block.subCalls.some(child => containsCall(child, callId))
}

/** Resolve only exact durable identity or exact verified event position. */
export function resolveProjectFocusTarget(snapshot: ChatSnapshot, item: NativeProjectSourceItem, exact: NativeEventSource): ProjectFocusTarget {
  const messageId = exact.messageId ?? item.messageId
  const callId = exact.toolCallId ?? item.toolCallId
  for (const key of snapshot.order) {
    const node = snapshot.nodes.get(key) as ChatNode | undefined
    if (node === undefined) continue
    const data = node.data as { readonly seq?: number; readonly messageId?: string; readonly finalNode?: { readonly seq: number; readonly messageId?: string }; readonly root?: ToolCallBlock }
    const hit = callId !== undefined ? node.kind === 'tool-call' && data.root !== undefined && containsCall(data.root, callId)
      : messageId !== undefined ? data.messageId === messageId || data.finalNode?.messageId === messageId
        : data.seq === exact.eventSeq || data.finalNode?.seq === exact.eventSeq
    if (!hit) continue
    // Stable message ids alone still need the returned event's exact seq; a duplicated id cannot redirect focus.
    if (callId === undefined && data.seq !== exact.eventSeq && data.finalNode?.seq !== exact.eventSeq) continue
    const process = snapshot.nodes.processSource(key).getSnapshot()
    const location = node.location
    const turn = location.kind === 'turn' || location.kind === 'step' ? location.turn.turn : undefined
    return { nodeKey: key, ...(callId === undefined ? {} : { callId }),
      ...(turn === undefined ? {} : { turn }), ...(process?.spec.answerStep == null ? {} : { answerStep: process.spec.answerStep }) }
  }
  return fail('the loaded native Chat contains no exact message or tool invocation')
}

export class ProjectFocusOwner {
  readonly state = createSnapshotStore<ProjectFocusState>({ phase: 'idle' })
  private readonly views = new Set<ProjectFocusView>()
  private abort: AbortController | undefined

  register(view: ProjectFocusView): () => void { this.views.add(view); return () => { this.views.delete(view) } }

  async focus(request: ProjectFocusRequest, signal?: AbortSignal): Promise<void> {
    this.abort?.abort(); const abort = new AbortController(); this.abort = abort
    for (const view of this.views) view.clear?.()
    const combined = signal === undefined ? abort.signal : AbortSignal.any([signal, abort.signal])
    this.state.set({ phase: 'loading' })
    try {
      const { item, exact } = exactSource(request)
      const candidates = [...this.views].filter(view => sameProjectFileBinding(view.binding, request.binding) && view.current()
        && (request.nativeBinding === undefined || view.nativeBinding === request.nativeBinding))
      if (candidates.length > 1) fail('multiple domains show this source; its exact native binding is required')
      const view = candidates[0]
      if (view === undefined) fail('the original conversation is not mounted')
      combined.throwIfAborted()
      await view.session.loadThrough(SessionSeq(exact.eventSeq))
      combined.throwIfAborted()
      if (!view.current() || !this.views.has(view)) fail('the source view was replaced while loading')
      const event = view.events.getSnapshot().entries.find(entry => entry.event.seq === exact.eventSeq)?.event
      if (event === undefined || event.type !== exact.eventType) fail('the exact source event was not loaded')
      if (await projectNativeEventDigest(event) !== exact.eventDigest) fail('the original source event content changed')
      combined.throwIfAborted()
      // Native user nodes may not publish messageId, but the exact raw event always must.
      const raw = event.data as { readonly id?: string; readonly message?: { readonly id?: string; readonly source?: { readonly callId?: string } }; readonly callId?: string; readonly subCallId?: string }
      const messageId = raw.message?.id ?? raw.id
      if ((exact.messageId ?? item.messageId) !== undefined && messageId !== (exact.messageId ?? item.messageId)) fail('native source message identity changed')
      if (item.messageId !== undefined && exact.messageId !== undefined && item.messageId !== exact.messageId) fail('backend target message identity changed')
      let loadSeq = exact.eventSeq
      if (item.toolCallId !== undefined || exact.toolCallId !== undefined) {
        const callId = exact.toolCallId ?? item.toolCallId!
        if (item.toolCallId !== undefined && exact.toolCallId !== undefined && item.toolCallId !== exact.toolCallId) fail('backend target tool identity changed')
        const eventCallId = event.type === 'tool/result' ? raw.message?.source?.callId
          : event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch' ? raw.subCallId : raw.callId
        if (eventCallId !== callId) fail('the source event belongs to a different tool invocation')
        const entries = view.events.getSnapshot().entries
        const start = entries.find(entry => callStart(entry.event, callId))
        // A tool/result might be loaded before its call. Load through its containing Turn start, then require real call evidence.
        if (start === undefined) {
          const turnStart = [...entries].reverse().find(entry => entry.event.seq < exact.eventSeq && entry.event.type === 'turn/start')
          if (turnStart !== undefined) loadSeq = turnStart.event.seq
          else loadSeq = 0
          await view.session.loadThrough(SessionSeq(loadSeq))
          combined.throwIfAborted()
        }
        const actual = view.events.getSnapshot().entries.find(entry => callStart(entry.event, callId))
        if (actual === undefined) fail('the actual tool invocation start is unavailable')
      }
      if (!view.current() || !this.views.has(view)) fail('source scope expired')
      await view.reveal(resolveProjectFocusTarget(view.snapshot(), item, exact), combined)
      combined.throwIfAborted()
      this.state.set({ phase: 'focused' })
    } catch (error) {
      if (this.abort === abort) this.state.set({ phase: 'failed', reason: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }
  cancel(): void { this.abort?.abort(); this.abort = undefined; for (const view of this.views) view.clear?.(); this.state.set({ phase: 'idle' }) }
  dispose(): void { this.cancel(); this.views.clear() }
}
