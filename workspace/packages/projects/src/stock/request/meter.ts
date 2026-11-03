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
// MIT; finite exact-candidate attachment pricing adapted from the validated Projects 41.3 token-meter algorithms.
import type { Agent } from '@deepseek-ai/dsh-agent'
import { projectToolUpdates } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ImageBlock, RequestMessage, LlmImageRequestPricing, ToolSchema, ToolHistory, ToolUpdate } from '@deepseek-ai/dsh-llm'
import type { EpochHeader, Session } from '@deepseek-ai/dsh-session'
import { headerEquals } from '@deepseek-ai/dsh-session'
import { estimateContent, estimateMessage, estimateStructuralBlock, estimateToolsTokens, ROLE_OVERHEAD } from './meter-estimate.ts'
import type { RequestDispatchCandidate } from './types.ts'
type FileAttachmentRef = Extract<ContentBlock, { type: 'file' }>['attachment']
interface PricedMessages { readonly nodes: readonly {tokens:number;heuristicTokens:number}[]; readonly surfaceTokens:number }
/** Message prices and attachment occurrences shared by durable and literal inputs. */
export interface MeterMessageNode {
  /** Fixed-heuristic price of the node's exact message. */
  readonly heuristicTokens: number
  /** Structural JSON price replaced when the routed request projects images. */
  readonly imageStructuralTokens: number
  /** Structural JSON price replaced when request assembly projects files to text. */
  readonly fileStructuralTokens: number
  /** Durable image blocks in message order, `offloaded` marks included; empty for image-free nodes. */
  readonly images: readonly ImageBlock[]
  /** Durable file occurrences in message order; empty for file-free nodes. */
  readonly files: readonly FileAttachmentRef[]
}

/** Collect projected attachment occurrences and their structural prices. */
function collectProjectedAttachments(
  blocks: readonly ContentBlock[],
  images: ImageBlock[],
  files: FileAttachmentRef[],
): { readonly imageTokens: number; readonly fileTokens: number } {
  let imageTokens = 0
  let fileTokens = 0
  for (const block of blocks) {
    if (block.type === 'image') {
      images.push(block)
      imageTokens += estimateStructuralBlock(block)
    } else if (block.type === 'file') {
      files.push(block.attachment)
      fileTokens += estimateStructuralBlock(block)
    }
  }
  return { imageTokens, fileTokens }
}

/**
 * Price an exact model-visible message without inventing a durable identity.
 * @param message - resolved event input or literal; null denotes a dormant surface node.
 * @returns fixed prices and attachment occurrences for route pricing.
 */
export function analyzeMessageTokens(message: RequestMessage | null): MeterMessageNode {
  if (message === null) {
    return {
      heuristicTokens: 0,
      imageStructuralTokens: 0,
      fileStructuralTokens: 0,
      images: [],
      files: [],
    }
  }
  const heuristicTokens = message.role === 'system'
    ? estimateMessage(message)
    : estimateContent(message.content) + ROLE_OVERHEAD
  const images: ImageBlock[] = []
  const files: FileAttachmentRef[] = []
  const structural = collectProjectedAttachments(message.content, images, files)
  return {
    heuristicTokens,
    imageStructuralTokens: structural.imageTokens,
    fileStructuralTokens: structural.fileTokens,
    images,
    files,
  }
}

export function priceMessageTokens(
  nodes: readonly MeterMessageNode[],
  pricing: LlmImageRequestPricing | undefined,
  fileText?: (ref: FileAttachmentRef) => string,
): PricedMessages {
  const images = pricing === undefined ? [] : nodes.flatMap(node => node.images)
  const hasFiles = fileText !== undefined && nodes.some(node => node.files.length > 0)
  if ((pricing === undefined || images.length === 0) && !hasFiles) {
    let surfaceTokens = 0
    const publicNodes = nodes.map((node) => {
      surfaceTokens += node.heuristicTokens
      return { tokens: node.heuristicTokens, heuristicTokens: node.heuristicTokens }
    })
    return { nodes: publicNodes, surfaceTokens }
  }
  const prices = pricing === undefined ? [] : pricing.priceImages(images)
  if (pricing !== undefined && prices.length !== images.length) {
    throw new Error(
      `token meter: route image pricing answered ${prices.length} prices for ${images.length} occurrences`,
    )
  }
  let cursor = 0
  let surfaceTokens = 0
  const publicNodes = nodes.map((node) => {
    let tokens = node.heuristicTokens
    if (fileText !== undefined && node.files.length > 0) {
      tokens -= node.fileStructuralTokens
      for (const file of node.files) {
        tokens += estimateContent([{ type: 'text', text: fileText(file) }])
      }
    }
    if (pricing !== undefined && node.images.length > 0) {
      tokens -= node.imageStructuralTokens
      for (let occurrence = 0; occurrence < node.images.length; occurrence += 1) {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- length equality is asserted above
        const price = prices[cursor]!
        cursor += 1
        tokens += price.visualTokens + estimateContent([{ type: 'text', text: price.text }])
      }
    }
    surfaceTokens += tokens
    return { tokens, heuristicTokens: node.heuristicTokens }
  })
  return { nodes: publicNodes, surfaceTokens }
}

/** Price the adapter-visible messages while retaining their pre-projection input positions. */
export function priceProjectRequestInput(holder: Pick<Agent, 'ctx'>, input: {
  messages: readonly RequestMessage[]; tools?: readonly ToolSchema[]; toolHistory?: ToolHistory; toolUpdate?: ToolUpdate
}, images?: LlmImageRequestPricing) {
  const projected = projectToolUpdates(input.messages, input.tools, input.toolUpdate, input.toolHistory)
  const toolsTokens = estimateToolsTokens({ config: { provider: '', model: '' }, tools: [...(projected.tools ?? [])] })
  const llm = holder.ctx.get('llm')
  const priced = priceMessageTokens(projected.messages.map(analyzeMessageTokens), images, llm === undefined ? undefined : ref => llm.fileRequestText(ref))
  let cursor = 0
  const nodes = input.messages.map((message, inputIndex) => {
    const visible = projected.messages[cursor]
    if (visible !== message && !(message.role === 'developer' && visible?.role === 'developer' && message.id === visible.id)) return undefined
    const price = priced.nodes[cursor++]!
    return { inputIndex, ...price }
  }).filter((node): node is NonNullable<typeof node> => node !== undefined)
  if (cursor !== projected.messages.length) throw new Error('Project request meter lost a projected input position')
  return { inputTokens: toolsTokens + priced.surfaceTokens, toolsTokens, nodes }
}

export function prepareProjectRequestMeter(holder:Pick<Agent,'ctx'|'session'>,header:EpochHeader,pricing?:{images?:LlmImageRequestPricing}) {
 const images=pricing===undefined?holder.ctx.get('llm')?.imageRequestPricing(header.config.provider,header.config.model):pricing.images
 return (candidate:RequestDispatchCandidate)=>{
  if(!headerEquals(header,candidate.envelope))throw new Error('Project request meter route/tools changed')
  const priced=priceProjectRequestInput(holder,{messages:candidate.messages.map(item=>item.message),tools:header.tools,toolUpdate:candidate.toolUpdate,toolHistory:candidate.toolHistory},images)
  return {inputTokens:priced.inputTokens,nodes:priced.nodes.map(({tokens,heuristicTokens})=>({tokens,heuristicTokens}))}
 }
}
export function measureProjectRequestCandidate(holder:Pick<Agent,'ctx'|'session'>,candidate:RequestDispatchCandidate,pricing?:{images?:LlmImageRequestPricing}){
 return prepareProjectRequestMeter(holder,candidate.envelope,pricing)(candidate)
}
