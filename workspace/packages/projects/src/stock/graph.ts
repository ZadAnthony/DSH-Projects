import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { interpolate } from '@deepseek-ai/cordis-plugin-loader'
import { installProjectAgentFactory, type ProjectAgentFactory, type ProjectAgentFactoryOptions } from './agent/index.ts'
import ProjectSessionPersistence from './persistence/index.ts'
import ProjectToolRuntime from './tools/index.ts'
import { createProjectsHostPorts, installProjectsReadOnlyHostCapabilities, ProjectsLlmRuntime, type ProjectsHostPorts } from './host-ports.ts'
import { ProjectsPresetLoader, type InstalledProjectsPreset } from './presets/loader.ts'
import { ProjectsAgentPresetRegistry, type ProjectsPresetPublication, type ProjectsPresetRequestLease } from './presets/revisions.ts'

export interface ProjectsGraphCloseOwner {
  readonly name: string
  close(): Promise<void>
}

export interface ProjectsRuntimeGraphConfig {
  readonly dataRoot: string
  readonly presetId?: string
  readonly factoryOptions?: ProjectAgentFactoryOptions
  /** Install private native host capabilities before mounting the selected preset. */
  readonly configure?: (ctx: Context, startupSignal: AbortSignal) => void | Promise<void>
  /** Containing façade can cancel a startup lock wait before this graph is returned. */
  readonly startupSignal?: AbortSignal
  readonly afterFactory?: (ctx: Context, factory: ProjectAgentFactory) => void | Promise<void>
  readonly onConfigurationChange?: (result: ProjectsPresetPublication) => void | Promise<void>
  readonly prepareConfiguration?: () => Promise<ProjectsConfigurationTransaction | void>
  readonly shouldMountWorkPreset?: (agent: Agent, parent?: Agent) => boolean | Promise<boolean>
  /** Explicit owner order, before factory handles and persistence are closed. */
  readonly closeOwners?: readonly ProjectsGraphCloseOwner[]
  readonly hostPorts?: ProjectsHostPorts
  /** A containing plugin may own the single ordered façade → graph cleanup. */
  readonly registerRootCleanup?: boolean
}

export interface ProjectsConfigurationTransaction {
  readonly generation: string
  commit(): Promise<void>
  rollback(): Promise<void>
}

export interface ProjectsGraphCloseResult {
  readonly status: 'closed' | 'partial'
  readonly owners: readonly { readonly name: string; readonly status: 'closed' | 'failed'; readonly error?: string }[]
}

/** Internal capability; the root façade must expose only Projects DTOs. */
export interface ProjectsRuntimeGraph {
  readonly ctx: Context
  readonly factory: ProjectAgentFactory
  readonly persistence: ProjectSessionPersistence
  readonly preset: InstalledProjectsPreset
  readonly status: 'ready' | 'closing' | 'closed' | 'failed'
  readonly closeResult: ProjectsGraphCloseResult | undefined
  readonly lastPublication: ProjectsPresetPublication | undefined
  refreshConfiguration(presetId?: string): Promise<ProjectsPresetPublication>
  acquireRequestPreset(agent: Agent): Promise<ProjectsPresetRequestLease | undefined>
  assertReady(): void
  close(): Promise<ProjectsGraphCloseResult>
}

/**
 * One graph per installed plugin/profile, shared by all Projects. Membership
 * is enforced by the factory/persistence owners, not by copying runtime graphs.
 * The root owns exactly one cleanup effect; private providers are never root
 * children, and root Context.extend/isolate is never used for this domain.
 */
export async function createProjectsRuntimeGraph(
  root: Context,
  config: ProjectsRuntimeGraphConfig,
): Promise<ProjectsRuntimeGraph> {
  const ports = config.hostPorts ?? createProjectsHostPorts(root)
  const snapshot = await ports.preset.capture(config.presetId)
  const runtimeConfiguration = ports.runtimeConfiguration?.() ?? { tools: {}, systemPrompt: {} }
  const ctx = new Context()
  const startup = new AbortController()
  const startupSignal = config.startupSignal === undefined ? startup.signal : AbortSignal.any([startup.signal, config.startupSignal])
  ctx.baseUrl = snapshot.tree.baseUrl
  const effectiveRuntimeConfiguration = {
    tools: interpolate(ctx, runtimeConfiguration.tools),
    systemPrompt: interpolate(ctx, runtimeConfiguration.systemPrompt),
  }
  let state: 'starting' | ProjectsRuntimeGraph['status'] = 'starting'
  let factory: ProjectAgentFactory | undefined
  let preset: InstalledProjectsPreset | undefined
  let closeResult: ProjectsGraphCloseResult | undefined
  let closing: Promise<ProjectsGraphCloseResult> | undefined
  let starting: Promise<void> | undefined
  let lastPublication: ProjectsPresetPublication | undefined
  let refreshTail: Promise<unknown> = Promise.resolve()
  const subscriptions: (() => void)[] = []
  const dedicatedAgents = new WeakSet<Agent>()
  const registry = () => ctx.agentPresets as ProjectsAgentPresetRegistry

  const selectedPreset = (agent: Agent): string | undefined => ctx.sessionProjections.stateOf(agent.session, 'agentPreset') ?? undefined
  const refreshConfiguration = (presetId?: string): Promise<ProjectsPresetPublication> => {
    const operation = refreshTail.then(async (): Promise<ProjectsPresetPublication> => {
      if (state !== 'ready') throw new Error(`PROJECT_NOT_READY: Projects runtime graph is ${state}`)
      let transaction: ProjectsConfigurationTransaction | void = undefined
      const wanted = presetId ?? config.presetId ?? root.get('agentPresets')?.defaultId ?? registry().defaultId
      try {
        const nextSnapshot = await ports.preset.capture(wanted)
        const nextRuntime = ports.runtimeConfiguration?.() ?? { tools: {}, systemPrompt: {} }
        const effectiveNextRuntime = { tools: interpolate(ctx, nextRuntime.tools), systemPrompt: interpolate(ctx, nextRuntime.systemPrompt) }
        if (JSON.stringify(effectiveNextRuntime) !== JSON.stringify(effectiveRuntimeConfiguration)) {
          throw new Error('PROJECT_RUNTIME_CONFIGURATION_REQUIRES_RESTART: constructor-owned SystemPrompt/ToolRuntime settings changed; the current private runtime remains active')
        }
        transaction = await config.prepareConfiguration?.()
        lastPublication = await registry().publishSnapshot(nextSnapshot,
          { runtime: effectiveNextRuntime, foundations: transaction?.generation }, () => transaction?.commit() ?? Promise.resolve(), presetId === undefined)
        if (lastPublication.status === 'failed') await transaction?.rollback()
      } catch (error) {
        let failure = error
        try { await transaction?.rollback() }
        catch (rollbackError) {
          state = 'failed'
          failure = new AggregateError([error, rollbackError], 'Project configuration rollback was unconfirmed')
        }
        lastPublication = { status: 'failed', presetId: wanted, generation: registry().generationForPreset(wanted),
          error: failure instanceof Error ? failure.message : String(failure) }
      }
      await config.onConfigurationChange?.(lastPublication)
      return lastPublication
    })
    refreshTail = operation.catch(() => {})
    return operation
  }

  const acquireRequestPreset = async (agent: Agent): Promise<ProjectsPresetRequestLease | undefined> => {
    if (dedicatedAgents.has(agent)) return undefined
    const selected = selectedPreset(agent)
    await refreshConfiguration(selected)
    return registry().acquireRequest(agent, selected)
  }

  const close = (): Promise<ProjectsGraphCloseResult> => closing ??= (async () => {
    state = 'closing'
    startup.abort(new Error('Projects runtime graph is closing'))
    for (const unsubscribe of subscriptions.splice(0)) unsubscribe()
    // Startup owns any in-flight registration and cannot publish after closure.
    await starting?.catch(() => {})
    await refreshTail
    const results: { name: string; status: 'closed' | 'failed'; error?: string }[] = []
    const settle = async (name: string, operation: () => unknown | Promise<unknown>) => {
      try { await operation(); results.push({ name, status: 'closed' }) }
      catch (error) { results.push({ name, status: 'failed', error: error instanceof Error ? error.message : String(error) }) }
    }
    for (const owner of config.closeOwners ?? []) await settle(owner.name, () => owner.close())
    const model = ctx.get('llm') as ProjectsLlmRuntime | undefined
    if (model !== undefined) await settle('model-iterators', () => model.close())
    if (factory !== undefined) await settle('agent-handles', () => factory!.close())
    if (preset !== undefined) await settle('preset-revision', () => preset!.close())
    const persistence = ctx.get('sessionPersistence') as ProjectSessionPersistence | undefined
    if (persistence !== undefined) await settle('session-persistence', () => persistence.close())
    await settle('private-context', () => ctx.fiber.dispose())
    closeResult = Object.freeze({ status: results.some(row => row.status === 'failed') ? 'partial' : 'closed', owners: results })
    state = closeResult.status === 'closed' ? 'closed' : 'failed'
    return closeResult
  })()

  if (config.registerRootCleanup !== false) {
    root.effect(() => async () => { await close() }, 'projects.private-runtime-graph')
  }
  const assertStarting = () => {
    startupSignal.throwIfAborted()
    if (state !== 'starting') throw new Error('PROJECT_CLOSING: Projects runtime graph is closing')
  }
  starting = (async () => {
    // Register every prerequisite first. Waiting on an injected provider before
    // registering its dependencies would deadlock startup.
    const fibers: Fiber[] = [
      ctx.plugin(ProjectsPresetLoader, { baseUrl: snapshot.tree.baseUrl }),
      ctx.plugin(TypertRegistry),
      ctx.plugin(SessionProjectionRegistry),
      ctx.plugin(ProjectSessionPersistence, { dataRoot: config.dataRoot }),
      ctx.plugin(SessionStore),
      ctx.plugin(AgentRegistry),
      ctx.plugin(SystemPrompt, effectiveRuntimeConfiguration.systemPrompt),
      ctx.plugin(ProjectsLlmRuntime, ports.models),
      ctx.plugin(ProjectToolRuntime, effectiveRuntimeConfiguration.tools),
      ctx.plugin(ProjectsAgentPresetRegistry, { default: snapshot.presetId }),
    ]
    await Promise.all(fibers.map(fiber => fiber.await()))
    assertStarting()
    for (const service of ['loader', 'typert', 'sessionProjections', 'sessionPersistence', 'sessions', 'agents', 'systemPrompt', 'llm', 'tools', 'agentPresets']) {
      if (ctx.get(service) === undefined) throw new Error(`PROJECT_NOT_READY: private provider ${service} is unavailable`)
    }
    await (ctx.sessionPersistence as ProjectSessionPersistence).initialize()
    assertStarting()
    await installProjectsReadOnlyHostCapabilities(ctx, ports)
    await config.configure?.(ctx, startupSignal)
    assertStarting()
    const initialConfiguration = await config.prepareConfiguration?.()
    lastPublication = await registry().publishSnapshot(snapshot,
      { runtime: effectiveRuntimeConfiguration, foundations: initialConfiguration?.generation }, () => initialConfiguration?.commit() ?? Promise.resolve())
    if (lastPublication.status === 'failed') throw new Error(`PROJECT_PRESET_NOT_READY: ${lastPublication.error}`)
    preset = registry().installed()
    registry().sourcePorts(id => refreshConfiguration(id), async () => structuredClone(await root.agentPresets.list()))
    assertStarting()
    const callerSetup = config.factoryOptions?.setupBase
    const callerRequest = config.factoryOptions?.request
    factory = installProjectAgentFactory(ctx, {
      ...config.factoryOptions,
      setupBase: async (agentCtx, agent, parent) => {
        if (await config.shouldMountWorkPreset?.(agent, parent) === false) dedicatedAgents.add(agent)
        else {
          const selected = selectedPreset(agent)
          if (selected !== undefined && (parent === undefined || selected !== registry().composedPreset(parent.ctx))) {
            if (state === 'ready') {
              const loaded = await refreshConfiguration(selected)
              if (loaded.status === 'failed' && !registry().hasSource(selected)) throw new Error(`PROJECT_PRESET_NOT_READY: ${loaded.error}`)
            }
          }
          await registry().bindAgent(agentCtx, parent, selected, agent.session.header.origin === 'subagent')
        }
        return callerSetup?.(agentCtx, agent, parent)
      },
      request: {
        ...callerRequest,
        beforePrepare: async input => {
          const lease = await acquireRequestPreset(input.agent)
          try {
            const callerLease = await callerRequest?.beforePrepare?.(input)
            return { ...lease === undefined ? {} : { preset: { id: lease.presetId, generation: lease.generation } }, [Symbol.asyncDispose]: async () => {
              try { await callerLease?.[Symbol.asyncDispose]() }
              finally { await lease?.[Symbol.asyncDispose]() }
            } }
          } catch (error) { await lease?.[Symbol.asyncDispose](); throw error }
        },
      },
    })
    await config.afterFactory?.(ctx, factory)
    state = 'ready'
    const scheduleRefresh = () => { if (state === 'ready') void refreshConfiguration().catch(error => ctx.logger.warn(error)) }
    subscriptions.push(root.on('loader/config-update', scheduleRefresh, { global: true }))
    subscriptions.push(root.on('loader/volatile-update', scheduleRefresh, { global: true }))
    if (ports.models.subscribe !== undefined) subscriptions.push(ports.models.subscribe(scheduleRefresh))
  })()
  try {
    await starting
    if ((state as string) !== 'ready' || factory === undefined || preset === undefined) throw new Error('PROJECT_NOT_READY: startup did not finish')
  } catch (error) {
    // Await startup outside itself before entering the ordered cleanup barrier.
    await close()
    throw error
  }

  return {
    ctx,
    factory,
    persistence: ctx.sessionPersistence as ProjectSessionPersistence,
    preset,
    get status() { return state as ProjectsRuntimeGraph['status'] },
    get closeResult() { return closeResult },
    get lastPublication() { return lastPublication },
    refreshConfiguration,
    acquireRequestPreset,
    assertReady() {
      if (state !== 'ready') throw new Error(`PROJECT_NOT_READY: Projects runtime graph is ${state}`)
    },
    close,
  }
}
