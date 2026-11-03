/** Permanent deletion retains ProjectStore progress and removes only this graph's owned namespaces. */
import { lstat, readdir, unlink, rmdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { ProjectControlPort } from './stock/project-ports.ts'
import { sameOwnedCreationHeader, type OwnedRetirement, type ProjectAbsentCarrierProof } from './stock/control/identity.ts'
import { purgeSessionSchedules } from './stock/control/schedule-helpers.ts'
import type { ProjectExecutionLifecycle } from './lifecycle-runtime.ts'
import type { LifecycleStoreCommit, ProjectStore } from './records.ts'
import type { MainCarrierPreparation, ProjectPreparationDeletionGroup, ProjectSessionSourceLifecycle, ProjectSession, SessionCleanupFailure, SessionCleanupStage, SessionCleanupProgress, SessionOwnedDeletion } from './records-types.ts'
import type { DeleteExecutionSessionRequest, DeleteProjectRequest, ProjectDeletionActionResult, ProjectDetail } from './public-types.ts'
import type { ProjectTargetDeletionCut, ProjectsDeletionV1Scope } from './deletion-v1.ts'
import { ProjectScheduleStore } from './features/schedule/store.ts'
import { ProjectSettingsStore } from './features/settings/store.ts'
import type { ProjectSettingsService } from './features/settings/service.ts'
import type { MemoryBatchDeletionPreparation } from './memory-bot/owner.ts'
import type { RootWriteScope } from './metadata-files.ts'

export interface ProjectDeletionPort {
  readonly nativeStorageDataRoot: string
  metadataCleanup?<T>(target: { projectId: string; sessionId: string; hostSessionId: string;
    header?: SessionHeader; preparationAttemptId?: string }, action: (scope: RootWriteScope) => Promise<T>): Promise<T>
  readonly control: ProjectControlPort
  creating(hostSessionId: string): Promise<void> | undefined
  scope(): ProjectsDeletionV1Scope
  prepareTarget(projectId: string, sessionId: string, hostSessionId: string, preparation?: MainCarrierPreparation): ProjectTargetDeletionCut
  prepareProject(projectId: string): ProjectTargetDeletionCut & { readonly continuitySettled: Promise<void> }
  prepareBackground(projectId: string): MemoryBatchDeletionPreparation
  library(projectId: string): { readonly drained: Promise<void>; commit(): void; release(): void }
  handle(hostSessionId: string): AgentHandle | undefined
  detail(projectId: string): Promise<ProjectDetail>
}
type ActiveLife = Extract<ProjectSessionSourceLifecycle, { kind: 'deleting' | 'partial' }>
interface DeletionRoot { id: string; revision: number; hostSessionId: string; sourceLifecycle: ProjectSessionSourceLifecycle; ownedLifecycle?: ProjectSession['ownedLifecycle']; header?: SessionHeader; preparation?: MainCarrierPreparation }
interface Group { root: DeletionRoot; header?: SessionHeader; absent?: true; owned: SessionOwnedDeletion }

export class ProjectSourceDeletion {
  constructor(private readonly ctx: Context, private readonly store: ProjectStore, private readonly dataRoot: string,
    private readonly lifecycle: ProjectExecutionLifecycle, private readonly settings: ProjectSettingsService, private readonly port: ProjectDeletionPort) {}
  deleteExecution(request: DeleteExecutionSessionRequest): Promise<ProjectDeletionActionResult> { return this.lifecycle.runProjectLifecycle(request.projectId, () => this.run(request)) }
  deleteProject(request: DeleteProjectRequest): Promise<ProjectDeletionActionResult> { return this.lifecycle.runProjectLifecycle(request.projectId, () => this.run(request)) }
  private async run(request: DeleteProjectRequest | DeleteExecutionSessionRequest): Promise<ProjectDeletionActionResult> {
    const whole = !('sessionId' in request), projectId = request.projectId
    let snapshot = await this.store.getSnapshot(projectId)
    const result = async (kind: ProjectDeletionActionResult['kind'], message: string): Promise<ProjectDeletionActionResult> => ({ kind, message, detail: await this.port.detail(projectId) })
    if (snapshot.project.sourceLifecycle?.kind === 'deleted') return result('deleted', '项目已永久删除。')
    if (!whole && snapshot.project.sourceLifecycle !== undefined) return result('conflict', '项目正在整体删除，请从原入口继续。')
    let logical = whole ? snapshot.sessions : snapshot.sessions.filter(row => row.id === request.sessionId && row.role === 'execution')
    if (!whole && logical.length !== 1) throw new Error('永久删除目标不是当前项目执行会话。')
    if (!whole && logical.flatMap(row => deletionRoots(row, false)).every(row => row.sourceLifecycle.kind === 'deleted')) return result('deleted', '执行会话已永久删除。')
    if ((whole ? snapshot.project.revision : logical[0]!.revision) !== request.expectedRevision) return result('conflict', '记录已变化，请查看当前范围后重试。')
    try { const scope = this.port.scope(); if (resolve(scope.dataRoot) !== resolve(this.dataRoot)) throw new Error('删除存储范围与当前项目owner不一致。'); scope.assertCurrent() }
    catch (error) { return result('stopped-before-cleanup', `删除范围未确认：${describe(error)}`) }
    const projectCut = whole ? this.port.prepareProject(projectId) : undefined
    let lifeCut: ReturnType<ProjectExecutionLifecycle['prepareDeletion']>
    try { lifeCut = this.lifecycle.prepareDeletion(projectId, logical.flatMap(row => deletionRoots(row, whole)).map(row => row.hostSessionId), whole) }
    catch (error) { projectCut?.release(); return result('stopped-before-cleanup', `删除接纳未关闭：${describe(error)}`) }
    const absenceProofs: ProjectAbsentCarrierProof[] = []
    const targets: ProjectTargetDeletionCut[] = [], instructions: ReturnType<ProjectSettingsService['prepareSessionInstructionsDeletion']>[] = [], ownedCuts: OwnedRetirement[] = []
    let background: MemoryBatchDeletionPreparation | undefined
    let library: ReturnType<ProjectDeletionPort['library']> | undefined
    let committed = snapshot.project.sourceLifecycle !== undefined || logical.some(row => deletionRoots(row, whole).some(root => root.sourceLifecycle.kind !== 'available'))
    let tokensSettled = false, stage: SessionCleanupStage = 'session-log', current: Group | undefined
    const release = () => { if (tokensSettled) return; tokensSettled = true; for (const cut of ownedCuts) cut.release(); for (const cut of targets) cut.release(); for (const cut of instructions) cut.release(); projectCut?.release(); lifeCut.release(); void background?.release(); library?.release() }
    const commit = () => { if (tokensSettled) return; tokensSettled = true; for (const cut of ownedCuts) cut.commit(); for (const cut of targets) cut.commit(); for (const cut of instructions) cut.commit(); projectCut?.commit(); lifeCut.commit(); background?.commit(); library?.commit() }
    try {
      background = whole ? this.port.prepareBackground(projectId) : undefined
      library = whole ? this.port.library(projectId) : undefined
      const selectedBefore = logical.flatMap(row => deletionRoots(row, whole))
      const cancellations = new Map<string, Promise<readonly PromiseSettledResult<unknown>[]>>()
      const instructed = new Set<string>()
      const beginStop = (row: DeletionRoot) => {
        if (row.sourceLifecycle.kind !== 'available' || cancellations.has(row.hostSessionId)) return
        const target = this.port.prepareTarget(projectId, row.id, row.hostSessionId, row.preparation)
        targets.push(target)
        let instruction: ReturnType<ProjectSettingsService['prepareSessionInstructionsDeletion']> | undefined
        if (row.preparation === undefined && !instructed.has(row.id)) { instructed.add(row.id); instruction = this.settings.prepareSessionInstructionsDeletion(projectId, row.id); instructions.push(instruction) }
        const cut = this.port.control.prepareOwnedRetirement(SessionId(row.hostSessionId), { retire: async (id, handle) => { const retired = await this.port.control.retire(id, { handle }); if (retired.status !== 'stopped') throw new AggregateError(retired.errors, '子会话停止未确认。') } })
        ownedCuts.push(cut)
        // prepareOwnedRetirement already cancels every real owner. Keep the old
        // main writer live until its original continuity cancellation is recorded.
        const retiring = async () => {
          await projectCut?.continuitySettled
          return this.port.control.retire(SessionId(row.hostSessionId), { handle: this.port.handle(row.hostSessionId) })
        }
        // Adopt metadata drains at creation, before preflight or real retirement can yield.
        const actual = Promise.allSettled([cut.drained, retiring(), target.drained, ...(instruction === undefined ? [] : [instruction.drained])])
        cancellations.set(row.hostSessionId, actual)
      }
      // Send every real cancel before awaiting background, creation or metadata drain.
      for (const row of selectedBefore) beginStop(row)
      const creations = selectedBefore.flatMap(row => { const creating = this.port.creating(row.hostSessionId); return creating === undefined ? [] : [creating] })
      const preflight = await Promise.allSettled([projectCut?.continuitySettled, projectCut?.drained, background?.drained, library?.drained, ...creations].filter(value => value !== undefined))
      const preflightErrors = preflight.flatMap(value => value.status === 'rejected' ? [value.reason] : [])
      // Retain every already accepted creation and stop its eventual real handle before cleanup.
      snapshot = await this.store.getSnapshot(projectId)
      logical = whole ? snapshot.sessions : snapshot.sessions.filter(row => row.id === logical[0]!.id)
      let selected = logical.flatMap(row => deletionRoots(row, whole))
      const groups: Group[] = []
      const stopping = selected.filter(row => row.sourceLifecycle.kind === 'available').map(async row => {
        beginStop(row)
        const actual = await cancellations.get(row.hostSessionId)!

        const errors = actual.flatMap(value => value.status === 'rejected' ? [value.reason] : [])
        const retired = actual[1]
        if (retired.status === 'fulfilled') { const result = retired.value as { status: 'stopped' | 'unconfirmed'; errors: readonly unknown[] }; if (result.status !== 'stopped') errors.push(...result.errors) }
        if (errors.length) throw new AggregateError(errors, '真实工作停止未确认。')
        const present = await this.ctx.sessionPersistence.stat(SessionId(row.hostSessionId))
        if (present === undefined) {
          const proof = await this.port.control.prepareAbsentCarrier(SessionId(row.hostSessionId)); absenceProofs.push(proof)
          if (row.preparation !== undefined) {
            const logical = (await this.store.getSnapshot(projectId)).sessions.find(item => item.id === row.id)!
            const discarded = await this.store.discardAbsentMainPreparation({ projectId, sessionId: row.id, attemptId: row.preparation.attemptId, expectedRevision: logical.revision }, proof)
            if (discarded.kind !== 'updated') throw new Error('未物化准备物的精确删除发生冲突。')
          } else groups.push({ root: row, absent: true, owned: { contract: 'owned-v1', members: [] } })
          return
        }
        const raw = await this.port.control.inspect(SessionId(row.hostSessionId))
        if (row.header !== undefined && !sameOwnedCreationHeader(row.header, raw.meta)) throw new Error('删除原承载创建身份变化。')
        if (row.preparation !== undefined) {
          // A reservation identifies the intended root, not an arbitrary same-ID
          // journal. The actual closed storage handle supplies its durable owner.
          if (raw.owner?.projectId !== projectId || raw.owner.logicalSessionId !== row.id || raw.meta.id !== row.preparation.toHostSessionId) throw new Error('删除准备物的实际journal owner归属已变化。')
        }
        const members = (actual[0] as PromiseFulfilledResult<Awaited<OwnedRetirement['drained']>>).value
        const union = new Map(members.map(member => [String(member.header.id), member]))
        for (const prior of row.ownedLifecycle?.members ?? []) { const old = union.get(String(prior.header.id)); if (old !== undefined && !sameOwnedCreationHeader(old.header, prior.header)) throw new Error('删除成员创建身份冲突。'); if (old === undefined) union.set(String(prior.header.id), { ...prior, parentSessionId: SessionId(prior.parentSessionId) }) }
        groups.push({ root: row, header: raw.meta, owned: { contract: 'owned-v1', members: [...union.values()].map(member => ({ ...member, progress: {} })) } })
      })
      const settled = await Promise.allSettled(stopping)
      const stopErrors = [...preflightErrors, ...settled.flatMap(value => value.status === 'rejected' ? [value.reason] : [])]
      if (stopErrors.length) throw new AggregateError(stopErrors, '所属工作或已接纳保存未确认。')
      snapshot = await this.store.getSnapshot(projectId)
      logical = whole ? snapshot.sessions : snapshot.sessions.filter(row => row.id === logical[0]!.id)
      selected = logical.flatMap(row => deletionRoots(row, whole))
      for (const row of selected.filter(row => row.sourceLifecycle.kind === 'deleting' || row.sourceLifecycle.kind === 'partial')) {
        const life = row.sourceLifecycle as ActiveLife
        if (life.fileDeletion !== undefined || life.imageDeletion !== undefined) throw new Error('此历史删除合同需要独立迁移核实，当前私图没有取得旧共享附件删除权。')
        groups.push({ root: row, header: row.header ?? row.ownedLifecycle?.rootHeader, owned: life.ownedDeletion ?? { contract: 'owned-v1', members: [] } })
      }
      if (!committed || whole && snapshot.project.sourceLifecycle === undefined) {
        const source = (row: DeletionRoot): ProjectSessionSourceLifecycle => row.sourceLifecycle.kind !== 'available' ? row.sourceLifecycle : { kind: 'deleting', requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), progress: {}, ownedDeletion: groups.find(group => group.root.hostSessionId === row.hostSessionId)!.owned }
        if (whole) {
          const proposed = logical.flatMap(carrierSessions).map(row => ({ ...row, sourceLifecycle: source(deletionRoots(row, false)[0]!) }))
          const preparations: ProjectPreparationDeletionGroup[] = selected.filter(row => row.preparation !== undefined).map(row => ({ sessionId: row.id, attemptId: row.preparation!.attemptId, hostSessionId: row.hostSessionId, header: groups.find(group => group.root.hostSessionId === row.hostSessionId)?.header ?? row.header, sourceLifecycle: source(row) }))
          let receipt: LifecycleStoreCommit | undefined
          await this.store.beginProjectSourceDeletion({ projectId, expectedRevision: snapshot.project.revision, sessions: proposed, preparations }, value => { receipt = value; committed = true })
          await receipt?.confirmSource()
        } else for (const group of groups.filter(group => group.root.sourceLifecycle.kind === 'available')) {
          let receipt: LifecycleStoreCommit | undefined
          const row = group.root
          const saved = await this.store.beginExecutionSourceDeletion({ projectId, sessionId: row.id, hostSessionId: row.hostSessionId, expectedRevision: (await this.store.getSnapshot(projectId)).sessions.find(item => item.id === row.id)!.revision, scheduleDeletion: true, ownedDeletion: group.owned }, value => { receipt = value; committed = true })
          if (saved.kind !== 'started') throw new Error('删除保存冲突。')
          await receipt?.confirmSource()
        }
      }
      commit(); await this.store.confirmDeletionSources(projectId)
      const refresh = async (group: Group) => { const row = (await this.store.getSnapshot(projectId)).sessions.find(row => row.id === group.root.id)!; group.root = deletionRoots(row, whole).find(root => root.hostSessionId === group.root.hostSessionId)! }
      const save = async (group: Group, progress: SessionCleanupProgress, failure?: SessionCleanupFailure) => {
        await refresh(group)
        const input = { projectId, sessionId: group.root.id, hostSessionId: group.root.hostSessionId, expectedRevision: group.root.revision, progress, ownedDeletion: group.owned, ...(failure === undefined ? {} : { failure }) }
        const saved = group.root.preparation === undefined ? await this.store.recordExecutionSourceDeletion({ ...input, scheduleDeletion: true, ...(whole ? { projectDeletion: true as const } : {}) }) : await this.store.recordMainPreparationSourceDeletion({ ...input, attemptId: group.root.preparation.attemptId })
        if (saved.kind !== 'updated') throw new Error('删除进度保存冲突。')
        await refresh(group)
      }
      const metadataCleanup = <T>(group: Group, within: (scope: RootWriteScope) => Promise<T>, standalone: () => Promise<T>): Promise<T> => {
        if (this.port.metadataCleanup === undefined) return standalone()
        return this.port.metadataCleanup({ projectId, sessionId: group.root.id, hostSessionId: group.root.hostSessionId,
          ...((group.header ?? group.root.header) === undefined ? {} : { header: group.header ?? group.root.header }),
          ...(group.root.preparation === undefined ? {} : { preparationAttemptId: group.root.preparation.attemptId }) }, within)
      }
      for (const group of groups) {
        current = group; await refresh(group)
        const life = () => group.root.sourceLifecycle as ActiveLife
        stage = 'project-schedules'
        if (life().progress.projectSchedules === undefined) { const owner = new ProjectScheduleStore(projectId, join(this.dataRoot, projectId)); const report = await metadataCleanup(group, scope => owner.purgeSessionWithin(scope, group.root.id), () => owner.purgeSession(group.root.id)); if (!report.complete) throw new Error(`项目定时部分清理：${report.failure ?? '未知'}`); await save(group, { ...life().progress, projectSchedules: 'cleared' }) }
        stage = 'native-schedules'
        if (life().progress.nativeSchedules === undefined) { const report = await purgeSessionSchedules(this.ctx, this.port.nativeStorageDataRoot, [SessionId(group.root.hostSessionId), ...group.owned.members.map(member => member.header.id)]); if (!report.complete) throw new Error(`私图计划部分清理：${report.failure ?? '未知'}`); group.owned = { ...group.owned, members: group.owned.members.map(member => ({ ...member, progress: { ...member.progress, nativeSchedules: 'cleared' } })) }; await save(group, { ...life().progress, nativeSchedules: 'cleared' }) }
        stage = 'session-log'
        for (const member of [...group.owned.members].reverse()) {
          if (member.progress.sessionLog === undefined) { await this.port.control.removeCarrier(member.header.id); group.owned = { ...group.owned, members: group.owned.members.map(row => row.header.id === member.header.id ? { ...row, progress: { ...row.progress, projectionCache: 'cleared', sessionLog: 'removed', queryIndex: 'not-present', sessionInstructions: 'not-applicable' } } : row) }; await save(group, life().progress) }
        }
        if (life().progress.sessionLog === undefined) { await this.port.control.removeCarrier(SessionId(group.root.hostSessionId)); await save(group, { ...life().progress, projectionCache: 'cleared', sessionLog: group.absent ? 'already-absent' : 'removed', queryIndex: 'not-present' }) }
        stage = 'session-instructions'
        if (life().progress.sessionInstructions === undefined) { const owner = new ProjectSettingsStore(projectId, join(this.dataRoot, projectId)); const removed = group.root.preparation === undefined ? await metadataCleanup(group, scope => owner.removeInstructionsWithin(scope, group.root.id), () => owner.removeInstructions(group.root.id)) : 'already-absent' as const; await save(group, { ...life().progress, sessionInstructions: removed }) }
        stage = 'final-project-record'; await refresh(group)
        let receipt: LifecycleStoreCommit | undefined
        const input = { projectId, sessionId: group.root.id, hostSessionId: group.root.hostSessionId, expectedRevision: group.root.revision }
        const done = group.root.preparation === undefined ? await this.store.completeExecutionSourceDeletion({ ...input, ...(whole ? { projectDeletion: true as const } : {}) }, value => { receipt = value }) : await this.store.completeMainPreparationSourceDeletion({ ...input, attemptId: group.root.preparation.attemptId }, value => { receipt = value })
        if (done.kind !== 'updated') throw new Error('来源终态保存冲突。')
        await receipt?.confirmSource()
      }
      current = undefined
      if (whole) {
        stage = 'project-files'; const state = (await this.store.getProject(projectId))!.sourceLifecycle!
        if (state.kind !== 'deleted' && state.progress.projectFiles === undefined) { await removeProjectContents(join(this.dataRoot, projectId)); await this.store.recordProjectSourceDeletion(projectId, undefined, 'removed') }
        stage = 'final-project-record'; let receipt: LifecycleStoreCommit | undefined; await this.store.completeProjectSourceDeletion(projectId, value => { receipt = value }); await receipt?.confirmSource()
      }
      return result('deleted', whole ? '项目及其自有内容已永久删除；外部原件和其它项目保留。' : '执行会话及其自有内容已永久删除。')
    } catch (error) {
      if (!committed) { release(); return result('stopped-before-cleanup', `停止或已接纳保存未确认，内容保留；请沿原入口处理：${describe(error)}`) }
      commit()
      const failure: SessionCleanupFailure = { stage, certainty: 'unknown', message: describe(error) }
      try {
        if (current !== undefined && current.root.sourceLifecycle.kind !== 'deleted') {
          const row = (await this.store.getSnapshot(projectId)).sessions.find(row => row.id === current!.root.id)!, root = deletionRoots(row, whole).find(root => root.hostSessionId === current!.root.hostSessionId)!
          const input = { projectId, sessionId: root.id, hostSessionId: root.hostSessionId, expectedRevision: root.revision, progress: (root.sourceLifecycle as ActiveLife).progress, ownedDeletion: current.owned, failure }
          if (root.preparation === undefined) await this.store.recordExecutionSourceDeletion({ ...input, ...(whole ? { projectDeletion: true as const } : {}) }); else await this.store.recordMainPreparationSourceDeletion({ ...input, attemptId: root.preparation.attemptId })
        }
        if (whole) await this.store.recordProjectSourceDeletion(projectId, failure)
      } catch (saving) { return result('partial', `${failure.message}；结果保存未确认：${describe(saving)}。请从原入口继续。`) }
      return result('partial', `${failure.message}。已完成的清理事实保留，请从原入口继续。`)
    } finally {
      await Promise.all(absenceProofs.map(proof => proof.release()))
    }
  }
}
function describe(error: unknown): string { return error instanceof AggregateError ? `${error.message} ${error.errors.map(describe).join('；')}` : error instanceof Error ? error.message : String(error) }
async function removeProjectContents(directory: string): Promise<void> {
  const status = await lstat(directory); if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('项目存储根不是本owner的本地目录。')
  const remove = async (path: string): Promise<void> => { let item; try { item = await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }; if (item.isDirectory() && !item.isSymbolicLink()) { for (const name of await readdir(path)) await remove(join(path, name)); await rmdir(path) } else await unlink(path) }
  for (const name of await readdir(directory)) if (name !== 'record.json') await remove(join(directory, name))
}
function carrierSessions(session: ProjectSession): ProjectSession[] { return (session.carriers ?? [{ hostSessionId: session.hostSessionId, sourceLifecycle: session.sourceLifecycle, ownedLifecycle: session.ownedLifecycle }]).map(carrier => ({ ...session, carriers: undefined, hostSessionId: carrier.hostSessionId, sourceLifecycle: carrier.sourceLifecycle, ownedLifecycle: carrier.ownedLifecycle })) }
function deletionRoots(session: ProjectSession, preparations: boolean): DeletionRoot[] {
  const roots: DeletionRoot[] = carrierSessions(session).map(row => ({ id: session.id, revision: session.revision, hostSessionId: row.hostSessionId, sourceLifecycle: row.sourceLifecycle, ownedLifecycle: row.ownedLifecycle, header: session.carriers?.find(carrier => carrier.hostSessionId === row.hostSessionId)?.header }))
  if (preparations) for (const preparation of session.mainPreparations ?? []) if (preparation.state !== 'committed') roots.push({ id: session.id, revision: session.revision, hostSessionId: preparation.toHostSessionId, header: preparation.toHeader, sourceLifecycle: preparation.sourceLifecycle ?? { kind: 'available' }, preparation })
  return roots
}
