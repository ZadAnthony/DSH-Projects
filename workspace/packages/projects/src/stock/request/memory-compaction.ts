/** A Memory-owned native compactor, without the work preset's tools or prompt. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { installBotCompaction } from './bot-compaction.ts'

const MEMORY_CHECKPOINT_RULE = 'For this Memory Bot checkpoint, preserve the exact active batchId, every request_id, and the complete original source/read locator objects needed to reread this frozen batch or finish project_memory_batch_result. Keep their Project, carrier, version, digest and range fields unchanged. A summary is not a new original source; do not replace exact read entries with a paraphrase.'

export function installMemoryCompaction(ctx: Context, agent: Agent): void {
  installBotCompaction(ctx, agent, { name: 'Memory', checkpoint: () => MEMORY_CHECKPOINT_RULE })
}
