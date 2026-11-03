/** Private stock present result surfaces; file bytes and native opening remain explicit owner capabilities. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceByteReadOptions, WorkspaceFileBytes } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { isAbsoluteWorkspacePath, resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { PresentRow } from './PresentRow.tsx'
import { PresentedFilesTail, type PresentedFilesInjected } from './PresentedFiles.tsx'
import { deliverablesDefinition } from './turn-deliverables.ts'
import { en, zh, NS, type DeliverablesKey } from './locales.ts'

export interface ProjectPresentedFilesPorts {
  /** Route the original physical Session and original path into the real unified FileReader. */
  readonly openFile: (sessionId: SessionId, path: string, options?: { readonly line?: number }) => void | Promise<void>
  /** Optional typed byte reader for a unified FileReader adapter. The stock card has no download control. */
  readonly readFileBytes?: (sessionId: SessionId, path: string, options: WorkspaceByteReadOptions, signal?: AbortSignal) => Promise<RemoteResult<WorkspaceFileBytes>>
  /** Explicit user gesture through the serving Host's existing default-application opener. */
  readonly externalFiles?: {
    canOpenWorkspacePath(): Promise<RemoteResult<boolean>>
    openWorkspacePath(request: { readonly path: string }): Promise<RemoteResult<{ readonly opened: true }>>
  }
}

export interface ProjectPresentedFiles {
  readonly nativeOpen: boolean
  readonly download: false
  dispose(): void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { deliverables: DeliverablesKey }
}

/** Mount only durable present rows and file cards after the private Conversation and Session owners exist. */
export async function installProjectPresentedFiles(ctx: Context, ports: ProjectPresentedFilesPorts): Promise<ProjectPresentedFiles> {
  if (typeof ports.openFile !== 'function') throw new Error('PROJECT_PRESENT_PREVIEW_UNAVAILABLE: exact private FileReader is required')
  await ctx.inject(['slots', 'sessions', 'locale', 'uiConversation'], () => {})
  const disposers: (() => void)[] = []
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    for (const off of disposers.reverse()) off()
  }
  ctx.effect(() => dispose, 'Projects present results')
  disposers.push(ctx.locale.register(NS, { en, zh }))
  const t = ctx.locale.bind(NS)
  disposers.push(ctx.uiConversation.events.register(deliverablesDefinition))
  disposers.push(ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview', key: 'present', locale: NS,
  }, PresentRow)))
  disposers.push(ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail', id: '@local/dsh-projects/presented-files', locale: NS,
    inject: (sessionId: SessionId): PresentedFilesInjected => {
      const binding = ctx.sessions.binding(sessionId)
      const assertCurrent = (): void => {
        if (disposed) throw new Error('PROJECT_PRESENT_PREVIEW_UNAVAILABLE: present owner is disposed')
        if (binding === undefined || ctx.sessions.binding(sessionId) !== binding) throw new Error('PROJECT_SOURCE_STALE: present file belongs to a replaced Session')
      }
      return { openPresentedFile: (path) => {
        assertCurrent()
        return ports.openFile(sessionId, path)
      }, openPresentedOriginal: async (path) => {
        assertCurrent()
        if (ports.externalFiles === undefined) throw new Error(t('wholeDeliverables.noDefaultApp'))
        const availability = await ports.externalFiles.canOpenWorkspacePath()
        if (!availability.ok) throw availability.error
        assertCurrent()
        if (!availability.value) throw new Error(t('wholeDeliverables.noDesktop'))
        const resolved = resolveWorkspacePath(ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd, path)
        if (!isAbsoluteWorkspacePath(resolved)) throw new Error(t('wholeDeliverables.originalDirectoryUnknown'))
        const result = await ports.externalFiles.openWorkspacePath({ path: resolved })
        if (!result.ok) throw result.error
        if (result.value.opened !== true) throw new Error(t('wholeDeliverables.openUnconfirmed'))
      } }
    },
  }, PresentedFilesTail)))
  return { nativeOpen: ports.externalFiles !== undefined, download: false, dispose }
}

export { deliverablesDefinition, presentedForClosing, producedForClosing } from './turn-deliverables.ts'
