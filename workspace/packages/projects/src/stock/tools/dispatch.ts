import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallBlock } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ResolvedToolSet } from '@deepseek-ai/dsh-tools'
import type { ProjectDriverPersistence } from '../request/dispatch.ts'
import { PROJECT_STREAM_TOOL_BATCH, type ProjectStreamingToolBatchInput } from './protocol.ts'

/** The selected scoped executor streams each durable outcome to the Projects driver. */
export async function executeToolCalls(
  ctx: Context, turn: number, step: number, toolCalls: ToolCallBlock[], signal: AbortSignal,
  acceptContext: (context: UserMessage) => void, maxParallelToolCalls = 4,
  persistence: ProjectDriverPersistence, toolSet?: ResolvedToolSet,
): Promise<{ concluded: boolean }> {
  const agent = ctx.agents.requireInitiator()
  const input: ProjectStreamingToolBatchInput = {
    calls: toolCalls, signal, agent, log: { turn, step }, maxParallelToolCalls,
    ...toolSet === undefined ? {} : { toolSet },
    [PROJECT_STREAM_TOOL_BATCH]: { persistence, acceptContext },
  }
  // ToolsService is the only scoped selector. Its delegate transparently carries
  // this private request; an ordinary executor does not acquire this protocol.
  const result: unknown = await ctx.tools.execute(input)
  if (typeof result !== 'object' || result === null || !('kind' in result)
    || result.kind !== 'projects-streamed' || !('concluded' in result) || typeof result.concluded !== 'boolean') {
    throw new Error('The selected executor did not honor the Projects streaming batch protocol')
  }
  return { concluded: result.concluded }
}
