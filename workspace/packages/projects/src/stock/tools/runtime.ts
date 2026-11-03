import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import ToolRuntime, { TOOL_RUNTIME_SCHEDULER, ToolArgsError, validateJsonSchemaValue, type JsonSchemaNode, type ToolDefinition, type ToolExecution, type ToolExecutionToken, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ToolInvocationSource } from '../../communication/invocation-source.ts'
import type { ProjectInvocationPort } from '../project-ports.ts'
import type { ProjectDriverPersistence } from '../request/dispatch.ts'
import { appendProjectRecording, flushProjectRecording } from '../recording/index.ts'
import type { ProjectExecutionIdentity } from '../recording/events.ts'

interface Binding { agent: Agent; callSeq: number; persistence: ProjectDriverPersistence }
interface Invocation extends Binding {
  invocationId: string; parentInvocationId?: string
  source: ToolInvocationSource
  nestedStarts: Map<string, SessionEvent<'tool/ptc-dispatch-start'>[]>
}
const scheduled = new AsyncLocalStorage<Binding>()
const activeBody = new AsyncLocalStorage<Invocation>()
const invocations = new Map<ToolExecutionToken, Invocation>()
const invocationSources = new WeakMap<object, ToolInvocationSource>()

/** The just-appended call identity is carried through native synchronous token creation. */
export function withProjectToolCall<T>(binding: Binding, operation: () => T): T {
  return scheduled.run(binding, operation)
}
export function bindProjectToolToken(exec: Readonly<ToolExecution>): void {
  if (invocations.has(exec.token)) return
  const parent = exec.parent === undefined ? undefined : invocations.get(exec.parent)
  const binding = parent ?? scheduled.getStore()
  if (!binding || exec.agent !== binding.agent) return
  let callSeq = binding.callSeq
  if (exec.parent !== undefined) {
    // A native PTC start is captured at append, under the enclosing body's async
    // context. Consume that exact event, never search the journal by callId.
    const queue = parent?.nestedStarts.get(String(exec.callId))
    const start = queue?.shift()
    if (!start || start.data.rootCallId !== exec.rootCallId || start.data.name !== exec.name) {
      const error = new Error('Project nested tool is missing its just-appended native dispatch start')
      binding.persistence.fail(error)
      throw error
    }
    if (queue?.length === 0) parent?.nestedStarts.delete(String(exec.callId))
    callSeq = start.seq
  }
  const source: ToolInvocationSource = Object.freeze({
    sessionId: binding.agent.session.id,
    sessionCreatedAt: binding.agent.session.header.createdAt,
    startEventSeq: callSeq as SessionSeq,
    callId: exec.callId,
    rootCallId: exec.rootCallId,
  })
  invocations.set(exec.token, {
    ...binding, callSeq, source, invocationId: randomUUID(), nestedStarts: new Map(),
    ...parent ? { parentInvocationId: parent.invocationId } : {},
  })
  invocationSources.set(exec, source)
}
export function releaseProjectToolToken(token: ToolExecutionToken): void { invocations.delete(token) }
export const projectInvocationPort: ProjectInvocationPort = Object.freeze({
  get(exec: Readonly<ToolExecution>): ToolInvocationSource | undefined { return invocationSources.get(exec) ?? invocations.get(exec.token)?.source },
})
function identity(exec: Readonly<ToolExecution>, invocation: Invocation): ProjectExecutionIdentity {
  return {
    startEventSeq: invocation.source.startEventSeq, callId: String(exec.callId), rootCallId: String(exec.rootCallId),
    name: exec.name, invocationId: invocation.invocationId,
    ...invocation.parentInvocationId ? { parentInvocationId: invocation.parentInvocationId } : {},
  }
}
function snapshot(value: unknown): JsonValue {
  const detached = snapshotJsonValue(value)
  if (detached === undefined) throw new TypeError('Project original tool fact must be losslessly JSON-serializable')
  return detached as JsonValue
}
function requireInvocation(exec: Readonly<ToolExecution>): Invocation {
  bindProjectToolToken(exec)
  const invocation = invocations.get(exec.token)
  if (!invocation) throw new Error('Project tool invocation is missing its actual call/start binding')
  invocation.persistence.assertHealthy()
  return invocation
}

/** Native pipeline and PTC remain native; only public definitions and hooks are decorated. */
export class ProjectToolRuntime extends ToolRuntime {
  private readonly bodyCancellations = new WeakMap<object, string>()
  constructor(ctx: Context, config: ConstructorParameters<typeof ToolRuntime>[1] = {}) {
    super(ctx, config)
    const manifest: { version?: string } = createRequire(import.meta.url)('@deepseek-ai/dsh-tools/package.json')
    if (!['0.2.0-rc.2', '0.2.1-rc.3', '0.2.1-rc.5'].includes(manifest.version ?? '')) throw new Error(`Unsupported native Tools scheduler ABI: ${manifest.version ?? 'unknown'}`)
    const scheduler = this[TOOL_RUNTIME_SCHEDULER]
    if (!scheduler || ['prepare', 'dispatch', 'finalize', 'finish'].some(key => typeof scheduler[key as keyof typeof scheduler] !== 'function')) throw new Error('Unsupported native Tools scheduler ABI: required pinned scheduler operations are absent')
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'tool/ptc-dispatch-start') return
      const parent = activeBody.getStore()
      if (!parent || parent.agent.session !== session) return
      const key = String(event.data.subCallId)
      const queue = parent.nestedStarts.get(key) ?? []
      queue.push(event)
      parent.nestedStarts.set(key, queue)
    })
    ctx.on('tools/pre-execute', (exec, next) => {
      // Binding runs synchronously before native policy's first await.
      bindProjectToolToken(exec)
      return next()
    })
    this.guard(exec => {
      if (!exec.agent) return undefined
      const invocation = requireInvocation(exec)
      invocation.persistence.assertHealthy()
      return undefined
    })
    ctx.on('tools/result', (exec, result) => {
      // Native contains observer errors. Explicitly poison only this carrier;
      // the finite scheduler and parent body's durability barrier rethrow it.
      let invocation: Invocation | undefined
      try {
        invocation = requireInvocation(exec)
        appendProjectRecording(invocation.agent.session, invocation.persistence, 'projects/tool-execution-final', {
          ...identity(exec, invocation), result: result as unknown as JsonValue,
        })
      } catch (error) {
        invocation ??= invocations.get(exec.token)
        invocation?.persistence.fail(error)
      } finally { releaseProjectToolToken(exec.token) }
    })
  }
  override get(name: string, scope?: ScopeKey): ToolDefinition | undefined {
    const definition = super.get(name, scope)
    if (!definition) return undefined
    let body: { exec: ToolRunContext; invocation: Invocation } | undefined
    return {
      ...definition,
      output: {
        ...definition.output,
        render: (args, value) => {
          const content = definition.output.render(args, value)
          if (body) appendProjectRecording(body.invocation.agent.session, body.invocation.persistence, 'projects/tool-execution-return', {
            ...identity(body.exec, body.invocation), phase: 'rendered', origin: 'body', value, content,
          })
          return content
        },
        ...definition.output.presentationMeta ? { presentationMeta: (args: unknown, value: JsonValue) => {
          const meta = definition.output.presentationMeta!(args, value)
          if (body) appendProjectRecording(body.invocation.agent.session, body.invocation.persistence, 'projects/tool-execution-return', {
            ...identity(body.exec, body.invocation), phase: 'presentation-meta', origin: 'body', meta,
          })
          return meta
        } } : {},
      },
      projectContent: (exec, result) => {
        const invocation = requireInvocation(exec)
        try {
          appendProjectRecording(invocation.agent.session, invocation.persistence, 'projects/tool-execution-return', {
            ...identity(exec, invocation), phase: 'canonical', origin: 'pipeline', result: result as unknown as JsonValue, content: result.content,
          })
        } catch (error) { invocation.persistence.fail(error); throw error }
        return definition.projectContent?.(exec, result)
      },
      finalizeContent: (exec, result) => {
        const content = definition.finalizeContent?.(exec, result)
        const cancellation = this.bodyCancellations.get(exec)
        this.bodyCancellations.delete(exec)
        if (!result.isError || cancellation === undefined) return content
        // Keep native status/code and the raw throw/canonical evidence. Only
        // the known object-cause placeholder needs a readable presentation.
        return (content ?? result.content).map(block => block.type === 'text' && block.text === 'Error: [object Object]'
          ? { ...block, text: `Error: tool call aborted (${cancellation})` } : block)
      },
      execute: async (args, exec) => {
        const invocation = requireInvocation(exec)
        // defineTool validates inside execute; validate first so a rejected
        // argument is never recorded as actual user body entry.
        const violations = validateJsonSchemaValue(definition.parameters as JsonSchemaNode, args, '')
        if (violations.length > 0) throw new ToolArgsError(violations)
        body = { exec, invocation }
        const { agent, persistence } = invocation
        const fact = identity(exec, invocation)
        appendProjectRecording(agent.session, persistence, 'projects/tool-execution-start', { ...fact, arguments: snapshot(args) })
        await flushProjectRecording(persistence)
        let value: unknown
        try {
          value = await activeBody.run(invocation, () => definition.execute(args, exec))
        } catch (error: unknown) {
          persistence.assertHealthy()
          appendProjectRecording(agent.session, persistence, 'projects/tool-execution-return', {
            ...fact, phase: 'throw', origin: 'body', error: { message: error instanceof Error ? error.message : String(error), ...error instanceof Error ? { name: error.name } : {} },
          })
          await flushProjectRecording(persistence)
          if (exec.signal.aborted && error === exec.signal.reason && error !== null && typeof error === 'object' && 'kind' in error) {
            const cause = error as { kind: unknown; reason?: unknown }
            if (['user', 'parent', 'disposed'].includes(String(cause.kind))) this.bodyCancellations.set(exec, String(cause.kind))
            else if (cause.kind === 'hook' && typeof cause.reason === 'string') this.bodyCancellations.set(exec, `hook: ${cause.reason}`)
          }
          throw error
        }
        // Recording failure never becomes an ordinary recoverable body throw.
        persistence.assertHealthy()
        // 原始记录由 payload owner 同步校验并捕获，此处不重复复制。
        appendProjectRecording(agent.session, persistence, 'projects/tool-execution-return', { ...fact, phase: 'value', origin: 'body', value: value as JsonValue })
        await flushProjectRecording(persistence)
        return value
      },
    }
  }
}
export default ProjectToolRuntime
