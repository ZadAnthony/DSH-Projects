import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContextSnapshotSection, UserMessage } from '@deepseek-ai/dsh-llm'
import type { ScheduleRunTiming } from './contract.ts'
import { currentScheduleObservations, foldScheduleNativeEvents } from './native.ts'
import type { ScheduleNativeObservation } from './native.ts'

interface ScheduleTimingSource {
  readonly kind: 'project-schedule-timing'
  readonly producer: 'projects'
  readonly form: 'snapshot'
  readonly projectId: string
  readonly sessionId: string
  readonly turn: number
  readonly sections: readonly ContextSnapshotSection[]
}

/** Plugin-owned current request block; stock Session does not own Harness assembly. */
export interface ScheduleRequestCurrentBlock {
  readonly producer: 'projects'
  readonly key: string
  readonly value: { readonly content: UserMessage['content']; readonly source: ScheduleTimingSource }
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'project-schedule-timing': ScheduleTimingSource }
}

/** 两个读取入口共用原事实；同message的待执行替换不覆盖最初真实入队时间。 */
export function scheduleRunTiming(row: ScheduleNativeObservation, observations: readonly ScheduleNativeObservation[]): ScheduleRunTiming {
  // observations沿原生日志顺序；wall clock回拨时，最小UTC并非最初入队。
  const insertion = observations.find(item => item.hostSessionId === row.hostSessionId && item.messageId === row.messageId
    && item.source.projectId === row.source.projectId && item.source.sessionId === row.source.sessionId
    && item.source.occurrenceId === row.source.occurrenceId && item.insertedAt !== undefined)
  const timestamp = (value: number | undefined) => value === undefined ? null : new Date(value).toISOString()
  const timing: ScheduleRunTiming = {
    plannedAt: row.source.plannedAt, plannedTimeBasis: row.source.trigger === 'manual' ? 'manual-request' : 'automatic-slot',
    triggeredAt: row.source.trigger === 'automatic' ? row.source.triggeredAt ?? null : null,
    requestedAt: row.source.trigger === 'manual' ? row.source.requestedAt : null,
    queuedAt: timestamp(insertion?.insertedAt),
    claimedAt: timestamp(row.claimedAt), processingStartedAt: timestamp(row.startedAt), unknownFields: [],
  }
  if (row.source.trigger === 'automatic' && timing.triggeredAt === null) timing.unknownFields.push('triggeredAt')
  for (const field of ['queuedAt', 'claimedAt', 'processingStartedAt'] as const) if (timing[field] === null) timing.unknownFields.push(field)
  return timing
}

/** 首次user/message尚未append时，turn/start和真实Inbox claim已在原生日志中。 */
export function prepareScheduleRequestContext(agent: Agent, scope: { projectId: string; sessionId: string }, turn?: number): readonly ScheduleRequestCurrentBlock[] {
  if (turn === undefined) return []
  const observations = foldScheduleNativeEvents(agent.session.snapshotEvents(), String(agent.id))
  const runs = currentScheduleObservations(observations).filter(row => row.claimed && row.turn === turn
    && row.source.projectId === scope.projectId && row.source.sessionId === scope.sessionId).map(row => ({
    scheduleId: row.source.scheduleId, occurrenceId: row.source.occurrenceId, trigger: row.source.trigger,
    source: { kind: 'message', hostSessionId: row.hostSessionId, messageId: row.messageId },
    timing: scheduleRunTiming(row, observations),
  }))
  if (runs.length === 0) return []
  const key = `schedule-timing:${scope.projectId}:${scope.sessionId}`
  const text = [
    'Projects系统提供的本处理回合定时／现在运行时间事实；不是用户新决定或新授权。所有时点为UTC。',
    'automatic-slot的plannedAt是规则时隙；triggeredAt是调度器最终ready后发起投递的取样，既不是准备解析Agent开始，也不是实际处理开始。manual-request的plannedAt等于requestedAt，表示本次立即运行请求的实际接纳时点，不是原自动计划时隙或浏览器点击时点。另一种触发方式的triggeredAt／requestedAt为null且不适用。',
    'queuedAt来自本输入最初真实入队；claimedAt来自实际领取；processingStartedAt来自关联原生turn/start，只表示处理回合开始，不表示模型请求发出、工具许可或业务完成。unknownFields列出的null为原来源未提供、未知，不能用计划、link.observedAt或现在回填；link.observedAt仍只是原运行关联的观察。完整设置与本次运行按project_schedule_list查询。',
    JSON.stringify({ projectId: scope.projectId, sessionId: scope.sessionId, turn, runs }),
  ].join('\n')
  return [{ producer: 'projects', key, value: { content: [{ type: 'text', text }], source: {
    kind: 'project-schedule-timing', producer: 'projects', form: 'snapshot', ...scope, turn,
    sections: [{ name: key, text }],
  } } }]
}
