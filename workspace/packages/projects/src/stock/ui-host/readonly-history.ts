/** Stock history template, fixed source and local change: see SOURCES.md. */
/** Cold Session history pagination and live-event source. */

import type { Context } from '@deepseek-ai/cordis'
import { Deque } from '@deepseek-ai/dsh-deque'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import {
  SessionLogOffset,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
import type {
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionLogOffset as SessionLogOffsetType,
  SessionSeqCursor,
} from '@deepseek-ai/dsh-session'
import type { ProjectDirectoryObservation } from '../read/index.ts'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-subagent'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  SessionAddress,
  SessionAssistantStreamBaseline,
  SessionAssistantStreamFrame,
  SessionEventEntry,
  SessionFollowRequest,
  SessionFollowFrame,
  SessionPage,
  SessionPageRequest,
  SessionProjectionBaseline,
  SessionProjectionsValue,
  SessionWireHeader,
  SessionWireEvent,
} from '@deepseek-ai/dsh-api-session-controller/types'
import { SessionAssistantStreamAccumulator } from './assistant-stream.ts'
import { projectUiHistoryEvent } from './history-wire.ts'
import type { ProjectUiProjectionsRequest } from './types.ts'
import { uiHistoryEvents, uiHistoryWindow, uiHistoryProjections } from './history-observation.ts'

const DEFAULT_MAX_MESSAGES = 50

/** Implements cold-safe history operations delegated by the Session Controller. */
export class ReadonlySessionHistoryController {
  private readonly closeFollowers = new Set<() => void>()
  private readonly assistantStreams = new Map<SessionId, SessionAssistantStreamAccumulator>()

  /**
   * @param ctx - Host context carrying Projects reads and native projections.
   */
  constructor(
    private readonly ctx: Context,
  ) {
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      let stream = this.assistantStreams.get(agent.session.id)
      if (stream === undefined) {
        stream = new SessionAssistantStreamAccumulator()
        this.assistantStreams.set(agent.session.id, stream)
      }
      stream.accept(frame, cursorBeforeNext(agent.session.seq))
    }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => {
      this.assistantStreams.delete(agent.session.id)
    }, { global: true })
    ctx.effect(() => () => {
      for (const close of this.closeFollowers) close()
      this.closeFollowers.clear()
    }, 'session-controller.history')
  }

  /**
   * Read one message-aligned history page without activating an Agent.
   * @param request - durable address and backwards-page cursor.
   * @param signal - caller cancellation for persistence reads.
   * @returns a contiguous event page.
   */
  async page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage> {
    validatePageRequest(request)
    const throughSeq: SessionSeqCursor = request.throughSeq === -1
      ? -1
      : SessionSeq(request.throughSeq)
    const beforeSeq = request.beforeSeq === undefined
      ? undefined
      : SessionLogOffset(request.beforeSeq)
    return this.withSource(request.address, signal, async source => {
      const sourceCursor: SessionSeqCursor = source.directory.nextSeq === 0 ? -1 : SessionSeq(source.directory.nextSeq - 1)
      if (throughSeq > sourceCursor) {
        throw new RemoteError(
          'gateway/bad-request',
          `session page through seq ${String(throughSeq)} is past cursor ${String(sourceCursor)}`,
          {},
        )
      }
      /* v8 ignore next -- Session and persistence validation guarantee a dense zero-based event prefix. */
      if (throughSeq >= 0 && source.directory.records[throughSeq]?.seq !== throughSeq) {
        throw new RemoteError('gateway/internal', `session log does not contain through seq ${String(throughSeq)}`, {})
      }
      const page = uiHistoryWindow(
        source.directory, throughSeq,
        beforeSeq,
        request.maxMessages ?? DEFAULT_MAX_MESSAGES,
        request.turnWindow,
      )
      const records = (await uiHistoryEvents(source, page.from, page.to)).map(entryFor)
      return {
        records,
        hasMore: page.hasMore,
      }
    })
  }

  /**
   * Follow events appended after an initial cursor on one durable address.
   * @param request - durable address and last committed sequence already held by the caller.
   * @param signal - stream cancellation owned by the Remote carrier.
   * @returns a complete opening snapshot followed by gap-free durable events and opted-in assistant frames.
   */
  async *follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    validateHistoryWindow(request)
    const { address } = request
    const target = addressId(address)
    const buffered = new Deque<
      | { readonly type: 'event'; readonly event: SessionWireEvent }
      | {
        readonly type: 'assistant-stream'
        readonly frame: SessionAssistantStreamFrame
        readonly ordinal: number
      }
    >()
    let snapshotCursor: SessionSeqCursor | undefined
    let assistantStreamOrdinal = 0
    type OpeningBoundary = { readonly seq: number; readonly assistantStream: SessionAssistantStreamBaseline; readonly ordinal: number }
    let openingBoundaries: OpeningBoundary[] | undefined = request.assistantStream === true ? [] : undefined
    const bufferEvent = (event: SessionWireEvent, front = false): void => {
      // A directory cut can predate a new turn that starts during its async read.
      // Keep the assistant state immediately before each buffered durable boundary.
      openingBoundaries?.push({ seq: event.seq,
        assistantStream: this.assistantStreams.get(target)?.snapshot() ?? { revision: 0 }, ordinal: assistantStreamOrdinal })
      const item = { type: 'event' as const, event }
      if (front) buffered.pushFront(item)
      else buffered.pushBack(item)
    }
    let wake: (() => void) | undefined
    const notify = (): void => {
      const resume = wake
      wake = undefined
      resume?.()
    }
    const follower = { closed: false }
    const close = (): void => {
      follower.closed = true
      notify()
    }
    this.closeFollowers.add(close)
    const disposeEvent = this.ctx.on('session/event', (session, event) => {
      if (session.id !== target) return
      bufferEvent(entryFor(event).event)
      notify()
    }, { global: true })
    const disposeCreated = this.ctx.on('session/created', (session) => {
      if (session.id !== target) return
      // Constructor seed events have no session/event notification. Normally
      // only the end-seed suffix is new; if persistence advanced after the
      // opening observation, replay everything beyond that snapshot cursor.
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const suffix = session.snapshotEvents(snapshotCursor === undefined
        ? session.firstLiveSeq
        : SessionLogOffset(snapshotCursor + 1))
      for (let index = suffix.length - 1; index >= 0; index -= 1) {
        bufferEvent(entryFor(suffix[index] as SessionEvent).event, true)
      }
      notify()
    }, { global: true })
    const disposeAssistantStream = request.assistantStream !== true
      ? undefined
      : this.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
        if (agent.session.id !== target) return
        buffered.pushBack({
          type: 'assistant-stream',
          frame: wireAssistantStreamFrame(frame, cursorBeforeNext(agent.session.seq)),
          ordinal: ++assistantStreamOrdinal,
        })
        notify()
      }, { global: true })
    const onAbort = (): void => { notify() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      // The directory action and any one-time projection bootstrap end before
      // yielding. Only the selected opening frame survives the follow.
      const opening = await this.withSource(address, signal, async source => {
        signal.throwIfAborted()
        const cursor = source.directory.nextSeq === 0 ? -1 : SessionSeq(source.directory.nextSeq - 1)
        snapshotCursor = cursor
        const page = uiHistoryWindow(source.directory, cursor, undefined, request.maxMessages ?? DEFAULT_MAX_MESSAGES, request.turnWindow)
        const records = (await uiHistoryEvents(source, page.from, page.to)).map(entryFor)
        const projections = await uiHistoryProjections(this.ctx, source, signal)
        let assistantStream = request.assistantStream === true
          ? this.assistantStreams.get(target)?.snapshot() ?? { revision: 0 }
          : undefined
        let assistantStreamOrdinalCut = assistantStreamOrdinal
        // The first durable event beyond the cut owns the preceding assistant
        // baseline and ordinal. Its later start/chunks remain in the live tail.
        const next = openingBoundaries?.reduce<OpeningBoundary | undefined>((first, boundary) =>
          boundary.seq > cursor && (first === undefined || boundary.seq < first.seq) ? boundary : first, undefined)
        if (next !== undefined) {
          assistantStream = next.assistantStream
          assistantStreamOrdinalCut = next.ordinal
        }
        openingBoundaries = undefined
        const frame: Extract<SessionFollowFrame, { type: 'snapshot' }> = {
          type: 'snapshot',
          header: wireHeader(source.directory.header),
          cursor,
          records,
          hasMore: page.hasMore,
          projections,
          ...assistantStream === undefined ? {} : { assistantStream },
        }
        return { frame, cursor, assistantStreamOrdinalCut }
      })
      signal.throwIfAborted()
      yield opening.frame
      let nextOffset = SessionLogOffset(opening.cursor + 1)
      while (!follower.closed && !signal.aborted) {
        const item = buffered.popFront()
        if (item === undefined) {
          await new Promise<void>((resolve) => { wake = resolve })
          continue
        }
        if (item.type === 'assistant-stream') {
          if (item.ordinal > opening.assistantStreamOrdinalCut) {
            yield { type: 'assistant-stream', frame: item.frame }
          }
          continue
        }
        const expectedSeq = SessionSeq(nextOffset)
        if (item.event.seq < expectedSeq) continue
        if (item.event.seq !== expectedSeq) {
          throw new RemoteError('gateway/internal', `session event stream skipped seq ${String(expectedSeq)}`, {})
        }
        nextOffset = SessionLogOffset(nextOffset + 1)
        yield entryFor(item.event)
      }
    } finally {
      this.closeFollowers.delete(close)
      signal.removeEventListener('abort', onAbort)
      disposeCreated()
      disposeEvent()
      disposeAssistantStream?.()
    }
  }

  /** Same source qualification as a Reader follow without history records or a follower. */
  async projections(request: ProjectUiProjectionsRequest, signal: AbortSignal): Promise<SessionProjectionsValue> {
    if (!Number.isSafeInteger(request.expectedCreatedAt) || request.expectedCreatedAt! < 0) {
      throw new RemoteError('gateway/bad-request', 'expectedCreatedAt must be a non-negative safe integer', {})
    }
    return this.withSource({ kind: 'session', sessionId: request.sessionId }, signal, async source => {
      signal.throwIfAborted()
      if (source.directory.header.createdAt !== request.expectedCreatedAt) {
        throw new RemoteError('gateway/internal', 'PROJECT_SOURCE_STALE: original carrier header no longer matches', { reason: 'PROJECT_SOURCE_STALE' })
      }
      const projections = await uiHistoryProjections(this.ctx, source, signal)
      signal.throwIfAborted()
      return { kind: 'sequenced', ...projections }
    })
  }

  private async withSource<T>(
    address: SessionAddress,
    signal: AbortSignal,
    action: (source: ProjectDirectoryObservation) => Promise<T>,
  ): Promise<T> {
    const sessionId = addressId(address)
    try {
      return await this.ctx.projectsRead.withDirectory(sessionId, async observation => {
        if (observation.directory.header.cwd === undefined) rejectNotFound(address)
        const projections = address.kind === 'subagent' ? await uiHistoryProjections(this.ctx, observation, signal) : undefined
        validateAddress(address, observation.directory.header, observation.directory.inheritedEventCount, projections)
        return action(observation)
      }, { signal })
    } catch (error) {
      if (error instanceof SessionPersistenceNotFoundError) rejectNotFound(address)
      throw error
    }
  }

}

function cursorBeforeNext(nextSeq: SessionLogOffsetType): SessionSeqCursor {
  return nextSeq === 0 ? -1 : SessionSeq(nextSeq - 1)
}

function wireAssistantStreamFrame(
  frame: AssistantStreamFrame,
  durableCursor: SessionSeqCursor,
): SessionAssistantStreamFrame {
  if (frame.type === 'start') return { ...frame, startedAfterSeq: durableCursor }
  if (frame.type === 'end') return frame
  return {
    ...frame,
    chunk: frame.chunk as JsonValue,
  }
}


function validatePageRequest(request: SessionPageRequest): void {
  if (!Number.isSafeInteger(request.throughSeq)
    || request.throughSeq < -1
    || Object.is(request.throughSeq, -0)) {
    throw new RemoteError('gateway/bad-request', 'throughSeq must be an integer greater than or equal to -1', {})
  }
  if (request.beforeSeq !== undefined
    && (!Number.isSafeInteger(request.beforeSeq)
      || request.beforeSeq < 0
      || Object.is(request.beforeSeq, -0))) {
    throw new RemoteError('gateway/bad-request', 'beforeSeq must be a non-negative safe integer', {})
  }
  validateHistoryWindow(request)
}

function validateHistoryWindow(request: Pick<SessionPageRequest, 'maxMessages' | 'turnWindow'>): void {
  if (request.maxMessages !== undefined
    && (!Number.isSafeInteger(request.maxMessages) || request.maxMessages <= 0)) {
    throw new RemoteError('gateway/bad-request', 'maxMessages must be a positive safe integer', {})
  }
  const window = request.turnWindow
  if (window !== undefined) {
    if (!Number.isSafeInteger(window.minMessages) || window.minMessages <= 0
      || window.minMessages > (request.maxMessages ?? DEFAULT_MAX_MESSAGES)) {
      throw new RemoteError('gateway/bad-request', 'turnWindow.minMessages must be a positive safe integer no greater than maxMessages', {})
    }
    if (!Number.isSafeInteger(window.minTurns) || window.minTurns <= 0) {
      throw new RemoteError('gateway/bad-request', 'turnWindow.minTurns must be a positive safe integer', {})
    }
  }
}

function addressId(address: SessionAddress): SessionId {
  return address.kind === 'session' ? address.sessionId : address.childSessionId
}

function validateAddress(
  address: SessionAddress,
  header: SessionHeader,
  inheritedEventCount: SessionLogOffsetType,
  projections: SessionProjectionBaseline | undefined,
): void {
  if (address.kind === 'session') {
    if (header.origin === 'subagent') {
      throw new RemoteError('session/agent-busy', 'subagent Sessions require their durable parent address', {
        reason: 'use subagent delivery for this child session',
      })
    }
    return
  }
  if (header.origin !== 'subagent' || header.parentSession !== address.parentSessionId) {
    throw new RemoteError('subagent/unauthorized', 'subagent does not belong to the supplied parent', {
      childSessionId: address.childSessionId,
    })
  }
  const identity = projections?.values.subagent
  if (identity === null) {
    throw new RemoteError('subagent/catalog-diagnostic', 'subagent descriptor is corrupt', {
      parentSessionId: address.parentSessionId,
      childSessionId: address.childSessionId,
      reason: 'corrupt',
    })
  }
  if (identity === undefined || identity.seq < inheritedEventCount) {
    throw new RemoteError('subagent/catalog-diagnostic', 'subagent descriptor is unavailable', {
      parentSessionId: address.parentSessionId,
      childSessionId: address.childSessionId,
      reason: 'unsupported',
    })
  }
  if (address.mode !== 'unknown' && identity.mode !== address.mode) {
    throw new RemoteError('subagent/unauthorized', 'subagent mode does not match the supplied address', {
      childSessionId: address.childSessionId,
    })
  }
}

function rejectNotFound(address: SessionAddress): never {
  if (address.kind === 'session') {
    throw new RemoteError('session/not-found', `session "${address.sessionId}" not found`, { sessionId: address.sessionId })
  }
  throw new RemoteError('subagent/not-found', 'subagent is unavailable', {
    parentSessionId: address.parentSessionId,
    childSessionId: address.childSessionId,
  })
}


/** Translate current logical Session metadata to the browser wire. */
function wireHeader(header: SessionHeader): SessionWireHeader {
  return { ...header }
}

function entryFor(event: SessionEvent | SessionWireEvent): SessionEventEntry {
  return {
    type: 'event',
    // Session.append validates and freezes event data as JSON before publication.
    event: projectUiHistoryEvent(event as unknown as SessionWireEvent),
  }
}
