import { readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { decodeNativeProjectSource } from '../../native-source.ts'
import { withRootWriteLock, writeFileDurable, type RootWriteScope } from '../../metadata-files.ts'

import type { OverviewBlockInput, OverviewDocument, OverviewDocumentRead, OverviewSourceRef } from './contract.ts'

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
const nonempty = z.string().trim().min(1)
const native = z.unknown().transform((value, ctx) => {
  try { return decodeNativeProjectSource(value) }
  catch (error) { ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) }); return z.NEVER }
})
const location = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project-file'), relativePath: nonempty }).strict(),
  z.object({ kind: z.literal('reference'), entryId: nonempty }).strict(),
])
const source = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('native'), source: native }).strict(),
  z.object({ kind: z.literal('library'), location }).strict(),
  z.object({ kind: z.literal('session'), id: nonempty }).strict(),
  z.object({ kind: z.literal('memory'), topicId: nonempty }).strict(),
])
const content = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('list'), items: z.array(z.string()) }).strict(),
  z.object({ type: z.literal('table'), columns: z.array(nonempty), rows: z.array(z.array(z.string())) }).strict()
    .refine(value => value.rows.every(row => row.length === value.columns.length), 'Table rows must match columns'),
])
const inputSchema = z.object({ id, title: nonempty, summary: z.string().optional(), content, sources: z.array(source) }).strict()
const blockSchema = inputSchema.extend({ updatedAt: z.iso.datetime(), updatedBySessionId: nonempty })
const documentSchema = z.object({
  schemaVersion: z.literal(2), projectId: id, blocks: z.array(blockSchema),
  updatedAt: z.iso.datetime().optional(), updatedBySessionId: nonempty.optional(),
}).strict()
  .refine(value => new Set(value.blocks.map(block => block.id)).size === value.blocks.length, 'Duplicate overview block id')
  .refine(value => (value.updatedAt === undefined) === (value.updatedBySessionId === undefined), 'Update time and session must be paired')

export function parseOverviewBlock(input: OverviewBlockInput): OverviewBlockInput { return inputSchema.parse(input) }
export function parseOverviewSource(input: OverviewSourceRef): OverviewSourceRef { return source.parse(input) }

/** 当前正文的完整读改写共用 Core 的跨进程元数据事务；普通读取无锁。 */
export class OverviewStore {
  #tail: Promise<void> = Promise.resolve()
  constructor(readonly dataRoot: string) {}

  async read(projectId: string): Promise<OverviewDocument> { return (await this.#read(projectId)).document }

  readState(projectId: string): Promise<OverviewDocumentRead> { return this.#read(projectId) }

  update(projectId: string, transform: (current: OverviewDocument) => OverviewDocument): Promise<OverviewDocument> {
    return this.#serial(() => withRootWriteLock({ root: this.dataRoot, anchor: '.metadata.lock' },
      scope => this.updateWithin(scope, projectId, transform)))
  }

  async updateWithin(scope: RootWriteScope, projectId: string, transform: (current: OverviewDocument) => OverviewDocument): Promise<OverviewDocument> {
    await this.#assertScope(scope)
    // Core owns the project directory; a missing project must never be recreated.
    if (!(await stat(join(this.dataRoot, id.parse(projectId)))).isDirectory()) throw new Error('Overview project path is not a directory')
    const next = documentSchema.parse(transform((await this.#read(projectId)).document))
    if (next.projectId !== projectId) throw new Error('Overview update cannot change its project')
    await this.#assertScope(scope)
    await writeFileDurable(this.#path(projectId), JSON.stringify(next, null, 2) + '\n')
    return next
  }

  async #assertScope(scope: RootWriteScope): Promise<void> {
    await scope.assertCurrent()
    if (scope.root !== await realpath(this.dataRoot)) throw new Error('Overview metadata scope belongs to another owner root')
  }

  async #read(projectId: string): Promise<OverviewDocumentRead> {
    let raw: string
    try { raw = await readFile(this.#path(projectId), 'utf8') } catch (error) {
      if (hasCode(error, 'ENOENT')) return { status: 'missing', document: { schemaVersion: 2, projectId, blocks: [] } }
      throw error
    }
    const document = documentSchema.parse(JSON.parse(raw))
    if (document.projectId !== projectId) throw new Error('Overview belongs to another project')
    return { status: 'available', document }
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation)
    this.#tail = next.then(() => {}, () => {})
    return next
  }

  #path(projectId: string): string { return join(this.dataRoot, id.parse(projectId), 'overview.json') }

}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
