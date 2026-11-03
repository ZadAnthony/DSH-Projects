/** Exact-existing-blank-session subset of upstream seat-store.ts; see ../SOURCES.json. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ProjectCurrentSessionPickerPorts } from '../contracts.ts'
import { AgentPresetSettingsController, type AgentPresetOption } from './settings-store.ts'

export interface AgentPresetSeatState {
  options: readonly AgentPresetOption[]
  current: string
  error: string | null
  busy: boolean
  introduce: boolean
}

/** Does not stage choices across sessions, create sessions, or change a default. */
export class AgentPresetSeatController {
  readonly store: SnapshotStore<AgentPresetSeatState> = createSnapshotStore({ options: [], current: '', error: null, busy: false, introduce: false })
  private disposed = false
  constructor(private readonly ctx: Context, readonly binding: SessionBinding,
    private readonly ports: ProjectCurrentSessionPickerPorts,
    private readonly roster: AgentPresetSettingsController) {}
  private current() {
    if (this.disposed || this.ctx.sessions.binding(this.binding.sessionId) !== this.binding) return undefined
    const summary = this.ctx.sessions.list.getSnapshot().byId[this.binding.sessionId]
    const retained = this.ctx.sessions.retainInfo(this.binding.sessionId).getSnapshot().retainedBy
    const liveSeat = (retained.mainView ?? 0) > 0 || (retained.projectsPanel ?? 0) > 0 && this.ports.isProjectPaneCurrent?.(this.binding) === true
    return summary?.blank === true && liveSeat ? summary : undefined
  }
  private preset(): string {
    const value = this.current()?.projectionValues?.agentPreset
    return typeof value === 'string' ? value : ''
  }
  refresh(): void {
    if (this.disposed) return
    this.store.set({ ...this.store.getSnapshot(), options: this.roster.store.getSnapshot().options, current: this.preset(), introduce: false })
  }
  async load(): Promise<void> { await this.roster.load(); this.refresh() }
  introduced(): void { if (!this.disposed) this.store.set({ ...this.store.getSnapshot(), introduce: false }) }
  async select(id: string): Promise<string | undefined> {
    if (this.disposed) return 'The session binding has ended'
    if (this.store.getSnapshot().busy) return undefined
    // All admission checks and the exact lease reach the bridge before the first await.
    if (this.ctx.sessions.binding(this.binding.sessionId) !== this.binding) return 'PROJECT_PICKER_SESSION_GENERATION_ENDED'
    if (!this.ports.developerTools.getSnapshot()) return 'Developer tools are disabled'
    if (this.current() === undefined) return 'The retained session is no longer blank'
    if (!this.roster.store.getSnapshot().options.some(option => option.id === id)) return 'The agent preset is no longer available'
    if (this.preset() === id) return undefined
    this.store.set({ ...this.store.getSnapshot(), busy: true, error: null })
    try {
      const result = await this.ports.agentPresets.select(this.binding, id)
      if (this.disposed || this.ctx.sessions.binding(this.binding.sessionId) !== this.binding) return 'The session binding has ended'
      if (!result.ok) {
        const details = result.error.details
        const refusal = 'reason' in details && typeof details.reason === 'string' ? details.reason : result.error.message
        this.store.set({ ...this.store.getSnapshot(), error: refusal, current: this.preset() })
        return refusal
      }
      this.store.set({ ...this.store.getSnapshot(), current: result.value })
    } catch (error) {
      const refusal = error instanceof Error ? error.message : String(error)
      if (!this.disposed) this.store.set({ ...this.store.getSnapshot(), error: refusal, current: this.preset() })
      return refusal
    } finally {
      if (!this.disposed) this.store.set({ ...this.store.getSnapshot(), busy: false })
    }
  }
  dispose(): void { this.disposed = true }
}
