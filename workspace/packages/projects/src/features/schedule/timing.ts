import {
  ScheduleId, createAfterScheduleRecord, createAtScheduleRecord, createEveryScheduleRecord,
  createDailyScheduleRecord, createWeeklyScheduleRecord, createCronScheduleRecord,
  resolveRecurringOccurrence, scheduleTitle, parseWeeklyInput, parseCronInput,
} from '@deepseek-ai/dsh-schedule'
import type { RecurringScheduleRecord, ScheduleRecord } from '@deepseek-ai/dsh-schedule'
import type { ProjectSchedule, ScheduleDecision, ScheduleDecisionInput, ScheduleRule, ScheduleTimeView, ScheduleRunLink } from './contract.ts'
import { ruleSchema, utcTimeSchema } from './validation.ts'

export function instant(value: string): number {
  utcTimeSchema.parse(value)
  const ms = Date.parse(value)
  if (!Number.isSafeInteger(ms) || !/^\d{4}-\d\d-\d\dT.*Z$/.test(value)) throw new Error('时间必须为可表示的 UTC 时刻。')
  return ms
}

export function validateScheduleText(title: string, prompt: string): void {
  scheduleTitle(title)
  if (!prompt.trim()) throw new Error('计划内容不能为空。')
}

/**
 * rc.2 根入口未导出 at/daily 的纯解析器。公开 weekly 解析器复用同一时钟/时区校验，
 * 此处只取其规范化结果，不创建星期计划或计算未来时刻。
 */
function clockZone(time: string, timeZone: string): { time: string; timeZone: string } {
  const parsed = parseWeeklyInput({ time, time_zone: timeZone, weekdays: [1] })
  return { time: parsed.time, timeZone: parsed.timeZone }
}

/** 在任何新锚点计算之前识别规则语义；不依赖当前时钟或“必须未来”的创建约束。 */
export function normalizeScheduleRule(input: ScheduleRule): ScheduleRule {
  const rule = ruleSchema.parse(input) as ScheduleRule
  switch (rule.kind) {
    case 'at': return { kind: 'at', date: rule.date, ...clockZone(rule.time, rule.timeZone) }
    case 'daily': return { kind: 'daily', ...clockZone(rule.time, rule.timeZone) }
    case 'weekly': {
      const parsed = parseWeeklyInput({ time: rule.time, time_zone: rule.timeZone, weekdays: rule.weekdays })
      return { kind: 'weekly', time: parsed.time, timeZone: parsed.timeZone, weekdays: [...parsed.weekdays] }
    }
    case 'cron': return { kind: 'cron', ...parseCronInput({ expression: rule.expression, time_zone: rule.timeZone }) }
    case 'after': return { kind: 'after', afterSeconds: rule.afterSeconds, timeZone: clockZone('00:00:00', rule.timeZone).timeZone }
    case 'every': return { kind: 'every', everySeconds: rule.everySeconds, timeZone: clockZone('00:00:00', rule.timeZone).timeZone }
  }
}

/** 只调用公开纯计算函数，不实例化/安装原生 ScheduleService。 */
export function createScheduleAnchor(input: ScheduleRule, now: string, title: string, prompt: string): { rule: ScheduleRule; anchorAt: string } {
  const rule = normalizeScheduleRule(input)
  const timeZone = rule.timeZone
  const id = ScheduleId('projects-calculation-only'); const at = instant(now)
  let record: ScheduleRecord
  switch (rule.kind) {
    case 'at': record = createAtScheduleRecord(id, prompt, { date: rule.date, time: rule.time, time_zone: timeZone }, at, title); break
    case 'after': record = createAfterScheduleRecord(id, prompt, rule.afterSeconds, at, title); break
    case 'every': record = createEveryScheduleRecord(id, prompt, rule.everySeconds, at, title); break
    case 'daily': record = createDailyScheduleRecord(id, prompt, { time: rule.time, time_zone: timeZone }, at, title); break
    case 'weekly': record = createWeeklyScheduleRecord(id, prompt, { time: rule.time, time_zone: timeZone, weekdays: rule.weekdays }, at, title); break
    case 'cron': record = createCronScheduleRecord(id, prompt, { expression: rule.expression, time_zone: timeZone }, at, title); break
  }
  return { rule, anchorAt: record.scheduledAt }
}

/** before 是真实恢复边界或调用者明确要预览的时刻；绝不能隐式换成通知处理时间。 */
export function nextScheduleTime(schedule: Pick<ProjectSchedule, 'rule' | 'anchorAt'>, before: string): ScheduleTimeView {
  const cutoff = instant(before); const first = instant(schedule.anchorAt)
  if (first > cutoff) return { kind: 'future', nextAt: schedule.anchorAt }
  const rule = schedule.rule
  if (rule.kind === 'at' || rule.kind === 'after') return { kind: 'expired-once' }
  const common = { id: ScheduleId('projects-calculation-only'), title: 'calculation', prompt: 'calculation', scheduledAt: schedule.anchorAt }
  const record = { ...common, ...rule } as RecurringScheduleRecord
  const nextAt = resolveRecurringOccurrence(record, cutoff).nextScheduledAt
  return nextAt === undefined ? { kind: 'exhausted' } : { kind: 'future', nextAt }
}

export function decideSchedule(input: ScheduleDecisionInput): ScheduleDecision {
  if (input.admission.kind === 'enqueued') return { kind: 'keep-enqueued', message: input.admission.message }
  if (input.admission.kind === 'uncertain') return { kind: 'unknown', reason: input.admission.reason }
  let now: number; let planned: number
  try { now = instant(input.now); planned = instant(input.plannedAt) }
  catch { return { kind: 'unknown', reason: '计划或当前时钟事实不一致。' } }
  // 未开始的未来项沿原wait；已开始项可能被校时移到当前wall未来，先核其当前段资格。
  if (planned > now && input.preparation?.kind !== 'started') return { kind: 'wait', plannedAt: input.plannedAt }
  if (!input.schedule.enabled) return { kind: 'suppressed', reason: 'disabled' }
  if (input.projectArchived || input.sessionArchived) return { kind: 'suppressed', reason: 'archived' }
  const facts = input.availability
  if (facts.kind === 'unknown') return { kind: 'unknown', reason: facts.reason }
  if (facts.kind !== 'known' || typeof facts.available !== 'boolean' || typeof facts.hostStartedAt !== 'string') {
    return { kind: 'unknown', reason: '启动或运行条件事实缺失。' }
  }
  let fixedBoundary: number; let enabledAt: number; let recovered: number | undefined
  let window: { lower: number; upper: number } | undefined
  const native = facts.provenance === 'darwin-kernel'
  try {
    fixedBoundary = Math.max(...[facts.hostStartedAt, facts.projectRestoredAt, facts.sessionRestoredAt,
      ...(native ? [facts.baselineAt] : [])].filter((value): value is string => value !== undefined).map(instant))
    enabledAt = instant(input.enabledAt ?? input.schedule.enabledSince ?? input.schedule.createdAt)
    if (Math.max(fixedBoundary, enabledAt) > now) throw new Error('future boundary')
    if (native) {
      if (instant(facts.observedAt) > now || instant(facts.baselineAt) > instant(facts.observedAt) || !Number.isSafeInteger(facts.epoch) || facts.epoch < 0
        || !Number.isSafeInteger(facts.baselineEpoch) || facts.baselineEpoch < 0 || facts.baselineEpoch > facts.epoch) throw new Error('epoch')
      if (facts.recoveryWindow !== undefined) {
        window = { lower: instant(facts.recoveryWindow.lowerBound), upper: instant(facts.recoveryWindow.upperBound) }
        // µs 原样本的 UTC floor/ceil 表示最多张开 1ms；上界不是一个未来恢复点。
        if (window.lower < instant(facts.baselineAt) || window.lower > window.upper || instant(facts.observedAt) > now || window.upper > instant(facts.observedAt) + 1) throw new Error('window')
      }
    } else if (facts.recoveredAt !== undefined) {
      recovered = instant(facts.recoveredAt)
      if (recovered > now) throw new Error('future recovery')
    }
  } catch { return { kind: 'unknown', reason: '启动、恢复范围或时钟事实不一致。' } }
  if (!facts.available) return { kind: 'suppressed', reason: 'host-unavailable' }
  if (native && input.preparation?.kind === 'started' && (input.preparation.epoch ?? -1) < facts.baselineEpoch) {
    return { kind: 'unknown', reason: '原准备跨过时钟连续性断裂；当前基线不恢复旧准备资格。' }
  }
  if (planned > now) return { kind: 'wait', plannedAt: input.plannedAt }
  const fixedCutoff = Math.max(fixedBoundary, enabledAt)
  const skip = (cutoff: number, reason: 'before-recovery' | 'before-enable'): ScheduleDecision => {
    const boundaryAt = new Date(cutoff).toISOString()
    try {
      const future = nextScheduleTime(input.schedule, boundaryAt)
      return { kind: 'skip', reason, boundaryAt, ...(future.nextAt === undefined ? {} : { nextAt: future.nextAt }) }
    } catch { return { kind: 'unknown', reason: '无法根据原规则计算恢复后的计划。' } }
  }
  if (planned <= fixedCutoff) return skip(fixedCutoff, enabledAt > fixedBoundary ? 'before-enable' : 'before-recovery')
  if (input.preparation?.kind === 'uncertain') return { kind: 'unknown', reason: input.preparation.reason,
    ...(window === undefined ? {} : { unresolvedUntil: new Date(window.upper).toISOString() }) }
  if (input.preparation?.kind === 'started') {
    const prepared = input.preparation
    try {
      const startedAt = instant(prepared.startedAt)
      if (startedAt < planned || startedAt > now) throw new Error('start')
      if (native) {
        if (!Number.isSafeInteger(prepared.epoch) || prepared.epoch! < 0 || prepared.epoch! > facts.epoch
          || prepared.epoch! < facts.baselineEpoch || prepared.baselineAt !== facts.baselineAt || prepared.recoveredAt !== undefined) throw new Error('start epoch')
      } else {
        const startRecovery = prepared.recoveredAt === undefined ? -Infinity : instant(prepared.recoveredAt)
        if (prepared.epoch !== undefined || prepared.baselineAt !== undefined || startRecovery >= planned
          || startRecovery > startedAt || (recovered ?? -Infinity) < startRecovery) throw new Error('start recovery')
      }
      // 资格已由真实调用处确认；只越过后来电源恢复，固定生命周期边界已在上方检查。
      return { kind: 'ready', plannedAt: input.plannedAt }
    } catch { return { kind: 'unknown', reason: '原准备的开始或恢复事实不一致。' } }
  }
  if (native && window !== undefined) {
    if (planned <= window.lower) return skip(window.lower, 'before-recovery')
    if (planned <= window.upper) return { kind: 'unknown',
      reason: recoveryUnknownReason(facts.recoveryWindow!.lowerBound, facts.recoveryWindow!.upperBound),
      unresolvedUntil: facts.recoveryWindow!.upperBound }
  } else if (recovered !== undefined && planned <= recovered) return skip(recovered, 'before-recovery')
  return { kind: 'ready', plannedAt: input.plannedAt }
}

export function recoveryUnknownReason(lower: string, upper: string): string {
  return `计划位于真实恢复范围 ${lower} 至 ${upper} 内，无法确认它在恢复前还是恢复后；该范围内的次数保持未知，不补投。`
}
/** 仅兼容本owner旧版完整范围文案；不从任意文字推断消费上界。 */
const qualificationPrefix = '本次自动尝试发送资格未确认，未调用原生send；不改写旧运行结果。'
export function qualificationUnknownReason(reason: string): string { return qualificationPrefix + reason }
export function savedUnknownRangeUpper(link: ScheduleRunLink, schedule: ProjectSchedule, ruleIdentity: string, occurrenceId: string, plannedAt: string): string | undefined {
  const row = link.observation
  if (link.trigger !== 'automatic' || link.projectId !== schedule.projectId || link.sessionId !== schedule.sessionId
    || link.scheduleId !== schedule.id || row?.outcome !== 'unknown' || row.ruleIdentity !== ruleIdentity
    || row.occurrenceId !== occurrenceId || link.id !== occurrenceId) return undefined
  const reason = row.reason.startsWith(qualificationPrefix) ? row.reason.slice(qualificationPrefix.length) : row.reason
  const match = /^计划位于真实恢复范围 (\S+) 至 (\S+) 内，无法确认它在恢复前还是恢复后；该范围内的次数保持未知，不补投。$/.exec(reason)
  if (!match) return undefined
  try {
    const lower = instant(match[1]!), upper = instant(match[2]!), planned = instant(link.plannedAt)
    if (lower > upper || planned <= lower || planned > upper || planned !== instant(plannedAt)) return undefined
    return match[2]
  } catch { return undefined }
}
