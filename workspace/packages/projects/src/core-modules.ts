import { ProjectsCoreAccessError, type ProjectsCoreAccess } from './core-access.ts'
import type { LibraryCorePort } from './library-contract.ts'
import type { MemoryCorePort, MemoryProjectAccess, MemorySourceEvidence, MemorySourceReadOptions } from './memory-service.ts'
import { communicationVisibleText } from './communication/visible-reader.ts'
import type { StoredMemorySource } from './memory-types.ts'
import { memoryFileText } from './memory-file-source.ts'

/** 只组合真实归属与文件能力，Library 不获得业务台账或 Store 写权限。 */
export function libraryCorePort(access: ProjectsCoreAccess): LibraryCorePort {
  return {
    withMetadataWrite: (request, prepared, sources, action, signal) => access.withMetadataWrite(request.projectId, fresh => {
      if (prepared.projectId !== request.projectId || prepared.sessionId !== request.sessionId) throw new Error('Library prepared scope belongs to another target')
      access.assertMetadataSession(fresh, { sessionId: prepared.sessionId, hostSessionId: prepared.hostSessionId,
        roles: ['main', 'execution'], activity: request.hostSessionId === undefined ? 'user-maintenance' : 'active' })
      access.assertMetadataSources(fresh, sources)
    }, scope => action(scope), signal),
    resolveScope: async (request, signal) => {
      signal?.throwIfAborted()
      const scope = request.hostSessionId === undefined ? await access.forSession(request.projectId, request.sessionId)
        : await access.forHostSession(request.projectId, request.hostSessionId)
      signal?.throwIfAborted()
      if (scope.session.id !== request.sessionId) throw new ProjectsCoreAccessError('资料调用承载不属于指定逻辑会话。', 'PROJECT_CORE_FOREIGN_SOURCE')
      if (scope.role !== 'main' && scope.role !== 'execution') {
        throw new ProjectsCoreAccessError('资料入口只接受项目工作会话。', 'PROJECT_CORE_MISSING_SESSION')
      }
      return { projectId: scope.project.id, sessionId: scope.session.id, hostSessionId: scope.hostSessionId,
        projectRoot: scope.projectRoot, projectFilesRoot: scope.projectFilesRoot,
        workingDirectory: scope.workingDirectory, workspaceRoot: scope.workspaceRoot }
    },
    verifySources: async (scope, sources, signal) => {
      for (const source of sources) {
        signal?.throwIfAborted()
        const evidence = await access.readSource(scope.projectId, source, signal, { before: 0, after: 0 })
        signal?.throwIfAborted()
        if (!evidence.readable) throw new Error(evidence.reason ?? '项目来源当前不可读。')
      }
    },
  }
}

export function memoryCorePort(access: ProjectsCoreAccess): MemoryCorePort {
  return {
    withMetadataWrite: (request, prepared, authorization, action) => access.withMetadataWrite(request.projectId, fresh => {
      if (prepared.projectId !== request.projectId || prepared.readOnly) throw new Error('只读或其它项目上下文不能保存共享记忆。')
      if (request.actor.kind === 'session') {
        access.assertMetadataSession(fresh, { sessionId: prepared.sessionId, hostSessionId: request.actor.hostSessionId,
          roles: ['memory'], activity: 'active' })
      } else if (prepared.actorId !== 'project-settings-user') throw new Error('共享记忆设置必须由实际设置入口提交。')
      if (authorization.scope?.kind === 'session') {
        for (const id of authorization.scope.sessionIds) {
          if (!fresh.sessions.some(session => session.id === id)) throw new Error(`项目会话不存在：${id}`)
        }
      }
      access.assertMetadataSources(fresh, authorization.sources ?? [])
    }, scope => action(scope), request.signal),
    resolveProject: async request => {
      request.signal?.throwIfAborted()
      if (request.actor.kind === 'settings') {
        const project = await access.forSettingsUser(request.projectId)
        request.signal?.throwIfAborted()
        return project
      }
      const view = await access.forProject(request.projectId)
      request.signal?.throwIfAborted()
      const hostSessionId = request.actor.hostSessionId
      const retained = await access.readSessionSource(hostSessionId, request.projectId)
      request.signal?.throwIfAborted()
      const session = retained?.projectId === request.projectId && retained.sourceLifecycle.kind === 'available' ? retained : undefined
      if (session === undefined) {
        const preparation = await access.preparedMainContext(request.projectId, hostSessionId)
        request.signal?.throwIfAborted()
        if (preparation !== undefined) return preparation
        throw new ProjectsCoreAccessError('记忆会话不属于当前项目。', 'PROJECT_CORE_FOREIGN_SOURCE')
      }
      return { projectId: view.project.id, projectDirectory: view.projectRoot, actorId: hostSessionId,
        sessionId: session.id, role: session.role }
    },
    readSource: (project, source, signal, options) => readMemorySource(access, project, source, signal, options),
    validateScope: async (project, scope) => {
      const view = await access.forProject(project.projectId)
      if (scope.kind === 'session') {
        for (const id of scope.sessionIds) {
          if (!view.snapshot.sessions.some(session => session.id === id)) throw new Error(`项目会话不存在：${id}`)
        }
      }
      // 文件和主题仅为适用范围，不授予文件或其它会话操作权限。
    },
  }
}

async function readMemorySource(access: ProjectsCoreAccess, project: MemoryProjectAccess,
  source: StoredMemorySource, signal?: AbortSignal, options?: MemorySourceReadOptions): Promise<MemorySourceEvidence> {
  signal?.throwIfAborted()
  if (source.kind === 'settings') return {
    projectId: project.projectId, readable: false, isUserDecision: false, reason: '设置修改来源由共享记忆的持久记录核实。',
  }
  if (source.kind === 'record') return access.readLegacySource(project.projectId, source, signal)
  if (source.kind === 'file') {
    const view = await access.forProject(project.projectId)
    signal?.throwIfAborted()
    const sessionId = project.sessionId ?? view.project.mainSessionId
    if (sessionId === undefined) throw new Error('文件来源缺少可用的项目会话。')
    const scope = await access.forSession(project.projectId, sessionId)
    signal?.throwIfAborted()
    try {
      const file = await access.readBytes({ hostSessionId: scope.hostSessionId, path: source.path, signal })
      signal?.throwIfAborted()
      return { projectId: project.projectId, isUserDecision: false, ...memoryFileText(file.absolutePath, file.data) }
    } catch (error) {
      signal?.throwIfAborted()
      const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
      const reason = code === 'ENOENT' || code === 'workspace-file/not-found' ? '来源文件不存在，无法读取原始内容。'
        : code === 'EACCES' || code === 'EPERM' || code === 'FS_PERMISSION_DENIED' || code === 'FS_ACCESS_DENIED' || code === 'workspace-file/forbidden' || code === 'workspace-file/outside-workspace'
          ? '当前无权读取此来源文件，请检查访问权限。' : '原始来源文件当前不可读，请稍后重试。'
      return { projectId: project.projectId, readable: false, isUserDecision: false, reason,
        diagnostic: error instanceof Error ? error.message : String(error) }
    }
  }
  if (source.kind === 'communication-part') {
    const read = await access.readCommunicationSource(project.projectId, source, { group: 'context', index: 0 }, signal)
    const human = read.parts.length > 0 && read.parts.every(part => part.originalSpeaker === 'user' && part.producer.kind === 'user')
    return { projectId: project.projectId, source: read.source, readable: read.visibleComplete, isUserDecision: human,
      ...(read.parts.length === 1 ? { producer: read.parts[0]!.producer.kind } : {}),
      text: read.parts.map(part => communicationVisibleText(part.blocks)).join('\n'),
      ...(read.visibleComplete ? {} : { partial: true as const, reason: '保存通信来源的可见内容不完整。' }) }
  }
  const read = await access.readSource(project.projectId, source, signal, options)
  const reason = read.code === 'deleted' ? '来源会话已删除。'
    : read.code === 'not-found' ? '原始记录不存在或不在可读取范围。'
    : read.code === 'stale-source' ? '来源内容已变化，请从原入口重新打开。'
    : read.code === 'invalid-source' || read.code === 'ambiguous-source' ? '当前来源位置无法确认，请从原聊天重新打开。'
    : '原始来源当前不可读，请稍后重试。'
  return { projectId: read.projectId, source: read.source, readable: read.readable, isUserDecision: read.isUserDecision,
    ...(read.producer === undefined ? {} : { producer: read.producer }),
    ...(read.nativeItems === undefined ? {} : { nativeItems: read.nativeItems }),
    ...(read.partial === undefined ? {} : { partial: read.partial }),
    ...(read.limitations === undefined ? {} : { limitations: read.limitations }),
    ...(read.text === undefined ? {} : { text: read.text }),
    ...(read.readable && read.reason === undefined ? {} : { reason: read.readable ? '当前仅显示部分来源信息，请核对原始来源。' : reason }),
    ...(read.reason === undefined ? {} : { diagnostic: read.reason }) }
}
