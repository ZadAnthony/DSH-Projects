/** Public endpoint names describe only the capabilities routed by the private Projects façade. */
import type { Context } from '@deepseek-ai/cordis'
import type { ClientRemoteAccess } from '@deepseek-ai/dsh-api-remote-access/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { whenAllowed } from './native/when-allowed.ts'

export interface ProjectChildInputAccess {
  readonly sessionId: SessionId
  readonly writable: HostObservable<boolean>
}

/** Only the captured child prompt/Stop façade is presented as writable; root endpoints stay unavailable. */
export function installProjectNativeAccess(ctx: Context, child?: ProjectChildInputAccess): void {
  const unavailable = createSnapshotStore(false)
  const source: ClientRemoteAccess['source'] = (kind, id, action) => child !== undefined && kind === 'session' && id === child.sessionId
    && (action === 'session/prompt' || action === 'session/cancel') ? child.writable : unavailable
  const access: ClientRemoteAccess = {
    source,
    whenAccess: () => () => {},
    whenResourceAccess: (kind, id, action, callback) => whenAllowed(ctx, source(kind, id, action), callback, 'Projects private child input access'),
  }
  ctx.provide('remoteAccess', access)
}
