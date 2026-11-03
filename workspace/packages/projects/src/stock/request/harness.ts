import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentCancelCause } from '@deepseek-ai/dsh-agent'
import type { ContextSnapshotSection, LlmCallConfig, LlmImageRequestPricing, MessageId, RequestMessage, MessageSource } from '@deepseek-ai/dsh-llm'
import type { SessionSeq, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import type { ProjectRequestHooks, ProjectRequestPreparation } from './dispatch.ts'
import type { RequestContentProjection, RequestCurrentBlock, RequestDispatchCandidate, RequestHistoryProjection, RequestInputPolicy, RequestSourcedHistory } from './types.ts'
export type * from './types.ts'
export { planRequestDispatch, readRequestSourcedHistory, getLatestConversationDispatch, deriveRequestDispatch } from './projection.ts'
export { isProjectConversationDispatch, isProjectAuxiliaryDispatch, latestProjectDispatch, readProjectDispatch } from './records.ts'
export { measureProjectRequestCandidate, prepareProjectRequestMeter } from './meter.ts'
export { previewProjectRequest } from './preview.ts'

export interface PreparedRequestContext {
  role?: 'work' | 'memory' | 'manager'
  refresh?: true
  currentRequirements?: string
  currentBlocks?: readonly RequestCurrentBlock[]
  historyProjection?: RequestHistoryProjection
  historySeqs?: readonly SessionSeq[]
  sourcedHistory?: readonly RequestSourcedHistory[]
  inputPolicy?: RequestInputPolicy
  messages?: readonly UserMessage[]
  contextMessageIds?: readonly MessageId[]
  projectCandidate?: (input: { candidate: RequestDispatchCandidate; signal: AbortSignal; contextWindow?: number; reservedOutputTokens: number; imageRequestPricing?: LlmImageRequestPricing }) => Promise<readonly RequestContentProjection[]> | readonly RequestContentProjection[]
}
export type ProjectPrepareInput = Parameters<NonNullable<ProjectRequestHooks['prepare']>>[0] & {
  purpose?: 'conversation' | 'compaction'
  config?: LlmCallConfig
  context?: import('@deepseek-ai/dsh-llm').PreparedLlmCall['context']
}
type Prepare = (input: ProjectPrepareInput, previous: PreparedRequestContext | undefined) => Promise<PreparedRequestContext | undefined> | PreparedRequestContext | undefined
const preparations = new WeakMap<Agent, Set<Prepare>>()
export function onProjectRequestPrepare(agent: Agent, callback: Prepare): () => void {
  let callbacks = preparations.get(agent)
  if (!callbacks) preparations.set(agent, callbacks = new Set())
  callbacks.add(callback)
  const off = () => { callbacks.delete(callback) }
  agent.ctx.effect(() => off)
  return off
}
/** The only role preparation fold; installed scopes are consumed on every real attempt. */
export async function prepareProjectHarness(input: ProjectPrepareInput): Promise<ProjectRequestPreparation & PreparedRequestContext> {
  let prepared: PreparedRequestContext | undefined
  for (const callback of [...(preparations.get(input.agent) ?? [])]) {
    input.signal.throwIfAborted()
    prepared = await callback(input, prepared)
  }
  input.signal.throwIfAborted()
  return { ...prepared, role: prepared?.role ?? 'work' }
}

export interface ProjectTurnSettled {
  readonly agent: Agent
  /** 原轮活动的取消事实；不改写已经保存的 turn/end 结果。 */
  readonly signal: AbortSignal
  readonly turn: number
  readonly startSeq: SessionSeq
  readonly endSeq: SessionSeq
  readonly reason: TurnEndReason
  readonly consumedInputs: readonly { readonly messageId: MessageId; readonly source: MessageSource; readonly eventSeq: SessionSeq }[]
}
type Cancel = { agent: Agent; cause: AgentCancelCause }
type Claimed = { agent: Agent; message: UserMessage; turn: number }
interface Listener<T> { readonly subject: Context | Agent; readonly callback: (value: T) => void }
const settled = new Set<Listener<ProjectTurnSettled>>()
const cancelled = new Set<Listener<Cancel>>()
const claimed = new Set<Listener<Claimed>>()
function listen<T>(set: Set<Listener<T>>, subject: Context | Agent, callback: (value: T) => void): () => void {
  const entry = { subject, callback }; set.add(entry)
  const off = () => { set.delete(entry) }
  const ctx = 'session' in subject ? subject.ctx : subject
  ctx.effect(() => off)
  return off
}
function emit<T extends { agent: Agent }>(set: Set<Listener<T>>, value: T): void {
  for (const { subject, callback } of set) {
    if ('session' in subject ? subject !== value.agent : subject.root !== value.agent.ctx.root) continue
    const report = (error: unknown) => { value.agent.ctx.logger.warn('Projects Harness notification failed: %s', error instanceof Error ? error.message : String(error)) }
    try { const returned: unknown = callback(value); void Promise.resolve(returned).catch(report) }
    catch (error) { report(error) }
  }
}
export function onProjectTurnSettled(subject: Context | Agent, callback: (value: ProjectTurnSettled) => void): () => void { return listen(settled, subject, callback) }
export function onProjectCancelRequested(subject: Context | Agent, callback: (value: Cancel) => void): () => void { return listen(cancelled, subject, callback) }
export function onProjectInboxClaimed(subject: Context | Agent, callback: (value: Claimed) => void): () => void { return listen(claimed, subject, callback) }
export function emitProjectTurnSettled(value: ProjectTurnSettled): void { emit(settled, value) }
export function emitProjectCancelRequested(value: Cancel): void { emit(cancelled, value) }
export function emitProjectInboxClaimed(value: Claimed): void { emit(claimed, value) }
