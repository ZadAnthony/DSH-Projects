import type { RootWriteScope } from '../../metadata-contract.ts'
import { durableMutationDetails } from '../../metadata-errors.ts'
import type { ModelCatalog, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'

/** 直接消费 DSH 目录；本模块不维护自己的模型目录或当前会话模型。 */
export type { ModelCatalog, ModelSelection }
export type { ModelCatalogModel } from '@deepseek-ai/dsh-api-session-controller/types'

export interface SettingsProjectRequest {
  projectId: string
  signal?: AbortSignal
  /** Internal caller identity supplied by core.forTool, never by tool parameters. */
  metadataActor?: { sessionId: string; hostSessionId: string }
}
export interface SettingsSessionRequest extends SettingsProjectRequest { sessionId: string }
export interface SettingsProjectAccess { projectId: string; projectDirectory: string }
export interface SettingsSessionAccess extends SettingsProjectAccess {
  sessionId: string
  hostSessionId: string
  role: 'main' | 'execution'
}

export interface ExecutionDefaults {
  projectId: string
  revision: number
  /** null 表示沿用既有 DSH 默认；不保存默认的副本。 */
  selection: ModelSelection | null
  updatedAt?: string
}

export interface ProjectInstructions {
  projectId: string
  revision: number
  instructions: string
  updatedAt?: string
}

export interface SessionInstructions extends ProjectInstructions {
  sessionId: string
}

export interface SessionInstructionsInitialization {
  kind: 'initialized' | 'existing'
  value: SessionInstructions
}

/** 仅交给原创建caller；须先真实确认原生会话未物化，才可撤销本次未改初始值。 */
export interface SessionInstructionsCreation {
  readonly initialization: SessionInstructionsInitialization
  discardUncreated(): Promise<boolean>
}

export type ExistingSessionInstructionsInitialization = SessionInstructionsInitialization
  | { kind: 'unavailable'; message: string }

export type SettingsWriteResult<T> =
  | { kind: 'saved'; value: T }
  | { kind: 'conflict'; current: T }
  | { kind: 'unavailable'; message: string }

export type SettingsCatalogRead =
  | { kind: 'available'; catalog: ModelCatalog; readAt: string }
  | { kind: 'unavailable'; message: string; readAt: string }

export type DefaultSelectionStatus =
  | { kind: 'inherit' }
  | { kind: 'available' }
  | { kind: 'unavailable'; message: string }

export interface ExecutionDefaultsView {
  defaults: ExecutionDefaults
  catalog: SettingsCatalogRead
  status: DefaultSelectionStatus
}

/** 只给未来一次创建消费；不持有任何已有会话的模型状态。 */
export type NewExecutionDefaults =
  | { kind: 'inherit'; projectId: string; revision: number }
  | { kind: 'configured'; projectId: string; revision: number; selection: ModelSelection }
  | { kind: 'unavailable'; projectId: string; revision: number; message: string }

export interface SessionInstructionContext {
  projectId: string
  sessionId: string
  available: boolean
  value?: SessionInstructions
  message?: string
}

export interface PreparedSessionInstructions {
  get(): SessionInstructionContext
  render(): string
  refresh(): Promise<void>
}

export interface ProjectInstructionContext {
  projectId: string
  available: boolean
  value?: ProjectInstructions
  message?: string
}

export interface PreparedProjectInstructions {
  get(): ProjectInstructionContext
  render(): string
  refresh(): Promise<void>
}

/** 与原项目删除 cut 同步准备、排空及提交；物理清理归原项目 namespace owner。 */
export interface ProjectInstructionsDeletionCut {
  readonly drained: Promise<void>
  commit(): void
  release(): void
}

export interface SessionInstructionsDeletionCut {
  readonly drained: Promise<void>
  commit(): RetiredSessionInstructions
  release(): void
}

export interface RetiredSessionInstructions {
  remove(): Promise<'removed' | 'already-absent'>
}

/** 由公共设置入口核实访问和精确归属，不开放整份核心记录。 */
export interface SettingsCorePort {
  resolveProject(request: SettingsProjectRequest): Promise<SettingsProjectAccess>
  resolveSession(request: SettingsSessionRequest): Promise<SettingsSessionAccess>
  /** Production bridges revalidate the current owner/lifecycle inside this root transaction. */
  withMetadataWrite<T>(request: SettingsProjectRequest, access: SettingsProjectAccess,
    operation: 'save' | 'initialize' | 'discard' | 'cleanup', action: (scope: RootWriteScope) => Promise<T>): Promise<T>
}

export interface SettingsModelPort {
  /** 对接真实 sessionController.modelCatalog()；不调用 selectModel/saveSelection。 */
  modelCatalog(signal?: AbortSignal): Promise<ModelCatalog>
}

export interface ExecutionDefaultsActions {
  read(): Promise<ExecutionDefaultsView>
  save(selection: ModelSelection | null, expectedRevision: number): Promise<SettingsWriteResult<ExecutionDefaults>>
}

export interface SessionInstructionsActions {
  read(): Promise<SessionInstructions>
  save(instructions: string, expectedRevision: number): Promise<SettingsWriteResult<SessionInstructions>>
}

export interface ProjectInstructionsActions {
  read(): Promise<ProjectInstructions>
  save(instructions: string, expectedRevision: number): Promise<SettingsWriteResult<ProjectInstructions>>
}

/** Browser-safe decoding of the metadata error and the existing RemoteError envelopes. */
export type SettingsMutationFailure = NonNullable<ReturnType<typeof durableMutationDetails>>
export function settingsMutationFailure(error: unknown): SettingsMutationFailure | undefined {
  const seen = new Set<object>()
  const decode = (input: unknown, inheritedCode?: unknown, inheritedMessage?: unknown): SettingsMutationFailure | undefined => {
    if (input === null || typeof input !== 'object' || seen.has(input)) return undefined
    seen.add(input)
    const value = input as Record<string, unknown>
    const code = value.code ?? inheritedCode
    const message = typeof value.message === 'string' ? value.message : inheritedMessage
    const failure = durableMutationDetails({ ...value, code, message })
    if (failure !== undefined) return failure
    for (const key of ['details', 'detail', 'data', 'error']) {
      const found = decode(value[key], code, message)
      if (found !== undefined) return found
    }
    return undefined
  }
  return decode(error)
}
export function settingsUnknownErrorText(error: unknown): string | undefined {
  const failure = settingsMutationFailure(error)
  if (failure?.code !== 'projects/metadata-write-unconfirmed' || failure.effect === 'none') return undefined
  return '保存结果未确认，内容可能已更新；当前输入已保留，请刷新核实后再决定是否保存。'
}
