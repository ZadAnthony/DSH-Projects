import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreparedRequestContext } from './harness.ts'
import type { RequestDispatchData, RequestHistoryImport } from './types.ts'
import { validateRequestHistoryImport } from './projection.ts'
import { captureProjectDispatch, projectRequestFacts, priorProjectDeliveryIds, type ProjectRequestPayload, type ProjectRequestPayloadStore } from './records.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

export type ProjectRequestSnapshot = Omit<GenerateOptions, 'signal' | 'sessionId'>
export interface ProjectPresetIdentity { readonly id: string; readonly generation: string }
export interface ProjectRequestLease extends AsyncDisposable { readonly preset?: ProjectPresetIdentity }
export interface ProjectRequestDispatch {
  version: 1
  dispatchId: string
  turn: number
  step: number
  attempt: number
  prefixLength: number
  request: ProjectRequestSnapshot
  context?: RequestDispatchData
  preset?: ProjectPresetIdentity
}
export interface ProjectAuxiliaryDispatch {
  version: 1; dispatchId: string; purpose: 'compaction'; compactionId: string; attempt: number
  prefixLength: number; request: ProjectRequestSnapshot; context: RequestDispatchData; preset?: ProjectPresetIdentity
}
export interface ProjectToolRaw {
  callSeq: number
  invocationId: string
  parentInvocationId?: string
  phase: 'start' | 'return' | 'throw'
  name: string
  callId: string
  value?: unknown
  error?: string
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'projects/request-dispatch': ProjectRequestDispatch
    'projects/history-import': RequestHistoryImport
    'projects/auxiliary-dispatch': ProjectAuxiliaryDispatch
    'projects/turn-settled': { turn: number; throughSeq: number }
    'projects/tool-raw': ProjectToolRaw
  }
}

/** Request hook used by work/Memory/manager to provide current requirements and a finite history. */
export interface ProjectRequestPreparation extends PreparedRequestContext {
  role: 'work' | 'memory' | 'manager'
  currentRequirements?: string
  /** Exact durable surface seqs selected by the role owner, never a second transcript. */
  historySeqs?: readonly import('@deepseek-ai/dsh-session').SessionSeq[]
}
export interface ProjectRequestHooks {
  beforePrepare?(input: {agent:Agent;turn:number;step:number;attempt:number;signal:AbortSignal}): Promise<ProjectRequestLease | void> | ProjectRequestLease | void
  prepare?(input: { agent: Agent; turn: number; step: number; attempt: number; signal: AbortSignal; purpose?: 'conversation' | 'compaction'; config?: import('@deepseek-ai/dsh-llm').LlmCallConfig; context?: import('@deepseek-ai/dsh-llm').PreparedLlmCall['context'] }): Promise<ProjectRequestPreparation> | ProjectRequestPreparation
}
const requestHooks = new WeakMap<Agent, ProjectRequestHooks | undefined>()
export function bindProjectRequestHooks(agent: Agent, hooks: ProjectRequestHooks | undefined): void { requestHooks.set(agent, hooks) }
export function projectRequestHooks(agent: Agent): ProjectRequestHooks | undefined { return requestHooks.get(agent) }

export interface ProjectDriverPersistence {
  stagePayload?: ProjectRequestPayloadStore['stagePayload']
  readPayload?: ProjectRequestPayloadStore['readPayload']
  flush(): Promise<void>
  assertHealthy(): void
  fail(error: unknown): void
}

/** Bind role owners through this actual per-attempt request preparation chain. */
export async function prepareProjectRequest(
  hooks: ProjectRequestHooks | undefined,
  input: Parameters<NonNullable<ProjectRequestHooks['prepare']>>[0],
): Promise<ProjectRequestPreparation> {
  const value = await hooks?.prepare?.(input) ?? { role: 'work' as const }
  input.signal.throwIfAborted()
  if (!['work', 'memory', 'manager'].includes(value.role)) throw new Error('invalid Project Harness role')
  return value
}

/** Project calls are legal hand-built requests; no AgentLoop-private marker is used. */
export function commitProjectDispatch(session: Session, request: GenerateOptions, position: { turn: number; step: number; attempt: number }, context?: RequestDispatchData, preset?: ProjectPresetIdentity, store?: ProjectRequestPayloadStore, capture?: (payload: ProjectRequestPayload) => void): SessionEvent<'projects/request-dispatch-v2'> {
  if (store === undefined) throw new Error('PROJECT_REQUEST_PAYLOAD_STORE_UNAVAILABLE')
  const { signal: _signal, sessionId: _sessionId, ...snapshot } = request
  const dispatchId = randomUUID(), prefixLength = session.seq
  validateDispatch({ version: 1, dispatchId, ...position, prefixLength, request: snapshot, ...context === undefined ? {} : { context }, ...preset === undefined ? {} : { preset } })
  let captured: ProjectRequestPayload | undefined
  const payload = store.stagePayload(session.id, { codec: 'projects-request/v2', value: { request: snapshot, ...context === undefined ? {} : { context }, ...preset === undefined ? {} : { preset } }, capture: value => { captured = value as ProjectRequestPayload } })
  if (captured === undefined) throw new Error('PROJECT_REQUEST_CAPTURE_UNAVAILABLE')
  capture?.(captured)
  const data = { version: 2 as const, representation: 'recorded' as const, dispatchId, ...position, prefixLength, payload, facts: projectRequestFacts(captured, priorProjectDeliveryIds(session)), ...preset === undefined ? {} : { preset } }
  return captureProjectDispatch(session, dispatchId, captured, () => session.append('projects/request-dispatch-v2', data))
}

export function commitProjectAuxiliaryDispatch(session: Session, request: GenerateOptions, owner: { compactionId: string; attempt: number }, context: RequestDispatchData, preset?: ProjectPresetIdentity, store?: ProjectRequestPayloadStore, capture?: (payload: ProjectRequestPayload) => void): SessionEvent<'projects/auxiliary-dispatch-v2'> {
  if (store === undefined) throw new Error('PROJECT_REQUEST_PAYLOAD_STORE_UNAVAILABLE')
  const { signal: _signal, sessionId: _sessionId, ...snapshot } = request
  const dispatchId = randomUUID(), prefixLength = session.seq
  validateAuxiliary({ version: 1, dispatchId, purpose: 'compaction', ...owner, prefixLength, request: snapshot, context, ...preset === undefined ? {} : { preset } })
  let captured: ProjectRequestPayload | undefined
  const payload = store.stagePayload(session.id, { codec: 'projects-request/v2', value: { request: snapshot, context, ...preset === undefined ? {} : { preset } }, capture: value => { captured = value as ProjectRequestPayload } })
  if (captured === undefined) throw new Error('PROJECT_REQUEST_CAPTURE_UNAVAILABLE')
  capture?.(captured)
  const data = { version: 2 as const, representation: 'recorded' as const, dispatchId, purpose: 'compaction' as const, ...owner, prefixLength, payload, facts: projectRequestFacts(captured), ...preset === undefined ? {} : { preset } }
  return captureProjectDispatch(session, dispatchId, captured, () => session.append('projects/auxiliary-dispatch-v2', data))
}
/** Rebind only the runtime carriers of a snapshot already detached and frozen by persistence. */
export function bindCapturedProjectRequest(snapshot: ProjectRequestSnapshot, session: Session, signal: AbortSignal): GenerateOptions {
  return Object.freeze({ ...snapshot, sessionId: session.id, signal })
}
export function rebuildProjectRequest(dispatch: Pick<ProjectRequestDispatch, 'request'>, session: Session, signal: AbortSignal): GenerateOptions {
  return deepFreeze({ ...structuredClone(dispatch.request), sessionId: session.id, signal })
}

export interface ProjectSchemaPersistence {
  registerProjectEventSchema(type: `projects/${string}`, validate: (data: unknown) => void): void
}
const installed = new WeakSet<object>()
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Project event requires an object')
  const data = value as Record<string, unknown>
  if (required.some(key => !Object.hasOwn(data, key)) || Object.keys(data).some(key => !required.includes(key) && !optional.includes(key))) throw new Error('Project event has invalid fields')
  return data
}
function integer(value: unknown, minimum: number): boolean { return Number.isSafeInteger(value) && (value as number) >= minimum }

function toolSchemas(value: unknown): boolean {
  return Array.isArray(value) && value.every(tool => {
    const data = record(tool, ['name', 'description', 'parameters'], ['deferLoading'])
    return typeof data.name === 'string' && data.name.length > 0 && typeof data.description === 'string' && !!data.parameters && typeof data.parameters === 'object' && !Array.isArray(data.parameters) && (data.deferLoading === undefined || data.deferLoading === true)
  })
}
function validateRequest(value: unknown): void {
  const data = record(value, ['provider', 'model', 'messages'], ['reasoningEffort', 'system', 'tools', 'toolHistory', 'temperature', 'maxTokens', 'stop', 'purpose'])
  if (typeof data.provider !== 'string' || !data.provider || typeof data.model !== 'string' || !data.model || !Array.isArray(data.messages)) throw new Error('invalid Project request route/messages')
  for (const message of data.messages) {
    const item = record(message, ['role', 'content'], ['id', 'source', 'isError', 'toolCallId', 'currentBlock'])
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(String(item.role)) || !Array.isArray(item.content)) throw new Error('invalid Project request message')
    if (item.id !== undefined && typeof item.id !== 'string') throw new Error('invalid Project request message identity')
    if (item.source !== undefined && (!item.source || typeof item.source !== 'object' || typeof (item.source as { kind?: unknown }).kind !== 'string')) throw new Error('invalid Project request message source')
    for (const block of item.content) if (!block || typeof block !== 'object' || typeof (block as { type?: unknown }).type !== 'string') throw new Error('invalid Project request content block')
  }
  if (data.tools !== undefined && !toolSchemas(data.tools)) throw new Error('invalid Project request tools')
  if (data.toolHistory !== undefined) {
    const history = record(data.toolHistory, ['tools', 'updates'])
    if (!toolSchemas(history.tools) || !Array.isArray(history.updates) || !history.updates.every(update => {
      const item = record(update, ['messageId', 'additions'])
      return typeof item.messageId === 'string' && toolSchemas(item.additions)
    })) throw new Error('invalid Project request tool history')
  }
  if (data.reasoningEffort !== undefined && typeof data.reasoningEffort !== 'string') throw new Error('invalid Project request reasoning effort')
  if (data.system !== undefined && typeof data.system !== 'string') throw new Error('invalid Project request system prompt')
  if (data.maxTokens !== undefined && !integer(data.maxTokens, 1)) throw new Error('invalid Project request maxTokens')
  if (data.temperature !== undefined && (typeof data.temperature !== 'number' || !Number.isFinite(data.temperature))) throw new Error('invalid Project request temperature')
  if (data.stop !== undefined && (!Array.isArray(data.stop) || !data.stop.every(value => typeof value === 'string'))) throw new Error('invalid Project request stop sequences')
  if (data.purpose !== undefined && data.purpose !== 'compaction' && data.purpose !== 'session-title') throw new Error('invalid Project request purpose')
}
function validateContext(value: unknown, request: ProjectRequestSnapshot, prefixLength: number): void {
  const data=record(value,['purpose','attempt','envelope','messages','currentBlocks','omissions','surface'],['turn','step','compactionId','toolUpdate','inputPolicy'])
  if(!integer(data.attempt,1)||!['conversation','compaction'].includes(String(data.purpose))||!Array.isArray(data.messages)||data.messages.length!==request.messages.length||!Array.isArray(data.currentBlocks)||!Array.isArray(data.omissions)||!Array.isArray(data.surface))throw new Error('invalid Project request context')
  if(data.purpose==='conversation'&&(!integer(data.turn,1)||!integer(data.step,1))||data.purpose==='compaction'&&typeof data.compactionId!=='string')throw new Error('invalid Project request context owner')
  const envelope=record(data.envelope,['kind','toolHistory'],['headerSeq','header'])
  if(envelope.toolHistory!=='prefix'&&envelope.toolHistory!=='current'||envelope.kind!=='header'&&envelope.kind!=='inline')throw new Error('invalid Project request envelope')
  if(envelope.kind==='header'&&(!integer(envelope.headerSeq,0)||(envelope.headerSeq as number)>=prefixLength||Object.hasOwn(envelope,'header')))throw new Error('invalid Project header reference')
  if(envelope.kind==='inline'){
    const header=record(envelope.header,['config'],['tools','adapterDefaults'])
    const config=record(header.config,['provider','model'],['reasoningEffort','maxTokens','temperature','stop'])
    validateRequest({...config,messages:[],...header.tools===undefined?{}:{tools:header.tools}})
    if(Object.hasOwn(envelope,'headerSeq'))throw new Error('inline Project envelope cannot reference a header')
  }
  if(data.inputPolicy!==undefined&&data.inputPolicy!=='identified-only'||data.toolUpdate!==undefined&&data.toolUpdate!=='in-history'&&data.toolUpdate!=='addition-only')throw new Error('invalid Project request policy')
  for(const raw of data.messages){
    const item=record(raw,['kind'],['seq','message','history','content','currentnessContent'])
    if(item.kind==='event'&&(!integer(item.seq,0)||(item.seq as number)>=prefixLength)||item.kind==='literal'&&(!item.message||typeof item.message!=='object')||item.kind!=='event'&&item.kind!=='literal')throw new Error('invalid Project input origin')
    if(item.history!==undefined){const history=record(item.history,['source','use']);if(history.use!=='historical-evidence')throw new Error('invalid Project historical input use')}
    if(item.kind==='event'&&(Object.hasOwn(item,'message')||Object.hasOwn(item,'history'))||item.kind==='literal'&&(Object.hasOwn(item,'seq')||Object.hasOwn(item,'content')||Object.hasOwn(item,'currentnessContent')))throw new Error('Project input origin fields conflict')
    if(item.content!==undefined&&!Array.isArray(item.content)||item.currentnessContent!==undefined&&!Array.isArray(item.currentnessContent))throw new Error('invalid Project content projection')
  }
  const keys=new Set<string>()
  for(const raw of data.currentBlocks){
    const item=record(raw,['producer','key','inputIndex'])
    const message=request.messages[item.inputIndex as number]
    const key=JSON.stringify([item.producer,item.key])
    if(typeof item.producer!=='string'||typeof item.key!=='string'||!integer(item.inputIndex,0)||message?.role!=='user'||!('currentBlock'in message)||message.currentBlock?.producer!==item.producer||message.currentBlock.key!==item.key||keys.has(key))throw new Error('invalid Project current-object mapping')
    keys.add(key)
  }
  for(const [index,raw] of data.surface.entries()){
    const row=record(raw,['seq','surfaceIndex','inputIndexes'])
    if(!integer(row.seq,0)||(row.seq as number)>=prefixLength||row.surfaceIndex!==index||!Array.isArray(row.inputIndexes)||row.inputIndexes.some(value=>!integer(value,0)||(value as number)>=request.messages.length))throw new Error('invalid Project surface mapping')
    for(const inputIndex of row.inputIndexes){const origin=data.messages[inputIndex] as {kind?:string;seq?:number};if(origin.kind!=='event'||origin.seq!==row.seq)throw new Error('Project input mapping contradicts its origin')}
  }
  const ids=new Set(request.messages.flatMap(message=>message.id===undefined?[]:[message.id]))
  const reference=(value:unknown)=>{const ref=record(value,['messageId','selector']);if(typeof ref.messageId!=='string'||!ids.has(ref.messageId as import('@deepseek-ai/dsh-llm').MessageId)||!Array.isArray(ref.selector)||ref.selector.some(part=>typeof part!=='string'&&!integer(part,0)))throw new Error('invalid Project omission reference');return JSON.stringify(ref)}
  for(const raw of data.omissions){const relation=record(raw,['omitted','keeper','identity']);if(reference(relation.omitted)===reference(relation.keeper))throw new Error('Project omission cannot keep itself');const identity=record(relation.identity,['source','version','range','use']);if(identity.use!=='current-read'&&identity.use!=='historical-evidence')throw new Error('invalid Project body use')}
}
function validatePreset(value: unknown): void {
  const data=record(value,['id','generation'])
  if(typeof data.id!=='string'||!data.id||typeof data.generation!=='string'||!data.generation)throw new Error('invalid actual Project preset identity')
}
const validateDispatch = (value: unknown): void => {
    const data = record(value, ['version', 'dispatchId', 'turn', 'step', 'attempt', 'prefixLength', 'request'], ['context', 'preset'])
    if (data.version !== 1 || typeof data.dispatchId !== 'string' || !data.dispatchId || !integer(data.turn, 1) || !integer(data.step, 1) || !integer(data.attempt, 1) || !integer(data.prefixLength, 0)) throw new Error('invalid projects/request-dispatch')
    validateRequest(data.request)
    if(data.context!==undefined)validateContext(data.context,data.request as ProjectRequestSnapshot,data.prefixLength as number)
    if(data.preset!==undefined)validatePreset(data.preset)
}

const validateSettled = (value: unknown): void => {
    const data = record(value, ['turn', 'throughSeq'])
    if (!integer(data.turn, 1) || !integer(data.throughSeq, 0)) throw new Error('invalid projects/turn-settled')
}

const validateRaw = (value: unknown): void => {
    const data = record(value, ['callSeq', 'invocationId', 'phase', 'name', 'callId'], ['parentInvocationId', 'value', 'error'])
    if (!integer(data.callSeq, 0) || typeof data.invocationId !== 'string' || !data.invocationId || !['start', 'return', 'throw'].includes(String(data.phase)) || typeof data.name !== 'string' || typeof data.callId !== 'string') throw new Error('invalid projects/tool-raw')
    if (data.parentInvocationId !== undefined && typeof data.parentInvocationId !== 'string') throw new Error('invalid Project parent invocation identity')
    if (data.phase === 'return' && !Object.hasOwn(data, 'value')) throw new Error('Project raw return requires value')
    if (data.phase === 'throw' && typeof data.error !== 'string') throw new Error('Project raw throw requires error')
    if (data.phase !== 'return' && Object.hasOwn(data, 'value') || data.phase !== 'throw' && Object.hasOwn(data, 'error')) throw new Error('Project raw phase fields conflict')
}
export function validateProjectToolRaw(value: unknown): void { validateRaw(value) }
const validateAuxiliary = (value: unknown): void => {
  const data=record(value,['version','dispatchId','purpose','compactionId','attempt','prefixLength','request','context'],['preset'])
  if(data.version!==1||data.purpose!=='compaction'||typeof data.dispatchId!=='string'||typeof data.compactionId!=='string'||!integer(data.attempt,1)||!integer(data.prefixLength,0))throw new Error('invalid Projects auxiliary dispatch')
  validateRequest(data.request)
  validateContext(data.context,data.request as ProjectRequestSnapshot,data.prefixLength as number)
  if(data.preset!==undefined)validatePreset(data.preset)
}
const validateReferencedDispatch = (value: unknown, auxiliary: boolean): void => {
  const data = record(value, ['version', 'representation', 'dispatchId', 'prefixLength', 'payload', 'facts', ...(auxiliary ? ['purpose', 'compactionId', 'attempt'] : ['turn', 'step', 'attempt'])], ['preset'])
  if (data.version !== 2 || !['recorded', 'legacy-derived'].includes(String(data.representation)) || typeof data.dispatchId !== 'string' || !data.dispatchId || !integer(data.prefixLength, 0) || !integer(data.attempt, 1)) throw new Error('invalid referenced Project dispatch')
  if (auxiliary ? data.purpose !== 'compaction' || typeof data.compactionId !== 'string' || !data.compactionId : !integer(data.turn, 1) || !integer(data.step, 1)) throw new Error('invalid referenced Project dispatch owner')
  const payload = data.payload as Record<string, unknown>
  if (!payload || !['projects-payload', 'projects-legacy-record'].includes(String(payload.kind)) || payload.version !== 1 || typeof payload.codec !== 'string') throw new Error('invalid referenced Project payload')
  if (data.representation === 'recorded' ? payload.kind !== 'projects-payload' || payload.codec !== 'projects-request/v2' : payload.kind !== 'projects-legacy-record' || payload.codec !== 'projects-request/v1') throw new Error('invalid Project dispatch representation')
  const payloadShape = payload.kind === 'projects-payload'
    ? record(payload, ['kind', 'version', 'codec', 'id', 'digest', 'bytes', 'owner'], ['inheritedFrom'])
    : record(payload, ['kind', 'version', 'codec', 'owner', 'seq', 'type', 'time', 'byteStart', 'byteEnd', 'rawLineDigest', 'eventDigest'])
  const payloadOwner = record(payloadShape.owner, ['projectId', 'logicalSessionId', 'carrierId', 'createdAt'])
  if (['projectId', 'logicalSessionId', 'carrierId'].some(key => typeof payloadOwner[key] !== 'string' || !payloadOwner[key]) || !integer(payloadOwner.createdAt, 0)) throw new Error('invalid Project payload owner')
  if (payload.kind === 'projects-payload') {
    if (typeof payload.id !== 'string' || !/^[0-9a-f-]{36}$/.test(payload.id) || !/^sha256:[0-9a-f]{64}$/.test(String(payload.digest)) || !integer(payload.bytes, 0)) throw new Error('invalid Project payload file reference')
  } else if (!integer(payload.seq, 0) || typeof payload.type !== 'string' || !Number.isSafeInteger(payload.time) || !integer(payload.byteStart, 0) || !integer(payload.byteEnd, 0) || (payload.byteEnd as number) <= (payload.byteStart as number) || !/^sha256:[0-9a-f]{64}$/.test(String(payload.rawLineDigest)) || !/^sha256:[0-9a-f]{64}$/.test(String(payload.eventDigest))) throw new Error('invalid Project legacy reference')
  if (payload.inheritedFrom !== undefined) {
    const inherited = record(payload.inheritedFrom, ['carrierId', 'createdAt', 'seq', 'eventDigest', 'payloadDigest'])
    if (typeof inherited.carrierId !== 'string' || !inherited.carrierId || !integer(inherited.createdAt, 0) || !integer(inherited.seq, 0) || !/^sha256:[0-9a-f]{64}$/.test(String(inherited.eventDigest)) || !/^sha256:[0-9a-f]{64}$/.test(String(inherited.payloadDigest))) throw new Error('invalid inherited Project payload locator')
  }
  const facts = record(data.facts, ['hasContext', 'deliveryPolicy', 'currentBlocks', 'omissions', 'deliveries', 'memoryCatalogs', 'evaluations'], ['systemContentDigest'])
  if (typeof facts.hasContext !== 'boolean' || !['all-inputs', 'first-adoption'].includes(String(facts.deliveryPolicy)) || ['currentBlocks', 'omissions', 'deliveries', 'memoryCatalogs', 'evaluations'].some(key => !Array.isArray(facts[key])) || facts.systemContentDigest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(String(facts.systemContentDigest))) throw new Error('invalid Project dispatch facts')
  for (const value of facts.currentBlocks as unknown[]) {
    const block = record(value, ['producer', 'key', 'inputIndex', 'contentDigest', 'sourceDigest'], ['eventSeq'])
    if (typeof block.producer !== 'string' || typeof block.key !== 'string' || !integer(block.inputIndex, 0) || block.eventSeq !== undefined && !integer(block.eventSeq, 0) || !/^sha256:[0-9a-f]{64}$/.test(String(block.contentDigest)) || !/^sha256:[0-9a-f]{64}$/.test(String(block.sourceDigest))) throw new Error('invalid Project current block facts')
  }
  for (const value of facts.deliveries as unknown[]) {
    const row = record(value, ['id', 'projectId', 'inputIndex'])
    if (typeof row.id !== 'string' || !row.id || typeof row.projectId !== 'string' || !row.projectId || !integer(row.inputIndex, 0)) throw new Error('invalid Project delivery selector')
  }
  for (const value of facts.memoryCatalogs as unknown[]) {
    const row = record(value, ['projectId', 'inputIndex'])
    if (typeof row.projectId !== 'string' || !row.projectId || !integer(row.inputIndex, 0)) throw new Error('invalid Project Memory selector')
  }
  for (const value of facts.evaluations as unknown[]) {
    const row = record(value, ['messageId', 'attemptId', 'inputIndex'])
    if (typeof row.messageId !== 'string' || !row.messageId || typeof row.attemptId !== 'string' || !row.attemptId || !integer(row.inputIndex, 0)) throw new Error('invalid Project evaluation selector')
  }
  const reference = (value: unknown): void => {
    const row = record(value, ['messageId', 'selector'])
    if (typeof row.messageId !== 'string' || !row.messageId || !Array.isArray(row.selector) || row.selector.some(part => typeof part !== 'string' && !integer(part, 0))) throw new Error('invalid Project omission selector')
  }
  for (const value of facts.omissions as unknown[]) {
    const row = record(value, ['omitted', 'keeper', 'identity']); reference(row.omitted); reference(row.keeper)
    const identity = record(row.identity, ['source', 'version', 'range', 'use'])
    if (identity.use !== 'current-read' && identity.use !== 'historical-evidence') throw new Error('invalid Project omission use')
  }
  if (data.preset !== undefined) validatePreset(data.preset)
}
const validateDispatchV2 = (value: unknown): void => validateReferencedDispatch(value, false)
const validateAuxiliaryV2 = (value: unknown): void => validateReferencedDispatch(value, true)
const validateHistoryImport = (value: unknown): void => { validateRequestHistoryImport(value as RequestHistoryImport) }
export function installProjectDriverSchemas(persistence: ProjectSchemaPersistence): void {
  persistence.registerProjectEventSchema('projects/auxiliary-dispatch', validateAuxiliary)
  persistence.registerProjectEventSchema('projects/auxiliary-dispatch-v2', validateAuxiliaryV2)
  persistence.registerProjectEventSchema('projects/request-dispatch-v2', validateDispatchV2)
  persistence.registerProjectEventSchema('projects/history-import', validateHistoryImport)
  persistence.registerProjectEventSchema('projects/request-dispatch', validateDispatch)
  persistence.registerProjectEventSchema('projects/turn-settled', validateSettled)
  persistence.registerProjectEventSchema('projects/tool-raw', validateRaw)
}
