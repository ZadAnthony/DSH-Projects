import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { installProjectHistoryTools } from '../src/project-tools.ts'
import * as catalog from '../src/prompts/catalog.generated.ts'
import { PROJECT_MEMORY_BOT_PROMPT } from '../src/memory-bot-runtime.ts'
import { MAIN_SESSION_MANAGER_PROMPT } from '../src/continuity/prompt.ts'

const root = process.env.DSH_AGENT_PROMPTS_CANONICAL_ROOT
  ?? new URL('../prompts/', import.meta.url).pathname

test('every compiled Agent prompt is exactly its canonical product body, with specialized consumers using that same body', async () => {
  const cases = [
    ['common.md', catalog.PROJECT_COMMON_PROMPT],
    ['main.md', catalog.PROJECT_MAIN_PROMPT],
    ['execution.md', catalog.PROJECT_EXECUTION_PROMPT],
    ['memory-bot.md', catalog.PROJECT_MEMORY_BOT_PROMPT],
    ['session-manager.md', catalog.MAIN_SESSION_MANAGER_PROMPT],
    ['compaction.md', catalog.PROJECT_COMPACTION_INSTRUCTION],
  ] as const
  for (const [file, body] of cases) {
    assert.ok(body.length > 0, file)
    assert.equal(body, (await readFile(resolve(root, file), 'utf8')).replace(/\r\n/g, '\n').trimEnd(), file)
  }
  assert.equal(PROJECT_MEMORY_BOT_PROMPT, catalog.PROJECT_MEMORY_BOT_PROMPT)
  assert.equal(MAIN_SESSION_MANAGER_PROMPT, catalog.MAIN_SESSION_MANAGER_PROMPT)
  const ctx = new Context()
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
  const dispose = installProjectHistoryTools({ id: 'prompt-schema-probe', ctx } as unknown as Agent, {
    history: async () => ({}), readHistoryContent: async () => { throw new Error('Schema assertion must not read history') },
  })
  try {
    const schema = ctx.tools.schemas().find(tool => tool.name === 'project_history')!.parameters as any
    assert.match(schema.properties.session_ids.description, /logical Project session IDs.*native source\.sessionId.*multiple carriers.*authorized scope/)
    assert.match(schema.properties.host_session_ids.description, /native carrier IDs.*native source\.hostSessionId.*not logical session IDs.*never grant extra access/)
    assert.match(schema.properties.keyword.description, /literal case-insensitive substring, not semantic search.*recorded-time\/source order, not relevance/)
  } finally { dispose(); await ctx.fiber.dispose() }
})
