import { z } from 'zod'
import { decodeNativeProjectSource } from '../../native-source.ts'

const text = z.string().min(1)
const timeZone = text
export const ruleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('at'), date: text, time: text, timeZone }).strict(),
  z.object({ kind: z.literal('after'), afterSeconds: z.number().int().positive(), timeZone }).strict(),
  z.object({ kind: z.literal('every'), everySeconds: z.number().int().positive(), timeZone }).strict(),
  z.object({ kind: z.literal('daily'), time: text, timeZone }).strict(),
  z.object({ kind: z.literal('weekly'), time: text, timeZone, weekdays: z.array(z.number().int().min(1).max(7)).min(1) }).strict(),
  z.object({ kind: z.literal('cron'), expression: text, timeZone }).strict(),
])
const nativeSourceSchema = z.unknown().transform((value, ctx) => {
  try { return decodeNativeProjectSource(value) }
  catch (error) { ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) }); return z.NEVER }
})
export const sourceSchema = z.union([nativeSourceSchema,
  z.object({ kind: z.literal('settings'), changeId: text }).strict(),
  z.object({ kind: z.literal('record'), recordKind: text, recordId: text, revision: z.number().int().positive() }).strict(),
])
export const utcTimeSchema = z.iso.datetime().refine(value => !value.startsWith('0000-'))
const date = utcTimeSchema
export const managerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), sources: z.array(sourceSchema).min(1) }).strict(),
  z.object({ kind: z.literal('session'), sessionId: text, sources: z.array(sourceSchema).min(1) }).strict(),
])
const legacyScheduleSchema = z.object({
  id: text, projectId: text, sessionId: text, title: text, prompt: text, rule: ruleSchema,
  anchorAt: date, enabled: z.boolean(), revision: z.number().int().positive(), createdAt: date, updatedAt: date,
  enabledSince: date.optional(),
  createdBy: managerSchema, updatedBy: managerSchema,
}).strict()
export const scheduleSchema = legacyScheduleSchema.extend({
  manualCancelRevision: z.number().int().nonnegative().optional(),
}).strict().superRefine((schedule, ctx) => {
  if ((schedule.manualCancelRevision ?? 0) > schedule.revision) {
    ctx.addIssue({ code: 'custom', message: '手动取消修订不能晚于当前定义。' })
  }
})
const runRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), hostSessionId: text, messageId: text }).strict(),
  z.object({ kind: z.literal('turn'), hostSessionId: text, turn: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('tool'), hostSessionId: text, toolCallId: text }).strict(),
  z.object({ kind: z.literal('result'), recordId: text }).strict(),
])
const legacyRunLinkSchema = z.object({
  id: text, scheduleId: text, projectId: text, sessionId: text, plannedAt: date, observedAt: date,
  trigger: z.enum(['automatic', 'manual']), refs: z.array(runRef),
}).strict()
export const runLinkSchema = legacyRunLinkSchema.extend({ observation: z.object({
  occurrenceId: text, ruleIdentity: text, definitionRevision: z.number().int().positive(),
  admission: z.enum(['not-enqueued', 'enqueued', 'unknown']),
  outcome: z.enum(['missed-before-boundary', 'not-started', 'admission-unknown', 'enqueued', 'suppressed', 'unknown']),
  reason: text, boundaryAt: date.optional(), admittedAt: date.optional(), provenance: z.literal('controlled-fixture').optional(),
}).strict().optional() }).strict()
export const legacyStateSchema = z.object({ version: z.literal(1), projectId: text,
  schedules: z.array(legacyScheduleSchema), runs: z.array(legacyRunLinkSchema),
}).strict()
const previousStateSchema = z.object({ version: z.literal(2), projectId: text,
  schedules: z.array(legacyScheduleSchema), runs: z.array(runLinkSchema),
}).strict()
const currentStateSchema = z.object({ version: z.literal(3), projectId: text,
  schedules: z.array(scheduleSchema), runs: z.array(runLinkSchema),
}).strict()
export const stateSchema = z.union([legacyStateSchema, previousStateSchema, currentStateSchema]).superRefine((state, ctx) => {
  if (state.schedules.some(item => item.projectId !== state.projectId) || state.runs.some(item => item.projectId !== state.projectId)
    || new Set(state.schedules.map(item => item.id)).size !== state.schedules.length
    || new Set(state.runs.map(item => item.id)).size !== state.runs.length) {
    ctx.addIssue({ code: 'custom', message: '定时记录归属或标识不一致。' })
  }
}).transform(state => ({ ...state, version: 3 as const, schedules: state.schedules.map(item => scheduleSchema.parse(item)),
  runs: state.runs.map(run => runLinkSchema.parse(run)) }))
export const runNowInputSchema = z.object({
  scheduleId: text, expectedRevision: z.number().int().positive(), requestId: text,
}).strict()
export const saveInputSchema = z.object({ id: text.optional(), expectedRevision: z.number().int().positive().optional(),
  sessionId: text, title: text, prompt: text, rule: ruleSchema, enabled: z.boolean(),
}).strict()
export type ScheduleState = z.infer<typeof stateSchema>
