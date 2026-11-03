import type { ProjectSnapshot, ProjectSessionRole } from './records-types.ts'

/** 单会话生命周期只消费核心的归属与状态，不另存 record.json。 */
export interface LifecycleTarget {
  readonly project: {
    readonly id: string
    readonly archived: boolean
  }
  readonly session: {
    readonly id: string
    readonly projectId: string
    readonly hostSessionId: string
    readonly role: 'main' | 'execution'
    readonly archived: boolean
  }
  /** 核心确认目标会话现有的全部定时设置数，包含停用设置；未知不能填零。 */
  readonly scheduledTaskCount: number
}

/** 精确操作一个执行会话；主会话生命周期必须由项目入口处理。 */
export interface ExecutionLifecycleRequest {
  readonly projectId: string
  readonly sessionId: string
}

/** 主会话与项目头共用的整项目生命周期入口。 */
export interface ProjectLifecycleActionRequest {
  readonly projectId: string
  readonly action: 'archive' | 'restore'
}

export type ProjectLifecycleStage =
  | 'complete'
  | 'schedule-preflight'
  | 'prepare-archive-targets'
  | 'stop-current-work'
  | 'schedule-post-stop'
  | 'save-project-archive'
  | 'prepare-project-restore'
  | 'save-project-restore'

export type ProjectSessionQuiescence =
  | 'settled'
  | 'no-live-instance'
  | 'already-session-archived'
  | 'unknown'
  | 'not-checked'

export interface ProjectLifecycleSessionOutcome {
  readonly sessionId: string
  readonly role: ProjectSessionRole
  readonly quiescence: ProjectSessionQuiescence
  readonly reason?: string
}

/** Runtime 内部结果保留 Store 的真实快照；Remote 再投影成 ProjectDetail。 */
export interface ProjectLifecycleChangeResult {
  readonly kind: 'archived' | 'restored' | 'unchanged' | 'failed'
  readonly stage: ProjectLifecycleStage
  readonly snapshot: ProjectSnapshot
  readonly sessions: readonly ProjectLifecycleSessionOutcome[]
  readonly admissionHeld: boolean
  readonly message: string
}

/** unchanged 只表示记录未变化，不额外证明宿主工作已经停止。 */
export interface LifecycleChangeResult {
  readonly kind: 'archived' | 'restored' | 'unchanged'
  readonly target: LifecycleTarget
}

export type LifecycleErrorCode =
  | 'LIFECYCLE_TARGET_MISMATCH'
  | 'LIFECYCLE_PROJECT_ACTION_REQUIRED'
  | 'LIFECYCLE_PROJECT_ARCHIVED'
  | 'LIFECYCLE_SCHEDULES_OUT_OF_SLICE'

/** 已确认的产品边界或当前功能片范围未满足；不发出部分宿主操作。 */
export class LifecycleBoundaryError extends Error {
  constructor(readonly code: LifecycleErrorCode, message: string) {
    super(message)
    this.name = 'LifecycleBoundaryError'
  }
}

export type LifecycleOperationStage = 'prepare-archive' | 'archive-host' | 'restore-host' | 'save-restore'

/**
 * 跨 Store/宿主没有全局事务；报出失败位置，不伪造成功、不回滚或自动重试。
 * 失败后由调用方重读 owner 和宿主实际状态，不能从本异常猜测写入是否落盘。
 */
export class LifecycleOperationError extends Error {
  constructor(readonly stage: LifecycleOperationStage, cause: unknown, readonly stoppedConfirmed = false) {
    super(`Execution session lifecycle failed at ${stage}`, { cause })
    this.name = 'LifecycleOperationError'
  }
}
