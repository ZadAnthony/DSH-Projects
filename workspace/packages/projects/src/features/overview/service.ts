import type {
  OverviewAccess, OverviewBlockInput, OverviewContext, OverviewCorePort, OverviewDocument,
  OverviewOwnerRead, OverviewRequest, OverviewRuntimeFact,
  OverviewSourceRef, OverviewSourceView, OverviewView,
} from './contract.ts'
import { isDeepStrictEqual } from 'node:util'
import { currentSource, sourceIdentity, unavailableSource } from './sources.ts'
import { OverviewStore, parseOverviewBlock, parseOverviewSource } from './store.ts'

type OverviewWriterAccess = OverviewAccess & { readonly actor: Extract<OverviewAccess['actor'], { kind: 'session' }> }

export class OverviewReadOnlyError extends Error {
  constructor() { super('只有本项目真实主会话可以维护看板；用户和执行会话只读。'); this.name = 'OverviewReadOnlyError' }
}

export interface OverviewServiceOptions {
  readonly store: OverviewStore
  readonly core: OverviewCorePort
  readonly now?: () => string
}

export class OverviewService {
  readonly #now: () => string
  constructor(readonly options: OverviewServiceOptions) { this.#now = options.now ?? (() => new Date().toISOString()) }

  /** 正文与来源各自读取，来源失败不抹掉已保存的整体说明。 */
  async read(request: OverviewRequest): Promise<OverviewView> {
    const access = await this.#access(request)
    const { document, status: documentStatus } = await this.options.store.readState(access.projectId)
    const project = await this.#owner(() => this.options.core.readProjectFacts(access))
    if (project.status === 'available' && (project.value.projectId !== access.projectId
      || project.value.sessions.some(session => session.projectId !== access.projectId))) throw new Error('Overview facts returned another project')
    const runtime = project.status === 'available' && this.options.core.readRuntime !== undefined
      ? await this.#owner(() => this.options.core.readRuntime!(access))
      : this.#unavailable<readonly OverviewRuntimeFact[]>('真实运行来源未接入或项目基本信息不可读。')
    if (project.status === 'available' && runtime.status === 'available'
      && runtime.value.some(fact => !project.value.sessions.some(session => session.id === fact.sessionId))) throw new Error('Overview runtime returned a foreign session')
    const reads = new Map<string, Promise<OverviewSourceView>>()
    const read = (reference: OverviewSourceRef): Promise<OverviewSourceView> => {
      const key = sourceIdentity(reference)
      let pending = reads.get(key)
      if (pending === undefined) { pending = this.#source(access, reference); reads.set(key, pending) }
      return pending
    }
    const blocks = await Promise.all(document.blocks.map(async block => ({ block, sources: await Promise.all(block.sources.map(read)) })))
    const views = blocks.flatMap(item => item.sources)
    const final = this.options.core.finalizeSources === undefined ? views : await this.options.core.finalizeSources(access, views)
    let offset = 0
    const published = blocks.map(item => { const sources = final.slice(offset, offset + item.sources.length); offset += item.sources.length; return {...item,sources} })
    return { projectId: access.projectId, document, documentStatus, project, runtime, blocks:published, loadedAt: this.#now() }
  }

  /** 只读同一当前正文，不展开来源，不访问来源/模型/消息能力。 */
  async readContext(request: OverviewRequest): Promise<OverviewContext> {
    const access = await this.#access(request)
    try {
      const state = await this.options.store.readState(access.projectId)
      return { projectId: access.projectId, ...state, readAt: this.#now() }
    } catch (error) {
      return { projectId: access.projectId, status: 'unreadable', message: errorMessage(error), readAt: this.#now() }
    }
  }

  /** 供公共只读来源导航复用，权限与看板读取一致。 */
  async readSource(request: OverviewRequest & { readonly reference: OverviewSourceRef }): Promise<OverviewSourceView> {
    const access = await this.#access(request)
    const source = await this.#source(access, parseOverviewSource(request.reference))
    return this.options.core.finalizeSources === undefined ? source : (await this.options.core.finalizeSources(access,[source]))[0]!
  }

  async putBlock(request: OverviewRequest & { readonly block: OverviewBlockInput }): Promise<OverviewDocument> {
    const access = await this.#writer(request)
    const sessionId = access.actor.sessionId
    const block = parseOverviewBlock(request.block)
    return this.#update(request, access, current => {
      const previous = current.blocks.find(item => item.id === block.id)
      if (previous !== undefined && previous.updatedBySessionId === sessionId) {
        const { updatedAt: _updatedAt, updatedBySessionId: _updatedBy, ...input } = previous
        if (isDeepStrictEqual(input, block)) return current
      }
      const now = this.#now()
      return {
        ...current, blocks: current.blocks.some(item => item.id === block.id)
          ? current.blocks.map(item => item.id === block.id ? { ...block, updatedAt: now, updatedBySessionId: sessionId } : item)
          : [...current.blocks, { ...block, updatedAt: now, updatedBySessionId: sessionId }],
        updatedAt: now, updatedBySessionId: sessionId,
      }
    })
  }

  async removeBlock(request: OverviewRequest & { readonly blockId: string }): Promise<OverviewDocument> {
    const access = await this.#writer(request)
    const sessionId = access.actor.sessionId
    return this.#update(request, access, current => {
      if (!current.blocks.some(block => block.id === request.blockId)) throw new Error('Overview block not found')
      return { ...current, blocks: current.blocks.filter(block => block.id !== request.blockId), updatedAt: this.#now(), updatedBySessionId: sessionId }
    })
  }

  async reorderBlocks(request: OverviewRequest & { readonly blockIds: readonly string[] }): Promise<OverviewDocument> {
    const access = await this.#writer(request)
    const sessionId = access.actor.sessionId
    return this.#update(request, access, current => {
      if (request.blockIds.length !== current.blocks.length || new Set(request.blockIds).size !== current.blocks.length) throw new Error('Reorder must include every block exactly once')
      const blocks = request.blockIds.map(id => {
        const block = current.blocks.find(block => block.id === id)
        if (block === undefined) throw new Error('Overview reorder contains an unknown block')
        return block
      })
      return { ...current, blocks, updatedAt: this.#now(), updatedBySessionId: sessionId }
    })
  }

  #update(request: OverviewRequest, access: OverviewAccess, transform: (current: OverviewDocument) => OverviewDocument): Promise<OverviewDocument> {
    return this.options.core.withMetadataWrite(request, access, scope => this.options.store.updateWithin(scope, request.projectId, transform))
  }

  async #source(access: OverviewAccess, reference: OverviewSourceRef): Promise<OverviewSourceView> {
    try { return currentSource(access.projectId, reference, await this.options.core.readSource(access, reference)) } catch (error) {
      return unavailableSource(access.projectId, reference, this.#now(), errorMessage(error), 'unreadable')
    }
  }

  async #access(request: OverviewRequest): Promise<OverviewAccess> {
    const access = await this.options.core.resolveAccess(request)
    if (access.projectId !== request.projectId) throw new Error('Overview access belongs to another project')
    return access
  }

  async #writer(request: OverviewRequest): Promise<OverviewWriterAccess> {
    const access = await this.#access(request)
    if (access.actor.kind !== 'session' || access.actor.role !== 'main') throw new OverviewReadOnlyError()
    return access as OverviewWriterAccess
  }

  async #owner<T>(read: () => Promise<OverviewOwnerRead<T>>): Promise<OverviewOwnerRead<T>> {
    try { return await read() } catch (error) { return { status: 'unreadable', message: errorMessage(error), readAt: this.#now() } }
  }

  #unavailable<T>(message: string): OverviewOwnerRead<T> { return { status: 'unavailable', message, readAt: this.#now() } }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
