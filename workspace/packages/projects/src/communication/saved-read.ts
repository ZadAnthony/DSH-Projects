/** Host-only reads of the two saved chat copies. No client snapshot or write path. */
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { ProjectsCoreAccess } from '../core-access.ts'
import type { ProjectStore } from '../records.ts'
import { selectNativeProjectVisibleDirectoryEvents, readNativeProjectSourceFromDirectory } from '../source-reader.ts'
import { mintNativeProjectSource } from '../native-source-host.ts'
import { communicationDirectoryEvents, communicationDeliveryMayMatch, communicationHolder as holder, communicationInvocationAt as invocationAt, communicationMessageAt as messageAt, factMayMatch, messagesOf, sameCommunicationMessage as sameMessage } from './directory.ts'
import type { CommunicationDirectory as Directory, MessageAt } from './directory.ts'
import type {
  ProjectCommunicationFile, ProjectCommunicationNavigation, ProjectCommunicationRead,
  ReadProjectCommunicationRequest, ResolveProjectCommunicationFileRequest, ResolveProjectCommunicationNavigationRequest,
} from '../public-types.ts'
import {
  canonicalJson, jsonFrozen, operationReference, snapshotCodec, validateInvocation, validateLocator,
} from './contract.ts'
import type {
  CommunicationInvocationSource, CommunicationPartV1, CommunicationRecordLocator, CommunicationSnapshotV1,
  CommunicationVisibleBlock,
} from './contract.ts'
import type { CommunicationQuery } from './query.ts'
import type { CommunicationTranscript } from './transcript.ts'
import { communicationAttachmentVerifier } from './visible-reader.ts'

type Saved = { projectId: string; record: CommunicationRecordLocator; snapshot: CommunicationSnapshotV1; directory: Directory }
export interface CommunicationSavedReadDependencies {
  readonly ctx: Context
  readonly store: ProjectStore
  readonly core: ProjectsCoreAccess
  readonly transcript: CommunicationTranscript
  readonly query: CommunicationQuery
}

/** Construct once beside Transcript/Query; the three runtime methods only delegate. */
export class CommunicationSavedRead {
  constructor(private readonly deps: CommunicationSavedReadDependencies) {}

  async readCommunication(request: ReadProjectCommunicationRequest, signal?: AbortSignal): Promise<ProjectCommunicationRead> {
    try {
      signal?.throwIfAborted()
      const retained = await this.deps.core.readSessionSource(request.holderHostSessionId)
      if (retained === undefined) return { kind: 'unavailable', reason: 'Saved holder is unavailable.' }
      const projectId = retained.projectId
      await this.deps.core.forProject(projectId)
      const directory = await this.deps.core.readNativeDirectory(projectId, request.holderHostSessionId, signal)
      if (!directory.readable) return { kind: 'unavailable', reason: directory.reason }
      let record: CommunicationRecordLocator
      if (request.locator.kind === 'recipient') {
        const actual = await messageAt(directory, request.locator.messageId, 'saved', signal)
        if (actual === undefined) return { kind: 'unavailable', reason: 'Exact received message is unavailable.' }
        const source = actual.message.source
        if (source.kind !== 'project-delivery' || source.projectId !== projectId) return { kind: 'unavailable', reason: 'Message is not a communication in this project.' }
        if (source.communicationFormat === undefined) return { kind: 'legacy' }
        if (source.communicationFormat !== 'projects-communication/v1') return { kind: 'unsupported', reason: 'Unsupported saved communication format.' }
        record = { kind: 'recipient-message', holder: holder(directory), messageId: request.locator.messageId }
      } else {
        const source = request.locator.kind === 'sender'
          ? await invocationAt(directory, request.locator.startEventSeq, request.locator.callId, request.locator.rootCallId)
          : await invocationForResult(directory, request.locator.resultEventSeq, request.locator.callId, signal)
        if (source === undefined) return { kind: 'unavailable', reason: 'Exact own project_send_message occurrence is unavailable.' }
        if (request.locator.kind === 'sender' && request.locator.invocationSource !== undefined
          && canonicalJson(validateInvocation(request.locator.invocationSource)) !== canonicalJson(source))
          return { kind: 'unavailable', reason: 'Invocation identity does not match the actual session and start.' }
        const savedEvents: Array<SessionEvent<'projects/communication'>> = []
        for await (const event of communicationDirectoryEvents(directory, record => record.type === 'projects/communication'
          && record.seq >= directory.inheritedEventCount && factMayMatch(record, 'operationRef', operationReference(source)), signal)) {
          if (event.type === 'projects/communication' && event.data.phase !== 'received' && canonicalJson(event.data.invocationSource) === canonicalJson(source)) savedEvents.push(event)
        }
        if (savedEvents.some(event => event.data.format !== 'projects-communication-event/v1' || event.data.phase !== 'prepared' && event.data.phase !== 'outcome'))
          return { kind: 'unsupported', reason: 'Unsupported saved communication event format.' }
        const preparedEvents = savedEvents.filter(event => event.data.phase === 'prepared')
        if (preparedEvents.length > 1) return { kind: 'unavailable', reason: 'Ambiguous prepared records for the actual occurrence.' }
        if (preparedEvents.length === 0) return legacyArguments(await directory.readEvent(source.startEventSeq))
          ? { kind: 'legacy' } : { kind: 'not-prepared', reason: 'This actual invocation has no prepared chat copy.' }
        const prepared = await this.deps.transcript.readPreparedForInvocation(projectId, source)
        if (prepared === undefined) return { kind: 'unavailable', reason: 'Prepared chat copy failed validation.' }
        record = prepared.record
      }
      const saved = await this.load(projectId, record, signal)
      if (saved === undefined) return { kind: 'unavailable', reason: 'Saved chat copy is unavailable or invalid.' }
      const query = await this.deps.query.read(projectId, { operationRef: saved.snapshot.operationRef })
      if (!await this.stillReadable(saved, signal)) return { kind: 'unavailable', reason: 'Saved holder changed during reading.' }
      const result = 'result' in query ? query.result : undefined
      const facts = 'facts' in query ? checkedFacts(query.facts) : undefined
      return jsonFrozen({ kind: 'communication', projectId, record: saved.record, snapshot: saved.snapshot,
        result: result === 'delivered' || result === 'not-delivered' || result === 'preparation-interrupted' ? result : 'unknown',
        ...('operation' in query && query.operation !== undefined ? { phase: query.operation.phase,
          ...(query.operation.failure === undefined ? {} : { failure: query.operation.failure }) } : {}),
        ...(facts === undefined ? {} : { facts }),
      })
    } catch (error) {
      signal?.throwIfAborted()
      return { kind: unsupported(error) ? 'unsupported' : 'unavailable', reason: reason(error) }
    }
  }

  async resolveCommunicationNavigation(request: ResolveProjectCommunicationNavigationRequest, signal?: AbortSignal): Promise<ProjectCommunicationNavigation> {
    try {
      const saved = await this.load(request.projectId, request.record, signal)
      if (saved === undefined) return noNavigation('Saved communication is unavailable.')
      const snapshot = saved.snapshot
      let destination: { directory: Directory; eventSeq: number; messageId?: string } | undefined
      switch (request.target.kind) {
        case 'sender': destination = await this.senderDestination(saved, signal); break
        case 'recipient': destination = await this.recipientDestination(saved, signal); break
        case 'reply': {
          const reply = snapshot.replyTo
          if (reply === undefined) break
          const receiver = await this.deps.core.readSessionSource(reply.receivedAt.holder.hostSessionId, request.projectId)
          if (receiver?.projectId !== request.projectId || receiver.id !== snapshot.sender.sessionId
            || receiver.role !== snapshot.sender.role || receiver.sourceLifecycle.kind !== 'available') break
          const directory = await this.directory(request.projectId, reply.receivedAt.holder.hostSessionId, signal)
          if (directory === undefined || directory.sessionCreatedAt !== reply.receivedAt.holder.sessionCreatedAt) break
          const at = await messageAt(directory, reply.receivedAt.messageId, 'navigation', signal)
          if (at === undefined || at.message.source.kind !== 'project-delivery' || at.message.source.projectId !== request.projectId
            || at.message.source.deliveryId !== reply.deliveryId || at.message.source.senderSessionId !== reply.sender.sessionId) break
          if (reply.format === 'projects-communication/v1') {
            const original = await this.load(request.projectId, reply.receivedAt, signal)
            if (original === undefined || original.snapshot.deliveryId !== reply.deliveryId || original.snapshot.sender.hostSessionId !== reply.sender.hostSessionId) break
          } else if (at.message.source.communicationFormat !== undefined) break
          destination = { directory, eventSeq: Number(at.event.seq), messageId: reply.receivedAt.messageId }
          break
        }
        case 'part-origin': {
          const partId = request.target.partId
          const part = [...snapshot.userMessageParts, ...snapshot.contextParts].find(part => part.id === partId)
          if (part === undefined) break
          const directory = await this.directory(request.projectId, part.origin.hostSessionId, signal)
          if (directory === undefined || directory.sessionCreatedAt !== part.version.sessionCreatedAt) break
          const event = await directory.readEvent(part.originEventSeq)
          if (event === undefined || event.seq !== part.originEventSeq || event.time !== part.originTime
            || part.originEventSeq >= part.version.prefixEventCount || !await matchesPartEvent(part, event, directory, signal)) break
          const messageId = part.origin.kind === 'tool' ? undefined : part.origin.messageId
          if (messageId !== undefined && (event.type === 'agent/inbox/spliced'
            || event.type === 'projects/communication' && event.data.phase === 'received')) {
            const original = messagesOf(event).filter(message => String(message.id) === messageId)
            const current = await messageAt(directory, messageId, 'navigation', signal)
            // The frozen part still names its original saved occurrence. Only
            // its exact unchanged message may gain a later visible append.
            if (original.length !== 1 || current === undefined || !sameMessage(original[0]!, current.message)) break
            destination = { directory, eventSeq: Number(current.event.seq), messageId }
            break
          }
          destination = { directory, eventSeq: part.originEventSeq,
            ...(part.origin.kind === 'message' ? { messageId: part.origin.messageId } : {}) }
          break
        }
      }
      if (destination === undefined) return noNavigation('Exact saved navigation target is unavailable.')
      // Work routes stay current; an available historical carrier opens only its exact visible source.
      const view = await this.deps.core.forProject(request.projectId)
      const source = await this.deps.core.readSessionSource(destination.directory.hostSessionId, request.projectId)
      const session = view.snapshot.sessions.find(session => session.id === source?.id
        && (session.role === 'main' || session.role === 'execution'))
      if (session === undefined || source?.projectId !== request.projectId || source.sourceLifecycle.kind !== 'available'
        || !await this.sameDirectory(request.projectId, destination.directory, signal) || !await this.stillReadable(saved, signal))
        return noNavigation('Navigation target or saved holder is no longer available.')
      const historical = session.hostSessionId !== destination.directory.hostSessionId
      if (historical && source.header?.createdAt !== destination.directory.sessionCreatedAt)
        return noNavigation('Exact historical carrier creation identity is unavailable.')
      const entries = (await selectNativeProjectVisibleDirectoryEvents(destination.directory, new Set([destination.eventSeq]), signal))
        .filter(entry => destination!.messageId === undefined || entry.item.messageId === destination!.messageId)
      const exactSource = entries.length === 1 ? entries[0]!.item.nativeSource : undefined
      if (exactSource?.kind !== 'native-event') return noNavigation('Exact visible navigation source is unavailable.')
      await destination.directory.revalidate()
      if (!await this.stillReadable(saved, signal)) return noNavigation('Saved holder is no longer available.')
      return jsonFrozen({ kind: 'available', projectId: request.projectId, target: { kind: session.role as 'main' | 'execution', sessionId: session.id,
        ...(historical ? { source: exactSource } : {}) },
        eventSeq: destination.eventSeq, ...(destination.messageId === undefined ? {} : { messageId: destination.messageId }) })
    } catch (error) { signal?.throwIfAborted(); return noNavigation(reason(error)) }
  }

  async resolveCommunicationFile(request: ResolveProjectCommunicationFileRequest, signal?: AbortSignal): Promise<ProjectCommunicationFile> {
    try {
      const saved = await this.load(request.projectId, request.record, signal)
      if (saved === undefined) return { kind: 'unavailable', reason: 'Saved communication is unavailable.' }
      const matches = new Map<string, Extract<CommunicationVisibleBlock, { type: 'file' }>>()
      const visit = (blocks: readonly CommunicationVisibleBlock[]): void => {
        for (const block of blocks) {
          if (block.type === 'quoted-tool-result') visit(block.content)
          else if (block.type === 'file' && String(block.attachment.attachmentId) === request.attachmentId)
            matches.set(canonicalJson(block.attachment), block)
        }
      }
      for (const part of [...saved.snapshot.userMessageParts, ...saved.snapshot.contextParts]) visit(part.blocks)
      if (matches.size !== 1) return { kind: 'unavailable', reason: matches.size === 0 ? 'File is absent from this saved snapshot.' : 'Attachment id has multiple saved file references; an exact alias is required.' }
      const block = [...matches.values()][0]!
      const read = this.deps.ctx.get('projectsRead')
      const owner = read === undefined ? this.deps.ctx.get('attachments') : await read.attachments.forCarrier(SessionId(saved.record.holder.hostSessionId))
      // Cordis service access can produce a new scoped proxy; pin implementation
      // identity rather than comparing access proxies from successive lookups.
      const ownerIdentity = read ?? this.deps.ctx.reflect._getImpl('attachments')?.value
      const fsIdentity = this.deps.ctx.reflect._getImpl('fs')?.value
      if (owner === undefined || ownerIdentity === undefined || fsIdentity === undefined)
        return { kind: 'unavailable', reason: 'Native attachment owner is unavailable.' }
      // Reuse the source owner's full immutable-byte verification, including native ref validation.
      await communicationAttachmentVerifier(this.deps.ctx)(block, signal, saved.record.holder.hostSessionId)
      const path = owner.fileHostPath(block.attachment)
      if ((read ?? this.deps.ctx.reflect._getImpl('attachments')?.value) !== ownerIdentity || this.deps.ctx.reflect._getImpl('fs')?.value !== fsIdentity
        || path === undefined || !isAbsolute(path)
        || !await this.stillReadable(saved, signal)) return { kind: 'unavailable', reason: 'File or saved holder changed during reading.' }
      return { kind: 'available', path }
    } catch (error) { signal?.throwIfAborted(); return { kind: 'unavailable', reason: reason(error) } }
  }

  private async directory(projectId: string, hostSessionId: string, signal?: AbortSignal): Promise<Directory | undefined> {
    const directory = await this.deps.core.readNativeDirectory(projectId, hostSessionId, signal)
    return directory.readable ? directory : undefined
  }
  private async load(projectId: string, input: CommunicationRecordLocator, signal?: AbortSignal): Promise<Saved | undefined> {
    signal?.throwIfAborted()
    const record = jsonFrozen(validateLocator(input))
    await this.deps.core.forProject(projectId)
    const directory = await this.directory(projectId, record.holder.hostSessionId, signal)
    if (directory === undefined || directory.sessionCreatedAt !== record.holder.sessionCreatedAt) return undefined
    if (record.kind === 'sender-prepared') {
      const event = await directory.readEvent(record.eventSeq)
      if (record.eventSeq < directory.inheritedEventCount || event?.type !== 'projects/communication'
        || event.data.format !== 'projects-communication-event/v1' || event.data.phase !== 'prepared'
        || canonicalJson(record.invocationSource) !== canonicalJson(await invocationAt(directory, record.invocationSource.startEventSeq, record.invocationSource.callId, record.invocationSource.rootCallId))) return undefined
    } else {
      const at = await messageAt(directory, record.messageId, 'saved', signal)
      if (at?.message.source.communicationFormat !== 'projects-communication/v1') return undefined
    }
    const snapshot = await this.deps.transcript.readSnapshot(projectId, record, signal)
    if (snapshot === undefined || snapshot.projectId !== projectId) return undefined
    const endpoint = record.kind === 'sender-prepared' ? snapshot.sender : snapshot.recipient
    const source = await this.deps.core.readSessionSource(directory.hostSessionId, projectId)
    if (source?.id !== endpoint.sessionId || source.hostSessionId !== endpoint.hostSessionId || source.projectId !== projectId
      || source.role !== endpoint.role || source.sourceLifecycle.kind !== 'available' || source.revision !== directory.sourceRevision) return undefined
    if (record.kind === 'sender-prepared') {
      if (snapshot.operationRef !== operationReference(record.invocationSource)) return undefined
    } else if (!matchesDeliverySource((await messageAt(directory, record.messageId, 'saved', signal))!.message.source, snapshot)) return undefined
    return { projectId, record, snapshot, directory }
  }
  private async sameDirectory(projectId: string, before: Directory, signal?: AbortSignal): Promise<boolean> {
    const after = await this.directory(projectId, before.hostSessionId, signal)
    return after !== undefined && after.sessionCreatedAt === before.sessionCreatedAt && after.inheritedEventCount === before.inheritedEventCount
      && after.sourceRevision === before.sourceRevision && after.endSeq >= before.endSeq
  }
  private async stillReadable(saved: Saved, signal?: AbortSignal): Promise<boolean> {
    const after = await this.load(saved.projectId, saved.record, signal)
    return after !== undefined && after.directory.sourceRevision === saved.directory.sourceRevision
      && snapshotCodec.identity(after.snapshot) === snapshotCodec.identity(saved.snapshot)
  }
  private async senderDestination(saved: Saved, signal?: AbortSignal) {
    const directory = await this.directory(saved.projectId, saved.snapshot.sender.hostSessionId, signal)
    if (directory === undefined) return undefined
    const matches: Array<{ directory: Directory; eventSeq: number }> = []
    for await (const event of communicationDirectoryEvents(directory, record => record.type === 'projects/communication' && factMayMatch(record, 'phase', 'prepared')
      && factMayMatch(record, 'operationRef', saved.snapshot.operationRef), signal)) {
      if (event.type !== 'projects/communication' || event.data.phase !== 'prepared' || event.data.operationRef !== saved.snapshot.operationRef) continue
      const record: CommunicationRecordLocator = { kind: 'sender-prepared', holder: holder(directory), eventSeq: Number(event.seq), invocationSource: event.data.invocationSource }
      const candidate = await this.load(saved.projectId, record, signal)
      if (candidate !== undefined && snapshotCodec.identity(candidate.snapshot) === snapshotCodec.identity(saved.snapshot))
        matches.push({ directory, eventSeq: record.invocationSource.startEventSeq })
    }
    return matches.length === 1 ? matches[0] : undefined
  }
  private async recipientDestination(saved: Saved, signal?: AbortSignal) {
    const directory = await this.directory(saved.projectId, saved.snapshot.recipient.hostSessionId, signal)
    if (directory === undefined) return undefined
    const messages = new Map<string, MessageAt>()
    for await (const event of communicationDirectoryEvents(directory, record => communicationDeliveryMayMatch(record, saved.snapshot.deliveryId), signal)) {
      if (event.seq < directory.inheritedEventCount) continue
      for (const message of messagesOf(event)) if (matchesDeliverySource(message.source, saved.snapshot)
        && canonicalJson(message.source.snapshot) === canonicalJson(saved.snapshot)) {
        const previous = messages.get(message.id)
        if (previous === undefined || event.type === 'user/message') messages.set(message.id, { event, message })
      }
    }
    if (messages.size !== 1) return undefined
    const at = await messageAt(directory, [...messages.keys()][0]!, 'navigation', signal)
    if (at === undefined) return undefined
    const actual = await this.load(saved.projectId, { kind: 'recipient-message', holder: holder(directory), messageId: at.message.id }, signal)
    if (actual === undefined || snapshotCodec.identity(actual.snapshot) !== snapshotCodec.identity(saved.snapshot)) return undefined
    return { directory, eventSeq: Number(at.event.seq), messageId: at.message.id }
  }
}

async function invocationForResult(directory: Directory, seq: number, callId: string, signal?: AbortSignal): Promise<CommunicationInvocationSource | undefined> {
  if (!Number.isSafeInteger(seq) || seq < directory.inheritedEventCount || seq > directory.endSeq) return undefined
  const event = await directory.readEvent(seq)
  if (event?.type === 'tool/result') {
    if (event.surfaceOp !== undefined && !isAppendSurfaceEvent(event)) return undefined
    if (event.data.message.source.callId !== callId || event.sourceEventSeqs === undefined) return undefined
    const starts: CommunicationInvocationSource[] = []
    for (const start of event.sourceEventSeqs) {
      if (start >= seq) continue
      const source = await invocationAt(directory, Number(start), callId, callId)
      if (source !== undefined) starts.push(source)
    }
    return starts.length === 1 ? starts[0] : undefined
  }
  if (event?.type !== 'tool/ptc-dispatch' || event.data.subCallId !== callId || event.data.name !== 'project_send_message') return undefined
  const target = canonicalJson(dispatchIdentity(event.data)), pending = new Set<number>()
  // Compare complete dispatch identities one record at a time; keep only pending seqs.
  for await (const candidate of communicationDirectoryEvents(directory, record => record.seq >= directory.inheritedEventCount && record.seq <= seq
    && (record.type === 'tool/ptc-dispatch-start' || record.type === 'tool/ptc-dispatch')
    && factMayMatch(record, 'subCallId', callId) && factMayMatch(record, 'rootCallId', String(event.data.rootCallId)), signal)) {
    if (candidate.type !== 'tool/ptc-dispatch-start' && candidate.type !== 'tool/ptc-dispatch') continue
    if (canonicalJson(dispatchIdentity(candidate.data)) !== target) continue
    if (candidate.type === 'tool/ptc-dispatch-start') { pending.add(Number(candidate.seq)); continue }
    if (pending.size !== 1) { if (candidate.seq === seq) return undefined; continue }
    const start = [...pending][0]!
    pending.delete(start)
    if (candidate.seq === seq) return invocationAt(directory, start, callId, String(candidate.data.rootCallId))
  }
  return undefined
}
function dispatchIdentity(data: { rootCallId: unknown; parentCallId: unknown; subCallId: unknown; name: unknown; arguments: unknown }) {
  return { rootCallId: data.rootCallId, parentCallId: data.parentCallId, subCallId: data.subCallId, name: data.name, arguments: data.arguments }
}
function matchesDeliverySource(source: Record<string, unknown>, snapshot: CommunicationSnapshotV1): boolean {
  return source.kind === 'project-delivery' && source.communicationFormat === 'projects-communication/v1'
    && source.projectId === snapshot.projectId && source.deliveryId === snapshot.deliveryId && source.operationRef === snapshot.operationRef
    && source.senderSessionId === snapshot.sender.sessionId && source.senderHostSessionId === snapshot.sender.hostSessionId
    && source.targetSessionId === snapshot.recipient.sessionId && source.targetHostSessionId === snapshot.recipient.hostSessionId
}
async function matchesPartEvent(part: CommunicationPartV1, event: SessionEvent, directory: Directory, signal?: AbortSignal): Promise<boolean> {
  if ((event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result')
    && event.surfaceOp !== undefined && !isAppendSurfaceEvent(event)) return false
  if (part.origin.kind === 'native-event') {
    if (event.type === 'projects/communication' && event.data.phase === 'received') {
      const messageId = part.origin.messageId
      return messageId !== undefined && String(event.data.message.id) === messageId
        && canonicalJson(mintNativeProjectSource(directory, event, event, { messageId })) === canonicalJson(part.origin)
    }
    return part.origin.eventSeq === event.seq
      && (await readNativeProjectSourceFromDirectory(directory, part.origin, { before: 0, after: 0, signal })).resolved
  }
  if (part.origin.kind === 'message') {
    const messageId = part.origin.messageId
    if (event.type === 'user/message') return event.data.id === messageId
    if (event.type === 'assistant/message' || event.type === 'tool/result') return event.data.message.id === messageId
    return event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => String(message.id) === messageId)
  }
  const entries = await selectNativeProjectVisibleDirectoryEvents(directory, new Set([Number(event.seq)]), signal)
  return entries.length === 1 && entries[0]!.item.toolCallId === part.origin.toolCallId
}
function legacyArguments(event: SessionEvent | undefined): boolean {
  if (event?.type !== 'tool/call' && event?.type !== 'tool/ptc-dispatch-start') return false
  try {
    const args = object(typeof event.data.arguments === 'string' ? JSON.parse(event.data.arguments) : event.data.arguments)
    return typeof args?.intent === 'string'
  } catch { return false }
}
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
function unsupported(error: unknown): boolean { return object(error)?.code === 'COMMUNICATION_FORMAT_UNSUPPORTED' }
function checkedFacts(value: unknown): Extract<ProjectCommunicationRead, { kind: 'communication' }>['facts'] {
  const facts = object(value)
  if (facts === undefined || !['not-attempted', 'not-inserted', 'inserted', 'unknown'].includes(String(facts.insertion))
    || !['not-started', 'flushed', 'unavailable', 'failed', 'unknown'].includes(String(facts.recipientPersistence))
    || !['not-started', 'flushed', 'unavailable', 'failed', 'unknown'].includes(String(facts.senderPersistence))
    || !['not-requested', 'requested', 'unknown'].includes(String(facts.wakeup))) return undefined
  const error = object(facts.error)
  return jsonFrozen({ insertion: facts.insertion, recipientPersistence: facts.recipientPersistence, senderPersistence: facts.senderPersistence, wakeup: facts.wakeup,
    ...(['not-started', 'flushed', 'unavailable', 'failed', 'unknown'].includes(String(facts.admissionPersistence)) ? { admissionPersistence: facts.admissionPersistence } : {}),
    ...(['consumed', 'not-observed', 'unknown'].includes(String(facts.consumption)) ? { consumption: facts.consumption } : {}),
    ...(typeof facts.consumerHostSessionId === 'string' ? { consumerHostSessionId: facts.consumerHostSessionId } : {}),
    ...(typeof error?.code === 'string' && typeof error.message === 'string' ? { error: { code: error.code, message: error.message } } : {}),
  }) as unknown as Extract<ProjectCommunicationRead, { kind: 'communication' }>['facts']
}
function reason(error: unknown): string { return error instanceof Error ? error.message : 'Saved communication is unavailable.' }
function noNavigation(reason: string): ProjectCommunicationNavigation { return { kind: 'unavailable', reason } }
