import { isDeepStrictEqual } from 'node:util'
import type { MemoryBatchInput } from './memory-bot/types.ts'
import type { NativeProjectSourceItem } from './source-types.ts'
import { nativeSourceDigest } from './native-source-host.ts'
import { visibleSourceItemForModel, visibleSourceItemText } from './model-visible-content.ts'
import { canonicalJsonChunks } from './canonical-chunks.ts'

interface MemoryModelSourceInput {
  isUserDecision: boolean
  text?: string
  nativeItems?: readonly NativeProjectSourceItem[]
  readable?: boolean
  partial?: true
}
type MemoryModelSourceItem = Omit<NativeProjectSourceItem, 'text'> & { readonly text?: string }
type MemoryModelSource<T> = Omit<T, 'isUserDecision' | 'text' | 'nativeItems'> & {
  isUserOrigin: boolean
  text?: string
  nativeItems?: readonly MemoryModelSourceItem[]
}

/** Only proven duplicate display forms leave the model view; owner evidence stays intact. */
export function memorySourceForModel<T extends MemoryModelSourceInput>(value: T): MemoryModelSource<T> {
  const { isUserDecision, text, nativeItems, ...source } = value
  const projected: MemoryModelSource<T> = { ...source,
    ...(Object.hasOwn(value, 'text') ? { text } : {}), ...(Object.hasOwn(value, 'nativeItems') ? { nativeItems } : {}),
    isUserOrigin: isUserDecision }
  if (source.readable !== true || nativeItems === undefined) return projected
  const targets = nativeItems.filter(item => item.isTarget)
  const targetText = targets.map(visibleSourceItemText)
  if (targets.length > 0 && targetText.every(item => typeof item === 'string')
    && typeof text === 'string' && text === targetText.join('\n')) delete projected.text
  projected.nativeItems = nativeItems.map(item => visibleSourceItemForModel(item) as MemoryModelSourceItem)
  return projected
}

/** 两个来源出口共用同一投影，不改冻结输入及来源正文。 */
export function memoryBatchForModel(input: MemoryBatchInput) {
  const { frozen, ...batch } = input
  const { coverage: _internalCoverage, projectionVersion: _projectionVersion, ...frozenForModel } = frozen
  type Context = MemoryBatchInput['requests'][number]['context'][number]
  interface Group { context: Context; count: number; id?: string }
  const groups: Group[] = [], buckets = new Map<string, Group[]>(), selected = new Map<Context, Group>()
  if (frozen.kind === 'explicit') for (const item of input.requests) for (const context of item.context) {
    const key = nativeSourceDigest(context.source), candidates = buckets.get(key) ?? []
    let group = candidates.find(candidate => isDeepStrictEqual(candidate.context, context))
    if (group === undefined) {
      group = { context, count: 0 }; candidates.push(group); groups.push(group); buckets.set(key, candidates)
    }
    group.count++; selected.set(context, group)
  }
  const shared = groups.filter(group => group.count > 1).map((group, index) => {
    group.id = `context-${index + 1}`
    return { ...group.context, id: group.id, value: memorySourceForModel(group.context.value) }
  })
  const inlineRequests = input.requests.map(item => {
    const { attempted: _attempted, frozenOriginal: _frozenOriginal, frozenContext: _frozenContext, ...request } = item.request
    return { ...item, request, original: memorySourceForModel(item.original),
      context: item.context.map(context => ({ ...context, value: memorySourceForModel(context.value) })),
    }
  })
  const sharedRequests = shared.length === 0 ? inlineRequests : inlineRequests.map((item, index) => ({ ...item, context: item.context.map((context, contextIndex) => {
    const sharedId = selected.get(input.requests[index]!.context[contextIndex]!)?.id
    if (sharedId === undefined) return context
    const { value: _sharedValue, ...reference } = context
    return { ...reference, shared_context_id: sharedId }
  }) }))
  const inline = { ...batch, frozen: frozenForModel, requests: inlineRequests }
  const pooled = { ...inline, shared_context: shared, requests: sharedRequests }
  const pooledSize = shared.length === 0 ? undefined : jsonSize(pooled), inlineSize = shared.length === 0 ? undefined : jsonSize(inline)
  // The existing fixed text estimator is monotone in UTF-16 length; UTF-8 is checked independently.
  const useShared = pooledSize !== undefined && inlineSize !== undefined && pooledSize.utf16 < inlineSize.utf16 && pooledSize.utf8 <= inlineSize.utf8
  return { ...batch, frozen: frozenForModel, ...(useShared ? { shared_context: shared } : {}), requests: useShared ? sharedRequests : inlineRequests }
}

/** JSON DTO key order does not change its encoded length; count bounded chunks, not body-sized copies. */
function jsonSize(value: unknown): { utf16: number; utf8: number } {
  let utf16 = 0, utf8 = 0
  for (const chunk of canonicalJsonChunks(value, 'communication')) { utf16 += chunk.length; utf8 += Buffer.byteLength(chunk) }
  return { utf16, utf8 }
}

export type MemoryBatchModelInput = ReturnType<typeof memoryBatchForModel>
