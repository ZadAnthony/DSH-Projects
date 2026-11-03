import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'

/** A detached copy of the effective declaration of one live Loader tree. */
export interface ProjectsPresetTreeSnapshot {
  readonly baseUrl: string | undefined
  readonly entries: readonly EntryOptions[]
  readonly includes: readonly {
    readonly entryId: string
    readonly tree: ProjectsPresetTreeSnapshot
  }[]
}

export class ProjectsPresetSnapshotError extends Error {
  readonly code = 'PROJECT_PRESET_SNAPSHOT_UNSUPPORTED'

  constructor(readonly at: string, detail: string) {
    super(`Cannot snapshot preset declaration at ${at}: ${detail}`)
    this.name = 'ProjectsPresetSnapshotError'
  }
}

/**
 * Copy declaration data, without invoking getters, to another runtime.
 * Contexts, volatile references, callbacks and service instances are deliberately
 * refused. A Loader !!js node remains an expression, evaluated in the new graph.
 */
export function copyPresetDeclaration<T>(value: T, at = '$'): T {
  const ancestors = new Set<object>()
  const copy = (source: unknown, path: string): unknown => {
    if (source === null || source === undefined || typeof source === 'string'
      || typeof source === 'boolean') return source
    if (typeof source === 'number') {
      if (!Number.isFinite(source)) throw new ProjectsPresetSnapshotError(path, 'non-finite number')
      return source
    }
    if (typeof source !== 'object') {
      throw new ProjectsPresetSnapshotError(path, `${typeof source} is a runtime value, not declaration data`)
    }
    if (ancestors.has(source)) throw new ProjectsPresetSnapshotError(path, 'cyclic declaration')
    const prototype = Object.getPrototypeOf(source)
    if (!Array.isArray(source) && prototype !== Object.prototype && prototype !== null) {
      throw new ProjectsPresetSnapshotError(path, 'Context, fiber, service or other non-plain runtime object')
    }
    ancestors.add(source)
    try {
      const result: Record<string, unknown> | unknown[] = Array.isArray(source)
        ? new Array(source.length)
        : Object.create(prototype)
      for (const key of Reflect.ownKeys(source)) {
        if (Array.isArray(source) && key === 'length') continue
        if (typeof key !== 'string') throw new ProjectsPresetSnapshotError(path, 'symbol-keyed runtime metadata')
        const descriptor = Object.getOwnPropertyDescriptor(source, key)!
        if (!('value' in descriptor)) throw new ProjectsPresetSnapshotError(`${path}.${key}`, 'accessor-backed runtime value')
        Object.defineProperty(result, key, {
          value: copy(descriptor.value, `${path}.${key}`), enumerable: descriptor.enumerable,
          writable: true, configurable: true,
        })
      }
      if (Object.hasOwn(source, '__jsExpr') && typeof (result as { __jsExpr?: unknown }).__jsExpr !== 'string') {
        throw new ProjectsPresetSnapshotError(path, 'invalid !!js expression node')
      }
      return result
    } finally {
      ancestors.delete(source)
    }
  }
  return copy(value, at) as T
}

export function freezePresetSnapshot<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezePresetSnapshot(child)
    Object.freeze(value)
  }
  return value
}
