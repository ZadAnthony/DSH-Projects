import type { ProjectSession } from '../../records-types.ts'
import type {
  ProjectUsageQuery, ProjectUsageResult, UsageGap, UsageGroup, UsageMetricKey,
  UsageMetrics, UsageRoute, UsageSession,
} from './contract.ts'
import type { NativeUsageRead, NativeUsageTurn } from './native.ts'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { UsageSourceBinding } from './lineage.ts'
import { withNativeUsageObservation } from './native.ts'
import { waitForUsageConsumer } from './cancellation.ts'

export interface ProjectUsageScope {
  readonly projectId: string
  /** 必须来自当前 ProjectStore 快照，含归档会话；不从原生会话名称推测归属。 */
  readonly sessions: readonly UsageSourceBinding[]
  readonly gaps?: readonly UsageGap[]
  /** owner 已知但尚未绑定到上述会话的自动协调、定时等来源。 */
  readonly missingSources?: readonly string[]
}

export interface ProjectUsagePorts {
  resolveProject(projectId: string, sessionId?: string, signal?: AbortSignal): Promise<ProjectUsageScope>
  readSession(hostSessionId: string, expected?: SessionHeader, signal?: AbortSignal): Promise<NativeUsageRead>
  now?: () => number
}

interface Row {
  readonly sessionId: string
  readonly role: UsageSession['role']
  readonly child?: UsageSession['child']
  readonly turn: NativeUsageTurn
  readonly route: UsageRoute | null
}
const keys: readonly UsageMetricKey[] = [
  'totalTokens', 'uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens',
]
const notes = [
  '统计当前项目原绑定会话及主／执行会话可正向追溯的原生子Agent新增已报告用量；含主会话各段、执行会话、共享记忆后台维护、会话管理后台判断，以及这些会话内的自动协调和定时运行。',
  '会话按真实轮次结束时间、辅助请求按用量报告时间筛选；未结束轮次单列结束时间未知。起点包含、终点不包含，每日分组使用 UTC。',
  '已报告小计与缺报可以属于同一轮；轮次未结束、失败或取消不抹去此前报告。可得轮数与缺报轮数可以重叠。分叉继承历史不重复计入，同一原生创建来源只计一次，当前上下文估算不作为累计消耗。',
  '缓存读取、缓存写入与未缓存输入互不重叠；思考已包含在输出中，不再次相加。',
  '一个轮次涉及多个模型或重试未记录模型时，整轮只计入“模型未能拆分”，不分摊或重复计入各模型。',
  '辅助压缩与标题请求使用原生记录的独立模型和用量；标题或摘要内容被拒绝、取消或提交失败，不抹去接收器已经接纳的报告。',
  '辅助请求缺报保留未知，不能由请求次数推断收费；其它未记录的辅助调用不在可证明范围内。',
]

/** 只读、无持久化的即时汇总；原生日志与 ProjectStore 仍是唯一来源。 */
export class ProjectUsageService {
  constructor(private readonly ports: ProjectUsagePorts) {}

  query(input: ProjectUsageQuery, signal?: AbortSignal): Promise<ProjectUsageResult> {
    signal?.throwIfAborted()
    return waitForUsageConsumer(withNativeUsageObservation(() => this.queryObserved(input, signal)), signal)
  }

  private async queryObserved(input: ProjectUsageQuery, signal?: AbortSignal): Promise<ProjectUsageResult> {
    const query = validateQuery(input)
    const scope = await this.ports.resolveProject(query.projectId, query.sessionId, signal)
    signal?.throwIfAborted()
    if (scope.projectId !== query.projectId) throw new Error('用量来源不属于当前项目。')
    // 不读取外部项目，即使调用方误把混合列表交到此处。
    const bindings = scope.sessions.filter(session => session.projectId === query.projectId)
    if (query.sessionId !== undefined && !bindings.some(session => session.id === query.sessionId)) {
      throw new Error('该会话不属于当前项目。')
    }
    const selected = bindings.filter(session => query.sessionId === undefined || session.id === query.sessionId)
    const lineageGaps = (scope.gaps ?? []).filter(gap => query.sessionId === undefined || gap.sessionId === undefined || gap.sessionId === query.sessionId)
    const gaps: UsageGap[] = [...(scope.missingSources ?? []).map(message => ({ code: 'unbound-source' as const, message })), ...lineageGaps]
    const unique = new Map<string, (typeof selected)[number]>()
    for (const binding of selected) {
      if (unique.has(binding.hostSessionId)) {
        gaps.push({ code: 'duplicate-binding', sessionId: binding.id, message: `${binding.title} 与另一会话指向同一原生记录，只计一次。` })
      } else unique.set(binding.hostSessionId, binding)
    }
    const rows: Row[] = []
    const sessions: UsageSession[] = []
    const routeOptions = new Map<string, UsageRoute>()
    let missingTurns = 0
    let missingAuxiliaryRequests = 0
    let missingSources = (scope.missingSources ?? []).length + lineageGaps.filter(gap => gap.code !== 'duplicate-binding').length
    // Session summaries add all of a logical session's carriers. Attach each
    // unresolved descendant once so that this subtotal stays visibly partial.
    const sessionGaps = new Map<string, number>()
    for (const gap of lineageGaps) if (gap.sessionId !== undefined && gap.code !== 'duplicate-binding') {
      sessionGaps.set(gap.sessionId, (sessionGaps.get(gap.sessionId) ?? 0) + 1)
    }
    for (const binding of unique.values()) {
      signal?.throwIfAborted()
      const sessionUnknownSources = sessionGaps.get(binding.id) ?? 0
      sessionGaps.delete(binding.id)
      const observedAt = this.now()
      let source: NativeUsageRead
      try { source = await this.ports.readSession(binding.hostSessionId, binding.expectedHeader, signal) }
      catch { signal?.throwIfAborted(); source = { kind: 'unavailable', hostSessionId: binding.hostSessionId, observedAt, reason: 'unreadable' } }
      signal?.throwIfAborted()
      if (source.hostSessionId !== binding.hostSessionId) {
        source = { kind: 'unavailable', hostSessionId: binding.hostSessionId, observedAt, reason: 'invalid-log' }
      }
      if (source.kind === 'unavailable') {
        missingSources += 1
        gaps.push({ code: source.reason === 'invalid-log' ? 'invalid-log' : 'unreadable', sessionId: binding.id,
          message: `${binding.title}：当前无法读取原生用量，未按零计入。` })
        sessions.push({
          key: `${binding.id}:${binding.hostSessionId}`, hostSessionId: binding.hostSessionId, label: usageSessionTitle(binding), sessionId: binding.id, role: binding.role, ...(binding.child === undefined ? {} : { child: binding.child }),
          source: 'unavailable', observedAt: source.observedAt, lastEventAt: null, cursor: null,
          excludedInheritedEvents: 0, nativeReported: null, reportedTurns: 0, reportedAuxiliaryRequests: 0, tokens: aggregate([], 1 + sessionUnknownSources),
        })
        continue
      }
      const sessionRows: Row[] = []
      for (const turn of source.turns) {
        for (const route of turn.route === undefined ? turn.reportedUsage?.routes ?? turn.usage?.routes ?? [] : [turn.route]) routeOptions.set(routeKey(route), route)
        if (!inPeriod(turn, query)) continue
        const routes = turn.reportedUsage === undefined ? turn.usage?.routes : turn.reportedUsage.routes
        const route = turn.route ?? (routes?.length === 1 ? routes[0]! : null)
        // summary 即使用量缺报仍可能有精确路由；已知属于其它模型的记录不污染当前筛选。
        if (route !== null && !matchesModel(route, query.model)) continue
        const location = turn.kind === 'compaction' ? '辅助压缩记录' : turn.kind === 'title' ? '标题辅助请求' : `第 ${turn.turn} 轮`
        const identity = { sessionId: binding.id, ...(turn.turn === null ? {} : { turn: turn.turn }),
          ...(isAuxiliary(turn) ? { source: turn.kind } : {}) }
        // 未知模型的用量不会伪装成已选模型；同时保留无法归属的缺口。
        if (route === null && (metricValue(turn, 'totalTokens') ?? 0) > 0) {
          gaps.push({ code: 'unattributed-model', ...identity,
            message: `${binding.title} ${location}：用量可得，但无法准确拆分到单个模型。` })
        }
        if (turn.usage === null) {
          if (isAuxiliary(turn)) missingAuxiliaryRequests += 1
          else missingTurns += 1
          gaps.push({ code: turn.reason ?? 'usage-unavailable', ...identity,
            message: `${binding.title} ${location}：${gapText(turn.reason)}，${hasReportedUsage(turn) ? '已有报告小计，仍有缺报' : isAuxiliary(turn) ? '该次辅助用量未知' : '该轮用量未知'}。` })
        }
        if (!matchesModel(route, query.model)) {
          if (route === null && (turn.usage === null || (metricValue(turn, 'totalTokens') ?? 0) > 0)) {
            const { reportedUsage: _reportedUsage, ...unreported } = turn
            const unknown = { sessionId: binding.id, role: binding.role, ...(binding.child === undefined ? {} : { child: binding.child }), turn: { ...unreported, usage: null }, route: null }
            rows.push(unknown); sessionRows.push(unknown)
          }
          continue
        }
        const row = { sessionId: binding.id, role: binding.role, ...(binding.child === undefined ? {} : { child: binding.child }), turn, route }
        rows.push(row); sessionRows.push(row)
      }
      const projection = source.projection
      sessions.push({
        key: `${binding.id}:${binding.hostSessionId}`, hostSessionId: binding.hostSessionId, label: usageSessionTitle(binding), sessionId: binding.id, role: binding.role, ...(binding.child === undefined ? {} : { child: binding.child }),
        source: source.source, observedAt: source.observedAt, lastEventAt: source.lastEventAt,
        cursor: source.cursor, excludedInheritedEvents: source.excludedInheritedEvents,
        // 累计投影无法证明缓存缺报与零的区别，也不能拆模型/时段，不把它加到分轮结果。
        nativeReported: projection === null ? null : {
          uncachedInputTokens: projection.uncachedInputTokens, outputTokens: projection.outputTokens,
        },
        reportedTurns: reportedCount(sessionRows, false), reportedAuxiliaryRequests: reportedCount(sessionRows, true),
        tokens: aggregate(sessionRows, sessionUnknownSources),
      })
    }
    const modelRows = new Map<string, Row[]>()
    const periodRows = new Map<string, Row[]>()
    const sourceRows = new Map<string, Row[]>()
    for (const row of rows) {
      const modelKey = row.route === null ? 'unattributed' : routeKey(row.route)
      append(modelRows, modelKey, row)
      append(sourceRows, row.child !== undefined ? isAuxiliary(row.turn) ? `subagent-${row.turn.kind}` : 'subagent' : row.role === 'session-manager' ? isAuxiliary(row.turn) ? `session-manager-${row.turn.kind}` : 'session-manager' : isAuxiliary(row.turn) ? row.turn.kind : 'turn', row)
      append(periodRows, row.turn.endedAt === null ? 'unknown-end'
        : new Date(row.turn.endedAt).toISOString().slice(0, 10), row)
    }
    // 无法读取来源时不知道发生在哪个模型/日期；占位只携带来源缺口，不虚构轮次。
    if (missingSources > 0) {
      if (!modelRows.has('unattributed')) modelRows.set('unattributed', [])
      if (!periodRows.has('unknown-end')) periodRows.set('unknown-end', [])
    }
    const readableSessions = sessions.filter(session => session.source !== 'unavailable').length
    const reportedTurns = reportedCount(rows, false)
    const reportedAuxiliaryRequests = reportedCount(rows, true)
    let rangeFrom = Infinity, rangeTo = -Infinity
    for (const row of rows) if (row.turn.endedAt !== null) {
      rangeFrom = Math.min(rangeFrom, row.turn.endedAt)
      rangeTo = Math.max(rangeTo, row.turn.endedAt)
    }
    return {
      projectId: query.projectId, query, refreshedAt: this.now(),
      observedRange: rangeFrom === Infinity ? null : { from: rangeFrom, to: rangeTo },
      tokens: aggregate(rows, missingSources), sessions,
      models: [...modelRows.entries()].map(([key, group]) => ({
        ...groupOf(key, key === 'unattributed' ? '模型未能拆分' : routeLabel(group[0]!.route!), group, missingSources),
        route: group[0]?.route ?? null,
      })),
      sources: [...sourceRows.entries()].map(([key, group]) => groupOf(key,
        key === 'subagent' ? '子Agent新增轮次（含重试）' : key === 'subagent-compaction' ? '子Agent辅助压缩请求' : key === 'subagent-title' ? '子Agent标题请求' : key === 'session-manager' ? '会话管理判断（含补读与重试）' : key === 'session-manager-compaction' ? '会话管理辅助压缩请求（原生记录）' : key === 'session-manager-title' ? '会话管理标题请求（原生记录）' : key === 'compaction' ? '辅助压缩请求（原生记录）' : key === 'title' ? '标题辅助请求（原生记录）' : '会话轮次（含重试）', group, missingSources)),
      periods: [...periodRows.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([key, group]) => groupOf(key, key === 'unknown-end' ? '结束时间未知' : key, group, missingSources)),
      options: {
        sessions: [...new Map(bindings.map(session => [session.id, { id: session.id, title: usageSessionTitle({ role: session.role, title: session.title }) }])).values()],
        models: [...routeOptions.values()],
      },
      coverage: {
        status: selected.length > 0 && readableSessions === 0 ? 'unavailable' : gaps.length > 0 ? 'partial' : 'reported',
        boundSessions: unique.size, readableSessions, reportedTurns, missingTurns,
        reportedAuxiliaryRequests, missingAuxiliaryRequests, missingSources, gaps, notes,
      },
      cost: { kind: 'unknown', reason: '尚无可信价格与完整计费规则，费用未知；这些用量不是账户账单。' },
    }
  }

  private now(): number { return (this.ports.now ?? Date.now)() }
}

function usageSessionTitle(session: Pick<ProjectSession, 'role' | 'title'> & { readonly child?: UsageSession['child'] }): string {
  if (session.child !== undefined) return `${session.title} · 子Agent ${session.child.label ?? session.child.hostSessionId}`
  return session.role === 'memory' ? `共享记忆后台维护 · ${session.title}` : session.role === 'session-manager' ? `会话管理后台判断 · ${session.title}` : session.title
}

function aggregate(rows: readonly Row[], unknownSources = 0): UsageMetrics {
  return Object.fromEntries(keys.map(key => {
    const values = rows.map(row => metricValue(row.turn, key))
    const known = values.filter((value): value is number => value !== undefined)
    let total = 0
    for (const value of known) { total += value; if (!Number.isSafeInteger(total)) throw new Error('用量合计超过可精确表示的范围。') }
    return [key, { reported: known.length === 0 && (rows.length > 0 || unknownSources > 0) ? null : total,
      unknownTurns: rows.filter(row => !isAuxiliary(row.turn) && metricMissing(row.turn, key)).length,
      unknownAuxiliaryRequests: rows.filter(row => isAuxiliary(row.turn) && metricMissing(row.turn, key)).length,
      unknownSources }]
  })) as unknown as UsageMetrics
}

function isAuxiliary(turn: NativeUsageTurn): turn is NativeUsageTurn & { readonly kind: 'compaction' | 'title' } { return turn.kind === 'compaction' || turn.kind === 'title' }

function metricValue(turn: NativeUsageTurn, key: UsageMetricKey): number | undefined {
  return turn.reportedUsage === undefined ? turn.usage?.[key] : turn.reportedUsage.reported[key]
}
function metricMissing(turn: NativeUsageTurn, key: UsageMetricKey): boolean {
  return turn.reportedUsage === undefined ? turn.usage?.[key] === undefined : turn.reportedUsage.missing.includes(key)
}
function hasReportedUsage(turn: NativeUsageTurn): boolean {
  return keys.some(key => metricValue(turn, key) !== undefined)
}

function append(groups: Map<string, Row[]>, key: string, row: Row): void {
  const group = groups.get(key) ?? []; group.push(row); groups.set(key, group)
}
function groupOf(key: string, label: string, rows: readonly Row[], unknownSources: number): UsageGroup {
  return { key, label, tokens: aggregate(rows, unknownSources), reportedTurns: reportedCount(rows, false),
    reportedAuxiliaryRequests: reportedCount(rows, true) }
}
function reportedCount(rows: readonly Row[], auxiliary: boolean): number {
  return rows.filter(row => (isAuxiliary(row.turn)) === auxiliary && hasReportedUsage(row.turn)).length
}
function inPeriod(turn: NativeUsageTurn, query: ProjectUsageQuery): boolean {
  if (turn.endedAt === null) return query.to === undefined || turn.startedAt < query.to
  return (query.from === undefined || turn.endedAt >= query.from) && (query.to === undefined || turn.endedAt < query.to)
}
function matchesModel(route: UsageRoute | null, filter: ProjectUsageQuery['model']): boolean {
  return filter === undefined || (filter === 'unattributed' ? route === null : route !== null && routeKey(route) === routeKey(filter))
}
function routeKey(route: UsageRoute): string { return JSON.stringify([route.provider, route.model]) }
function routeLabel(route: UsageRoute): string { return `${route.provider} / ${route.model}` }
function gapText(reason: NativeUsageTurn['reason']): string {
  return reason === 'incomplete-turn' ? '尚未结束或记录不完整'
    : reason === 'inherited-boundary' ? '继承边界穿过轮次，无法单独归属'
      : '缺少完整计量或用量记录冲突'
}

/** 请求可能来自浏览器；只接受精确对象及有效的时间边界。 */
function validateQuery(input: ProjectUsageQuery): ProjectUsageQuery {
  if (!input || typeof input !== 'object' || typeof input.projectId !== 'string' || input.projectId.length === 0) {
    throw new Error('请选择项目。')
  }
  if (input.sessionId !== undefined && (typeof input.sessionId !== 'string' || input.sessionId.length === 0)) throw new Error('会话筛选无效。')
  for (const value of [input.from, input.to]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000)) throw new Error('时间范围无效。')
  }
  if (input.from !== undefined && input.to !== undefined && input.from >= input.to) throw new Error('结束时间须晚于开始时间。')
  const model = input.model
  if (model !== undefined && model !== 'unattributed' && (model === null || typeof model !== 'object'
    || typeof model.provider !== 'string' || !model.provider || typeof model.model !== 'string' || !model.model)) throw new Error('模型筛选无效。')
  return {
    projectId: input.projectId, ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.from === undefined ? {} : { from: input.from }), ...(input.to === undefined ? {} : { to: input.to }),
    ...(model === undefined ? {} : { model: model === 'unattributed' ? model : { provider: model.provider, model: model.model } }),
  }
}
