/** Encoded representations owned by one prepared adapter request. */
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'

export type RequestImageBase64 = (version: RequestImageAttachment) => string

/** Prepared versions are immutable for the request; distinct versions never share entries. */
export function requestImageBase64(): RequestImageBase64 {
  const encoded = new WeakMap<RequestImageAttachment, string>()
  return version => {
    const existing = encoded.get(version)
    if (existing !== undefined) return existing
    const data = version.data
    const value = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64')
    encoded.set(version, value)
    return value
  }
}
