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
// MIT; finite native runtime-context currentness algorithm from verified Projects 41.3.
import type { ContextSnapshotSection } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { RequestCurrentBlock,RequestHistoryProjection } from './types.ts'
import {getLatestConversationDispatch} from './projection.ts'
export function prepareRuntimeCurrentBlocks(session: Session, sections: readonly ContextSnapshotSection[]): readonly RequestCurrentBlock[] {
  const current=sections.map(section=>({producer:'runtime-context',key:section.name,value:{content:[{type:'text' as const,text:section.text}],source:{kind:'runtime-context' as const,form:'snapshot' as const,sections:[section]}}}))
  const present=new Set(current.map(block=>block.key))
  const removed=getLatestConversationDispatch(session)?.data.currentBlocks.filter(block=>block.producer==='runtime-context'&&!present.has(block.key)).map(block=>({producer:block.producer,key:block.key,value:null}))??[]
  return [...current,...removed]
}
/**
 * Remove only refreshed named values from legacy native snapshots, preserving other owners' text.
 * @param projection - optional product currentness and structured omission capability.
 * @param sections - native named sections replaced by freshly prepared current values.
 * @returns a pure projection; mixed already-projected snapshots require exact contextSections.
 */
export function withRuntimeRequestProjection(projection?: RequestHistoryProjection, sections: readonly ContextSnapshotSection[] = []): RequestHistoryProjection {
  const refreshed=new Set(sections.map(section=>section.name))
  return {
    projectCurrentness(history) {
      const own=projection?.projectCurrentness(history)
      const excluded=new Set(own?.excludeMessageIds??[])
      const changed=new Map((own?.overrides??[]).map(item=>[item.messageId,item]))
      const declared=new Map((own?.contextSections??[]).map(item=>[item.messageId,item.sections]))
      for(const {message} of history){
        if(message.role!=='user'||message.id===undefined||message.source?.kind!=='runtime-context'||'currentBlock' in message&&message.currentBlock!==undefined||excluded.has(message.id)) continue
        const source=message.source
        if(source.form!=='snapshot') continue
        // Another owner must identify the exact retained sections when it has already projected this mixed snapshot.
        if(changed.has(message.id)&&!declared.has(message.id)) continue
        const previous=declared.get(message.id)??source.sections
        const remaining=previous.filter(section=>!refreshed.has(section.name))
        if(remaining.length===previous.length) continue
        if(remaining.length===0){excluded.add(message.id);changed.delete(message.id)}
        else changed.set(message.id,{messageId:message.id,content:[{type:'text',text:remaining.map(section=>section.text).join('\n\n')}]})
      }
      return {...own,overrides:[...changed.values()],excludeMessageIds:[...excluded]}
    },
    renderOmissions(history, omitted) { return projection?.renderOmissions(history,omitted)??[] },
  }
}

