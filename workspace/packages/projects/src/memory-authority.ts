import type { MemoryCurrentReference } from './memory-types.ts'

/** 同一消费语义供角色、索引及按需读取复用；关系不是条款级裁决。 */
export const MEMORY_CURRENT_AUTHORITY = '用户在设置直接保存的当前主题编辑，对该主题及其适用范围生效；同主题旧版本中被移除的表达，不能仅因旧原话仍可读取而恢复为当前约定。来源可追溯不等于当前继续适用。原话可同时涉及多个主题，不能整条作废；其它事项、范围和后来新的明确用户决定仍须分别判断。关联仅指向当前主题，不能裁定原话每个条款的效力；无关联或读取不完整不证明原话有效或无效。正文仍须按需读取。最后编辑者、来源和版本事实分别看：reconfirmedBy或settings来源可被后续Bot修订沿用，不代表整份当前Bot整理正文由用户直接编辑。已撤回主题只保留最小标识、来源及撤回情况，不能沿同源旧聊天、摘要、交办抄本或看板绕过相应事项和范围的撤回。历史撤回记录只证明曾撤回；同标识当前主题仍在current集合时，以owner已合法恢复的当前主题为准，不把历史撤回当作当前状态。用户可在指令或记忆自由填写内容；承载位置不设固定高低，按真实来源、适用范围和真正明确的新决定理解。'

/** 只投影当前文件事实，不复制默认正文或推断设置编辑的历史快照。 */
export function currentMemoryReference(memory: MemoryCurrentReference): MemoryCurrentReference {
  const { id, projectId, path, title, type, nature, scope, revision, generation, updatedAt, updatedBy, sources, originSources, reconfirmedBy } = memory
  return structuredClone({ id, projectId, path, title, type, nature, scope, revision, updatedAt, updatedBy, sources, originSources,
    ...(generation === undefined ? {} : { generation }),
    ...(reconfirmedBy === undefined ? {} : { reconfirmedBy }) })
}
