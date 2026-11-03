import { readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { decodeNativeProjectSource, nativeProjectSourceKey } from './native-source.ts'
import { ensureDirectoryDurable, withRootWriteLock, writeFileDurable, type RootWriteScope } from './metadata-files.ts'

import type { NativeProjectSource } from './source-reader.ts'
import type { LibraryEntry } from './library-contract.ts'

const nativeSource = z.unknown().transform((value, ctx) => {
  try { return decodeNativeProjectSource(value) }
  catch (error) { ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) }); return z.NEVER }
})
const target = z.union([
  z.object({ kind: z.enum(['file', 'directory']), path: z.string().min(1) }),
  z.object({ kind: z.literal('url'), url: z.url() }),
])
const fields = {
  id: z.string().min(1), projectId: z.string().min(1), name: z.string().min(1),
  description: z.string(), target,
  ownership: z.enum(['project', 'workspace', 'external']), addedBySessionId: z.string().min(1),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
} as const
const currentEntry = z.object({ ...fields, sources: z.array(nativeSource) }).strict()
// 旧业务字段只在私有封套保留，不参与文件关联验证或当前 DTO。
const persistedTarget = z.union([
  z.object({ kind: z.enum(['file', 'directory']), path: z.string().min(1) }).passthrough(),
  z.object({ kind: z.literal('url'), url: z.url() }).passthrough(),
])
const persistedEntry = z.object({ ...fields, target: persistedTarget, sources: z.array(z.unknown()) }).passthrough()
const catalogSchema = z.object({ version: z.union([z.literal(1), z.literal(2)]), entries: z.array(persistedEntry) }).passthrough()
type Catalog = z.infer<typeof catalogSchema>
type PersistedEntry = z.infer<typeof persistedEntry>

/** 引用 owner 的完整读改写共用 Core 的跨进程元数据事务；不保存原件正文。 */
export class LibraryStore {
  readonly #tails = new Map<string, Promise<void>>()
  constructor(readonly dataRoot: string) {}

  async list(projectId: string): Promise<readonly LibraryEntry[]> {
    return (await this.#read(projectId)).entries
  }

  upsert(entry: Omit<LibraryEntry, 'sourceLimitations'>, assertWritable: () => void = () => {}): Promise<LibraryEntry> {
    return this.#serial(entry.projectId, () => withRootWriteLock({ root: this.dataRoot, anchor: '.metadata.lock' },
      scope => this.upsertWithin(scope, entry, assertWritable)))
  }

  async upsertWithin(scope: RootWriteScope, entry: Omit<LibraryEntry, 'sourceLimitations'>, assertWritable: () => void = () => {}): Promise<LibraryEntry> {
    await this.#assertScope(scope)
    const parsed = currentEntry.parse(entry)
    assertWritable()
    const { catalog } = await this.#read(parsed.projectId)
    const previous = catalog.entries.find(candidate => targetIdentity(candidate) === targetIdentity(parsed))
    if (previous === undefined && catalog.entries.some(candidate => candidate.id === parsed.id)) throw new Error('Duplicate Library reference id')
    const next: PersistedEntry = {
      ...previous, ...parsed,
      target: { ...previous?.target, ...parsed.target },
      id: previous?.id ?? parsed.id,
      addedBySessionId: previous?.addedBySessionId ?? parsed.addedBySessionId,
      createdAt: previous?.createdAt ?? parsed.createdAt,
      sources: uniqueSources([...(previous?.sources ?? []), ...parsed.sources]),
    }
    await this.#write(scope, parsed.projectId, {
      ...catalog,
      entries: previous === undefined ? [...catalog.entries, next] : catalog.entries.map(candidate => candidate.id === previous.id ? next : candidate),
    }, assertWritable)
    return projectEntry(next)
  }

  /** 用户移除的仅是指定入口；其余条目/扩展原值保持，不删除原件。 */
  remove(projectId: string, entryId: string, assertWritable: () => void = () => {}): Promise<void> {
    return this.#serial(projectId, () => withRootWriteLock({ root: this.dataRoot, anchor: '.metadata.lock' },
      scope => this.removeWithin(scope, projectId, entryId, assertWritable)))
  }

  async removeWithin(scope: RootWriteScope, projectId: string, entryId: string, assertWritable: () => void = () => {}): Promise<void> {
    await this.#assertScope(scope)
    assertWritable()
    const { catalog } = await this.#read(projectId)
    if (!catalog.entries.some(entry => entry.id === entryId)) throw new Error('Library reference was not found')
    await this.#write(scope, projectId, { ...catalog, entries: catalog.entries.filter(entry => entry.id !== entryId) }, assertWritable)
  }

  async #read(projectId: string): Promise<{ readonly catalog: Catalog; readonly entries: readonly LibraryEntry[] }> {
    let raw: string
    try { raw = await readFile(this.#path(projectId), 'utf8') } catch (error) {
      if (hasCode(error, 'ENOENT')) return { catalog: { version: 2, entries: [] }, entries: [] }
      throw error
    }
    const catalog = catalogSchema.parse(JSON.parse(raw))
    if (catalog.entries.some(entry => entry.projectId !== projectId)) throw new Error('Library reference belongs to another project')
    if (new Set(catalog.entries.map(entry => entry.id)).size !== catalog.entries.length) throw new Error('Duplicate Library reference id')
    // 损坏的 native locator 不能伪装成有效来源；退休间接来源只保留限制说明。
    const entries = catalog.entries.map(projectEntry)
    return { catalog, entries }
  }

  async #write(scope: RootWriteScope, projectId: string, catalog: Catalog, assertWritable: () => void): Promise<void> {
    assertWritable()
    const projectDirectory = join(this.dataRoot, directoryId(projectId))
    // Core owns project creation: only an existing project's Library child may be created.
    if (!(await stat(projectDirectory)).isDirectory()) throw new Error('Library project path is not a directory')
    await ensureDirectoryDurable(join(projectDirectory, 'library'))
    await this.#assertScope(scope)
    assertWritable()
    await writeFileDurable(this.#path(projectId), `${JSON.stringify(catalog, null, 2)}\n`, { beforePublish: assertWritable })
  }

  async #assertScope(scope: RootWriteScope): Promise<void> {
    await scope.assertCurrent()
    if (scope.root !== await realpath(this.dataRoot)) throw new Error('Library metadata scope belongs to another owner root')
  }

  #serial<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.#tails.get(projectId) ?? Promise.resolve()).then(operation)
    const tail = next.then(() => {}, () => {})
    this.#tails.set(projectId, tail)
    void tail.then(() => { if (this.#tails.get(projectId) === tail) this.#tails.delete(projectId) })
    return next
  }

  #path(projectId: string): string { return join(this.dataRoot, directoryId(projectId), 'library', 'references.json') }
}

function projectEntry(entry: PersistedEntry): LibraryEntry {
  const sources: NativeProjectSource[] = []
  let hasLegacySource = false
  for (const value of entry.sources) {
    if (typeof value === 'object' && value !== null && 'kind' in value && (value.kind === 'message' || value.kind === 'tool' || value.kind === 'native-event')) sources.push(readPersistedNativeSource(value))
    else hasLegacySource = true
  }
  return {
    id: entry.id, projectId: entry.projectId, name: entry.name, description: entry.description,
    target: entry.target.kind === 'url' ? { kind: 'url', url: entry.target.url } : { kind: entry.target.kind, path: entry.target.path }, ownership: entry.ownership,
    addedBySessionId: entry.addedBySessionId, sources,
    ...(hasLegacySource ? { sourceLimitations: ['此引用含历史间接来源，无法由它直接定位原聊天。'] } : {}),
    createdAt: entry.createdAt, updatedAt: entry.updatedAt,
  }
}

function directoryId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error('Invalid Library project id')
  return id
}
function targetIdentity(entry: Pick<LibraryEntry, 'target'>): string {
  return entry.target.kind === 'url' ? `url:${entry.target.url}` : `${entry.target.kind}:${entry.target.path}`
}
function uniqueSources(sources: readonly unknown[]): unknown[] {
  const unique = new Map<string, unknown>()
  for (const source of sources) {
    let key: string
    try { key = nativeProjectSourceKey(readPersistedNativeSource(source)) } catch { key = JSON.stringify(source) }
    if (!unique.has(key)) unique.set(key, source)
  }
  return [...unique.values()]
}
function hasCode(error: unknown, code: string): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === code }

/** Legacy envelopes retain unknown fields on disk; their public locator projects only its historical contract. */
function readPersistedNativeSource(value: unknown): NativeProjectSource {
  if (typeof value === 'object' && value !== null && 'kind' in value) {
    const raw = value as Record<string, unknown>
    if (raw.kind === 'message') return decodeNativeProjectSource({ kind: raw.kind, hostSessionId: raw.hostSessionId, messageId: raw.messageId })
    if (raw.kind === 'tool') return decodeNativeProjectSource({ kind: raw.kind, hostSessionId: raw.hostSessionId, toolCallId: raw.toolCallId })
  }
  return decodeNativeProjectSource(value)
}
