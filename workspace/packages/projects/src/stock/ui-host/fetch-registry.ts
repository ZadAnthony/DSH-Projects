/** Private, in-process Fetch contributions. No listener or second auth owner. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute, ConnectionRpcEndpointMatcher, ConnectionRpcHandler, HostConnectionFetch, HostConnectionRpc, PeerScope } from '@deepseek-ai/dsh-client-connection'

/**
 * Native FileUploads and media references register Fetch handlers even when the
 * caller uses their public methods. Keep those real contributions in this graph;
 * the explicit Projects upload bridge dispatches an authenticated request.
 * Browser admission belongs to PrivateSessionUiPort.uploadFetch; no root Agent resolver or credential owner is exposed here.
 */
export class PrivateSessionFetchRegistry extends Service {
  private readonly routes = new Map<string, ConnectionFetchRoute>()
  private readonly channels = new Map<string, ConnectionRpcHandler>()
  private readonly interceptors = new Set<{ matches: ConnectionRpcEndpointMatcher; handler: ConnectionRpcHandler }>()
  readonly rpc: HostConnectionRpc = {
    handle: (channel, handler) => {
      if (this.channels.has(channel)) throw new Error(`Projects private RPC channel already registered: ${channel}`)
      this.channels.set(channel, handler)
      return async () => { if (this.channels.get(channel) === handler) this.channels.delete(channel) }
    },
    intercept: (channel, matches, handler) => {
      if (channel !== '/api') throw new Error(`Projects private RPC interceptor channel is invalid: ${channel}`)
      const entry = { matches, handler }
      this.interceptors.add(entry)
      return async () => { this.interceptors.delete(entry) }
    },
  }
  readonly fetch: HostConnectionFetch = {
    register: route => {
      if (this.routes.has(route.path)) throw new Error(`Projects private Fetch route already registered: ${route.path}`)
      this.routes.set(route.path, route)
      return async () => { if (this.routes.get(route.path) === route) this.routes.delete(route.path) }
    },
  }

  constructor(ctx: Context) {
    super(ctx, 'connection')
    ctx.effect(() => () => { this.routes.clear(); this.channels.clear(); this.interceptors.clear() }, 'projects.private-ui-fetch')
  }

  /** Internal decoded transport; the containing Projects boundary owns admission. */
  async dispatchRpc(channel: string, endpoint: string, payload: unknown, signal: AbortSignal, peer: PeerScope) {
    signal.throwIfAborted()
    const interceptor = channel === '/api' ? [...this.interceptors].find(entry => entry.matches(endpoint)) : undefined
    const handler = interceptor?.handler ?? this.channels.get(channel)
    if (handler === undefined) throw new Error(`Projects private RPC endpoint is not registered: ${channel}/${endpoint}`)
    return handler(endpoint, payload, signal, peer)
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
