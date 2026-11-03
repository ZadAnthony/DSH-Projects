/** 浏览器安全的只读合同；不携带原生日志、聊天正文或宿主服务。 */
export interface UsageRoute { readonly provider: string; readonly model: string }

export interface ProjectUsageQuery {
  readonly projectId: string
  readonly sessionId?: string
  readonly model?: UsageRoute | 'unattributed'
  /** 毫秒时间戳，按完整轮次结束或辅助请求报告时间筛选：[from, to)。 */
  readonly from?: number
  readonly to?: number
}

export type UsageMetricKey = 'totalTokens' | 'uncachedInputTokens' | 'outputTokens'
  | 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens'

export interface UsageMetric {
  /** 仅对实际报告了该分类的请求求和；同一轮可同时有小计及缺报，没有可得值时为 null。 */
  readonly reported: number | null
  readonly unknownTurns: number
  /** 有原生辅助请求记录但用量不可得；不据此推断已发生收费。 */
  readonly unknownAuxiliaryRequests: number
  /** 整个来源不可读/未绑定，轮次数未知；不折算成缺失轮数。 */
  readonly unknownSources: number
}
export type UsageMetrics = Readonly<Record<UsageMetricKey, UsageMetric>>

export interface UsageGroup {
  readonly key: string
  readonly label: string
  readonly tokens: UsageMetrics
  /** 有任一已报告分类的轮次；可与 missingTurns 重叠。 */
  readonly reportedTurns: number
  readonly reportedAuxiliaryRequests: number
}

/** Real native child identity attributed to the existing logical session. */
export interface UsageChildIdentity {
  readonly kind: 'subagent'
  readonly hostSessionId: string
  readonly sessionCreatedAt: number
  readonly rootHostSessionId: string
  readonly parentHostSessionId: string
  readonly depth: number
  /** Catalog discovery field; unknown does not weaken established creation ownership. */
  readonly mode: 'one-shot' | 'continuable' | 'unknown'
  readonly provider?: string
  readonly label?: string
}

export interface UsageGap {
  readonly code: 'unreadable' | 'incomplete-turn' | 'usage-unavailable' | 'unattributed-model'
    | 'inherited-boundary' | 'duplicate-binding' | 'unbound-source' | 'invalid-log' | 'unverified-source'
  readonly message: string
  readonly sessionId?: string
  readonly turn?: number
  readonly source?: 'compaction' | 'title' | 'subagent'
  readonly hostSessionId?: string
}

export interface UsageSession extends UsageGroup {
  /** Actual carrier; sessionId remains the logical session. */
  readonly hostSessionId?: string
  readonly child?: UsageChildIdentity
  readonly sessionId: string
  readonly role: 'main' | 'execution' | 'memory' | 'session-manager'
  readonly source: 'live' | 'prepared' | 'unavailable'
  readonly observedAt: number
  readonly lastEventAt: number | null
  readonly cursor: number | null
  readonly excludedInheritedEvents: number
  /** 原生助手累计（不含辅助请求）仅作旁证，不参与任何分组或合计。 */
  readonly nativeReported: {
    readonly uncachedInputTokens: number
    readonly outputTokens: number
  } | null
}

export interface ProjectUsageResult {
  readonly projectId: string
  readonly query: ProjectUsageQuery
  readonly refreshedAt: number
  readonly observedRange: { readonly from: number; readonly to: number } | null
  readonly tokens: UsageMetrics
  readonly sessions: readonly UsageSession[]
  readonly models: readonly (UsageGroup & { readonly route: UsageRoute | null })[]
  readonly sources: readonly UsageGroup[]
  /** UTC 日期；按轮次结束或辅助请求报告时间分组。 */
  readonly periods: readonly UsageGroup[]
  readonly options: {
    readonly sessions: readonly { readonly id: string; readonly title: string }[]
    readonly models: readonly UsageRoute[]
  }
  readonly coverage: {
    readonly status: 'reported' | 'partial' | 'unavailable'
    /** Confirmed physical native sources, including attributable child sources; no new Project sessions. */
    readonly boundSessions: number
    readonly readableSessions: number
    readonly reportedTurns: number
    readonly missingTurns: number
    readonly reportedAuxiliaryRequests: number
    readonly missingAuxiliaryRequests: number
    readonly missingSources: number
    readonly gaps: readonly UsageGap[]
    readonly notes: readonly string[]
  }
  readonly cost: { readonly kind: 'unknown'; readonly reason: string }
}

/** UI 由现有 Host bridge 注入查询；可选订阅只通知刷新，不传另一份累计。 */
export interface ProjectUsageActions {
  query(query: ProjectUsageQuery, signal?: AbortSignal): Promise<ProjectUsageResult>
  subscribe?(projectId: string, refresh: () => void): () => void
}
