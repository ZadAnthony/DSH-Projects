/** Stock fetch-once policy over exact private calls; each mounted turn owns its cancellation. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ChangesDiff, ChangesSummary, ProjectChangedFilesPorts } from './types.ts'

export type ChangesDiffState = ChangesDiff | 'missing' | 'error' | 'loading'
export type ChangesSummaryState = ChangesSummary | 'missing' | 'error' | 'loading'
interface ReadState { summary?: ChangesSummaryState; diffs: Record<number, ChangesDiffState | undefined>; stale: boolean }

/** No URL, root Remote, Session creation, or ambient-current-session fallback is reachable here. */
export class ProjectChangesScope {
  readonly state = createSnapshotStore<ReadState>({ diffs: {}, stale: false })
  private readonly lifetime = new AbortController()
  private readonly binding: SessionBinding | undefined
  private readonly stops: (() => void)[] = []
  constructor(private readonly ctx: Context, readonly sessionId: SessionId, readonly seq: number,
    private readonly ports: ProjectChangedFilesPorts, private readonly onDispose: () => void = () => {}) {
    this.binding = ctx.sessions.binding(sessionId)
    const check = () => { if (!this.current()) this.dispose() }
    this.stops.push(ctx.sessions.list.subscribe(check), ctx.sessions.retainInfo(sessionId).subscribe(check))
    check()
  }
  private current(): boolean {
    return !this.lifetime.signal.aborted && this.binding !== undefined
      && this.ctx.sessions.binding(this.sessionId) === this.binding
      && this.ctx.sessions.retainInfo(this.sessionId).getSnapshot().referenceCount > 0
  }
  private assertCurrent(): void {
    if (!this.current()) { this.dispose(); throw new DOMException('PROJECT_SOURCE_STALE: changed files belong to an ended Session binding', 'AbortError') }
  }
  async loadSummary(): Promise<void> {
    this.assertCurrent()
    const previous = this.state.getSnapshot().summary
    if (previous !== undefined && previous !== 'error') return
    this.state.update(value => { value.summary = 'loading' })
    try {
      const summary = await this.ports.summary(this.sessionId, this.seq, this.lifetime.signal)
      this.assertCurrent()
      this.state.update(value => { value.summary = summary ?? 'missing' })
    } catch (error) {
      if (!this.current()) { this.dispose(); return }
      this.state.update(value => { value.summary = 'error' })
    }
  }
  async loadDiff(index: number): Promise<void> {
    this.assertCurrent()
    const summary = this.state.getSnapshot().summary
    if (typeof summary !== 'object' || summary.files[index] === undefined) throw new Error('PROJECT_CHANGES_INDEX: comparison requires a listed file')
    const previous = this.state.getSnapshot().diffs[index]
    if (previous !== undefined && previous !== 'error') return
    this.state.update(value => { value.diffs[index] = 'loading' })
    try {
      const diff = await this.ports.diff(this.sessionId, this.seq, index, this.lifetime.signal)
      this.assertCurrent()
      if (diff !== undefined && diff.path !== summary.files[index]!.path) throw new Error('PROJECT_CHANGES_SOURCE: comparison path does not match its original file')
      this.state.update(value => { value.diffs[index] = diff ?? 'missing' })
    } catch (error) {
      if (!this.current()) { this.dispose(); return }
      this.state.update(value => { value.diffs[index] = 'error' })
    }
  }
  async openFile(index: number): Promise<void> {
    this.assertCurrent()
    const summary = this.state.getSnapshot().summary
    if (typeof summary !== 'object' || summary.files[index] === undefined) throw new Error('PROJECT_CHANGES_INDEX: opening requires a listed file')
    await this.ports.openFile(this.sessionId, summary.files[index]!.path)
    this.assertCurrent()
  }
  dispose(): void {
    if (this.lifetime.signal.aborted) return
    this.lifetime.abort(new DOMException('Projects changes scope ended', 'AbortError'))
    for (const stop of this.stops.splice(0)) stop()
    this.state.set({ diffs: {}, stale: true })
    this.onDispose()
  }
}
