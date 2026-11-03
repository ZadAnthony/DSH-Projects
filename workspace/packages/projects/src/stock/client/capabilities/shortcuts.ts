/** Projects-owned keyboard adapter. It only observes descendants of its mounted container. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Shortcuts, ShortcutContext, ShortcutFixedInput } from '@deepseek-ai/dsh-client-shortcuts/client'
import { initialShortcutConfig, bindingIssue, bindingKey, normalizeBinding, overlappingBindings, presentBinding } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import type { ProjectShortcutSettingsPort } from './contracts.ts'
import { ShortcutRegistry } from './native/shortcut-registry.ts'

function unavailable(operation: string): never { throw new Error(`Projects shortcut capability is not connected: ${operation}`) }

export class ProjectScopedShortcuts implements Shortcuts {
  readonly runtime: Shortcuts['runtime']
  readonly platform: Shortcuts['platform']
  readonly catalog: Shortcuts['catalog']
  readonly config: Shortcuts['config']
  readonly fixedCatalog: Shortcuts['fixedCatalog']
  readonly stopSequenceMs: number
  private readonly registry: ShortcutRegistry
  private readonly listeners = new Set<(input: ShortcutFixedInput) => void>()
  private unmount: (() => void) | undefined

  constructor(ctx: Context, private readonly settings?: ProjectShortcutSettingsPort) {
    this.runtime = settings?.runtime ?? 'web'
    this.platform = settings?.platform ?? (/mac|iphone|ipad/iu.test(globalThis.navigator?.platform ?? '') ? 'macos' : /win/iu.test(globalThis.navigator?.platform ?? '') ? 'windows' : 'linux')
    this.stopSequenceMs = settings?.stopSequenceMs ?? 500
    if (!Number.isSafeInteger(this.stopSequenceMs) || this.stopSequenceMs < 1 || this.stopSequenceMs > 2_147_483_646) throw new Error('Invalid Projects stop shortcut interval')
    this.registry = new ShortcutRegistry(this.runtime, this.platform, settings?.config.getSnapshot() ?? { ...initialShortcutConfig(), status: 'ready' })
    this.catalog = this.registry.catalog
    this.config = this.registry.config
    this.fixedCatalog = this.registry.fixedCatalog
    if (settings !== undefined) ctx.effect(() => settings.config.subscribe(() => this.registry.configure(settings.config.getSnapshot())), 'Projects shortcut configuration')
    ctx.effect(() => ctx.locale.subscribe(() => { this.registry.refreshLabels() }), 'Projects shortcut locale')
    ctx.effect(() => () => this.dispose(), 'Projects scoped keyboard')
  }

  register: Shortcuts['register'] = command => this.registry.register(command)
  registerFixed: Shortcuts['registerFixed'] = command => this.registry.registerFixed(command)
  observeFixedInput: Shortcuts['observeFixedInput'] = listener => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  describeBinding: Shortcuts['describeBinding'] = binding => {
    const normalized = binding === null ? null : normalizeBinding(binding, this.platform)
    return { binding: normalized, keys: presentBinding(normalized, this.platform).keys,
      issue: normalized === null ? null : bindingIssue(normalized, this.runtime, this.platform),
      conflicts: normalized === null ? [] : [
        ...this.catalog.getSnapshot().filter(row => row.binding !== null && overlappingBindings(row.binding, normalized)).map(row => row.id),
        ...this.fixedCatalog.getSnapshot().filter(row => row.bindings.some(item => overlappingBindings(item, normalized))).map(row => row.id),
      ] }
  }
  edit: Shortcuts['edit'] = (edit, revision) => this.settings?.edit(edit, revision) ?? Promise.reject(new Error('Projects shortcut configuration is read only'))
  recording: Shortcuts['recording'] = async active => { if (this.settings === undefined) unavailable('recording'); await this.settings.recording(active) }
  closeWindow: Shortcuts['closeWindow'] = async () => { if (this.settings === undefined) unavailable('closeWindow'); await this.settings.closeWindow() }

  /** Mount after the private renderer commits. No window/document keyboard handler is registered. */
  mount(root: HTMLElement): () => void {
    if (this.unmount !== undefined) throw new Error('Projects keyboard is already mounted')
    let composing = false
    const reset = () => { this.publish({ type: 'reset' }) }
    const start = () => { composing = true; reset() }
    const end = () => { composing = false; reset() }
    const keydown = (event: KeyboardEvent): void => {
      const element = event.composedPath().find(value => value instanceof Element)
      if (!(element instanceof Element) || !root.contains(element)) return
      const region: ShortcutContext['region'] = element.closest('.xterm') !== null ? 'terminal'
        : element.closest('input,textarea,select,[contenteditable="true"],[contenteditable=""]') !== null ? 'editable' : 'page'
      const modal = element.closest<HTMLElement>('[role="dialog"],[aria-modal="true"]')
      const context: ShortcutContext = { source: 'keyboard', region, modal: modal?.dataset.shortcutModal ?? (modal === null ? null : 'other'), target: element }
      const gesture = { code: event.code, control: event.ctrlKey, alt: event.altKey, shift: event.shiftKey,
        meta: event.metaKey, repeat: event.repeat, composing: composing || event.isComposing || event.key === 'Dead' || event.getModifierState('AltGraph'), defaultPrevented: event.defaultPrevented }
      const consume = () => { event.preventDefault(); event.stopPropagation() }
      this.publish({ type: 'keydown', gesture, context, consume })
      this.registry.dispatch({ ...gesture, defaultPrevented: event.defaultPrevented }, context, consume)
      // A private fixed action belongs to this panel even when its owner is
      // idle. In particular, an idle Project Escape must not reach an ordinary
      // root Session's independent double-Escape Stop state machine.
      const modifiers = (['control', 'alt', 'shift', 'meta'] as const).filter(key => gesture[key])
      const key = bindingKey({ code: gesture.code, modifiers })
      if (this.fixedCatalog.getSnapshot().some(row => row.bindings.some(binding => bindingKey(binding) === key))) event.stopPropagation()
    }
    root.addEventListener('keydown', keydown)
    root.addEventListener('compositionstart', start)
    root.addEventListener('compositionend', end)
    root.addEventListener('focusin', reset)
    root.addEventListener('focusout', reset)
    root.addEventListener('pointerdown', reset)
    const off = () => {
      if (this.unmount !== off) return
      this.unmount = undefined
      root.removeEventListener('keydown', keydown)
      root.removeEventListener('compositionstart', start)
      root.removeEventListener('compositionend', end)
      root.removeEventListener('focusin', reset)
      root.removeEventListener('focusout', reset)
      root.removeEventListener('pointerdown', reset)
      reset()
    }
    this.unmount = off
    return off
  }

  private publish(input: ShortcutFixedInput): void {
    let consumed = false
    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue
      try {
        listener(input.type === 'reset' ? input : { ...input,
          gesture: { ...input.gesture, defaultPrevented: input.gesture.defaultPrevented || consumed },
          consume: () => { consumed = true; input.consume() } })
      } catch (error) { console.error('Projects fixed shortcut handler failed', error) }
    }
  }
  dispose(): void { this.unmount?.(); this.listeners.clear() }
}
