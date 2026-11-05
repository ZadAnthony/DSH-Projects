import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { JobHooks, JobId, JobOutcome, JobSpec } from '@deepseek-ai/dsh-jobs'
import SubagentRuntime, {
  type SubagentActivation, type SubagentActivationSpec,
  type SubagentSendMessageOptions,
  type SubagentPromptReceipt, type SubagentPromptRequest,
} from '@deepseek-ai/dsh-subagent'
import PtcWorkflowEngine from '@deepseek-ai/dsh-workflow-ptc'
import type { WorkflowRun, WorkflowStartRequest } from '@deepseek-ai/dsh-workflow'

export interface StockCapabilityResponsibility {
  readonly owner: Agent
  readonly kind: 'job' | 'subagent' | 'workflow' | 'process' | 'title' | 'model'
  /** Requests actual producer cancellation; a throw never settles `done`. */
  readonly cancel: () => void | Promise<void>
  /** Actual resource/notification settlement, independent of registry status. */
  readonly done: Promise<unknown>
}

export interface StockCapabilityOwnership {
  assertAdmitting(id: Agent['id'], owner: Agent): void
  track(responsibility: StockCapabilityResponsibility): void | (() => void)
}

export interface OwnedStockCapabilities {
  readonly Jobs: typeof LocalJobRegistry
  readonly Subagents: typeof SubagentRuntime
  readonly Workflow: typeof PtcWorkflowEngine
}

/**
 * Keep public promise consumer branches alive through their returned promises.
 * Native callbacks (including job settlement/pump drain) and explicit async
 * parent notifications are retained without touching a provider's internals.
 * Code following an `await` belongs to its calling tool/command operation.
 */
class RetainedPromise<T> extends Promise<T> {
  static override get [Symbol.species](): PromiseConstructor { return Promise }
  constructor(pending: Promise<T>, private readonly retain: (branch: Promise<unknown>) => void) {
    super((resolve, reject) => { void pending.then(resolve, reject) })
    // A dropped observer must not produce an unhandled rejection. Callers
    // still see the same rejection, and the owner retains its real promise.
    void super.then(undefined, () => undefined)
  }
  override then<TResult1 = T, TResult2 = never>(
    fulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    rejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    const branch = super.then(fulfilled, rejected)
    this.retain(branch)
    return new RetainedPromise(branch, this.retain)
  }
}

function expose<T>(pending: Promise<T>, ownership: StockCapabilityOwnership, owner: Agent,
  kind: StockCapabilityResponsibility['kind'], cancel: StockCapabilityResponsibility['cancel']): Promise<T> {
  return new RetainedPromise(pending, done => {
    ownership.track({ owner, kind, cancel, done })
  })
}

/** Wait for every resource boundary even if an earlier one rejected. */
async function settledTogether(promises: readonly Promise<unknown>[]): Promise<void> {
  const outcomes = await Promise.allSettled(promises)
  const failures = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : [])
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Project capability did not settle cleanly')
}

/** Retain a real run until both its result and actual disposer settle. */
function ownedRun<T extends { result: Promise<unknown>; dispose(): Promise<void> }>(run: T) {
  const released = Promise.withResolvers<void>()
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    if (disposal !== undefined) return disposal
    // Calling a public disposer remains an actual call, including a
    // synchronous throw from a provider that violates its async contract.
    try { disposal = Promise.resolve(run.dispose()) }
    catch (error) { disposal = Promise.reject(error) }
    void disposal.then(released.resolve, released.reject)
    return disposal
  }
  return { dispose, done: settledTogether([run.result, released.promise]) }
}

/**
 * Public, bounded subclasses for one private graph. Native Config, injection,
 * validation, scopes, lifecycle events, and execution remain native. Root DSH
 * keeps its original providers. No private reflection or prototype changes.
 */
export function createOwnedStockCapabilities(ownership: StockCapabilityOwnership): OwnedStockCapabilities {
  class ProjectJobRegistry extends LocalJobRegistry {
    constructor(private readonly ownerContext: Context, config: ConstructorParameters<typeof LocalJobRegistry>[1]) {
      super(ownerContext, config)
    }

    override start(spec: JobSpec): JobId {
      if (spec.owner === undefined) throw new Error('PROJECT_JOB_OWNER_REQUIRED: background work requires its exact Project Agent')
      // Cordis 将 this.ctx 重绑定到可能只注入 jobs 的调用方。
      // 与原生一致，从本 provider 的私有 Graph 显式解析 owner。
      const agents = this.ownerContext.get('agents')
      if (agents === undefined) throw new Error('background job ownership requires the agent registry (load @deepseek-ai/dsh-agent)')
      const owner = agents.get(spec.owner)
      if (owner === undefined) throw new Error(`session "${spec.owner}" has no live agent (background job owner must be live)`)
      ownership.assertAdmitting(owner.id, owner)
      return super.start({
        ...spec,
        run(job) {
          let producer: JobHooks | undefined
          let stopping = false
          const completion = Promise.withResolvers<JobOutcome>()
          const cancel = () => { stopping = true; producer?.cancel('Project owner stopping') }
          // Producer completion, not the native registry's forced failed
          // record, is the authority for execution/resource quiescence.
          ownership.track({ owner, kind: 'job', cancel, done: completion.promise })
          try { producer = spec.run(job) }
          catch (error) { completion.reject(error); throw error }
          void producer.done.then(completion.resolve, completion.reject)
          if (stopping) cancel()
          return {
            cancel: producer.cancel.bind(producer),
            done: expose(producer.done, ownership, owner, 'job', cancel),
          }
        },
      })
    }
  }

  class ProjectSubagentRuntime extends SubagentRuntime {
    override startActivation(spec: SubagentActivationSpec & { readonly childId: SessionId }): Promise<SubagentActivation & { readonly messageId: MessageId }>
    override startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>
    override startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation> {
      const owner = spec.request.parent
      try { ownership.assertAdmitting(owner.id, owner) }
      catch (error) { return Promise.reject(error) }
      const controller = new AbortController()
      const signal = AbortSignal.any([spec.signal, controller.signal])
      const completion = Promise.withResolvers<void>()
      let published: ReturnType<typeof ownedRun<SubagentActivation>> | undefined
      let pending: Promise<SubagentActivation> | undefined
      const cancel = (): Promise<void> => {
        controller.abort(new Error('Project owner stopping'))
        if (published !== undefined) return published.dispose()
        // Cancellation cannot abandon provider startup. A late publication
        // still transfers its actual run to this owner and is disposed.
        return pending === undefined ? Promise.resolve() : pending.then(() => published?.dispose(), () => undefined)
      }
      // Register before invoking the provider: it may start resources before
      // its first await or synchronously reenter a control operation.
      ownership.track({ owner, kind: 'subagent', cancel, done: completion.promise })
      pending = super.startActivation({ ...spec, signal }).then(run => {
        published = ownedRun(run)
        void published.done.then(completion.resolve, completion.reject)
        // Native activations settle their result after managed teardown. Join
        // that exact disposer too, retaining teardown errors and its lifetime.
        void run.result.then(() => published!.dispose(), () => published!.dispose()).catch(() => undefined)
        if (controller.signal.aborted) void published.dispose().catch(() => undefined)
        return {
          childId: run.childId,
          ...run.messageId === undefined ? {} : { messageId: run.messageId },
          result: expose(run.result, ownership, owner, 'subagent', cancel),
          dispose: published.dispose,
        }
      }, error => {
        completion.reject(error)
        throw error
      })
      return expose(pending, ownership, owner, 'subagent', cancel)
    }

    override sendMessage(sender: Agent, targetId: SessionId, content: ContentBlock[],
      options: SubagentSendMessageOptions): Promise<MessageId> {
      return this.admitted(sender, options.signal,
        signal => super.sendMessage(sender, targetId, content, { ...options, signal }))
    }

    override prompt(request: SubagentPromptRequest, signal: AbortSignal): Promise<SubagentPromptReceipt> {
      const parent = this.ctx.agents.get(request.parentSessionId)
      // Preserve the native request validation/unavailable errors.
      if (parent === undefined) return super.prompt(request, signal)
      return this.admitted(parent, signal, admitted => super.prompt(request, admitted))
    }

    private admitted<T>(owner: Agent, signal: AbortSignal, begin: (signal: AbortSignal) => Promise<T>): Promise<T> {
      try { ownership.assertAdmitting(owner.id, owner) }
      catch (error) { return Promise.reject(error) }
      const controller = new AbortController()
      const completion = Promise.withResolvers<T>()
      const cancel = () => { controller.abort(new Error('Project owner stopping')) }
      ownership.track({ owner, kind: 'subagent', cancel, done: completion.promise })
      try { void begin(AbortSignal.any([signal, controller.signal])).then(completion.resolve, completion.reject) }
      catch (error) { completion.reject(error) }
      return expose(completion.promise, ownership, owner, 'subagent', cancel)
    }

    // The inherited public drainDescendants(exactParents) retains pending
    // materializations and native Activations, releases handles child-first,
    // and completes final parent settlement delivery.
  }

  class ProjectWorkflowEngine extends PtcWorkflowEngine {
    override start(request: WorkflowStartRequest): WorkflowRun {
      const owner = request.parent
      ownership.assertAdmitting(owner.id, owner)
      const completion = Promise.withResolvers<void>()
      let stopping = false
      let run: WorkflowRun | undefined
      let retained: ReturnType<typeof ownedRun<WorkflowRun>> | undefined
      const cancel = (): void | Promise<void> => {
        stopping = true
        if (run === undefined || retained === undefined) return
        run.cancel('Project owner stopping')
        return retained.dispose()
      }
      ownership.track({ owner, kind: 'workflow', cancel, done: completion.promise })
      // Native start is synchronous and validates before starting execution.
      // PtcWorkflowRun.result settles after its real process and children drain.
      try { run = super.start(request) }
      catch (error) { completion.reject(error); throw error }
      retained = ownedRun(run)
      void retained.done.then(completion.resolve, completion.reject)
      if (stopping) void cancel()
      return {
        id: run.id, meta: run.meta,
        result: expose(run.result, ownership, owner, 'workflow', cancel),
        cancel: run.cancel.bind(run),
        dispose: retained.dispose,
      }
    }
  }
  return { Jobs: ProjectJobRegistry, Subagents: ProjectSubagentRuntime, Workflow: ProjectWorkflowEngine }
}
