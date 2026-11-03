/** Streaming counterparts of the existing canonical encoders; no whole-body strings. */
export type CanonicalMode = 'source' | 'communication' | 'history'
const STRING_CHUNK = 1024
function* stringChunks(value: string): Generator<string> {
  yield '"'
  for (let start = 0; start < value.length;) {
    let end = Math.min(value.length, start + STRING_CHUNK)
    if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end--
    yield JSON.stringify(value.slice(start, end)).slice(1, -1)
    start = end
  }
  yield '"'
}
function arrayIndex(key: string): number | undefined {
  const value = Number(key)
  return Number.isInteger(value) && value >= 0 && value < 0xffffffff && String(value) === key ? value : undefined
}
export function* canonicalJsonChunks(value: unknown, mode: CanonicalMode = 'source'): Generator<string> {
  if (typeof value === 'string') { yield* stringChunks(value); return }
  if (value === null || typeof value === 'boolean') { yield JSON.stringify(value); return }
  if (typeof value === 'number') {
    if (Number.isFinite(value) && (mode !== 'source' || !Object.is(value, -0))) { yield JSON.stringify(value); return }
    if (mode === 'history') { yield `number:${String(value)}`; return }
    throw new TypeError('Expected lossless JSON')
  }
  if (Array.isArray(value)) {
    yield '['
    for (let index = 0, length = value.length; index < length; index++) {
      if (index !== 0) yield ','
      if (index in value) yield* canonicalJsonChunks(value[index], mode)
      else if (mode === 'communication') yield 'null'
    }
    yield ']'; return
  }
  if (typeof value === 'object' && value !== null) {
    if (mode === 'source' && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Expected lossless JSON')
    const object = value as Record<string, unknown>
    const entries = mode === 'communication' ? Object.entries(object).filter(([, item]) => item !== undefined) : Object.keys(object).map(key => [key, object[key]] as [string, unknown])
    entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    // JSON.stringify enumerates integer keys before the other sorted keys.
    if (mode === 'communication') entries.sort(([left], [right]) => {
      const a = arrayIndex(left), b = arrayIndex(right)
      return a === undefined ? b === undefined ? left < right ? -1 : left > right ? 1 : 0 : 1 : b === undefined ? -1 : a - b
    })
    yield '{'
    for (const [index, [key, entry]] of entries.entries()) {
      if (index !== 0) yield ','
      yield* stringChunks(key); yield ':'; yield* canonicalJsonChunks(entry, mode)
    }
    yield '}'; return
  }
  if (mode === 'history') { yield value === undefined ? 'undefined' : typeof value === 'bigint' ? `bigint:${value}` : `${typeof value}:${String(value)}`; return }
  throw new TypeError('Expected lossless JSON')
}
export function codePointLength(value: string): number { let count = 0; for (const _point of value) count++; return count }
/** Copy the finite selected characters; a V8 sliced string could retain its whole source body. */
export function sliceCodePoints(value: string, start: number, end = Infinity): string {
  let index = 0
  const selected: string[] = []
  for (const point of value) {
    if (index >= end) break
    if (index >= start) selected.push(point)
    index++
  }
  return selected.join('')
}

export function canonicalCodePointLength(value: unknown, mode: CanonicalMode = 'communication'): number {
  let total = 0; for (const chunk of canonicalJsonChunks(value, mode)) total += codePointLength(chunk); return total
}
/** Count the complete stream while retaining only the requested finite window. */
export function canonicalWindow(value: unknown, start: number, end: number, mode: CanonicalMode = 'communication'): { text: string; total: number } {
  let total = 0
  const selected: string[] = []
  for (const chunk of canonicalJsonChunks(value, mode)) {
    const size = codePointLength(chunk)
    if (total < end && total + size > start) selected.push(sliceCodePoints(chunk, Math.max(0, start - total), Math.min(size, end - total)))
    total += size
  }
  return { text: selected.join(''), total }
}
