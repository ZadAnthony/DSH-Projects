import {preparedProjectImagePricing,preparedProjectConfigurationGeneration} from '../model/capture.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { createSystemMessage } from '@deepseek-ai/dsh-llm'
import { renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { prepareProjectHarness } from './harness.ts'
import { planRequestDispatch } from './projection.ts'
import { prepareRuntimeCurrentBlocks, withRuntimeRequestProjection } from './runtime-current.ts'

/** Prepare the same complete role-owned input without admitting input or issuing a model call. */
export async function previewProjectRequest(agent: Agent, signal: AbortSignal) {
  if (!agent.options.provider || !agent.options.model) throw new Error('Prepared Project route is unavailable')
  const call = await agent.ctx.llm.prepareCall({ ...agent.options, provider: agent.options.provider, model: agent.options.model }, signal)
  const prepared = await prepareProjectHarness({ agent, purpose: 'conversation', turn: 1, step: 1, attempt: 1, config: call.config, context: call.context, signal })
  const assembly = await agent.ctx.systemPrompt.assemble(assembleContextFor(agent, signal))
  const sections = renderContextSections(assembly)
  const input = {
    owner: { purpose: 'conversation' as const, turn: 1, step: 1, attempt: 1 },
    header: { config: call.config, tools: assembly.tools, adapterDefaults: call.adapterDefaults },
    system: createSystemMessage([renderPrompt(assembly), prepared.currentRequirements].filter(Boolean).join('\n\n')),
    currentBlocks: [...(prepared.currentBlocks ?? []), ...prepareRuntimeCurrentBlocks(agent.session, sections)],
    historyProjection: withRuntimeRequestProjection(prepared.historyProjection, sections),
    historySeqs: prepared.historySeqs,
    sourcedHistory: prepared.sourcedHistory,
    inputPolicy: prepared.inputPolicy,
    toolUpdate: call.toolUpdate,
  }
  let candidate = planRequestDispatch(agent.session, input)
  if (prepared.projectCandidate) {
    const changes = await prepared.projectCandidate({ candidate, signal, contextWindow: call.context?.contextWindow,
      reservedOutputTokens: call.config.maxTokens ?? 0,
      imageRequestPricing: preparedProjectConfigurationGeneration(call)!==undefined?preparedProjectImagePricing(call):agent.ctx.llm.imageRequestPricing(call.config.provider, call.config.model) })
    if (changes.length > 0 || agent.session.seq !== candidate.baseRevision) candidate = planRequestDispatch(agent.session, { ...input, contentProjection: changes })
  }
  signal.throwIfAborted()
  return candidate
}
