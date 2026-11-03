import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { OverviewBlockInput, OverviewRequest } from './contract.ts'
import type { OverviewService } from './service.ts'
import { durableMutationDetails } from '../../metadata-files.ts'
import { projectOverviewModelResult } from './model-result.ts'

export interface OverviewToolBindings {
  /** 核心按真实调用方绑定 service.core；不得把模型自报 main 传给此函数。Store 在各调用之间共用。 */
  resolveCall(exec: ToolRunContext): Promise<{ readonly service: OverviewService; readonly request: OverviewRequest }>
}

function output() {
  return { schema: { type: 'json' as const }, render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
}

/** 维护权限只在 service 看板写入处检查，不成为其它会话工具的门槛。 */
export function installOverviewTools(agent: Agent, bindings: OverviewToolBindings, installationRole: 'main' | 'execution' = 'main'): () => void {
  const disposers: Array<() => unknown> = []
  const run = async (exec: ToolRunContext, operation: (call: Awaited<ReturnType<OverviewToolBindings['resolveCall']>>) => Promise<unknown>): Promise<JsonValue> => {
    exec.signal.throwIfAborted()
    try { return await operation(await bindings.resolveCall(exec)) as JsonValue }
    catch (error) {
      const detail = durableMutationDetails(error)
      if (detail !== undefined && detail.effect !== 'none') return { kind: 'unknown', ...detail }
      throw error
    }
  }
  try {
    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'project_overview_read',
      description: 'Read the current project-level goals, overall plan, progress, important issues and linked originals, including each block\'s saved summary when present and its complete content. This does not wake an Agent or model. Content update time, source read time and live runtime observations remain distinct. Missing sources are reported honestly; saved board content does not override newer user messages.',
      parameters: {}, output: output(), execute: (_args, exec) => run(exec, async call => projectOverviewModelResult(await call.service.read(call.request))),
    })))
    if (installationRole === 'main') {
      disposers.push(agent.ctx.tools.register(defineTool({
        name: 'project_overview_put_block',
        description: 'Only the verified project main session may add or replace one block of the current overall project content. Maintain goals/scope, overall planning, stage progress, important issues and relevant links while handling real conversations. Do not create per-task, recognition or requirements ledgers or copy Memory rules. Saving does not send messages or wake other sessions. block_json contains id, title, optional summary, content and sources. Write summary for people to scan, using the same information and sources as this block\'s complete content; include important pending decisions, constraints and unknowns rather than hiding them in expanded content. Keep the complete explanation in content. There is no fixed summary length or required business-section template. Omitting summary replaces the block without a summary; the system does not generate one automatically. content is {type:"text",text}, {type:"list",items:string[]} or {type:"table",columns:string[],rows:string[][]}. Sources include {kind:"native",source:the complete system-returned native-event source including project/session/host/header/event version/digest and optional body range}; retain all fields. Legacy message/tool source objects remain readable. Other sources are {kind:"library",location:{kind:"project-file",relativePath}} or {kind:"library",location:{kind:"reference",entryId}}, {kind:"session",id}, {kind:"memory",topicId}. Empty content/sources are allowed; missing source content is not a save prerequisite. Time and updating session are assigned by the service. Newer user statements take precedence over this overall expression. A result with kind:"unknown" means the board may already be updated but saving is unconfirmed; read the current board and do not automatically repeat the write.',
        parameters: { block_json: { type: 'string', required: true, description: 'Serialized OverviewBlockInput. id must start with an ASCII letter or digit and contain only ASCII letters, digits, underscores or hyphens, for example goals or current-plan; title is the human-readable label. summary, when supplied, is a literal string for human scanning alongside the complete content and sources. Unknown fields, non-string summaries and malformed table rows are rejected; strings are displayed as literal text.' } }, output: output(),
        execute: (args, exec) => run(exec, call => call.service.putBlock({ ...call.request, block: JSON.parse(args.block_json) as OverviewBlockInput })),
      })))
      disposers.push(agent.ctx.tools.register(defineTool({
        name: 'project_overview_remove_block',
        description: 'Only the verified main session may remove a block from the project-level board. This removes its displayed project summary, never referenced chat, files or Memory. Removing a goal description is not a user decision to cancel the goal. Saving does not send messages or wake sessions. A result with kind:"unknown" means the board may already be updated but saving is unconfirmed; read the current board and do not automatically repeat the write.',
        parameters: { block_id: { type: 'string', required: true } }, output: output(),
        execute: (args, exec) => run(exec, call => call.service.removeBlock({ ...call.request, blockId: args.block_id })),
      })))
      disposers.push(agent.ctx.tools.register(defineTool({
        name: 'project_overview_reorder',
        description: 'Only the verified main session may reorder the current overall project blocks. Include every current block id once. This changes document layout time; content blocks retain their original update times. It does not send messages or wake sessions. A result with kind:"unknown" means the board may already be updated but saving is unconfirmed; read the current board and do not automatically repeat the write.',
        parameters: { block_ids: { type: 'array', required: true, items: { type: 'string' } } }, output: output(),
        execute: (args, exec) => run(exec, call => call.service.reorderBlocks({ ...call.request, blockIds: args.block_ids })),
      })))
    }
  } catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error }
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
