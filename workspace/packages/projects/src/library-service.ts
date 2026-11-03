import { createHash, randomUUID } from 'node:crypto'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'

import type {
  LibraryAddRequest, LibraryCorePort, LibraryEntry, LibraryEntryRequest, LibraryFailureReason,
  LibraryFileLocation, LibraryListing, LibraryListRequest, LibraryNativeFiles, LibraryOpenRequest,
  LibraryOpenResult, LibraryProjectDeletion, LibraryScope, LibrarySessionRequest, LibraryTarget,
} from './library-contract.ts'
import { LibraryStore } from './library-store.ts'

export interface LibraryServiceOptions {
  readonly store: LibraryStore
  readonly core: LibraryCorePort
  readonly files: LibraryNativeFiles
  readonly now?: () => string
}

/** 文件区直接读原位置；引用索引不保存正文或工作台账。 */
export class LibraryService {
  readonly #now: () => string
  readonly #writes = new Map<string, Set<Promise<unknown>>>()
  readonly #deletions = new Map<string, { committed: boolean; preparation: LibraryProjectDeletion }>()
  constructor(readonly options: LibraryServiceOptions) {
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  /** 同步封本项目入口；已接纳调用连同来源读取和最终保存一起结算。 */
  prepareProjectDeletion(projectId: string): LibraryProjectDeletion {
    const previous = this.#deletions.get(projectId)
    if (previous !== undefined) return previous.preparation
    const drained = Promise.allSettled([...(this.#writes.get(projectId) ?? [])]).then(results => {
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length > 0) throw new AggregateError(errors, 'Library accepted reference writes did not all save')
    })
    // 删除事务先停止其它 owner，再 join；保留原 reject，但不制造等待期间的未处理拒绝。
    void drained.catch(() => {})
    const state = {
      committed: false,
      preparation: {
        drained,
        commit: () => {
          if (this.#deletions.get(projectId) !== state) throw new Error('Library project deletion preparation was released')
          state.committed = true
        },
        release: () => {
          if (!state.committed && this.#deletions.get(projectId) === state) this.#deletions.delete(projectId)
        },
      },
    }
    this.#deletions.set(projectId, state)
    return state.preparation
  }

  async list(request: LibraryListRequest, signal?: AbortSignal): Promise<LibraryListing> {
    signal?.throwIfAborted()
    const scope = await this.#scope(request, signal)
    signal?.throwIfAborted()
    const relativePath = projectRelativePath(request.directory ?? '')
    const [directory, references] = await Promise.allSettled([
      this.options.files.listProjectDirectory({ scope, relativePath, signal }),
      this.options.store.list(scope.projectId),
    ])
    signal?.throwIfAborted()
    return {
      projectFiles: directory.status === 'fulfilled'
        ? { status: 'directory', relativePath, ...directory.value, readAt: this.#now() }
        : { status: 'unavailable', relativePath, reason: failureReason(directory.reason), message: errorMessage(directory.reason), readAt: this.#now() },
      references: references.status === 'fulfilled'
        ? { status: 'ready', entries: references.value }
        : { status: 'unavailable', message: errorMessage(references.reason) },
    }
  }

  async add(request: LibraryAddRequest, signal?: AbortSignal): Promise<LibraryEntry> {
    signal?.throwIfAborted()
    return this.#acceptWrite(request.projectId, async () => {
      const scope = await this.#scope(request, signal)
      const sources = request.sources ?? []
      await this.options.core.verifySources(scope, sources, signal)
      signal?.throwIfAborted()
      this.#assertNotDeleted(scope.projectId)
      const target = normalizeTarget(request.target, scope)
      const now = this.#now()
      const entry: Omit<LibraryEntry, 'sourceLimitations'> = {
        id: randomUUID(), projectId: scope.projectId, name: text(request.name, 'name'),
        description: request.description ?? '', target, ownership: ownership(target, scope),
        addedBySessionId: scope.sessionId, sources, createdAt: now, updatedAt: now,
      }
      const assertWritable = () => { signal?.throwIfAborted(); this.#assertNotDeleted(scope.projectId) }
      return this.options.core.withMetadataWrite(request, scope, sources,
        transaction => this.options.store.upsertWithin(transaction, entry, assertWritable), signal)
    })
  }

  async open(request: LibraryOpenRequest, signal?: AbortSignal): Promise<LibraryOpenResult> {
    signal?.throwIfAborted()
    const scope = await this.#scope(request, signal)
    signal?.throwIfAborted()
    let location: LibraryFileLocation
    let target: LibraryTarget
    let name: string
    if (request.location.kind === 'reference') {
      const entryId = request.location.entryId
      const entry = (await this.options.store.list(scope.projectId)).find(candidate => candidate.id === entryId)
      signal?.throwIfAborted()
      if (entry === undefined) throw new Error('Library reference was not found in this project')
      const relativePath = projectRelativePath(request.location.relativePath ?? '')
      location = { kind: 'reference', entryId: entry.id, ...(relativePath === '' ? {} : { relativePath }) }
      if (relativePath === '') {
        target = entry.target
        name = entry.name
      } else {
        if (entry.target.kind !== 'directory') throw new Error('Only a directory reference has child locations')
        target = { kind: 'file', path: resolve(entry.target.path, relativePath) }
        name = basename(relativePath)
      }
    } else if (request.location.kind === 'project-file') {
      const relativePath = projectRelativePath(request.location.relativePath)
      location = { kind: 'project-file', relativePath }
      target = { kind: relativePath === '' ? 'directory' : 'file', path: resolve(scope.projectFilesRoot, relativePath) }
      name = basename(target.path)
    } else {
      throw new Error('Unsupported Library file location')
    }
    const identity = { location, name, target }
    if (target.kind === 'url') return { ...identity, status: 'url', url: target.url, availability: 'notChecked' }
    const filePath = target.path
    const readDirectory = async (): Promise<LibraryOpenResult> => {
      const listing = location.kind === 'project-file'
        ? await this.options.files.listProjectDirectory({ scope, relativePath: location.relativePath, signal })
        : { absolutePath: filePath, ...await this.options.files.listDirectory({ hostSessionId: scope.hostSessionId, path: filePath, signal }) }
      signal?.throwIfAborted()
      return { ...identity, target: { kind: 'directory', path: listing.absolutePath }, status: 'directory', entries: listing.entries, truncated: listing.truncated, readAt: this.#now() }
    }
    try {
      if (target.kind === 'directory') return await readDirectory()
      let current: Awaited<ReturnType<LibraryNativeFiles['readBytes']>>
      try {
        current = await this.options.files.readBytes({ hostSessionId: scope.hostSessionId, path: filePath, signal })
      } catch (error) {
        // 项目位置与目录引用子项不预存类型；只有宿主明确指出不是普通文件时才读取目录。
        if ((location.kind === 'project-file' || location.relativePath !== undefined) && errorCode(error) === 'workspace-file/not-regular-file') return await readDirectory()
        throw error
      }
      signal?.throwIfAborted()
      const data = Buffer.from(current.data)
      return {
        ...identity, status: 'file', target: { kind: 'file', path: current.absolutePath }, absolutePath: current.absolutePath,
        base64: data.toString('base64'), byteLength: data.byteLength, sha256: createHash('sha256').update(data).digest('hex'),
        mediaType: mediaType(current.absolutePath), readAt: this.#now(),
      }
    } catch (error) {
      signal?.throwIfAborted()
      return { ...identity, status: 'unavailable', reason: failureReason(error), message: errorMessage(error), readAt: this.#now() }
    }
  }

  async remove(request: LibraryEntryRequest, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    return this.#acceptWrite(request.projectId, async () => {
      const scope = await this.#scope(request, signal)
      const assertWritable = () => { signal?.throwIfAborted(); this.#assertNotDeleted(scope.projectId) }
      await this.options.core.withMetadataWrite(request, scope, [],
        transaction => this.options.store.removeWithin(transaction, scope.projectId, request.entryId, assertWritable), signal)
    })
  }

  async #scope(request: LibrarySessionRequest, signal?: AbortSignal): Promise<LibraryScope> {
    signal?.throwIfAborted()
    this.#assertNotDeleted(request.projectId)
    const scope = await this.options.core.resolveScope(request, signal)
    signal?.throwIfAborted()
    if (scope.projectId !== request.projectId || scope.sessionId !== request.sessionId) throw new Error('Library project/session scope mismatch')
    this.#assertNotDeleted(scope.projectId)
    return scope
  }

  #acceptWrite<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    if (this.#deletions.has(projectId)) throw new Error('Library project deletion is in progress')
    const pending = this.#writes.get(projectId) ?? new Set<Promise<unknown>>()
    this.#writes.set(projectId, pending)
    const accepted = Promise.withResolvers<T>()
    pending.add(accepted.promise)
    // 登记责任后同步进入原调用，不把首个归属/source await 留在接纳之外。
    try { Promise.resolve(operation()).then(accepted.resolve, accepted.reject) } catch (error) { accepted.reject(error) }
    const settled = () => {
      pending.delete(accepted.promise)
      if (pending.size === 0) this.#writes.delete(projectId)
    }
    void accepted.promise.then(settled, settled)
    return accepted.promise
  }

  #assertNotDeleted(projectId: string): void {
    if (this.#deletions.get(projectId)?.committed) throw new Error('Library project was permanently deleted')
  }
}

function projectRelativePath(value: string): string {
  if (typeof value !== 'string' || value.includes('\0') || /^[\\/]/.test(value) || isAbsolute(value) || /^[A-Za-z]:/.test(value)) throw new Error('Project file path must be relative')
  const normalized: string[] = []
  for (const part of value.replaceAll('\\', '/').split('/')) {
    if (part === '..') throw new Error('Project file path must stay within the project files directory')
    if (part !== '' && part !== '.') normalized.push(part)
  }
  return normalized.join('/')
}

function normalizeTarget(target: LibraryTarget, scope: LibraryScope): LibraryTarget {
  if (target.kind === 'url') {
    const url = new URL(text(target.url, 'url'))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Invalid Library URL protocol')
    return { kind: 'url', url: url.href }
  }
  if (target.kind !== 'file' && target.kind !== 'directory') throw new Error('Unsupported Library target')
  return { kind: target.kind, path: resolve(scope.workingDirectory, text(target.path, 'path')) }
}

function ownership(target: LibraryTarget, scope: LibraryScope): LibraryEntry['ownership'] {
  if (target.kind === 'url') return 'external'
  if (inside(scope.projectRoot, target.path)) return 'project'
  if (scope.workspaceRoot !== undefined && inside(scope.workspaceRoot, target.path)) return 'workspace'
  return 'external'
}

function inside(root: string, path: string): boolean {
  const child = relative(resolve(root), path)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

function text(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Library ${label} is required`)
  return value.trim()
}

function mediaType(path: string): string {
  return ({ '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json', '.html': 'text/html',
    '.css': 'text/css', '.csv': 'text/csv', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
    '.ts': 'text/plain', '.tsx': 'text/plain', '.js': 'text/plain',
  } as Record<string, string>)[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function errorCode(error: unknown): unknown { return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined }
function failureReason(error: unknown): LibraryFailureReason {
  const code = errorCode(error)
  if (code === 'ENOENT' || code === 'workspace-file/not-found') return 'missing'
  if (code === 'EACCES' || code === 'EPERM' || code === 'FS_PERMISSION_DENIED' || code === 'FS_ACCESS_DENIED' || code === 'workspace-file/forbidden' || code === 'workspace-file/outside-workspace') return 'permissionDenied'
  if (code === 'FS_TOO_LARGE' || code === 'workspace-file/too-large') return 'tooLarge'
  if (code === 'workspace-file/not-regular-file' || code === 'workspace-file/not-directory') return 'unsupported'
  return 'readFailed'
}
