import SessionTitleService, { type SessionTitleProvider, type SessionTitleSnapshot } from '@deepseek-ai/dsh-session-title'
import type { Session } from '@deepseek-ai/dsh-session'
import type { StockCapabilityOwnership } from './capabilities.ts'

/** Native cadence, fallback, validation and title persistence stay with the native service. */
export function createOwnedProjectTitles(ownership: StockCapabilityOwnership): typeof SessionTitleService {
  return class ProjectSessionTitleService extends SessionTitleService {
    static override inject = [...SessionTitleService.inject, 'agents']
    override register(provider: SessionTitleProvider): () => Promise<void> {
      return super.register({
        ...provider,
        generate: request => {
          const owner = this.ctx.agents.get(request.session.id)
          if (owner === undefined || owner.session !== request.session) return Promise.reject(new Error('Projects title generation has no exact live carrier'))
          try { ownership.assertAdmitting(owner.id, owner) } catch (error) { return Promise.reject(error) }
          const controller = new AbortController()
          const signal = AbortSignal.any([request.signal, controller.signal])
          const pending = Promise.resolve().then(async () => {
            signal.throwIfAborted()
            const result = await provider.generate({ ...request, signal })
            // An ignored cancellation still waits for the real provider. Its
            // stale result cannot become a new title after the stop cut.
            signal.throwIfAborted()
            return result
          })
          ownership.track({ owner, kind: 'title', cancel: () => controller.abort(new Error('Projects title owner is stopping')),
            done: pending.then(() => undefined, () => undefined) })
          return pending
        },
      })
    }
    override refresh(session: Session, upstream?: AbortSignal): Promise<SessionTitleSnapshot | undefined> {
      const owner = this.ctx.agents.get(session.id)
      if (owner === undefined || owner.session !== session) return Promise.reject(new Error('Projects title refresh has no exact live carrier'))
      try { ownership.assertAdmitting(owner.id, owner) } catch (error) { return Promise.reject(error) }
      const controller = new AbortController()
      const signal = upstream === undefined ? controller.signal : AbortSignal.any([upstream, controller.signal])
      const pending = super.refresh(session, signal)
      ownership.track({ owner, kind: 'title', cancel: () => controller.abort(new Error('Projects title refresh is stopping')),
        done: pending.then(() => undefined, () => undefined) })
      return pending
    }
  }
}
