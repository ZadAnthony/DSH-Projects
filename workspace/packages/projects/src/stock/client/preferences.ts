/** Isolated, process-local presentation preferences; no root configuration service is shadowed. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

export interface ProjectClientPreferenceBridge {
  readonly developerTools: ObservableSnapshot<boolean>
  /** Values only. No Host settings writer crosses into the private graph. */
  get(namespace: string): ObservableSnapshot<{ readonly value?: unknown }>
}

export class ProjectClientPreferences {
  readonly developerTools: { readonly enabled: ObservableSnapshot<boolean> }
  private readonly subscriptions = new Set<() => void>()
  constructor(private readonly bridge?: ProjectClientPreferenceBridge) {
    this.developerTools = { enabled: bridge?.developerTools ?? createSnapshotStore(false) }
  }
  dispose(): void { for (const stop of this.subscriptions) stop(); this.subscriptions.clear() }
  private readonly forms = new Map<string, ConfigForm<unknown>>()

  get<T>(namespace: string): ConfigForm<T> {
    const current = this.forms.get(namespace)
    if (current !== undefined) return current as ConfigForm<T>
    const source = createSnapshotStore<ConfigFormSnapshot<T>>({ status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false })
    if (this.bridge !== undefined) {
      const upstream = this.bridge.get(namespace)
      const adopt = () => source.set({ ...source.getSnapshot(), value: upstream.getSnapshot().value as T | undefined })
      this.subscriptions.add(upstream.subscribe(adopt)); adopt()
    }
    const set = async (field: string, value: unknown, remove = false): Promise<boolean> => {
      const before = source.getSnapshot()
      const next = { ...(before.value as Record<string, unknown> | undefined) }
      if (remove) delete next[field]
      else next[field] = value
      source.set({ ...before, value: next as T })
      // ConfigForm's true branch promises a Host write. These preferences are memory-only.
      return false
    }
    const form: ConfigForm<T> = {
      getSnapshot: source.getSnapshot, subscribe: source.subscribe,
      set: (field, value) => set(field, value), unset: field => set(field, undefined, true),
      mutate: async () => { throw new Error('Projects presentation preferences do not expose Host settings mutation') },
    }
    this.forms.set(namespace, form)
    return form
  }
}
