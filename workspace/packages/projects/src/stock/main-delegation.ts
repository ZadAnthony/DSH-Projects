/** Main sessions coordinate durable Projects sessions, never native subagents. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import * as NativeSubagentTool from '@deepseek-ai/dsh-tool-subagent'
import { projectPresetTrees } from './preset-snapshot.ts'

const mainAgents = new WeakSet<Agent>()
const nativeControlNames = ['subagent', 'subagent_fork', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent', 'workflow']

/**
 * Native model-selection/preset-aware delegation installs Agent-owned tools,
 * which tools.restrict() intentionally cannot mask. Use the native supported
 * per-Session apply entry point only for non-main Agents instead. Every child
 * option, schema, model-selection policy and provider lifecycle remains native.
 */
export const ProjectsSubagentTool = {
  name: NativeSubagentTool.name,
  Config: NativeSubagentTool.Config,
  inject: [...NativeSubagentTool.inject, 'agents'],
  apply(ctx: Context, config: NativeSubagentTool.Config): void {
    const composition = scopeOf(ctx)
    if (composition === undefined) throw new Error('Projects native delegation requires a standing preset scope.')
    const installations = new Map<Agent, Fiber>()
    const installing = new WeakSet<Agent>()
    const belongs = (agent: Agent): boolean => !mainAgents.has(agent) && scopeChainOf(scopeOf(agent.ctx)).includes(composition)
    const remove = (agent: Agent): void => {
      const fiber = installations.get(agent)
      if (fiber === undefined) return
      installations.delete(agent)
      void fiber.dispose().catch(error => ctx.logger.warn('projects: native delegation scope disposal failed', error))
    }
    const install = (agent: Agent): Fiber | undefined => {
      if (!belongs(agent)) { remove(agent); return }
      const existing = installations.get(agent)
      if (existing !== undefined) return existing
      if (installing.has(agent)) return
      installing.add(agent)
      try {
        const fiber = agent.ctx.inject(NativeSubagentTool.inject, nativeCtx => NativeSubagentTool.apply(nativeCtx, config, agent.session))
        installations.set(agent, fiber)
        return fiber
      } finally { installing.delete(agent) }
    }
    ctx.on('agent/created', async ({ agent }) => { await install(agent) })
    ctx.on('agent/disposed', ({ agent }) => { remove(agent) })
    ctx.on('tools/change', () => { for (const agent of ctx.agents.list()) install(agent) })
    ctx.effect(() => () => { for (const agent of installations.keys()) remove(agent) }, 'projects.native-delegation-composition')
    for (const agent of ctx.agents.list()) install(agent)
  },
}

/** Install before Agent publication, for normal creation, recovery and relay. */
export function installMainDelegationPolicy(agent: Agent): () => void {
  mainAgents.add(agent)
  const disposers: (() => void)[] = []
  const names = new Set(nativeControlNames)
  const restricted = new Set<string>()
  const hiddenSections = new Set<string>()
  let refreshing = false, disposed = false
  const refresh = (): void => {
    if (refreshing || disposed) return
    refreshing = true
    try {
      // Read the actual selected native declarations, including custom tool
      // names and nested Includes, rather than matching business prose.
      for (const key of scopeChainOf(scopeOf(agent.ctx))) for (const tree of projectPresetTrees(agent.ctx, key)) {
        for (const entry of tree.entries()) {
          if (entry.options.name !== '@deepseek-ai/dsh-tool-subagent'
            && entry.options.name !== '@deepseek-ai/dsh-tool-workflow'
            && (!('projectsSourceModule' in entry.options)
              || entry.options.projectsSourceModule !== '@deepseek-ai/dsh-tool-subagent')) continue
          const name = entry.options.config?.toolName
          if (typeof name === 'string' && name.length > 0) names.add(name)
        }
      }
      for (const name of names) {
        if (!hiddenSections.has(name)) {
          hiddenSections.add(name)
          disposers.push(agent.ctx.systemPrompt.section({ name: `tool:${name}`, order: 0, text: '' }))
        }
        if (!restricted.has(name) && agent.ctx.tools.get(name, agent) !== undefined) {
          // Reserve before restrict() emits tools/change synchronously. Missing
          // optional tools are not named: native restrict rejects unknown names.
          restricted.add(name)
          disposers.push(agent.ctx.tools.restrict({ deny: [name] }))
        }
      }
    } finally { refreshing = false }
  }
  disposers.push(agent.ctx.on('tools/change', refresh))
  refresh()
  return agent.ctx.effect(() => () => {
    disposed = true
    for (const dispose of disposers.toReversed()) dispose()
  }, 'projects.main-delegation-policy')
}
