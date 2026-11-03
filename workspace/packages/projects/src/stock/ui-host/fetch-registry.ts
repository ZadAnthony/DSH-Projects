/** Private, in-process Fetch contributions. No listener or second auth owner. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute, HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'

/**
 * Native FileUploads and media references register Fetch handlers even when the
 * caller uses their public methods. Keep those real contributions in this graph;
 * the explicit Projects upload bridge dispatches an authenticated request.
 * Browser admission belongs to PrivateSessionUiPort.uploadFetch; no root Agent resolver or credential owner is exposed here.
 */
export class PrivateSessionFetchRegistry extends Service {
  private readonly routes = new Map<string, ConnectionFetchRoute>()
  readonly fetch: HostConnectionFetch = {
    register: route => {
      if (this.routes.has(route.path)) throw new Error(`Projects private Fetch route already registered: ${route.path}`)
      this.routes.set(route.path, route)
      return async () => { if (this.routes.get(route.path) === route) this.routes.delete(route.path) }
    },
  }

  constructor(ctx: Context) {
    super(ctx, 'connection')
    ctx.effect(() => () => { this.routes.clear() }, 'projects.private-ui-fetch')
  }

  /** Dispatch is internal only; a transport must perform its own admission first. */
  async dispatch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    const route = this.routes.get(path)
    if (route === undefined) throw new Error(`Projects private Fetch route is not registered: ${path}`)
    if (!route.methods.some(method => method === request.method)) return new Response(null, { status: 405 })
    return route.fetch(request)
  }
}
