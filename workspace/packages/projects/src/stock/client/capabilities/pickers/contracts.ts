/** Narrow current-session capabilities; no Settings writer or session creation face. */
import type { Context } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

export interface ProjectCurrentSessionPickerPorts {
  readonly permissionPresets: Pick<ClientRemote['permissionPresets'], 'catalog'>
  readonly agentPresets: {
    readonly list: ClientRemote['agentPresets']['list']
    /** Synchronously capture this exact physical binding; reject ended/replaced bindings. */
    select(binding: SessionBinding, preset: string): ReturnType<ClientRemote['agentPresets']['select']>
  }
  /** Read the actual Developer tools preference. This gate never writes Settings. */
  readonly developerTools: ObservableSnapshot<boolean>
  /** Only the Projects live owner supplies this exact visible physical-pane predicate. */
  readonly isProjectPaneCurrent?: (binding: SessionBinding) => boolean
}

export function assertCurrentBinding(ctx: Context, binding: SessionBinding): void {
  if (ctx.sessions.binding(binding.sessionId) !== binding) throw new Error('PROJECT_PICKER_SESSION_GENERATION_ENDED')
}
