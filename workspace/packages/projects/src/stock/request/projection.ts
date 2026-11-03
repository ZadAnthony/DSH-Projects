/*!
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
// Finite currentness/omission planner migrated from Projects 41.3; native Session and its surface remain authoritative.
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage, RequestMessage } from '@deepseek-ai/dsh-llm'
import { deepFreeze, isJsonValue } from '@deepseek-ai/dsh-util-values'
import { canonicalHeader, headerEquals, foldSurface, deriveEventMessage, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { RequestCurrentBlockKey, RequestCandidateMessage, RequestContentProjection, RequestBodyOccurrence, RequestOmissionRelation, RequestOccurrenceRef, RequestDispatchPlanInput, RequestDispatchPlan, RequestDispatchedCurrentBlock, RequestInputRecord, RequestDispatchData, RequestHistoryImport, RequestSourcedHistory } from './types.ts'
import { dispatchFacts, latestProjectContextDispatch, type ProjectRequestRuntimeFacts } from './records.ts'
import { nativeSourceDigest } from '../../native-source-host.ts'
export type ContextDispatch = { seq: SessionSeq; data: ProjectRequestRuntimeFacts }
export function getLatestConversationDispatch(session: Session): ContextDispatch | undefined {
  const event = latestProjectContextDispatch(session)
  return event === undefined ? undefined : { seq: event.seq, data: dispatchFacts(event) }
}
export function deriveRequestDispatch(session: Session, seq: SessionSeq) {
  const event=session.eventAt(seq)
  if(event?.type!=='projects/request-dispatch')throw new Error('Project request dispatch is unavailable')
  const data=event.data, context=data.context
  const surfaceIndexBySeq=new Map<SessionSeq,number>()
  for(const [index,row] of (context?.surface??[]).entries()) if(!surfaceIndexBySeq.has(row.seq)) surfaceIndexBySeq.set(row.seq,index)
  return {event,messages:data.request.messages,envelope:canonicalHeader({config:{provider:data.request.provider,model:data.request.model,...data.request.reasoningEffort===undefined?{}:{reasoningEffort:data.request.reasoningEffort},...data.request.maxTokens===undefined?{}:{maxTokens:data.request.maxTokens},...data.request.temperature===undefined?{}:{temperature:data.request.temperature},...data.request.stop===undefined?{}:{stop:data.request.stop}},...data.request.tools===undefined?{}:{tools:data.request.tools}}),toolHistory:data.request.toolHistory,
    origins:context?.messages.map(record=>record.kind==='literal'?{kind:'literal' as const,...record.history?{history:record.history}:{}}:{kind:'event' as const,seq:record.seq,surfaceIndex:surfaceIndexBySeq.get(record.seq)??-1})??data.request.messages.map(()=>({kind:'literal' as const}))}
}
export function readRequestHistory(session: Session, selectedSeqs?: readonly SessionSeq[]): readonly RequestCandidateMessage[] {
 const selected=selectedSeqs===undefined?undefined:new Set(selectedSeqs)
 if(selected){
  const surface=new Set(session.surface.nodes)
  if([...selected].some(seq=>!surface.has(seq)))throw new Error('request history selects a non-current surface node')
 }
 const actual=new Map(session.deriveMessages().map(message=>[message.id,message]))
 return deepFreeze(session.surface.nodes.flatMap((seq,surfaceIndex)=>{
  if(selected&&!selected.has(seq))return[]
  const event=session.eventAt(seq);const original=event?deriveEventMessage(event):null
  const message=original?actual.get(original.id)??original:null
  return message===null?[]:[{message,origin:{kind:'event' as const,seq,surfaceIndex}}]
 }))
}
// Session owns an immutable append-only log. Retain only an event locator and
// the examined cut, never another copy of imported messages or source bodies.
// A cold Session has its own key; later reads inspect only its appended suffix.
const sourcedHistoryCuts = new WeakMap<Session, { through: number; latest?: SessionSeq }>()
export function readRequestSourcedHistory(session: Session):readonly RequestSourcedHistory[]{
 const cut: { through: number; latest?: SessionSeq } = sourcedHistoryCuts.get(session) ?? { through: 0 }
 const through = Number(session.seq)
 for (let index = through - 1; index >= cut.through; index--) {
  const event = session.eventAt(SessionSeq(index))
  if (event?.type === 'projects/history-import') { cut.latest = event.seq; break }
 }
 cut.through = through
 sourcedHistoryCuts.set(session, cut)
 const event = cut.latest === undefined ? undefined : session.eventAt(cut.latest)
 return event?.type==='projects/history-import'?event.data.history:[]
}
export function validateRequestHistoryImport(imported: RequestHistoryImport):void{
 if(!imported||typeof imported.owner!=='string'||!imported.owner||typeof imported.attemptId!=='string'||!imported.attemptId||!Array.isArray(imported.history))throw new Error('invalid Project historical import')
 for(const item of imported.history)if(!item||item.use!=='historical-evidence'||!isJsonValue(item.source)||!item.message||!['user','assistant','tool'].includes(item.message.role)||!Array.isArray(item.message.content))throw new Error('invalid Project historical evidence')
}
export function commitRequestPlan(session:Session,plan:RequestDispatchPlan):RequestDispatchData{
 if(plan.previewOnly||session.seq!==plan.baseRevision)throw new Error('Project request candidate became stale')
 const records=plan.records.map(record=>({...record}));const surface=plan.surface.map(row=>({...row,inputIndexes:[...row.inputIndexes]}))
 for(const append of plan.appends){const event=session.append('user/message',append.message,{surfaceOp:'append'});records[append.inputIndex]={kind:'event',seq:event.seq};surface.push({seq:event.seq,surfaceIndex:surface.length,inputIndexes:[append.inputIndex]})}
 return {...plan.owner,envelope:plan.dispatchEnvelope,messages:records,currentBlocks:plan.currentBlocks,omissions:plan.omissions,surface,...plan.toolUpdate===undefined?{}:{toolUpdate:plan.toolUpdate},...plan.inputPolicy===undefined?{}:{inputPolicy:plan.inputPolicy}}
}
/** JSON equality independent of producer object-key insertion order. */
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v,i)=>equal(v,b[i]))
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  const left = a as Record<string, unknown>; const right = b as Record<string, unknown>
  return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(k=>Object.hasOwn(right,k)&&equal(left[k],right[k]))
}
function key(block: RequestCurrentBlockKey): string { return JSON.stringify([block.producer,block.key]) }
function identifiedUser(message: RequestMessage): message is UserMessage { return message.role === 'user' && message.id !== undefined && message.source !== undefined }
function refKey(ref: RequestOccurrenceRef): string { return JSON.stringify([ref.messageId,ref.selector]) }

function overrides(history: readonly RequestCandidateMessage[], changes: readonly RequestContentProjection[] = []): RequestCandidateMessage[] {
  const byId=new Map(changes.map(change=>[change.messageId,change.content]))
  if(byId.size!==changes.length) throw new Error('duplicate request content projection')
  const ids=new Set(history.map(item=>item.message.id))
  for(const change of changes) if(!ids.has(change.messageId)) throw new Error('request projection targets an absent message')
  return history.map(item=>{
    const content=item.message.id===undefined?undefined:byId.get(item.message.id)
    if(content===undefined) return item
    if(item.message.role==='assistant'||item.message.role==='developer'||item.message.role==='system'||item.message.role==='user'&&item.message.source?.kind==='user') throw new Error('request projection cannot rewrite original user, assistant, developer or system input')
    return {...item,message:{...item.message,content}}
  })
}
/** Validate inherited relations before creating any new omission at an allowed trigger. */
function omissionsFor(occurrences: readonly RequestBodyOccurrence[], inherited: readonly RequestOmissionRelation[], allowNew: boolean): RequestOmissionRelation[] {
  const byRef=new Map(occurrences.map(item=>[refKey(item),item]))
  if(byRef.size!==occurrences.length) throw new Error('duplicate body occurrence selector')
  const relations:RequestOmissionRelation[]=[]; const omitted=new Set<string>()
  if(allowNew){
    for(const a of occurrences){
      const keeper=occurrences.find(b=>equal(b.identity,a.identity)&&b.body===a.body)
      if(keeper===undefined||keeper===a) continue
      relations.push({omitted:{messageId:a.messageId,selector:a.selector},keeper:{messageId:keeper.messageId,selector:keeper.selector},identity:a.identity})
    }
    return relations
  }
  for(const old of inherited){
    const a=byRef.get(refKey(old.omitted)); const b=byRef.get(refKey(old.keeper))
    if(!a||!b||a===b||a.body!==b.body||!equal(a.identity,b.identity)||!equal(a.identity,old.identity)||omitted.has(refKey(b))) continue
    relations.push(old); omitted.add(refKey(a))
  }
  return relations
}
export function planRequestDispatch(session: Session, input: RequestDispatchPlanInput): RequestDispatchPlan {
  // Only a prospective admission needs to fold a synthetic full prefix. An
  // ordinary request already has the authoritative current Session surface.
  const committed = input.pending === undefined ? undefined : session.snapshotEvents()
  const prefix: readonly SessionEvent[] | undefined = committed === undefined ? undefined : [
    ...committed, ...input.pending!.map((event, index) => ({ ...event, seq: SessionSeq(committed.length + index), time: 0 })),
  ]
  if(input.headerSeq!==undefined){ const header=prefix===undefined?session.eventAt(input.headerSeq):prefix[input.headerSeq]; if(header?.type!=='request/header'||!headerEquals(header.data.header,input.header)) throw new Error('request candidate header does not match its committed reference') }
  const pendingSurface = prefix === undefined ? undefined : foldSurface(prefix, [])
  const selectedHistory=input.historySeqs===undefined?undefined:new Set(input.historySeqs)
  const currentSurfaceIndexes=pendingSurface===undefined?undefined:new Map(session.surface.nodes.map((seq,index)=>[seq,index]))
  const pendingSurfaceIndexes=pendingSurface===undefined?undefined:new Map(pendingSurface.nodes.map((seq,index)=>[seq,index]))
  const base: readonly RequestCandidateMessage[] = pendingSurface === undefined ? readRequestHistory(session,input.historySeqs)
    : deepFreeze(pendingSurface.nodes.flatMap(seq => {
      if (selectedHistory !== undefined && seq < committed!.length && !selectedHistory.has(seq)) return []
      const message = deriveEventMessage(prefix![seq]!, pendingSurface.projectedMessages)
      if (message === null) return []
      return [{ message, origin: { kind: 'event' as const, seq,
        surfaceIndex: (seq < committed!.length ? currentSurfaceIndexes!.get(seq) : pendingSurfaceIndexes!.get(seq))??-1,
      } }]
    }))
  const previous=getLatestConversationDispatch(session)
  const baseBySeq=new Map<SessionSeq,RequestCandidateMessage>()
  for(const item of base) if(item.origin.kind==='event'&&!baseBySeq.has(item.origin.seq)) baseBySeq.set(item.origin.seq,item)
  const blocks=input.currentBlocks??[]; const blockKeys=new Set(blocks.map(key)); const producers=new Set(blocks.map(block=>block.producer))
  if(blockKeys.size!==blocks.length) throw new Error('duplicate current block key')
  let history:RequestCandidateMessage[]=base.filter(item=>{
    if(input.system!==undefined&&item.message.role==='system') return false
    if(!identifiedUser(item.message)||item.message.currentBlock===undefined) return true
    const currentBlock=item.message.currentBlock
    if(producers.has(currentBlock.producer)) return false
    return previous?.data.currentBlocks.some(block=>{
      return key(block)===key(currentBlock)&&block.eventSeq!==undefined&&item.origin.kind==='event'&&block.eventSeq===item.origin.seq
    })===true
  })
  const currents:RequestDispatchedCurrentBlock[]=[]; const newMessages=new Set<UserMessage>()
  for(const block of [...blocks].sort((a,b)=>key(a)<key(b)?-1:key(a)>key(b)?1:0)){
    if(block.value===null) continue
    const old=previous?.data.currentBlocks.find(row=>key(row)===key(block))
    const retained=old?.eventSeq===undefined?undefined:baseBySeq.get(old.eventSeq)
    let item:RequestCandidateMessage
    if(input.owner.purpose==='conversation'&&retained&&old&&old.contentDigest===nativeSourceDigest(block.value.content)&&old.sourceDigest===nativeSourceDigest(block.value.source)) item=retained
    else {
      const message=deepFreeze({...createUserMessage(block.value),currentBlock:{producer:block.producer,key:block.key}})
      item={message,origin:{kind:'literal'}}
      if(input.owner.purpose==='conversation') newMessages.add(message)
    }
    history.push(item)
    currents.push({producer:block.producer,key:block.key,inputIndex:0})
  }
  // Retained current nodes keep their real historical positions; only new blocks go to the tail.
  history.sort((a,b)=>a.origin.kind==='event'&&b.origin.kind==='event'?a.origin.surfaceIndex-b.origin.surfaceIndex:a.origin.kind==='event'?-1:b.origin.kind==='event'?1:0)
  if(input.system!==undefined) history.unshift({message:input.system,origin:{kind:'literal'}})
  const sourced = input.sourcedHistory ?? readRequestSourcedHistory(session)
  if (sourced.length > 0) {
    const at = history[0]?.message.role === 'system' ? 1 : 0
    history.splice(at, 0, ...sourced.map(item => ({ message: item.message,
      origin: { kind: 'literal' as const, history: { source: item.source, use: item.use } } })))
  }
  const projected=input.historyProjection?.projectCurrentness(history)
  if(projected?.excludeMessageIds){
    const excluded=new Set(projected.excludeMessageIds)
    for(const item of history) if(item.message.id!==undefined&&excluded.has(item.message.id)&&(item.message.role!=='user'||item.message.source?.kind==='user')) throw new Error('only sourced supplemental messages may exit the current request')
    history=history.filter(item=>item.message.id===undefined||!excluded.has(item.message.id))
  }
  history=overrides(history,projected?.overrides)
  let occurrences:RequestBodyOccurrence[]=[]
  if(projected?.occurrences?.length){
    const firstMessageIndex=new Map<RequestMessage['id'],number>()
    const eventMessageIds=new Map<SessionSeq,Set<RequestMessage['id']>>()
    for(const [index,item] of history.entries()){
      if(!firstMessageIndex.has(item.message.id)) firstMessageIndex.set(item.message.id,index)
      if(item.origin.kind==='event'){
        let ids=eventMessageIds.get(item.origin.seq)
        if(ids===undefined) eventMessageIds.set(item.origin.seq,ids=new Set())
        ids.add(item.message.id)
      }
    }
    occurrences=projected.occurrences.filter(o=>eventMessageIds.get(o.seq)?.has(o.messageId)).toSorted((a,b)=>firstMessageIndex.get(a.messageId)!-firstMessageIndex.get(b.messageId)!)
  }
  const currentnessHistory=history
  const omissions=omissionsFor(occurrences,previous?.data.omissions??[],input.allowNewOmissions!==undefined)
  const omittedRefs=new Set(omissions.map(relation=>refKey(relation.omitted)))
  const omitted=occurrences.filter(o=>omittedRefs.has(refKey(o)))
  if(omitted.length>0&&input.historyProjection) history=overrides(history,input.historyProjection.renderOmissions(history,omitted))
  history.push(...(input.suffix??[]).map(message=>({message,origin:{kind:'literal' as const}})))
  history=overrides(history,input.contentProjection)
  for(const current of currents){
    const index=history.findIndex(item=>identifiedUser(item.message)&&item.message.currentBlock!==undefined&&key(item.message.currentBlock)===key(current))
    if(index<0) throw new Error('current block missing from final request');(current as {inputIndex:number}).inputIndex=index
  }
  for(const [inputIndex,item] of history.entries()) {
    if(!identifiedUser(item.message)||item.message.currentBlock===undefined) continue
    const currentBlock=item.message.currentBlock
    if(!currents.some(block=>key(block)===key(currentBlock))) currents.push({...currentBlock,inputIndex})
  }
  const currentnessById=new Map<RequestMessage['id'],RequestCandidateMessage>()
  for(const item of currentnessHistory) if(!currentnessById.has(item.message.id)) currentnessById.set(item.message.id,item)
  const omittedIds=new Set<RequestMessage['id']>(omissions.map(relation=>relation.omitted.messageId))
  const records:RequestInputRecord[]=history.map(item=>{
    if(item.origin.kind==='literal') return {kind:'literal',message:item.message,...item.origin.history === undefined ? {} : { history: item.origin.history }}
    const sourceSeq=item.origin.seq
    const original=baseBySeq.get(sourceSeq)?.message
    const beforeOmission=currentnessById.get(item.message.id)?.message.content
    const hasOmission=omittedIds.has(item.message.id)
    return {kind:'event',seq:item.origin.seq,...equal(original?.content,item.message.content)?{}:{content:item.message.content},...hasOmission&&!equal(original?.content,beforeOmission)&&beforeOmission!==undefined?{currentnessContent:beforeOmission}:{}}
  })
  const appends=history.flatMap((item,inputIndex)=>identifiedUser(item.message)&&newMessages.has(item.message)?[{inputIndex,message:item.message}]:[])
  const inputIndexesBySeq=new Map<SessionSeq,number[]>()
  for(const [index,item] of history.entries()) if(item.origin.kind==='event'){
    let indexes=inputIndexesBySeq.get(item.origin.seq)
    if(indexes===undefined) inputIndexesBySeq.set(item.origin.seq,indexes=[])
    indexes.push(index)
  }
  const surface=session.surface.nodes.map((seq,surfaceIndex)=>({seq,surfaceIndex,inputIndexes:inputIndexesBySeq.get(seq)??[]}))
  const mode=input.toolHistory??'prefix'
  return deepFreeze({...input.pending === undefined ? {} : { previewOnly: true as const },baseRevision:session.seq,owner:input.owner,envelope:structuredClone(canonicalHeader(input.header)),...mode==='prefix'?{toolHistory:session.toolHistory()}:{},...input.toolUpdate===undefined?{}:{toolUpdate:input.toolUpdate},messages:history,currentBlocks:currents,omissions,surface,...input.inputPolicy===undefined?{}:{inputPolicy:input.inputPolicy},appends,records,dispatchEnvelope:input.owner.purpose==='conversation'&&input.headerSeq!==undefined?{kind:'header',headerSeq:input.headerSeq,toolHistory:mode}:{kind:'inline',header:structuredClone(canonicalHeader(input.header)),toolHistory:mode}})
}
