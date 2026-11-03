/** Actual native create, inherited configuration and exact retirement. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { previewProjectRequest } from '../stock/request/harness.ts'
import type { ProjectControlPort } from '../stock/project-ports.ts'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { dshNewProjectSessionConfiguration } from '../features/settings/dsh.ts'
import type { ProjectStore } from '../records.ts'
import type { MainPreparationResult, ProjectHostOwnership } from '../records-types.ts'
import type { EvaluationEnvelope } from './types.ts'
import type { MainHistoryWindow } from './history-types.ts'
import type { CommunicationVisibleBlock } from '../communication/types.ts'
import { canonicalJson } from '../communication/contract.ts'
import type {} from '../stock/read/index.ts'

/** An actual native Agent whose durable Project relation is still unpublished. */
export interface PreparedMainCarrier {
  readonly handle: AgentHandle
  readonly header: SessionHeader
  revision: number
}

interface NativePorts {
  installPrepared(agent: Agent, ownership: Extract<ProjectHostOwnership, { kind: 'preparation' }>): Promise<void>
  activate(agent: Agent): Promise<void>
  hold(hostSessionId: string): void
  retain(handle: AgentHandle): void
  assertValid(): void
}

/** Isolated preset services belong to the Agent's retained composition, even during private setup. */
function mainPolicyOwners(agent: Agent) {
  const ctx = agent.ctx, presets = ctx.get('agentPresets')
  return {
    permission: presets?.serviceFor(agent, 'permissionPresets') ?? ctx.get('permissionPresets'),
    sandbox: presets?.serviceFor(agent, 'sandboxPolicy') ?? ctx.get('sandboxPolicy'),
    approval: presets?.serviceFor(agent, 'approval') ?? ctx.get('approval'),
    plan: presets?.serviceFor(agent, 'planMode') ?? ctx.get('planMode'),
  }
}

/** Read the actual scoped policy owners, including pending plan intent, without taking authority. */
export async function readMainNativePolicy(agent: Agent) {
  const ctx = agent.ctx, { permission, sandbox, approval, plan } = mainPolicyOwners(agent)
  if (permission === undefined || sandbox === undefined || approval === undefined || plan === undefined) {
    if (agent.session.snapshotEvents().some(event => permission === undefined && event.type === 'permission/preset'
      || sandbox === undefined && event.type === 'sandbox/mode' || approval === undefined && event.type === 'approval/policy'
      || plan === undefined && event.type === 'plan/mode')) throw new Error('A current main policy owner is unavailable for its durable configuration.')
  }
  const policy = sandbox?.resolve({ session: agent.session }), planValue = plan?.get(agent)
  const projections = ctx.get('sessionProjections')
  if (projections === undefined) throw new Error('Native policy projections are unavailable.')
  const planState = plan === undefined ? undefined : projections.stateOf(agent.session, 'plan')
  if (plan !== undefined && planState === undefined) throw new Error('The native plan configuration projection is unavailable.')
  return {
    permissionPreset: permission?.current(agent.session) ?? null,
    sandbox: policy === undefined ? null : { mode: policy.mode, workspaceRoot: policy.workspaceRoot },
    approval: approval === undefined ? null : approval.overrideOf(agent.session) ?? approval.config.policy ?? 'ask',
    plan: planValue === undefined ? null : { active: planValue.active, pending: planValue.pending ?? null,
      wanted: planState?.wanted ?? null, running: planState?.running ?? null },
  }
}

type MainNativePolicy = Awaited<ReturnType<typeof readMainNativePolicy>>

/** Pending commands and intentions remain the old receiver's responsibility. */
function assertSettledMainPolicy(policy: MainNativePolicy): void {
  if (policy.plan !== null && (policy.plan.pending !== null || policy.plan.wanted !== null || policy.plan.running !== null)) {
    throw new Error('Current main still owns a pending native plan selection.')
  }
}

/** Apply only already effective policy through its real native owners in the private setup. */
async function inheritMainNativePolicy(agent: Agent, policy: MainNativePolicy): Promise<void> {
  assertSettledMainPolicy(policy)
  const before = await readMainNativePolicy(agent)
  assertSettledMainPolicy(before)
  for (const key of ['permissionPreset', 'sandbox', 'approval', 'plan'] as const) {
    if ((policy[key] === null) !== (before[key] === null)) throw new Error(`Prepared main ${key} owner does not match current scope.`)
  }
  const { permission, plan } = mainPolicyOwners(agent)
  if (policy.permissionPreset !== null && policy.permissionPreset !== 'custom') {
    if (permission === undefined) throw new Error('Prepared permission preset owner is unavailable.')
    // In particular auto uses its live integration's existing admission check.
    permission.set(agent.session, policy.permissionPreset)
  }
  const selected = await readMainNativePolicy(agent)
  if (policy.sandbox !== null && policy.sandbox.mode !== selected.sandbox?.mode) setSandboxMode(agent.session, policy.sandbox.mode)
  if (policy.approval !== null && policy.approval !== selected.approval) setApprovalPolicy(agent.session, policy.approval)
  if (policy.plan !== null) {
    if (plan === undefined) throw new Error('Prepared plan-mode owner is unavailable.')
    const result = plan.set(agent, policy.plan.active)
    if (result !== 'committed' && result !== 'noop') throw new Error('Prepared plan selection did not settle through its native owner.')
  }
  const after = await readMainNativePolicy(agent)
  if (JSON.stringify(after) !== JSON.stringify(policy)) throw new Error('Prepared main effective native policy does not match current main.')
  if (agent.inbox.nextStep.length !== 0 || agent.inbox.nextTurn.length !== 0) throw new Error('Prepared policy setup admitted native input.')
}

/** The thin native bridge owns only the real handle created by its current operation. */
export class MainContinuityNative {
  constructor(private readonly ctx: Context, private readonly store: ProjectStore, private readonly control: ProjectControlPort) {}

  /** Create and durably prepare the exact reserved root without sending any business input. */
  async prepare(envelope: EvaluationEnvelope, from: Agent, window: MainHistoryWindow, signal: AbortSignal, ports: NativePorts): Promise<PreparedMainCarrier> {
    const header = from.session.header
    if (header.cwd === undefined || header.agentPreset === undefined) throw new Error('Current main cwd or preset is unavailable.')
    const nativePolicy = await readMainNativePolicy(from)
    assertSettledMainPolicy(nativePolicy)
    ports.assertValid(); signal.throwIfAborted()
    const selected = this.ctx.sessionProjections.stateOf(from.session, 'modelSelection')
    const route = selected?.pending ?? selected?.lastUsed
    if (route === undefined || route === null) throw new Error('Current main effective model selection is unavailable.')
    const config = dshNewProjectSessionConfiguration({ provider: route.provider, model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }) })
    const oldConfig = from.session.requestHeader()?.config
    const options: AgentOptions = { ...config.agentOptions,
      ...from.options.maxTokens === undefined && oldConfig?.maxTokens === undefined ? {} : { maxTokens: from.options.maxTokens ?? oldConfig?.maxTokens } }
    ports.assertValid(); signal.throwIfAborted()
    const toHostSessionId = SessionId(`project-${randomUUID()}`)
    let receipt = requireUpdated(await this.store.reserveMainPreparation({ projectId: envelope.projectId, sessionId: envelope.mainSessionId,
      attemptId: envelope.attemptId, expectedRevision: envelope.sessionRevision, fromHeader: header, toHostSessionId }))
    ports.hold(toHostSessionId)
    let handle: AgentHandle | undefined
    try {
      handle = await this.control.createPreparedAgent({ projectId: envelope.projectId, sessionId: envelope.mainSessionId, attemptId: envelope.attemptId, options: { sessionId: toHostSessionId, meta: { cwd: header.cwd, agentPreset: header.agentPreset }, agentOptions: options, signal,
        setup: async (agentCtx, agent) => {
          await config.initializeInSetup(agentCtx, agent)
          receipt = requireUpdated(await this.store.confirmPreparedHeader({ projectId: envelope.projectId, sessionId: envelope.mainSessionId,
            attemptId: envelope.attemptId, expectedRevision: receipt.session.revision, header: agent.session.header }))
          await inheritMainNativePolicy(agent, nativePolicy)
          const ownership = await this.store.resolveHostOwnership(toHostSessionId)
          if (ownership?.kind !== 'preparation' || ownership.preparation.attemptId !== envelope.attemptId) throw new Error('Prepared ownership is unavailable.')
          await ports.installPrepared(agent, ownership)
          await this.copyHistoryAttachments(agent.id, window, signal, ports.assertValid)
          agent.session.append('projects/history-import', { owner: 'projects-main-continuity', attemptId: envelope.attemptId, history: window.sourcedHistory })
        } } })
      ports.retain(handle)
      signal.throwIfAborted(); ports.assertValid()
      await this.validatePreparedRequest(handle.agent, signal)
      signal.throwIfAborted(); ports.assertValid()
      if (!await this.ctx.sessions.flush(handle.agent.session)) throw new Error('Prepared native Session flush is unavailable.')
      return { handle, header: handle.agent.session.header, revision: receipt.session.revision }
    } catch (error) {
      let retired = false
      try {
        if (handle !== undefined) retired = (await this.control.retire(toHostSessionId, { handle })).status === 'stopped'
        else retired = await this.ctx.sessionPersistence.stat(toHostSessionId) === undefined
      } catch { /* An unconfirmed physical root remains durably owned. */ }
      await this.store.abandonMainPreparation({ projectId: envelope.projectId, sessionId: envelope.mainSessionId, attemptId: envelope.attemptId,
        expectedRevision: receipt.session.revision, retirementConfirmed: retired })
      throw error
    }
  }

  /** Copy exact saved bytes into this root before its durable import references them. */
  private async copyHistoryAttachments(target: SessionId, window: MainHistoryWindow, signal: AbortSignal, assertValid: () => void): Promise<void> {
    const seen = new Set<string>(), hosts = new Set(window.directory.carriers.map(carrier => carrier.hostSessionId))
    const copy = async (host: string, blocks: readonly CommunicationVisibleBlock[]): Promise<void> => {
      for (const block of blocks) {
        if (block.type === 'quoted-tool-result') { await copy(host, block.content); continue }
        if (block.type !== 'image' && block.type !== 'file') continue
        signal.throwIfAborted(); assertValid()
        const key = canonicalJson({ host, kind: block.type, ref: block.attachment })
        if (seen.has(key)) continue
        seen.add(key)
        if (!hosts.has(host)) throw new Error('Historical attachment is outside this stable main.')
        await this.ctx.projectsRead.copyAttachment(SessionId(host), target, block.type === 'image'
          ? { kind: 'image', ref: block.attachment, signal, beforeSave: assertValid }
          : { kind: 'file', ref: block.attachment, signal, beforeSave: assertValid })
        signal.throwIfAborted(); assertValid()
      }
    }
    for (const item of [...window.turns.flatMap(turn => turn.items), ...window.unsettledTurns.flatMap(turn => turn.items), ...window.pendingInputs]) {
      if (item.visibleBlocks === undefined) continue
      const host = item.nativeSource?.hostSessionId
      if (host === undefined) {
        if (item.visibleBlocks.some(block => block.type === 'image' || block.type === 'file' || block.type === 'quoted-tool-result' && block.content.some(part => part.type === 'image' || part.type === 'file'))) throw new Error('Historical attachment has no exact physical holder.')
        continue
      }
      await copy(host, item.visibleBlocks)
    }
  }

  /** Bind and measure a legal complete first-request preview without admitting or streaming it. */
  private async validatePreparedRequest(agent: Agent, signal: AbortSignal): Promise<void> {
    await previewProjectRequest(agent, signal)
    signal.throwIfAborted()
  }

  /** Confirm failed/stale private ownership through its real disposer, without retrying creation. */
  async abandon(envelope: EvaluationEnvelope, prepared: PreparedMainCarrier): Promise<void> {
    const retired = await this.control.retire(prepared.handle.agent.id, { handle: prepared.handle })
    requireUpdated(await this.store.abandonMainPreparation({ projectId: envelope.projectId, sessionId: envelope.mainSessionId,
      attemptId: envelope.attemptId, expectedRevision: prepared.revision, retirementConfirmed: retired.status === 'stopped' }))
    if (retired.status !== 'stopped') throw new Error('Prepared native retirement remains unconfirmed.')
  }
}

function requireUpdated(result: MainPreparationResult): Extract<MainPreparationResult, { kind: 'updated' }> {
  if (result.kind !== 'updated') throw new Error('Main preparation revision conflicted.')
  return result
}
