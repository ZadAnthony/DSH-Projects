/** Bounded transport for existing read capabilities. No durable state or new authority. */
import { createHash, randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ObjectJsonSchema, ToolDefinition, ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'
import { hasSpillNotice } from '@deepseek-ai/dsh-spill-policy/notice'
import { canonicalJson, canonicalJsonChunks, canonicalJsonWindow, countCanonicalJsonPoints } from './communication/contract.ts'
import { codePointLength, sliceCodePoints } from './canonical-chunks.ts'
import type { CommunicationContentBudget } from './communication/content-types.ts'

export interface PreparedToolRead {
  readonly value: JsonValue
  /** 按这次真实调用重新授权，再读取原owner的同一范围。 */
  readonly reread?: (exec: ToolRunContext) => Promise<JsonValue>
}

export interface ToolReadMemoryResource {
  readonly kind: 'project-memory'
  readonly projectId: string
  readonly id: string
  readonly revision: number
  readonly generation?: string
  /** Digest of the exact stored scope; a page never claims a complete Memory body read. */
  readonly scopeDigest: string
}
export interface ToolReadPage {
  readonly format: 'projects-tool-read-page/v1'
  readonly tool: string
  readonly status: 'partial'
  readonly encoding: 'canonical-json' | 'plain-text'
  readonly text_field?: 'body' | 'text'
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly snapshot_identity: string
  readonly resource?: ToolReadMemoryResource
  readonly text: string
  readonly range: { readonly unit: 'unicode-code-points'; readonly start: number; readonly end: number; readonly total: number }
  readonly complete: boolean
  readonly page_complete: true
  readonly end_of_content: boolean
  readonly cursor_parameter?: 'result_cursor'
  readonly same_page_cursor: string
  readonly next_cursor?: string
  readonly verified_at: string
  readonly guidance: string
}
interface Snapshot {
  readonly token: string
  readonly scope: string
  readonly version: string
  readonly identity: string
  readonly total: number
  /** A continuation keeps the transport selected by its first page. */
  readonly textField?: 'body' | 'text'
  /** Only first-read observation clocks are retained; bodies are re-read from their owner. */
  readonly observations?: ObservationPatch
  readonly resource?: ToolReadMemoryResource
  /** Native retention may expose a smaller inline capacity than the fallback budget. */
  readonly retainedInlineTokens?: number
  readonly expiresAt: number
  /** 同页入口仅持有定位元数据，不捕获结果正文。 */
  readonly reread?: PreparedToolRead['reread']
}
interface ObservationPatch {
  readonly clocks: ReadonlyMap<string, unknown>
  readonly children: ReadonlyMap<string, ObservationPatch>
}
interface ToolReadBudget extends CommunicationContentBudget { readonly maxInlineCodePoints?: number }
interface Prepared { page: ToolReadPage; budget: ToolReadBudget; args: Record<string, JsonValue>; tool: string; cursorField: 'cursor' | 'result_cursor'; snapshotToken: string }
const PAGE_POINTS = 4096
const SNAPSHOTS_MAX = 8
const SNAPSHOT_TTL_MS = 15 * 60_000
export const TOOL_READ_PAGE_GUIDANCE = 'Long results use bounded canonical-JSON pages. Call this SAME tool with the SAME original arguments plus next_cursor as cursor; concatenate text in range order and JSON.parse only after end_of_content. A page is partial evidence, never a complete Memory body. On unavailable/restart_required restart without cursor; never mix snapshots. If retention changed a page, retry same_page_cursor instead of skipping forward. Cursors are temporary to this tool installation; they grant no file or write access.'
export const TOOL_READ_TEXT_PAGE_GUIDANCE = 'Long bodies use bounded plain-text pages. metadata retains the original title, scope, source and version information; text contains only the stated text_field range in Unicode code points. Call this SAME tool with the SAME original arguments plus next_cursor as cursor for more; do not JSON.parse body text. A page is partial evidence, never proof that the whole body was read. On unavailable/restart_required restart without cursor; never mix snapshots. If retention changed a page, retry same_page_cursor instead of skipping forward. Cursors are temporary to this tool installation and grant no additional access.'

/** Shared recognizer for current-read projection. It must still verify the actual tool/result origin. */
export function toolReadMemoryResource(value: unknown): ToolReadMemoryResource | undefined {
  const page = record(value), resource = record(page?.resource)
  if (page?.format !== 'projects-tool-read-page/v1' || page.tool !== 'project_memory_read' || resource?.kind !== 'project-memory'
    || typeof resource.projectId !== 'string' || typeof resource.id !== 'string' || !Number.isSafeInteger(resource.revision)
    || resource.generation !== undefined && typeof resource.generation !== 'string'
    || typeof resource.scopeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(resource.scopeDigest) || typeof page.text !== 'string') return
  return resource as unknown as ToolReadMemoryResource
}
export function toolReadDigest(value: unknown): string {
  const hash = createHash('sha256')
  for (const chunk of canonicalJsonChunks(value)) hash.update(chunk)
  return hash.digest('hex')
}

/** One bounded cache per real Agent tool installation, cleared by its existing disposer. */
export class ToolReadPager {
  private readonly snapshots = new Map<string, Snapshot>()
  private disposed = false
  private readonly prepared = new WeakMap<Readonly<ToolExecution>, Prepared>()
  constructor(private readonly agent: Agent, private readonly now: () => number = Date.now) {}
  clear(): void { this.disposed = true; this.snapshots.clear() }
  wrap(tool: ToolDefinition, options?: { readonly textField?: 'body' | 'text'; readonly cursorField?: 'cursor' | 'result_cursor'; readonly prepare?: (args: Record<string, JsonValue>, exec: ToolRunContext) => Promise<PreparedToolRead> }): ToolDefinition {
    const parameters = tool.parameters as unknown as ObjectJsonSchema
    const preferredTextField = options?.textField, cursorField = options?.cursorField ?? 'cursor'
    const guidanceFor = (textField: 'body' | 'text' | undefined) => (textField === undefined ? TOOL_READ_PAGE_GUIDANCE : TOOL_READ_TEXT_PAGE_GUIDANCE)
      .replaceAll('as cursor', `as ${cursorField}`).replaceAll('without cursor', `without ${cursorField}`)
      + (cursorField === 'result_cursor' ? ' Only search/read use result_cursor to page the complete serialized tool RESULT. Preserve the original message-list cursor and query arguments unchanged; it is independent of any source/body cursor. These result pages do not expand the message query or prove whole-body delivery.' : '')
    const fallbackGuidance = preferredTextField === undefined ? '' : ' If the metadata cannot fit alongside a body page, the complete result uses canonical-json pages instead; follow the returned encoding and guidance.'
    // The Schema keeps the complete protocol. Memory results retain executable
    // recovery/decoding rules without repeating its entire fixed description.
    // Other readers keep their existing envelopes and capacity/pressure behavior.
    const conciseMemoryProtocol = ['project_memory_read', 'project_memory_list', 'project_memory_source'].includes(tool.name)
    const pageGuidanceFor = (textField: 'body' | 'text' | undefined) => (textField === undefined
      ? 'Concatenate text by range; JSON.parse only at end_of_content. '
      : 'Append text by range as plain text; do not JSON.parse. ')
      + `Same tool and original arguments: pass next_cursor as ${cursorField}, or replay same_page_cursor after retention changes. Restart without ${cursorField} on unavailable/restart_required; never mix snapshots. Partial evidence only; cursors add no access.`
      + (cursorField === 'result_cursor' ? ' result_cursor pages the complete result; preserve original message-list and source/body cursors.' : '')
    return { ...tool, description: `${tool.description} ${guidanceFor(preferredTextField)}${fallbackGuidance}`,
      parameters: { ...parameters, properties: { ...parameters.properties,
        [cursorField]: { type: 'string', description: `Temporary same-tool ${cursorField === 'result_cursor' ? 'complete-result' : 'read'} continuation returned by this read. Preserve every original argument${cursorField === 'result_cursor' ? ', including the original message-list cursor' : ''}; omit to start a fresh current read.` } } },
      execute: async (raw, exec) => {
        const input = record(raw)
        if (input === undefined) throw new Error('Read arguments must be an object.')
        const cursor = input[cursorField]
        const args = Object.fromEntries(Object.entries(input).filter(([key]) => key !== cursorField)) as Record<string, JsonValue>
        if (cursor !== undefined && typeof cursor !== 'string') throw new Error('Read cursor must be a string.')
        exec.signal.throwIfAborted()
        if (this.disposed) return unavailable('This Bot read installation has been disposed.')
        this.expire()
        const scope = toolReadDigest({ actor: String(this.agent.id), tool: tool.name, args })
        let found: Snapshot | undefined, start = 0
        if (cursor !== undefined) {
          const match = /^([a-f0-9-]{36}):(0|[1-9][0-9]*)$/.exec(cursor)
          found = match === null ? undefined : this.snapshots.get(match[1]!)
          start = match === null ? -1 : Number(match[2])
          if (found === undefined || found.scope !== scope || !Number.isSafeInteger(start) || start < 0 || start > found.total) return unavailable('Cursor expired, belongs to another read, or is invalid.')
        }
        const prepared = found === undefined && options?.prepare !== undefined ? await options.prepare(args, exec) : undefined
        const reread = found?.reread ?? prepared?.reread
        // owner同页入口逐次重新授权；当前值工具仍执行原读取并比较版本。
        let value = prepared === undefined
          ? await (reread === undefined ? tool.execute(args, exec) : reread(exec)) : prepared.value
        exec.signal.throwIfAborted()
        if (this.disposed) return unavailable('This Bot read installation was disposed during reading.')
        const versionOf = (input: unknown) => toolReadDigest(applyObservationTimes(input, undefined, tool.name))
        let snapshot: Snapshot, textField = preferredTextField
        if (found !== undefined) {
          if (found.version !== versionOf(value)) { this.snapshots.delete(found.token); return unavailable('The current content, revision, source availability or scope changed; earlier pages remain only the old observation.') }
          snapshot = found
          textField = snapshot.textField
        } else {
          const body = textField === undefined ? undefined : record(value)?.[textField]
          // Explicit text fields only: unavailable/binary/directory results keep their existing DTO.
          if (textField !== undefined && typeof body !== 'string') return value
          const canonicalTotal = countCanonicalJsonPoints(value), budget = this.budget(exec)
          if (canonicalTotal <= PAGE_POINTS && fits([{ type: 'text', text: JSON.stringify(value) }], budget)) return value
          const text = textField === undefined ? undefined : body as string
          const total = text === undefined ? canonicalTotal : codePointLength(text)
          const observations = text === undefined ? captureObservationTimes(value, tool.name) : undefined
          // The second real owner read detects changes during preparation before any page is published.
          const version = versionOf(value), identity = textField === undefined ? toolReadDigest(value) : version
          const current = await (reread === undefined ? tool.execute(args, exec) : reread(exec))
          exec.signal.throwIfAborted()
          if (this.disposed) return unavailable('This Bot read installation was disposed during preparation.')
          if (version !== versionOf(current)) return unavailable('The content changed while preparing the read; no mixed snapshot was published.')
          value = current
          const memory = record(value)
          const resource: ToolReadMemoryResource | undefined = tool.name === 'project_memory_read' && typeof memory?.projectId === 'string'
            && typeof memory.id === 'string' && Number.isSafeInteger(memory.revision) && record(memory.scope) !== undefined
            ? { kind: 'project-memory', projectId: memory.projectId, id: memory.id, revision: memory.revision as number,
              ...(typeof memory.generation === 'string' ? { generation: memory.generation } : {}), scopeDigest: toolReadDigest(memory.scope) } : undefined
          snapshot = { token: randomUUID(), scope, version, identity, total,
            ...(reread === undefined ? {} : { reread }),
            ...(textField === undefined ? {} : { textField }),
            ...(observations === undefined ? {} : { observations }),
            ...(resource === undefined ? {} : { resource }), expiresAt: this.now() + SNAPSHOT_TTL_MS }
          while (this.snapshots.size >= SNAPSHOTS_MAX) this.snapshots.delete(this.snapshots.keys().next().value!)
          this.snapshots.set(snapshot.token, snapshot)
        }
        const budget = this.budget(exec, snapshot), verifiedAt = new Date(this.now()).toISOString()
        const preparePage = (): ToolReadPage | undefined => {
          const pageEnd = Math.min(snapshot.total, start + PAGE_POINTS)
          const window = textField === undefined ? canonicalJsonWindow(applyObservationTimes(value, snapshot.observations, tool.name), start, pageEnd).text
            : sliceCodePoints(record(value)![textField] as string, start, pageEnd)
          const page = (end: number): ToolReadPage => ({ format: 'projects-tool-read-page/v1', tool: tool.name, status: 'partial', encoding: textField === undefined ? 'canonical-json' : 'plain-text',
            ...(textField === undefined ? {} : { text_field: textField, metadata: withoutTextField(value, textField) }),
            snapshot_identity: snapshot.identity, ...(snapshot.resource === undefined ? {} : { resource: snapshot.resource }),
            text: sliceCodePoints(window, 0, end - start), range: { unit: 'unicode-code-points', start, end, total: snapshot.total },
            complete: start === 0 && end === snapshot.total, page_complete: true, end_of_content: end === snapshot.total,
            ...(cursorField === 'result_cursor' ? { cursor_parameter: cursorField } : {}),
            same_page_cursor: `${snapshot.token}:${start}`, ...(end === snapshot.total ? {} : { next_cursor: `${snapshot.token}:${end}` }),
            verified_at: verifiedAt, guidance: conciseMemoryProtocol ? pageGuidanceFor(textField) : guidanceFor(textField) })
          let low = start, high = pageEnd
          if (fits(render(page(high)), budget)) low = high
          else while (low < high) { const middle = Math.ceil((low + high) / 2); if (fits(render(page(middle)), budget)) low = middle; else high = middle - 1 }
          const result = page(low)
          return (low === start && start < snapshot.total) || !fits(render(result), budget) ? undefined : result
        }
        let result = preparePage()
        if (result === undefined && cursor === undefined && textField !== undefined) {
          // Metadata is also user data. Page the existing complete DTO rather than
          // repeating an oversized fixed envelope or making its body unreadable.
          textField = undefined
          snapshot = { ...snapshot, textField: undefined, total: countCanonicalJsonPoints(value), identity: toolReadDigest(value),
            observations: captureObservationTimes(value, tool.name) }
          this.snapshots.set(snapshot.token, snapshot)
          result = preparePage()
        }
        if (result === undefined) return unavailable('No inline capacity for a bounded page and its recovery manifest.')
        this.prepared.set(exec, { page: result, budget, args, tool: tool.name, cursorField, snapshotToken: snapshot.token })
        return result as unknown as JsonValue
      },
      finalizeContent: (exec, result) => {
        const prepared = this.prepared.get(exec); this.prepared.delete(exec)
        if (prepared === undefined) return undefined
        const exact = render(prepared.page)
        if (canonicalJson(exact) === canonicalJson(result.content)) return exact
        const notice: ContentBlock = { type: 'text', text: JSON.stringify({ tool_read_retention: {
          inline_complete: false, same_page_cursor: prepared.page.same_page_cursor,
          read: { tool: prepared.tool, arguments: { ...prepared.args, [prepared.cursorField]: prepared.page.same_page_cursor } },
          note: 'Retention changed this page; retain the actual spill and retry this same page using the read action shown. Native read/grep hints do not grant additional tools or file access. No next-page delivery is claimed.' } }) }
        const footer = retainedSpillFooter(result.content)
        let budget = prepared.budget
        if (footer !== undefined) {
          // rc.3 没有预算服务；真实 spill 的已保留结果提供已经能容纳的容量。
          // 同一快照的重读沿这个容量重新分页，不能反复返回同一份过大的页。
          const retainedInlineTokens = Math.floor(budget.estimate(result.content))
          if (!Number.isSafeInteger(retainedInlineTokens) || retainedInlineTokens < 0) throw new Error('Read retention budget is unavailable.')
          budget = { ...budget, maxInlineTokens: Math.min(budget.maxInlineTokens ?? retainedInlineTokens, retainedInlineTokens) }
          const snapshot = this.snapshots.get(prepared.snapshotToken)
          if (snapshot !== undefined) this.snapshots.set(snapshot.token, { ...snapshot, retainedInlineTokens: budget.maxInlineTokens })
        }
        const combined = [...result.content, notice]
        if (fits(combined, budget)) return combined
        const recovery = budget.recoveryContent?.()
        if (recovery !== undefined && fits([...recovery, notice], budget)) return [...recovery, notice]
        // Stock rc.3 has no budget service. Its actual post-execute result still carries
        // the native spill footer. Keep that exact footer, dropping preview head/tail if
        // they would crowd out the executable same-tool recovery. Never infer a path
        // from the original body or treat a native file hint as new authority.
        if (footer !== undefined && fits([footer, notice], budget)) return [footer, notice]
        if (footer === undefined && fits([notice], budget)) return [notice]
        return [{ type: 'text', text: JSON.stringify({ status: 'unavailable', partial: true, complete: false,
          inline_complete: false, restart_required: true,
          reason: 'No inline capacity for the actual spill locator and same-page recovery. Restart this same tool with the original arguments; no page delivery or progress is claimed.' }) }]
      },
    }
  }
  private budget(exec: ToolRunContext, snapshot?: Snapshot): ToolReadBudget {
    const budget: CommunicationContentBudget = this.agent.ctx.get?.('toolResultRetention')?.budget(exec) ?? { maxInlineTokens: 12_500, estimate: content => estimateContent(content) }
    // 原生 pruner 在工具 finalize 之后按字符裁剪；它与 token/spill 预算是两个独立的真实保留边界。
    // 读取当前服务的配置，不修改全局阈值；未安装 pruner 的宿主保持原有预算行为。
    const pruner = this.agent.ctx.get?.('toolResultPruner') as { readonly config?: { readonly thresholdChars: number } } | undefined
    const maxInlineCodePoints = pruner?.config?.thresholdChars
    const retained = snapshot?.retainedInlineTokens === undefined ? budget
      : { ...budget, maxInlineTokens: Math.min(budget.maxInlineTokens ?? snapshot.retainedInlineTokens, snapshot.retainedInlineTokens) }
    return maxInlineCodePoints === undefined ? retained : { ...retained, maxInlineCodePoints }
  }
  private expire(): void { for (const [key, snapshot] of this.snapshots) if (snapshot.expiresAt <= this.now()) this.snapshots.delete(key) }
}
function unavailable(reason: string): JsonValue { return { status: 'unavailable', partial: true, restart_required: true, complete: false, reason } }
function render(page: ToolReadPage): ContentBlock[] { return [{ type: 'text', text: JSON.stringify(page) }] }
function fits(content: readonly ContentBlock[], budget: ToolReadBudget): boolean {
  const estimate = budget.estimate(content)
  if (!Number.isFinite(estimate) || estimate < 0 || budget.maxInlineTokens !== undefined && (!Number.isSafeInteger(budget.maxInlineTokens) || budget.maxInlineTokens < 0)) throw new Error('Read retention budget is unavailable.')
  if (budget.maxInlineCodePoints !== undefined && (!Number.isSafeInteger(budget.maxInlineCodePoints) || budget.maxInlineCodePoints < 1)) throw new Error('Read retention character budget is unavailable.')
  return (budget.maxInlineTokens === undefined || estimate <= budget.maxInlineTokens)
    && (budget.maxInlineCodePoints === undefined || content.reduce((total, block) => total + (block.type === 'text' ? codePointLength(block.text) : 0), 0) <= budget.maxInlineCodePoints)
}
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
function withoutTextField(value: unknown, field: 'body' | 'text'): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record(value) ?? {}).filter(([key]) => key !== field))
}
function isObservationClock(tool: string, key: string, value: unknown, depth: number): boolean {
  // Actual owner contracts provide scalar clocks. Object-shaped source/version
  // values with the same name stay part of the content version.
  return (value === null || typeof value !== 'object') && (tool === 'project_overview_read' && ['readAt', 'loadedAt', 'observedAt'].includes(key)
    || tool === 'project_library_open' && depth === 0 && key === 'readAt')
}
function captureObservationTimes(value: unknown, tool: string, depth = 0): ObservationPatch | undefined {
  if (tool !== 'project_overview_read' && tool !== 'project_library_open') return
  if (value === null || typeof value !== 'object') return
  const clocks = new Map<string, unknown>(), children = new Map<string, ObservationPatch>()
  for (const [key, child] of Object.entries(value)) {
    if (isObservationClock(tool, key, child, depth)) clocks.set(key, child)
    else if (tool === 'project_overview_read') {
      const patch = captureObservationTimes(child, tool, depth + 1)
      if (patch !== undefined) children.set(key, patch)
    }
  }
  return clocks.size === 0 && children.size === 0 ? undefined : { clocks, children }
}
/** Strip current clocks for versioning, or restore first-read clocks on changed paths only. */
function applyObservationTimes(value: unknown, patch: ObservationPatch | undefined, tool: string, depth = 0): unknown {
  if (tool !== 'project_overview_read' && tool !== 'project_library_open' || value === null || typeof value !== 'object') return value
  let result = value as Record<string, unknown>
  const entries = Object.entries(value)
  const edit = (): Record<string, unknown> => {
    if (result === value) result = (Array.isArray(value) ? value.slice() : Object.fromEntries(entries)) as Record<string, unknown>
    return result
  }
  for (const [key, child] of entries) {
    if (isObservationClock(tool, key, child, depth)) {
      if (!patch?.clocks.has(key)) delete edit()[key]
      else if (!Object.is(child, patch.clocks.get(key))) edit()[key] = patch.clocks.get(key)
    } else if (tool === 'project_overview_read') {
      const restored = applyObservationTimes(child, patch?.children.get(key), tool, depth + 1)
      if (restored !== child) edit()[key] = restored
    }
  }
  for (const [key, clock] of patch?.clocks ?? []) if (!Object.hasOwn(value, key)) edit()[key] = clock
  return result
}

/** Only recognize a complete native footer from this execution's retained content. */
function retainedSpillFooter(content: readonly ContentBlock[]): ContentBlock | undefined {
  const last = content.at(-1)
  if (last?.type !== 'text') return
  const at = last.text.lastIndexOf('\n\n(')
  const footer = at < 0 ? last.text : last.text.slice(at + 2)
  if (footer.startsWith('(') && hasSpillNotice(footer)) return { type: 'text', text: footer }
}
