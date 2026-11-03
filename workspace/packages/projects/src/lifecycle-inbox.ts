import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

import { LifecycleBoundaryError } from './lifecycle-types.ts'

/** 只保留待退出的旧输入标识；正文和待处理事实仍在 DSH inbox/原始日志。 */
export interface ArchiveInboxSnapshot {
  readonly hostSessionId: SessionId
  readonly messageIds: readonly MessageId[]
}

/** 本片只需原生 Agent 的目标身份、inbox 与当前轮控制。 */
export interface ArchiveAgent {
  readonly id: Agent['id']
  readonly inbox: Pick<Agent['inbox'], 'nextStep' | 'nextTurn' | 'remove'>
  readonly cancel: Agent['cancel']
  readonly whenIdle: Agent['whenIdle']
}

/**
 * 核心在归档动作的同步准入边界捕获；其后新来信仍存原 inbox，但不唤醒。
 * 核心须把该边界与唯一 owner 的归档写入接线，不把本快照当持久生命周期事实。
 */
export function captureArchiveInbox(agent: ArchiveAgent): ArchiveInboxSnapshot {
  return {
    hostSessionId: agent.id,
    messageIds: [...agent.inbox.nextStep, ...agent.inbox.nextTurn].map(message => message.id),
  }
}

/**
 * 取消当前轮但保留 inbox，等待真实结束后只退出切点前旧输入。
 * 不清空晚到消息，不删除原日志；核心随后 flush，并在 idle 时调用原生默认 archive。
 * 此顺序使用默认参数检查剩余 activity，不追加 stopActivity 的各 provider 停止副作用。
 */
export async function settleArchiveInbox(agent: ArchiveAgent, before: ArchiveInboxSnapshot): Promise<void> {
  if (agent.id !== before.hostSessionId) {
    throw new LifecycleBoundaryError('LIFECYCLE_TARGET_MISMATCH', 'Archive inbox snapshot belongs to a different host session')
  }
  agent.cancel({ kind: 'user' }, { keepInbox: true })
  await agent.whenIdle()
  for (const messageId of before.messageIds) agent.inbox.remove(messageId)
}
