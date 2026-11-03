/** Private changed-file cards. The shared deliverables Definition is installed by presented-files. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { ChangedFilesTail, type ChangedFilesInjected } from './ChangedFiles.tsx'
import { ProjectChangesScope } from './reads.ts'
import { en, zh, NS, type DeliverablesKey } from './locales.ts'
import { acquireUiStyles } from '../../../../client/ui/index.ts'
import type { ProjectChangedFilesPorts } from './types.ts'
export type { ProjectChangedFilesPorts, ChangesSummary, ChangesDiff } from './types.ts'
export interface ProjectChangedFiles { readonly nativeOpen: false; readonly reviewTabs: false; dispose(): void }
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'project-changes': DeliverablesKey } }

/** Install after PresentedFiles, with exact private read and FileReader operations. */
export async function installProjectChangedFiles(ctx: Context, ports: ProjectChangedFilesPorts): Promise<ProjectChangedFiles> {
  if (typeof ports.summary !== 'function' || typeof ports.diff !== 'function' || typeof ports.openFile !== 'function') throw new Error('PROJECT_CHANGES_CAPABILITY_UNAVAILABLE: summary, comparison and exact FileReader are required')
  await ctx.inject(['slots', 'sessions', 'locale'], () => {})
  const scopes = new Set<ProjectChangesScope>(), stops: (() => void)[] = []
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const scope of [...scopes]) scope.dispose()
    for (const stop of stops.reverse()) stop()
  }
  ctx.effect(() => dispose, 'Projects changed files')
  stops.push(acquireUiStyles(document))
  stops.push(ctx.locale.register(NS, { en, zh }))
  stops.push(ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail', id: '@local/dsh-projects/changed-files', locale: NS,
    inject: (sessionId: SessionId): ChangedFilesInjected => ({ createChangesScope: seq => {
      if (disposed) throw new Error('PROJECT_SOURCE_STALE: changed-files owner is disposed')
      let scope: ProjectChangesScope | undefined
      scope = new ProjectChangesScope(ctx, sessionId, seq, ports, () => { if (scope !== undefined) scopes.delete(scope) })
      if (!scope.state.getSnapshot().stale) scopes.add(scope)
      return scope
    } }),
  }, ChangedFilesTail)))
  return { nativeOpen: false, reviewTabs: false, dispose }
}
