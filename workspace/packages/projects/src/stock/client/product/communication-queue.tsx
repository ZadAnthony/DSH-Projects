/** Projects saved-message presentation through the optional public queue row port. */
import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComponentType } from 'react'
import { ProjectCommunicationMessage } from '../../../client/ProjectCommunicationCard.tsx'
import type { QueueDockProps } from '../compat/input/client/queue/QueueDock.tsx'
import type { ProjectProductCommunicationPorts } from './tool-views.tsx'
import css from './communication-queue.module.css'

interface AdapterPorts {
  readonly native: ComponentType<QueueDockProps>
  readonly communication: ProjectProductCommunicationPorts
  readonly translateProjects: PropsLocale<'projects'>['t']
}

/** One native owner keeps queue order, total count, collapse, actions and local submissions. */
export function ProjectCommunicationQueueDock(props: QueueDockProps & AdapterPorts) {
  const Native = props.native
  return <Native {...props} presentationFor={row => row.source.kind !== 'project-delivery'
    ? undefined
    : { editable: false, content: <div className={css.content} data-project-communication-queue-row={row.id}>
      <ProjectCommunicationMessage {...props.communication} sessionId={props.sessionId}
        message={{ source: row.source, messageId: row.id }} loadImage={props.loadImage} t={props.translateProjects}
        renderOriginal={() => <span>{row.content.filter(part => part.type === 'text').map(part => part.text).join('')}</span>} />
    </div> }} />
}

/** Wrap the current public queue winner; retain its native injection and locale lifecycle. */
export function installProjectCommunicationQueue(ctx: Context, communication: ProjectProductCommunicationPorts): () => void {
  return ctx.slots.inject('conversation.input.dock', () => {
    let source: StoredEntry | undefined, close: (() => void) | undefined, updating = false, disposed = false
    const update = () => {
      if (disposed || updating) return
      updating = true
      try {
        const next = ctx.slots.entries('conversation.input.dock').find(entry => entry.options.id === 'queue' && entry.component !== ProjectCommunicationQueueDock)
        if (source === next) return
        source = next; close?.(); close = undefined
        if (next === undefined) return
        close = ctx.slots.register({ ...next.options, name: 'conversation.input.dock', priority: (next.options.priority ?? 0) - 1,
          locale: next.locale, store: next.store, select: next.select,
          inject: (...args: never[]) => ({ ...next.inject?.(...args), native: next.component, communication, translateProjects: ctx.locale.bind('projects') }),
        } as never, ProjectCommunicationQueueDock as never)
      } finally { updating = false }
    }
    const unsubscribe = ctx.slots.subscribe('conversation.input.dock', update)
    update()
    return () => { disposed = true; unsubscribe(); close?.() }
  })
}
