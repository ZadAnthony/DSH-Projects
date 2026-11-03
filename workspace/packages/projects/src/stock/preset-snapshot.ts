import type { Context } from '@deepseek-ai/cordis'
import { Include } from '@deepseek-ai/cordis-plugin-include'
import type { EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import { scopeOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { createHash } from 'node:crypto'
import {
  copyPresetDeclaration, freezePresetSnapshot, ProjectsPresetSnapshotError,
  type ProjectsPresetTreeSnapshot,
} from './presets/codec.ts'

export interface ProjectsPresetSnapshot {
  readonly format: 'projects-preset-snapshot/v1'
  readonly presetId: string
  readonly generation?: string
  readonly tree: ProjectsPresetTreeSnapshot
}

const sourceGenerations = new WeakMap<object, number>()
let nextSourceGeneration = 0

/**
 * Find a detached standing tree through the published Cordis runtime inventory.
 * rc.3 stopped exporting the process-global preset mount set. Loader entries
 * still expose their owning tree; the leased scope key identifies that exact
 * revision without inspecting the native registry's private generations.
 */
export function projectPresetTrees(root: Context, key: ScopeKey): EntryTree[] {
  const trees = new Set<EntryTree>()
  for (const runtime of root.registry.values()) {
    for (const fiber of runtime.fibers) {
      const tree = fiber.entry?.parent.tree
      if (tree === undefined || scopeOf(tree.ctx) !== key) continue
      // Include trees are nested under the same standing scope. Only its root
      // has an owner whose parent context is outside that exact scope.
      if (scopeOf(tree.ctx.fiber.parent) === key) continue
      trees.add(tree)
    }
  }
  return [...trees]
}

/** Known public spellings of the native file Include. */
export function isNativeIncludeName(name: string): boolean {
  return name === 'cordis:include' || name === '@deepseek-ai/cordis-plugin-include'
}

/** Synchronous by design: the lease does not freeze live volatile updates. */
function captureTree(tree: EntryTree, at: string): ProjectsPresetTreeSnapshot {
  const entries = copyPresetDeclaration(tree.root.data, `${at}.entries`)
  const includes: { entryId: string; tree: ProjectsPresetTreeSnapshot }[] = []
  for (const entry of Object.values(tree.store)) {
    if (entry.subtree === undefined) continue
    if (entry.subtree.constructor !== Include) {
      throw new ProjectsPresetSnapshotError(`${at}.${entry.options.id}`,
        'a non-Include plugin owns a subtree; its runtime contribution needs an explicit adapter')
    }
    includes.push({ entryId: entry.options.id, tree: captureTree(entry.subtree, `${at}.${entry.options.id}`) })
  }
  return { baseUrl: tree.ctx.baseUrl, entries, includes }
}

/**
 * Retain the exact selected generation, find its public tree by object key,
 * then copy all declaration trees without an await or another source read.
 * Nothing from the root graph survives in the returned immutable DTO.
 */
export async function captureProjectsPresetSnapshot(root: Context, id?: string): Promise<ProjectsPresetSnapshot> {
  const presetId = id ?? root.agentPresets.defaultId
  const lease = await root.agentPresets.acquireScope(presetId)
  try {
    const matches = projectPresetTrees(root, lease.key)
    let tree: ProjectsPresetTreeSnapshot
    if (matches.length === 1) tree = captureTree(matches[0]!, '$')
    else if (matches.length === 0) {
      // An empty native tree creates no entry fibers. Its public inventory
      // proves there is no declaration to resolve or re-evaluate. A nonempty
      // tree without a discoverable entry must not be guessed from a roster.
      const inventory = await root.agentPresets.compositionInventory()
      const current = await root.agentPresets.acquireScope(presetId)
      try {
        const declaration = inventory.find(preset => preset.id === presetId)
        if (current.key !== lease.key || declaration?.broken !== undefined
          || declaration?.rows.length !== 0) {
          throw new ProjectsPresetSnapshotError('$', `leased preset ${presetId} has no observable public Loader tree; its nonempty declaration cannot be copied exactly`)
        }
        tree = { baseUrl: undefined, entries: [], includes: [] }
      } finally { await current[Symbol.asyncDispose]() }
    } else {
      throw new ProjectsPresetSnapshotError('$', `expected exactly one public Loader tree for leased preset ${presetId}; found ${matches.length}`)
    }
    let sourceGeneration = sourceGenerations.get(lease.key)
    if (sourceGeneration === undefined) sourceGenerations.set(lease.key, sourceGeneration = ++nextSourceGeneration)
    const digest = createHash('sha256').update(JSON.stringify({ presetId, tree })).digest('hex')
    return freezePresetSnapshot({
      format: 'projects-preset-snapshot/v1' as const,
      presetId,
      generation: `${sourceGeneration}:${digest}`,
      tree,
    })
  } finally {
    await lease[Symbol.asyncDispose]()
  }
}
