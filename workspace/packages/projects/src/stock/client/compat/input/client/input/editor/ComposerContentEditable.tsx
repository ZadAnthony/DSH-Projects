/** Native editable binding; its original DOM and Lexical runtime belong to the logical draft. */
import { useLayoutEffect, useRef } from 'react'
import type { HTMLAttributes, ReactNode } from 'react'
import { $getSelection, $setSelection, SKIP_DOM_SELECTION_TAG, type LexicalEditor, type BaseSelection } from 'lexical'

export interface ComposerContentEditableProps extends HTMLAttributes<HTMLDivElement> {
  readonly editor: LexicalEditor | null
  readonly editable: boolean
}

/** Resident DOM roots survive physical SessionProvider teardown without exporting editor state. */
const residentRoots = new WeakMap<LexicalEditor, HTMLDivElement>()
const parkedSelection = new WeakMap<LexicalEditor, BaseSelection>()
const parkedFocus = new WeakMap<LexicalEditor, boolean>()
const managedStyles = new WeakMap<LexicalEditor, Set<string>>()

export function ComposerContentEditable({ editor, editable, ...rest }: ComposerContentEditableProps): ReactNode {
  const mount = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (editor === null || mount.current === null) return
    let root = residentRoots.get(editor)
    if (root === undefined) {
      root = document.createElement('div')
      residentRoots.set(editor, root)
      root.setAttribute('role', 'textbox')
      root.setAttribute('aria-multiline', 'true')
      root.setAttribute('data-composer-input', '')
      editor.setRootElement(root)
    }
    const host = mount.current
    host.appendChild(root)
    const selection = parkedSelection.get(editor)
    const active = root.ownerDocument.activeElement
    const restoreOwnedFocus = parkedFocus.get(editor) === true && editable
      && (active === root.ownerDocument.body || active === root.ownerDocument.documentElement || active === root)
      && root.closest('[hidden], [inert], [aria-hidden="true"]') === null
    parkedFocus.delete(editor)
    parkedSelection.delete(editor)
    if (selection !== undefined) {
      // Removing a focused DOM root collapses the browser Range. Restore both
      // faces only for its still-visible focus owner; background mounts remain inert.
      if (restoreOwnedFocus) root.focus({ preventScroll: true })
      editor.update(() => { $setSelection(selection.clone()) }, {
        discrete: true, ...restoreOwnedFocus ? {} : { tag: SKIP_DOM_SELECTION_TAG },
      })
      if (restoreOwnedFocus) editor.focus()
    }
    // Keep the original DOM and the editor's selection/undo/decorator node keys.
    // Lexical root detachment belongs exclusively to SessionInputShell.dispose().
    return () => {
      if (root?.parentNode !== host) return
      const selection = editor.getEditorState().read(() => $getSelection()?.clone())
      if (selection !== undefined) parkedSelection.set(editor, selection)
      parkedFocus.set(editor, root.contains(root.ownerDocument.activeElement))
      root.remove()
    }
  }, [editor])
  useLayoutEffect(() => {
    if (editor === null) return
    const root = residentRoots.get(editor)
    if (root === undefined) return
    const attributes = ['class', 'data-phase', 'aria-disabled', 'data-placeholder', 'aria-label', 'aria-haspopup', 'aria-expanded', 'tabindex']
    for (const key of attributes) root.removeAttribute(key)
    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined || value === null || key === 'style' || key.startsWith('on')) continue
      const name = key === 'className' ? 'class' : key === 'tabIndex' ? 'tabindex' : key
      root.setAttribute(name, String(value))
    }
    for (const name of managedStyles.get(editor) ?? []) root.style.removeProperty(name)
    const styled = new Set<string>()
    if (rest.style !== undefined) for (const [key, value] of Object.entries(rest.style)) {
      if (value === undefined || value === null) continue
      const name = key.startsWith('--') ? key : key.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`)
      root.style.setProperty(name, String(value))
      styled.add(name)
    }
    managedStyles.set(editor, styled)
    root.contentEditable = String(editable)
    editor.setEditable(editable)
  }, [editor, editable, rest])
  // The native no-session workspace picker keeps React's keyboard handler.
  if (editor === null) return <div contentEditable={false} role="textbox" aria-multiline="true" data-composer-input {...rest} />
  return <div ref={mount} style={{ display: 'contents' }} data-project-draft-mount="" />
}
