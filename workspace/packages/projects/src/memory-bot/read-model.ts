/** Memory's disposable projection over acknowledged record positions, never a raw journal cache. */
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectSessionPersistence, ProjectRecordDirectory, CommittedRange } from '../stock/persistence/index.ts'
import { decodeProjectRecord, projectRecordSemanticType } from '../stock/recording/records.ts'
import { mintNativeProjectSource } from '../native-source-host.ts'
import { MemoryPendingProjector, isMemoryProjectionEvent } from './projection.ts'
import type { MemoryBotCut, SavedWorkCut } from './types.ts'

export type MemoryReadIdentity = Omit<SavedWorkCut, 'events' | 'endSeq'>
type ReadPersistence = Pick<ProjectSessionPersistence, 'recordDirectory' | 'readCanonicalEvent' | 'readCanonicalRange' | 'readPayload'>

export function isMemoryRecordType(type: string): boolean {
  return isMemoryProjectionEvent({ type: projectRecordSemanticType(type) } as Pick<SessionEvent, 'type'>)
}

export class MemoryReadModel {
  readonly projector: MemoryPendingProjector
  private readonly journals = new Map<string, string>()
  private readonly processed = new Map<string, MemoryBotCut>()
  constructor(readonly projectId: string, private readonly persistence: ReadPersistence, processed: readonly MemoryBotCut[], readonly version: 1 | 2 = 2) {
    this.projector = new MemoryPendingProjector(projectId, processed, version)
    for (const cut of processed) this.processed.set(cut.hostSessionId, { ...cut })
  }

  async directory(identity: MemoryReadIdentity): Promise<ProjectRecordDirectory> {
    const directory = await this.persistence.recordDirectory(SessionId(identity.hostSessionId), { fromSeq: this.projector.endSeq(identity.hostSessionId) + 1 })
    if (directory.owner.projectId !== this.projectId || directory.owner.logicalSessionId !== identity.sessionId
      || identity.sessionCreatedAt !== undefined && directory.header.createdAt !== identity.sessionCreatedAt
      || identity.formatVersion !== undefined && directory.header.version !== identity.formatVersion) throw new Error('Memory directory owner or creation identity changed.')
    const previous = this.journals.get(identity.hostSessionId)
    if (previous !== undefined && previous !== directory.journalIdentity) throw new Error('Memory journal generation changed.')
    this.journals.set(identity.hostSessionId, directory.journalIdentity)
    if (directory.nextSeq < this.projector.endSeq(identity.hostSessionId) + 1) throw new Error('Memory acknowledged source regressed.')
    return directory
  }

  async append(identity: MemoryReadIdentity, directory: ProjectRecordDirectory, endSeq = directory.nextSeq - 1, through?: CommittedRange): Promise<void> {
    if (!Number.isSafeInteger(endSeq) || endSeq < -1 || endSeq >= directory.nextSeq || endSeq < this.projector.endSeq(identity.hostSessionId)) throw new Error('Memory frozen cut is not present in the acknowledged directory.')
    let next = this.projector.endSeq(identity.hostSessionId) + 1
    const fullIdentity: MemoryReadIdentity = { ...identity, sessionCreatedAt: directory.header.createdAt, formatVersion: directory.header.version }
    let index = 0
    while (index < directory.records.length) {
      const record = directory.records[index]!
      if (record.seq < next) { index++; continue }
      if (record.seq > endSeq) break
      if (record.seq !== next) throw new Error('Memory record directory has a gap.')
      if (!isMemoryRecordType(record.type)) { index++; next++; continue }
      // Existing range reads keep one fd for adjacent selected records. Never
      // widen a group across unrelated request/raw evidence or the frozen cut.
      let stop = index + 1
      while (stop < directory.records.length) {
        const candidate = directory.records[stop]!
        if (candidate.seq !== record.seq + stop - index || candidate.seq > endSeq || !isMemoryRecordType(candidate.type)) break
        stop++
      }
      const toSeq = record.seq + stop - index
      let selected = index
      for await (const canonical of this.persistence.readCanonicalRange(SessionId(identity.hostSessionId), record.seq, toSeq,
        through === undefined ? {} : { through })) {
        const expected = directory.records[selected++]
        if (selected > stop || expected === undefined || canonical.seq !== expected.seq || canonical.type !== expected.type) throw new Error('Memory selected canonical record is unavailable.')
        const decoded = await decodeProjectRecord(canonical, this.persistence)
        const source = mintNativeProjectSource({ projectId: this.projectId, sessionId: identity.sessionId, hostSessionId: identity.hostSessionId,
          sessionCreatedAt: directory.header.createdAt, formatVersion: directory.header.version }, decoded.canonical, decoded.canonical)
        this.projector.appendIndexed(fullIdentity, decoded.semantic, endSeq, source)
      }
      if (selected !== stop) throw new Error('Memory selected canonical record is unavailable.')
      index = stop; next = toSeq
    }
    if (next !== endSeq + 1) throw new Error('Memory selected directory did not reach the captured cut.')
    this.projector.appendIndexed(fullIdentity, undefined, endSeq)
  }

  /** A successful batch advances its paused fold, rereading at most its last stable context per carrier. */
  async advanceProcessed(cuts: readonly MemoryBotCut[]): Promise<void> {
    for (const before of this.processed.values()) {
      const after = cuts.find(cut => cut.hostSessionId === before.hostSessionId)
      if (after === undefined || after.sessionId !== before.sessionId || after.endSeq < before.endSeq) throw new Error('Memory processed state rewound or changed membership.')
    }
    const sources = this.projector.processedContextSources(cuts), context = new Map<string, string>()
    for (const item of sources) {
      if (item.source.kind !== 'native-event') throw new Error('Memory processed context has no exact canonical source.')
      const canonical = await this.persistence.readCanonicalEvent(SessionId(item.hostSessionId), item.source.eventSeq)
      if (canonical === undefined) throw new Error('Memory processed context is unavailable.')
      const identity = { projectId: this.projectId, sessionId: item.source.sessionId, hostSessionId: item.hostSessionId,
        sessionCreatedAt: item.source.sessionCreatedAt, formatVersion: item.source.eventSpace.formatVersion }
      const { canonical: original, semantic } = await decodeProjectRecord(canonical, this.persistence)
      const actual = mintNativeProjectSource(identity, original, original)
      if (actual.eventType !== item.source.eventType || actual.eventDigest !== item.source.eventDigest) throw new Error('Memory processed context source changed.')
      // Only a single stable completed message needs restoration. Open progress
      // keeps its full visible baseline in the existing assembler instead.
      const data = semantic.data as unknown as Record<string, unknown>
      const message = semantic.type === 'assistant/message' ? data.message as Record<string, unknown> | undefined : semantic.type === 'user/message' ? data : undefined
      if (message !== undefined && Array.isArray(message.content)) context.set(item.hostSessionId, message.content.flatMap(block => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join(''))
    }
    this.projector.advanceProcessed(cuts, context)
    for (const cut of cuts) this.processed.set(cut.hostSessionId, { ...cut })
  }
}
