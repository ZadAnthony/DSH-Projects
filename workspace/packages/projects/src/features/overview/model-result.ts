import { isDeepStrictEqual } from 'node:util'
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'
import { codePointLength } from '../../canonical-chunks.ts'
import { decodeNativeProjectSource } from '../../native-source.ts'
import type { OverviewSourceRef, OverviewSourceView, OverviewView } from './contract.ts'
import { sourceIdentity } from './sources.ts'

export interface OverviewModelSourceLink { readonly sourceViewId: string }
export interface OverviewModelView extends Omit<OverviewView, 'blocks'> {
  readonly blocks: readonly {
    readonly block: OverviewView['blocks'][number]['block']
    readonly sources: readonly (OverviewSourceView | OverviewModelSourceLink)[]
  }[]
  readonly sourceViews?: readonly { readonly id: string; readonly view: OverviewSourceView }[]
  readonly sourceViewsNote?: string
}

export const OVERVIEW_MODEL_SOURCE_VIEW_GUIDANCE = 'sourceViewId is local to this result and refers to sourceViews; it grants no access. Use the view\'s original reference/links.'

/** Same-result representation only; the source/UI owner and every read observation stay unchanged. */
export function projectOverviewModelResult(value: OverviewView): OverviewModelView {
  if (Object.hasOwn(value, 'sourceViews') || Object.hasOwn(value, 'sourceViewsNote')) return value
  const groups = new Map<string, { view: OverviewSourceView; positions: [number, number][] }[]>()
  for (const [blockIndex, block] of value.blocks.entries()) {
    for (const [sourceIndex, view] of block.sources.entries()) {
      if (!completeKnownView(view, value.projectId)) continue
      const key = sourceIdentity(view.reference), candidates = groups.get(key) ?? []
      let group = candidates.find(candidate => isDeepStrictEqual(candidate.view, view))
      if (group === undefined) { group = { view, positions: [] }; candidates.push(group); groups.set(key, candidates) }
      group.positions.push([blockIndex, sourceIndex])
    }
  }
  const sourceViews: { id: string; view: OverviewSourceView }[] = []
  const links = new Map<number, Map<number, string>>()
  for (const candidates of groups.values()) for (const group of candidates) {
    if (group.positions.length < 2) continue
    const id = `overview-source-${sourceViews.length + 1}`
    sourceViews.push({ id, view: group.view })
    for (const [blockIndex, sourceIndex] of group.positions) {
      const sources = links.get(blockIndex) ?? new Map<number, string>()
      sources.set(sourceIndex, id); links.set(blockIndex, sources)
    }
  }
  if (sourceViews.length === 0) return value
  const candidate: OverviewModelView = { ...value, sourceViews, sourceViewsNote: OVERVIEW_MODEL_SOURCE_VIEW_GUIDANCE, blocks: value.blocks.map((block, index) => {
    const sources = links.get(index)
    return sources === undefined ? block : { ...block, sources: block.sources.map((view, sourceIndex) => {
      const sourceViewId = sources.get(sourceIndex)
      return sourceViewId === undefined ? view : { sourceViewId }
    }) }
  }) }
  // Count the complete rendered result, including its table, links and explanation.
  const before = JSON.stringify(value), after = JSON.stringify(candidate)
  if (codePointLength(after) >= codePointLength(before) || Buffer.byteLength(after, 'utf8') >= Buffer.byteLength(before, 'utf8')) return value
  const beforeEstimate = estimateContent([{ type: 'text', text: before }]), afterEstimate = estimateContent([{ type: 'text', text: after }])
  return Number.isFinite(beforeEstimate) && Number.isFinite(afterEstimate) && afterEstimate <= beforeEstimate ? candidate : value
}

type RecordValue = Record<string, unknown>
function known(value: unknown, keys: readonly string[]): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key))
}
const strings = (value: unknown): boolean => Array.isArray(value) && value.every(item => typeof item === 'string')
function reference(value: unknown): value is OverviewSourceRef {
  if (!known(value, ['kind', 'source', 'location', 'id', 'topicId'])) return false
  if (value.kind === 'session') return known(value, ['kind', 'id']) && typeof value.id === 'string'
  if (value.kind === 'memory') return known(value, ['kind', 'topicId']) && typeof value.topicId === 'string'
  if (value.kind === 'library') {
    if (!known(value, ['kind', 'location']) || !known(value.location, ['kind', 'relativePath', 'entryId'])) return false
    return value.location.kind === 'project-file'
      ? known(value.location, ['kind', 'relativePath']) && typeof value.location.relativePath === 'string'
      : value.location.kind === 'reference' && known(value.location, ['kind', 'entryId']) && typeof value.location.entryId === 'string'
  }
  if (value.kind !== 'native' || !known(value, ['kind', 'source'])) return false
  try { return isDeepStrictEqual(decodeNativeProjectSource(value.source), value.source) } catch { return false }
}
function completeKnownView(value: OverviewSourceView, projectId: string): boolean {
  if (!known(value, ['projectId', 'reference', 'label', 'status', 'readAt', 'rows', 'message', 'limitations'])
    || value.projectId !== projectId || value.status !== 'available' || typeof value.label !== 'string'
    || typeof value.readAt !== 'string' || value.readAt.length === 0 || !reference(value.reference) || !Array.isArray(value.rows)
    || value.rows.length === 0 || value.message !== undefined && typeof value.message !== 'string'
    || value.limitations !== undefined && !strings(value.limitations)) return false
  return value.rows.every(row => known(row, ['id', 'title', 'fields', 'links', 'ownerUpdatedAt', 'limitations'])
    && typeof row.id === 'string' && typeof row.title === 'string'
    && (row.ownerUpdatedAt === undefined || typeof row.ownerUpdatedAt === 'string')
    && (row.limitations === undefined || strings(row.limitations))
    && Array.isArray(row.fields) && row.fields.every(field => known(field, ['label', 'value'])
      && typeof field.label === 'string' && typeof field.value === 'string')
    && Array.isArray(row.links) && row.links.every(link => {
      if (!known(link, ['label', 'target']) || typeof link.label !== 'string' || !known(link.target, ['kind', 'reference', 'sessionId'])) return false
      return link.target.kind === 'session'
        ? known(link.target, ['kind', 'sessionId']) && typeof link.target.sessionId === 'string'
        : link.target.kind === 'source' && known(link.target, ['kind', 'reference']) && reference(link.target.reference)
    }))
}
