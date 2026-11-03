import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ProjectSettingsService } from './features/settings/service.ts'
import { settingsMutationFailure } from './features/settings/types.ts'
import { retainCompletedToolResult } from './tool-result-retention.ts'

/** 身份由每次调用的 core.forTool 提供，目标仅能落在这个项目的 settings owner。 */
export interface InstructionToolRequest {
  readonly projectId: string
  readonly sessionId: string
  readonly hostSessionId?: string
  readonly role: 'main' | 'execution' | 'memory'
}

export interface InstructionToolPort {
  readonly service: Pick<ProjectSettingsService,
    'readProjectInstructions' | 'saveProjectInstructions' | 'readSessionInstructions' | 'saveSessionInstructions'>
  resolveRequest(exec: ToolRunContext): Promise<InstructionToolRequest>
}

type InstructionTarget = { kind: 'project' } | { kind: 'session'; session_id: string }
type InstructionSave = InstructionTarget & { instructions: string; expected_revision: number }

const projectTarget = { type: 'object', additionalProperties: false,
  properties: { kind: { type: 'string', required: true, const: 'project' } } } as const
const sessionTarget = { type: 'object', additionalProperties: false, properties: {
  kind: { type: 'string', required: true, const: 'session' },
  session_id: { type: 'string', required: true, description: 'Exact Project session id, not a title or native host session id. Use project_read to discover it when needed.' },
} } as const
const saveProperties = {
  instructions: { type: 'string', required: true, description: 'Complete next user supplement based on the current target body: Project requirements or a session assignment, within built-in responsibilities, boundaries and work standards. Preserve unrelated paragraphs and independent local agreements; empty or whitespace-only text clears only this supplement.' },
  expected_revision: { type: 'integer', required: true, description: 'Revision of this exact target read before forming this change. On conflict reconsider the returned current body; do not force an old replacement.' },
} as const

function output() {
  return { schema: { type: 'json' as const }, render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
}

export function installInstructionTools(agent: Agent, port: InstructionToolPort): () => void {
  const disposers: Array<() => unknown> = []
  const request = async (exec: ToolRunContext) => {
    exec.signal.throwIfAborted()
    const current = await port.resolveRequest(exec)
    exec.signal.throwIfAborted()
    if ((current.role !== 'main' && current.role !== 'execution') || !current.projectId || !current.sessionId) {
      throw new Error('指令工具只供当前项目真实主会话或执行会话使用。')
    }
    return { projectId: current.projectId, signal: exec.signal,
      ...(current.hostSessionId === undefined ? {} : { metadataActor: { sessionId: current.sessionId, hostSessionId: current.hostSessionId } }) }
  }
  try {
    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'project_instructions_read',
      description: 'Read complete current user-supplement instructions and revision for explicit targets in this Project. Project instructions add Project requirements for its main/execution sessions; session instructions add the named session’s assignment. Built-in responsibilities, boundaries and work standards are provided separately and are not editable through this tool. This is the same saved value as Settings, not shared Memory or historical chat. Target/read failures are returned individually; failure is not empty text. No Agent is woken and no message is sent.',
      parameters: { targets: { type: 'array', required: true, items: { oneOf: [projectTarget, sessionTarget] },
        description: 'One or more explicit objects to read; do not infer a session from its title.' } },
      output: output(),
      execute: async (args, exec) => {
        const current = await request(exec)
        const results = []
        for (const target of args.targets as InstructionTarget[]) {
          try {
            exec.signal.throwIfAborted()
            const value = target.kind === 'project'
              ? await port.service.readProjectInstructions(current)
              : await port.service.readSessionInstructions({ ...current, sessionId: target.session_id })
            results.push({ target, kind: 'read', value })
          } catch (error) { results.push({ target, ...failureResult(error) }) }
        }
        return json({ projectId: current.projectId, results })
      },
    })))
    disposers.push(agent.ctx.tools.register(retainCompletedToolResult(defineTool({
      name: 'project_instructions_save',
      description: 'Save, replace or clear explicit Project/session user supplements through the same Settings owner. They add Project requirements or concrete session assignments; they do not override built-in responsibilities, boundaries or work standards. Clearing removes only the saved supplement, while built-in duties remain. Save only this Project or explicitly intended sessions. Base each complete replacement on that target’s current body and revision; on conflict reconsider the returned current body, never force an old replacement. Results are per target, not an atomic batch: saved/value, conflict/current, unavailable/message, failed/message or unknown/code/stage/effect/message. Unknown means the content may already be updated: read the current target before deciding whether to save again. Report the actual objects, scope and partial results; no save means no claim of lasting change. Saving never wakes/broadcasts/restarts/cancels work, changes tools/models/permissions, or proves adoption. Current saved instructions enter the next independent model-request preparation; in-flight requests remain as prepared.',
      parameters: { targets: { type: 'array', required: true, items: { oneOf: [
        { ...projectTarget, properties: { ...projectTarget.properties, ...saveProperties } },
        { ...sessionTarget, properties: { ...sessionTarget.properties, ...saveProperties } },
      ] }, description: 'Explicit target replacements. Each carries its own current revision and full next text. Empty text clears only that target.' } },
      output: output(),
      execute: async (args, exec) => {
        const current = await request(exec)
        const results = []
        for (const change of args.targets as InstructionSave[]) {
          const target: InstructionTarget = change.kind === 'project' ? { kind: 'project' } : { kind: 'session', session_id: change.session_id }
          try {
            exec.signal.throwIfAborted()
            const result = target.kind === 'project'
              ? await port.service.saveProjectInstructions(current, change.instructions, change.expected_revision)
              : await port.service.saveSessionInstructions({ ...current, sessionId: target.session_id }, change.instructions, change.expected_revision)
            results.push({ target, ...result })
          } catch (error) { results.push({ target, ...failureResult(error) }) }
        }
        return json({ projectId: current.projectId, results })
      },
    }))))
  } catch (error) { for (const dispose of disposers.toReversed()) dispose(); throw error }
  return () => { for (const dispose of disposers.toReversed()) dispose() }
}

function failureResult(error: unknown): { kind: 'unknown'; code: string; stage: string; effect: string; message: string } | { kind: 'failed'; message: string } {
  const failure = settingsMutationFailure(error)
  return failure?.code === 'projects/metadata-write-unconfirmed' && failure.effect !== 'none'
    ? { kind: 'unknown', ...failure } : { kind: 'failed', message: errorMessage(error) }
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function json(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue }
