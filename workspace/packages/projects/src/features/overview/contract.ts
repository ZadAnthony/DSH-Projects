import type { RootWriteScope } from '../../metadata-contract.ts'
import type { LibraryFileLocation } from '../../library-contract.ts'
import type { NativeProjectSource } from '../../source-types.ts'

export interface OverviewRequest { readonly projectId: string }

/** 只保存原件定位；读取权限与实际内容仍由对应 owner 判定。 */
export type OverviewSourceRef =
  | { readonly kind: 'native'; readonly source: NativeProjectSource }
  | { readonly kind: 'library'; readonly location: LibraryFileLocation }
  | { readonly kind: 'session'; readonly id: string }
  | { readonly kind: 'memory'; readonly topicId: string }

/** 普通文字结构，不解释 HTML、脚本或可执行页面。 */
export type OverviewContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'list'; readonly items: readonly string[] }
  | { readonly type: 'table'; readonly columns: readonly string[]; readonly rows: readonly (readonly string[])[] }

export interface OverviewBlockInput {
  readonly id: string
  readonly title: string
  /** 主会话维护的扫读概况，与本区块完整正文同源；缺省时不自动生成。 */
  readonly summary?: string
  readonly content: OverviewContent
  readonly sources: readonly OverviewSourceRef[]
}

export interface OverviewBlock extends OverviewBlockInput {
  readonly updatedAt: string
  readonly updatedBySessionId: string
}

/** 项目整体正文的唯一保存处；没有另一份 goal 或逐项业务状态。 */
export interface OverviewDocument {
  readonly schemaVersion: 2
  readonly projectId: string
  readonly blocks: readonly OverviewBlock[]
  readonly updatedAt?: string
  readonly updatedBySessionId?: string
}

export interface OverviewDocumentRead {
  readonly status: 'available' | 'missing'
  readonly document: OverviewDocument
}

/** 只供真实模型输入组装读取，不展开来源或复制 Memory 正文。 */
export type OverviewContext =
  | (OverviewDocumentRead & { readonly projectId: string; readonly readAt: string })
  | { readonly projectId: string; readonly status: 'unreadable'; readonly message: string; readonly readAt: string }

/** 必须由核心从真实请求/Agent 绑定获得，不能相信工具参数或浏览器 JSON 的角色。 */
export interface OverviewAccess {
  readonly projectId: string
  readonly actor:
    | { readonly kind: 'user' }
    | { readonly kind: 'session'; readonly sessionId: string; readonly role: 'main' | 'execution'; readonly hostSessionId?: string }
}

export type OverviewOwnerRead<T> =
  | { readonly status: 'available'; readonly value: T; readonly readAt: string }
  | { readonly status: 'missing' | 'unreadable' | 'unavailable'; readonly message: string; readonly readAt: string }

export interface OverviewSessionFact {
  readonly id: string
  readonly projectId: string
  readonly hostSessionId: string
  readonly role: 'main' | 'execution'
  readonly title: string
  readonly archived: boolean
}

/** 设置与看板共用这些 Core 事实；正文不在这里重复保存。 */
export interface OverviewProjectFacts {
  readonly projectId: string
  readonly name: string
  readonly projectRoot: string
  readonly workspace?: string
  readonly archived: boolean
  readonly sessions: readonly OverviewSessionFact[]
}

export interface OverviewRuntimeFact {
  readonly sessionId: string
  readonly state: 'running' | 'idle' | 'unknown'
  readonly observedAt: string
  readonly reason?: string
}

/** 导航只有查看含义，不携带发送、执行、批准或修复动作。 */
export type OverviewNavigation =
  | { readonly kind: 'source'; readonly reference: OverviewSourceRef }
  | { readonly kind: 'session'; readonly sessionId: string }

export interface OverviewLink {
  readonly label: string
  readonly target: OverviewNavigation
}

export interface OverviewRow {
  readonly id: string
  readonly title: string
  readonly fields: readonly { readonly label: string; readonly value: string }[]
  readonly links: readonly OverviewLink[]
  readonly ownerUpdatedAt?: string
  readonly limitations?: readonly string[]
}

/** 来源只在本次读取中展示；不回写为正文或下一次的来源缓存。 */
export interface OverviewSourceView {
  readonly projectId: string
  readonly reference: OverviewSourceRef
  readonly label: string
  readonly status: 'available' | 'missing' | 'unreadable' | 'unavailable'
  readonly readAt: string
  readonly rows: readonly OverviewRow[]
  readonly message?: string
  readonly limitations?: readonly string[]
}

export interface OverviewView {
  readonly projectId: string
  readonly document: OverviewDocument
  readonly documentStatus: OverviewDocumentRead['status']
  readonly project: OverviewOwnerRead<OverviewProjectFacts>
  readonly runtime: OverviewOwnerRead<readonly OverviewRuntimeFact[]>
  readonly blocks: readonly { readonly block: OverviewBlock; readonly sources: readonly OverviewSourceView[] }[]
  /** 各来源不构成同一时刻的原子快照。 */
  readonly loadedAt: string
}

/** Core 提供只读事实与短期元数据写入核验；不能创建/唤醒 Agent、模型或修改来源。 */
export interface OverviewCorePort {
  resolveAccess(request: OverviewRequest): Promise<OverviewAccess>
  /** Production Core freshly verifies the prepared main carrier and lifecycle before the owner mutation. */
  withMetadataWrite<T>(request: OverviewRequest, prepared: OverviewAccess, action: (scope: RootWriteScope) => Promise<T>): Promise<T>
  readProjectFacts(access: OverviewAccess): Promise<OverviewOwnerRead<OverviewProjectFacts>>
  /** 对每种定位核实本项目归属，返回当前原件/入口与真实失败原因。 */
  readSource(access: OverviewAccess, reference: OverviewSourceRef): Promise<OverviewSourceView>
  /** Recheck retained native identities once before publishing a combined source view. */
  finalizeSources?(access: OverviewAccess, sources: readonly OverviewSourceView[]): Promise<readonly OverviewSourceView[]>
  readRuntime?(access: OverviewAccess): Promise<OverviewOwnerRead<readonly OverviewRuntimeFact[]>>
}

/** 浏览器仅可读取；写方法只交给主会话工具。 */
export interface OverviewClientActions { read(request: OverviewRequest): Promise<OverviewView> }
