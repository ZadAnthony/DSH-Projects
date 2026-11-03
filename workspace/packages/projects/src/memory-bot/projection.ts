import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { BlockAssembler, expandAssistantStream, type AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import { mintNativeProjectSource, nativeSourceDigest } from '../native-source-host.ts'
import { projectVisibleNativeEvents } from '../source-reader.ts'
import { projectCommunicationVisibleBlocks } from '../communication/visible-reader.ts'
import type { NativeProjectSourceItem } from '../source-reader.ts'
import type { MemoryBatchCoverage, MemoryBotCut, MemoryBotMessage, MemoryBotProjection, SavedWorkCut } from './types.ts'
import type {} from '../stock/recording/events.ts'
import type { NativeEventSource } from '../source-reference-types.ts'

export const MEMORY_BATCH_TURNS = 6
export const MEMORY_BATCH_CHARACTERS = 6_000
export function cutLocator(cut: MemoryBotCut): MemoryBotCut { return { sessionId: cut.sessionId, hostSessionId: cut.hostSessionId, endSeq: cut.endSeq } }

/** A finite manifest for this batch; processed history is reconstructed from cuts. */
export function memoryCoverage(pending: MemoryBotProjection): MemoryBatchCoverage {
  return { sources: [...pending.messages.map(message => message.source), ...(pending.changes ?? []).flatMap(change => [change.source, change.previousSource])], digest: nativeSourceDigest(pending) }
}

/** A disposable Memory-only fold. No raw events or request/tool bodies are cached. */
export class MemoryPendingProjector {
  private readonly hosts = new Map<string, CarrierProjection>()
  private current: MemoryBotProjection | undefined
  private stats: Pick<MemoryBotProjection, 'visibleCharacters' | 'completeTurns'> | undefined
  private readonly cursors: Map<string, MemoryBotCut>
  constructor(private readonly projectId: string, processed: readonly MemoryBotCut[], private readonly projectionVersion: 1 | 2 = 2) { this.cursors = new Map(processed.map(cut => [cut.hostSessionId, cutLocator(cut)])) }

  append(cut: Omit<SavedWorkCut, 'events' | 'endSeq'>, events: readonly SessionEvent[], endSeq: number): void {
    if (cut.role === 'memory') return
    const cursor = this.cursors.get(cut.hostSessionId)
    if (cursor !== undefined && (cursor.sessionId !== cut.sessionId || cursor.endSeq > endSeq)) throw new Error('已处理游标与原会话cut不一致。')
    let host = this.hosts.get(cut.hostSessionId)
    if (host === undefined) {
      host = new CarrierProjection(this.projectId, cut, cursor?.endSeq ?? -1, this.projectionVersion)
      this.hosts.set(cut.hostSessionId, host)
    }
    if (events.some(isMemoryProjectionEvent)) { this.current = undefined; this.stats = undefined }
    host.append(cut, events)
    if (host.endSeq !== endSeq) throw new Error('日志增量未到达声明的cut。')
  }

  reset(cut: Omit<SavedWorkCut, 'events' | 'endSeq'>): void {
    const cursor = this.cursors.get(cut.hostSessionId)
    this.hosts.set(cut.hostSessionId, new CarrierProjection(this.projectId, cut, cursor?.endSeq ?? -1, this.projectionVersion))
    this.current = undefined
    this.stats = undefined
  }

  endSeq(hostSessionId: string): number { return this.hosts.get(hostSessionId)?.endSeq ?? -1 }

  /** Directory-authorized gaps contain no Memory event; no synthetic raw events are constructed. */
  appendIndexed(cut: Omit<SavedWorkCut, 'events' | 'endSeq'>, event: SessionEvent | undefined, through: number, canonicalSource?: NativeEventSource): void {
    const cursor = this.cursors.get(cut.hostSessionId)
    if (!Number.isSafeInteger(through) || through < -1 || cursor !== undefined && (cursor.sessionId !== cut.sessionId || cursor.endSeq > through)) throw new Error('Memory indexed cut does not contain its processed prefix.')
    let host = this.hosts.get(cut.hostSessionId)
    if (host === undefined) { host = new CarrierProjection(this.projectId, cut, cursor?.endSeq ?? -1, this.projectionVersion); this.hosts.set(cut.hostSessionId, host) }
    if (event === undefined) { host.skip(through); return }
    if (event.seq > through || !isMemoryProjectionEvent(event)) throw new Error('Memory indexed record is outside its selected cut or class.')
    host.skip(event.seq - 1)
    host.append(cut, [event], canonicalSource)
    this.current = undefined
    this.stats = undefined
  }

  /** Only the paused, fully consumed cut can become processed without replaying historical bodies. */
  processedContextSources(cuts: readonly MemoryBotCut[]): readonly { hostSessionId: string; source: MemoryBotMessage['source'] }[] {
    return cuts.flatMap(cut => {
      const before = this.cursors.get(cut.hostSessionId)?.endSeq ?? -1
      if (cut.endSeq === before) return []
      const host = this.hosts.get(cut.hostSessionId)
      if (host === undefined || cut.endSeq < before || cut.endSeq !== host.endSeq) throw new Error('Memory processed update requires its exact paused projection cut.')
      const entry = host.contextCandidate()
      return entry === undefined ? [] : [{ hostSessionId: cut.hostSessionId, source: entry.source }]
    })
  }

  advanceProcessed(cuts: readonly MemoryBotCut[], contextText: ReadonlyMap<string, string> = new Map()): void {
    this.processedContextSources(cuts)
    let changed = false
    for (const cut of cuts) {
      if (cut.endSeq === (this.cursors.get(cut.hostSessionId)?.endSeq ?? -1)) continue
      changed = true
      this.hosts.get(cut.hostSessionId)!.markProcessed(cut.endSeq, contextText.get(cut.hostSessionId))
      this.cursors.set(cut.hostSessionId, cutLocator(cut))
    }
    if (changed) { this.current = undefined; this.stats = undefined }
  }

  /** Threshold checks never materialize the model-facing pending message array. */
  statistics(): Pick<MemoryBotProjection, 'visibleCharacters' | 'completeTurns'> {
    if (this.stats !== undefined) return this.stats
    const seen = new Set<string>(), completed = new Set<string>()
    for (const host of this.hosts.values()) {
      for (const identity of host.processedIdentities) seen.add(identity)
      for (const entry of host.entries) if (entry.processed && !entry.superseded) seen.add(entry.identity)
      for (const identity of host.processedCompletedInputs) completed.add(identity)
      for (const turn of host.turns) if (turn.processed) for (const identity of turn.identities) completed.add(identity)
    }
    let visibleCharacters = 0, completeTurns = 0
    for (const host of this.hosts.values()) {
      for (const entry of host.entries) {
        if (entry.processed || entry.superseded || seen.has(entry.identity) || entry.inputState === 'superseded' || entry.inputState === 'withdrawn') continue
        seen.add(entry.identity); visibleCharacters += unicodeLength(entry.text)
      }
      for (const turn of host.turns) {
        if (turn.processed) continue
        if (turn.identities.some(identity => !completed.has(identity))) completeTurns++
        for (const identity of turn.identities) completed.add(identity)
      }
    }
    return this.stats = { visibleCharacters, completeTurns }
  }

  projection(): MemoryBotProjection {
    if (this.current !== undefined) return this.current
    const entries = [...this.hosts.values()].flatMap(host => host.entries), turns = [...this.hosts.values()].flatMap(host => host.turns)
    const changes = [...this.hosts.values()].flatMap(host => host.changes), hosts = this.hosts.keys()
    const seen = new Set([...this.hosts.values()].flatMap(host => [...host.processedIdentities, ...host.entries.filter(entry => entry.processed && !entry.superseded).map(entry => entry.identity)]))
    const messages: MemoryBotMessage[] = []
    for (const entry of entries) {
      if (entry.processed || entry.superseded || seen.has(entry.identity) || entry.inputState === 'superseded' || entry.inputState === 'withdrawn') continue
      seen.add(entry.identity)
      const { processed: _processed, superseded: _superseded, ...message } = entry
      messages.push(message)
    }
    const completedInputs = new Set([...this.hosts.values()].flatMap(host => [...host.processedCompletedInputs, ...host.turns.filter(turn => turn.processed).flatMap(turn => turn.identities)]))
    let completeTurns = 0
    for (const turn of turns) {
      if (turn.processed) continue
      if (turn.identities.some(identity => !completedInputs.has(identity))) completeTurns++
      for (const identity of turn.identities) completedInputs.add(identity)
    }
    const context: MemoryBotMessage[] = []
    for (const host of hosts) {
      const first = messages.find(message => message.source.hostSessionId === host)
      if (first === undefined) continue
      const previous = entries.findLast(entry => entry.source.hostSessionId === host && entry.processed && !entry.superseded && entry.seq < first.seq && entry.inputState !== 'superseded' && entry.inputState !== 'withdrawn')
      if (previous !== undefined) { const { processed: _processed, superseded: _superseded, ...message } = previous; context.push(message) }
    }
    return this.current = { visibleCharacters: this.statistics().visibleCharacters, completeTurns, messages,
      ...(context.length === 0 ? {} : { context }), ...(changes.length === 0 ? {} : { changes }) }
  }
}

type TextBaseline = { text?: string; length: number; digest: string }
type Entry = MemoryBotMessage & { processed: boolean; superseded?: true }
class CarrierProjection {
  readonly entries: Entry[] = []
  readonly processedIdentities = new Set<string>()
  readonly processedCompletedInputs = new Set<string>()
  readonly turns: { identities: string[]; processed: boolean }[] = []
  readonly changes: NonNullable<MemoryBotProjection['changes']>[number][] = []
  endSeq = -1
  private readonly inputs = new Map<string, { digest: string; identity: string }>()
  private readonly inputEntries = new Map<string, Entry>()
  private readonly inbox = new Map<string, { id: string; entry?: Entry }[]>([['next-turn', []], ['next-step', []]])
  private readonly attempts = new Map<string, { end: number; text: TextBaseline; processedText: TextBaseline; processedEnd: number; settled?: boolean; source?: MemoryBotMessage['source']; entry?: Entry }>()
  private readonly streams = new Map<string, { assembler: BlockAssembler; end: number }>()
  private turn: { number: number; inputs: Set<string> } | undefined
  private readonly cut: Omit<SavedWorkCut, 'events' | 'endSeq'>
  constructor(private readonly projectId: string, cut: Omit<SavedWorkCut, 'events' | 'endSeq'>, private processedSeq: number, private readonly projectionVersion: 1 | 2) {
    // Structural typing permits a SavedWorkCut here. Copy only identity facts,
    // never accidentally retain its raw events through a constructor parameter.
    this.cut = { sessionId: cut.sessionId, hostSessionId: cut.hostSessionId, role: cut.role,
      ...(cut.sessionCreatedAt === undefined ? {} : { sessionCreatedAt: cut.sessionCreatedAt }), ...(cut.formatVersion === undefined ? {} : { formatVersion: cut.formatVersion }) }
  }

  skip(through: number): void {
    if (!Number.isSafeInteger(through) || through < this.endSeq) throw new Error('Memory indexed sequence regressed.')
    this.endSeq = through
  }

  contextCandidate(): Entry | undefined {
    const queued = new Set([...this.inbox.values()].flatMap(queue => queue.flatMap(item => item.entry === undefined ? [] : [item.entry])))
    return this.entries.findLast(entry => !entry.superseded && !queued.has(entry) && entry.inputState !== 'superseded' && entry.inputState !== 'withdrawn')
  }

  markProcessed(through: number, contextText?: string): void {
    if (through !== this.endSeq || through < this.processedSeq) throw new Error('Memory cannot advance an unobserved processed cut.')
    const context = this.contextCandidate()
    if (context !== undefined) {
      const activeBaseline = [...this.attempts.values()].find(attempt => attempt.entry === context)?.text.text
      if (contextText !== undefined || activeBaseline !== undefined) context.text = contextText ?? activeBaseline!
    }
    this.processedSeq = through
    for (const entry of this.entries) entry.processed = true
    for (const turn of this.turns) turn.processed = true
    for (const attempt of this.attempts.values()) {
      attempt.processedText = { length: attempt.text.length, digest: attempt.text.digest }
      attempt.processedEnd = attempt.end
      if (attempt.settled) delete attempt.text.text
    }
    this.changes.length = 0
    this.compactProcessed()
  }

  private assistantText(type: string, attempt: string, from: number, to: number, stream: ReturnType<typeof expandAssistantStream>): string {
    const progress = type === 'assistant/progress' || type === 'projects/assistant-progress'
    const key = `${type}:${attempt}`
    const previous = progress ? this.streams.get(key) : undefined
    const state = previous ?? { assembler: new BlockAssembler(), end: 0 }
    if (from !== state.end) throw new Error('模型进展stream存在未保存缺口。')
    for (const { chunk } of stream) {
      // Assembly needs block order/closure, never hidden reasoning or tool args.
      // Preserve the skeleton so first-close and late-delta rules stay native.
      if (chunk.type === 'reasoning-delta') state.assembler.push({ ...chunk, text: '' })
      else if (chunk.type === 'tool-call-delta') state.assembler.push({ ...chunk, argumentsDelta: '' })
      else if (chunk.type === 'block-end' && chunk.block.type !== 'text') state.assembler.push({ ...chunk, block: { type: 'reasoning', text: '' } })
      else if (chunk.type === 'finish') state.assembler.push({ type: 'finish', reason: chunk.reason })
      else if (chunk.type !== 'usage') state.assembler.push(chunk)
    }
    state.end = to
    if (progress) this.streams.set(key, state)
    return visibleText(projectCommunicationVisibleBlocks(state.assembler.interruptedBlocks()).blocks)
  }

  private settleLink(event: SessionEvent<'projects/assistant-settlement'>): void {
    const { attemptId, eventSeq } = event.data
    this.streams.delete(`assistant/progress:${attemptId}`)
    this.streams.delete(`projects/assistant-progress:${attemptId}`)
    const previous = this.attempts.get(attemptId)
    if (this.projectionVersion === 1) {
      // Preserve historical input/coverage while releasing the real stream owner.
      if (previous !== undefined) { delete previous.text.text; delete previous.processedText.text; previous.settled = true }
      return
    }
    const provisionalKey = `settlement:${eventSeq}`, final = this.attempts.get(provisionalKey)
    if (final === undefined) return
    const processed = eventSeq <= this.processedSeq
    const original = final.entry, text = original?.text ?? ''
    const end = Math.max(previous?.end ?? 0, final.end)
    if (original !== undefined) this.remove(original)
    if (previous?.entry !== undefined && previous.entry.processed === processed) { previous.entry.superseded = true; this.remove(previous.entry) }
    const baseline = previous?.processedText ?? textBaseline('')
    const suffix = unprocessedText(text, baseline)
    if (!processed && previous?.source !== undefined && !unprocessedText(text, previous.text).isExtension) this.changes.push({ source: final.source!, previousSource: previous.source, status: 'superseded' })
    const entry: Entry | undefined = original === undefined || text === '' ? undefined : { ...original,
      identity: `attempt:${this.cut.hostSessionId}:${attemptId}:${eventSeq}`, text: processed ? text : suffix.text,
      visibleRange: { start: processed || !suffix.isExtension ? 0 : previous?.processedEnd ?? 0, end } }
    if (entry !== undefined && entry.text !== '') this.entries.push(entry)
    this.attempts.delete(provisionalKey)
    this.attempts.set(attemptId, { end, text: final.text, processedText: processed ? final.text : { length: baseline.length, digest: baseline.digest },
      processedEnd: processed ? end : previous?.processedEnd ?? 0, ...(final.source === undefined ? {} : { source: final.source }), settled: true,
      ...(entry === undefined ? {} : { entry }) })
  }

  private compactProcessed(): void {
    const queued = new Set([...this.inbox.values()].flatMap(queue => queue.flatMap(item => item.entry === undefined ? [] : [item.entry])))
    const stable = this.entries.findLast(entry => entry.processed && !entry.superseded && !queued.has(entry) && entry.inputState !== 'superseded' && entry.inputState !== 'withdrawn')
    for (const entry of [...this.entries]) {
      if (!entry.processed || entry === stable || queued.has(entry)) continue
      this.remove(entry)
      // inputEntries/attempts may retain this identity, never its old body.
      entry.text = ''
    }
    for (const turn of this.turns) if (turn.processed) for (const identity of turn.identities) this.processedCompletedInputs.add(identity)
    for (let index = this.turns.length - 1; index >= 0; index--) if (this.turns[index]!.processed) this.turns.splice(index, 1)
  }

  private remove(entry: Entry): void {
    if (entry.processed && !entry.superseded) this.processedIdentities.add(entry.identity)
    const index = this.entries.indexOf(entry)
    if (index >= 0) this.entries.splice(index, 1)
    entry.text = ''
  }

  append(cut: Omit<SavedWorkCut, 'events' | 'endSeq'>, events: readonly SessionEvent[], canonicalSource?: NativeEventSource): void {
    if (cut.sessionId !== this.cut.sessionId || cut.sessionCreatedAt !== this.cut.sessionCreatedAt || cut.role !== this.cut.role) throw new Error('记忆日志增量的创建身份已变化。')
    const { projectId, processedSeq, entries, turns, changes, inputs, inputEntries, inbox, attempts } = this
    const locatorAt = (event: SessionEvent, messageId?: string) => canonicalSource !== undefined && canonicalSource.eventSeq === event.seq
      ? { ...canonicalSource, ...(messageId === undefined ? {} : { messageId }) }
      : cut.sessionCreatedAt === undefined
      ? { kind: 'message' as const, hostSessionId: cut.hostSessionId, messageId: messageId ?? `event:${event.seq}` }
      : mintNativeProjectSource({ projectId, sessionId: cut.sessionId, hostSessionId: cut.hostSessionId, sessionCreatedAt: cut.sessionCreatedAt, formatVersion: cut.formatVersion ?? 4 }, event, event, messageId === undefined ? {} : { messageId })
    const add = (event: SessionEvent, message: Record<string, unknown> | undefined, text: string, identity: string, role: 'user' | 'assistant', item?: Partial<Pick<NativeProjectSourceItem, 'source' | 'speaker' | 'partial' | 'limitations'>>, range?: { start: number; end: number }) => {
      if (!text) return
      const source = message?.source as Record<string, unknown> | undefined
      const messageId = typeof message?.id === 'string' ? message.id : undefined
      const entry: Entry = { source: locatorAt(event, messageId), sessionId: cut.sessionId, seq: event.seq, identity, text, role, time: event.time,
        speaker: item?.speaker ?? (role === 'assistant' ? 'assistant' : source?.kind === 'user' ? 'user' : 'unknown'),
        ...(item?.source === undefined ? source === undefined ? {} : { producer: source as never } : { producer: item.source }),
        ...(item?.partial ? { partial: true as const } : {}), ...(item?.limitations === undefined ? {} : { limitations: item.limitations }),
        ...(range === undefined ? {} : { visibleRange: range }), processed: event.seq <= processedSeq }
      entries.push(entry)
      return entry
    }
    let changed = false
    for (const event of events) {
      if (event.seq !== this.endSeq + 1) throw new Error('需要连续的真实日志增量。')
      this.endSeq = event.seq
      if (!isMemoryProjectionEvent(event)) continue
      changed = true
      if (event.type === 'projects/assistant-settlement') { this.settleLink(event); continue }
      // Metadata projection never visits ignored request/tool payloads.
      const native = new Map((event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'agent/inbox/spliced' ? projectVisibleNativeEvents(cut.hostSessionId, [event]) : []).map(entry => [nativeMessageKey(entry.item.seq, entry.item.messageId), entry.item]))
      if (event.type === 'turn/start') this.turn = { number: event.data.turn, inputs: new Set() }
      const envelope = event as unknown as { type: string; data: Record<string, unknown>; surfaceOp?: unknown }
      const messages = event.type === 'user/message' && event.surfaceOp === 'append' ? [event.data]
        : envelope.type === 'agent/inbox/spliced' && Array.isArray(envelope.data.inserted) ? envelope.data.inserted : []
      const queued: { id: string; entry?: (typeof entries)[number] }[] = []
      if (envelope.type === 'agent/inbox/spliced') {
        const queue = inbox.get(String(envelope.data.target))
        if (queue === undefined) throw new Error('未知原生Inbox目标。')
        const start = Number(envelope.data.start), count = Number(envelope.data.removedCount ?? 0)
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 0 || start + count > queue.length) throw new Error('原生Inbox历史范围不完整。')
        const removed = queue.splice(start, count)
        if (envelope.data.outcome === 'canceled') for (const old of removed) {
          if (old.entry === undefined) continue
          const status = messages.some(message => String((message as Record<string, unknown>).id) === old.id) ? 'superseded' as const : 'withdrawn' as const
          old.entry.inputState = status
          this.remove(old.entry)
          if (event.seq > processedSeq) changes.push({ source: locatorAt(event, old.id), previousSource: old.entry.source, status })
        }
      }
      for (const raw of messages) {
        const message = raw as Record<string, unknown>
        const queuedItem: { id: string; entry?: (typeof entries)[number] } = { id: String(message.id) }
        queued.push(queuedItem)
        const source = message.source as Record<string, unknown> | undefined
        if (!source || source.kind === 'runtime-context' || source.kind === 'agent-instructions' || typeof source.form === 'string') continue
        if (source.kind === 'project-delivery' && (source.projectId !== projectId || typeof source.deliveryId !== 'string')) continue
        const text = visibleText(message.content), id = String(message.id), digest = nativeSourceDigest(message.content ?? [])
        const previous = inputs.get(id)
        const identity = source.kind === 'project-delivery' ? `delivery:${projectId}:${source.deliveryId}:${digest}`
          : previous?.digest === digest ? previous.identity : `input:${cut.hostSessionId}:${event.seq}:${id}`
        inputs.set(id, { digest, identity })
        if (event.type === 'user/message') this.turn?.inputs.add(identity)
        const entry = add(event, message, text, identity, 'user', native.get(nativeMessageKey(event.seq, typeof message.id === 'string' ? message.id : undefined)))
        if (entry !== undefined) {
          entry.inputState = event.type === 'user/message' ? 'consumed' : 'accepted'
          const previousEntry = inputEntries.get(id)
          if (event.type === 'user/message' && previous?.digest === digest && previousEntry !== undefined) {
            previousEntry.inputState = 'consumed'; previousEntry.consumedSource = entry.source
          }
          inputEntries.set(id, entry)
        }
        if (entry !== undefined) queuedItem.entry = entry
      }
      if (envelope.type === 'agent/inbox/spliced') inbox.get(String(envelope.data.target))!.splice(Number(envelope.data.start), 0, ...queued)
      if (envelope.type === 'assistant/progress' || envelope.type === 'projects/assistant-progress' || envelope.type === 'assistant/attempt' || event.type === 'assistant/message' && event.surfaceOp === 'append') {
        const data = envelope.data
        const message = event.type === 'assistant/message' ? event.data.message as unknown as Record<string, unknown> : undefined
        const attempt = typeof data.attemptId === 'string' ? data.attemptId : `settlement:${event.seq}`
        const previous = attempts.get(attempt) ?? { end: 0, text: textBaseline(''), processedText: textBaseline(''), processedEnd: 0 }
        const end = previous.end
        const stream = Array.isArray(data.stream) ? expandAssistantStream(data.stream as AssistantStreamRecord[]) : []
        const progress = envelope.type === 'assistant/progress' || envelope.type === 'projects/assistant-progress'
        const from = progress ? Number(data.fromIndex) : 0
        const to = progress ? Number(data.toIndex) : stream.length
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to - from !== stream.length) throw new Error('模型进展stream范围不可读。')
        if (from > end) throw new Error('模型进展stream存在未保存缺口。')
        // The shared reader uses the real BlockAssembler for saved progress and
        // attempts. A block-end can authoritatively replace earlier deltas;
        // summing those deltas would count a body that no longer exists.
        const messageId = typeof message?.id === 'string' ? message.id : undefined
        const item = native.get(nativeMessageKey(event.seq, messageId))
        const text = message === undefined ? this.assistantText(envelope.type, attempt, from, to, stream) : visibleText(message.content)
        const source = locatorAt(event, messageId)
        if (previous.source !== undefined && !unprocessedText(text, previous.text).isExtension && event.seq > processedSeq) {
          changes.push({ source, previousSource: previous.source, status: 'superseded' })
        }
        const processedEvent = event.seq <= processedSeq
        // Keep the last processed representation as context for a new suffix.
        if (previous.entry !== undefined && previous.entry.processed === processedEvent) { previous.entry.superseded = true; this.remove(previous.entry) }
        const suffix = unprocessedText(text, previous.processedText)
        const entry = add(event, message, processedEvent ? text : suffix.text,
          `attempt:${cut.hostSessionId}:${attempt}:${event.seq}`, 'assistant', message === undefined ? { source: { kind: 'model' }, speaker: 'assistant', partial: true, limitations: [progress ? '仅为该attempt截至此事件已保存的输出；后续尾部未知。' : '这是未成为成功答复的attempt已有可见内容。'] } : item,
          { start: processedEvent || !suffix.isExtension ? 0 : previous.processedEnd, end: Math.max(end, to) })
        if (!progress) { this.streams.delete(`assistant/progress:${attempt}`); this.streams.delete(`projects/assistant-progress:${attempt}`) }
        attempts.set(attempt, { end: Math.max(end, to), text: textBaseline(text, progress), source, settled: !progress,
          processedText: processedEvent ? textBaseline(text, progress) : progress ? previous.processedText : { length: previous.processedText.length, digest: previous.processedText.digest },
          processedEnd: processedEvent ? Math.max(end, to) : previous.processedEnd,
          ...(entry === undefined ? {} : { entry }) })
      }
      if (event.type === 'turn/end') {
        if (event.data.reason.kind === 'completed' && this.turn?.number === event.data.turn && this.turn.inputs.size > 0) turns.push({ identities: [...this.turn.inputs], processed: event.seq <= processedSeq })
        this.turn = undefined
      }
    }
    if (changed) this.compactProcessed()
  }
}

export function projectPendingMemory(projectId: string, cuts: readonly SavedWorkCut[], processed: readonly MemoryBotCut[], projectionVersion: 1 | 2 = 2): MemoryBotProjection {
  const projector = new MemoryPendingProjector(projectId, processed, projectionVersion), hosts = new Set<string>()
  for (const cut of cuts) {
    if (cut.role === 'memory') continue
    if (hosts.has(cut.hostSessionId)) throw new Error('同一原生会话不能提供两个cut。')
    hosts.add(cut.hostSessionId)
    if (!Number.isSafeInteger(cut.endSeq) || cut.endSeq < -1 || cut.events.length !== cut.endSeq + 1) throw new Error('需要完整、连续的真实已保存日志前缀。')
    projector.append(cut, cut.events, cut.endSeq)
  }
  return projector.projection()
}

function visibleText(content: unknown): string {
  return Array.isArray(content) ? content.flatMap(block => block && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('') : ''
}

function nativeMessageKey(seq: number, messageId?: string): string { return JSON.stringify([seq, messageId ?? null]) }

function textBaseline(text: string, retain = true): TextBaseline { return { ...(retain ? { text } : {}), length: text.length, digest: nativeSourceDigest(text) } }

function unprocessedText(current: string, processed: TextBaseline): { text: string; isExtension: boolean } {
  const prefix = current.slice(0, processed.length)
  const boundary = processed.length > 0 && processed.length < current.length
    && /[\uD800-\uDBFF]/.test(current[processed.length - 1]!) && /[\uDC00-\uDFFF]/.test(current[processed.length]!)
  const isExtension = !boundary && (processed.text === undefined ? nativeSourceDigest(prefix) === processed.digest : prefix === processed.text)
  return { text: isExtension ? detachedSuffix(current, processed.length) : current, isExtension }
}

function unicodeLength(text: string): number { let count = 0; for (const _point of text) count++; return count }

export function isMemoryProjectionEvent(event: Pick<SessionEvent, 'type'>): boolean {
  return event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'user/message' || event.type === 'agent/inbox/spliced'
    || String(event.type) === 'assistant/progress' || event.type === 'projects/assistant-progress' || event.type === 'assistant/attempt' || event.type === 'assistant/message' || event.type === 'projects/assistant-settlement'
}

/** A small new suffix must not keep its entire processed V8 parent string alive. */
function detachedSuffix(text: string, start: number): string {
  if (start === 0) return text
  // UTF-16 preserves even isolated surrogate code units, unlike UTF-8 encoding.
  return Buffer.from(text.slice(start), 'utf16le').toString('utf16le')
}
