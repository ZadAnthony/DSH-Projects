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
*/
// MIT; finite summarizer framing from stock DSH 639ed015397290b3745d163aafe02ffee4aa3f84.
// Native BasicCompactionEngine still owns selection, region transaction and checkpoint commit.
import BasicCompactionEngine, { type BasicCompactionConfig, type ResolvedConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { createProjectCompactionMeter } from './compaction-meter.ts'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { createSystemMessage } from '@deepseek-ai/dsh-llm'
import { renderPrompt, renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import { projectRequestHooks, prepareProjectRequest, commitProjectAuxiliaryDispatch, bindCapturedProjectRequest } from './dispatch.ts'
import { prepareProjectHarness } from './harness.ts'
import { planRequestDispatch, commitRequestPlan } from './projection.ts'
import { isProjectAuxiliaryDispatch, type ProjectRequestPayloadStore, type ProjectRequestPayload } from './records.ts'
import { prepareRuntimeCurrentBlocks, withRuntimeRequestProjection } from './runtime-current.ts'
import { withProjectCallIdentity, preparedProjectImagePricing, preparedProjectConfigurationGeneration } from '../model/capture.ts'
/**
 * Default one-shot summarization and durable checkpoint framing.
 *
 * @module @deepseek-ai/dsh-compaction-basic/summarizer
 */

import type { Context } from '@deepseek-ai/cordis'
import { contentHasImage, BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type {
  ContentBlock, FinishReason, GenerateOptions, Message, RequestMessage, TokenUsage, ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PROJECT_COMPACTION_INSTRUCTION } from '../../prompts/catalog.generated.ts'

interface SummaryConfig {
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
}

/** Tags wrapping the structured summary inside the landed checkpoint node. */
const SUMMARY_OPEN_TAG = '<compacted-summary>'

/**
 * The summarization directive, delivered as the FINAL user message after the
 * replayed conversation rather than as a distinct summarizer system prompt.
 * Keeping the conversation's own system prompt, tools, and message prefix in
 * front of it makes the auxiliary call a genuine prefix of the last routed
 * request, so the provider's KV cache is reused instead of invalidated.
 */
const COMPACTION_INSTRUCTION = PROJECT_COMPACTION_INSTRUCTION

/**
 * The replayed conversation surface the summarizer condenses. Reproducing the
 * last routed request's system prompt, tools, and leading messages verbatim
 * lets the auxiliary call reuse the provider's warm prefix cache; the trailing
 * compaction instruction is then the only novel input.
 */
export interface SummarizationInput {
  /** The conversation's tool schemas, reused for prefix-cache alignment; absent when the request carried none. */
  readonly tools?: readonly ToolSchema[]
  /** The derived system head, when present, followed by the shadowed region in surface order. */
  readonly messages: readonly Message[]
}

/** Safe summary content plus the exact auxiliary call envelope recorded with it. */
export type SummaryResult = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  /** Provider-reported usage for this summarization request. */
  usage?: TokenUsage
} & (
  | {
    /** Complete provider output before the text-only summary projection. */
    rawOutput: ContentBlock[]
    /** Identifies exactly one call through this context's `ctx.llm.stream()`. */
    llmStreamCall: true
  }
  | {
    /** Optional complete output from an unmarked template, remote, or other summarizer. */
    rawOutput?: ContentBlock[]
    /** An unmarked result does not identify a call through this context's LLM seam. */
    llmStreamCall?: never
  }
)

/**
 * Run the default cache-reusing `ctx.llm.stream()` summarization call: replay
 * the conversation prefix, then append the compaction instruction as the final
 * user message so the provider's warm prefix cache is reused.
 * @param ctx - context providing the LLM service.
 * @param config - resolved backend configuration.
 * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
 * @param agent - supplies routed-model history, fallback model, and session id.
 * @param signal - optional cancellation forwarded to the adapter.
 * @returns safe text-only summary blocks and the exact call envelope and output.
 */
export async function summarizeWithLlm(
  ctx: Context,
  config: SummaryConfig,
  input: SummarizationInput,
  agent: Agent,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  const latest = agent.session.requestHeader()?.config
  const configured = config.summarizationProvider.length === 0
    ? undefined
    : { provider: config.summarizationProvider, model: config.summarizationModel }
  const agentTarget = agent.options.provider !== undefined
    && agent.options.provider.length > 0
    && agent.options.model !== undefined
    && agent.options.model.length > 0
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined
  const target = configured ?? latest ?? agentTarget
  if (target === undefined) {
    throw new Error(
      'no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields',
    )
  }

  const abort = signal ?? new AbortController().signal
  const start = agent.session.snapshotEvents().findLast(event=>event.type==='compaction/start')
  if(start?.type!=='compaction/start')throw new Error('Projects compaction requires its actual native transaction')
  const attempt=agent.session.snapshotEvents().filter(event=>isProjectAuxiliaryDispatch(event)&&event.data.compactionId===start.data.compactionId).length+1
  const hooks=projectRequestHooks(agent)
  const turn=start.data.turn??0
  const step=agent.session.snapshotEvents().findLast(event=>event.type==='step/start')?.data.step??0
  const lease=await hooks?.beforePrepare?.({agent,turn,step,attempt,signal:abort})
  const assembler = new BlockAssembler()
  let options!:GenerateOptions
  try {
    const call=await ctx.llm.prepareCall({provider:target.provider,model:target.model,maxTokens:config.maxTokens},abort)
    const prepareInput={agent,turn,step,attempt,signal:abort,purpose:'compaction' as const,config:call.config,context:call.context}
    const prepared=hooks?.prepare?await prepareProjectRequest(hooks,prepareInput):await prepareProjectHarness(prepareInput)
    const assembly=await agent.ctx.systemPrompt.assemble(assembleContextFor(agent,abort))
    const sections=renderContextSections(assembly)
    const selectedIds=new Set(input.messages.map(message=>message.id))
    const allowed=prepared.historySeqs===undefined?undefined:new Set(prepared.historySeqs)
    const historySeqs=agent.session.surface.nodes.filter(seq=>{
      const event=agent.session.eventAt(seq),message=event?deriveEventMessage(event):null
      return message!==null&&selectedIds.has(message.id)&&(allowed===undefined||allowed.has(seq))
    })
    const planning={owner:{purpose:'compaction' as const,compactionId:start.data.compactionId,attempt},header:{config:call.config,tools:assembly.tools,adapterDefaults:call.adapterDefaults},toolUpdate:call.toolUpdate,
      historySeqs,system:createSystemMessage([renderPrompt(assembly),prepared.currentRequirements].filter(Boolean).join('\n\n')),
      currentBlocks:[...(prepared.currentBlocks??[]),...prepareRuntimeCurrentBlocks(agent.session,sections)],historyProjection:withRuntimeRequestProjection(prepared.historyProjection,sections),
      sourcedHistory:prepared.sourcedHistory,inputPolicy:prepared.inputPolicy,
      suffix:[deepFreeze({role:'user' as const,content:[{type:'text' as const,text:COMPACTION_INSTRUCTION}]})],allowNewOmissions:'pressure' as const}
    let plan=planRequestDispatch(agent.session,planning)
    if(prepared.projectCandidate){
      const changes=await prepared.projectCandidate({candidate:plan,signal:abort,contextWindow:call.context?.contextWindow,reservedOutputTokens:call.config.maxTokens??0,
        imageRequestPricing:preparedProjectConfigurationGeneration(call)!==undefined?preparedProjectImagePricing(call):ctx.llm.imageRequestPricing(call.config.provider,call.config.model)})
      if(changes.length>0||agent.session.seq!==plan.baseRevision) plan=planRequestDispatch(agent.session,{...planning,contentProjection:changes})
    }
    const context=commitRequestPlan(agent.session,plan)
    const candidate:GenerateOptions={...call.config,messages:plan.messages.map(item=>item.message),...plan.envelope.tools===undefined?{}:{tools:plan.envelope.tools},...plan.toolHistory===undefined?{}:{toolHistory:plan.toolHistory},sessionId:agent.id,signal:abort,purpose:'compaction'}
    let captured: ProjectRequestPayload | undefined
    const dispatch=commitProjectAuxiliaryDispatch(agent.session,candidate,{compactionId:start.data.compactionId,attempt},context,lease?.preset,agent.ctx.sessionPersistence as unknown as ProjectRequestPayloadStore,value=>{captured=value})
    if(!await agent.ctx.sessions.flush(agent.session))throw new Error('Projects compaction has no durable Session writer')
    if(captured===undefined)throw new Error('PROJECT_REQUEST_CAPTURE_UNAVAILABLE')
    options=bindCapturedProjectRequest(captured.request,agent.session,abort)
    await withProjectCallIdentity(agent,{dispatchId:dispatch.data.dispatchId,attemptId:`${start.data.compactionId}:${attempt}`,role:prepared.role,turn,step,attempt},async()=>{
      for await(const chunk of call.stream(options))assembler.push(chunk)
    })
  } finally {
    try { await agent.ctx.sessions.flush(agent.session) } finally { await lease?.[Symbol.asyncDispose]() }
  }
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error

  const rawOutput = assembler.blocks()
  const summary = summaryText(rawOutput)
  if (!summary.some(block => block.text.trim().length > 0)) {
    throw new Error('summarization produced no text summary content')
  }
  return {
    summary,
    rawOutput,
    llmStreamCall: true,
    provider: options.provider,
    model: options.model,
    maxTokens: config.maxTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}

/** Map a terminal summarization finish to its fail-closed error. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      return new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    }
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/** Reject visual output and keep only text before synthesizing a user message. */
function summaryText(
  blocks: readonly ContentBlock[],
): Array<Extract<ContentBlock, { type: 'text' }>> {
  if (contentHasImage(blocks)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
}

/** Only request preparation is Projects-owned; the native region algorithm remains in use. */
export class ProjectsCompactionEngine extends BasicCompactionEngine {
  // Projects owns replacement of the complete immutable policy. The inherited
  // native engine and its retry state remain mounted; no frozen object mutates.
  declare config: ResolvedConfig
  private readonly requestMeter: ReturnType<typeof createProjectCompactionMeter>
  private requestBudget?: (agent: Agent, signal: AbortSignal) => Promise<{ maxTokens: number; headroomTokens: number } | undefined>
  private operationDepth = 0
  private pendingBudget?: { maxTokens: number; headroomTokens: number }
  constructor(ctx: Context, config: BasicCompactionConfig = {}) {
    const requestMeter = createProjectCompactionMeter(ctx)
    super(ctx.extend({ tokenMeter: requestMeter.meter }), config)
    this.requestMeter = requestMeter
  }
  override async compactIfNeeded(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal) {
    if (this.requestBudget !== undefined) {
      const budget = await this.requestBudget(agent, signal)
      signal.throwIfAborted()
      if (budget === undefined) return null
      this.updateRequestBudget(budget)
    }
    return this.withNativePolicy(async () => {
      await this.requestMeter.prepare(agent, signal)
      return super.compactIfNeeded(agent, trigger, signal)
    })
  }
  /** Bot-only capacity refresh, before native policy selection and pressure. */
  setRequestBudgetResolver(resolve: NonNullable<ProjectsCompactionEngine['requestBudget']>): void {
    this.requestBudget = resolve
  }
  /** Replace only the bot's summary cap and headroom, retaining native policy. */
  updateRequestBudget(budget: { maxTokens: number; headroomTokens: number }): void {
    if (!Number.isSafeInteger(budget.maxTokens) || budget.maxTokens < 1
      || !Number.isSafeInteger(budget.headroomTokens) || budget.headroomTokens < 0) throw new Error('Invalid Project compaction request budget')
    if (this.operationDepth > 0) {
      this.pendingBudget = { maxTokens: budget.maxTokens, headroomTokens: budget.headroomTokens }
      return
    }
    this.config = deepFreeze({ ...this.config, ...budget })
  }
  /** One native operation may call nested regions and run multiple summaries. */
  private async withNativePolicy<T>(action: () => Promise<T>): Promise<T> {
    this.operationDepth++
    try { return await action() }
    finally {
      this.operationDepth--
      if (this.operationDepth === 0 && this.pendingBudget !== undefined) {
        const pending = this.pendingBudget
        this.pendingBudget = undefined
        this.updateRequestBudget(pending)
      }
    }
  }
  override async compactRegion(start: SessionSeq, end: SessionSeq, agent: Agent, signal?: AbortSignal) {
    return this.withNativePolicy(async () => {
      await this.requestMeter.prepare(agent, signal)
      return super.compactRegion(start, end, agent, signal)
    })
  }
  override async compactNow(agent: Agent, signal: AbortSignal, sourceCommandId?: CommandId) {
    return this.withNativePolicy(async () => {
      await this.requestMeter.prepare(agent, signal)
      return super.compactNow(agent, signal, sourceCommandId)
    })
  }
  protected override summarize(input:SummarizationInput,agent:Agent,signal?:AbortSignal):Promise<SummaryResult>{
    const latest=agent.session.requestHeader()?.config
    const route=latest??agent.options
    const override=this.config.modelPolicies.find(policy=>policy.provider===route.provider&&policy.model===route.model)
    return summarizeWithLlm(this.ctx,{summarizationProvider:override?.summarizationProvider??this.config.summarizationProvider,summarizationModel:override?.summarizationModel??this.config.summarizationModel,maxTokens:override?.maxTokens??this.config.maxTokens},input,agent,signal)
  }
}
export default ProjectsCompactionEngine
