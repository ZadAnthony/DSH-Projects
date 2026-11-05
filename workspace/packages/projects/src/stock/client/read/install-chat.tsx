/** Project-owned native Chat template assembly, shared by live and read-only domains. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatSnapshot } from '../compat/chat/client/contract/snapshot.ts'
import type { ReactNode } from 'react'
import type { MessageImageLoader } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ProjectReplyLinkSource } from '../../../client/ProjectReplySessionLinks.tsx'
export interface ProjectCommunicationMessagePresentation {
  readonly sessionId: string
  readonly message: { readonly source: unknown; readonly messageId?: string }
  readonly loadImage: MessageImageLoader
  readonly openFile?: (path: string) => void | Promise<void>
  readonly renderOriginal: () => ReactNode
}
import { apply } from '../compat/chat/client/apply.ts'
import type { ProjectFileReaderOwner } from './file-reader.ts'
import { sameProjectFileBinding } from './file-reader.ts'
import type { ProjectFocusOwner, ProjectFocusTarget } from './focus.ts'

export interface InstallProjectChatOptions {
  readonly fileReader: ProjectFileReaderOwner
  readonly focusOwner?: ProjectFocusOwner
  readonly allowBranch: false
  /** Resolve the actual work-role owner of the presented physical Session; absent for children and Bots. */
  readonly replySessionLinkSource?: ((hostSessionId: string) => ProjectReplyLinkSource | undefined) | undefined
  readonly renderCommunicationMessage?: (presentation: ProjectCommunicationMessagePresentation) => ReactNode
}
export interface ProjectChatFocusRegistration {
  attach(root: HTMLElement, actions: { setTurnProcessOpen(turn: number, answerStep: number, open: boolean): void }): () => void
}

async function frame(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>(resolve => { requestAnimationFrame(() => { resolve() }) })
  signal.throwIfAborted()
}

export function createProjectChatFocusRegistration(ctx: Context, binding: SessionBinding,
  snapshot: () => ChatSnapshot, options: InstallProjectChatOptions): ProjectChatFocusRegistration | undefined {
  const owner = options.focusOwner
  const exact = options.fileReader.options.resolveBinding(binding.sessionId)
  if (owner === undefined || exact === undefined) return undefined
  return { attach: (root, actions) => owner.register({
    binding: exact, nativeBinding: binding, session: binding.session, events: binding.eventSource, snapshot,
    clear: () => { for (const element of root.querySelectorAll<HTMLElement>('[data-project-source-focused]')) delete element.dataset.projectSourceFocused },
    current: () => {
      const latest = options.fileReader.options.resolveBinding(binding.sessionId)
      return root.isConnected && ctx.sessions.binding(binding.sessionId) === binding
        && latest !== undefined && sameProjectFileBinding(exact, latest)
    },
    reveal: async (target: ProjectFocusTarget, signal) => {
      if (target.turn !== undefined) actions.setTurnProcessOpen(target.turn, target.answerStep ?? 0, true)
      await frame(signal); await frame(signal)
      if (!root.isConnected || ctx.sessions.binding(binding.sessionId) !== binding) throw new Error('PROJECT_SOURCE_STALE: original Chat was replaced')
      const key = CSS.escape(target.nodeKey)
      const row = root.querySelector<HTMLElement>(`[data-chat-node-key="${key}"]:not([data-chat-group-part="reasoning"])`)
      if (row === null) throw new Error('PROJECT_SOURCE_FOCUS_FAILED: exact native row is not rendered')
      // Native Chat's Turn and step-group disclosures implement browser find through
      // beforematch. Reveal only the exact target's ancestors, through that same path.
      for (let depth = 0; depth < 8; depth++) {
        const hidden = row.closest<HTMLElement>('[hidden="until-found"]')
        if (hidden === null) break
        hidden.dispatchEvent(new Event('beforematch'))
        await frame(signal)
      }
      let anchor = row
      if (target.callId !== undefined) {
        const call = row.querySelector<HTMLElement>(`[data-chat-call-id="${CSS.escape(target.callId)}"]`)
        if (call === null) throw new Error('PROJECT_SOURCE_FOCUS_FAILED: actual tool invocation is not rendered')
        // Only the exact call's own native disclosure is expanded; unrelated controls are untouched.
        const disclosure = [...call.querySelectorAll<HTMLButtonElement>('[aria-expanded="false"]')]
          .find(button => button.closest('[data-chat-call-id]') === call)
        disclosure?.click(); anchor = call
        await frame(signal)
      }
      if (anchor.closest('[hidden]') !== null) throw new Error('PROJECT_SOURCE_FOCUS_FAILED: native source is still folded')
      anchor.tabIndex = -1
      anchor.dataset.projectSourceFocused = ''
      anchor.scrollIntoView({ block: 'center' }); anchor.focus({ preventScroll: true })
    },
  }) }
}

export function installProjectChat(ctx: Context, options: InstallProjectChatOptions): void {
  if (options.allowBranch !== false) throw new Error('Projects Chat does not support branching')
  apply(ctx, options)
}
