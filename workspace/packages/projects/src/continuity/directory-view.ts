/** Disposable query view: directory facts choose positions; only selected records carry bodies. */
import { TOOL_OUTCOME_UNKNOWN, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { RetainedNativeDirectory } from '../source-reader.ts'
import type { ProjectsCoreAccess } from '../core-access.ts'
import { projectRecordSemanticType } from '../stock/recording/records.ts'
import type { ProjectRecordLocator } from '../stock/persistence/types.ts'

export type ContinuityPrefix = ContinuityDirectoryView
export type ContinuitySource = RetainedNativeDirectory

/** Continuity reads use the Projects retained directory owner. */
export async function readContinuitySource(core: ProjectsCoreAccess, projectId: string, host: string, signal?: AbortSignal): Promise<ContinuitySource> {
  return core.readNativeDirectory(projectId, host, signal)
}
export function continuityPrefix(source: Extract<ContinuitySource, { readable: true }>, through?: number): ContinuityPrefix {
  return continuityDirectoryView(source, through)
}
export async function loadContinuityPositions(prefix: ContinuityPrefix, seqs: Iterable<number>, signal?: AbortSignal): Promise<void> {
  await prefix.load(seqs, signal)
}
export function continuityPositionLoaded(prefix: ContinuityPrefix, seq: number): boolean { return prefix.loaded.has(seq) }
export async function revalidateContinuityPrefix(prefix: ContinuityPrefix): Promise<void> { await prefix.revalidate() }

export type ContinuityDirectory = Extract<RetainedNativeDirectory, { readable: true }>
export interface ContinuityDirectoryView extends ContinuityDirectory {
  /** Metadata shapes are query-only, never native records or evidence. */
  readonly events: SessionEvent[]
  readonly canonicalEvents: Map<number, SessionEvent>
  readonly canonicalLocators: ReadonlyMap<number, ProjectRecordLocator>
  readonly loaded: ReadonlySet<number>
  load(seqs: Iterable<number>, signal?: AbortSignal): Promise<void>
}

export function continuityDirectoryView(source: ContinuityDirectory, through = source.endSeq): ContinuityDirectoryView {
  const locators = new Map(source.directory.records.filter(record => record.seq <= through).map(record => [record.seq, record]))
  const canonicalEvents = new Map<number, SessionEvent>(), loaded = new Set<number>()
  // The array index remains the canonical seq expected by the shared projector.
  // These shapes contain no original body and are never used to mint a digest.
  const events = Array.from({ length: through + 1 }, (_, seq) => {
    const locator = locators.get(seq)
    if (locator === undefined) throw new Error('CONTINUITY_DIRECTORY_GAP')
    return metadataEvent(locator)
  })
  return { ...source, endSeq: through, events, canonicalEvents, canonicalLocators: locators, loaded,
    async load(seqs, signal) {
      for (const seq of new Set(seqs)) {
        signal?.throwIfAborted()
        if (seq < 0 || seq > through || loaded.has(seq)) continue
        const decoded = await source.readDecodedEvent(seq)
        if (decoded === undefined) throw new Error('CONTINUITY_SELECTED_RECORD_UNAVAILABLE')
        if (decoded.canonical.seq !== seq || decoded.semantic.seq !== seq) throw new Error('CONTINUITY_SELECTED_RECORD_POSITION_MISMATCH')
        canonicalEvents.set(seq, decoded.canonical)
        events[seq] = decoded.semantic
        loaded.add(seq)
      }
    },
  }
}

function metadataEvent(record: ProjectRecordLocator): SessionEvent {
  const facts = record.facts, type = projectRecordSemanticType(record.type)
  let data: Record<string, unknown> = { ...facts }
  const message = (role: string) => ({ id: facts.messageId, role, source: { kind: facts.sourceKind ?? (role === 'assistant' ? 'model' : role), ...(facts.sourceForm === undefined ? {} : { form: facts.sourceForm }) }, content: [],
    ...(role !== 'tool' ? {} : { toolCallId: facts.callId, isError: facts.isError === true }) })
  if (type === 'user/message') data = message('user')
  else if (type === 'assistant/message' || type === 'tool/result') data = { ...data, message: message(type === 'assistant/message' ? 'assistant' : 'tool'), stream: [] }
  else if (type === 'turn/end') data.reason = { kind: facts.reasonKind }
  else if (type === 'agent/inbox/spliced') data.inserted = (record.inboxMetadata?.inserted ?? []).map(item => ({ id: item.id, role: 'user', source: { kind: item.sourceKind, ...(item.sourceForm === undefined ? {} : { form: item.sourceForm }) }, content: [] }))
  else if (type === 'request/header') data.header = { config: { provider: facts.provider, model: facts.model } }
  else if (type === 'tool/call' || type === 'tool/ptc-dispatch-start') data.arguments = ''
  else if (type === 'assistant/attempt' || type === 'assistant/progress' || type === 'projects/assistant-progress') data.stream = []
  if (facts.outcomeUnknown === true) data.error = { code: TOOL_OUTCOME_UNKNOWN }
  const surfaceOp = facts.surfaceOp === 'append' ? 'append' : facts.surfaceOp === 'replace' ? { startSeq: facts.surfaceStartSeq, endSeq: facts.surfaceEndSeq } : undefined
  return { seq: record.seq, type, time: record.time, data,
    ...(surfaceOp === undefined ? {} : { surfaceOp }),
    ...(record.sourceEventSeqs === undefined ? type !== 'tool/result' || typeof facts.startEventSeq !== 'number' ? {} : { sourceEventSeqs: [facts.startEventSeq] } : { sourceEventSeqs: record.sourceEventSeqs }),
  } as unknown as SessionEvent
}

/** Shared visible projection dependencies; request/context and private raw payloads stay unread. */
export function continuityProjectionRecord(type: string): boolean {
  return ['user/message', 'assistant/message', 'tool/result', 'tool/call', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch',
    'agent/inbox/spliced', 'assistant/attempt', 'assistant/progress', 'projects/assistant-progress',
    'tool/execution-start', 'tool/execution-return', 'projects/tool-execution-start', 'projects/tool-execution-return', 'projects/tool-execution-final',
    'agent/stop-request', 'projects/agent-stop-request', 'projects/assistant-settlement', 'projects/tool-proposal',
    'tool/project-communication', 'projects/communication'].includes(projectRecordSemanticType(type))
}
