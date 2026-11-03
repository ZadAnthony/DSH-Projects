import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type {} from '@deepseek-ai/dsh-agent/types'
import type { InboxTarget } from '@deepseek-ai/dsh-agent/types'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session/types'
import type { ProjectSchedule, ScheduleManager, ScheduleSource } from './contract.ts'
import { instant, normalizeScheduleRule } from './timing.ts'
import { managerSchema, sourceSchema } from './validation.ts'

/** 自动来源保留原管理定位；它自身不代表一项新的用户授权。 */
interface ProjectScheduleMessageSourceBase {
  readonly kind: 'project-schedule'
  readonly projectId: string
  readonly sessionId: string
  readonly scheduleId: string
  readonly occurrenceId: string
  readonly plannedAt: string
  readonly definitionRevision: number
  readonly ruleIdentity: string
  readonly managementSources?: readonly ScheduleSource[]
}
export type ProjectScheduleMessageSource = ProjectScheduleMessageSourceBase & (
  | { readonly trigger: 'automatic'; /** 最终ready裁决后发起投递的取样；不是准备或执行开始。 */ readonly triggeredAt?: string }
  | { readonly trigger: 'manual'; readonly requestId: string; readonly requestedAt: string
      readonly requestedBy: ScheduleManager; readonly acceptedRevision: number }
)

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'project-schedule': ProjectScheduleMessageSource
  }
}

/** 只表达真实原生事件；completed 不证明用户任务达成。 */
export interface ScheduleNativeObservation {
  /** 原事件顺序中该 message 的当前版本；旧取消版本仍单独保留。 */
  readonly current: boolean
  readonly source: ProjectScheduleMessageSource
  readonly hostSessionId: string
  readonly messageId: string
  readonly message: UserMessage
  readonly inserted: boolean
  readonly claimed: boolean
  readonly discarded: boolean
  readonly pending?: InboxTarget
  readonly turn?: number
  readonly end?: TurnEndReason['kind']
  readonly endReason?: TurnEndReason
  readonly error?: string
  readonly insertedAt?: number
  readonly claimedAt?: number
  readonly discardedAt?: number
  readonly startedAt?: number
  readonly endedAt?: number
}

type MutableObservation = { -readonly [K in keyof ScheduleNativeObservation]: ScheduleNativeObservation[K] }

/** 身份只含规范化规则和原始锚点，不受内容、修订或启停影响。 */
export function scheduleRuleIdentity(schedule: Pick<ProjectSchedule, 'rule' | 'anchorAt'>): string {
  instant(schedule.anchorAt)
  return identity('schedule-rule', [normalizeScheduleRule(schedule.rule), schedule.anchorAt])
}

/** 同一自动时隙跨进程保持相同身份；更改规则或锚点才产生另一组时隙。 */
export function scheduleOccurrenceId(
  schedule: Pick<ProjectSchedule, 'id' | 'projectId' | 'sessionId' | 'rule' | 'anchorAt'>,
  plannedAt: string,
): string {
  const planned = new Date(instant(plannedAt)).toISOString()
  return identity('project-schedule', [schedule.projectId, schedule.sessionId, schedule.id,
    scheduleRuleIdentity(schedule), planned, 'automatic'])
}

/** 手动身份只依赖真实目标与本次请求，不占用自动时隙。 */
export function manualScheduleOccurrenceId(
  schedule: Pick<ProjectSchedule, 'id' | 'projectId' | 'sessionId'>,
  requestId: string,
): string {
  if (typeof requestId !== 'string' || requestId.length === 0) throw new Error('invalid manual schedule request identity')
  return identity('project-schedule', [schedule.projectId, schedule.sessionId, schedule.id, requestId, 'manual'])
}

/** 当前行按事件顺序确定，不能用最大修订号、首行或曾取消推导。 */
export function currentScheduleObservations(rows: readonly ScheduleNativeObservation[]): ScheduleNativeObservation[] {
  return rows.filter(row => row.current)
}

function identity(prefix: string, fields: readonly unknown[]): string {
  return `${prefix}:${createHash('sha256').update(JSON.stringify(fields)).digest('hex')}`
}

/**
 * 输入必须是公共 reader 取得的真实持久日志前缀；prepared 的合成 closer 无法由事件外形辨别。
 * 本函数不读取/补写日志、不合成 interruption、不从缺失事件推断失败或未投递。
 */
export function foldScheduleNativeEvents(events: readonly SessionEvent[], hostSessionId: string): ScheduleNativeObservation[] {
  const inbox: Record<InboxTarget, UserMessage[]> = { 'next-turn': [], 'next-step': [] }
  const observations: MutableObservation[] = []
  const current = new Map<string, MutableObservation>()
  const manualRequests = new Map<string, readonly [string, string, ScheduleManager, number]>()
  let openTurn: { turn: number; startedAt: number } | undefined

  const observe = (message: UserMessage, insertion = false): MutableObservation | undefined => {
    if (message.source.kind !== 'project-schedule') return undefined
    const source = parseScheduleMessageSource(message.source)
    const previous = current.get(String(message.id))
    if (source.trigger === 'manual') {
      const identity = [source.requestId, source.requestedAt, source.requestedBy, source.acceptedRevision] as const
      const accepted = manualRequests.get(source.occurrenceId)
      if (accepted !== undefined && !isDeepStrictEqual(accepted, identity)) {
        throw new Error('invalid native project-schedule immutable manual request')
      }
      manualRequests.set(source.occurrenceId, identity)
    }
    // 同 source 的原位替换也产生新一段真实输入生命周期，不能留下 sticky canceled。
    if (!insertion && previous !== undefined && !previous.discarded
      && JSON.stringify(previous.source) === JSON.stringify(source)) return previous
    if (previous !== undefined) previous.current = false
    const observation: MutableObservation = { current: true, source, hostSessionId, messageId: String(message.id),
      message: structuredClone({ ...message, source }), inserted: false, claimed: false, discarded: false }
    observations.push(observation)
    current.set(String(message.id), observation)
    return observation
  }

  const claim = (observation: MutableObservation, time: number): void => {
    if (openTurn === undefined) return
    observation.claimed = true
    observation.claimedAt ??= time
    observation.turn = openTurn.turn
    observation.startedAt = openTurn.startedAt
  }

  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        openTurn = { turn: event.data.turn, startedAt: event.time }
        break
      case 'agent/inbox/spliced': {
        const splice = event.data
        const pending = inbox[splice.target]
        const removedCount = splice.removedCount ?? 0
        // 与原生 Inbox projection 的合法索引和跨队列唯一性保持同一合同。
        if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > pending.length
          || !Number.isSafeInteger(removedCount) || removedCount < 0
          || splice.start + removedCount > pending.length) {
          throw new Error(`invalid persisted inbox splice at session seq ${event.seq}`)
        }
        const removed = pending.slice(splice.start, splice.start + removedCount)
        const next = pending.toSpliced(splice.start, removedCount, ...splice.inserted)
        const other = inbox[splice.target === 'next-turn' ? 'next-step' : 'next-turn']
        if (new Set([...next, ...other].map(message => message.id)).size !== next.length + other.length) {
          throw new Error(`duplicate pending message at session seq ${event.seq}`)
        }
        inbox[splice.target] = next
        for (const message of removed) {
          const observation = observe(message)
          if (observation === undefined) continue
          delete observation.pending
          if (splice.outcome === 'canceled') {
            observation.discarded = true
            observation.discardedAt = event.time
          } else {
            // 原生 claim 在 turn/start 之后移除；孤立的缺省移除不伪造 claim 或失败。
            claim(observation, event.time)
          }
        }
        for (const message of splice.inserted) {
          const observation = observe(message, true)
          if (observation === undefined) continue
          observation.inserted = true
          observation.insertedAt ??= event.time
          observation.pending = splice.target
          observation.message = structuredClone({ ...message, source: observation.source })
        }
        break
      }
      case 'user/message': {
        // replacement 是模型上下文副本，不能成为新的原文或活动，也不能重关联旧轮次。
        if (event.surfaceOp !== 'append') break
        const observation = observe(event.data)
        if (observation !== undefined) claim(observation, event.time)
        break
      }
      case 'turn/end': {
        for (const observation of observations) {
          if (!observation.claimed || observation.turn !== event.data.turn) continue
          observation.end = event.data.reason.kind
          observation.endReason = structuredClone(event.data.reason)
          observation.endedAt = event.time
          if (event.data.reason.kind === 'error') observation.error = event.data.reason.error.message
        }
        if (openTurn?.turn === event.data.turn) openTurn = undefined
        break
      }
    }
  }
  return observations
}

/** 严格核 producer 必需字段；旧 automatic 保持兼容，未知旧 manual 不补造请求事实。 */
export function parseScheduleMessageSource(raw: unknown): ProjectScheduleMessageSource {
  if (typeof raw !== 'object' || raw === null) throw new Error('invalid native project-schedule source')
  const source = raw as Record<string, unknown>
  if (source.kind !== 'project-schedule'
    || ![source.projectId, source.sessionId, source.scheduleId, source.occurrenceId, source.ruleIdentity]
      .every(value => typeof value === 'string' && value.length > 0)
    || (source.trigger !== 'automatic' && source.trigger !== 'manual')
    || !Number.isSafeInteger(source.definitionRevision) || (source.definitionRevision as number) < 1
    || typeof source.plannedAt !== 'string') throw new Error('invalid native project-schedule source')
  instant(source.plannedAt)
  const base: ProjectScheduleMessageSourceBase = {
    kind: 'project-schedule', projectId: source.projectId as string, sessionId: source.sessionId as string,
    scheduleId: source.scheduleId as string, occurrenceId: source.occurrenceId as string, plannedAt: source.plannedAt,
    definitionRevision: source.definitionRevision as number, ruleIdentity: source.ruleIdentity as string,
    ...(source.managementSources === undefined ? {} : { managementSources: Array.isArray(source.managementSources)
      ? source.managementSources.map(item => sourceSchema.parse(item)) : invalidSource() }),
  }
  if (source.trigger === 'automatic') {
    if (source.triggeredAt !== undefined) {
      if (typeof source.triggeredAt !== 'string') throw new Error('invalid native project-schedule trigger time')
      instant(source.triggeredAt)
    }
    return { ...base, trigger: 'automatic', ...(source.triggeredAt === undefined ? {} : { triggeredAt: source.triggeredAt }) }
  }
  if (typeof source.requestId !== 'string' || !source.requestId
    || typeof source.requestedAt !== 'string' || source.requestedAt !== source.plannedAt
    || !Number.isSafeInteger(source.acceptedRevision) || (source.acceptedRevision as number) < 1
    || (source.acceptedRevision as number) > base.definitionRevision) throw new Error('invalid native project-schedule source')
  instant(source.requestedAt)
  const requestedBy = managerSchema.parse(source.requestedBy) as ScheduleManager
  const result: ProjectScheduleMessageSource = { ...base, trigger: 'manual', requestId: source.requestId,
    requestedAt: source.requestedAt, requestedBy, acceptedRevision: source.acceptedRevision as number }
  if (result.occurrenceId !== manualScheduleOccurrenceId({ id: result.scheduleId, projectId: result.projectId,
    sessionId: result.sessionId }, result.requestId)) throw new Error('invalid native project-schedule manual identity')
  return result
}
function invalidSource(): never { throw new Error('invalid native project-schedule source') }
