/** Read-only native Host invalidations, kept outside the Projects control-event codec. */
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { TypertClientEventListener } from '@deepseek-ai/dsh-typert-protocol'

type PluginManagerListener = TypertClientEventListener<'plugin-manager/changed'>

export interface ProjectNativeHostNotificationSource {
  subscribePluginManagerChanged(listener: PluginManagerListener): () => void
}

/** Root entry alone feeds this channel; private domains receive only its subscribe face. */
export class ProjectNativeHostNotifications implements ProjectNativeHostNotificationSource {
  private readonly listeners = new Set<PluginManagerListener>()
  private disposed = false

  subscribePluginManagerChanged(listener: PluginManagerListener): () => void {
    if (this.disposed) throw new Error('Projects native Host notifications are disposed')
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  publishPluginManagerChanged(...args: Parameters<PluginManagerListener>): void {
    if (this.disposed) return
    for (const listener of [...this.listeners]) listener(...structuredClone(args))
  }

  dispose(): void { this.disposed = true; this.listeners.clear() }
}
