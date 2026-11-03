/** 工作模型的有限项目信息维护和只读用量入口；不暴露通用设置或生命周期写权限。 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, ToolArgsError, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ProjectSessionRole, ProjectUpdateResult } from './records-types.ts'
import type { ProjectUsageQuery, ProjectUsageResult } from './features/usage/contract.ts'

interface WorkToolScope { readonly project: { readonly id: string }; readonly role: ProjectSessionRole }
export interface ProjectWorkToolPorts {
  /** 真实caller核对和项目已接纳操作边界均由runtime提供，不接受模型传项目身份。 */
  run<T>(exec: ToolRunContext, toolName: string, action: (scope: WorkToolScope) => Promise<T>): Promise<T>
  updateName(projectId: string, name: string, expectedRevision: number): Promise<ProjectUpdateResult>
  queryUsage(query: ProjectUsageQuery): Promise<ProjectUsageResult>
}
interface RenameArgs { readonly name: string; readonly expected_revision: number }
interface UsageArgs { readonly session_id?: string; readonly model?: ProjectUsageQuery['model']; readonly from?: number; readonly to?: number }

const output = { schema: { type: 'json' as const }, render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }] }

export function installProjectWorkTools(agent: Agent, ports: ProjectWorkToolPorts, installationRole: 'main' | 'execution'): () => void {
  const disposers: Array<() => unknown> = []
  try {
    if (installationRole === 'main') disposers.push(agent.ctx.tools.register(strict(defineTool({
      name: 'project_rename',
      description: 'Main Project session only: update this Project name on an explicit user request. Read project_read for the current Project revision before forming the change. Only the name changes; this does not change goals, workspace, permissions, archive/delete state or start extra work. Returns the actual saved Project, or conflict with the current Project; on conflict reread and reconsider instead of forcing an old change.',
      parameters: {
        name: { type: 'string', required: true, description: 'Requested Project name; nonempty after trimming.' },
        expected_revision: { type: 'integer', required: true, description: 'Current project.revision from project_read; a stale revision returns conflict without saving.' },
      }, output,
      execute: async (input, exec) => {
        const args = input as RenameArgs
        if (!args.name.trim() || !Number.isSafeInteger(args.expected_revision) || args.expected_revision < 1) throw new ToolArgsError(['A nonempty name and positive safe expected_revision are required.'])
        return ports.run(exec, 'project_rename', async scope => {
          if (scope.role !== 'main') throw new ToolArgsError(['Only the current Project main session may rename its Project.'])
          exec.signal.throwIfAborted()
          return json(await ports.updateName(scope.project.id, args.name, args.expected_revision))
        })
      },
    }))))
    disposers.push(agent.ctx.tools.register(strict(defineTool({
      name: 'project_usage',
      description: 'Read actual reported usage for this Project without waking another Agent or calling a model. Main and execution work sessions only. Optional filters use the existing usage owner; omitted filters cover the Project. Preserve coverage, missing/unknown metrics, source/model attribution and observation time: reported zero differs from unavailable, partial totals are not a complete bill, and cost remains unknown. This does not change configuration, budgets or permissions.',
      parameters: {
        session_id: { type: 'string', description: 'Optional exact logical Project session id within this Project, not a native carrier id.' },
        model: { description: 'Optional actual provider/model route, or unattributed for usage that cannot be assigned to one route.', oneOf: [
          { type: 'object', additionalProperties: false, properties: {
            provider: { type: 'string', required: true }, model: { type: 'string', required: true },
          } },
          { type: 'string', enum: ['unattributed'] },
        ] },
        from: { type: 'integer', description: 'Inclusive Unix time in milliseconds, using completed-turn end time or auxiliary-request usage report time. Unknown end times remain unknown.' },
        to: { type: 'integer', description: 'Exclusive Unix time in milliseconds, using the same owner time basis as from; the range is [from, to).' },
      }, output,
      execute: async (input, exec) => {
        const args = input as UsageArgs
        return ports.run(exec, 'project_usage', async scope => {
          if (scope.role !== 'main' && scope.role !== 'execution') throw new ToolArgsError(['Only Project work sessions may query Project usage.'])
          exec.signal.throwIfAborted()
          return json(await ports.queryUsage({ projectId: scope.project.id,
            ...(args.session_id === undefined ? {} : { sessionId: args.session_id }),
            ...(args.model === undefined ? {} : { model: args.model }),
            ...(args.from === undefined ? {} : { from: args.from }), ...(args.to === undefined ? {} : { to: args.to }),
          }))
        })
      },
    }))))
  } catch (error) { for (const dispose of disposers.toReversed()) dispose(); throw error }
  return () => { for (const dispose of disposers.toReversed()) dispose() }
}

function json(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue }
function strict(tool: ToolDefinition): ToolDefinition {
  const parameters: ObjectJsonSchema = { ...tool.parameters, type: 'object', additionalProperties: false }
  return { ...tool, parameters: parameters as unknown as Record<string, unknown>, execute: (args, exec) => {
    const violations = validateJsonSchemaValue(parameters, args, '')
    if (violations.length > 0) throw new ToolArgsError(violations)
    return tool.execute(args, exec)
  } }
}
