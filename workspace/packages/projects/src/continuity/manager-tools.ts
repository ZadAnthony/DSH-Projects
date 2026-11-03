/** Read-only manager tool installation; actual history and current values retain their owners. */
import { ToolReadPager } from '../tool-read-pages.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, ToolArgsError, validateJsonSchemaValue, type ObjectJsonSchema, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'
import { installProjectHistoryTools, type HistoryArgs } from '../project-tools.ts'
import { finalizeProjectHistoryContentPage, type ProjectHistoryContentPage, type ProjectHistoryContentRequest } from '../project-history.ts'
import type { ProjectHistorySearchRequest, ProjectHistorySearchResult, ProjectHistoryReadRequest, ProjectHistoryReadResult } from '../project-history-types.ts'
import type { CommunicationContentBudget } from '../communication/content-types.ts'
import type { OverviewContext } from '../features/overview/contract.ts'
import type { MemoryAccessRequest } from '../memory-service.ts'
import type { MemorySnapshot, ProjectMemory } from '../memory-types.ts'
import { MEMORY_CURRENT_AUTHORITY } from '../memory-authority.ts'
import { LEGACY_MEMORY_SCOPE_NOTICE } from '../memory-types.ts'
import type { EvaluationEnvelope } from './types.ts'
import type { SourceRef } from '../records-types.ts'
import { assertManagerJsonBudget, MANAGER_INPUT_POINTS } from './manager-input.ts'
import { historyResultForModel } from '../model-visible-content.ts'
import { projectMemoryRepresentation } from '../memory-result-representation.ts'

/** One set constrains both the final schema and every execution, including late registrations. */
export const MAIN_SESSION_MANAGER_TOOLS: ReadonlySet<string> = new Set(['project_history', 'project_overview_read', 'project_memory_list', 'project_memory_read'])

/** A stable-main reader rejects foreign session, host, holder, source and cursor scopes itself. */
export interface MainManagerHistoryReader {
  search(request: ProjectHistorySearchRequest, signal?: AbortSignal,
    captureSamePage?: (read: (signal?: AbortSignal) => Promise<ProjectHistorySearchResult>) => void): Promise<ProjectHistorySearchResult>
  read(request: ProjectHistoryReadRequest, signal?: AbortSignal): Promise<ProjectHistoryReadResult>
  readContent(request: ProjectHistoryContentRequest, budget: CommunicationContentBudget, signal?: AbortSignal): Promise<ProjectHistoryContentPage>
}

/** Current observations carry real timestamps and unknown capacity explicitly. */
export interface MainManagerObservations {
  readonly observedAt: string
  readonly state: 'running' | 'idle' | 'unknown'
  readonly contextUsage: JsonValue | null
  readonly limitations: readonly string[]
  readonly sources: readonly SourceRef[]
}

/** Read-only closures call the existing overview and memory owners with the actual Bot actor. */
export interface MainManagerContextPorts {
  overview(projectId: string, signal?: AbortSignal): Promise<OverviewContext>
  memoryList(request: MemoryAccessRequest): Promise<MemorySnapshot>
  memoryRead(request: MemoryAccessRequest, id: string): Promise<ProjectMemory | undefined>
  observations(envelope: EvaluationEnvelope, signal?: AbortSignal): Promise<MainManagerObservations>
}

/** Exact tool invocation scope is established by the manager and core live-Agent checks. */
export interface MainManagerToolScope {
  readonly projectId: string
  readonly hostSessionId: string
  readonly history: MainManagerHistoryReader
  /** Evaluation-local bounded transport; entries never count as delivered body receipts. */
  retain(value: unknown): unknown
}

/** Install only read actions and preserve the existing body retention/continuation protocol.
 * @param agent - The hidden manager's actual Agent.
 * @param authorize - Rechecks the real active evaluation and core invocation.
 * @param context - Existing read-only current-value services.
 * @returns Disposer for every registration.
 */
export function installMainManagerTools(agent: Agent, authorize: (exec: ToolRunContext) => Promise<MainManagerToolScope>, context: MainManagerContextPorts): () => void {
  const pager = new ToolReadPager(agent)
  const disposers: Array<() => unknown> = [() => pager.clear()]
  const output = { schema: { type: 'json' as const }, render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
  const bounded = (tool: ToolDefinition): ToolDefinition => ({ ...tool, execute: async (args, exec) => {
    const value = await tool.execute(args, exec), scope = await authorize(exec)
    return json(scope.retain(value))
  }, finalizeContent: (exec, result) => result.isError ? undefined : tool.finalizeContent?.(exec, result) })
  try {
    disposers.push(installProjectHistoryTools(agent, {
      history: async (exec, args) => {
        const scope = await authorize(exec)
        if (args.action === 'read') return historyPreparation(await scope.history.read({ source: historySource(args), before: args.before, after: args.after }, exec.signal))
        if (args.action !== 'search') throw new ToolArgsError(['历史动作不匹配。'])
        return historyPreparation(await scope.history.search(historySearchRequest(args), exec.signal))
      },
      prepareHistoryRead: async (exec, args) => {
        const scope = await authorize(exec), projectId = scope.projectId, hostSessionId = scope.hostSessionId
        let samePage: ((signal?: AbortSignal) => Promise<ProjectHistorySearchResult>) | undefined
        const value = historyPreparation(await scope.history.search(historySearchRequest(args), exec.signal, read => { samePage = read }))
        const read = samePage
        return { value, ...(read === undefined ? {} : { reread: async (next: ToolRunContext) => {
          const fresh = await authorize(next)
          if (fresh.projectId !== projectId || fresh.hostSessionId !== hostSessionId) throw new ToolArgsError(['History result belongs to another Manager scope.'])
          return historyPreparation(await read(next.signal))
        } }) }
      },
      readHistoryContent: async (exec, request) => {
        const scope = await authorize(exec)
        const budget: CommunicationContentBudget = agent.ctx.get('toolResultRetention')?.budget(exec) ?? { estimate: content => estimateContent(content) }
        const page = await scope.history.readContent(request, budget, exec.signal)
        const value = scope.retain(page)
        return { page: value as ProjectHistoryContentPage, finalize: retained => typeof value === 'object' && value !== null && 'format' in value && value.format === page.format ? finalizeProjectHistoryContentPage(value as ProjectHistoryContentPage, retained, budget) : [...retained] }
      },
    }, async (value, exec) => json((await authorize(exec)).retain(value))))
    disposers.push(agent.ctx.tools.register(bounded(strict(pager.wrap(defineTool({ name: 'project_overview_read',
      description: '只读本项目当前看板正文及区块来源、更新时间和读取时间；不展开引用原文、不读取执行会话、不唤醒或修改任何对象。看板不是实时事实或新授权，引用入口不是已读原文。读取失败保持真实失败。',
      parameters: {}, output, execute: async (_args, exec) => { const scope = await authorize(exec); return json(await context.overview(scope.projectId, exec.signal)) },
    }))))))
    disposers.push(agent.ctx.tools.register(bounded(strict(pager.wrap(defineTool({ name: 'project_memory_list',
      description: '只读本项目当前完整共享记忆索引及读取/同步限制。全部正文按需使用project_memory_read；索引、摘要和来源入口不等于已读原文，不读取执行会话历史，也不保存或整理记忆。',
      parameters: {}, output, execute: async (_args, exec) => { const scope = await authorize(exec)
        return json(projectMemoryRepresentation(scope.projectId, 'project_memory_list', await context.memoryList(request(scope, exec)), false)) },
    }))))))
    disposers.push(agent.ctx.tools.register(bounded(strict(pager.wrap(defineTool({ name: 'project_memory_read',
      description: '使用当前本项目索引中的memory_id读取该主题当前正文、适用范围、版本和来源。不存在或撤回如实返回；历史work范围不扩大为当前约定。引用来源只是入口，核原话须用本主会话project_history，不能沿引用扩权读取执行会话。此工具没有写操作。',
      parameters: { memory_id: { type: 'string', required: true } }, output, execute: async (args, exec) => {
        const scope = await authorize(exec), memory = await context.memoryRead(request(scope, exec), args.memory_id)
        return json(memory === undefined ? { unavailable: true, guidance: MEMORY_CURRENT_AUTHORITY } : { ...memory, guidance: MEMORY_CURRENT_AUTHORITY,
          ...(memory.scope.kind === 'work' ? { limitation: LEGACY_MEMORY_SCOPE_NOTICE } : {}) })
      },
    }))))))
  } catch (error) { for (const dispose of disposers.toReversed()) dispose(); throw error }
  return () => { for (const dispose of disposers.toReversed()) dispose() }
}

function historySearchRequest(args: HistoryArgs): ProjectHistorySearchRequest {
  return { sessionIds: args.session_ids, hostSessionIds: args.host_session_ids, producer: args.producer,
    recordKinds: args.record_kinds, timeField: args.time_field, fromTime: timestamp(args.from_time), toTime: timestamp(args.to_time),
    speaker: args.speaker, keyword: args.keyword, limit: args.limit, cursor: args.cursor }
}
function historySource(args: HistoryArgs): ProjectHistoryReadRequest['source'] {
  if (args.source !== undefined) return args.source
  if (!args.source_host_session_id || (args.source_message_id === undefined) === (args.source_tool_call_id === undefined)) throw new ToolArgsError(['需要精确source或host加唯一message/tool定位。'])
  return args.source_message_id !== undefined ? { kind: 'message', hostSessionId: args.source_host_session_id, messageId: args.source_message_id }
    : { kind: 'tool', hostSessionId: args.source_host_session_id, toolCallId: args.source_tool_call_id! }
}
function timestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new ToolArgsError(['时间必须是带时区的ISO时间。'])
  return Date.parse(value)
}
function request(scope: MainManagerToolScope, exec: ToolRunContext): MemoryAccessRequest { return { projectId: scope.projectId, actor: { kind: 'session', hostSessionId: scope.hostSessionId }, signal: exec.signal } }
function json(value: unknown): JsonValue {
  // Raw background owners reach this before ToolReadPager clones/canonicalizes,
  // makes its second owner read, or stores the full snapshot points array.
  // This finite preparation check grants no body receipt or cumulative read credit.
  assertManagerJsonBudget(value, MANAGER_INPUT_POINTS)
  return JSON.parse(JSON.stringify(value)) as JsonValue
}
/** The owner DTO is a bounded preparation value, never a delivered page receipt. */
function historyPreparation(value: unknown): JsonValue {
  const prepared = historyResultForModel(value)
  assertManagerJsonBudget(prepared, 24_576)
  return json(prepared)
}
function strict(tool: ToolDefinition): ToolDefinition {
  const parameters: ObjectJsonSchema = { ...tool.parameters, type: 'object', additionalProperties: false }
  return { ...tool, parameters: { ...parameters }, execute: (args, exec) => {
    const violations = validateJsonSchemaValue(parameters, args, '')
    if (violations.length > 0) throw new ToolArgsError(violations)
    return tool.execute(args, exec)
  } }
}
