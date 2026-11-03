/** Numeric view of the last actual request and its legal tail for native compaction. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { headerEquals, type EpochHeader, type Session, type SessionSeq } from '@deepseek-ai/dsh-session'
import type { TokenMeter, TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { priceProjectRequestInput } from './meter.ts'
import { currentProjectDispatchCapture, isProjectConversationDispatch, latestProjectDispatch, readProjectDispatch } from './records.ts'
import type { ConversationDispatchEvent, ProjectRequestPayload, ProjectRequestPayloadStore } from './records.ts'

interface NodePrice { tokens: number; nativeTokens: number }
interface RequestPrices {
  dispatchId: string; dispatchSeq: number; prefixLength: number; turn: number; step: number
  header: EpochHeader
  fixedTokens: number
  nodes: Map<SessionSeq, NodePrice>
  usageExtra: number
}

/** The view is private to one compaction engine; it never replaces the graph's native meter. */
export function createProjectCompactionMeter(ctx: Context): { meter: TokenMeter; prepare(agent: Agent, signal?: AbortSignal): Promise<void> } {
  const native = ctx.tokenMeter
  const states = new WeakMap<Session, RequestPrices>()
  const measure = (session: Session, header?: Parameters<TokenMeter['measure']>[1]): TokenMeasurement => {
    const raw = native.measure(session, header), state = states.get(session)
    const effectiveHeader = header ?? session.requestHeader()
    if (state === undefined || effectiveHeader === undefined || !headerEquals(state.header, effectiveHeader)) return raw
    let surfaceTokens = 0
    const nodes = raw.nodes.map(node => {
      const previous = state.nodes.get(node.seq)
      // Native repricing (for example image offload) remains a signed delta on
      // the exact retained occurrence. Replacements and later inputs are tail.
      const tokens = node.seq >= state.prefixLength ? node.tokens : previous === undefined ? 0
        : Math.max(0, previous.tokens + node.tokens - previous.nativeTokens)
      surfaceTokens += tokens
      // Native shadow accounting still names the complete original surface;
      // only the request price changes, not its durable heuristic receipt.
      return { ...node, tokens }
    })
    const totalTokens = state.fixedTokens + surfaceTokens + state.usageExtra
    return deepFreeze({ ...raw, baseline: { kind: 'estimated' as const, tokens: totalTokens }, surfaceDeltaTokens: 0, totalTokens, surfaceTokens, nodes })
  }
  const capture = (session: Session, event: ConversationDispatchEvent, payload: ProjectRequestPayload): void => {
    const context = payload.context
    if (context === undefined) { states.delete(session); return }
    const headerEvent = context.envelope.kind === 'header' ? session.eventAt(context.envelope.headerSeq) : undefined
    const header = context.envelope.kind === 'inline' ? context.envelope.header
      : headerEvent?.type === 'request/header' ? headerEvent.data.header : undefined
    if (header === undefined) throw new Error('Project compaction request header is unavailable')
    const raw = native.measure(session), rawNodes = new Map(raw.nodes.map(node => [node.seq, node.tokens]))
    const prices = priceProjectRequestInput({ ctx }, { ...payload.request, toolUpdate: context.toolUpdate }, ctx.llm.imageRequestPricing(payload.request.provider, payload.request.model))
    const current = new Set(context.currentBlocks.map(block => block.inputIndex))
    const nodes = new Map<SessionSeq, NodePrice>()
    let fixedTokens = prices.toolsTokens
    for (const price of prices.nodes) {
      const origin = context.messages[price.inputIndex]
      // Current supplies return after a region replacement, and literal imports
      // have no native replacement target. Neither is a compressible history gain.
      if (origin?.kind !== 'event' || current.has(price.inputIndex)) { fixedTokens += price.tokens; continue }
      const previous = nodes.get(origin.seq)
      nodes.set(origin.seq, { tokens: (previous?.tokens ?? 0) + price.tokens, nativeTokens: rawNodes.get(origin.seq) ?? 0 })
    }
    states.set(session, { dispatchId: event.data.dispatchId, dispatchSeq: event.seq, prefixLength: event.data.prefixLength,
      turn: event.data.turn, step: event.data.step, header, fixedTokens, nodes, usageExtra: 0 })
  }
  const anchorUsage = (session: Session, event: ReturnType<Session['eventAt']>): void => {
    const state = states.get(session)
    if (state === undefined || event?.type !== 'assistant/message' || event.seq <= state.dispatchSeq
      || event.data.turn !== state.turn || event.data.step !== state.step || event.data.usage === undefined) return
    const usage = event.data.usage
    const total = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens
    state.usageExtra = 0
    state.usageExtra = Math.max(0, total - measure(session).totalTokens)
  }
  ctx.on('session/event', (session, event) => {
    // This is an optional warm numeric cache. A failed price must not turn a
    // saved request/output into a failed append; prepare retries at the read boundary.
    try {
      if (isProjectConversationDispatch(event)) {
        const payload = currentProjectDispatchCapture(session, event)
        if (payload === undefined) states.delete(session); else capture(session, event, payload)
      } else anchorUsage(session, event)
    } catch { states.delete(session) }
  })
  const meter = Object.assign(Object.create(native) as TokenMeter, { measure })
  return { meter, async prepare(agent, signal) {
    signal?.throwIfAborted()
    const event = latestProjectDispatch(agent.session)
    if (event === undefined) { states.delete(agent.session); return }
    if (states.get(agent.session)?.dispatchId === event.data.dispatchId) return
    // Cold restoration reads only the latest request once and retains numbers;
    // no complete request body becomes a compaction cache.
    const payload = await readProjectDispatch(agent.session, event, agent.ctx.sessionPersistence as unknown as ProjectRequestPayloadStore, signal)
    signal?.throwIfAborted()
    capture(agent.session, event, payload)
    for (let seq = Number(event.seq) + 1; seq < agent.session.seq; seq++) anchorUsage(agent.session, agent.session.eventAt(seq as SessionSeq))
  } }
}
