/** 主会话基于可核用户原话，停止本项目指定执行会话的真实当前轮。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { NativeProjectSource } from './source-reader.ts'

export interface StopExecutionArgs {
  readonly execution_session_id: string
  readonly original_source: { readonly host_session_id: string; readonly message_id: string }
}
export interface NativeProjectRun {
  readonly turn: number
  readonly startSeq: number
}
export interface NativeProjectStopResult {
  readonly kind: 'stopped' | 'failed' | 'unconfirmed' | 'no-current-run'
  /** sent 只证明调用了原生取消入口，不证明停止或唯一因果。 */
  readonly request: 'not-sent' | 'sent' | 'unknown'
  readonly run?: NativeProjectRun
  readonly observed?: { readonly endSeq: number; readonly endedAt: number; readonly reason: TurnEndReason }
  readonly message: string
}
export interface ProjectControlCall {
  readonly projectId: string
  readonly sessionId: string
  readonly hostSessionId: string
  readonly role: 'main' | 'execution' | 'memory'
}
export interface ProjectControlTarget {
  readonly projectId: string
  readonly sessionId: string
  readonly hostSessionId: string
  readonly role: 'main' | 'execution' | 'memory'
}
export interface ProjectControlPorts {
  readonly ctx: Context
  /** 必须核对真实 live caller、工具执行上下文和当前项目归属。 */
  resolveCall(exec: ToolRunContext): Promise<ProjectControlCall>
  /** 从本项目原始消息读取；不可读、Agent来源和系统来源均不能认作用户原话。 */
  readUserSource(projectId: string, source: Extract<NativeProjectSource, { kind: 'message' }>, signal: AbortSignal): Promise<{
    readonly readable: boolean; readonly isUserDecision: boolean; readonly text?: string
  }>
  readTarget(projectId: string, sessionId: string): Promise<ProjectControlTarget | undefined>
  /** 最后一个 await 后同步核对 caller/target 绑定及正常生命周期，不得冷恢复目标。 */
  assertCurrent(call: ProjectControlCall, target: ProjectControlTarget): void
}
export interface ProjectStopExecutionResult extends NativeProjectStopResult {
  readonly requestedSessionId: string
  readonly target?: ProjectControlTarget
  readonly originalUserSource?: Extract<NativeProjectSource, { kind: 'message' }>
  readonly originalUserText?: string
}

/** 只从原生日志读取未闭合轮，不把 running/idle 或某次历史结束当本次当前轮。 */
export function currentNativeProjectRun(events: readonly SessionEvent[]): NativeProjectRun | undefined {
  let current: NativeProjectRun | undefined
  for (const event of events) {
    if (event.type === 'turn/start') current = { turn: event.data.turn, startSeq: event.seq }
    else if (event.type === 'turn/end' && event.data.turn === current?.turn) current = undefined
  }
  return current
}

/** 监听后同步锁定当前轮并取消；只等这个轮的原生终态，不跟随后续活动。 */
export async function requestNativeProjectStop(ctx: Context, agent: Agent, signal: AbortSignal): Promise<NativeProjectStopResult> {
  if (signal.aborted) return { kind: 'unconfirmed', request: 'not-sent', message: '调用已中断，未发出停止请求。' }
  if (ctx.agents.get(agent.id) !== agent) return { kind: 'unconfirmed', request: 'not-sent', message: '目标原生活动已失效，未发出停止请求。' }
  const run = currentNativeProjectRun(agent.session.snapshotEvents())
  if (run === undefined) return { kind: 'no-current-run', request: 'not-sent', message: '目标没有已打开的当前运行；没有唤醒或恢复会话。' }

  type Observation = { kind: 'end'; event: SessionEvent<'turn/end'> } | { kind: 'unconfirmed'; message: string }
  const done = Promise.withResolvers<Observation>()
  const disposeEvent = ctx.on('session/event', (session, event) => {
    if (session === agent.session && event.type === 'turn/end' && event.data.turn === run.turn && event.seq > run.startSeq) {
      done.resolve({ kind: 'end', event })
    }
  })
  const disposeAgent = ctx.on('agent/disposed', ({ agent: subject }) => {
    if (subject === agent) done.resolve({ kind: 'unconfirmed', message: '目标已卸载，未观察到原目标轮终态。' })
  })
  const aborted = (): void => { done.resolve({ kind: 'unconfirmed', message: '停止请求已发出，但本次观察已中断；目标轮停止尚未确认。' }) }
  signal.addEventListener('abort', aborted, { once: true })
  try {
    // 到 cancel 之间没有 await；保留 inbox，与原生用户 Stop 一致。
    try { agent.cancel({ kind: 'user' }, { keepInbox: true }) }
    catch (error) { return { kind: 'unconfirmed', request: 'unknown', run, message: `取消调用失败，实际停止未知：${errorText(error)}` } }
    const observation = await done.promise
    if (observation.kind === 'unconfirmed') return { kind: 'unconfirmed', request: 'sent', run, message: observation.message }
    const observed = { endSeq: observation.event.seq, endedAt: observation.event.time, reason: observation.event.data.reason }
    if (observed.reason.kind === 'aborted') return { kind: 'stopped', request: 'sent', run, observed,
      message: '原目标轮已记录中断；已发出取消请求，但该事实不证明本调用是唯一停止原因。已发生的操作未回滚，后续消息和定时按原规则处理。' }
    return { kind: 'unconfirmed', request: 'sent', run, observed,
      message: `原目标轮已以 ${observed.reason.kind} 结束，未确认由 Stop 中断；已发生操作的范围仍须核对。` }
  } finally {
    signal.removeEventListener('abort', aborted)
    disposeEvent(); disposeAgent()
  }
}

/** 核对可追溯用户原话及本项目 execution ID 后，调用原生停止；既有授权不因跨轮失效。 */
export async function stopProjectExecution(exec: ToolRunContext, args: StopExecutionArgs, ports: ProjectControlPorts): Promise<ProjectStopExecutionResult> {
  const base = { requestedSessionId: args.execution_session_id }
  const failed = (message: string): ProjectStopExecutionResult => ({ ...base, kind: 'failed', request: 'not-sent', message })
  try {
    const call = await ports.resolveCall(exec)
    if (call.role !== 'main') return failed('只有本项目主会话可以按用户要求停止其它执行会话。')
    if (!args.execution_session_id?.trim() || !args.original_source?.host_session_id?.trim() || !args.original_source?.message_id?.trim()) {
      return failed('需要真实执行会话 ID 和明确用户要求的原始消息定位。')
    }
    const originalUserSource = { kind: 'message' as const, hostSessionId: args.original_source.host_session_id, messageId: args.original_source.message_id }
    const original = await ports.readUserSource(call.projectId, originalUserSource, exec.signal)
    if (!original.readable || !original.isUserDecision || !original.text?.trim()) return failed('指定原消息不是当前可核对的本项目用户原话。')
    const target = await ports.readTarget(call.projectId, args.execution_session_id)
    if (target === undefined || target.projectId !== call.projectId || target.sessionId !== args.execution_session_id || target.role !== 'execution') {
      return failed('目标已失效、无法访问，或不是本项目的执行会话；没有恢复或重建目标。')
    }
    ports.assertCurrent(call, target)
    const agent = ports.ctx.agents.get(SessionId(target.hostSessionId))
    const result: NativeProjectStopResult = agent === undefined
      ? { kind: 'no-current-run', request: 'not-sent', message: '目标当前没有已连接运行；没有为停止而启动或恢复会话。' }
      : await requestNativeProjectStop(ports.ctx, agent, exec.signal)
    return { ...base, ...result, target, originalUserSource, originalUserText: original.text }
  } catch (error) { return failed(`停止未执行：${errorText(error)}`) }
}

export interface ProjectControlToolRuntime { stopExecution(exec: ToolRunContext, args: StopExecutionArgs): Promise<JsonValue> }

/** 注册定向 Stop；权限、原话和目标在实际调用时核对，不依赖目标模型收信。 */
export function installProjectControlTools(agent: Agent, runtime: ProjectControlToolRuntime, installationRole: 'main' | 'execution' = 'main'): () => void {
  if (installationRole !== 'main') return () => {}
  return agent.ctx.tools.register(defineTool({
    name: 'project_stop_execution',
    description: 'Main-session only: stop the current native turn of an exact execution session in this Project, only for an explicit human user request. Supply its original native user-message locator, including when an execution session relays it. A retained user request can remain applicable in later turns; a locator confirms source, not the meaning or scope of Stop authorization. Agent suggestions, system failure notices and historical Goal records do not grant new Stop authority. Resolve ambiguous names before calling. The target model need not receive or answer a message. A sent cancel request is not confirmed stopped; report the actual turn observation. This does not cancel business work, roll back writes, disable future messages/schedules, archive, delete or recover a session.',
    parameters: {
      execution_session_id: { type: 'string', required: true, description: 'Exact Projects execution session ID from this Project, never a name.' },
      original_source: { type: 'object', required: true, additionalProperties: false, properties: {
        host_session_id: { type: 'string', required: true }, message_id: { type: 'string', required: true },
      } },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: (args, exec) => runtime.stopExecution(exec, args),
  }))
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
