import { join, resolve } from 'node:path'

/** One new-format home; domain stores all use the records root beneath it. */
export interface ProjectPaths {
  readonly dataRoot: string
  readonly recordsRoot: string
  project(projectId: string): string
}

export function createProjectPaths(dataRoot: string): ProjectPaths {
  const home = resolve(dataRoot)
  const recordsRoot = join(home, 'projects')
  return Object.freeze({ dataRoot: home, recordsRoot, project: (id: string) => join(recordsRoot, id) })
}
