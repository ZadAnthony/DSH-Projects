import { extname } from 'node:path'

type MemoryFileText = { readable: true; text: string }
  | { readable: false; reason: string; limitations: readonly string[] }

const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.gz', '.7z', '.rar',
  '.mp3', '.mp4', '.wav', '.ogg', '.woff', '.woff2', '.ttf', '.otf', '.bin', '.exe', '.dll', '.so', '.dylib'])
const TEXT_READING_LIMIT = '文件来源只读取完整 UTF-8 文本；未解析图片、PDF、办公文档或其它二进制格式，也未取得其文本内容。'

/** Bytes have already passed the existing Project identity, native path permissions and full-file cap. */
export function memoryFileText(path: string, data: Uint8Array): MemoryFileText {
  const unavailable = (reason: string): MemoryFileText => ({ readable: false, reason, limitations: [TEXT_READING_LIMIT] })
  const extension = extname(path).toLowerCase()
  if (BINARY_EXTENSIONS.has(extension)) return unavailable(`文件类型 ${extension} 不支持作为 UTF-8 文本来源；未解析其内容。`)
  // Some binary documents are ASCII or valid UTF-8. Reject their known signatures even when renamed.
  const head = Buffer.from(data.subarray(0, 16)).toString('latin1')
  if (head.startsWith('%PDF-') || head.startsWith('\x89PNG\r\n\x1a\n') || /^GIF8[79]a/.test(head)
    || head.startsWith('\xff\xd8\xff') || head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP'
    || /^PK[\x03\x05\x07][\x04\x06\x08]/.test(head) || head.startsWith('\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1')) {
    return unavailable('文件具有二进制文档格式标记，未解析为文本来源。')
  }
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data) }
  catch { return unavailable('文件不是有效的 UTF-8 文本，未用替换字符冒充原文。') }
  // Keep ordinary text whitespace, including form feed. Other C0/DEL bytes are binary evidence.
  if (/[\u0000-\u0008\u000e-\u001f\u007f]/u.test(text)) return unavailable('文件含二进制控制字符，不能可靠作为文本来源。')
  return { readable: true, text }
}
