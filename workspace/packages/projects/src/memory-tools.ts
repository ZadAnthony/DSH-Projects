import { isProxy } from 'node:util/types'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ProjectMemoryService, MemoryAccessRequest } from './memory-service.ts'
import type { MemoryScope, MemorySource, SaveMemoryInput } from './memory-types.ts'
import { LEGACY_MEMORY_SCOPE_NOTICE, memoryMutationFailure } from './memory-types.ts'
import { MEMORY_CURRENT_AUTHORITY } from './memory-authority.ts'
import { memorySourceForModel } from './memory-source-model.ts'
import { projectMemoryRepresentation } from './memory-result-representation.ts'
import type { MemoryRequestPort, MemoryRequestInput } from './memory-request.ts'
import { legacyNativeMessageSourceParameter, nativeEventSourceParameter, nativeProjectSourceParameter } from './native-source.ts'
import { communicationSavedPartSourceParameter } from './communication/source-schema.ts'
import { ToolReadPager } from './tool-read-pages.ts'
import { retainCompletedToolResult } from './tool-result-retention.ts'
import { PROJECT_HISTORY_CONTEXT_MAX, PROJECT_HISTORY_RECORD_VERSIONS } from './project-history.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ParameterPropertySpec } from '@deepseek-ai/dsh-tools'

/** 工具身份在每次调用时由核心核实，模型不能传另一项目或 settings 身份。 */
export interface MemoryBotToolPort {
  service: ProjectMemoryService
  resolveRequest(exec: ToolRunContext): Promise<MemoryAccessRequest>
}

export interface MemoryToolPort extends MemoryBotToolPort {
  requests: MemoryRequestPort
}

export interface MemorySaveToolArgs {
  request_ids?: string[]
  memory_id?: string
  expected_revision?: number
  expected_generation?: string
  topic?: string
  title: string
  summary: string
  body: string
  type: 'rule' | 'preference' | 'background' | 'fact' | 'experience'
  nature: 'confirmed' | 'verified' | 'unverified'
  scope_kind: 'project' | 'session' | 'file' | 'topic'
  scope_targets?: string[]
  sources: MemorySource[]
  reconfirmed_by?: MemorySource
}

/** 工作会话只读当前记忆，并转交用户明确请求；不安装保存或撤回能力。 */
export function installMemoryTools(agent: Agent, port: MemoryToolPort): () => void {
  return installMemoryToolSet(agent, { kind: 'work', port })
}

/** 仅供公共层核实的后台 Bot；实际写入时 service 再使用 core 的真实角色。 */
export function installMemoryBotTools(agent: Agent, port: MemoryBotToolPort): () => void {
  return installMemoryToolSet(agent, { kind: 'bot', port })
}

function installMemoryToolSet(agent: Agent, installation: { kind: 'work'; port: MemoryToolPort } | { kind: 'bot'; port: MemoryBotToolPort }): () => void {
  const port = installation.port
  const pager = new ToolReadPager(agent)
  const readTool = (tool: ToolDefinition) => installation.kind === 'bot' ? pager.wrap(tool)
    : tool.name === 'project_memory_read' ? pager.wrap(tool, { textField: 'body' }) : tool
  const disposers: Array<() => unknown> = [() => pager.clear()]
  const output = () => ({
    schema: { type: 'json' as const },
    render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
  })
  const request = async (exec: ToolRunContext): Promise<MemoryAccessRequest> => {
    exec.signal.throwIfAborted()
    const value = await port.resolveRequest(exec)
    exec.signal.throwIfAborted()
    if (value.actor.kind !== 'session') throw new Error('记忆工具必须使用当前项目会话身份。')
    return { ...value, signal: exec.signal }
  }
  try {
    disposers.push(agent.ctx.tools.register(readTool(defineTool({
      name: 'project_memory_list',
      description: 'Read this Project’s shared-memory directory of summaries: continuing conventions/preferences, Project background, verified findings, important choices with reasons/conditions, and event recollections. Follow an event summary into its memory body, exact chat sources and current artifacts as needed. All bodies are explicit reads. Withdrawn entries are excluded; legacy work scope is historical. Report read/sync and scope limitations.',
      parameters: {}, output: output(),
      execute: async (_args, exec) => {
        const access = await request(exec)
        const value = await port.service.list(access)
        // Both roles share the same lossless model view before long-result paging.
        return json(projectMemoryRepresentation(access.projectId, 'project_memory_list', value, false))
      },
    }))))
    disposers.push(agent.ctx.tools.register(readTool(defineTool({
      name: 'project_memory_read',
      description: 'Read one shared-memory body with title, scope, nature and sources. Legacy work scope is historical and excluded from current use; do not broaden it. Legacy business-record locators are historical only, not new user decisions; original content requires a real native locator. An absent/withdrawn body cannot be recovered from its old summary. Do not read another Project.',
      parameters: { memory_id: { type: 'string', required: true, description: 'Memory id from the current Project index.' } },
      output: output(),
      execute: async (args, exec) => {
        const memory = await port.service.read(await request(exec), args.memory_id)
        return json(memory === undefined ? { unavailable: true, guidance: MEMORY_CURRENT_AUTHORITY } : { ...memory, guidance: MEMORY_CURRENT_AUTHORITY,
          ...(memory.scope.kind === 'work' ? { limitation: LEGACY_MEMORY_SCOPE_NOTICE } : {}),
          ...([...memory.sources, ...memory.originSources].some(source => source.kind === 'record')
            ? { historical_source_notice: '旧业务来源仅作历史定位，不是新用户决定依据；查看原话须有真实原生消息或工具定位。' } : {}),
        })
      },
    }))))
    if (installation.kind === 'work') {
      const requests = installation.port.requests
      disposers.push(agent.ctx.tools.register(defineTool({
        name: 'project_memory_request',
        description: 'Forward an explicit user request to remember, correct or withdraw shared memory. Supply the real original USER message locator and necessary context locators, not a rewritten quote or candidate memory. The service rereads the source and verifies its Project/user identity. Accepted means the request was retained; it does not mean memory was saved, corrected or withdrawn. Ongoing work and communication do not wait for this request.',
        parameters: {
          operation: { type: 'string', required: true, enum: ['remember', 'correct', 'withdraw'], description: 'Action explicitly requested in the original user message.' },
          source: { oneOf: [nativeEventSourceParameter(), legacyNativeMessageSourceParameter()], required: true, description: 'Exact original human-user event source returned by the system. A legacy message locator is accepted only if the reader can uniquely fix its event version. Include necessary referenced original material in context_sources.' },
          memory_id: { type: 'string', description: 'Optional current memory id to correct or withdraw.' },
          context_sources: { type: 'array', items: sourceParameter(), description: 'Necessary original messages, tool observations or file locators; no copied chat body.' },
        }, output: output(),
        execute: async (args, exec) => json(await port.service.requestChange(await request(exec), {
          operation: args.operation, source: args.source,
          ...(args.memory_id === undefined ? {} : { memoryId: args.memory_id }),
          ...(args.context_sources === undefined ? {} : { contextSources: args.context_sources }),
        } as MemoryRequestInput, requests)),
      })))
    } else {
      disposers.push(agent.ctx.tools.register(readTool(defineTool({
        name: 'project_memory_source',
        description: 'Read an exact Project event, saved communication part or current file source before maintaining memory. ' + PROJECT_HISTORY_RECORD_VERSIONS + ' Native items retain speaker, producer, time, event version, exact target and bounded nearby context. Use the common history read_content capability with returned stable body source to continue long content; a temporary cursor is not a durable memory source. Legacy message/tool locators cannot select a historical version unless uniquely resolved. Saved communication parts keep their holder/version identity; current files are current, not historical snapshots. Partial/limitations never mean complete evidence. isUserOrigin reports only original human identity, not semantic adoption or current validity.',
        parameters: { source: { ...sourceParameter(), required: true, description: 'Real original Project source locator.' },
          before: { type: 'integer', enum: Array.from({ length: PROJECT_HISTORY_CONTEXT_MAX + 1 }, (_, index) => index), description: `0–${PROJECT_HISTORY_CONTEXT_MAX} visible entries before a native target; default 1. Not used for files.` },
          after: { type: 'integer', enum: Array.from({ length: PROJECT_HISTORY_CONTEXT_MAX + 1 }, (_, index) => index), description: `0–${PROJECT_HISTORY_CONTEXT_MAX} visible entries after a native target; default 1. Not used for files.` },
        },
        output: output(),
        execute: async (args, exec) => json(memorySourceForModel(await port.service.readSource(await request(exec), args.source as MemorySource,
          { ...(args.before === undefined ? {} : { before: args.before }), ...(args.after === undefined ? {} : { after: args.after }) }))),
      }))))
      disposers.push(agent.ctx.tools.register(retainCompletedToolResult(defineTool({
        name: 'project_memory_save',
        description: 'Memory Bot only: create or correct one theme and synchronize its index. Five kinds of useful content are continuing user conventions/preferences, Project-specific background, verified findings, important choices with sourced reasons/conditions, and event recollections. An event recollection may use experience: record what happened, when recorded, key outcome/current state and exact sources/current artifacts for later follow-up; rewrite its overview as new facts arrive, without inventing a separate event ledger or missing reasons. Confirmed covers only what the user expressed/adopted in context; verified findings retain evidence/conditions. User-entered content is free-form and must not be deleted for falling outside automatic categories. Keep summary, body, scope and sources consistent. Read current body/revision before correcting; on conflict reread current user edits, never omit revision or change id to force old content. No change needs no save call and must leave body/index/time unchanged; batch settlement belongs to the runtime. Report actual saved/conflict/failed/partial/unknown; partial is not complete success and unknown must be checked before repeating. Restoring withdrawn content requires a NEW explicit human-user event; another page/range of the same event is not new confirmation.',
        parameters: {
          request_ids: requestIdsParameter(),
          memory_id: { type: 'string', description: 'Existing id to correct; omit for a new theme.' },
          expected_revision: { type: 'integer', description: 'Current revision read before correcting an existing theme. If the read also returns generation, pass it unchanged as expected_generation; an earlier incarnation cannot edit a restored theme.' },
          expected_generation: { type: 'string', description: 'Opaque generation from the current body read, when present. Preserve it with expected_revision for an edit; omit both when explicitly restoring an absent theme.' },
          topic: { type: 'string', description: 'Optional explicit filename theme for a new file. Omit for a system-assigned UUID filename independent of the display title. Explicit themes retain filename validation and never overwrite an existing file; existing memories keep their path when edited.' },
          title: { type: 'string', required: true, description: 'Human-readable theme title.' },
          summary: { type: 'string', required: true, description: 'Short current summary for the index; maintain it with the body.' },
          body: { type: 'string', required: true, description: 'Reusable theme content supported by its actual sources and adoption scope; keep verified findings distinct from user conventions.' },
          type: { type: 'string', required: true, enum: ['rule', 'preference', 'background', 'fact', 'experience'], description: 'Organization label. experience includes important choice reasons/conditions and event recollections with follow-up sources; no mandatory event object.' },
          nature: { type: 'string', required: true, enum: ['confirmed', 'verified'], description: 'Confirmed for the parts the user actually expressed or adopted; verified for findings with evidence and conditions. A user-message locator alone does not confirm the theme.' },
          scope_kind: { type: 'string', required: true, enum: ['project', 'session', 'file', 'topic'], description: 'Actual current scope from the source; never broaden a local preference or retired work scope automatically.' },
          scope_targets: { type: 'array', items: { type: 'string' }, description: 'Session ids, canonical file paths or exact topics for the chosen scope; omit for project.' },
          sources: { type: 'array', required: true, items: sourceParameter(), description: 'Real original source locators in this Project; no fabricated source ids.' },
          reconfirmed_by: { ...sourceParameter(), description: 'Only for explicit restoration: a NEW user decision locator also included in sources.' },
        },
        output: output(),
        execute: async (args, exec) => memoryWriteOutput(async () => port.service.save(await request(exec), memoryToolInput(args as MemorySaveToolArgs))),
      }))))
      disposers.push(agent.ctx.tools.register(retainCompletedToolResult(defineTool({
        name: 'project_memory_withdraw',
        description: 'Withdraw one shared memory at the user’s request. It removes the reusable body and summary, retaining only minimal id/source withdrawal markers to prevent automatic revival. Original chat and original source files are not deleted. Report partial removal honestly; this does not send messages.',
        parameters: {
          request_ids: requestIdsParameter(),
          memory_id: { type: 'string', required: true, description: 'Existing memory to withdraw.' },
          expected_revision: { type: 'integer', required: true, description: 'Current revision from the body read.' },
          expected_generation: { type: 'string', description: 'Opaque generation from the current body read, when present; required with expected_revision for a restored theme.' },
        }, output: output(),
        execute: async (args, exec) => memoryWriteOutput(async () => port.service.withdraw(await request(exec), args.memory_id, args.expected_revision, args.expected_generation)),
      }))))
    }
  } catch (error) {
    for (const dispose of disposers.toReversed()) dispose()
    throw error
  }
  return () => { for (const dispose of disposers.toReversed()) dispose() }
}

export function memoryToolInput(args: MemorySaveToolArgs): SaveMemoryInput {
  if (!['project', 'session', 'file', 'topic'].includes(args.scope_kind)) throw new Error('该旧范围已退出当前适用，不能作为新保存范围。')
  const targets = args.scope_targets ?? []
  const scope: MemoryScope = args.scope_kind === 'project' ? { kind: 'project' }
    : args.scope_kind === 'session' ? { kind: 'session', sessionIds: targets }
    : args.scope_kind === 'file' ? { kind: 'file', paths: targets }
    : { kind: 'topic', topics: targets }
  return {
    title: args.title, summary: args.summary, body: args.body, type: args.type, nature: args.nature,
    scope, sources: args.sources,
    ...(args.memory_id === undefined ? {} : { id: args.memory_id }),
    ...(args.expected_revision === undefined ? {} : { expectedRevision: args.expected_revision }),
    ...(args.expected_generation === undefined ? {} : { expectedGeneration: args.expected_generation }),
    ...(args.topic === undefined ? {} : { topic: args.topic }),
    ...(args.reconfirmed_by === undefined ? {} : { reconfirmedBy: args.reconfirmed_by }),
  }
}

function sourceParameter(): ParameterPropertySpec {
  return { oneOf: [nativeProjectSourceParameter(), communicationSavedPartSourceParameter(), {
    type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'file', required: true },
      path: { type: 'string', required: true }, locator: { type: 'string' } },
  }] }
}

function requestIdsParameter() {
  return { type: 'array' as const, items: { type: 'string' as const },
    description: 'Explicit request_id values from this batch that this write actually serves. Omit for ordinary maintenance without an explicit request. This is your semantic association; the runtime binds it to the actual call and write result. Do not supply memory ids or call ids.' }
}

/** Plain owner DTOs need detached containers, not a second serialized copy of every body. */
function json(value: unknown): JsonValue {
  const unsupported = Symbol('non-plain JSON DTO'), ancestors = new Set<object>()
  const copy = (input: unknown): JsonValue | undefined | typeof unsupported => {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input
    if (typeof input === 'number') return Number.isFinite(input) ? (input === 0 ? 0 : input) : null
    if (input === undefined || typeof input === 'symbol') return undefined
    // Preserve the old JSON semantics for callable/toJSON, boxed, Proxy and other exotic inputs.
    if (typeof input !== 'object' || isProxy(input)) return unsupported
    const array = Array.isArray(input), prototype = Object.getPrototypeOf(input)
    if ((array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      || 'toJSON' in input || ancestors.has(input)) return unsupported
    ancestors.add(input)
    try {
      if (array) {
        const result: JsonValue[] = []
        for (let index = 0; index < input.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
          if (descriptor === undefined && index in input || descriptor !== undefined && !('value' in descriptor)) return unsupported
          const child = copy(descriptor?.value)
          if (child === unsupported) return unsupported
          result.push(child ?? null)
        }
        return result
      }
      const result: { [key: string]: JsonValue } = {}
      for (const key of Object.keys(input)) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!
        if (!('value' in descriptor)) return unsupported
        const child = copy(descriptor.value)
        if (child === unsupported) return unsupported
        if (child !== undefined) Object.defineProperty(result, key, { value: child, enumerable: true, writable: true, configurable: true })
      }
      return result
    } finally { ancestors.delete(input) }
  }
  const detached = copy(value)
  return detached === unsupported || detached === undefined ? JSON.parse(JSON.stringify(value)) as JsonValue : detached
}

/** Mutations with a visible but unconfirmed commit remain explicit tool outcomes. */
async function memoryWriteOutput(action: () => Promise<unknown>): Promise<JsonValue> {
  try { return json(await action()) }
  catch (error) {
    const failure = memoryMutationFailure(error)
    if (failure === undefined) throw error
    return json({ kind: 'unknown', ...failure, guidance: '内容可能已更新；请核对当前主题与索引，不要把本次当作未保存或自动重做。' })
  }
}
