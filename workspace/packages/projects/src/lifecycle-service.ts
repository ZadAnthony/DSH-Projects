import {
  LifecycleBoundaryError,
  type ExecutionLifecycleRequest,
  type LifecycleTarget,
} from './lifecycle-types.ts'

/** 项目归档与单会话归档分别表达；任一归档都只能查看聊天。 */
export function lifecycleAccess(target: LifecycleTarget): {
  readonly readOnly: boolean
  readonly canRestoreExecution: boolean
} {
  return {
    readOnly: target.project.archived || target.session.archived,
    canRestoreExecution: target.session.role === 'execution'
      && target.session.archived && !target.project.archived,
  }
}

/** 核心 prepareArchive 在准入/保存前复用同一目标校验；恢复读取也沿用此边界。 */
export function assertExecutionLifecycleTarget(request: ExecutionLifecycleRequest, target: LifecycleTarget): void {
  if (target.project.id !== request.projectId || target.session.projectId !== request.projectId
    || target.session.id !== request.sessionId) {
    throw new LifecycleBoundaryError('LIFECYCLE_TARGET_MISMATCH', 'Lifecycle owner returned a different project or session')
  }
  if (target.session.role !== 'execution') {
    throw new LifecycleBoundaryError('LIFECYCLE_PROJECT_ACTION_REQUIRED', 'Main session lifecycle actions apply to the entire project')
  }
}

