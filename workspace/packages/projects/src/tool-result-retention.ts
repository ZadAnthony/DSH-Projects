import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

const completedValues = new WeakMap<Readonly<ToolExecution>, unknown>()

/** 只供同次真实调用的结果消费者读取；不从模型文本或原生错误推断写入结果。 */
export function completedToolValue(exec: Readonly<ToolExecution>): unknown {
  return completedValues.get(exec)
}

/** 原生取消仍是错误，但不能抹去写工具已经返回的领域事实。 */
export function retainCompletedToolResult(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    execute: async (args, exec) => {
      const value = await tool.execute(args, exec)
      completedValues.set(exec, value)
      return value
    },
    finalizeContent: (exec, result) => {
      const content = tool.finalizeContent?.(exec, result)
      if (!result.isError || !completedValues.has(exec)) return content
      try {
        // 仍走工具的公开投影，不能把 renderer 隐去的内部字段直接暴露给模型。
        const returned = tool.output.render(exec.arguments, completedValues.get(exec) as JsonValue)
        return [...(content ?? result.content), { type: 'text', text: 'Completed tool body result (the tool call still ended with the error above):' }, ...returned]
      } catch {
        // 原投影本身失败时没有可用的公开表示；保留原生错误，不编造写入结论。
        return content
      }
    },
  }
}
