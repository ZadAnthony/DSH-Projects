import { isDeepStrictEqual } from 'node:util'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ProjectSchedule, SchedulePendingEffect, ScheduleRunLink } from './contract.ts'
import { parseScheduleMessageSource, scheduleOccurrenceId, scheduleRuleIdentity } from './native.ts'
import { scheduleSchema } from './validation.ts'

/** 只看原 Inbox；不读配置、不启动目标，也不把文本当来源。 */
export function hasSchedulePending(agent: Agent): boolean {
  return [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => message.source.kind === 'project-schedule')
}

/** automatic 与 manual 共用正文 owner；不追加新的任务或用户决定。 */
export function renderSchedulePrompt(schedule: Pick<ProjectSchedule, 'title' | 'prompt'>, trigger: 'automatic' | 'manual' = 'automatic'): string {
  return `${trigger === 'manual' ? '手动运行任务' : '定时任务'}「${schedule.title}」

${schedule.prompt}

沿原会话当前要求与许可处理；若上轮操作结果未明，先核对，不盲目重复。`
}

interface PendingScope { projectId: string; sessionId: string; hostSessionId: string }
interface PendingChange { target: 'next-turn' | 'next-step'; message: UserMessage; replacement?: UserMessage }

/** 同一 Store slot 内先完整核选集，再同步精确修改；不读盘、不 flush、不 send。 */
export function coordinateSchedulePending(
  agent: Agent,
  scope: PendingScope,
  state: { schedules: ProjectSchedule[]; runs: ScheduleRunLink[] },
): SchedulePendingEffect {
  if (String(agent.session.id) !== scope.hostSessionId) throw new Error('定时待执行输入的原生目标不一致。')
  const changes: PendingChange[] = []
  const ids = new Set<string>()
  for (const target of ['next-turn', 'next-step'] as const) {
    const messages = target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep
    for (const message of messages) {
      if (message.source.kind !== 'project-schedule') continue
      const source = parseScheduleMessageSource(message.source)
      if (source.projectId !== scope.projectId || source.sessionId !== scope.sessionId) {
        throw new Error('定时待执行输入不属于此项目原目标。')
      }
      if (ids.has(String(message.id))) throw new Error('定时待执行输入标识重复。')
      ids.add(String(message.id))
      const matches = state.schedules.filter(item => item.id === source.scheduleId)
      if (matches.length > 1) throw new Error('定时定义标识重复。')
      const schedule = matches[0] === undefined ? undefined : scheduleSchema.parse(matches[0]) as ProjectSchedule
      if (schedule === undefined) { changes.push({ target, message }); continue }
      if (schedule.projectId !== scope.projectId || schedule.sessionId !== scope.sessionId) {
        throw new Error('定时定义与待执行输入的归属不一致。')
      }
      if (source.definitionRevision > schedule.revision) throw new Error('定时待执行输入使用了无法确认的未来修订。')
      const ruleIdentity = scheduleRuleIdentity(schedule)
      if (source.definitionRevision === schedule.revision && source.ruleIdentity !== ruleIdentity) {
        throw new Error('定时待执行输入的同修订规则身份矛盾。')
      }
      if (source.trigger === 'automatic') {
        if (!schedule.enabled || source.ruleIdentity !== ruleIdentity
          || source.definitionRevision < (schedule.manualCancelRevision ?? 0)) {
          changes.push({ target, message }); continue
        }
        if (source.occurrenceId !== scheduleOccurrenceId(schedule, source.plannedAt)) {
          throw new Error('定时待执行输入的自动时隙身份不一致。')
        }
      } else if (source.acceptedRevision < (schedule.manualCancelRevision ?? 0)) {
        changes.push({ target, message }); continue
      }
      const attribution = { ...source, definitionRevision: schedule.revision, ruleIdentity,
        managementSources: structuredClone(schedule.updatedBy.sources) }
      const replacement: UserMessage = { ...message, source: attribution,
        content: [{ type: 'text', text: renderSchedulePrompt(schedule, source.trigger) }] }
      if (!isDeepStrictEqual(replacement, message)) changes.push({ target, message, replacement })
    }
  }
  const effect: SchedulePendingEffect = { kind: 'unchanged', updatedMessageIds: [], removedMessageIds: [] }
  try {
    for (const change of changes) {
      const messages = change.target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep
      const current = messages.find(item => item.id === change.message.id)
      // 已被领取或由原生消费者替换，不追杀当前轮，也不覆盖另一版本。
      if (current === undefined || !isDeepStrictEqual(current, change.message)) continue
      if (change.replacement === undefined) {
        if (agent.inbox.remove(change.message.id)) effect.removedMessageIds.push(String(change.message.id))
      } else if (agent.inbox.replace(change.message.id, change.replacement)) effect.updatedMessageIds.push(String(change.message.id))
    }
    if (effect.updatedMessageIds.length + effect.removedMessageIds.length > 0) effect.kind = 'applied'
    return effect
  } catch (error) {
    return { ...effect, kind: 'unconfirmed', error: error instanceof Error ? error.message : String(error) }
  }
}
