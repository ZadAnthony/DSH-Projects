/** Request-only references to complete, verified current supplies. Canonical tool results stay intact. */
import { isDeepStrictEqual } from 'node:util'
import type { RequestCandidateMessage, RequestCurrentBlock } from './stock/request/harness.ts'
import type { ProjectInstructions, SessionInstructions } from './features/settings/types.ts'
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'

type Value = Record<string, unknown>
export interface WorkCurrentSupply {
  readonly instructions: readonly {
    readonly sectionName: string
    readonly sectionText: string
    readonly value: ProjectInstructions | SessionInstructions
  }[]
  readonly currentBlocks: readonly RequestCurrentBlock[]
  readonly invocationInputs?: { readonly key: string; readonly value: readonly unknown[] }
}
export type WorkCurrentSupplyReader = () => WorkCurrentSupply | undefined

/** Each invocation closes over one prepare's snapshots and verifies their presence in this candidate. */
export function prepareWorkCurrentRepresentation(projectId: string, history: readonly RequestCandidateMessage[], supply?: WorkCurrentSupply): (tool: string | undefined, input: unknown) => unknown {
  const instructions = (supply?.instructions ?? []).filter(item => item.value.projectId === projectId
    && item.value.instructions.length > 0 && item.sectionText.length > 0
    && Number.isSafeInteger(item.value.revision)
    && history.filter(({ message }) => message.role === 'system'
      && message.content.some(block => block.type === 'text' && block.text.includes(item.sectionText))).length === 1)
  const blocks = (supply?.currentBlocks ?? []).flatMap(block => {
    if (block.producer !== 'projects' || block.value === null) return []
    const source = record(block.value.source)
    if (source?.kind !== 'project-request-context' || source.projectId !== projectId || source.status !== 'available') return []
    const candidates = history.filter(({ message }) => message.role === 'user' && 'currentBlock' in message
      && message.currentBlock?.producer === block.producer && message.currentBlock.key === block.key
      && isDeepStrictEqual(message.content, block.value!.content) && isDeepStrictEqual(message.source, block.value!.source))
    const visible = candidates[0]
    if (candidates.length !== 1 || visible === undefined || visible.message.id === undefined || block.value.content.length !== 1
      || visible.origin.kind === 'literal' && visible.origin.history !== undefined) return []
    const content = block.value.content[0]
    if (content?.type !== 'text') return []
    const object = record(source.object), value = object?.kind === 'runtime' && supply?.invocationInputs?.key === block.key
      ? { invocationInputs: supply.invocationInputs.value } : parse(content.text)
    if (object?.key !== block.key || value?.projectId !== projectId && object?.kind !== 'runtime') return []
    return [{ key: block.key, object, value, messageId: visible.message.id }]
  })
  const instruction = (raw: unknown, target: Value): unknown => {
    const value = record(raw)
    if (value === undefined || partial(value)) return raw
    const keeper = instructions.find(item => isDeepStrictEqual(item.value, value)
      && (target.kind === 'project' ? !('sessionId' in item.value)
        : target.kind === 'session' && 'sessionId' in item.value && item.value.sessionId === target.session_id))
    if (keeper === undefined) return raw
    const { instructions: _body, ...metadata } = value
    return shorter(value, { ...metadata, instructions_ref: {
      keeper: 'sessionId' in keeper.value ? '本请求当前单会话用户补充指令' : '本请求当前项目用户补充指令/共享约定', range: '完整原文',
    } })
  }
  const overviewBlock = (raw: unknown): unknown => {
    const value = record(raw)
    if (value === undefined || partial(value) || typeof value.id !== 'string' || typeof value.title !== 'string'
      || !Array.isArray(value.sources) || record(value.content) === undefined
      || typeof value.updatedAt !== 'string' || typeof value.updatedBySessionId !== 'string') return raw
    const keeper = blocks.find(block => block.object?.kind === 'overview'
      && block.key === `overview:${projectId}:block:${value.id}` && isDeepStrictEqual(block.value?.block, value))
    if (keeper === undefined) return raw
    const { content: _body, ...metadata } = value
    return shorter(value, { ...metadata, content_ref: { keeper: '本请求当前看板区块', projectId, blockId: value.id, range: '完整content' } })
  }
  const document = (raw: unknown): unknown => {
    const value = record(raw)
    if (value === undefined || partial(value) || value.projectId !== projectId || value.schemaVersion !== 2 || !Array.isArray(value.blocks)) return raw
    const original = value.blocks, projected = original.map(overviewBlock)
    return projected.every((block, index) => block === original[index]) ? raw : { ...value, blocks: projected }
  }
  return (tool, input) => {
    const value = record(input)
    if (value === undefined || partial(value)) return input
    if (tool === 'project_instructions_read' || tool === 'project_instructions_save') {
      if (value.projectId !== projectId || !Array.isArray(value.results)) return input
      const original = value.results, results = original.map(raw => {
        const row = record(raw), target = record(row?.target)
        if (row === undefined || target === undefined || partial(row)) return raw
        const field = row.kind === 'read' || row.kind === 'saved' ? 'value' : row.kind === 'conflict' ? 'current' : undefined
        if (field === undefined) return raw
        const projected = instruction(row[field], target)
        return projected === row[field] ? raw : { ...row, [field]: projected }
      })
      return results.every((row, index) => row === original[index]) ? input : { ...value, results }
    }
    if (tool === 'project_overview_put_block' || tool === 'project_overview_remove_block' || tool === 'project_overview_reorder') return document(input)
    if (tool === 'project_overview_read') {
      if (value.projectId !== projectId || value.documentStatus !== 'available') return input
      const projected = document(value.document)
      return projected === value.document ? input : { ...value, document: projected }
    }
    if (tool !== 'project_read' || record(value.project)?.id !== projectId) return input
    const overview = record(value.overview)
    const projectedDocument = overview?.status === 'available' && overview.projectId === projectId && !partial(overview) ? document(overview.document) : overview?.document
    const inputs = blocks.find(block => block.object?.kind === 'runtime' && block.key === supply?.invocationInputs?.key
      && Array.isArray(value.invocationInputs) && isDeepStrictEqual(block.value?.invocationInputs, value.invocationInputs))
    const originalInputs = { invocationInputs: value.invocationInputs }
    const projectedInputs = inputs === undefined ? originalInputs : shorter(originalInputs, { invocationInputs_ref: { keeper: '本请求系统提供的本处理轮真实输入来源', range: '完整invocationInputs' } })
    if (projectedDocument === overview?.document && projectedInputs === originalInputs) return input
    const { invocationInputs, ...rest } = value
    return { ...rest, ...(overview === undefined ? {} : { overview: projectedDocument === overview.document ? overview : { ...overview, document: projectedDocument } }),
      ...(Object.hasOwn(value, 'invocationInputs') ? projectedInputs : {}) }
  }
}

function partial(value: Value): boolean {
  return value.partial === true || value.status === 'partial' || value.complete === false || value.page_complete === true
    || value.format === 'projects-tool-read-page/v1' || value.kind === 'unknown' || value.kind === 'failed'
}
function record(value: unknown): Value | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Value : undefined }
function parse(value: string): Value | undefined { try { return record(JSON.parse(value)) } catch { return undefined } }
/** References must reduce the actual serialized content, never merely reduce marker counts. */
function shorter(original: Value, projected: Value): Value {
  const before = JSON.stringify(original), after = JSON.stringify(projected)
  if (after.length >= before.length || Buffer.byteLength(after) >= Buffer.byteLength(before)) return original
  return estimateContent([{ type: 'text', text: after }]) <= estimateContent([{ type: 'text', text: before }]) ? projected : original
}
