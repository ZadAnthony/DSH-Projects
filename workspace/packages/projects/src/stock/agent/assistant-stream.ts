/*!
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Adapted from DeepSeek DSH 639ed015397290b3745d163aafe02ffee4aa3f84
packages/core/agent-loop/src/assistant-stream.ts
*/
// MIT; adapted from DeepSeek DSH 639ed015397290b3745d163aafe02ffee4aa3f84 packages/core/agent-loop/src/assistant-stream.ts
/** Process-local assistant attempt framing and durable stream accumulation. */

import {
  AssistantStreamAccumulator,
  BlockAssembler,
  LlmAttemptId,
  type AssistantStreamRecord,
  type ContentBlock,
  type FinishReason,
  type ReplayEnvelope,
  type StreamChunk,
  type TokenUsage,
  type TimedStreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEventMap, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { appendProjectRecording, flushProjectRecording, type ProjectStreamRecording } from '../recording/index.ts'

/** Folds one model attempt into one compact stream plus ordered transient frames. */
export class AssistantStreamAttempt {
  private readonly accumulator = new AssistantStreamAccumulator()
  private readonly assembler = new BlockAssembler()
  private index = 0
  private terminal = false
  private readonly progress: AssistantProgressRecorder | undefined
  /** Attempt identity unique within this Agent lifecycle. */
  readonly attemptId: LlmAttemptId

  /** Whether this started attempt has emitted its terminal frame. */
  get ended(): boolean { return this.terminal }

  /**
   * @param sessionId - identity embedded only in the Agent-lifecycle-local attempt id.
   * @param attempt - attached-Session-local attempt counter.
   * @param nextRevision - allocates the next emitted frame revision.
   * @param turn - durable turn owning the request.
   * @param step - durable step owning the request.
   * @param emit - agent-scoped notification publisher.
   */
  constructor(
    sessionId: SessionId,
    attempt: number,
    private readonly nextRevision: () => number,
    readonly turn: number,
    readonly step: number,
    private readonly emit: (frame: AssistantStreamFrame) => void,
    recording?: ProjectStreamRecording,
  ) {
    this.attemptId = LlmAttemptId(recording === undefined ? `${sessionId}:${attempt}` : `${sessionId}:${recording.session.seq}:${attempt}`)
    if (recording !== undefined) this.progress = new AssistantProgressRecorder(recording, this.attemptId, turn, step)
  }

  /** Publish the opening marker before the first delivered chunk. */
  start(): void {
    this.emit({
      type: 'start',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      turn: this.turn,
      step: this.step,
    })
  }

  /** Snapshot one chunk once, then feed durable compaction, assembly, and live publication. */
  push(chunk: StreamChunk): void {
    const timed = this.accumulator.push({ time: Date.now(), chunk })
    this.progress?.push(timed)
    this.assembler.push(timed.chunk)
    this.emit({
      type: 'chunk',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.index++,
      time: timed.time,
      chunk: timed.chunk,
    })
  }

  /**
   * Publish terminal settlement after the matching durable event commits.
   * @param eventType - durable settlement type.
   * @param append - synchronous durable append returning its committed seq.
   */
  async settle(
    eventType: 'assistant/message' | 'assistant/attempt',
    append: () => SessionSeq,
  ): Promise<void> {
    let seq: SessionSeq
    try {
      await this.progress?.checkpoint(true)
      seq = append()
      await this.progress?.confirmSettlement(eventType, seq)
    } catch (error: unknown) {
      this.abandon()
      throw error
    }
    this.terminal = true
    this.emit({
      type: 'end',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.index,
      outcome: { kind: 'committed', eventType, seq },
    })
  }

  /** Publish abandonment when no durable attempt event can be committed. */
  abandon(): void {
    this.progress?.dispose()
    this.terminal = true
    this.emit({
      type: 'end',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.index,
      outcome: { kind: 'abandoned' },
    })
  }

  /** Await size checkpoint; timed failures stay sticky and outrank abort fallout. */
  async checkpoint(): Promise<void> { await this.progress?.checkpoint(false) }
  get recordingError(): unknown { return this.progress?.error }

  /** Exact compact stream for the final durable event. */
  get stream(): SessionEventMap['assistant/attempt']['stream'] {
    return [...this.accumulator.snapshot()] as AssistantStreamRecord[]
  }

  /** Canonical completed-message blocks from the same chunks. */
  blocks(): ContentBlock[] {
    return this.assembler.blocks()
  }

  /** Safe visible prefix when cancellation interrupts the attempt. */
  interruptedBlocks(): ContentBlock[] {
    return this.assembler.interruptedBlocks()
  }

  /** Latest adapter-reported usage in the stream. */
  get usage(): TokenUsage | undefined {
    return this.assembler.usage
  }

  /** Terminal reason, defaulting to stop when the stream omitted one. */
  get finish(): FinishReason {
    return this.assembler.finish
  }

  /** Replay state carried by the terminal finish record. */
  get replayState(): ReplayEnvelope | undefined {
    return this.assembler.replayState
  }
}

/** One bounded pending chunk batch over the native writer's flush barrier. */
class AssistantProgressRecorder {
  private accumulator = new AssistantStreamAccumulator()
  private bytes = 0
  private fromIndex = 0
  private toIndex = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<void> | undefined
  error: unknown

  constructor(
    private readonly recording: ProjectStreamRecording,
    private readonly attemptId: LlmAttemptId,
    private readonly turn: number,
    private readonly step: number,
  ) {}

  push(timed: TimedStreamChunk): void {
    if (this.error !== undefined) throw this.error
    this.accumulator.push(timed)
    this.bytes += Buffer.byteLength(JSON.stringify(timed))
    this.toIndex++
    this.timer ??= setTimeout(() => {
      this.timer = undefined
      void this.checkpoint(true).catch(error => { this.fail(error) })
    }, this.recording.policy.streamCheckpointIntervalMs)
  }

  async checkpoint(force: boolean): Promise<void> {
    if (this.error !== undefined) throw this.error
    if (this.pending !== undefined) await this.pending
    if (this.error !== undefined) throw this.error
    if (this.fromIndex === this.toIndex || (!force && this.bytes < this.recording.policy.streamCheckpointBytes)) return
    this.dispose()
    const fromIndex = this.fromIndex
    const toIndex = this.toIndex
    const stream = [...this.accumulator.snapshot()]
    this.accumulator = new AssistantStreamAccumulator()
    this.bytes = 0
    this.fromIndex = toIndex
    try {
      appendProjectRecording(this.recording.session, this.recording.persistence, 'projects/assistant-progress', {
        turn: this.turn, step: this.step, attemptId: this.attemptId, fromIndex, toIndex, stream,
      })
      const pending = flushProjectRecording(this.recording.persistence)
      this.pending = pending
      await pending
      if (this.pending === pending) this.pending = undefined
    } catch (error: unknown) {
      this.fail(error)
      throw error
    }
  }

  async confirmSettlement(eventType: 'assistant/message' | 'assistant/attempt', eventSeq: SessionSeq): Promise<void> {
    try {
      appendProjectRecording(this.recording.session, this.recording.persistence, 'projects/assistant-settlement', { attemptId: this.attemptId, eventType, eventSeq })
      await flushProjectRecording(this.recording.persistence)
    }
    catch (error: unknown) { this.fail(error); throw error }
    finally { this.dispose() }
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private fail(error: unknown): void {
    if (this.error !== undefined) return
    this.error = error
    this.dispose()
    this.recording.failed(error)
  }
}
