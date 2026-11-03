import { projectCopy, type ProjectsTranslate } from '../ui/copy.ts'
import type { MemoryDraft, MemoryScope, MemoryType, MemoryWriteResult, ProjectMemory, SaveMemoryInput, StoredMemoryDraft, StoredMemoryScope } from '../../memory-types.ts'
import { LEGACY_MEMORY_SCOPE_NOTICE, memoryMutationFailure } from '../../memory-types.ts'

export function emptyMemoryDraft(): MemoryDraft {
  return { title: '', summary: '', body: '', type: 'rule', nature: 'confirmed', scope: { kind: 'project' }, sources: [] }
}

/** Compare editable fields only; saved metadata is not a user draft. */
export function memoryDraftKey(draft: StoredMemoryDraft): string {
  return JSON.stringify([draft.title, draft.summary, draft.body, draft.type, draft.nature, draft.scope])
}

export function memoryEditInput(draft: StoredMemoryDraft, current?: ProjectMemory): SaveMemoryInput {
  if (draft.scope.kind === 'work') throw new Error(LEGACY_MEMORY_SCOPE_NOTICE)
  return {
    ...draft, scope: scopeWithTargets(draft.scope.kind, scopeTargets(draft.scope)), sources: structuredClone(draft.sources),
    ...(current === undefined ? {} : { id: current.id, expectedRevision: current.revision }),
    ...(current?.generation === undefined ? {} : { expectedGeneration: current.generation }),
  }
}

export function memoryOutcome(result: MemoryWriteResult, copy: ProjectsTranslate = projectCopy()): string {
  switch (result.kind) {
    case 'saved': return copy("p5.memory.savedOutcome")
    case 'withdrawn': return copy("p5.memory.withdrawnOutcome")
    case 'conflict': return result.message
    case 'failed': return copy("p5.memory.saveFailed", { value: result.message })
    case 'partial': return [
      copy("p5.memory.partialSave"),
      result.operation === 'save' ? copy("p5.memory.bodyOutcome", { value: result.bodySaved ? copy("tool.card.result.saved") : copy("p3.memory.unsaved") })
        : copy("p5.memory.withdrawalBodyOutcome", { value: result.bodyRemoved ? copy("sessions.deletion.progress.removed") : copy("p5.memory.notDeleted") }),
      copy("p5.memory.indexOutcome", { value: result.indexSaved ? copy("p5.memory.synced") : copy("p5.memory.notSynced") }), result.message,
    ].join(' ')
  }
}

export function scopeTargets(scope: StoredMemoryScope): string {
  switch (scope.kind) {
    case 'project': return ''
    case 'work': return scope.workIds.join('\n')
    case 'session': return scope.sessionIds.join('\n')
    case 'file': return scope.paths.join('\n')
    case 'topic': return scope.topics.join('\n')
  }
}

/** Textareas retain incomplete lines while typing; the save boundary normalizes complete targets. */
export function scopeWithTargets(kind: MemoryScope['kind'], text: string, preserveDraft = false): MemoryScope {
  const lines = text.split(/\r?\n/)
  const targets = preserveDraft ? lines : lines.map(value => value.trim()).filter(Boolean)
  switch (kind) {
    case 'project': return { kind }
    case 'session': return { kind, sessionIds: targets }
    case 'file': return { kind, paths: targets }
    case 'topic': return { kind, topics: targets }
    default: throw new Error(LEGACY_MEMORY_SCOPE_NOTICE)
  }
}

export const memoryTypeLabels: Record<MemoryType, string> = {
  rule: '持续规则', preference: '项目内偏好', background: '相关背景', fact: '事实与发现', experience: '选择经验与事情回忆',
}

/** Preserves the unknown outcome after transport removes the Error prototype. */
export function memoryErrorText(error: unknown, copy: ProjectsTranslate = projectCopy()): string {
  const failure = memoryMutationFailure(error)
  if (failure === undefined) return error instanceof Error ? error.message : String(error)
  const facts = failure.confirmed
  return [copy("p5.memory.saveUnconfirmed"),
    ...(facts.bodySaved ? [copy("p5.memory.bodySaveConfirmed")] : []),
    ...(facts.withdrawalSaved ? [copy("p5.memory.withdrawalSaveConfirmed")] : []),
    ...(facts.bodyRemoved ? [copy("p5.memory.bodyDeletionConfirmed")] : []),
    ...(facts.indexSaved ? [copy("p5.memory.indexSyncConfirmed")] : []),
  ].join(' ')
}
