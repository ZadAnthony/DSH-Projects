/** One file gesture owner for native prose, tool cards, communication and Library. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { ProjectConversationFileRequest, ReadConversationFile } from '../../../client/workflow-navigation.ts'
import type { WorkspaceFileBytes } from '@deepseek-ai/dsh-api-workspace-files/types'
import { projectCopy, type ProjectsTranslate } from '../../../client/ui/copy.ts'

export interface ProjectFileBinding {
  readonly projectId: string
  /** Logical Project session identity. */
  readonly sessionId: string
  readonly hostSessionId: string
  readonly sessionCreatedAt: number
  readonly role?: 'main' | 'execution'
  readonly sessionTitle?: string
}
export interface ProjectFileReaderOptions {
  readonly resolveBinding: (hostSessionId: string) => ProjectFileBinding | undefined
  readonly read: ReadConversationFile
  readonly readBytes?: (binding: ProjectFileBinding, path: string, signal: AbortSignal) => Promise<WorkspaceFileBytes>
  readonly onReturnFocus?: (binding: ProjectFileBinding) => void
  readonly translate?: ProjectsTranslate
  readonly subscribeLocale?: (listener: () => void) => (() => void)
  readonly ownerDocument?: Document
}
export type ProjectFileRequest = ProjectConversationFileRequest & { readonly sessionCreatedAt: number }
interface FileImage { readonly binding: ProjectFileBinding; readonly abort: AbortController; state: 'loading' | 'failed' | 'ready'; source: string; objectUrl?: string }
const imageScopeKey = (binding: ProjectFileBinding): string => JSON.stringify([binding.projectId, binding.sessionId, binding.hostSessionId, binding.sessionCreatedAt])
function xmlText(value: string): string { return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!) }
function imageStatusLayout(message: string, fontSize: number): { readonly lines: readonly string[]; readonly width: number; readonly height: number; readonly lineHeight: number } {
  // Reserve a conservative em width for the host's normal text fonts; English
  // wraps at words and Chinese at characters. Intrinsic height grows with type.
  const units = (text: string): number => Array.from(text).reduce((sum, character) => sum + (character.codePointAt(0)! > 255 ? 1 : .7), 0)
  const spaced = /\s/.test(message), parts = spaced ? message.split(/\s+/) : Array.from(message)
  const lines: string[] = []
  let line = ''
  for (const part of parts) {
    const next = line === '' ? part : line + (spaced ? ' ' : '') + part
    if (line !== '' && units(next) * fontSize > 216) { lines.push(line); line = part }
    else line = next
  }
  lines.push(line)
  const lineHeight = Math.ceil(fontSize * 1.4)
  return { lines, width: Math.max(240, Math.ceil(Math.max(...lines.map(units)) * fontSize + 24)), height: Math.max(64, lines.length * lineHeight + 24), lineHeight }
}
function imageMediaType(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  const start = new TextDecoder().decode(bytes.subarray(0, 512))
  if (/^GIF8[79]a/.test(start)) return 'image/gif'
  if (start.startsWith('RIFF') && start.slice(8, 12) === 'WEBP') return 'image/webp'
  if (/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/.test(start)) return 'image/svg+xml'
  throw new Error('PROJECT_FILE_IMAGE_UNSUPPORTED')
}

export function sameProjectFileBinding(a: ProjectFileBinding, b: ProjectFileBinding): boolean {
  return a.projectId === b.projectId && a.sessionId === b.sessionId
    && a.hostSessionId === b.hostSessionId && a.sessionCreatedAt === b.sessionCreatedAt
}
export function assertProjectFileBinding(value: ProjectFileBinding): void {
  if (!value.projectId || !value.sessionId || !value.hostSessionId || !Number.isSafeInteger(value.sessionCreatedAt)
    || value.sessionCreatedAt < 0) throw new Error('PROJECT_SOURCE_INVALID: exact Project file identity is required')
}

export class ProjectFileReaderOwner {
  readonly request = createSnapshotStore<ProjectFileRequest | undefined>(undefined)
  readonly imageRevision = createSnapshotStore(0)
  private readonly images = new Map<string, FileImage>()
  private readonly imageScopes = new Map<string, number>()
  private abort: AbortController | undefined
  private sequence = 0
  private disposed = false
  private readonly document: Document | undefined
  private readonly themeObserver: MutationObserver | undefined
  private readonly stopLocale: (() => void) | undefined
  private unavailableImage: string | undefined
  constructor(readonly options: ProjectFileReaderOptions) {
    this.document = options.ownerDocument ?? (typeof document === 'undefined' ? undefined : document)
    const Observer = this.document?.defaultView?.MutationObserver
    if (Observer !== undefined && this.document !== undefined) {
      this.themeObserver = new Observer(() => this.refreshImagePresentation())
      // rc.3 ThemePresenter projects the active palette/tokens onto these exact owners.
      this.themeObserver.observe(this.document.documentElement, { attributes: true, attributeFilter: ['style', 'data-ds-theme-source'] })
      if (this.document.body !== null) this.themeObserver.observe(this.document.body, { attributes: true, attributeFilter: ['style', 'data-ds-dark-theme'] })
    }
    this.stopLocale = options.subscribeLocale?.(() => this.refreshImagePresentation())
  }
  private imageStatus(state: 'loading' | 'failed'): string {
    const root = this.document?.body ?? this.document?.documentElement
    const styles = root === undefined ? undefined : this.document?.defaultView?.getComputedStyle(root)
    const background = styles?.getPropertyValue('--dsw-alias-bg-layer-1').trim() || 'transparent'
    const foreground = styles?.getPropertyValue('--dsw-alias-label-secondary').trim() || styles?.color || 'currentColor'
    const size = Number.parseFloat(styles?.getPropertyValue('--dsh-content-font-size') || styles?.fontSize || '')
    const fontSize = Number.isFinite(size) && size > 0 ? size : 14
    const fontFamily = styles?.fontFamily || styles?.getPropertyValue('--dsw-font-family').trim() || 'sans-serif'
    const message = projectCopy(this.options.translate)(state === 'loading' ? 'wholeRead.image.loading' : 'wholeRead.image.failed')
    const { lines, width, height, lineHeight } = imageStatusLayout(message, fontSize)
    const firstBaseline = (height - lines.length * lineHeight) / 2 + fontSize
    const text = lines.map((line, index) => `<tspan x="12" y="${firstBaseline + index * lineHeight}">${xmlText(line)}</tspan>`).join('')
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" role="img" aria-label="${xmlText(message)}"><title>${xmlText(message)}</title><rect width="${width}" height="${height}" fill="${xmlText(background)}"/><text font-size="${fontSize}" font-family="${xmlText(fontFamily)}" fill="${xmlText(foreground)}">${text}</text></svg>`)
  }
  private refreshImagePresentation(): void {
    if (this.disposed) return
    let changed = false
    for (const image of this.images.values()) {
      if (image.state === 'ready') continue
      const source = this.imageStatus(image.state)
      if (source !== image.source) { image.source = source; changed = true }
    }
    if (this.unavailableImage !== undefined) {
      const source = this.imageStatus('failed')
      if (source !== this.unavailableImage) { this.unavailableImage = source; changed = true }
    }
    if (changed) this.imageRevision.set(this.imageRevision.getSnapshot() + 1)
  }
  unavailableImageSource(): string { return this.unavailableImage = this.imageStatus('failed') }
  /** Bind inline image lifetime to the exact native Chat binding scope. */
  retainImages(binding: ProjectFileBinding): () => void {
    const key = imageScopeKey(binding)
    this.imageScopes.set(key, (this.imageScopes.get(key) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return; released = true
      const remaining = (this.imageScopes.get(key) ?? 0) - 1
      if (remaining > 0) { this.imageScopes.set(key, remaining); return }
      this.imageScopes.delete(key)
      let changed = false
      for (const [pathKey, image] of this.images) {
        if (imageScopeKey(image.binding) !== key) continue
        image.abort.abort(); if (image.objectUrl !== undefined) URL.revokeObjectURL(image.objectUrl)
        this.images.delete(pathKey); changed = true
      }
      if (changed) this.imageRevision.set(this.imageRevision.getSnapshot() + 1)
    }
  }

  /** Synchronous native Markdown image resolver backed only by captured Project byte reads. */
  imageSource(binding: ProjectFileBinding, path: string): string {
    const latest = this.options.resolveBinding(binding.hostSessionId)
    if (this.disposed || latest === undefined || !sameProjectFileBinding(binding, latest)
      || (this.imageScopes.get(imageScopeKey(binding)) ?? 0) === 0) return this.unavailableImageSource()
    const key = JSON.stringify([binding.projectId, binding.sessionId, binding.hostSessionId, binding.sessionCreatedAt, path])
    const cached = this.images.get(key)
    if (cached !== undefined) return cached.source
    const abort = new AbortController(), image: FileImage = { binding: { ...binding }, abort, state: 'loading', source: this.imageStatus('loading') }
    this.images.set(key, image)
    void (async () => {
      try {
        if (this.options.readBytes === undefined) throw new Error('PROJECT_FILE_IMAGE_READER_UNAVAILABLE')
        const value = await this.options.readBytes(binding, path, abort.signal)
        abort.signal.throwIfAborted()
        const current = this.options.resolveBinding(binding.hostSessionId)
        if (current === undefined || !sameProjectFileBinding(binding, current)) throw new Error('PROJECT_SOURCE_STALE')
        if (!value.eof || value.offset !== 0 || value.bytes !== undefined && value.bytes !== value.data.byteLength) throw new Error('PROJECT_FILE_IMAGE_INCOMPLETE')
        const bytes = new Uint8Array(value.data)
        image.objectUrl = URL.createObjectURL(new Blob([bytes], { type: imageMediaType(bytes) }))
        image.source = image.objectUrl; image.state = 'ready'
      } catch { if (!abort.signal.aborted) { image.state = 'failed'; image.source = this.imageStatus('failed') } }
      if (!abort.signal.aborted) this.imageRevision.set(this.imageRevision.getSnapshot() + 1)
    })()
    return image.source
  }

  readonly read: ReadConversationFile = async (request, options, signal) => {
    request.signal.throwIfAborted()
    signal?.throwIfAborted()
    const createdAt = (request as Partial<ProjectFileRequest>).sessionCreatedAt
    const current = this.options.resolveBinding(request.hostSessionId)
    if (createdAt === undefined || current === undefined || !sameProjectFileBinding(current, {
      projectId: request.projectId, sessionId: request.sessionId,
      hostSessionId: request.hostSessionId, sessionCreatedAt: createdAt,
    })) throw new Error('PROJECT_SOURCE_STALE: original file session is no longer available')
    const combined = signal === undefined ? request.signal : AbortSignal.any([signal, request.signal])
    const value = await this.options.read(request, options, combined)
    combined.throwIfAborted()
    const after = this.options.resolveBinding(request.hostSessionId)
    if (after === undefined || !sameProjectFileBinding(current, after)) throw new Error('PROJECT_SOURCE_STALE: file source changed during read')
    return value
  }

  async openFile(binding: ProjectFileBinding, path: string, options?: { readonly line?: number }): Promise<void> {
    if (this.disposed) throw new Error('Project file reader is disposed')
    assertProjectFileBinding(binding)
    const current = this.options.resolveBinding(binding.hostSessionId)
    if (current === undefined || !sameProjectFileBinding(binding, current)) throw new Error('PROJECT_SOURCE_STALE: file gesture belongs to an unavailable session')
    if (path.length === 0 || path.includes('\0')) throw new Error('PROJECT_FILE_PATH_INVALID')
    if (options?.line !== undefined && (!Number.isSafeInteger(options.line) || options.line < 1)) throw new Error('PROJECT_FILE_LINE_INVALID')
    this.abort?.abort()
    this.abort = new AbortController()
    this.request.set({ id: ++this.sequence, ...binding, role: binding.role ?? 'execution',
      sessionTitle: binding.sessionTitle ?? binding.sessionId, path,
      ...(options?.line === undefined ? {} : { line: options.line }), signal: this.abort.signal })
  }

  async openResource(url: string, options?: { readonly params?: { readonly line?: number } }, binding?: ProjectFileBinding): Promise<void> {
    const resource = parseFileAddress(url)
    if (resource === undefined) throw new Error('PROJECT_RESOURCE_UNSUPPORTED: not a native file address')
    const exact = binding ?? (resource.scope === 'session' ? this.options.resolveBinding(resource.sessionId) : undefined)
    if (exact === undefined) throw new Error('PROJECT_SOURCE_INVALID: absolute file opening requires its original session')
    if (resource.scope === 'session' && resource.sessionId !== exact.hostSessionId) throw new Error('PROJECT_SOURCE_INVALID: file address and original session disagree')
    await this.openFile(exact, resource.path, options?.params)
  }

  close(options: { readonly focus?: boolean } = {}): void {
    const request = this.request.getSnapshot()
    this.abort?.abort(); this.abort = undefined
    this.request.set(undefined)
    if (request !== undefined && options.focus === true) {
      const current = this.options.resolveBinding(request.hostSessionId)
      if (current !== undefined && sameProjectFileBinding(request, current)) this.options.onReturnFocus?.(current)
    }
  }

  /** Call when a carrier disappears or its source identity changes. */
  invalidate(): void {
    const request = this.request.getSnapshot()
    if (request !== undefined) {
      const current = this.options.resolveBinding(request.hostSessionId)
      if (current === undefined || !sameProjectFileBinding(request, current)) this.close()
    }
    let changed = false
    for (const [key, image] of this.images) {
      const current = this.options.resolveBinding(image.binding.hostSessionId)
      if (current !== undefined && sameProjectFileBinding(image.binding, current)) continue
      image.abort.abort(); if (image.objectUrl !== undefined) URL.revokeObjectURL(image.objectUrl)
      this.images.delete(key); changed = true
    }
    if (changed) this.imageRevision.set(this.imageRevision.getSnapshot() + 1)
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.close()
    this.themeObserver?.disconnect(); this.stopLocale?.()
    for (const image of this.images.values()) { image.abort.abort(); if (image.objectUrl !== undefined) URL.revokeObjectURL(image.objectUrl) }
    this.images.clear(); this.imageScopes.clear()
  }
}
