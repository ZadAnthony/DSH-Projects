/** Ordinary-user timing metadata derived from the existing native Inbox log. */
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { ProjectUserInputTiming } from './public-types.ts'

interface InputTimingEntry {
  readonly id: string
  readonly user: boolean
  readonly acceptedAt?: number
  readonly claimedAt?: number
}
interface UserInputTimingState {
  readonly 'next-turn': readonly InputTimingEntry[]
  readonly 'next-step': readonly InputTimingEntry[]
  readonly current: readonly InputTimingEntry[]
  /** One adjacent splice can move the same input between queues. */
  readonly removed: readonly InputTimingEntry[]
  readonly inTurn: boolean
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { 'projects/user-input-timing': UserInputTimingState }
}

const entry = z.object({ id: z.string(), user: z.boolean(), acceptedAt: z.number().int().optional(), claimedAt: z.number().int().optional() })
export const userInputTimingProjectionDefinition = {
  key: 'projects/user-input-timing', stateVersion: 1,
  stateSchema: z.object({ 'next-turn': z.array(entry).readonly(), 'next-step': z.array(entry).readonly(), current: z.array(entry).readonly(), removed: z.array(entry).readonly(), inTurn: z.boolean() }),
  init: (): UserInputTimingState => ({ 'next-turn': [], 'next-step': [], current: [], removed: [], inTurn: false }),
  apply(state, event): UserInputTimingState {
    if (event.type === 'turn/start') return { ...state, current: [], removed: [], inTurn: true }
    if (event.type === 'turn/end') return { ...state, current: [], removed: [], inTurn: false }
    if (event.type !== 'agent/inbox/spliced') return state.removed.length === 0 ? state : { ...state, removed: [] }
    const splice = event.data, pending = state[splice.target]
    const removed = pending.slice(splice.start, splice.start + (splice.removedCount ?? 0))
    let current = state.current
    if (state.inTurn && splice.outcome !== 'canceled') {
      const claimed = removed.filter(item => item.user).map(item => ({ ...item, claimedAt: event.time }))
      if (claimed.length > 0) current = [...current.filter(item => !claimed.some(value => value.id === item.id)), ...claimed]
    }
    const inserted = splice.inserted.map(message => {
      const id = String(message.id), user = message.source.kind === 'user'
      const previous = [...removed, ...state.removed, ...current].find(item => item.id === id && item.user === user)
      return { id, user, ...(user ? { acceptedAt: previous?.acceptedAt ?? event.time } : {}) }
    })
    return { ...state, [splice.target]: pending.toSpliced(splice.start, splice.removedCount ?? 0, ...inserted),
      current: current.filter(item => !inserted.some(value => value.id === item.id)), removed }
  },
} satisfies ProjectionDefinition<'projects/user-input-timing', UserInputTimingState>

/** Missing original stages stay missing; neither now nor consumed-message time is a fallback. */
export function userInputTiming(state: UserInputTimingState | undefined, messageId: string): ProjectUserInputTiming | undefined {
  const value = state?.current.find(item => item.id === messageId && item.user)
  if (value === undefined || value.acceptedAt === undefined && value.claimedAt === undefined) return undefined
  return {
    ...(value.acceptedAt === undefined ? {} : { acceptedAt: new Date(value.acceptedAt).toISOString() }),
    ...(value.claimedAt === undefined ? {} : { claimedAt: new Date(value.claimedAt).toISOString() }),
  }
}
