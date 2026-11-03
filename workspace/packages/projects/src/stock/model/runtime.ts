import { latestProjectDispatch } from '../request/records.ts'
/** Private native LLM registry, bound configuration generations and one accounting receiver. */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import LlmRuntime, { LlmAdapter, type AdapterRegistrationHandle, type ConfigureCall, type GenerateOptions, type LlmCallConfig, type LlmImageRequestPricing, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type PreparedLlmCall, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type {} from '@deepseek-ai/dsh-session-title-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectsModelHostPort, ProjectsProviderSnapshot } from '../host-ports.ts'
import type { ProjectSessionPersistence } from '../persistence/index.ts'
import type { StockCapabilityOwnership } from '../control/capabilities.ts'
import { createProjectsBoundAdapter, type ProjectsBoundAdapter } from './adapters.ts'
import { currentProjectCallIdentity, withProjectUsageReceiver, bindProjectPreparedFacts, withProjectPreparedImagePricing } from './capture.ts'
import type { ProjectModelIdentity, ProjectUsageSample } from './schema.ts'
import { usageMetrics } from './schema.ts'

export { preparedProjectImagePricing, preparedProjectConfigurationGeneration } from './capture.ts'

/** The public registry keeps one family owner while each prepare captures its immutable adapter. */
class GenerationAdapter extends LlmAdapter {
  constructor(public bound: ProjectsBoundAdapter) { super() }
  override providerInfo(provider: string) { return this.bound.adapter.providerInfo(provider) }
  override providerRetryPolicy(provider: string) { return this.bound.adapter.providerRetryPolicy(provider) }
  override listModels(provider: string) { return this.bound.adapter.listModels(provider) }
  override resolveModel(provider: string, model: string, signal?: AbortSignal) { return this.bound.adapter.resolveModel(provider, model, signal) }
  override imageRequestPricing(provider: string, model: string) { return this.bound.adapter.imageRequestPricing(provider, model) }
  override imageRequestTarget(provider: string, model: string, image: ImageAttachmentRef) { return this.bound.adapter.imageRequestTarget(provider, model, image) }
  override prepareCall(provider: string, model: string, signal?: AbortSignal) {
    const adapter = this.bound.adapter
    return adapter.prepareCall(provider, model, signal)
  }
  stream(options: GenerateOptions) { return this.bound.adapter.stream(options) }
}
interface ManagedGeneration { generation: string; wrapper: GenerationAdapter; registration: AdapterRegistrationHandle }

export class ProjectsLlmRuntime extends LlmRuntime {
  static inject = ['sessions', 'sessionPersistence']
  private readonly managed = new Map<string, ManagedGeneration>()
  private readonly active = new Map<AbortController, Promise<void>>()
  private readonly preparing = new Set<Promise<PreparedLlmCall>>()
  private readonly shutdown = new AbortController()
  private readonly settlementFailures: unknown[] = []
  private ownership?: StockCapabilityOwnership
  private closing = false
  private closeResult?: Promise<void>

  constructor(ctx: Context, readonly host: ProjectsModelHostPort) {
    super(ctx)
    if (host.subscribe !== undefined) ctx.effect(() => host.subscribe!(() => ctx.emit('llm/adapters-updated')))
    ctx.effect(() => () => this.close(), 'projects.model-gateway')
  }

  private native(provider: string): ProjectsProviderSnapshot | undefined {
    const snapshot = this.host.captureProvider?.(provider)
    if (snapshot === undefined) return undefined
    const key = snapshot.family === 'pi-ai' ? 'pi-ai' : `${snapshot.family}:${provider}`
    const prior = this.managed.get(key)
    if (prior?.generation === snapshot.generation) return snapshot
    const bound = createProjectsBoundAdapter(this.ctx, snapshot)
    if (!bound.routes.includes(provider)) throw new Error(`PROJECT_MODEL_ROUTE_UNAVAILABLE: ${provider}`)
    if (prior === undefined) {
      const wrapper = new GenerationAdapter(bound)
      const registration = super.registerAdapter([...bound.routes], wrapper)
      this.managed.set(key, { generation: snapshot.generation, wrapper, registration })
    } else {
      const old = prior.wrapper.bound
      prior.wrapper.bound = bound
      try { prior.registration.replace([...bound.routes]); prior.generation = snapshot.generation }
      catch (error) { prior.wrapper.bound = old; throw error }
    }
    return snapshot
  }
  private local(provider: string): boolean { return super.listProviders().some(route => route.id === provider) }
  override listProviders(): LlmProviderInfo[] {
    const local = super.listProviders()
    return [...local, ...this.host.listProviders().filter(route => !local.some(own => own.id === route.id))]
  }
  override listModels(provider: string): Promise<LlmModelInfo[]> { return this.host.listProviders().some(route => route.id === provider) ? this.host.listModels(provider) : super.listModels(provider) }
  override resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    this.native(provider)
    return this.local(provider) ? super.resolveModelInfo(provider, model, signal) : this.host.resolveModelInfo(provider, model, signal)
  }
  override resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig> {
    this.native(config.provider)
    return this.local(config.provider) ? super.resolveCallConfig(config, signal) : this.host.resolveCallConfig(config, signal)
  }
  override imageRequestPricing(provider: string, model: string): LlmImageRequestPricing | undefined {
    this.native(provider)
    return this.local(provider) ? super.imageRequestPricing(provider, model) : this.host.imageRequestPricing(provider, model)
  }
  override imageRequestTarget(provider: string, model: string, image: ImageAttachmentRef): ImageRequestTarget {
    this.native(provider)
    return this.local(provider) ? super.imageRequestTarget(provider, model, image) : this.host.imageRequestTarget(provider, model, image)
  }
  /** Bind to the private graph's real Agent responsibility owner before admitting calls. */
  setOwnership(ownership: StockCapabilityOwnership): void {
    if (this.ownership !== undefined && this.ownership !== ownership) throw new Error('PROJECT_MODEL_OWNER_ALREADY_BOUND')
    if (this.active.size || this.preparing.size) throw new Error('PROJECT_MODEL_OWNER_MUST_BIND_BEFORE_CALLS')
    this.ownership = ownership
  }
  override prepareCall(config: LlmCallConfig, signal?: AbortSignal, configure?: ConfigureCall): Promise<PreparedLlmCall> {
    if (this.closing) return Promise.reject(new Error('PROJECT_MODEL_CLOSING'))
    const actualSignal = signal === undefined ? this.shutdown.signal : AbortSignal.any([signal, this.shutdown.signal])
    const pending = this.prepareBound(config, actualSignal, configure)
    this.preparing.add(pending)
    void pending.then(() => this.preparing.delete(pending), () => this.preparing.delete(pending))
    return pending
  }
  private async prepareBound(config: LlmCallConfig, signal: AbortSignal, configure?: ConfigureCall): Promise<PreparedLlmCall> {
    // GenerateOptions structurally extends this type. Never clone request-only fields (especially AbortSignal) into prepared.config.
    config = { provider: config.provider, model: config.model,
      ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
      ...config.temperature === undefined ? {} : { temperature: config.temperature },
      ...config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens },
      ...config.stop === undefined ? {} : { stop: [...config.stop] } }
    if (this.closing) throw new Error('PROJECT_MODEL_CLOSING')
    const native = this.native(config.provider)
    // Static adapters bind pricing before await; a dynamic adapter supplies the
    // exact resolved connection's pricing within this preparation's ALS scope.
    let images = this.local(config.provider) ? super.imageRequestPricing(config.provider, config.model) : this.host.imageRequestPricing(config.provider, config.model)
    const local = this.local(config.provider)
    const prepared = await withProjectPreparedImagePricing(value => { images = value }, () =>
      local ? super.prepareCall(config, signal, configure) : this.host.prepareCall(config, signal, configure))
    signal.throwIfAborted()
    if (this.closing) throw new Error('PROJECT_MODEL_CLOSING')
    let dispatched = false
    const generation = native?.generation ?? (local ? 'private-adapter' : 'host-prepared-call')
    const wrapped: PreparedLlmCall = Object.freeze({
      ...prepared,
      stream: (options: GenerateOptions) => {
        if (dispatched) throw new Error('A prepared Projects model call can only be dispatched once')
        dispatched = true
        const stream = (actual: GenerateOptions) => local ? prepared.stream(actual) : this.ctx.waterfall(this, 'llm/stream', actual, () => prepared.stream(actual))
        return this.record(options, generation, native !== undefined, stream)
      },
    })
    bindProjectPreparedFacts(wrapped, { generation, ...images === undefined ? {} : { images } })
    return wrapped
  }
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const self = this
    return (async function* () { const prepared = await self.prepareCall(options, options.signal); yield* prepared.stream({ ...options, ...prepared.config }) })()
  }

  private async *record(options: GenerateOptions, generation: string, raw: boolean, open: (actual: GenerateOptions) => AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
    if (this.closing) throw new Error('PROJECT_MODEL_CLOSING')
    const binding = currentProjectCallIdentity()
    const session: Session | undefined = binding?.agent.session ?? (options.sessionId === undefined ? undefined : this.ctx.sessions.get(options.sessionId as SessionId))
    if (session === undefined || session.id !== options.sessionId || this.ctx.sessions.get(session.id) !== session) throw new Error('PROJECT_MODEL_CARRIER_UNAVAILABLE')
    const persistence = this.ctx.sessionPersistence as ProjectSessionPersistence
    const controller = new AbortController()
    const actual = { ...options, signal: options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal]) }
    const done = Promise.withResolvers<void>()
    // Both the graph and carrier retirement observe the same final iterator + journal settlement.
    void done.promise.catch(() => {})
    this.active.set(controller, done.promise)
    const realOwner = binding?.agent ?? this.ctx.get('agents')?.get(session.id)
    if (this.ownership !== undefined && (realOwner === undefined || realOwner.session !== session)) {
      this.active.delete(controller); done.resolve()
      throw new Error('PROJECT_MODEL_AGENT_OWNER_UNAVAILABLE')
    }
    let untrack: void | (() => void) = undefined
    let tail: Promise<void> = Promise.resolve(), failure: unknown, ordinal = 0, previous: string | undefined, previousCounters: string | undefined
    let iterator: AsyncIterator<StreamChunk> | undefined, begun = false
    let outcome: 'completed' | 'failed' | 'cancelled' | 'consumer-closed' = 'consumer-closed'
    const flush = async (): Promise<void> => { if (!await this.ctx.sessions.flush(session)) throw new Error('PROJECT_MODEL_DURABILITY_UNAVAILABLE') }
    const conversation = options.purpose === undefined
    // An auxiliary task may inherit its initiating conversation's ALS; it still consumed a distinct provider request.
    const requestId = conversation ? binding?.identity.dispatchId ?? randomUUID() : randomUUID()
    const attemptId = conversation ? binding?.identity.attemptId ?? randomUUID() : randomUUID()
    const receiver = (sample: ProjectUsageSample): void => {
      const fingerprint = JSON.stringify(sample)
      const counters = JSON.stringify({ counters: sample.counters, incomplete: sample.incomplete, reporter: sample.reporter })
      // Terminal SDK delivery repeats the very same raw report through a normalized view.
      if (fingerprint === previous || sample.raw === undefined && counters === previousCounters) return
      previous = fingerprint; previousCounters = counters
      session.append('projects/model-request-usage', { requestId, attemptId, ordinal: ordinal++, sample })
      tail = tail.then(flush).catch(error => { failure ??= error; controller.abort(error); throw error })
      void tail.catch(() => {})
    }
    try {
      if (this.ownership !== undefined) untrack = this.ownership.track({ owner: realOwner!, kind: 'model', cancel: () => controller.abort(new Error('Projects model owner is retiring')), done: done.promise })
      const owner = await persistence.resolveOwner(session.id)
      if (owner === undefined) throw new Error('PROJECT_MODEL_MEMBERSHIP_UNAVAILABLE')
      const lastDispatch = latestProjectDispatch(session)
      const auxiliary = options.purpose === 'compaction' ? session.snapshotEvents().findLast(event => event.type === 'compaction/start')
        : options.purpose === 'session-title' ? session.snapshotEvents().findLast(event => event.type === 'session/title-llm-request') : undefined
      const identity: ProjectModelIdentity = {
        requestId, attemptId, ...owner, carrierId: session.id, carrierCreatedAt: session.header.createdAt,
        role: binding?.identity.role ?? 'work', purpose: options.purpose ?? 'conversation', provider: options.provider, model: options.model,
        configurationGeneration: generation,
        ...binding?.identity.turn !== undefined ? { turn: binding.identity.turn } : options.purpose === undefined && lastDispatch !== undefined ? { turn: lastDispatch.data.turn } : {},
        ...binding?.identity.step !== undefined ? { step: binding.identity.step } : options.purpose === undefined && lastDispatch !== undefined ? { step: lastDispatch.data.step } : {},
        ...auxiliary === undefined ? {} : { sourceEventSeq: auxiliary.seq },
        ...auxiliary?.type === 'compaction/start' ? { compactionId: auxiliary.data.compactionId } : {},
        ...options.purpose !== undefined || lastDispatch === undefined ? {} : { dispatchSeq: lastDispatch.seq },
      }
      session.append('projects/model-request-start', identity); begun = true
      await flush()
      actual.signal.throwIfAborted()
      // The producer's task inherits this receiver even when its SDK runs a background pump.
      iterator = withProjectUsageReceiver(receiver, () => open(actual)[Symbol.asyncIterator]())
      while (true) {
        const next = await withProjectUsageReceiver(receiver, () => iterator!.next())
        await tail
        if (failure !== undefined) throw failure
        if (next.done) break
        const chunk = next.value
        if (chunk.type === 'usage' && chunk.usage !== undefined && !raw) {
          const counters: ProjectUsageSample['counters'] = {}
          for (const metric of usageMetrics) if (chunk.usage[metric] !== undefined) counters[metric] = chunk.usage[metric]
          receiver({ counters, incomplete: [], reporter: 'host-normalized' }); await tail
        }
        if (chunk.type === 'finish') outcome = chunk.reason.kind === 'error' ? 'failed' : chunk.reason.kind === 'aborted' ? 'cancelled' : 'completed'
        yield chunk
      }
    } catch (error) { outcome = failure !== undefined ? 'failed' : options.signal?.aborted || controller.signal.aborted ? 'cancelled' : 'failed'; throw error }
    finally {
      let settlementFailure: unknown
      try {
        if (iterator?.return !== undefined) await withProjectUsageReceiver(receiver, () => iterator!.return!())
        await tail
        if (failure !== undefined) throw failure
        if (begun) { session.append('projects/model-request-end', { requestId, attemptId, outcome }); await flush() }
      } catch (error) { settlementFailure = error; this.settlementFailures.push(error); throw error }
      finally {
        this.active.delete(controller)
        if (settlementFailure === undefined) done.resolve(); else done.reject(settlementFailure)
        if (typeof untrack === 'function') untrack()
      }
    }
  }
  /** Graph owner calls this before its Session writers/providers are released. */
  close(): Promise<void> {
    return this.closeResult ??= (async () => {
      this.closing = true
      this.shutdown.abort(new Error('Projects model gateway is closing'))
      for (const controller of this.active.keys()) controller.abort(new Error('Projects model gateway is closing'))
      await Promise.allSettled([...this.preparing, ...this.active.values()])
      if (this.settlementFailures.length) throw new AggregateError([...this.settlementFailures], 'Projects model journal settlement failed')
    })()
  }
}
