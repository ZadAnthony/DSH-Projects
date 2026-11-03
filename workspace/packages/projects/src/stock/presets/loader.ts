import { Context, Service, type Plugin } from '@deepseek-ai/cordis'
import { EntryGroup, EntryTree, Group, Loader, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { ProjectsPresetSnapshot } from '../preset-snapshot.ts'
import { isNativeIncludeName } from '../preset-snapshot.ts'
import { copyPresetDeclaration, type ProjectsPresetTreeSnapshot } from './codec.ts'

export const PROJECTS_SNAPSHOT_INCLUDE = 'projects-snapshot-include'
export type ProjectsModuleOverrides = ReadonlyMap<string, Plugin>

/** Confirmed Projects product policy: Goal is withdrawn; old facts stay readable. */
export const PROJECTS_WITHDRAWN_GOAL_MODULES: ReadonlySet<string> = new Set([
  '@deepseek-ai/dsh-goal', '@deepseek-ai/dsh-goal-round-driver',
  '@deepseek-ai/dsh-tool-goal', '@deepseek-ai/dsh-command-goal',
])

interface ProjectsSnapshotIncludeConfig {
  /** The original Include declaration, retained for diagnostics; never opened. */
  readonly source: unknown
  readonly sourceName: string
  readonly tree?: ProjectsPresetTreeSnapshot
}

/**
 * Re-create native Include's tree-carrier behavior with an in-memory tree.
 * No file I/O, refresh watcher, or writer is attached to the source file.
 * The snapshot already contains Include's effective, patched declaration.
 */
export class ProjectsSnapshotInclude extends EntryTree {
  static inject = ['loader']
  static readonly [EntryGroup.key] = true

  constructor(ctx: Context, readonly config: ProjectsSnapshotIncludeConfig) {
    super(ctx)
    if (config.tree === undefined) {
      throw new Error('PROJECT_PRESET_SNAPSHOT_UNAVAILABLE: the Include had no mounted source tree when captured')
    }
    this.ctx.baseUrl = config.tree.baseUrl
  }

  async* [Service.init]() {
    yield () => this.root.stop()
    await this.root.update(materializeSnapshotTree(this.config.tree!, this.ctx.loader as ProjectsPresetLoader))
  }

  override write(): void {}
}

/** A distinct Group plugin owned and registered by this graph's Loader. */
export class ProjectsSnapshotGroup extends Group {}

export class ProjectsPresetLoader extends Loader {
  private readonly overrides = new Map<string, { plugin: Plugin; builtin: string }>()
  constructor(ctx: Context, config: Loader.Config = {}) {
    super(ctx, config)
    this.builtins.group = ProjectsSnapshotGroup
    this.builtins[PROJECTS_SNAPSHOT_INCLUDE] = ProjectsSnapshotInclude
    // A declaration cannot accidentally reach the file-backed writer.
    this.builtins.include = ProjectsSnapshotInclude
  }

  /** Context-local choices for explicitly owned native subclasses. */
  setModuleOverrides(overrides: ProjectsModuleOverrides): void {
    for (const [name, plugin] of overrides) {
      const previous = this.overrides.get(name)
      if (previous !== undefined) {
        if (previous.plugin !== plugin) throw new Error(`PROJECT_MODULE_OVERRIDE_CONFLICT: ${name} already has an owner`)
        continue
      }
      const builtin = `projects-owned-${this.overrides.size}`
      this.builtins[builtin] = plugin
      this.overrides.set(name, { plugin, builtin })
    }
  }

  moduleName(name: string): string { return this.overrides.has(name) ? `cordis:${this.overrides.get(name)!.builtin}` : name }
}

/** Clone again: native Loader assigns ids and edits its own declaration copy. */
export function materializeSnapshotTree(tree: ProjectsPresetTreeSnapshot, loader?: ProjectsPresetLoader): EntryOptions[] {
  const includes = new Map(tree.includes.map(include => [include.entryId, include.tree]))
  const visit = (rows: readonly EntryOptions[]): EntryOptions[] => rows.map((row) => {
    const result = copyPresetDeclaration(row)
    if (PROJECTS_WITHDRAWN_GOAL_MODULES.has(row.name)) {
      // Retain the declaration in the snapshot. The explicit Projects policy
      // is applied only to its runnable copy; root retains the original row.
      result.disabled = true
    }
    const included = includes.get(row.id)
    if (included !== undefined || isNativeIncludeName(row.name)) {
      result.name = `cordis:${PROJECTS_SNAPSHOT_INCLUDE}`
      result.config = { sourceName: row.name, source: copyPresetDeclaration(row.config), tree: included }
    } else if (row.group === true && Array.isArray(row.config)) {
      result.config = visit(row.config)
    } else if (loader !== undefined && loader.moduleName(row.name) !== row.name) {
      // The source declaration remains in the immutable snapshot. This private
      // runnable row resolves an explicitly selected subclass through Loader.
      result.name = loader.moduleName(row.name)
      Object.assign(result, { projectsSourceModule: row.name })
    }
    return result
  })
  return visit(tree.entries)
}

export interface InstalledProjectsPreset {
  readonly id: string
  readonly snapshot: ProjectsPresetSnapshot
  close(): Promise<void>
}

/** Uses the real public register → activate → mount → EntryTree.import chain. */
export async function installProjectsPresetSnapshot(
  ctx: Context,
  snapshot: ProjectsPresetSnapshot,
): Promise<InstalledProjectsPreset> {
  const declaring = ctx.extend({ baseUrl: snapshot.tree.baseUrl })
  const unregister = await declaring.agentPresets.register({
    id: snapshot.presetId,
    plugins: materializeSnapshotTree(snapshot.tree, ctx.loader as ProjectsPresetLoader),
  })
  try {
    const state = await declaring.agentPresets.resolve(snapshot.presetId)
    if (state.broken !== undefined) throw new Error(`PROJECT_PRESET_NOT_READY: ${state.broken}`)
    // Retain the revision independently of the root lease and of any Agent.
    const lease = await declaring.agentPresets.acquireScope(snapshot.presetId)
    let closed: Promise<void> | undefined
    return {
      id: snapshot.presetId,
      snapshot,
      close: () => closed ??= (async () => {
        await unregister()
        await lease[Symbol.asyncDispose]()
      })(),
    }
  } catch (error) {
    await unregister()
    throw error
  }
}
