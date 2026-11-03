import { nativeProjectSourceKey } from '../../native-source.ts'
import type { OverviewSourceRef, OverviewSourceView } from './contract.ts'

/** 定位比较只使用合同字段，不依赖 JSON 属性顺序。 */
export function sourceIdentity(reference: OverviewSourceRef): string {
  switch (reference.kind) {
    case 'native': return 'native:' + nativeProjectSourceKey(reference.source)
    case 'library': return JSON.stringify(['library', reference.location.kind,
      reference.location.kind === 'project-file' ? reference.location.relativePath : reference.location.entryId])
    case 'session': return JSON.stringify(['session', reference.id])
    case 'memory': return JSON.stringify(['memory', reference.topicId])
  }
}

export function sourceLabel(reference: OverviewSourceRef): string {
  return { native: '原聊天或工具来源', library: 'Library文件', session: '项目会话', memory: '共享记忆' }[reference.kind]
}

export function unavailableSource(
  projectId: string, reference: OverviewSourceRef, readAt: string, message: string,
  status: OverviewSourceView['status'] = 'unavailable',
): OverviewSourceView {
  return { projectId, reference, label: sourceLabel(reference), status, readAt, rows: [], message }
}

/** 无法读取的来源不展示附带的旧内容；真实删除原因只沿用 Core 提供的消息。 */
export function currentSource(projectId: string, reference: OverviewSourceRef, value: OverviewSourceView): OverviewSourceView {
  if (value.projectId !== projectId) throw new Error('Overview source returned another project')
  if (sourceIdentity(value.reference) !== sourceIdentity(reference)) throw new Error('Overview source does not match its requested reference')
  return { ...value, rows: value.status === 'available' ? value.rows : [] }
}
