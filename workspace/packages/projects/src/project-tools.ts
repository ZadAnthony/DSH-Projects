/** 直接协作与原聊天查询；实际身份由当前原生 Agent 确定。 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import { defineTool, ToolArgsError, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import type { ObjectJsonSchema, ToolDefinition, ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-tools/types';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types';
import { renderProjectHistoryContentPage, PROJECT_HISTORY_DEFAULT_LIMIT, PROJECT_HISTORY_LIMIT_MAX, PROJECT_HISTORY_CONTEXT_MAX, PROJECT_HISTORY_RECORD_VERSIONS } from './project-history.ts';
import { NATIVE_CONTENT_DEFAULT_LIMIT, NATIVE_CONTENT_LIMIT_MAX } from './native-content.ts';
import { COMMUNICATION_CONTENT_LIMIT_MAX } from './communication/content.ts';
import { ToolReadPager, type PreparedToolRead } from './tool-read-pages.ts';
import { historyResultForModel } from './model-visible-content.ts';
import type { ProjectHistoryContentPage, ProjectHistoryContentRequest } from './project-history.ts';
import { communicationSourceParameter, communicationRecordSchema } from './communication/source-schema.ts';
import type { ProjectHistorySpeaker } from './project-history.ts';
import { exact, object, operationReference, validateSendArgs } from './communication/contract.ts';
import type { CommunicationRecordLocator, CommunicationSendArgs, CommunicationSource } from './communication/types.ts';
import type { ToolInvocationSource } from './communication/invocation-source.ts';
import { projectInvocationPort } from './stock/tools/index.ts';
export interface CreateSessionArgs {
  readonly title: string;
  readonly instructions?: string;
}
export interface ReadProjectArgs {
  readonly source_host_session_id?: string;
  readonly source_message_id?: string;
  readonly source_tool_call_id?: string;
  readonly operation_ref?: string;
  readonly delivery_id?: string;
}
export interface SendMessageArgs extends CommunicationSendArgs {
}
export interface HistoryArgs extends ReadProjectArgs {
  readonly action: 'search' | 'read' | 'read_content';
  readonly source?: CommunicationSource;
  readonly record?: CommunicationRecordLocator;
  readonly snapshot_version?: 1;
  readonly part_id?: string;
  readonly session_ids?: string[];
  readonly host_session_ids?: string[];
  readonly producer?: string;
  readonly record_kinds?: string[];
  readonly time_field?: 'recorded';
  readonly from_time?: string;
  readonly to_time?: string;
  readonly speaker?: ProjectHistorySpeaker;
  readonly keyword?: string;
  readonly limit?: number;
  readonly cursor?: string;
  /** Temporary serialized-result continuation; never a query or body cursor. */
  readonly result_cursor?: string;
  readonly before?: number;
  readonly after?: number;
}
export interface PreparedProjectHistoryContent {
  readonly page: ProjectHistoryContentPage;
  /** 闭包使用本次实际读取的同一预算及可信spill owner，不重新读设置。 */
  finalize(retained: readonly ContentBlock[]): ContentBlock[];
}
export interface ProjectToolRuntime {
  readProject(exec: ToolRunContext, args: ReadProjectArgs): Promise<JsonValue>;
  createProjectSession(exec: ToolRunContext, args: CreateSessionArgs): Promise<JsonValue>;
  sendProjectMessage(exec: ToolRunContext, args: SendMessageArgs): Promise<JsonValue>;
  history(exec: ToolRunContext, args: HistoryArgs): Promise<JsonValue>;
  prepareHistoryRead?(exec: ToolRunContext, args: HistoryArgs): Promise<PreparedToolRead>;
  readHistoryContent(exec: ToolRunContext, args: ProjectHistoryContentRequest): Promise<PreparedProjectHistoryContent>;
}
function jsonOutput() {
  return {
    schema: { type: 'json' as const }, render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }]
  };
}
function sourceParameters() {
  return {
    source_host_session_id: { type: 'string' as const, description: 'Exact native session id within this Project.' },
    source_message_id: {
      type: 'string' as const, description: 'Exact native message id; use this or source_tool_call_id.'
    },
    source_tool_call_id: {
      type: 'string' as const, description: 'Exact native tool call id; use this or source_message_id.'
    },
  };
}
export function installProjectTools(agent: Agent, runtime: ProjectToolRuntime, installationRole: 'main' | 'execution' = 'main'): () => void {
  const disposers: Array<() => unknown> = [];
  const communicationInvocations = new WeakMap<object, ToolInvocationSource>();
  try {
    disposers.push(agent.ctx.tools.register(strictTool(defineTool({
      name: 'project_read',
      description: 'Without a selector, read current Project membership, the main-maintained overall board and the legacy deliveries directory; an empty legacy directory does not mean a v2 communication was not delivered. For an exact v2 receipt, use either the real deliveryId from an incoming project-delivery source as delivery_id, or the original project_send_message operation_ref. Choose one receipt selector and do not combine it with a native source selector. The query returns actual found/absent/unknown facts and never resends. Transport receipt does not prove processing, reply or business completion. Returned work-session records include link and Markdown mention for the exact Project and stable logical session ID. Copy mention when naming that session in a reply; it opens the current session, not a historical message, and is not a delivery receipt. Specific decisions, feedback and progress remain in chat; query project_history when needed. Optional exact native source can be read without prior registration. Summaries do not override newer original user messages.',
      parameters: { ...sourceParameters(), operation_ref: { type: 'string', description: 'Original operation_ref returned by this caller\'s project_send_message; queries that exact operation without resending. Use instead of delivery_id or a native source selector.' }, delivery_id: { type: 'string', description: 'Actual deliveryId from an incoming project-delivery source visible to this caller. Queries the exact v2 receipt; use instead of operation_ref or a native source selector.' } }, output: jsonOutput(), execute: async (args, exec) => {
        const value = await runtime.readProject(exec, args);
        if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.hasOwn(value, 'source')) return value;
        const source = historyResultForModel(value.source);
        return source === value.source ? value : { ...value, source } as JsonValue;
      },
    }))));
    if (installationRole === 'main') disposers.push(agent.ctx.tools.register(strictTool(defineTool({
      name: 'project_create_session',
      description: 'Main-session only: create one empty execution session with its title and optional complete saved user-supplement instructions for its specific assignment. Built-in execution responsibilities, boundaries and work standards are provided separately. Omitted instructions and an explicit empty string both leave this supplement empty. Creation never sends work or runs a model. Use the actual returned session id with project_send_message. The returned target includes link and escaped Markdown mention for that exact logical session; copy mention when naming it in a reply. The reference is not evidence of delivery or work completion. Reuse an existing suitable session directly without changing its instructions. A created session remains real if later work fails.',
      parameters: { title: { type: 'string', required: true }, instructions: { type: 'string', description: 'Optional complete user supplement for this session’s specific assignment. It does not replace built-in duties or grant permissions.' } },
      output: jsonOutput(), execute: (args, exec) => runtime.createProjectSession(exec, args),
    }))));
    disposers.push(agent.ctx.tools.register(strictTool(defineTool({
      name: 'project_send_message',
      description: 'Send to one actual Project session or reply to one communication actually received here. Exactly one target_session_id or reply_to_delivery_id is required, and at least one nonblank Agent message or selected source is required. message is your Agent-authored text; user_message_refs forwards complete verified human-user messages or saved user parts, while context_refs selects related visible messages, tools or saved parts. Agent-authored message and forwarded human-user originals are normally supplied in full; related context is supplied as exact saved-part reading entries, with its body not provided until requested. Actual capacity pressure may also reduce message and user originals to reading entries. When asked to pass on original words, select their exact system-returned source objects, including long originals: the system saves them fully and supplies full content or a stable reading entry according to actual input capacity. A file path or rewritten summary does not replace those originals. Preserve each list order; no adjacent messages are added. Any selected source unavailable or incomplete makes the whole communication fail before insertion. Replies go to that incoming communication sender; omit target_session_id for a reply. An archived execution session can receive a saved communication without waking a model. Viewing or restoring it alone does not replay saved work. Creation is separate. Delivery, persistence, wakeup, model understanding, actual reply and work completion are different facts. Reply only as needed. For an unknown/cancelled outcome query project_read with the original operation_ref rather than resending. Old intent/original_source or self-reported sender/author fields are rejected.',
      parameters: {
        ...(installationRole === 'main' ? { delivery_mode: { type: 'string' as const, enum: ['queued', 'direct'], description: 'Choose for this message to an execution session: queued (default) waits for the next turn; direct uses native steer at the next consumable step, after the current model request and tools, including pending questions, finish. Direct does not Stop, inject into an in-flight request, bypass archive, or prove adoption. A Stop race can admit it to next-turn instead; inspect the actual admission/partial receipt. You choose the mode; no wording automatically selects it.' } } : {}),
        target_session_id: { type: 'string', description: 'Actual recipient session ID for a new message. Omit this field when replying.' },
        reply_to_delivery_id: { type: 'string', description: 'Actual delivery ID received in this session. Use this selector alone to reply to its sender.' },
        message: { type: 'string' },
        user_message_refs: { type: 'array', items: communicationSourceParameter(false) },
        context_refs: { type: 'array', items: communicationSourceParameter(true) },
      },
      output: jsonOutput(), execute: (args, exec) => {
        const source = projectInvocationPort.get(exec);
        if (source !== undefined) communicationInvocations.set(exec, source);
        return runtime.sendProjectMessage(exec, validateSendArgs(args));
      },
      finalizeContent: (exec, result) => {
        const source = communicationInvocations.get(exec) ?? projectInvocationPort.get(exec);
        if (!result.isError || source === undefined)
          return undefined;
        return [
          ...result.content, {
            type: 'text', text: JSON.stringify({
              operation_ref: operationReference(source), notice: 'Cancellation or tool failure does not prove no delivery occurred. Query this original operation with project_read; do not resend to infer its result.'
            })
          }
        ];
      },
    }))));
    disposers.push(installProjectHistoryTools(agent, runtime));
  }
  catch (error) {
    for (const dispose of disposers.toReversed())
      dispose();
    throw error;
  }
  return () => { for (const dispose of disposers.toReversed())
    dispose(); };
}
/** The exact read-only History capability is shared by work and the isolated Memory Bot. */
export function installProjectHistoryTools(agent: Agent, runtime: Pick<ProjectToolRuntime, 'history' | 'readHistoryContent' | 'prepareHistoryRead'>,
  prepareResult?: (value: unknown, exec: ToolRunContext) => ReturnType<ToolDefinition['execute']>): () => void {
  const historyContent = new WeakMap<Readonly<ToolExecution>, PreparedProjectHistoryContent>();
  const pager = new ToolReadPager(agent);
  const history = defineTool({
      name: 'project_history',
      description: 'Read original visible Project chat without waking an Agent/model. ' + PROJECT_HISTORY_RECORD_VERSIONS + ' search keeps its own fixed message-list query cursor and filters. read accepts either one exact source object returned by the system (including a saved communication-part), or the named native source_host_session_id plus exactly one message/tool id; do not mix these locators. before/after only select neighbouring visible native event entries, and a saved part remains exact. read_content reads native visible/tool bodies using the returned stable source (with body stream/version), or a saved communication body using record, delivery_id, snapshot_version=1 and part_id ($agent for Agent text). Native and saved communication body pages default to 4096 Unicode code points and accept limit up to 16384. Continue only with that body cursor; stable source can reopen an expired page. Body ranges/cursors are separate from message-list pagination. Returned source/range/complete/next_cursor are actual facts; an entry or partial page does not mean the full content was read. If output retention changes a body page, preserve the real spill path and re-read same_page_cursor rather than skipping forward. Native body pages may return verified read-only attachment paths for descriptors in the selected range; paths are access entries, and file/image bodies require the matching file/image read tools. Unavailable attachments are reported explicitly. Human-user originals and Agent deliveries keep their different identity; hidden reasoning/internal instructions are excluded.',
      parameters: {
        action: { type: 'string', required: true, enum: ['search', 'read', 'read_content'] },
        session_ids: { type: 'array', items: { type: 'string' }, description: "search: logical Project session IDs from the session directory or native source.sessionId. May span multiple carriers; omitted means the caller's authorized scope." },
        host_session_ids: { type: 'array', items: { type: 'string' }, description: "search: native carrier IDs from the carrier directory or native source.hostSessionId, not logical session IDs. Use with session_ids to narrow scope; IDs never grant extra access." },
        producer: { type: 'string', description: 'search only: exact sourceKind, such as user, model, project-delivery or tool. Producer identity does not indicate semantic adoption.' },
        record_kinds: { type: 'array', items: { type: 'string' }, description: 'search only: exact item.kind event names, such as user/message, assistant/message, agent/inbox/spliced or projects/assistant-progress. One event must satisfy all filters; matching stages of the same host/message form one candidate. Its versionsCursor opens all saved stages and marks matchesSearch.' },
        time_field: { type: 'string', enum: ['recorded'], description: 'recorded means the native event append/record time, not the original producer occurrence time. Unknown original occurrence times are not inferred. from_time and to_time filter this same recorded time.' },
        from_time: { type: 'string', description: 'Inclusive ISO timestamp with timezone, filtering native event append/record time (recorded), not an unknown producer occurrence time.' },
        to_time: { type: 'string', description: 'Inclusive ISO timestamp with timezone, filtering the same native event append/record time (recorded) as from_time.' },
        speaker: { type: 'string', enum: ['user', 'assistant', 'project-delivery', 'system', 'tool', 'unknown'], description: 'search only: original visible speaker. User inbox and consumed versions can both match user; this filter does not count distinct human inputs.' },
        keyword: { type: 'string', description: "search: literal case-insensitive substring, not semantic search. Results use recorded-time/source order, not relevance; omit to browse with other filters." },
        limit: { type: 'integer', description: `search: 1–${PROJECT_HISTORY_LIMIT_MAX} message candidates (or event versions when continuing versionsCursor), default ${PROJECT_HISTORY_DEFAULT_LIMIT}; read_content: 1–${NATIVE_CONTENT_LIMIT_MAX} Unicode code points, default ${NATIVE_CONTENT_DEFAULT_LIMIT}. Not accepted by read.` },
        cursor: { type: 'string', description: 'search: a fixed message-list nextCursor, or messageGroup.versionsCursor to open that message\'s frozen stage/version list and then its own nextCursor. read_content: cursor of the selected single body. These views and body cursors are distinct; never use a serialized-result continuation here.' },
        ...sourceParameters(),
        before: { type: 'integer', enum: Array.from({ length: PROJECT_HISTORY_CONTEXT_MAX + 1 }, (_, index) => index), description: `read only: 0–${PROJECT_HISTORY_CONTEXT_MAX} visible native entries before the target; default 1. Saved communication parts require 0 or omission.` },
        after: { type: 'integer', enum: Array.from({ length: PROJECT_HISTORY_CONTEXT_MAX + 1 }, (_, index) => index), description: `read only: 0–${PROJECT_HISTORY_CONTEXT_MAX} visible native entries after the target; default 1. Saved communication parts require 0 or omission.` },
        source: communicationSourceParameter(true),
        record: communicationRecordSchema(),
        delivery_id: { type: 'string' }, snapshot_version: { type: 'integer', const: 1 }, part_id: { type: 'string' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => {
        if (typeof value === 'object' && value !== null && !Array.isArray(value) && (value.format === 'projects-communication-content/v1' || value.format === 'projects-native-content/v1')) {
          return renderProjectHistoryContentPage(value as unknown as ProjectHistoryContentPage);
        }
        return [{ type: 'text', text: JSON.stringify(value) }];
      } },
      execute: async (input, exec) => {
        const args = validateHistoryArgs(input as unknown as HistoryArgs);
        if (args.action !== 'read_content') return historyResultForModel(await runtime.history(exec, args)) as JsonValue;
        const request: ProjectHistoryContentRequest = args.source?.kind === 'native-event'
          ? { source: args.source, ...(args.cursor === undefined ? {} : { cursor: args.cursor }), ...(args.limit === undefined ? {} : { limit: args.limit }) }
          : { record: args.record!, delivery_id: args.delivery_id!, snapshot_version: 1, part_id: args.part_id!,
            ...(args.cursor === undefined ? {} : { cursor: args.cursor }), ...(args.limit === undefined ? {} : { limit: args.limit }) };
        const prepared = await runtime.readHistoryContent(exec, request);
        historyContent.set(exec, prepared);
        return prepared.page as unknown as JsonValue;
      },
      finalizeContent: (exec, result) => {
        const prepared = historyContent.get(exec);
        historyContent.delete(exec);
        if (prepared === undefined) return undefined;
        try {
          return prepared.finalize(result.content);
        } catch (error) {
          // finalizer必须total；保留原错误及真实spill内容，明确本页未完整读出，绝不推进cursor。
          return [...result.content, { type: 'text', text: JSON.stringify({
            communication_content_failure: {
              code: 'COMMUNICATION_CONTENT_CAPACITY_UNAVAILABLE', inline_complete: false,
              ...(prepared.page.format === 'projects-communication-content/v1' ? { delivery_id: prepared.page.delivery_id, part_id: prepared.page.part_id } : { source: prepared.page.source }),
              same_page_cursor: prepared.page.same_page_cursor,
              reason: error instanceof Error ? error.message : String(error),
            },
          }) }];
        }
      },
  });
  const bounded = pager.wrap(history, { cursorField: 'result_cursor', prepare: async (args, exec) => {
    const input = validateHistoryArgs(args as unknown as HistoryArgs);
    if (input.action !== 'search' || runtime.prepareHistoryRead === undefined) return { value: await history.execute(args, exec) as JsonValue };
    const { value, reread } = await runtime.prepareHistoryRead(exec, input);
    return { value: historyResultForModel(value) as JsonValue,
      ...(reread === undefined ? {} : { reread: async (next: ToolRunContext) => historyResultForModel(await reread(next)) as JsonValue }) };
  } });
  try {
    const dispose = agent.ctx.tools.register(strictTool({
      ...bounded,
      execute: async (args, exec) => {
        if ((args as unknown as HistoryArgs).action === 'read_content') return history.execute(args, exec);
        const value = await bounded.execute(args, exec);
        return prepareResult === undefined ? value : prepareResult(value, exec);
      },
      finalizeContent: (exec, result) => historyContent.has(exec)
        ? history.finalizeContent!(exec, result) : bounded.finalizeContent!(exec, result),
    }));
    return () => { pager.clear(); dispose(); };
  } catch (error) { pager.clear(); throw error; }
}

/** root和nested字段均由同一实际Schema校验，旧字段不能被静默丢弃后继续执行。 */
function strictTool(tool: ToolDefinition): ToolDefinition {
  const parameters: ObjectJsonSchema = { ...tool.parameters, type: 'object', additionalProperties: false };
  return {
    ...tool, parameters: parameters as unknown as Record<string, unknown>, execute: (args, exec) => {
      const violations = validateJsonSchemaValue(parameters, args, '');
      if (violations.length > 0) throw new ToolArgsError(violations);
      return tool.execute(args, exec);
    },
  };
}

/** 每种历史动作仅接受自己的定位/游标，避免正文游标被当成列表续页。 */
function validateHistoryArgs(args: HistoryArgs): HistoryArgs {
  const raw = object(args, 'history arguments');
  if (args.action === 'search') {
    validateHistoryLimit(args.limit, PROJECT_HISTORY_LIMIT_MAX, 'search limit');
    exact(raw, ['action', 'session_ids', 'host_session_ids', 'producer', 'record_kinds', 'time_field', 'from_time', 'to_time', 'speaker', 'keyword', 'limit', 'cursor']);
    return args;
  }
  if (args.action === 'read_content') {
    validateHistoryLimit(args.limit, args.source === undefined ? COMMUNICATION_CONTENT_LIMIT_MAX : NATIVE_CONTENT_LIMIT_MAX, 'read_content limit');
    if (args.source !== undefined) {
      exact(raw, ['action', 'source', 'cursor', 'limit']);
      if (args.source.kind !== 'native-event') throw new ToolArgsError(['native read_content requires a stable native-event source']);
      return args;
    }
    exact(raw, ['action', 'record', 'delivery_id', 'snapshot_version', 'part_id', 'cursor', 'limit']);
    if (args.record === undefined || args.snapshot_version !== 1 || !args.delivery_id?.trim() || !args.part_id?.trim()) {
      throw new ToolArgsError(['read_content requires record, delivery_id, snapshot_version=1 and part_id']);
    }
    return args;
  }
  exact(raw, ['action', 'source', 'source_host_session_id', 'source_message_id', 'source_tool_call_id', 'before', 'after']);
  const named = args.source_host_session_id !== undefined || args.source_message_id !== undefined || args.source_tool_call_id !== undefined;
  if (args.source !== undefined) {
    if (named) throw new ToolArgsError(['source cannot be combined with named native locators']);
    if (args.source.kind === 'communication-part' && ((args.before ?? 0) !== 0 || (args.after ?? 0) !== 0)) {
      throw new ToolArgsError(['a saved communication-part is exact and has no adjacent-message window']);
    }
  } else if (!args.source_host_session_id?.trim() || (args.source_message_id === undefined) === (args.source_tool_call_id === undefined)) {
    throw new ToolArgsError(['read requires one source object or host session plus exactly one native message/tool id']);
  }
  return args;
}


/** Stock Schema supports integer/enum, not minimum/maximum; enforce the documented action range here. */
function validateHistoryLimit(value: number | undefined, maximum: number, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > maximum))
    throw new ToolArgsError([`${name} must be an integer between 1 and ${maximum}`]);
}
