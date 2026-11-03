/** 将真实工作轮 error 终态一次性投递为系统输入；不调失败模型、不自动补救。 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { NativeProjectSource } from './source-reader.ts'
import { currentNativeProjectRun } from './project-control-tools.ts'
import type { NativeProjectRun } from './project-control-tools.ts'

type MessageSourceRef = Extract<NativeProjectSource, { kind: 'message' }>
export type ProjectExecutionFailureInput =
  | { readonly producer: 'user'; readonly source: MessageSourceRef }
  | { readonly producer: 'project-delivery'; readonly source: MessageSourceRef; readonly deliveryId: string; readonly senderSessionId: string; readonly targetSessionId: string }
  | { readonly producer: 'goal'; readonly source: MessageSourceRef; readonly goalId: string; readonly revision: number; readonly round: number }

/** 公开且可保存的最小事实；原生 session+turn+seq 标识运行，不另存 Goal 或运行台账。 */
export interface ProjectExecutionFailureMessageSource {
  readonly kind: 'project-execution-failure'
  readonly projectId: string
  readonly sessionId: string
  readonly hostSessionId: string
  readonly run: NativeProjectRun & { readonly endSeq: number }
  readonly inputs: readonly ProjectExecutionFailureInput[]
  readonly failedAt: number
  readonly reason: { readonly code: string; readonly message: string }
  readonly sessionEntry: { readonly kind: 'execution'; readonly sessionId: string; readonly hostSessionId: string }
  readonly sideEffects: 'unknown'
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'project-execution-failure': ProjectExecutionFailureMessageSource }
}
export interface ExecutionFailureIdentity {
  readonly projectId: string
  readonly sessionId: string
  readonly hostSessionId: string
  readonly role: 'main' | 'execution' | 'memory'
}
export interface ExecutionFailureDeliveryResult {
  readonly insertion: 'inserted' | 'not-inserted' | 'unknown'
  readonly wakeup: boolean | 'unknown'
  readonly persistence: 'flushed' | 'unavailable' | 'failed' | 'not-started'
  readonly error?: string
}
export interface ExecutionFailureNoticeObservation {
  readonly source: ProjectExecutionFailureMessageSource
  readonly messageId: string
  readonly delivery: ExecutionFailureDeliveryResult
}
export interface ExecutionFailureNoticePorts {
  /** 仅检查当前 Runtime/后台仍活动；主会话归档不在这里丢弃通知。 */
  canNotify(): boolean
  /** 解析本项目当前主会话，沿正常 target operation/inbox/flush；归档不唤醒，删除不重建。 */
  deliver(source: ProjectExecutionFailureMessageSource, message: UserMessage): Promise<ExecutionFailureDeliveryResult>
  /** 投递事实和失败/未知由调用方呈现；不能把入队当回应或业务处理。 */
  observed(observation: ExecutionFailureNoticeObservation): void
}
export interface ExecutionFailureNoticeInstallation {
  dispose(): void
  /** 只结算已开始的本地投递，不补发历史终态、不重试。 */
  whenSettled(): Promise<void>
}
interface TrackedTurn {
  readonly run: NativeProjectRun
  trigger?: string
  readonly inputs: Map<string, ProjectExecutionFailureInput>
}

/** 同一 Agent 安装一次；只消费安装后的真实事件，当前未闭合轮可沿原日志关联。 */
export function installExecutionFailureNotices(agent: Agent, identity: ExecutionFailureIdentity, ports: ExecutionFailureNoticePorts): ExecutionFailureNoticeInstallation {
  if (String(agent.id) !== identity.hostSessionId) throw new Error('失败通知必须绑定同一个原生执行会话。')
  const pending = new Set<Promise<void>>()
  let current: TrackedTurn | undefined
  let disposed = false
  const events = agent.session.snapshotEvents()
  const run = currentNativeProjectRun(events)
  if (run !== undefined) {
    current = { run, inputs: new Map() }
    for (const event of events) if (event.seq > run.startSeq && event.type === 'user/message') recordInput(current, identity, event.data, false)
  }
  const claimed = agent.ctx.on('agent/inbox/claimed', ({ message, turn }) => {
    if (current?.run.turn === turn) recordInput(current, identity, message, true)
  })
  const observed = agent.ctx.on('session/event', (session, event) => {
    if (disposed || session !== agent.session) return
    if (event.type === 'turn/start') { current = { run: { turn: event.data.turn, startSeq: event.seq }, inputs: new Map() }; return }
    if (event.type === 'user/message' && current !== undefined) { recordInput(current, identity, event.data, false); return }
    if (event.type !== 'turn/end' || current?.run.turn !== event.data.turn) return
    const ended = current
    // 消费后即释放此轮身份；重复事件、投递失败或后来 idle 不会再发同轮通知。
    current = undefined
    if (identity.role !== 'execution' || event.data.reason.kind !== 'error' || !ports.canNotify()
      || !['user', 'project-delivery', 'goal'].includes(ended.trigger ?? '') || ended.inputs.size === 0) return
    const source: ProjectExecutionFailureMessageSource = {
      kind: 'project-execution-failure', projectId: identity.projectId, sessionId: identity.sessionId, hostSessionId: identity.hostSessionId,
      run: { ...ended.run, endSeq: event.seq }, inputs: [...ended.inputs.values()], failedAt: event.time,
      reason: { code: event.data.reason.error.code, message: event.data.reason.error.message },
      sessionEntry: { kind: 'execution', sessionId: identity.sessionId, hostSessionId: identity.hostSessionId }, sideEffects: 'unknown',
    }
    const message = executionFailureMessage(source)
    const task = (async () => {
      let delivery: ExecutionFailureDeliveryResult
      try { delivery = await ports.deliver(source, message) }
      catch (error) { delivery = { insertion: 'unknown', wakeup: 'unknown', persistence: 'not-started', error: errorText(error) } }
      try { ports.observed({ source, messageId: String(message.id), delivery }) }
      catch (error) { agent.ctx.logger.warn(`projects: failure notice observation unavailable: ${errorText(error)}`) }
    })()
    pending.add(task)
    void task.finally(() => pending.delete(task))
  })
  return {
    dispose: () => { disposed = true; current = undefined; claimed(); observed() },
    whenSettled: async () => { while (pending.size > 0) await Promise.all([...pending]) },
  }
}

/** 原生消息带系统 producer，正文只声明已知终止事实与未确认副作用。 */
export function executionFailureMessage(source: ProjectExecutionFailureMessageSource): UserMessage {
  return createUserMessage({ source, content: [{ type: 'text', text: [
    '系统运行失败通知（不是用户指令，也不是执行 Agent 汇报）',
    `项目：${source.projectId}；执行会话：${source.sessionId}；原生会话：${source.hostSessionId}`,
    `失败运行：turn ${source.run.turn}，原生日志 ${source.run.startSeq}–${source.run.endSeq}；时间：${new Date(source.failedAt).toISOString()}`,
    `原输入来源：${JSON.stringify(source.inputs)}`,
    `已知技术原因：${source.reason.code}：${source.reason.message}`,
    `原会话入口：${JSON.stringify(source.sessionEntry)}`,
    '已确认该轮以技术错误终止；已发生的文件、工具或外部操作范围未知，不能假定未发生或已回滚。',
    '通知不授予自动重试、重派、恢复工作或重新激活 Goal 的权限。请核对已有结果、影响及原授权；收到或回应不等于问题已解决。',
  ].join('\n') }] })
}

function recordInput(turn: TrackedTurn, identity: ExecutionFailureIdentity, message: UserMessage, claimed: boolean): void {
  const raw: unknown = message.source
  if (typeof raw !== 'object' || raw === null || !('kind' in raw) || typeof raw.kind !== 'string') return
  // claim 是真实外来输入；日志里的内部上下文不是触发来源。
  if (claimed && turn.trigger === undefined) turn.trigger = raw.kind
  const source: MessageSourceRef = { kind: 'message', hostSessionId: identity.hostSessionId, messageId: String(message.id) }
  let input: ProjectExecutionFailureInput | undefined
  if (raw.kind === 'user') input = { producer: 'user', source }
  else if (raw.kind === 'project-delivery' && 'projectId' in raw && raw.projectId === identity.projectId
    && 'deliveryId' in raw && typeof raw.deliveryId === 'string' && 'senderSessionId' in raw && typeof raw.senderSessionId === 'string'
    && 'targetSessionId' in raw && raw.targetSessionId === identity.sessionId) {
    input = { producer: 'project-delivery', source, deliveryId: raw.deliveryId, senderSessionId: raw.senderSessionId, targetSessionId: raw.targetSessionId }
  } else if (raw.kind === 'goal' && 'goalId' in raw && typeof raw.goalId === 'string' && raw.goalId.length > 0
    && 'revision' in raw && typeof raw.revision === 'number' && Number.isSafeInteger(raw.revision) && raw.revision >= 0
    && 'round' in raw && typeof raw.round === 'number' && Number.isSafeInteger(raw.round) && raw.round > 0) {
    input = { producer: 'goal', source, goalId: raw.goalId, revision: raw.revision, round: raw.round }
  }
  if (input !== undefined) {
    turn.trigger ??= input.producer
    turn.inputs.set(source.messageId, input)
  } else if (!claimed && (raw.kind === 'project-schedule' || raw.kind === 'project-memory-batch' || raw.kind === 'project-execution-failure')) turn.trigger ??= raw.kind
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
