/** Read-only native child attribution. Catalog publication, not header lineage alone, establishes an edge. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { sameOwnedCreationHeader } from '../../stock/control/identity.ts'
import type {} from '../../stock/read/index.ts'
import type { SubagentCatalogEntry } from '@deepseek-ai/dsh-subagent'
import type { ProjectSession, SessionOwnedLifecycle } from '../../records-types.ts'
import type { UsageChildIdentity, UsageGap } from './contract.ts'
import { readNativeUsageObservation } from './native.ts'

/** One physical source attributed to an existing Project logical session. */
export type UsageSourceBinding = Pick<ProjectSession, 'id' | 'projectId' | 'hostSessionId' | 'title' | 'role'> & {
  readonly expectedHeader?: SessionHeader
  readonly child?: UsageChildIdentity
  readonly discoverChildren?: boolean
  readonly retainedOwned?: SessionOwnedLifecycle
}

/** One immutable observation used only to verify native ownership. */
export interface UsageLineagePrefix {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
  readonly inherited: number
  readonly children: readonly SubagentCatalogEntry[]
  /** Projects' already-folded facts allow the source body to be released immediately. */
  readonly eventCount?: number
  readonly descriptorFact?: { readonly count: number; readonly value?: Pick<NonNullable<ReturnType<typeof foldSubagentDescriptor>>, 'mode' | 'label' | 'provider'> }
}

/** Header-first access refuses a foreign creation before any child body is requested. */
export interface UsageLineagePorts {
  stat(id: string, signal?: AbortSignal): Promise<SessionHeader | undefined>
  read(id: string, expected: SessionHeader, signal?: AbortSignal): Promise<UsageLineagePrefix>
}

interface Attribution { readonly projectId: string; readonly rootHeader: SessionHeader; readonly header: SessionHeader; readonly child: boolean }
interface Edge { readonly id: string; readonly createdAt: number; readonly mode: string; readonly label?: string; readonly retained?: SessionOwnedLifecycle['members'][number] }

/** Compose public native observation services; neither this adapter nor discovery flushes or wakes Agents. */
export function nativeUsageLineagePorts(ctx: Context): UsageLineagePorts {
  return {
    stat: async (id, signal) => ctx.get('projectsRead') === undefined ? (await ctx.sessionPersistence.stat(SessionId(id), { signal }))?.header
      : ctx.projectsRead.withDirectory(SessionId(id), observation => observation.directory.header, { signal }),
    read: async (id, expected, signal) => {
      signal?.throwIfAborted()
      const reader = ctx.get('projectsRead')
      if (reader !== undefined) {
        const observation = await readNativeUsageObservation(ctx, id, Date.now, signal)
        if (!sameOwnedCreationHeader(observation.header, expected)) throw new Error('Project child creation changed')
        return { header: observation.header, events: [], inherited: observation.inherited, eventCount: observation.eventCount,
          children: observation.children, descriptorFact: observation.descriptorFact }
      }
      using observation = await ctx.sessionQuery.observeSession(SessionId(id), { projectionMode: 'all', signal })
      signal?.throwIfAborted()
      if (!sameOwnedCreationHeader(observation.header, expected)) throw new Error('Native creation changed during lineage observation.')
      const children = observation.projections?.values.subagentCatalog
      if (children === undefined) throw new Error('Native parent catalog projection is unavailable.')
      let events = observation.events, inherited = Number(observation.inheritedEventCount)
      if (observation.source === 'prepared') {
        const handle = await ctx.sessionPersistence.open(SessionId(id), 'read', { signal })
        try {
          if (!sameOwnedCreationHeader(handle.header, expected) || handle.inheritedEventCount !== observation.inheritedEventCount) throw new Error('Native durable creation or inherited cut changed.')
          events = (await handle.read(0, undefined, { signal })).events
          signal?.throwIfAborted()
          inherited = Number(handle.inheritedEventCount)
        } finally { await handle.close() }
      }
      return { header: observation.header, events, inherited, children }
    },
  }
}

/** Positive identity cache serves refresh notices only; reports remain in native logs. */
export class ProjectUsageLineage {
  private readonly notifications = new Map<string, readonly Attribution[]>()
  constructor(private readonly ports: UsageLineagePorts) {}

  /** Resolve current exact source identities without adding Project records or changing native lifecycles. */
  async expand(projectId: string, bindings: readonly UsageSourceBinding[], sessionId?: string, signal?: AbortSignal): Promise<{ sessions: UsageSourceBinding[]; gaps: UsageGap[] }> {
    signal?.throwIfAborted()
    const sessions = bindings.filter(binding => binding.projectId === projectId).map(binding => ({ ...binding }))
    const gaps: UsageGap[] = []
    const attributions: Attribution[] = []
    const attributedIds: string[] = []
    const claims = new Map<string, string>()
    const originals = new Set(sessions.map(binding => binding.hostSessionId))
    // Store creation identities can route catalog refreshes before asynchronous discovery completes.
    // This records no child membership and never supplies usage or execution authority.
    for (const root of sessions) if (root.discoverChildren && root.expectedHeader !== undefined && String(root.expectedHeader.id) === root.hostSessionId) {
      const attribution = { projectId, rootHeader: root.expectedHeader, header: root.expectedHeader, child: false }
      const entries = this.notifications.get(root.hostSessionId) ?? []
      this.notifications.set(root.hostSessionId, [...entries.filter(entry => entry.projectId !== projectId || entry.child), attribution])
      attributions.push(attribution); attributedIds.push(root.hostSessionId)
    }
    const gap = (root: UsageSourceBinding, id: string, message: string): void => {
      gaps.push({ code: 'unverified-source', source: 'subagent', sessionId: root.id, hostSessionId: id, message: `${root.title}：${message}；子来源范围未知，未按零计入。` })
    }
    const note = (rootHeader: SessionHeader, header: SessionHeader, child: boolean): void => {
      attributions.push({ projectId, rootHeader, header, child }); attributedIds.push(String(header.id))
    }
    for (const root of sessions.slice()) {
      signal?.throwIfAborted()
      if (!root.discoverChildren || (root.role !== 'main' && root.role !== 'execution') || (sessionId !== undefined && root.id !== sessionId)) continue
      const expected = root.expectedHeader
      if (expected === undefined) { gap(root, root.hostSessionId, '缺少原承载创建身份，直接根已报量仍照常读取'); continue }
      if (String(expected.id) !== root.hostSessionId) { gap(root, root.hostSessionId, 'Store承载创建身份不一致'); continue }
      const retained = root.retainedOwned !== undefined && sameOwnedCreationHeader(root.retainedOwned.rootHeader, expected) ? root.retainedOwned.members : []
      const visited = new Set<string>()
      const known = new Map<string, UsageLineagePrefix>()
      const readPrefix = async (id: string, header: SessionHeader): Promise<UsageLineagePrefix> => {
        signal?.throwIfAborted()
        const cached = known.get(id)
        if (cached !== undefined) return cached
        const prefix = await this.ports.read(id, header, signal)
        signal?.throwIfAborted()
        known.set(id, prefix)
        return prefix
      }
      const visit = async (header: SessionHeader, depth: number): Promise<void> => {
        signal?.throwIfAborted()
        const parentId = String(header.id)
        if (visited.has(parentId)) { gap(root, parentId, '原生catalog存在重复或循环关系'); return }
        visited.add(parentId)
        let prefix: UsageLineagePrefix | undefined
        try { prefix = await readPrefix(parentId, header) }
        catch { signal?.throwIfAborted(); gap(root, parentId, '父catalog或来源不可读') }
        const edges: Edge[] = (prefix?.children ?? []).map(child => ({ id: String(child.id), createdAt: child.createdAt, mode: child.mode, ...child.label === undefined ? {} : { label: child.label } }))
        // Native archive receipts retain already-confirmed positive identities when a parent is unavailable.
        for (const member of retained.filter(member => String(member.parentSessionId) === parentId)) {
          const existing = edges.find(edge => edge.id === String(member.header.id))
          if (existing === undefined) edges.push({ id: String(member.header.id), createdAt: member.header.createdAt, mode: member.mode, retained: member })
          else if (existing.createdAt !== member.header.createdAt) {
            gap(root, String(member.header.id), 'catalog与已确认owned创建身份冲突')
            edges.splice(edges.indexOf(existing), 1)
          } else {
            // mode is discovery metadata; the receipt contributes the exact creation header.
            edges[edges.indexOf(existing)] = { ...existing, mode: existing.mode === member.mode ? existing.mode : 'unknown', retained: member }
          }
        }
        const seenEdges = new Set<string>()
        for (const edge of edges) {
          signal?.throwIfAborted()
          if (seenEdges.has(edge.id)) { gap(root, edge.id, '同一parent的catalog重复声明child'); continue }
          seenEdges.add(edge.id)
          if (visited.has(edge.id) || originals.has(edge.id)) { gap(root, edge.id, 'child关系与已有根或祖先冲突'); continue }
          let child: SessionHeader | undefined
          try { child = await this.ports.stat(edge.id, signal) } catch { signal?.throwIfAborted(); /* Header unavailability remains a source gap below. */ }
          signal?.throwIfAborted()
          if (child === undefined || String(child.id) !== edge.id || child.createdAt !== edge.createdAt || child.parentSession !== header.id
            || (edge.retained !== undefined && !sameOwnedCreationHeader(child, edge.retained.header))) {
            gap(root, edge.id, 'child创建身份或catalog对应关系无法核实'); continue
          }
          let own: UsageLineagePrefix
          try { own = await readPrefix(edge.id, child) }
          catch { signal?.throwIfAborted(); gap(root, edge.id, 'child来源或后代catalog不可读'); continue }
          if (!sameOwnedCreationHeader(own.header, child) || !Number.isSafeInteger(own.inherited) || own.inherited < 0 || own.inherited > (own.eventCount ?? own.events.length)) {
            gap(root, edge.id, 'child创建身份或继承切点不一致'); continue
          }
          // Catalog publication proves creation ownership. Descriptor fields describe execution;
          // deletion/continuation qualification is deliberately not required for read-only usage.
          const suffix = own.events.slice(own.inherited)
          let descriptor: Pick<NonNullable<ReturnType<typeof foldSubagentDescriptor>>, 'mode' | 'label' | 'provider'> | undefined = own.descriptorFact?.value
          if (own.descriptorFact === undefined) try { descriptor = foldSubagentDescriptor(suffix) } catch { /* Unknown description never discards known reports. */ }
          const descriptionMatches = (own.descriptorFact?.count ?? suffix.filter(event => event.type === 'subagent/descriptor').length) === 1
            && descriptor !== undefined && (edge.mode === 'unknown' || descriptor.mode === edge.mode)
            && (edge.label === undefined || descriptor.label === edge.label)
          const provider = descriptionMatches ? descriptor?.provider : undefined
          const claimed = claims.get(edge.id)
          if (claimed !== undefined && claimed !== root.id) { gap(root, edge.id, '同一native来源出现不同逻辑归属'); continue }
          if (claimed !== undefined) continue
          claims.set(edge.id, root.id)
          const identity: UsageChildIdentity = {
            kind: 'subagent', hostSessionId: edge.id, sessionCreatedAt: child.createdAt,
            rootHostSessionId: root.hostSessionId, parentHostSessionId: parentId, depth: depth + 1, mode: edge.mode === 'one-shot' || edge.mode === 'continuable' ? edge.mode : 'unknown',
            ...provider === undefined ? {} : { provider },
            ...edge.label === undefined ? {} : { label: edge.label },
          }
          const binding: UsageSourceBinding = { id: root.id, projectId, hostSessionId: edge.id, title: root.title, role: root.role, expectedHeader: child, child: identity }
          sessions.push(binding); note(expected, child, true)
          await visit(child, depth + 1)
        }
      }
      try {
        const actual = await this.ports.stat(root.hostSessionId, signal)
        signal?.throwIfAborted()
        if (actual === undefined || !sameOwnedCreationHeader(actual, expected)) { gap(root, root.hostSessionId, 'root原创建身份已变化'); continue }
        note(expected, actual, false)
        await visit(actual, 0)
      } catch { signal?.throwIfAborted(); gap(root, root.hostSessionId, '原生归属读取未完成') }
    }
    signal?.throwIfAborted()
    for (const [id, entries] of this.notifications) {
      const kept = entries.filter(entry => entry.projectId !== projectId || sessions.some(binding => binding.discoverChildren && binding.expectedHeader !== undefined
        && sameOwnedCreationHeader(binding.expectedHeader, entry.rootHeader) && sessionId !== undefined && binding.id !== sessionId))
      if (kept.length) this.notifications.set(id, kept); else this.notifications.delete(id)
    }
    for (let index = 0; index < attributions.length; index++) {
      const id = attributedIds[index]!, entries = this.notifications.get(id) ?? []
      const attribution = attributions[index]!
      this.notifications.set(id, [...entries.filter(entry => entry.projectId !== projectId || entry.child !== attribution.child
        || !sameOwnedCreationHeader(entry.rootHeader, attribution.rootHeader) || !sameOwnedCreationHeader(entry.header, attribution.header)), attribution])
    }
    return { sessions, gaps }
  }

  /** Only known same-creation children or their parents' new catalog facts trigger a Project re-read. */
  projectsForEvent(header: SessionHeader, type: string): readonly string[] {
    const relevant = type === 'subagent/catalog' || type === 'turn/end' || type === 'assistant/progress' || type === 'assistant/message'
      || type === 'assistant/attempt' || type === 'projects/model-request-usage' || type === 'projects/model-request-end' || type === 'session/title-llm-request'
      || type === 'compaction/summary' || type === 'compaction/end'
    if (!relevant) return []
    return [...new Set((this.notifications.get(String(header.id)) ?? []).filter(entry => (entry.child || type === 'subagent/catalog')
      && sameOwnedCreationHeader(entry.header, header)).map(entry => entry.projectId))]
  }
}
