import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ScheduleRequest } from './contract.ts'
import type { ProjectScheduleService } from './service.ts'

const TIME_ZONE = { type: 'string', required: true, description: 'IANA time zone, for example Asia/Taipei or UTC. Use the actual requested zone.' } as const
const LOCAL_TIME = { type: 'string', required: true, description: 'Local HH:mm:ss time, with optional 1–3 fractional digits.' } as const
const RULE = { oneOf: [
  { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', required: true, const: 'at' },
    date: { type: 'string', required: true, description: 'Local YYYY-MM-DD date. The resulting instant must be in the future when a new rule is saved.' },
    time: LOCAL_TIME, timeZone: TIME_ZONE,
  } },
  { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', required: true, const: 'after' },
    afterSeconds: { type: 'integer', required: true, description: 'Positive safe integer seconds from saving the new rule; runs once.' }, timeZone: TIME_ZONE,
  } },
  { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', required: true, const: 'every' },
    everySeconds: { type: 'integer', required: true, description: 'Safe integer seconds between runs, at least 60; the first is one interval after saving the new rule.' }, timeZone: TIME_ZONE,
  } },
  { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', required: true, const: 'daily' }, time: LOCAL_TIME, timeZone: TIME_ZONE,
  } },
  { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', required: true, const: 'weekly' }, time: LOCAL_TIME, timeZone: TIME_ZONE,
    weekdays: { type: 'array', required: true, description: 'Non-empty selection: 1 is Monday and 7 is Sunday.', items: { type: 'integer', enum: [1, 2, 3, 4, 5, 6, 7] } },
  } },
  { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', required: true, const: 'cron' },
    expression: { type: 'string', required: true, description: 'Five-field cron expression: minute hour day-of-month month day-of-week.' }, timeZone: TIME_ZONE,
  } },
] } as const
const SAVE_FIELDS = {
  sessionId: { type: 'string', required: true, description: 'Exact targets[].id from project_schedule_list, not hostSessionId or the session title. Main can manage this Project’s work sessions; execution can manage only itself.' },
  title: { type: 'string', required: true, description: 'Non-blank name for this schedule.' },
  prompt: { type: 'string', required: true, description: 'Authorized task to send to the original target conversation at each run. Preserve the actual sources, scope and file locations.' },
  enabled: { type: 'boolean', required: true, description: 'The requested automatic enabled setting. true enables future scheduling when the Host is available; it does not run the task now or prove execution.' },
  rule: { ...RULE, required: true },
} as const
const SAVE_INPUT = { oneOf: [
  { type: 'object', additionalProperties: false, description: 'Create a new schedule. Omit id and expectedRevision.', properties: SAVE_FIELDS },
  { type: 'object', additionalProperties: false, description: 'Edit an existing schedule using the latest saved revision. Keep its original sessionId.', properties: {
    ...SAVE_FIELDS, id: { type: 'string', required: true, description: 'Existing schedule.id from list.' },
    expectedRevision: { type: 'integer', required: true, description: 'Latest schedule.revision from list; stale values return conflict.' },
  } },
] } as const

export interface ScheduleToolBindings {
  resolveCall(exec: ToolRunContext): Promise<{ service: ProjectScheduleService; request: ScheduleRequest }>
}
export function installScheduleTools(agent: Agent, bindings: ScheduleToolBindings): () => void {
  const disposers: Array<() => unknown> = []
  const output = () => ({ schema: { type: 'json' as const }, render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }] })
  const call = async (exec: ToolRunContext, action: (value: Awaited<ReturnType<ScheduleToolBindings['resolveCall']>>) => Promise<unknown>): Promise<JsonValue> => {
    exec.signal.throwIfAborted(); const value = await bindings.resolveCall(exec)
    const result = await action({ ...value, request: { ...value.request, signal: exec.signal } })
    return JSON.parse(JSON.stringify(result)) as JsonValue
  }
  try {
    disposers.push(agent.ctx.tools.register(defineTool({ name: 'project_schedule_list',
      description: 'Read this Project’s manageable targets, saved schedules and source-linked run status. For each saved schedule, time.nextAt is the actual next planned instant when time.kind is future; its rule.timeZone gives the zone. Read again after saving to report the current next time. native.timing gives UTC source and native-event times: automatic-slot plannedAt is the rule slot, triggeredAt is final-ready dispatch initiation; manual-request plannedAt equals actual accepted requestedAt, not the automatic slot. queuedAt is first insertion, claimedAt is actual claim, processingStartedAt is native turn start, not tool permission or business completion. Null fields listed in unknownFields are unknown; the other trigger mode’s triggeredAt/requestedAt is not applicable. link.observedAt retains its original observation meaning and never fills missing timing. Main sees this Project’s work sessions; execution sees only itself. Unknown execution remains unknown. Reading does not wake a model or arm a timer.',
      parameters: {}, output: output(), execute: (_args, exec) => call(exec, value => value.service.read(value.request)),
    })))
    const save = defineTool({ name: 'project_schedule_save_config',
      description: 'Create or edit an authorized schedule in this Project. Supply input_json as a structured object, not an encoded JSON string. Choose sessionId from project_schedule_list targets; identity and management scope are verified by core, never supplied as roles. To create, omit id and expectedRevision; to edit, use both from the latest list and retain the original target. On edit, the same normalized rule preserves the original anchorAt, including when title, prompt or enabled changes; reuse the listed rule to keep timing. A different normalized rule recalculates anchorAt from the new rule at save time. enabled changes the saved automatic setting, not a current turn or Host connection. After saving, read list for the current time.nextAt, rule.timeZone, automaticDispatch and automaticAvailability. Connection and availability are separate. Report actual configuration, pending-input effects and persistence separately; saving never means the task ran or finished.',
      parameters: { input_json: { ...SAVE_INPUT, required: true } }, output: output(),
      execute: (args, exec) => call(exec, value => value.service.save(value.request, args.input_json)),
    })
    const executeSave = save.execute
    // 旧会话可能继续生成原字符串参数；仅在此解码，仍经过当前参数和业务验证。
    save.execute = async (args, exec) => {
      exec.signal.throwIfAborted()
      if (args !== null && typeof args === 'object' && !Array.isArray(args)
        && 'input_json' in args && typeof args.input_json === 'string') {
        return executeSave({ ...args, input_json: JSON.parse(args.input_json) }, exec)
      }
      return executeSave(args, exec)
    }
    disposers.push(agent.ctx.tools.register(save))
    disposers.push(agent.ctx.tools.register(defineTool({ name: 'project_schedule_set_enabled',
      description: 'Change the saved enabled setting and reconcile this schedule’s not-started inputs. Report the actual configuration, pending changes and persistence result separately, including partial or unknown effects. This does not stop a current turn, connect the Host automatic runtime, or change model/tool permission; automatic admission follows the current connection and availability.',
      parameters: { schedule_id: { type: 'string', required: true }, enabled: { type: 'boolean', required: true }, expected_revision: { type: 'integer', required: true } }, output: output(),
      execute: (args, exec) => call(exec, value => value.service.setEnabled(value.request, args.schedule_id, args.enabled, args.expected_revision)),
    })))
    disposers.push(agent.ctx.tools.register(defineTool({ name: 'project_schedule_remove_config',
      description: 'Remove the saved schedule setting under the verified caller’s scope and cancel its not-started inputs. Preserve existing run associations, original chat and results. Report the actual pending and persistence effects; partial or unknown is not success. This does not stop a current turn or delete a session.',
      parameters: { schedule_id: { type: 'string', required: true }, expected_revision: { type: 'integer', required: true } }, output: output(),
      execute: (args, exec) => call(exec, value => value.service.remove(value.request, args.schedule_id, args.expected_revision)),
    })))
    disposers.push(agent.ctx.tools.register(defineTool({ name: 'project_schedule_run_now',
      description: 'Run an existing schedule now in its original target conversation, only for an actual user request within existing authorization. Use the returned revision from list; disabled or expired one-time schedules can be run explicitly without changing their automatic plan. A busy target queues the input normally. Report actual admission, run-link/native persistence and source; queued, started or ended never means the business task succeeded. Never retry automatically or invent a new request identity. Identity and management scope come from the real core caller, not model-supplied roles.',
      parameters: { schedule_id: { type: 'string', required: true }, expected_revision: { type: 'integer', required: true } }, output: output(),
      execute: (args, exec) => call(exec, value => value.service.runNow(value.request, {
        scheduleId: args.schedule_id, expectedRevision: args.expected_revision, requestId: 'schedule-tool:' + exec.callId,
      })),
    })))
  } catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error }
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
