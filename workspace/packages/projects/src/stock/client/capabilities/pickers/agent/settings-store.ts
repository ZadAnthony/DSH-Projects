/** Read-only subset of upstream ui-agent-preset/settings-store.ts; see ../SOURCES.json. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AgentPresetRoster } from '@deepseek-ai/dsh-agent-preset-registry/types'
import type { ProjectCurrentSessionPickerPorts } from '../contracts.ts'

export interface AgentPresetOption { id: string; name?: string; description?: string }
export interface AgentPresetSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'
  error: string | null
  options: readonly AgentPresetOption[]
}

export function presetOptions(presets: AgentPresetRoster['presets']): AgentPresetOption[] {
  return presets.filter(preset => preset.broken === undefined).map(preset => ({
    id: preset.id,
    ...(preset.name === undefined ? {} : { name: preset.name }),
    ...(preset.description === undefined ? {} : { description: preset.description }),
  }))
}

/** One roster shared by the existing blank-session hero and read-only header. */
export class AgentPresetSettingsController {
  readonly store: SnapshotStore<AgentPresetSettingsState> = createSnapshotStore({ status: 'idle', error: null, options: [] })
  private epoch = 0
  private pending: Promise<void> | undefined
  private disposed = false
  constructor(private readonly remote: ProjectCurrentSessionPickerPorts['agentPresets']) {}
  invalidate(): void {
    if (this.disposed) return
    ++this.epoch
    this.pending = undefined
    this.store.set({ status: 'idle', error: null, options: [] })
  }
  load(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.pending !== undefined) return this.pending
    const epoch = ++this.epoch
    this.store.set({ ...this.store.getSnapshot(), status: 'loading', error: null })
    const task = this.remote.list().then(result => {
      if (this.disposed || epoch !== this.epoch) return
      if (!result.ok) {
        this.store.set(result.error.code === 'gateway/invocation-unavailable'
          ? { status: 'unavailable', error: null, options: [] }
          : { status: 'error', error: result.error.message, options: [] })
        return
      }
      this.store.set({ status: result.value.presets.length === 0 ? 'unavailable' : 'ready', error: null, options: presetOptions(result.value.presets) })
    }).catch((error: unknown) => {
      if (!this.disposed && epoch === this.epoch) this.store.set({ status: 'error', error: error instanceof Error ? error.message : String(error), options: [] })
    }).finally(() => { if (this.pending === task) this.pending = undefined })
    this.pending = task
    return task
  }
  dispose(): void { this.disposed = true; ++this.epoch; this.pending = undefined }
}
