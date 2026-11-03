/** Exact native child address plus the independently captured Project root lease. */
import type { SessionAddress } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { FullProjectClientRemotePort } from '../remote-shim.ts'
import type { CarrierAddress } from '../draft/types.ts'
import { freezeCarrier } from '../draft/types.ts'
import { assertProjectFileBinding, type ProjectFileBinding } from '../read/file-reader.ts'

export interface ProjectSubagentIdentity {
  readonly address: SubagentAddress
  readonly rootProof: CarrierAddress
  /** Native child header; sessionId is its real root logical owner, never a new child membership. */
  readonly childSource: ProjectFileBinding
  readonly isRootCurrent: (proof: CarrierAddress) => boolean
}
export function sameSubagentAddress(a: SubagentAddress, b: SubagentAddress): boolean {
  return a.parentSessionId === b.parentSessionId && a.childSessionId === b.childSessionId && a.mode === b.mode
}

/** No lookup can change the target of an already open Aside. */
export class ProjectSubagentCapture {
  readonly address: SubagentAddress
  readonly rootProof: CarrierAddress
  readonly childSource: ProjectFileBinding
  readonly readOnly: boolean
  private ended = false
  constructor(readonly options: ProjectSubagentIdentity, private readonly failed: (error: Error) => void = () => {}) {
    assertProjectFileBinding(options.childSource)
    this.rootProof = freezeCarrier(options.rootProof)
    this.address = Object.freeze({ ...options.address })
    this.childSource = Object.freeze({ ...options.childSource })
    if (!this.address.parentSessionId || !this.address.childSessionId || this.address.parentSessionId === this.address.childSessionId
      || !['one-shot', 'continuable', 'unknown'].includes(this.address.mode)
      || this.childSource.hostSessionId !== this.address.childSessionId
      || this.childSource.projectId !== this.rootProof.projectId || this.childSource.sessionId !== this.rootProof.logicalSessionId) {
      throw new Error('PROJECT_SUBAGENT_IDENTITY_INVALID: exact child header, address and real root owner are required')
    }
    this.readOnly = this.address.mode !== 'continuable'
  }
  private assertOpen(): void { if (this.ended) throw new Error('PROJECT_SUBAGENT_DOMAIN_ENDED') }
  assertAddress(address: SessionAddress): void {
    this.assertOpen()
    if (address.kind !== 'subagent' || !sameSubagentAddress(address, this.address)) throw new Error('PROJECT_SUBAGENT_ADDRESS_CHANGED')
  }
  assertChild(id: SessionId): void { this.assertOpen(); if (id !== this.address.childSessionId) throw new Error('PROJECT_SUBAGENT_FOREIGN_SESSION') }
  assertWritable(): void {
    let error: Error | undefined
    if (this.ended) error = new Error('PROJECT_SUBAGENT_DOMAIN_ENDED')
    else if (this.readOnly) error = new Error('PROJECT_READ_ONLY: this native child mode has no writer')
    else if (!this.options.isRootCurrent(this.rootProof)) error = new Error('PROJECT_INPUT_STALE: the root carrier changed; this child draft remains in its original Aside')
    if (error !== undefined) { this.failed(error); throw error }
  }
  target(id: SessionId) {
    this.assertOpen()
    // Native subagent.prompt captures its direct parent, while all other controls capture the child.
    if (id !== this.address.childSessionId && id !== this.address.parentSessionId) throw new Error('PROJECT_SUBAGENT_FOREIGN_SESSION')
    return { sessionId: id, carrier: this.rootProof,
      ...(this.readOnly ? { readonly: true as const } : {}) }
  }
  dispose(): void { this.ended = true }
}

/** Named façade methods stay on the real port; only this child's routing and admission are wrapped. */
export function projectSubagentRemote(port: FullProjectClientRemotePort, capture: ProjectSubagentCapture): FullProjectClientRemotePort {
  const follow: FullProjectClientRemotePort['uiFollow'] = (request, signal) => {
    capture.assertAddress(request.address)
    const stream = (capture.readOnly ? port.uiFollowReadonly : port.uiFollow).call(port, request, signal)
    return { send: item => stream.send(item), end: () => stream.end(), dispose: () => stream.dispose(),
      async *[Symbol.asyncIterator]() {
        try {
          for await (const frame of stream) {
            if (frame.type === 'snapshot' && (frame.header.id !== capture.childSource.hostSessionId
              || frame.header.createdAt !== capture.childSource.sessionCreatedAt)) {
              throw new RemoteError('gateway/internal', 'PROJECT_SOURCE_STALE: native child header no longer matches', { reason: 'PROJECT_SOURCE_STALE' })
            }
            yield frame
          }
        } finally { stream.dispose() }
      } }
  }
  const childWrite = (id: SessionId): void => { capture.assertChild(id); capture.assertWritable() }
  return {
    list: () => port.list(), get: request => port.get(request),
    create: async () => { capture.assertWritable(); throw new Error('PROJECT_SUBAGENT_OPERATION_UNAVAILABLE: create a Project session from its owner') },
    uiControl: signal => {
      const stream = port.uiControl(signal)
      return { send: item => stream.send(item), end: () => stream.end(), dispose: () => stream.dispose(),
        async *[Symbol.asyncIterator]() {
          try {
            for await (const frame of stream) {
              if (frame.type === 'error' && frame.sessionId !== capture.address.childSessionId) continue
              yield frame
            }
          } finally { stream.dispose() }
        } }
    },
    uiModelCatalog: () => port.uiModelCatalog(),
    uiProjections: (request, signal) => { capture.assertChild(request.sessionId); return port.uiProjections(request, signal) },
    uiSearch: (request, signal) => port.uiSearch(request, signal),
    uiCommandCatalog: (request, signal) => { capture.assertChild(request.sessionId); return port.uiCommandCatalog(request, signal) },
    uiFileCandidates: (request, signal) => { capture.assertChild(request.sessionId); return port.uiFileCandidates(request, signal) },
    uiSessionCandidates: (request, signal) => { capture.assertChild(request.sessionId); return port.uiSessionCandidates(request, signal) },
    uiSubagentAddress: (request, signal) => { capture.assertChild(request.sessionId); return port.uiSubagentAddress(request, signal) },
    uiSubagentCatalog: (request, signal) => { capture.assertChild(request.sessionId); return port.uiSubagentCatalog(request, signal) },
    uiPermissionCatalog: () => port.uiPermissionCatalog(), uiAgentPresetList: () => port.uiAgentPresetList(),
    uiSkills: (request, signal) => port.uiSkills(request, signal),
    uiJobList: (request, signal) => port.uiJobList(request, signal), uiJobFollow: (request, signal) => port.uiJobFollow(request, signal),
    uiInteractions: (request, signal) => { childWrite(request.sessionId); return port.uiInteractions(request, signal) },
    uiFollow: follow, uiFollowReadonly: follow,
    uiPage: ((request, signal) => { capture.assertAddress(request.address); return port.uiPage(request, signal) }) as FullProjectClientRemotePort['uiPage'],
    uiAttachment: (request => { capture.assertChild(request.sessionId); return port.uiAttachment(request) }) as FullProjectClientRemotePort['uiAttachment'],
    uiPrompt: ((request, signal) => { childWrite(request.sessionId); return port.uiPrompt(request, signal) }) as FullProjectClientRemotePort['uiPrompt'],
    uiCancel: (request => { childWrite(request.sessionId); return port.uiCancel(request) }) as FullProjectClientRemotePort['uiCancel'],
    uiUpdateQueue: (request => { childWrite(request.sessionId); return port.uiUpdateQueue(request) }) as FullProjectClientRemotePort['uiUpdateQueue'],
    uiSelectModel: (request => { childWrite(request.sessionId); return port.uiSelectModel(request) }) as FullProjectClientRemotePort['uiSelectModel'],
    uiRename: (request => { childWrite(request.sessionId); return port.uiRename(request) }) as FullProjectClientRemotePort['uiRename'],
    uiExecuteCommand: ((request, signal) => { childWrite(request.sessionId); return port.uiExecuteCommand(request, signal) }) as FullProjectClientRemotePort['uiExecuteCommand'],
    uiAnswerQuestion: (request => { childWrite(request.sessionId); return port.uiAnswerQuestion(request) }) as FullProjectClientRemotePort['uiAnswerQuestion'],
    uiAttachQuestionWait: ((request, signal) => { childWrite(request.sessionId); return port.uiAttachQuestionWait(request, signal) }) as FullProjectClientRemotePort['uiAttachQuestionWait'],
    uiSetPlan: (request => { childWrite(request.sessionId); return port.uiSetPlan(request) }) as FullProjectClientRemotePort['uiSetPlan'],
    // Upload's shim has already read the body; checking here closes its await-to-dispatch gap.
    uiUpload: ((request, signal) => { childWrite(request.sessionId); return port.uiUpload(request, signal) }) as FullProjectClientRemotePort['uiUpload'],
    uiRespondInteraction: (request => { childWrite(request.sessionId); return port.uiRespondInteraction(request) }) as FullProjectClientRemotePort['uiRespondInteraction'],
    uiAgentPresetSelect: (request => { childWrite(request.sessionId); return port.uiAgentPresetSelect(request) }) as FullProjectClientRemotePort['uiAgentPresetSelect'],
    uiJobKill: (request => { childWrite(request.sessionId); return port.uiJobKill(request) }) as FullProjectClientRemotePort['uiJobKill'],
    uiSubagentPrompt: ((request, signal) => {
      if (!sameSubagentAddress({ ...request, mode: request.mode }, capture.address)) throw new Error('PROJECT_SUBAGENT_ADDRESS_CHANGED')
      capture.assertWritable(); return port.uiSubagentPrompt(request, signal)
    }) as FullProjectClientRemotePort['uiSubagentPrompt'],
    uiSubagentInterrupt: (request => {
      if (!sameSubagentAddress(request, capture.address)) throw new Error('PROJECT_SUBAGENT_ADDRESS_CHANGED')
      capture.assertWritable(); return port.uiSubagentInterrupt(request)
    }) as FullProjectClientRemotePort['uiSubagentInterrupt'],
  }
}
