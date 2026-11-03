/** Running Turn clock isolated from the transcript's render cycle. */
import { memo, useEffect, useState, useSyncExternalStore } from 'react'
import { TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionPendingInteraction } from '@deepseek-ai/dsh-client-ui-session/client'
import type { PendingQuestion } from '@deepseek-ai/dsh-client-ui-user-questions/client'
import type {} from '@deepseek-ai/dsh-client-ui-approval/client'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { formatRunDuration, LIVE_RUN_CLOCK_INTERVAL_MS } from './message-chrome.ts'
import { RunningWhaleTail } from './RunningWhaleTail.tsx'
import a11yCss from './accessibility.module.css'
import css from './ChatView.module.css'

interface RunningStatusProps {
  readonly startTime: number | undefined
  readonly pendingInteraction?: SessionPendingInteraction | undefined
  readonly projectStatusText: ChatViewSlotProps['projectStatusText']
  readonly t: ChatViewSlotProps['t']
}

const EMPTY_QUESTION = {
  subscribe: () => () => {},
  getSnapshot: (): ReturnType<PendingQuestion['getSnapshot']> | undefined => undefined,
}

/**
 * Show live elapsed time after the current Turn's content without announcing ticks.
 * @param props - Current Turn start time and localized copy.
 * @returns the blue running indicator; mount only while the Session is running.
 */
export const RunningStatus = memo(function RunningStatus({ startTime, pendingInteraction, projectStatusText, t }: RunningStatusProps) {
  const question = pendingInteraction?.kind === 'question' || pendingInteraction?.kind === 'plan-review'
    ? pendingInteraction : undefined
  const card = useSyncExternalStore(question?.subscribe ?? EMPTY_QUESTION.subscribe,
    question?.getSnapshot ?? EMPTY_QUESTION.getSnapshot)
  // A late answerable card can coexist with a new model turn. Only a live
  // foreground waterfall means this turn is currently waiting for the user.
  const waiting = question !== undefined && card?.state === 'open'
    && card.channel === 'waterfall' && !card.closed
    ? question.kind
    : pendingInteraction?.kind === 'approval' && pendingInteraction.answerable ? 'approval' : undefined
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (startTime === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, LIVE_RUN_CLOCK_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [startTime])
  const status = waiting === 'question' ? projectStatusText('answer')
    : waiting === 'plan-review' ? projectStatusText('plan')
      : waiting === 'approval' ? projectStatusText('approval') : t('chat.deepDiving')
  const label = startTime === undefined ? status : projectStatusText('elapsed', {
    status,
    duration: formatRunDuration(Math.max(1000, now - startTime), t).map(part => part.text).join(''),
  })
  return (
    <div className={css.running} data-chat-running>
      <span className={a11yCss.visuallyHidden} role="status" aria-live="polite" aria-atomic="true">{status}</span>
      <span className={css.runningDivider} aria-hidden="true" />
      <span className={css.runningContent}>
        <RunningWhaleTail />
        <TextShimmer active={waiting === undefined} className={css.runningText}>{label}</TextShimmer>
      </span>
    </div>
  )
})
