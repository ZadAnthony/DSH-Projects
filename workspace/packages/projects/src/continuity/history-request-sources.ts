/** Lossless request-only source interning for partial native-history manifests. */
import { canonicalJson } from '../communication/contract.ts'
import { decodeNativeProjectSource } from '../native-source.ts'

type RecordValue = Record<string, unknown>
const GUIDANCE = 'nativeSourceRef and relatedSourceRefs[] are zero-based indexes into sourceTable. Each entry is the original complete source object; copy sourceTable[ref] unchanged when a source is needed. bodySourceAt is a JSON Pointer inside that same item. delivery.same_page.source remains the complete original source: call project_history with that action and source unchanged. Refs are not source objects and do not mean the original body was delivered. All original ranges, limitations and partial status still apply.'

/**
 * Share only known locator fields, leaving quoted bodies and the durable import intact.
 * Every complete source remains in this same model input, usable by the existing reader.
 */
export function compactPartialHistorySources(value: RecordValue): RecordValue {
  if (value.format !== 'projects-main-history/v1' || record(value.delivery)?.status !== 'partial'
    || !Array.isArray(value.items) || Object.hasOwn(value, 'sourceTable') || Object.hasOwn(value, 'sourceRepresentation')) return value
  const sourceTable: unknown[] = [], indexes = new Map<string, number>()
  const ref = (source: unknown): number | undefined => {
    let key: string
    try {
      key = canonicalJson(source)
      if (canonicalJson(decodeNativeProjectSource(source)) !== key) return undefined
    } catch { return undefined }
    const previous = indexes.get(key)
    if (previous !== undefined) return previous
    const index = sourceTable.length
    sourceTable.push(source); indexes.set(key, index)
    return index
  }
  const items = value.items.map(raw => {
    const item = record(raw)
    if (item === undefined || ['nativeSourceRef', 'bodySourceAt', 'relatedSourceRefs'].some(key => Object.hasOwn(item, key))) return raw
    const result = { ...item }
    for (const key of ['nativeSource']) {
      if (!Object.hasOwn(item, key)) continue
      const index = ref(item[key])
      if (index !== undefined) { delete result[key]; result[`${key}Ref`] = index }
    }
    if (Array.isArray(item.relatedSources)) {
      const refs = item.relatedSources.map(ref)
      if (refs.every(index => index !== undefined)) { delete result.relatedSources; result.relatedSourceRefs = refs }
    }
    const delivery = record(item.delivery), page = record(delivery?.same_page)
    if (page !== undefined && page.action === 'read_content' && Object.hasOwn(page, 'source') && Object.hasOwn(item, 'bodySource')
      && canonicalJson(item.bodySource) === canonicalJson(page.source)) {
      delete result.bodySource; result.bodySourceAt = '/delivery/same_page/source'
    }
    return result
  })
  if (sourceTable.length === 0) return value
  const projected = { ...value, items, sourceTable, sourceRepresentation: { format: 'source-table/v1', guidance: GUIDANCE } }
  const before = canonicalJson(value), after = canonicalJson(projected)
  return after.length < before.length && Buffer.byteLength(after) < Buffer.byteLength(before) ? projected : value
}

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined
}
