/** Lossless model views of known visible source items; canonical owner DTOs stay untouched. */
import { communicationVisibleText } from './communication/visible-reader.ts'
import type { CommunicationVisibleBlock } from './communication/types.ts'

type RecordValue = Record<string, unknown>

/** A read item remains historical evidence even when its compatibility text was omitted. */
export function isHistoricalSourceItem(value: unknown): value is RecordValue {
  const item = record(value), source = record(item?.nativeSource)
  return item !== undefined && source !== undefined && typeof source.hostSessionId === 'string'
    && (source.kind === 'native-event' && source.version === 1 && Number.isSafeInteger(source.eventSeq) && typeof source.eventDigest === 'string'
      || source.kind === 'message' && typeof source.messageId === 'string' || source.kind === 'tool' && typeof source.toolCallId === 'string')
    && Number.isSafeInteger(item.seq) && typeof item.kind === 'string' && typeof item.role === 'string'
    && (typeof item.text === 'string' || visibleBlocks(item.visibleBlocks) !== undefined)
}

/** Compatibility text is derived only from a complete known block shape, never from arbitrary JSON. */
export function visibleSourceItemText(value: unknown): string | undefined {
  const item = record(value)
  if (typeof item?.text === 'string') return item.text
  const blocks = visibleBlocks(item?.visibleBlocks)
  return blocks === undefined ? undefined : communicationVisibleText(blocks)
}

/** Drop one proven display alias, retaining every source, phase, warning and structured fact. */
export function visibleSourceItemForModel(value: unknown): unknown {
  if (!isHistoricalSourceItem(value) || typeof value.text !== 'string') return value
  const blocks = visibleBlocks(value.visibleBlocks)
  if (blocks === undefined || blocks.length === 0 || communicationVisibleText(blocks) !== value.text) return value
  if (blocks.length === 1 && blocks[0]!.type === 'text') {
    const { visibleBlocks: _blocks, ...item } = value
    return item
  }
  const { text: _text, ...item } = value
  return item
}

/** Apply before serialized-result paging so short and long reads share the same model contract. */
export function historyResultForModel(value: unknown): unknown {
  const result = record(value)
  if (result === undefined || !Array.isArray(result.items)) return value
  const original = result.items
  const items = original.map(visibleSourceItemForModel)
  return items.some((item, index) => item !== original[index]) ? { ...result, items } : value
}

function visibleBlocks(value: unknown): readonly CommunicationVisibleBlock[] | undefined {
  if (!Array.isArray(value) || !value.every(visibleBlock)) return undefined
  return value as readonly CommunicationVisibleBlock[]
}
function visibleBlock(value: unknown): boolean {
  const block = record(value)
  if (block === undefined) return false
  if (block.type === 'text') return exact(block, ['type', 'text']) && typeof block.text === 'string'
  if (block.type === 'quoted-tool-call') return exact(block, ['type', 'toolCallId', 'name', 'arguments'])
    && typeof block.toolCallId === 'string' && typeof block.name === 'string' && typeof block.arguments === 'string'
  if (block.type === 'quoted-tool-result') {
    const error = record(block.error)
    return exact(block, ['type', 'toolCallId', 'messageId', 'isError', 'error', 'content']) && typeof block.toolCallId === 'string'
      && (block.messageId === undefined || typeof block.messageId === 'string') && typeof block.isError === 'boolean'
      && (block.error === undefined || error !== undefined && exact(error, ['name', 'code', 'reason']) && Object.values(error).every(value => typeof value === 'string'))
      && Array.isArray(block.content) && block.content.every(plainBlock)
  }
  return plainBlock(value)
}
function plainBlock(value: unknown): boolean {
  const block = record(value)
  if (block?.type === 'text') return exact(block, ['type', 'text']) && typeof block.text === 'string'
  if (block?.type !== 'file' && block?.type !== 'image') return false
  const attachment = record(block.attachment)
  return exact(block, block.type === 'image' ? ['type', 'attachment', 'offloaded'] : ['type', 'attachment'])
    && (block.offloaded === undefined || block.type === 'image' && block.offloaded === true)
    && attachment !== undefined && typeof attachment.attachmentId === 'string'
    && exact(attachment, block.type === 'image' ? ['attachmentId', 'name', 'bytes', 'mediaType', 'width', 'height', 'originalDimensions'] : ['attachmentId', 'name', 'bytes'])
    && (block.type === 'file' ? typeof attachment.name === 'string' : attachment.name === undefined || typeof attachment.name === 'string')
    && typeof attachment.bytes === 'number' && Number.isFinite(attachment.bytes) && attachment.bytes >= 0
    && (block.type === 'file' || typeof attachment.mediaType === 'string'
      && typeof attachment.width === 'number' && attachment.width > 0 && typeof attachment.height === 'number' && attachment.height > 0)
    && (attachment.originalDimensions === undefined || dimensions(attachment.originalDimensions))
}
function dimensions(value: unknown): boolean {
  const size = record(value)
  return size !== undefined && exact(size, ['width', 'height']) && typeof size.width === 'number' && typeof size.height === 'number'
}
function exact(value: RecordValue, keys: readonly string[]): boolean { return Object.keys(value).every(key => keys.includes(key)) }
function record(value: unknown): RecordValue | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined }
