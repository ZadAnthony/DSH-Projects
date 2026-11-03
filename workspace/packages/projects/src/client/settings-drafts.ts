import { projectCopy, type ProjectsTranslate } from './ui/copy.ts'
import { useEffect, useRef } from 'react'

/** A settings object owns its draft; navigation asks once before discarding any object. */
export interface SettingsDraftState {
  readonly dirty: boolean
  readonly busy: boolean
  readonly discard: () => void
}
export type RegisterSettingsDraftGuard = (key: string, read: () => SettingsDraftState) => () => void

export function useSettingsDraftGuard(register: RegisterSettingsDraftGuard | undefined, key: string, state: SettingsDraftState): void {
  const latest = useRef(state)
  latest.current = state
  useEffect(() => register?.(key, () => latest.current), [register, key])
}

export function discardSettingsDrafts(states: readonly SettingsDraftState[], translate?: ProjectsTranslate): boolean {
  if (states.some(state => state.busy)) return false
  const dirty = states.filter(state => state.dirty)
  if (dirty.length > 0 && !window.confirm(projectCopy(translate)("p3.memory.unsaved.description"))) return false
  dirty.forEach(state => state.discard())
  return true
}

/** Apply a discard already approved by the current UI; still reject busy objects. */
export function applySettingsDraftDiscards(states: readonly SettingsDraftState[]): boolean {
  if (states.some(state => state.busy)) return false
  states.filter(state => state.dirty).forEach(state => state.discard())
  return true
}
