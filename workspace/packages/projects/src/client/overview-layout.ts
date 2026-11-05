export const OVERVIEW_DEFAULT_WIDTH = 360
export const READING_DEFAULT_WIDTH = 520
export const OVERVIEW_MIN_WIDTH = 280
export const OVERVIEW_MAX_WIDTH = 480
export const READING_MAX_WIDTH = 560
export const CONVERSATION_MIN_WIDTH = 480

/** Resolve the physical workspace without obscuring its conversation or changing saved preferences. */
export function resolveOverviewLayout(availableWidth: number, preferredWidth: number, reading = false) {
  const available = Math.max(0, availableWidth)
  const mode = available >= CONVERSATION_MIN_WIDTH + OVERVIEW_MIN_WIDTH ? 'inline' : 'stacked'
  const minWidth = Math.min(OVERVIEW_MIN_WIDTH, available)
  const maxWidth = mode === 'inline'
    ? Math.min(reading ? READING_MAX_WIDTH : OVERVIEW_MAX_WIDTH, available - CONVERSATION_MIN_WIDTH)
    : available
  const width = mode === 'inline' ? Math.min(maxWidth, Math.max(minWidth, preferredWidth)) : available
  return { mode, minWidth, maxWidth, width, conversationWidth: mode === 'inline' ? available - width : available } as const
}
