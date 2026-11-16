/*!
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Adapted from DeepSeek DSH 38a6a5c965aa99ab525161efb7cc5cf1fe62fced
packages/core/tool-executor-ptc/src/index.ts
*/
/** Scoped rc.3 executors with Projects' streaming durability boundary. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { renderToolsSdk, renderToolsSdkPy, CodeResetFailedError, Config as PtcConfig } from '@deepseek-ai/dsh-tool-executor-ptc'
import { createRunCodeTool, requirePtcRuntime } from '@deepseek-ai/dsh-tool-executor-ptc/src/ptc.ts'
import { PtcCalls } from '@deepseek-ai/dsh-tool-executor-ptc/src/ptc-calls.ts'
import { RUN_CODE_NAME, ToolNotFoundError, projectToolSchema, type ToolBatchInput, type ToolBatchResult, type ToolExecutor, type ToolDefinition, type ToolPromptSection } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline, executeToolBatch, toolErrorMessage, type ScheduledToolPreparation } from '@deepseek-ai/dsh-tools/pipeline'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { bindProjectToolToken, ProjectToolRuntime } from './runtime.ts'
import { executeProjectToolBatch } from './batch.ts'
import { PROJECT_STREAM_TOOL_BATCH, isProjectStreamingToolBatch, type ProjectStreamingToolBatchInput, type ProjectStreamingToolBatchResult } from './protocol.ts'

class ProjectExecutionPipeline extends ToolExecutionPipeline {
  override async prepare(input: ToolExecutionInput): Promise<ScheduledToolPreparation> {
    const prepared = await super.prepare(input)
    // A cancelled/invalid call may bypass pre-execute; it still has a real
    // just-appended root/start fact and receives an authoritative final record.
    bindProjectToolToken(prepared.exec)
    return prepared
  }
}

export class ProjectNativeToolExecutor extends NativeToolExecutor {
  private readonly projectPipeline: ProjectExecutionPipeline
  constructor(ctx: Context, private readonly projectMaxParallel: () => number = () => 10) {
    super(ctx, projectMaxParallel)
    this.projectPipeline = new ProjectExecutionPipeline(ctx)
  }
  override execute(input: ProjectStreamingToolBatchInput): Promise<ProjectStreamingToolBatchResult>
  override execute(input: ToolBatchInput): Promise<ToolBatchResult>
  override async execute(input: ToolBatchInput): Promise<ToolBatchResult | ProjectStreamingToolBatchResult> {
    if (isProjectStreamingToolBatch(input)) {
      const { persistence, acceptContext } = input[PROJECT_STREAM_TOOL_BATCH]
      const result = await executeProjectToolBatch(input, this.projectPipeline, persistence, acceptContext, this.projectMaxParallel)
      return { kind: 'projects-streamed', ...result }
    }
    return executeToolBatch(input, this.projectPipeline, this.projectMaxParallel)
  }
}

/**
 * Derived from the rc.3 PTC provider composition. The exported official
 * transport factory and PtcCalls own program execution and nested dispatch.
 * Only root batch settlement is replaced by the existing Projects writer.
 */
export class ProjectPtcExecutor implements ToolExecutor {
  readonly sections: readonly ToolPromptSection[]
  private readonly pipeline: ProjectExecutionPipeline
  private readonly calls: PtcCalls
  private readonly config: PtcConfig
  private transport: ToolDefinition | undefined
  constructor(private readonly ctx: Context, config: Partial<PtcConfig> = {}, private readonly maxParallel: () => number = () => 10) {
    this.config = PtcConfig(config)
    this.sections = [
      { name: 'tools:ptc-only', order: ctx.systemPrompt.getSectionOrder('PTC_ONLY'), interpolate: false,
        text: `\`${RUN_CODE_NAME}\` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.` },
      { name: 'tools:sdk', order: ctx.systemPrompt.getSectionOrder('TOOLS_SDK'), interpolate: false,
        text: tools => {
          const runtime = requirePtcRuntime(ctx)
          const schemas = tools.map(definition => ({ ...projectToolSchema(definition, false), output: definition.output.schema }))
          return runtime.language === 'typescript' ? renderToolsSdk(schemas, runtime.programFormat) : renderToolsSdkPy(schemas)
        } },
    ]
    this.calls = new PtcCalls(ctx)
    const tools = ctx.tools
    this.pipeline = new ProjectExecutionPipeline(ctx, {
      get: (name, scope, toolSet) => name === RUN_CODE_NAME ? this.requireTransport() : tools.executable(name, scope, toolSet),
      reject: (name, nested) => !nested && name !== RUN_CODE_NAME
        ? new ToolNotFoundError(name, `only \`${RUN_CODE_NAME}\` is callable directly — call \`${name}\` from inside a \`${RUN_CODE_NAME}\` program instead`)
        : undefined,
    })
  }
  describe(_tools: readonly ToolDefinition[]) {
    requirePtcRuntime(this.ctx)
    return { schemas: [projectToolSchema(this.requireTransport(), false)], knownNames: [RUN_CODE_NAME] }
  }
  execute(input: ProjectStreamingToolBatchInput): Promise<ProjectStreamingToolBatchResult>
  execute(input: ToolBatchInput): Promise<ToolBatchResult>
  async execute(input: ToolBatchInput): Promise<ToolBatchResult | ProjectStreamingToolBatchResult> {
    if (isProjectStreamingToolBatch(input)) {
      const { persistence, acceptContext } = input[PROJECT_STREAM_TOOL_BATCH]
      const result = await executeProjectToolBatch(input, this.pipeline, persistence, acceptContext, this.maxParallel)
      return { kind: 'projects-streamed', ...result }
    }
    return executeToolBatch(input, this.pipeline, this.maxParallel)
  }
  async reset(agent: Agent): Promise<void> {
    const runtime = requirePtcRuntime(this.ctx)
    if (!runtime.retainsState) throw new CodeResetFailedError('The PTC runtime does not retain an environment')
    try {
      await this.calls.reset(agent.session.id, () => runtime.release(agent), () => {
        agent.inject(createUserMessage({ content: [{ type: 'text', text: 'Program environment reset; retained variables cleared. Completed tool effects remain.' }], source: { kind: 'ptc-mode' } }))
      })
    } catch (error) {
      throw new CodeResetFailedError(`Program environment reset failed: ${toolErrorMessage(error)}. State may not be cleared; retry the host reset before running more code.`)
    }
  }
  private requireTransport(): ToolDefinition {
    const tools = this.ctx.tools
    if (!(tools instanceof ProjectToolRuntime)) throw new Error('Projects PTC executor requires the Projects tool registry')
    this.transport ??= createRunCodeTool(this.ctx, this.pipeline, this.config, this.calls)
    // The official definition resolves language/control getters against the
    // current runtime. Decorate each lookup without freezing those getters.
    return tools.decorate(this.transport)
  }
}

export const ProjectsNativeToolExecutorPlugin = {
  name: 'projects-native-tool-executor', inject: ['tools'],
  apply(ctx: Context) { ctx.tools.setExecutor(new ProjectNativeToolExecutor(ctx)) },
}
export const ProjectsPtcExecutorPlugin = {
  name: 'projects-ptc-tool-executor', inject: ['tools', 'systemPrompt', 'ptcRuntime'], Config: PtcConfig,
  apply(ctx: Context, config: PtcConfig) { ctx.tools.setExecutor(new ProjectPtcExecutor(ctx, config)) },
}
