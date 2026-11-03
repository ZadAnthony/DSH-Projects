import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentPresetRegistry, { type AgentPreset } from '@deepseek-ai/dsh-agent-preset-registry'
import { scopeOf, scopeParentOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { createHash } from 'node:crypto'
import type { ProjectsPresetSnapshot } from '../preset-snapshot.ts'
import { materializeSnapshotTree, ProjectsPresetLoader, type InstalledProjectsPreset } from './loader.ts'

interface Revision {
  readonly snapshot: ProjectsPresetSnapshot
  readonly generation: string
  readonly runtimeId: string
  readonly key: ScopeKey
  readonly keeper: AsyncDisposable
  readonly unregister: () => Promise<void>
  requests: number
  retired: boolean
  retirement?: Promise<void>
}

export interface ProjectsPresetRequestLease extends AsyncDisposable {
  readonly presetId: string
  readonly generation: string
  readonly key: ScopeKey
}

export interface ProjectsPresetPublication {
  readonly status: 'published' | 'unchanged' | 'failed'
  readonly presetId: string
  readonly generation?: string
  readonly error?: string
}

/**
 * Public native registry plus a logical-id routing layer. Native registration,
 * activation, scope binding, child inheritance and retirement are unchanged;
 * unique private ids allow a candidate to become ready before one synchronous
 * publication changes the logical selection. No native private fields are read.
 */
export class ProjectsAgentPresetRegistry extends AgentPresetRegistry {
  private currentRevision?: Revision
  private readonly selections = new Map<string, Revision>()
  private readonly revisions = new Map<string, Revision>()
  private readonly fixedChildren = new WeakSet<ScopeKey>()
  private readonly explicitChildren = new WeakSet<ScopeKey>()
  private sequence = 0
  private stopped = false
  private staging: Promise<unknown> = Promise.resolve()
  private readonly retirementFailures: unknown[] = []
  private loadSource?: (id: string) => Promise<ProjectsPresetPublication>
  private sourceCatalog?: () => Promise<AgentPreset[]>

  sourcePorts(load: (id: string) => Promise<ProjectsPresetPublication>, catalog: () => Promise<AgentPreset[]>): void {
    this.loadSource = load
    this.sourceCatalog = catalog
  }

  private async ensureSource(id?: string): Promise<void> {
    if (id === undefined || this.selections.has(id) || this.revisions.has(id) || this.loadSource === undefined) return
    const result = await this.loadSource(id)
    if (result.status === 'failed') throw new Error(`PROJECT_PRESET_NOT_READY: ${result.error}`)
  }

  override get defaultId(): string { return this.currentRevision?.snapshot.presetId ?? super.defaultId }
  get generation(): string | undefined { return this.currentRevision?.generation }
  get snapshot(): ProjectsPresetSnapshot | undefined { return this.currentRevision?.snapshot }
  hasSource(id: string): boolean { return this.selections.has(id) }
  generationForPreset(id?: string): string | undefined { return id === undefined ? this.currentRevision?.generation : this.selections.get(id)?.generation }

  async publishSnapshot(snapshot: ProjectsPresetSnapshot, configuration?: unknown, beforePublish?: () => Promise<void>, selectDefault = true): Promise<ProjectsPresetPublication> {
    const operation = this.staging.then(() => this.publishOwned(snapshot, configuration, beforePublish, selectDefault))
    this.staging = operation.catch(() => {})
    return operation
  }

  private async publishOwned(snapshot: ProjectsPresetSnapshot, configuration?: unknown, beforePublish?: () => Promise<void>, selectDefault = true): Promise<ProjectsPresetPublication> {
    if (this.stopped) throw new Error('PROJECT_CLOSING: preset revisions are closing')
    const generation = createHash('sha256').update(JSON.stringify({ snapshot, configuration })).digest('hex')
    const selected = this.selections.get(snapshot.presetId)
    if (selected?.generation === generation) {
      if (selectDefault) this.currentRevision = selected
      return { status: 'unchanged', presetId: snapshot.presetId, generation }
    }
    const runtimeId = `projects-revision-${++this.sequence}-${generation.slice(0, 16)}`
    const declaring = this.ctx.extend({ baseUrl: snapshot.tree.baseUrl })
    let unregister: (() => Promise<void>) | undefined
    let keeper: ({ key: ScopeKey } & AsyncDisposable) | undefined
    try {
      unregister = await declaring.agentPresets.register({ id: runtimeId, plugins: materializeSnapshotTree(snapshot.tree, this.ctx.loader as ProjectsPresetLoader) })
      const state = await super.resolve(runtimeId)
      if (state.broken !== undefined) throw new Error(state.broken)
      keeper = await super.acquireScope(runtimeId)
      if (this.stopped) throw new Error('PROJECT_CLOSING: preset publication was cancelled')
      await beforePublish?.()
      if (this.stopped) throw new Error('PROJECT_CLOSING: preset publication was cancelled')
      const revision: Revision = { snapshot, generation, runtimeId, key: keeper.key, keeper, unregister, requests: 0, retired: false }
      const previous = this.selections.get(snapshot.presetId)
      // No awaits between inserting the fully ready candidate and routing new
      // readers to it. Failed candidates never reach either map or selection.
      this.revisions.set(runtimeId, revision)
      this.selections.set(snapshot.presetId, revision)
      if (selectDefault || this.currentRevision === previous) this.currentRevision = revision
      if (previous !== undefined) {
        previous.retired = true
        try { await this.retire(previous) } catch (error) { this.retirementFailures.push(error) }
      }
      this.collectRetired()
      return { status: 'published', presetId: snapshot.presetId, generation }
    } catch (error) {
      if (unregister !== undefined) await unregister()
      await keeper?.[Symbol.asyncDispose]()
      return { status: 'failed', presetId: snapshot.presetId, generation: this.currentRevision?.generation,
        error: error instanceof Error ? error.message : String(error) }
    }
  }

  private runtimeId(id?: string): string {
    if (id === undefined) {
      if (this.currentRevision === undefined) throw new Error('PROJECT_NOT_READY: no preset revision has been published')
      return this.currentRevision.runtimeId
    }
    const selected = this.selections.get(id)
    if (selected !== undefined) return selected.runtimeId
    return id
  }

  private logical(id: string): string { return this.revisions.get(id)?.snapshot.presetId ?? id }

  override async list(): Promise<AgentPreset[]> {
    const available = await this.sourceCatalog?.() ?? []
    const mounted = await Promise.all([...this.selections.values()].map(async revision => ({ ...await super.resolve(revision.runtimeId), id: revision.snapshot.presetId })))
    return [...available.filter(row => !this.selections.has(row.id)), ...mounted]
  }

  override async resolve(id?: string): Promise<AgentPreset> {
    await this.ensureSource(id)
    const row = await super.resolve(this.runtimeId(id))
    return { ...row, id: this.logical(row.id) }
  }

  override async mount(ctx: Context, id?: string): Promise<AgentPreset> {
    await this.ensureSource(id)
    const row = await super.mount(ctx, this.runtimeId(id))
    return { ...row, id: this.logical(row.id) }
  }

  override composedPreset(ctx: Context): string | undefined {
    const id = super.composedPreset(ctx)
    return id === undefined ? undefined : this.logical(id)
  }

  override composeFrom(ctx: Context, parent: Context): string | undefined {
    const parentKey = scopeOf(parent)
    const parentRevision = parentKey === undefined ? undefined : scopeParentOf(parentKey)
    const existing = super.composedPreset(ctx)
    if (existing !== undefined) {
      const childKey = scopeOf(ctx)
      if (childKey !== undefined && this.explicitChildren.has(childKey)) return this.logical(existing)
      if (childKey === undefined || scopeParentOf(childKey) !== parentRevision) throw new Error('Child already joined a different preset revision')
      const key = scopeOf(ctx)
      if (key !== undefined) this.fixedChildren.add(key)
      return this.logical(existing)
    }
    const id = super.composeFrom(ctx, parent)
    const key = scopeOf(ctx)
    if (id !== undefined && key !== undefined) this.fixedChildren.add(key)
    return id === undefined ? undefined : this.logical(id)
  }

  override async acquireScope(id?: string): Promise<{ key: ScopeKey } & AsyncDisposable> {
    await this.ensureSource(id)
    return super.acquireScope(this.runtimeId(id))
  }

  override async readDocument(id: string) {
    await this.ensureSource(id)
    const document = await super.readDocument(this.runtimeId(id))
    return { ...document, agentPreset: this.logical(document.agentPreset) }
  }

  override async compositionInventory(): ReturnType<AgentPresetRegistry['compositionInventory']> {
    return (await super.compositionInventory()).filter(row => this.selections.get(this.logical(row.id))?.runtimeId === row.id)
      .map(row => ({ ...row, id: this.logical(row.id) }))
  }

  async bindAgent(ctx: Context, parent?: Agent, selectedId?: string, coldChild = false): Promise<void> {
    if (parent !== undefined && (selectedId === undefined || selectedId === this.composedPreset(parent.ctx))) {
      if (this.composeFrom(ctx, parent.ctx) === undefined) throw new Error('PROJECT_PRESET_PARENT_UNBOUND: child must inherit its actual parent revision')
    } else {
      await this.mount(ctx, selectedId)
      if (parent !== undefined || coldChild) {
        const key = scopeOf(ctx)
        if (key !== undefined) { this.fixedChildren.add(key); this.explicitChildren.add(key) }
      }
    }
  }

  /** Called before assembly. Existing children stay on their inherited tree. */
  async acquireRequest(agent: Agent, selectedId?: string): Promise<ProjectsPresetRequestLease> {
    if (this.stopped) throw new Error('PROJECT_CLOSING: preset revisions are closing')
    const scope = scopeOf(agent.ctx)
    if (scope === undefined) throw new Error('Project request requires a real Agent scope')
    // Native recompose also emits tools/change, which reconciles Agent-owned
    // delegation definitions when an old child still retains the former tree.
    if (!this.fixedChildren.has(scope)) await this.recompose(agent.ctx, selectedId ?? this.defaultId)
    const mounted = super.composedPreset(agent.ctx)
    const revision = mounted === undefined ? undefined : this.revisions.get(mounted)
    if (revision === undefined || scopeParentOf(scope) !== revision.key) throw new Error('PROJECT_PRESET_REVISION_UNAVAILABLE: request has no exact bound revision')
    revision.requests++
    let released = false
    return {
      presetId: revision.snapshot.presetId, generation: revision.generation, key: revision.key,
      [Symbol.asyncDispose]: async () => {
        if (released) return
        released = true
        revision.requests--
        await this.retire(revision)
        this.collectRetired()
      },
    }
  }

  isFixedChild(agent: Agent): boolean { const key = scopeOf(agent.ctx); return key !== undefined && this.fixedChildren.has(key) }

  private retire(revision: Revision): Promise<void> {
    if (!revision.retired || revision.requests !== 0) return Promise.resolve()
    return revision.retirement ??= (async () => {
      await revision.unregister()
      await revision.keeper[Symbol.asyncDispose]()
    })()
  }

  private collectRetired(): void {
    const live = new Set(super.inspectCompositions().map(mount => mount.id))
    for (const [id, revision] of this.revisions) {
      if (revision.retired && revision.requests === 0 && !live.has(id)) this.revisions.delete(id)
    }
  }

  installed(): InstalledProjectsPreset {
    const self = this
    return {
      get id() { return self.defaultId },
      get snapshot() { if (self.snapshot === undefined) throw new Error('PROJECT_NOT_READY'); return self.snapshot },
      close: () => self.closeRevisions(),
    }
  }

  async closeRevisions(): Promise<void> {
    this.stopped = true
    await this.staging
    const failures: unknown[] = [...this.retirementFailures]
    for (const revision of this.revisions.values()) {
      revision.retired = true
      if (revision.requests !== 0) { failures.push(new Error(`Preset revision ${revision.generation} still has ${revision.requests} active request owners`)); continue }
      try { await this.retire(revision) } catch (error) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Project preset revision close was incomplete')
  }
}
