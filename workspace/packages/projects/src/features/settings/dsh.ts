import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { AgentOptions, AgentSetup, ModelSelection as AgentModelSelection } from '@deepseek-ai/dsh-agent'
import type { NewExecutionDefaults, SettingsModelPort } from './types.ts'

/** 只绑定目录读取方法；不取得 selectModel 或全局默认写能力。 */
export function dshSettingsModelPort(controller: SettingsModelPort): SettingsModelPort {
  return { modelCatalog: signal => { signal?.throwIfAborted(); return controller.modelCatalog(signal) } }
}

export interface DshNewExecutionConfiguration {
  agentOptions: AgentOptions
  /** 新会话在首次请求前保存原生 model/selection，重开沿 DSH 投影恢复。 */
  initialSelection: AgentModelSelection
  /** 新建 factory.setup 中先执行，再安装会读取 pending selection 的宿主选择逻辑。 */
  initializeInSetup: AgentSetup
}

/** 只用于已决定新建的执行会话。inherit 由创建方取得当时原生默认，unavailable 不偷偷换模型。 */
export function dshNewExecutionConfiguration(plan: NewExecutionDefaults): DshNewExecutionConfiguration | undefined {
  if (plan.kind === 'unavailable') throw new Error(plan.message)
  if (plan.kind === 'inherit') return undefined
  const selection: AgentModelSelection = {
    provider: plan.selection.provider, model: plan.selection.model,
    ...(plan.selection.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(plan.selection.reasoningEffort) }),
  }
  return dshNewProjectSessionConfiguration(selection)
}

/** 在真正新建时固定同一份选择，主会话与未配置执行默认的空会话也不继续联动宿主默认。 */
export function dshNewProjectSessionConfiguration(selection: AgentModelSelection): DshNewExecutionConfiguration {
  const initialSelection = { ...selection }
  return {
    agentOptions: { ...initialSelection }, initialSelection: { ...initialSelection },
    initializeInSetup: (_agentCtx, agent) => {
      if (agent.session.snapshotEvents().length !== 0) throw new Error('项目模型只能初始化尚无事件的新会话，不能覆盖已有会话。')
      agent.session.append('model/selection', { ...initialSelection })
    },
  }
}
