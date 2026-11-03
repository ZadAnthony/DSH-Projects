import { Context, resolveConfig, type Fiber } from '@deepseek-ai/cordis'
import { EntryTree, interpolate, type Entry, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { volatileEntries } from '@deepseek-ai/cosmokit'
import { auditRows } from '@deepseek-ai/dsh-agent-preset-registry'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { copyPresetDeclaration, freezePresetSnapshot } from './codec.ts'
import { ProjectsPresetLoader, type ProjectsModuleOverrides } from './loader.ts'

/**
 * Host-plane native capabilities used by the stock standard preset. This list
 * selects declarations, never root instances. AgentLoop, ordinary persistence,
 * Goal, settings writers, transport listeners and credential writers are absent.
 */
const FOUNDATION_MODULES = new Set([
  '@deepseek-ai/cordis-plugin-timer',
  '@deepseek-ai/dsh-user-questions', '@deepseek-ai/dsh-jobs-local', '@deepseek-ai/dsh-llm-retry',
  '@deepseek-ai/dsh-session-title', '@deepseek-ai/dsh-session-title-first-prompt-llm', '@deepseek-ai/dsh-session-title-all-prompts-llm',
  '@deepseek-ai/dsh-storage', '@deepseek-ai/dsh-storage-json', '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-subprocess-local', '@deepseek-ai/dsh-sandbox-local', '@deepseek-ai/dsh-sandbox-policy',
  '@deepseek-ai/dsh-bash-sandbox', '@deepseek-ai/dsh-pwsh-sandbox', '@deepseek-ai/dsh-shell-env',
  '@deepseek-ai/dsh-user-approval', '@deepseek-ai/dsh-permission-presets',
  '@deepseek-ai/dsh-fs-observation-policy', '@deepseek-ai/dsh-fs-sandbox',
  '@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-commands', '@deepseek-ai/dsh-token-meter',
  '@deepseek-ai/dsh-subagent', '@deepseek-ai/dsh-subagent-spawn-in-process', '@deepseek-ai/dsh-subagent-fork-in-process',
  '@deepseek-ai/dsh-tool-subagent/model-selection-settings',
  '@deepseek-ai/dsh-ptc-runtime-node', '@deepseek-ai/dsh-tool-call-timeout-policy',
  '@deepseek-ai/dsh-spill-local', '@deepseek-ai/dsh-spill-policy',
  '@deepseek-ai/dsh-session-checkpoint-policy', '@deepseek-ai/dsh-compaction-image-offload',
  '@deepseek-ai/dsh-repeat-tool-reminder', '@deepseek-ai/dsh-web',
  '@deepseek-ai/dsh-workspace-changes',
  '@deepseek-ai/dsh-session-reference', '@deepseek-ai/dsh-file-reference-local',
  '@deepseek-ai/dsh-working-directory',
  '@deepseek-ai/dsh-web-search-deepseek', '@deepseek-ai/dsh-web-fetch-http', '@deepseek-ai/dsh-mcp-resources',
])

export function isProjectsNativeFoundationModule(name: string): boolean { return FOUNDATION_MODULES.has(name) }

interface FoundationDeclaration {
  readonly baseUrl: string | undefined
  readonly row: EntryOptions
}

export interface ProjectsNativeFoundationSnapshot {
  readonly format: 'projects-native-foundations/v1'
  readonly declarations: readonly FoundationDeclaration[]
}

/** Copy the live host Loader declaration once, before returning to async work. */
export function captureProjectsNativeFoundations(root: Context): ProjectsNativeFoundationSnapshot {
  const declarations: FoundationDeclaration[] = []
  const seen = new Set<string>()
  for (const entry of root.loader.entries()) {
    if (!FOUNDATION_MODULES.has(entry.options.name) || entry.disabled) continue
    if (seen.has(entry.options.name)) throw new Error(`PROJECT_FOUNDATION_AMBIGUOUS: multiple host declarations for ${entry.options.name}`)
    seen.add(entry.options.name)
    if (entry.options.name === '@deepseek-ai/dsh-web-search-deepseek'
      && typeof entry.options.config?.apiKey === 'string' && entry.options.config.apiKey.length > 0) {
      throw new Error('PROJECT_HOST_SECRET_CONFIGURATION_UNSUPPORTED: web-search literal API keys cannot be copied; use the root credential-reference owner')
    }
    declarations.push({
      baseUrl: entry.parent.tree.ctx.baseUrl,
      row: copyPresetDeclaration(entry.options, `host.${entry.id}`),
    })
  }
  for (const required of ['@deepseek-ai/dsh-sandbox-policy', '@deepseek-ai/dsh-user-approval', '@deepseek-ai/dsh-fs-sandbox']) {
    if (!seen.has(required)) throw new Error(`PROJECT_FOUNDATION_UNAVAILABLE: actual host declaration ${required} is required; no permission fallback is selected`)
  }
  return freezePresetSnapshot({ format: 'projects-native-foundations/v1' as const, declarations })
}

class ProjectsFoundationTree extends EntryTree {
  override write(): void {}
}

export interface InstalledProjectsNativeFoundations {
  readonly modules: readonly string[]
  /** Called after UI foundations have also been registered. */
  ready(): Promise<void>
  prepareRefresh(snapshot: ProjectsNativeFoundationSnapshot): Promise<ProjectsFoundationRefresh>
  /** Native disposers abort and await actual queued/active title generation. */
  closeTitles(): Promise<void>
  /** Stop/drain real background producers before factory writer barriers. */
  close(): Promise<void>
}

export interface ProjectsFoundationRefresh {
  readonly generation: string
  readonly changed: boolean
  commit(): Promise<void>
  rollback(): Promise<void>
}

/** Normalize only public native Volatile leaves; every other field must match. */
function constructorConfiguration(config: unknown): unknown {
  const paths = new Set(volatileEntries(config).map(({ path }) => JSON.stringify(path)))
  const project = (value: unknown, path: string[]): unknown => {
    if (paths.has(JSON.stringify(path))) return { projectsVolatileLeaf: true }
    if (Array.isArray(value)) return value.map((item, index) => project(item, [...path, String(index)]))
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, project(item, [...path, key])]))
    return value
  }
  return project(config, [])
}

const PRODUCERS = new Set([
  // Native title providers' disposers abort and drain registration.active;
  // the service disposer aborts its lifetime and drains all inFlight work.
  '@deepseek-ai/dsh-session-title-first-prompt-llm', '@deepseek-ai/dsh-session-title-all-prompts-llm', '@deepseek-ai/dsh-session-title',
  '@deepseek-ai/dsh-workspace-changes',
  '@deepseek-ai/dsh-subagent', '@deepseek-ai/dsh-ptc-runtime-node',
  '@deepseek-ai/dsh-jobs-local', '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-working-directory',
])

/**
 * Re-import selected native modules from their declaration baseUrl. Original
 * sandbox/approval/filter/timeout configs stay intact. Only plugin-owned data
 * homes are redirected, so no ordinary storage or spill directory is opened.
 */
export async function installProjectsNativeFoundations(
  ctx: Context,
  options: { readonly dataRoot: string; readonly snapshot: ProjectsNativeFoundationSnapshot; readonly moduleOverrides?: ProjectsModuleOverrides },
): Promise<InstalledProjectsNativeFoundations> {
  const loader = ctx.loader as ProjectsPresetLoader
  if (options.moduleOverrides !== undefined) loader.setModuleOverrides(options.moduleOverrides)
  const trees: ProjectsFoundationTree[] = []
  const entries = new Map<string, { declaration: FoundationDeclaration; entry: Entry }>()
  const producers: { name: string; fiber: Fiber }[] = []
  await Promise.all(options.snapshot.declarations.map(async (declaration) => {
    const row = copyPresetDeclaration(declaration.row)
    const sourceModule = row.name
    if (row.name === '@deepseek-ai/dsh-storage-json') {
      row.config = { ...row.config, root: join(options.dataRoot, 'native-storage') }
    }
    if (row.name === '@deepseek-ai/dsh-spill-local') {
      row.config = { ...row.config, root: join(options.dataRoot, 'native-spills') }
    }
    if (loader.moduleName(sourceModule) !== sourceModule) {
      row.name = loader.moduleName(sourceModule)
      Object.assign(row, { projectsSourceModule: sourceModule })
    }
    const tree = new ProjectsFoundationTree(ctx.extend({ baseUrl: declaration.baseUrl }))
    trees.push(tree)
    await tree.root.update([row])
    if (tree.store[row.id] !== undefined) entries.set(sourceModule, { declaration, entry: tree.store[row.id]! })
    const fiber = tree.store[row.id]?.fiber
    if (fiber !== undefined && PRODUCERS.has(sourceModule)) producers.push({ name: sourceModule, fiber })
  }))
  let closing: Promise<void> | undefined
  let closingTitles: Promise<void> | undefined
  let activeSnapshot = options.snapshot
  // The installed snapshot already owns these exact immutable declarations.
  // Keep its comparison encoding beside it; every refresh still captures and
  // serializes the current host declarations before comparing them.
  let activeEncoding = JSON.stringify(activeSnapshot)
  let activeGeneration = createHash('sha256').update(activeEncoding).digest('hex')
  const closeTitles = () => closingTitles ??= (async () => {
    const failures: unknown[] = []
    for (const producer of producers.filter(candidate => candidate.name.includes('dsh-session-title'))) {
      try { await producer.fiber.dispose() } catch (error) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Projects native title work did not drain')
  })()
  return {
    modules: options.snapshot.declarations.map(declaration => declaration.row.name),
    async ready() {
      const diagnostics = await Promise.all(trees.map(tree => auditRows(tree)))
      const failures = diagnostics.flatMap(audit => [...audit.failed, ...audit.pending])
      if (failures.length > 0) throw new Error(`PROJECT_FOUNDATION_NOT_READY:\n${failures.join('\n')}`)
    },
    async prepareRefresh(snapshot) {
      if (closing !== undefined) throw new Error('PROJECT_CLOSING: native foundations are closing')
      const encoding = JSON.stringify(snapshot)
      if (encoding === activeEncoding) {
        return { generation: activeGeneration, changed: false, commit: async () => {}, rollback: async () => {} }
      }
      const generation = createHash('sha256').update(encoding).digest('hex')
      const oldByModule = new Map(activeSnapshot.declarations.map(item => [item.row.name, item]))
      const nextByModule = new Map(snapshot.declarations.map(item => [item.row.name, item]))
      if (oldByModule.size !== nextByModule.size || [...oldByModule.keys()].some(name => !nextByModule.has(name))) {
        throw new Error('PROJECT_RUNTIME_CONFIGURATION_REQUIRES_RELOAD: native foundation provider membership changed')
      }
      const updates: { entry: Entry; previous: unknown; next: unknown }[] = []
      for (const [name, declaration] of nextByModule) {
        const previous = oldByModule.get(name)!
        if (JSON.stringify(previous) === JSON.stringify(declaration)) continue
        const record = entries.get(name)
        const fiber = record?.entry.fiber
        if (record === undefined || fiber?.runtime == null) throw new Error(`PROJECT_FOUNDATION_NOT_READY: ${name}`)
        if (declaration.baseUrl !== previous.baseUrl
          || JSON.stringify({ ...declaration.row, config: undefined }) !== JSON.stringify({ ...previous.row, config: undefined })) {
          throw new Error(`PROJECT_RUNTIME_CONFIGURATION_REQUIRES_RELOAD: ${name} loader identity or activation options changed`)
        }
        let next = copyPresetDeclaration(declaration.row.config)
        // These two directories belong to this graph, including on refresh.
        if (name === '@deepseek-ai/dsh-storage-json') next = { ...(next as object), root: join(options.dataRoot, 'native-storage') }
        if (name === '@deepseek-ai/dsh-spill-local') next = { ...(next as object), root: join(options.dataRoot, 'native-spills') }
        const candidate = resolveConfig(fiber.runtime, interpolate(record.entry.ctx, next))
        if (JSON.stringify(constructorConfiguration(fiber.config)) !== JSON.stringify(constructorConfiguration(candidate))) {
          throw new Error(`PROJECT_RUNTIME_CONFIGURATION_REQUIRES_RELOAD: ${name} changed a constructor-owned field; only native Volatile values can update in place`)
        }
        updates.push({ entry: record.entry, previous: copyPresetDeclaration(record.entry.options.config), next })
      }
      let committed = false
      const before = activeSnapshot
      const beforeEncoding = activeEncoding
      const beforeGeneration = activeGeneration
      return {
        generation, changed: true,
        async commit() {
          if (committed) return
          committed = true
          // Native volatile commits run synchronously up to their returned
          // promises. All validated updates happen before yielding the turn.
          await Promise.all(updates.map(update => update.entry.update({ config: update.next })))
          activeSnapshot = snapshot
          activeEncoding = encoding
          activeGeneration = generation
        },
        async rollback() {
          if (!committed) return
          await Promise.all(updates.map(update => update.entry.update({ config: update.previous })))
          activeSnapshot = before
          activeEncoding = beforeEncoding
          activeGeneration = beforeGeneration
          committed = false
        },
      }
    },
    closeTitles,
    close: () => closing ??= (async () => {
      const failures: unknown[] = []
      for (const name of PRODUCERS) {
        for (const producer of producers.filter(candidate => candidate.name === name)) {
          try { await producer.fiber.dispose() } catch (error) { failures.push(error) }
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'Projects native producers failed to close')
    })(),
  }
}
