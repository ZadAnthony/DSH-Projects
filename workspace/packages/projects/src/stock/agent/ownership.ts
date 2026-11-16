import { AsyncLocalStorage } from 'node:async_hooks'
import type { Agent } from '@deepseek-ai/dsh-agent'

const creationParents = new AsyncLocalStorage<Agent | undefined>()

/** 由实际子会话owner移交本次创建责任，普通根会话和driver不继承因果归属。 */
export function withProjectAgentParent<T>(parent: Agent | undefined, operation: () => T): T {
  return creationParents.run(parent, operation)
}

export function projectAgentParent(): Agent | undefined { return creationParents.getStore() }
