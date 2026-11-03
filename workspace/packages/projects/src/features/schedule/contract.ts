import type { RootWriteScope } from '../../metadata-contract.ts'
import type { DurableMutationEffect, DurableMutationStage } from '../../metadata-errors.ts'
import type { ScheduleClockBoundary } from './power-facts.ts'
/** 浏览器安全合同。真实身份、管理授权和恢复事实均由核心提供，不接受模型自报角色。 */
export type ScheduleRule =
  | { kind: 'at'; date: string; time: string; timeZone: string }
  | { kind: 'after'; afterSeconds: number; timeZone: string }
  | { kind: 'every'; everySeconds: number; timeZone: string }
  | { kind: 'daily'; time: string; timeZone: string }
  | { kind: 'weekly'; time: string; timeZone: string; weekdays: number[] }
  | { kind: 'cron'; expression: string; timeZone: string }

export type ScheduleSource = import('../../source-reference-types.ts').NativeProjectSource
  | { kind: 'settings'; changeId: string }
  | { kind: 'record'; recordKind: string; recordId: string; revision: number }

export interface ScheduleRequest { projectId: string; caller: unknown; signal?: AbortSignal }
export interface ScheduleSession { id: string; hostSessionId: string; readonly carrierHostSessionIds?: readonly string[]; title: string; role: 'main' | 'execution'; archived: boolean }
export interface ScheduleAccess {
  projectId: string
  projectDirectory: string
  projectArchived: boolean
  sessions: readonly ScheduleSession[]
  /** session 的角色只从 sessions 中的真实绑定读取。 */
  actor: { kind: 'user' } | { kind: 'session'; sessionId: string; hostSessionId?: string }
  /** 真实用户决定、原始工具调用或实际设置操作的定位；不要求重新确认旧授权。 */
  managementSources: readonly ScheduleSource[]
  /** 真实工具调用身份；不接受模型自报的重试身份。 */
  manualRequestId?: string
}
export type ScheduleManager =
  | { kind: 'user'; sessionId?: never; sources: ScheduleSource[] }
  | { kind: 'session'; sessionId: string; sources: ScheduleSource[] }
export interface ProjectSchedule {
  id: string; projectId: string; sessionId: string; title: string; prompt: string
  rule: ScheduleRule
  /** 创建/显式改规则时的原始锚点，恢复不得重新创建固定间隔。 */
  anchorAt: string
  enabled: boolean; revision: number; createdAt: string; updatedAt: string
  /** 最近一次真实启用设置的时刻；不代表运行锁或宿主已可用。 */
  enabledSince?: string
  /** 最近一次显式取消未开始项的修订；字段名兼容，普通编辑、重新启用不清除。 */
  manualCancelRevision?: number
  createdBy: ScheduleManager; updatedBy: ScheduleManager
}
export interface SaveScheduleInput {
  id?: string; expectedRevision?: number; sessionId: string
  title: string; prompt: string; rule: ScheduleRule; enabled: boolean
}
export type ScheduleRunRef =
  | { kind: 'message'; hostSessionId: string; messageId: string }
  | { kind: 'turn'; hostSessionId: string; turn: number }
  | { kind: 'tool'; hostSessionId: string; toolCallId: string }
  | { kind: 'result'; recordId: string }
/** 只保存运行关联；聊天、成果和任务成功事实仍归原来源。 */
export interface ScheduleRunLink {
  id: string; scheduleId: string; projectId: string; sessionId: string
  plannedAt: string; observedAt: string; trigger: 'automatic' | 'manual'
  refs: ScheduleRunRef[]
  /** Host 实际发生的观察；不是重试/待执行状态，也不代表业务任务已达成。 */
  observation?: ScheduleRunObservation
}
export interface ScheduleRunObservation {
  occurrenceId: string; ruleIdentity: string; definitionRevision: number
  admission: 'not-enqueued' | 'enqueued' | 'unknown'
  outcome: 'missed-before-boundary' | 'not-started' | 'admission-unknown' | 'enqueued' | 'suppressed' | 'unknown'
  reason: string
  boundaryAt?: string; admittedAt?: string
  provenance?: 'controlled-fixture'
}
export interface ScheduleNativeRunView {
  messageId: string; inserted: boolean; claimed: boolean; discarded: boolean
  turn?: number; end?: string; error?: string
  timing?: ScheduleRunTiming
}
/** 原 source 与原生事件的时间；null 不用计划或读取时间补齐。 */
export interface ScheduleRunTiming {
  plannedAt: string
  plannedTimeBasis: 'automatic-slot' | 'manual-request'
  triggeredAt: string | null
  requestedAt: string | null
  queuedAt: string | null
  claimedAt: string | null
  processingStartedAt: string | null
  unknownFields: Array<'triggeredAt' | 'queuedAt' | 'claimedAt' | 'processingStartedAt'>
}
export type ScheduleRunStatus = 'unknown' | 'queued' | 'processing' | 'waiting-permission' | 'delivery-failed' | 'execution-failed' | 'not-achieved' | 'achieved'
export interface ScheduleRunView { link: ScheduleRunLink; status: ScheduleRunStatus; note?: string; native?: ScheduleNativeRunView; taskOutcome?: 'unknown' }
/** One request owns this immutable native observation; never retained across reads. */
export interface ScheduleRunReader {
  nativeLinks: ScheduleRunLink[]
  readStatus(link: ScheduleRunLink): Omit<ScheduleRunView, 'link'>
}
export interface ScheduleTimeView { kind: 'future' | 'expired-once' | 'exhausted'; nextAt?: string }
export interface ScheduleSnapshot {
  projectId: string; projectArchived: boolean
  /** 当前调用者可管理的真实目标；执行会话只含自己。 */
  targets: ScheduleSession[]
  schedules: Array<{ schedule: ProjectSchedule; time: ScheduleTimeView }>
  runs: ScheduleRunView[]
  automaticDispatch: 'not-connected' | 'connected'
  /** 最近一次真实取样，不把连接存在说成到点工作已完成。 */
  automaticAvailability?: { kind: 'available' | 'unavailable' | 'unknown'; observedAt?: string; reason?: string }
}
export interface SchedulePendingEffect {
  kind: 'applied' | 'unchanged' | 'unconfirmed' | 'not-connected'
  updatedMessageIds: string[]
  removedMessageIds: string[]
  error?: string
}
export interface SchedulePendingConsumer {
  assertCurrent(): void
  /** 保存确认后或冷读取的同一个 Store slot 内同步执行；不得重入 Store。 */
  apply(state: { schedules: ProjectSchedule[]; runs: ScheduleRunLink[] }): SchedulePendingEffect
  flush(): Promise<boolean>
  /** Release only this configuration preparation; it never wakes a target. */
  release?(): void
}
export interface ScheduleMetadataFailure {
  code: string
  stage: DurableMutationStage
  effect: DurableMutationEffect
  message: string
}
export interface ScheduleWriteEffects {
  metadata?: ScheduleMetadataFailure
  configuration: 'confirmed' | 'unconfirmed' | 'unchanged'
  pending: SchedulePendingEffect
  nativeSaved: 'confirmed' | 'unconfirmed' | 'not-applicable'
  error?: string
}
export type ScheduleWriteResult =
  | { kind: 'saved'; schedule: ProjectSchedule; pendingInputIntegration: 'required' | 'applied' | 'partial'; effects?: ScheduleWriteEffects }
  | { kind: 'removed'; id: string; historyRetained: true; pendingInputIntegration: 'required' | 'applied' | 'partial'; effects?: ScheduleWriteEffects }
  | { kind: 'conflict'; current?: ProjectSchedule }
  | { kind: 'failed'; error: string; pendingInputIntegration: 'partial'; effects: ScheduleWriteEffects }

export interface RunNowScheduleInput { scheduleId: string; expectedRevision: number; requestId: string }
export interface ManualRunAdmissionResult {
  metadata?: ScheduleMetadataFailure
  kind: 'accepted' | 'existing' | 'conflict' | 'rejected' | 'unknown'
  projectId: string; scheduleId: string; requestId: string
  sessionId?: string; hostSessionId?: string; requestedAt?: string
  admission: 'not-enqueued' | 'enqueued' | 'unknown'
  runLinkSaved: 'confirmed' | 'unconfirmed' | 'not-applicable'
  nativeSaved: 'confirmed' | 'unconfirmed' | 'not-applicable'
  link?: ScheduleRunLink; native?: ScheduleNativeRunView; status?: ScheduleRunStatus
  taskOutcome: 'unknown'; current?: ProjectSchedule; error?: string
}

export interface ScheduleCorePort {
  captureBoundary?(): ScheduleClockBoundary
  configurationCommitted?(previous: ProjectSchedule | undefined, current: ProjectSchedule | undefined, boundary: ScheduleClockBoundary): void
  automaticState?(): Pick<ScheduleSnapshot, 'automaticDispatch' | 'automaticAvailability'>
  /** 从真实 Remote/ToolRunContext 解析 caller 与现有授权，不把 caller 的 JSON 字段当身份。 */
  resolve(request: ScheduleRequest): Promise<ScheduleAccess>
  /** 最终 fresh Core 授权与 Schedule 变换/保存共用同一 records-root 短写 scope。 */
  withMetadataWrite<T>(request: ScheduleRequest, access: ScheduleAccess, target: ScheduleSession,
    action: (scope: RootWriteScope) => Promise<T>): Promise<T>
  withTargetOperation?<T>(request: ScheduleRequest, access: ScheduleAccess, target: ScheduleSession, operation: () => Promise<T>): Promise<T>
  preparePending?(request: ScheduleRequest, access: ScheduleAccess, target: ScheduleSession): Promise<SchedulePendingConsumer>
  runNow?(request: ScheduleRequest, access: ScheduleAccess, input: RunNowScheduleInput): Promise<ManualRunAdmissionResult>
  /** 精确可管理原目标的一次只读观察；补关联与全部状态共用同一来源，不激活Agent或保存。 */
  prepareRunRead?(request: ScheduleRequest, access: ScheduleAccess): Promise<ScheduleRunReader>
  /** 仅供后续 Host 记录经原生日志核实的关联；配置工具不暴露此写入口。 */
  verifyRunLink?(request: ScheduleRequest, candidate: ScheduleRunLink): Promise<ScheduleRunLink>
}

/** boundary 是实际启动/恢复时刻，不是 resume 通知被处理的时间。 */
export interface ScheduleRecoveryWindow { lowerBound: string; upperBound: string }
export type ScheduleAvailability =
  | ({ kind: 'known'; available: boolean; hostStartedAt: string; projectRestoredAt?: string; sessionRestoredAt?: string } & (
    | { provenance?: 'controlled-fixture'; recoveredAt?: string; epoch?: never; baselineAt?: never; recoveryWindow?: never }
    | { provenance: 'darwin-kernel'; observedAt: string; epoch: number; baselineEpoch: number; baselineAt: string; recoveryWindow?: ScheduleRecoveryWindow; recoveredAt?: never }
  ))
  | { kind: 'unknown'; reason: string }
export type ScheduleAdmission =
  | { kind: 'not-enqueued' }
  | { kind: 'enqueued'; message: Extract<ScheduleRunRef, { kind: 'message' }> }
  | { kind: 'uncertain'; reason: string }
export interface ScheduleDecisionInput {
  /** Host同进程已核的当前段启用边界；不是模型输入或持久时间重写。 */
  enabledAt?: string
  schedule: ProjectSchedule; plannedAt: string; now: string
  projectArchived: boolean; sessionArchived: boolean
  availability: ScheduleAvailability; admission: ScheduleAdmission
  /** 仅同进程真实准备调用的易失事实；不是入队、执行或可重开的持久许可。 */
  preparation?: { kind: 'started'; startedAt: string; recoveredAt?: string; epoch?: number; baselineAt?: string } | { kind: 'uncertain'; reason: string }
}
export type ScheduleDecision =
  | { kind: 'keep-enqueued'; message: Extract<ScheduleRunRef, { kind: 'message' }> }
  | { kind: 'wait'; plannedAt: string }
  | { kind: 'suppressed'; reason: 'disabled' | 'archived' | 'host-unavailable' }
  | { kind: 'unknown'; reason: string; unresolvedUntil?: string }
  | { kind: 'skip'; reason: 'before-recovery' | 'before-enable'; boundaryAt: string; nextAt?: string }
  | { kind: 'ready'; plannedAt: string }

export interface ScheduleSettingsActions {
  read(): Promise<ScheduleSnapshot>
  save(input: SaveScheduleInput): Promise<ScheduleWriteResult>
  setEnabled(id: string, enabled: boolean, expectedRevision: number): Promise<ScheduleWriteResult>
  remove(id: string, expectedRevision: number): Promise<ScheduleWriteResult>
  runNow(input: RunNowScheduleInput): Promise<ManualRunAdmissionResult>
}
