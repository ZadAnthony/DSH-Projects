/** One native compactor per dedicated bot, with request-owned capacity budgets. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig, LlmModelContext } from '@deepseek-ai/dsh-llm'
import { ProjectsCompactionEngine } from './compaction.ts'
import { onProjectRequestPrepare } from './harness.ts'

export function installBotCompaction(ctx: Context, agent: Agent, options: {
  name: 'Memory' | 'Manager'
  checkpoint: () => string
}): void {
  let engine: ProjectsCompactionEngine | undefined
  let installing: Promise<ProjectsCompactionEngine> | undefined
  let warned = false
  const warn = (message: string) => {
    if (!warned) ctx.logger.warn(`${options.name} compaction ${message}; retaining the original request/error`)
    warned = true
  }
  const budgetFor = (route: LlmCallConfig, context: LlmModelContext | undefined) => {
    const available = context === undefined ? undefined : context.contextWindow - (route.maxTokens ?? 0)
    if (available === undefined || available < 16) {
      warn('has no declared usable model context budget')
      return undefined
    }
    // Keep the existing bot budget ratio. Native policy owns pressure,
    // retention, transaction boundaries and retry admission.
    const tokens = Math.min(4096, route.maxTokens ?? 4096, Math.floor(available / 16))
    return { maxTokens: tokens, headroomTokens: tokens }
  }
  const refresh = async (current: Agent, signal: AbortSignal) => {
    const route = current.session.requestHeader()?.config
    if (route === undefined) return undefined
    try {
      const model = await ctx.llm.resolveModelInfo(route.provider, route.model, signal)
      signal.throwIfAborted()
      // Pressure prices the last actual routed request, including its actual
      // output reservation. The next prepare supplies its newly resolved cap.
      return budgetFor({ ...route, maxTokens: route.maxTokens ?? model.defaultMaxTokens }, model.context)
    } catch (error) {
      signal.throwIfAborted()
      warn(`model metadata unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }
  ctx.effect(() => onProjectRequestPrepare(agent, async (payload, previous) => {
    if (payload.purpose === 'compaction') return { ...previous,
      currentRequirements: [previous?.currentRequirements,
        'Native compaction auxiliary request. Produce only the Markdown checkpoint required by the final compaction instruction; do not call tools or perform normal bot decisions, writes or settlement in this auxiliary request.',
        options.checkpoint()].filter(Boolean).join('\n\n') }
    // Cold/close-only carriers have no prepared route and resolve nothing.
    if (payload.config === undefined) return previous
    const budget = budgetFor(payload.config, payload.context)
    if (budget === undefined) return previous
    if (engine === undefined) {
      installing ??= (async () => {
        const fiber = ctx.isolate('compaction').plugin(ProjectsCompactionEngine, budget)
        await fiber.await()
        const installed = fiber.ctx.compaction
        if (!(installed instanceof ProjectsCompactionEngine)) throw new Error('Project bot compaction engine is unavailable')
        installed.setRequestBudgetResolver(refresh)
        return installed
      })()
      engine = await installing
    }
    payload.signal.throwIfAborted()
    engine.updateRequestBudget(budget)
    return previous
  }))
}
