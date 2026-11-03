/** Per-surface, disposable read provenance folded from acknowledged canonical positions. */
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { nativeSourceDigest } from './native-source-host.ts'
import { summarizeRetainedMemoryReads, type RetainedMemoryResult } from './memory-read-retention.ts'
import { observedMemoryReads, type ObservedMemoryRead, type PreparedProjectReadEvidence, type ReadReceiptFact } from './project-read-evidence.ts'
import { decodeProjectRecord, projectRecordSemanticType, type ProjectRawPayloadReader } from './stock/recording/records.ts'
import type { ProjectReadPort, ProjectDirectoryObservation } from './stock/read/index.ts'
import type { ProjectRecordLocator } from './stock/persistence/types.ts'

const tools = new Set(['run_code', 'project_memory_read', 'project_memory_list', 'project_library_open', 'project_overview_read', 'project_history', 'project_read',
  'project_instructions_read', 'project_instructions_save', 'project_overview_put_block', 'project_overview_remove_block', 'project_overview_reorder'])
interface Operation { readonly startSeq: number; readonly callId: string; readonly name: string; readonly records: ProjectRecordLocator[] }
interface Completed {
  readonly call: PreparedProjectReadEvidence['calls'][number]
  readonly receipts: readonly ReadReceiptFact[]
  readonly retained: readonly RetainedMemoryResult[]
  readonly reads: readonly ObservedMemoryRead[]
  readonly operations: readonly { readonly seq: number; readonly digest: string }[]
}

/** No Session, Promise result, full tool value or raw body is held by this model. */
export class ProjectReadEvidenceModel {
  private nextSeq = 0
  private identity: string | undefined
  private readonly active = new Map<string, Operation>()
  private readonly completed = new Map<string, Completed>()
  private readonly issues: { seq: number; message: string }[] = []
  private disposed = false
  private tail: Promise<void> = Promise.resolve()
  constructor(readonly projectId: string, readonly sessionId: SessionId,
    private readonly reader: Pick<ProjectReadPort, 'withDirectory'>, private readonly payloads: ProjectRawPayloadReader) {}

  prepare(signal?: AbortSignal): Promise<PreparedProjectReadEvidence> {
    const operation = this.tail.then(() => this.prepareNext(signal))
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async prepareNext(signal?: AbortSignal): Promise<PreparedProjectReadEvidence> {
    if (this.disposed) throw new Error('PROJECT_READ_EVIDENCE_DISPOSED')
    return this.reader.withDirectory(this.sessionId, async observation => {
      const { directory } = observation
      if (directory.owner.projectId !== this.projectId || directory.header.id !== this.sessionId) throw new Error('PROJECT_READ_EVIDENCE_OWNER_CHANGED')
      // Store revisions also change for ordinary preparation metadata. Keep
      // journal identity across requests; each observation revalidates its own
      // Store revision before it can publish a snapshot.
      const identity = nativeSourceDigest({ header: directory.header, owner: directory.owner, journalIdentity: directory.journalIdentity })
      if (this.identity !== undefined && this.identity !== identity) throw new Error('PROJECT_READ_EVIDENCE_GENERATION_CHANGED')
      if (directory.nextSeq < this.nextSeq) throw new Error('PROJECT_READ_EVIDENCE_SOURCE_REGRESSED')
      this.identity = identity
      for (const record of directory.records) {
        if (record.seq < this.nextSeq) continue
        signal?.throwIfAborted()
        await this.append(record, observation, signal)
        this.nextSeq = record.seq + 1
      }
      if (this.nextSeq !== directory.nextSeq) throw new Error('PROJECT_READ_EVIDENCE_DIRECTORY_GAP')
      await observation.revalidate()
      signal?.throwIfAborted()
      if (this.disposed) throw new Error('PROJECT_READ_EVIDENCE_DISPOSED')
      return this.snapshot()
    }, { ...(signal === undefined ? {} : { signal }), fromSeq: this.nextSeq })
  }

  private async append(record: ProjectRecordLocator, source: ProjectDirectoryObservation, signal?: AbortSignal): Promise<void> {
    if (record.seq !== this.nextSeq) throw new Error('PROJECT_READ_EVIDENCE_DIRECTORY_GAP')
    const facts = record.facts, type = projectRecordSemanticType(record.type)
    if (type === 'tool/call') {
      if (typeof facts.callId !== 'string' || typeof facts.name !== 'string') return
      this.active.delete(facts.callId)
      if (tools.has(facts.name)) this.active.set(facts.callId, { startSeq: record.seq, callId: facts.callId, name: facts.name, records: [record] })
      return
    }
    const rootId = type === 'tool/result' ? facts.callId : facts.rootCallId
    const operation = typeof rootId === 'string' ? this.active.get(rootId) : undefined
    if (operation === undefined) return
    const relevant = type === 'tool/result' || type === 'tool/ptc-dispatch-start' || type === 'tool/ptc-dispatch'
      || type === 'tool/execution-start' || type === 'projects/tool-execution-start'
      || (type === 'tool/execution-return' || type === 'projects/tool-execution-return') && facts.phase === 'canonical'
    if (!relevant) return
    if (operation.records.at(-1)?.seq !== record.seq) operation.records.push(record)
    if (type !== 'tool/result') return
    // A root result cannot be attached to a different reuse of the call id.
    if (typeof facts.startEventSeq === 'number' && facts.startEventSeq !== operation.startSeq) { this.active.delete(operation.callId); return }
    try {
      const events: SessionEvent[] = [], operations = operation.records.map(locator => ({ seq: locator.seq, digest: locator.eventDigest }))
      const needsMemoryExecution = operation.name === 'project_memory_read' || operation.name === 'run_code' && operation.records.some(locator =>
        locator.type === 'tool/ptc-dispatch-start' && locator.facts.name === 'project_memory_read')
      for (const locator of operation.records) {
        const semanticType = projectRecordSemanticType(locator.type)
        // Other Project read projections use their existing native result
        // provenance. Their forensic returns add no Memory retention fact.
        if (!needsMemoryExecution && ['tool/execution-start', 'projects/tool-execution-start', 'tool/execution-return', 'projects/tool-execution-return'].includes(semanticType)) continue
        signal?.throwIfAborted()
        const canonical = await source.readEvent(locator.seq)
        if (canonical === undefined || canonical.type !== locator.type || nativeSourceDigest(canonical) !== locator.eventDigest) throw new Error('PROJECT_READ_EVIDENCE_CANONICAL_UNAVAILABLE')
        const decoded = await decodeProjectRecord(canonical, this.payloads, signal === undefined ? {} : { signal })
        events.push(decoded.semantic)
      }
      const result = events.at(-1)
      if (result?.type !== 'tool/result' || result.data.message.isError) { this.active.delete(operation.callId); return }
      const receipts = events.flatMap(event => event.type !== 'tool/ptc-dispatch' || event.data.isError ? [] : event.data.content.flatMap(block => {
        if (block.type !== 'text') return []
        try { return [{ name: event.data.name, digest: nativeSourceDigest(JSON.parse(block.text)) }] } catch { return [] }
      }))
      const retained = summarizeRetainedMemoryReads(this.projectId, events)
      const recorded = events.some(event => ['tool/execution-start', 'projects/tool-execution-start', 'tool/execution-return', 'projects/tool-execution-return'].includes(event.type))
      // When exact execution evidence exists, its identity/settlement/retention
      // proof is authoritative. A parseable result cannot bypass a failed proof.
      const reads = recorded ? retained.flatMap(row => row.complete) : observedMemoryReads(this.projectId, events)
      this.completed.set(result.data.message.id, {
        call: { messageId: result.data.message.id as MessageId, name: operation.name, startSeq: operation.startSeq }, receipts,
        retained, reads, operations,
      })
      this.active.delete(operation.callId)
    } catch (error) {
      signal?.throwIfAborted()
      // Missing/corrupt payload is an explicit unknown operation, never a
      // successful zero-read reconstruction or a body synthesized from its ref.
      this.active.delete(operation.callId)
      this.issues.push({ seq: record.seq, message: error instanceof Error ? error.message : String(error) })
    }
  }

  snapshot(): PreparedProjectReadEvidence {
    const rows = [...this.completed.values()]
    return { calls: rows.map(row => row.call), nested: rows.map(row => ({ startSeq: row.call.startSeq, receipts: row.receipts })),
      retained: rows.flatMap(row => row.retained), reads: rows.flatMap(row => row.reads), issues: [...this.issues] }
  }

  dispose(): void { this.disposed = true; this.active.clear(); this.completed.clear(); this.issues.length = 0; this.identity = undefined }
}
