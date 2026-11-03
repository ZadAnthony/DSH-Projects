import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-plan-mode'

/** Resolve this Agent's retained preset owner, including its isolated planning group. */
export function projectPlanModeOwner(agent: Pick<Agent, 'ctx'>) {
  return agent.ctx.get('agentPresets')?.serviceFor(agent, 'planMode') ?? agent.ctx.get('planMode')
}
