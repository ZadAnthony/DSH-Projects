/** Native root endpoints are not capabilities of the private Projects façade. */
import type { Context } from '@deepseek-ai/cordis'
import type { ClientRemoteAccess } from '@deepseek-ai/dsh-api-remote-access/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Projects operations keep their captured carrier guards; native root actions stay unavailable. */
export function installProjectNativeAccess(ctx: Context): void {
  const unavailable = createSnapshotStore(false)
  const access: ClientRemoteAccess = { source: () => unavailable }
  ctx.provide('remoteAccess', access)
}
