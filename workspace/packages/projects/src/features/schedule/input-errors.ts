/** 只标识保存变换前由原生规则解析器拒绝的输入；不承载持久化结果。 */
export const SCHEDULE_INPUT_NAMESPACE = 'projects/schedule-input'
export type ScheduleInputField = 'title' | 'timeZone' | 'expression' | 'date' | 'time' | 'weekdays' | 'afterSeconds' | 'everySeconds'
export type ScheduleInputCode = 'invalid_prompt' | 'invalid_rule' | 'invalid_time_zone' | 'not_future' | 'time_out_of_range' | 'frequency_too_high'
export interface ScheduleInputIssue {
  readonly namespace: typeof SCHEDULE_INPUT_NAMESPACE
  readonly path: readonly string[]
  readonly code: ScheduleInputCode
}

export function isScheduleInputCode(code: unknown): code is ScheduleInputCode {
  return code === 'invalid_prompt' || code === 'invalid_rule' || code === 'invalid_time_zone'
    || code === 'not_future' || code === 'time_out_of_range' || code === 'frequency_too_high'
}

export function scheduleInputPath(field: ScheduleInputField): readonly string[] {
  return field === 'title' ? ['title'] : ['rule', field]
}

/** Remote code、所属命名空间、字段路径与原生code都匹配才是本表单输入错误。 */
export function scheduleInputFailure(error: unknown): { field: ScheduleInputField; code: ScheduleInputCode } | undefined {
  if (!record(error) || error.code !== 'gateway/bad-request' || !record(error.details)
    || !Array.isArray(error.details.issues) || error.details.issues.length !== 1) return undefined
  const issue: unknown = error.details.issues[0]
  if (!record(issue) || issue.namespace !== SCHEDULE_INPUT_NAMESPACE || !Array.isArray(issue.path)) return undefined
  const field = issue.path.length === 1 && issue.path[0] === 'title' ? 'title'
    : issue.path.length === 2 && issue.path[0] === 'rule' ? issue.path[1] : undefined
  if (field === 'title' && issue.code === 'invalid_prompt') return { field, code: issue.code }
  if (field === 'timeZone' && issue.code === 'invalid_time_zone') return { field, code: issue.code }
  if (!['expression', 'date', 'time', 'weekdays', 'afterSeconds', 'everySeconds'].includes(field as string)) return undefined
  if (issue.code !== 'invalid_rule' && issue.code !== 'not_future' && issue.code !== 'time_out_of_range'
    && !(field === 'everySeconds' && issue.code === 'frequency_too_high')) return undefined
  return { field: field as ScheduleInputField, code: issue.code }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
