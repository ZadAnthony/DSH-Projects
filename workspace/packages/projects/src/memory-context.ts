import type {
  MemoryContext, MemoryContextTarget, MemorySnapshot, MemoryWithdrawal, ProjectMemory,
} from './memory-types.ts'
import { LEGACY_MEMORY_SCOPE_NOTICE } from './memory-types.ts'
import { MEMORY_CURRENT_AUTHORITY, currentMemoryReference } from './memory-authority.ts'

/** 范围用于索引判断，不再选择任何默认供给正文；旧 work 不进入当前索引。 */
export function selectMemoryContext(
  snapshot: MemorySnapshot,
  memories: readonly Omit<ProjectMemory, 'body'>[],
  target: MemoryContextTarget,
  withdrawals: readonly MemoryWithdrawal[] = [],
): MemoryContext {
  if (snapshot.projectId !== target.projectId) throw new Error('不能把另一项目的记忆提供给当前会话。')
  const legacy = snapshot.entries.filter(item => item.scope.kind === 'work')
  const current = snapshot.entries.filter(item => item.scope.kind !== 'work')
  for (const memory of memories) {
    if (memory.projectId !== target.projectId) throw new Error('记忆正文项目归属不匹配。')
  }
  return {
    projectId: target.projectId,
    index: legacy.length === 0 ? snapshot.index : [
      '# 当前共享记忆索引', '旧 work 范围不在本次供给中；原文件与完整索引保留供查看。',
      ...current.map(item => JSON.stringify(item)),
      ...(current.length === 0 ? ['当前没有现行范围的共享记忆。'] : []),
    ].join('\n'),
    entries: structuredClone(current),
    currentReferences: memories.filter(memory => memory.scope.kind !== 'work').map(currentMemoryReference),
    withdrawals: structuredClone([...withdrawals]), availability: 'available',
    indexSynchronized: snapshot.indexSynchronized,
    provided: [], issues: [
      ...structuredClone(snapshot.issues), ...legacy.map(item => ({ path: item.path, message: LEGACY_MEMORY_SCOPE_NOTICE })),
    ],
  }
}

/** 只渲染当前目录，不消费旧 provided 字段或任何记忆正文。 */
export function renderMemoryContext(context: MemoryContext): string {
  return [
    '以下是Projects产品在本次请求准备时从记忆owner取得的当前索引。整体目标、规划和进展取自项目看板；要求按真实来源、适用范围和真正明确的变化理解，不因承载位置改变来源或授权。',
    '所有共享记忆正文均按需调用 project_memory_read 读取，包括持续规则和偏好。索引只说明有什么、适用处和读取入口，不代表已经读取正文或核对来源；待验证历史内容不能当作已确认要求。',
    '本次供给替代较早输入中的共享记忆；已纠正或撤回的旧内容不能继续作为当前记忆依据。保存不等于已通知其它会话或被模型采用。',
    MEMORY_CURRENT_AUTHORITY,
    '\n共享记忆索引：', context.index,
    ...((context.invalidations?.length ?? 0) === 0 ? [] : [
      '仍须解释保留历史的最小失效说明（仅相应主题及已知范围，不撤销同源消息中的其它事项；未列出的旧范围未知）：',
      ...context.invalidations!.map(item => JSON.stringify(item) + (item.previouslyRead ? '。此主题此前已读，使用前须重新按需读取。' : '')),
      '已修订主题使用前须重新按需读取；停止依赖旧摘要和旧读取结果。撤回或不可读不提供旧正文；核对历史原件不恢复当前效力。',
    ]),
    ...(context.issues.length === 0 ? [] : ['读取限制（不能据此声称取得完整最新记忆）：', JSON.stringify(context.issues)]),
  ].join('\n')
}
