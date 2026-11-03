import { createHash } from 'node:crypto';
import { canonicalJsonChunks, codePointLength, sliceCodePoints } from './canonical-chunks.ts';
import type { Context } from "@deepseek-ai/cordis";
import type { SessionEvent } from "@deepseek-ai/dsh-session";

import {
  scanNativeProjectVisibleEvents,
  selectNativeProjectVisibleEvents,
  iterateNativeProjectVisibleEvents,
  boundNativeProjectSourceItem,
  readRetainedProjectSource,
  readRetainedProjectNativePrefix,
  readRetainedProjectNativeDirectory,
  prepareNativeProjectDirectory,
  prepareNativeProjectDirectoryRelations,
  selectNativeProjectVisibleDirectoryEvents,
  visitNativeProjectVisibleDirectoryEvents,
  type RetainedNativeDirectory,
  projectSourceUnavailableReason,
  type ProjectSessionSourceReader,
  type NativeProjectSourceItem,
  type NativeProjectVisibleEvent,
} from "./source-reader.ts";
import { decodeNativeEventSource } from './native-source.ts';
import type { NativeEventSource } from './source-reference-types.ts';
import type { ProjectSessionSource } from "./records-types.ts";
import { CommunicationTranscript } from './communication/transcript.ts'
import { CommunicationVisibleReader, communicationAttachmentVerifier, communicationVisibleText } from './communication/visible-reader.ts'
import { CommunicationContentReader } from './communication/content.ts'
import { renderCommunicationContentPage, finalizeCommunicationContentPage } from './communication/content.ts'
import type { CommunicationContentRequest, CommunicationContentBudget, CommunicationContentPage } from './communication/content.ts'
import { NativeContentReader, renderNativeContentPage, finalizeNativeContentPage } from './native-content.ts'
import type { NativeContentRequest, NativeContentPage } from './native-content-types.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
export type ProjectHistoryContentRequest = CommunicationContentRequest | NativeContentRequest
export type ProjectHistoryContentPage = CommunicationContentPage | NativeContentPage
export { renderProjectHistoryContentPage, finalizeProjectHistoryContentPage }
function renderProjectHistoryContentPage(page: ProjectHistoryContentPage): ContentBlock[] { return page.format === 'projects-native-content/v1' ? renderNativeContentPage(page) : renderCommunicationContentPage(page) }
function finalizeProjectHistoryContentPage(page: ProjectHistoryContentPage, retained: readonly ContentBlock[], budget: CommunicationContentBudget): ContentBlock[] { return page.format === 'projects-native-content/v1' ? finalizeNativeContentPage(page, retained, budget) : finalizeCommunicationContentPage(page, retained, budget) }
import { isProjectVisibleLocator } from './query-directory.ts';
import { projectRecordSemanticType } from './stock/recording/records.ts';
import type { ProjectRecordLocator } from './stock/persistence/types.ts';
import type { CommunicationSavedPartSource } from './communication/types.ts'

/** Default number of visible history entries returned by one bounded page. */
export const PROJECT_HISTORY_DEFAULT_LIMIT = 20;
/** The history reader follows DSH's bounded source-window ceiling. */
export const PROJECT_HISTORY_LIMIT_MAX = 100;
export const PROJECT_HISTORY_CONTEXT_MAX = 10;
export const PROJECT_HISTORY_EXCERPT_MAX = 256;
/** Shared by the History and Memory-source tools that expose the same saved versions. */
export const PROJECT_HISTORY_RECORD_VERSIONS = 'Search groups saved stages sharing hostSessionId and messageId into one message candidate, ordered by its last saved stage within the frozen query cut. The displayed text and source are the latest actual matching event, which may be an earlier version; messageGroup identifies that fact and provides versionsCursor. Continue search with versionsCursor to page all stages of that same message and frozen cut; matchesSearch marks each exact version satisfying the original filters. A search nextCursor continues its own messages or versions view. Entries without messageId stay separate; equal text and attemptId do not merge messages. Exact read/read_content continue to return original event versions. saved-prefix entries are cumulative output for attemptId, and settlement can repeat that output. relatedSources links adjacent saved versions or one exact tool occurrence; each link keeps its own event locator, time and content. Multiple stages do not prove multiple sends or user confirmations.';

export type * from './project-history-types.ts'
import type { ProjectHistoryStatus, ProjectHistorySpeaker, ProjectHistoryMembership, ProjectHistoryMembershipResolver, ProjectHistorySearchRequest, ProjectHistoryReadRequest, ProjectHistorySearchItem, ProjectHistoryUnavailableSource, ProjectHistorySearchResult, ProjectHistoryReadResult } from './project-history-types.ts'

interface FixedQuery {
  readonly sessionIds?: readonly string[] | undefined;
  readonly hostSessionIds?: readonly string[] | undefined;
  readonly producer?: string | undefined;
  readonly recordKinds?: readonly string[] | undefined;
  readonly timeField?: 'recorded' | undefined;
  readonly fromTime?: number | undefined;
  readonly toTime?: number | undefined;
  readonly speaker?: ProjectHistorySpeaker | undefined;
  readonly keyword?: string | undefined;
  readonly limit: number;
}

interface SourceCut extends ProjectHistoryMembership {
  readonly sourceRevision: number;
  readonly sourceKind: "available";
  readonly eventCount: number;
  readonly cursor: number;
  readonly sourceIdentity: string;
  readonly prefixHash: string;
  readonly directoryCut?: { readonly generation: string; readonly nextSeq: number; readonly byteEnd: number; readonly commitId: string };
}

interface HistoryPosition {
  readonly time: number;
  readonly hostSessionId: string;
  readonly eventIndex: number;
  readonly kind: string;
  readonly id: string;
}

interface HistoryCursor {
  readonly version: 1 | 2 | 3;
  readonly order?: 'recorded-desc-host-seq-kind-id/v1';
  readonly projectId: string;
  readonly query: FixedQuery;
  readonly cuts: readonly SourceCut[];
  readonly after?: HistoryPosition;
  readonly view?: 'messages' | 'message-versions';
  readonly message?: { readonly hostSessionId: string; readonly messageId: string };
}

interface OrderedHistoryItem {
  readonly item: ProjectHistorySearchItem;
  readonly position: HistoryPosition;
  readonly group?: {
    readonly messageId: string;
    readonly versionCount: number;
    readonly latestSource: NativeEventSource;
    readonly latestRecordPhase?: string;
    readonly representativeIsLatest: boolean;
  };
}

interface SourceRead {
  readonly items: readonly OrderedHistoryItem[];
  readonly cuts: readonly SourceCut[];
  readonly readableSources: number;
  readonly limitations: readonly string[];
  readonly brokenHosts: ReadonlySet<string>;
  readonly unavailableSources: readonly ProjectHistoryUnavailableSource[];
  readonly anchors: ReadonlySet<string>;
}

/**
 * Reads only currently authorized Projects directories and exact saved records.
 * It owns no index, cache, persistence handle, Agent lifecycle, or write path.
 */
export class ProjectHistoryReader {
  constructor(
    private readonly ctx: Context,
    private readonly resolveMembership: ProjectHistoryMembershipResolver,
    private readonly readSessionSource: ProjectSessionSourceReader,
    private readonly assertSourceAdmitting: (hostSessionId: string) => void = () => {},
    /** 逐次读取本项目的有效来源；旧reader适配器可省略。 */
    private readonly readSessionSources?: (projectId?: string) => Promise<readonly ProjectSessionSource[]>,
  ) {}

  async search(
    projectId: string,
    request: ProjectHistorySearchRequest,
    signal?: AbortSignal,
    captureSamePage?: (read: (signal?: AbortSignal) => Promise<ProjectHistorySearchResult>) => void,
  ): Promise<ProjectHistorySearchResult> {
    signal?.throwIfAborted();
    const cursor = request.cursor === undefined ? undefined : decodeCursor(request.cursor);
    if (request.cursor !== undefined && cursor === undefined) {
      return unavailableSearch("history cursor is invalid");
    }
    if (cursor !== undefined && cursor.projectId !== projectId) {
      return unavailableSearch("history cursor belongs to a different project");
    }
    const normalized = cursor === undefined
      ? normalizeInitialQuery(request)
      : queryFromCursorRequest(request, cursor.query);
    if (typeof normalized === "string") return unavailableSearch(normalized);

    const membership = await this.memberships(projectId, signal);
    if (membership === undefined) return unavailableSearch("project membership is unavailable");
    signal?.throwIfAborted();

    if (cursor === undefined) {
      const selected = selectMembers(membership, normalized.sessionIds, normalized.hostSessionIds);
      const sourceRead = await this.captureInitial(projectId, selected.members, normalized, signal);
      captureSamePage?.(this.samePageReader(projectId, normalized, sourceRead, undefined, selected.limitations, false, { version: 3, view: 'messages' }));
      return pageSearch(projectId, normalized, sourceRead, undefined, selected.limitations, false, signal, { version: 3, view: 'messages' });
    }

    const continuation = await this.captureContinuation(projectId, cursor, membership, normalized, signal);
    if (continuation.invalid !== undefined) return unavailableSearch(continuation.invalid);
    captureSamePage?.(this.samePageReader(projectId, normalized, continuation.sourceRead, cursor.after, continuation.limitations, true, cursor));
    return pageSearch(projectId, normalized, continuation.sourceRead, cursor.after, continuation.limitations, true, signal, cursor);
  }


  /** 内部同页读取保留原cut，不改公开的下一页游标。 */
  private samePageReader(projectId: string, query: FixedQuery, first: SourceRead, after: HistoryPosition | undefined,
    additionalLimitations: readonly string[], wasContinuation: boolean,
    shape: Pick<HistoryCursor, 'version' | 'view' | 'message'>): (signal?: AbortSignal) => Promise<ProjectHistorySearchResult> {
    // 闭包仅保留定位与首次缺项事实，不持有查询结果、原生事件或正文。
    const cursor: HistoryCursor = { ...shape, projectId, query, cuts: first.cuts,
      ...(shape.version === 1 ? {} : { order: 'recorded-desc-host-seq-kind-id/v1' }),
      ...(after === undefined ? {} : { after }) };
    const frozenLimitations = [...additionalLimitations, ...first.limitations];
    const frozenUnavailable = [...first.unavailableSources];
    return async signal => {
      signal?.throwIfAborted();
      const membership = await this.memberships(projectId, signal);
      if (membership === undefined) return unavailableSearch('project membership is unavailable');
      const continued = await this.captureContinuation(projectId, cursor, membership, query, signal);
      if (continued.invalid !== undefined) return unavailableSearch(continued.invalid);
      // 首次缺项不进入已冻结的候选页；新失败覆盖该来源原来的缺项状态。
      const unavailableSources = [...new Map([...frozenUnavailable, ...continued.sourceRead.unavailableSources]
        .map(item => [item.hostSessionId, item])).values()];
      return pageSearch(projectId, query, { ...continued.sourceRead, unavailableSources }, after,
        [...frozenLimitations, ...continued.limitations], wasContinuation, signal, shape);
    };
  }

  async read(
    projectId: string,
    request: ProjectHistoryReadRequest,
    signal?: AbortSignal,
  ): Promise<ProjectHistoryReadResult> {
    if (request.source.kind === 'communication-part') {
      if ((request.before ?? 0) !== 0 || (request.after ?? 0) !== 0) return {status:'unavailable',found:false,items:[],limitations:['A saved communication part has no native adjacent-message window.'],code:'invalid-source'};
      return this.readSavedPart(projectId, request.source, signal);
    }
    const before = boundedWindow(request.before, "before");
    const after = boundedWindow(request.after, "after");
    if (typeof before === "string" || typeof after === "string") {
      return { status: "unavailable", found: false, items: [], limitations: [before, after].filter((value): value is string => typeof value === "string") };
    }
    const membership = await this.memberships(projectId, signal);
    if (membership === undefined) {
      return { status: "unavailable", found: false, items: [], limitations: ["project membership is unavailable"] };
    }
    const nativeSource = request.source;
    if (!membership.some(member => member.hostSessionId === nativeSource.hostSessionId)) {
      return {
        status: "unavailable",
        found: false,
        items: [],
        limitations: ["source is outside the current project membership"],
      };
    }
    try {
      signal?.throwIfAborted();
      const read = await readRetainedProjectSource(this.ctx, projectId, request.source, this.readSessionSource, { before, after, signal, assertAdmitting: this.assertSourceAdmitting });
      signal?.throwIfAborted();
      if (!read.resolved) {
        const unavailable = read.code !== "not-found" || read.reason === "session not found" || read.reason?.includes("来源会话") === true;
        return {
          status: unavailable ? "unavailable" : "ok",
          found: false,
          items: [],
          limitations: read.reason === undefined ? [] : [read.reason],
          ...(read.reason === undefined ? {} : { reason: read.reason }),
          ...(read.code === undefined ? {} : { code: read.code }),
        };
      }
      const expanded = await this.adjacentCarriers(projectId, membership, nativeSource.hostSessionId, read.items, before, after, signal);
      return { status: read.partial === true || expanded.limitations.length > 0 ? 'partial' : 'ok', found: true, items: expanded.items,
        limitations: [...(read.limitations ?? []), ...expanded.limitations], coverage: expanded.coverage };

    } catch (error: unknown) {
      signal?.throwIfAborted();
      return {
        status: "unavailable",
        found: false,
        items: [],
        limitations: ["source session is unavailable"],
      };
    }
  }

  private async adjacentCarriers(projectId: string, membership: readonly ProjectHistoryMembership[], hostSessionId: string,
    initial: readonly NativeProjectSourceItem[], before: number, after: number, signal?: AbortSignal) {
    const current = membership.find(item => item.hostSessionId === hostSessionId)!;
    const items = [...initial], limitations: string[] = [];
    const coverage: Array<{sessionId:string;hostSessionId:string;firstSeq?:number;lastSeq?:number}> = [coverageFor(current, initial)];
    const sequence = current.carrierSequence ?? current.carrierIndex;
    if (sequence === undefined) return {items,limitations,coverage};
    for (const direction of [-1,1]) {
      let needed = (direction < 0 ? before : after) - initial.filter(item => !item.isTarget && (direction < 0 ? item.seq < initial.find(item=>item.isTarget)!.seq : item.seq > initial.findLast(item=>item.isTarget)!.seq)).length;
      let next = sequence + direction;
      while (needed > 0) {
        const member = membership.find(item => item.id === current.id && (item.carrierSequence ?? item.carrierIndex) === next);
        if (member === undefined) break;
        const directory = await readRetainedProjectNativeDirectory(this.ctx, projectId, member.hostSessionId, this.readSessionSource, {signal,assertAdmitting:this.assertSourceAdmitting});
        if (!directory.readable) { limitations.push(`adjacent carrier ${member.hostSessionId}: ${directory.reason}`); break; }
        const preparation = prepareNativeProjectDirectory(directory, signal);
        const candidates = preparation.records.filter(isProjectVisibleLocator);
        if (direction < 0) candidates.reverse();
        const selected: NativeProjectSourceItem[] = [];
        for (const candidate of candidates) {
          const entries = await selectNativeProjectVisibleDirectoryEvents(directory, new Set([candidate.seq]), signal, preparation);
          const values = entries.map(entry => boundNativeProjectSourceItem(entry.item));
          if (direction < 0) selected.unshift(...values.slice(-Math.max(0, needed - selected.length)));
          else selected.push(...values.slice(0, Math.max(0, needed - selected.length)));
          if (selected.length >= needed) break;
        }
        if (direction < 0) {items.unshift(...selected);coverage.unshift(coverageFor(member,selected));}
        else {items.push(...selected);coverage.push(coverageFor(member,selected));}
        needed -= selected.length; next += direction;
      }
    }
    return {items,limitations,coverage};
  }

  /** Read one saved immutable content stream independently of message-list pagination. */
  async readContent(projectId: string, request: ProjectHistoryContentRequest, budget: CommunicationContentBudget, signal?: AbortSignal) {
    if ('source' in request) return new NativeContentReader((project, source, signal) => readRetainedProjectSource(this.ctx, project, source, this.readSessionSource, { before: 0, after: 0, signal, fullBody: true, assertAdmitting: this.assertSourceAdmitting }), communicationAttachmentVerifier(this.ctx)).readContent(projectId, request, budget, signal)
    const transcript = this.communicationTranscript()
    return new CommunicationContentReader({ readSnapshot: (project, record, readSignal) => transcript.readSnapshot(project, record, readSignal),
      verifyAttachment: communicationAttachmentVerifier(this.ctx) }).readContent(projectId, request, budget, signal)
  }

  private communicationTranscript() {
    return new CommunicationTranscript(this.ctx, (project, host, signal) => readRetainedProjectNativeDirectory(this.ctx, project, host, this.readSessionSource, { signal, assertAdmitting: this.assertSourceAdmitting }))
  }

  private async readSavedPart(projectId: string, source: CommunicationSavedPartSource, signal?: AbortSignal): Promise<ProjectHistoryReadResult> {
    const transcript = this.communicationTranscript()
    const read = await new CommunicationVisibleReader({
      readDirectory: (project, host, readSignal) => readRetainedProjectNativeDirectory(this.ctx, project, host, this.readSessionSource, { signal: readSignal, assertAdmitting: this.assertSourceAdmitting }),
      readSnapshot: (project, record, readSignal) => transcript.readSnapshot(project, record, readSignal),
      verifyAttachment: communicationAttachmentVerifier(this.ctx),
    }).readSelected(projectId, source, { group: 'context', index: 0 }, signal)
    if (!read.visibleComplete) return { status: 'unavailable', found: false, items: [], limitations: read.missingVisible.map(item => item.code) }
    return { status: 'ok', found: true, limitations: [], items: read.parts.map(part => ({ isTarget: true, seq: part.originEventSeq, time: part.originTime,
      kind: 'communication-part', role: part.originalSpeaker === 'assistant' ? 'assistant' : part.originalSpeaker === 'tool' ? 'tool' : part.originalSpeaker === 'system' ? 'system' : 'user',
      text: communicationVisibleText(part.blocks), speaker: part.originalSpeaker, sourceKind: part.producer.kind, source: part.producer,
      nativeSource: part.origin, visibleBlocks: part.blocks, visibleComplete: true, savedPartSource: source })) }
  }

  private async memberships(projectId: string, signal?: AbortSignal): Promise<readonly ProjectHistoryMembership[] | undefined> {
    try {
      signal?.throwIfAborted();
      const memberships = await this.resolveMembership(projectId);
      signal?.throwIfAborted();
      return memberships.filter(validMembership).filter(member => member.role === "main" || member.role === "execution");
    } catch (error: unknown) {
      signal?.throwIfAborted();
      return undefined;
    }
  }

  private async captureInitial(
    projectId: string,
    memberships: readonly ProjectHistoryMembership[],
    query: FixedQuery,
    signal?: AbortSignal,
  ): Promise<SourceRead> {
    const sourceRead = emptySourceRead();
    for (const membership of memberships) {
      signal?.throwIfAborted();
      try {
        const source = await this.availableSource(projectId, membership, sourceRead);
        if (source === undefined) continue;
        const directory = await readRetainedProjectNativeDirectory(this.ctx, projectId, membership.hostSessionId, this.readSessionSource, { signal, assertAdmitting: this.assertSourceAdmitting });
        if (!directory.readable) throw new Error(directory.reason);
        sourceRead.cuts.push(await directorySourceCut(membership, source.revision, directory));
        sourceRead.readableSources += 1;
        await appendGroupedDirectoryItems(sourceRead.items, membership, directory, query, undefined, signal);
      } catch (error: unknown) {
        signal?.throwIfAborted();
        // The native read can observe a deletion which started after the first
        // availability check. Recheck only its existing source identity, not its body.
        try { await this.availableSource(projectId, membership, sourceRead); }
        catch { signal?.throwIfAborted(); }
        sourceRead.limitations.push(`session "${membership.title}" is unavailable`);
        sourceRead.brokenHosts.add(membership.hostSessionId);
      }
    }
    return this.revalidateRead(projectId, sourceRead, signal);
  }

  private async captureContinuation(
    projectId: string,
    cursor: HistoryCursor,
    membership: readonly ProjectHistoryMembership[],
    query: FixedQuery,
    signal?: AbortSignal,
  ): Promise<{ readonly sourceRead: SourceRead; readonly limitations: readonly string[]; readonly invalid?: string }> {
    const current = new Map(membership.map(item => [`${item.id}\u0000${item.hostSessionId}`, item]));
    const sourceRead = emptySourceRead();
    for (const cut of cursor.cuts) {
      signal?.throwIfAborted();
      const member = current.get(`${cut.id}\u0000${cut.hostSessionId}`);
      if (await this.availableSource(projectId, cut, sourceRead, cut.sourceRevision) === undefined) continue;
      if (member === undefined) {
        sourceRead.limitations.push(`session "${cut.title}" is no longer in this project`);
        sourceRead.brokenHosts.add(cut.hostSessionId);
        continue;
      }
      try {
        if (cursor.version === 2 || cursor.version === 3) {
          const directory = await readRetainedProjectNativeDirectory(this.ctx, projectId, cut.hostSessionId, this.readSessionSource, { signal, assertAdmitting: this.assertSourceAdmitting });
          if (!directory.readable) throw new Error(directory.reason);
          if (!await sameDirectorySource(cut, directory)) {
            sourceRead.limitations.push(`session "${cut.title}" changed since the first history page`); sourceRead.brokenHosts.add(cut.hostSessionId); continue;
          }
          sourceRead.cuts.push(cut); sourceRead.readableSources += 1;
          // This is a query scope inside the newly authorized cut, never a newly issued persistence receipt.
          const scope = { ...directory, endSeq: cut.eventCount - 1,
            directory: { ...directory.directory, records: directory.directory.records.filter(record => record.seq < cut.eventCount) },
            cut: { ...directory.cut, nextSeq: cut.eventCount } };
          const anchor = cursor.version === 3
            ? await appendGroupedDirectoryItems(sourceRead.items, member, scope, query, cursor.after, signal, cursor.message)
            : await appendDirectoryItems(sourceRead.items, member, scope, query, cursor.after, signal);
          if (anchor) sourceRead.anchors.add(cut.hostSessionId);
          continue;
        }
        // v1 compatibility keeps the original whole-prefix SHA, sort and anchor semantics.
        const prefix = await readRetainedProjectNativePrefix(this.ctx, projectId, cut.hostSessionId, this.readSessionSource, { signal, assertAdmitting: this.assertSourceAdmitting });
        if (!prefix.readable) throw new Error(prefix.reason);
        const header = { id: prefix.hostSessionId, createdAt: prefix.sessionCreatedAt, version: prefix.formatVersion };
        if (!await sameSource(cut, header, prefix.inheritedEventCount, prefix.events, prefix.endSeq)) {
          sourceRead.limitations.push(`session "${cut.title}" changed since the first history page`);
          sourceRead.brokenHosts.add(cut.hostSessionId);
          continue;
        }
        sourceRead.cuts.push(cut);
        sourceRead.readableSources += 1;
        if (appendProjectedItems(sourceRead.items, projectId, member, prefix.events.slice(0, cut.eventCount), query, signal, prefix.sessionCreatedAt, prefix.formatVersion, cursor.after)) sourceRead.anchors.add(cut.hostSessionId);
      } catch (error: unknown) {
        signal?.throwIfAborted();
        // A failed prefix has no successful cut for revalidateRead to inspect.
        // Retain the same source owner's newly unavailable identity and revision.
        try { await this.availableSource(projectId, cut, sourceRead, cut.sourceRevision); }
        catch { signal?.throwIfAborted(); }
        sourceRead.limitations.push(`session "${cut.title}" is unavailable`);
        sourceRead.brokenHosts.add(cut.hostSessionId);
      }
    }
    const frozen = await this.revalidateRead(projectId, sourceRead, signal);
    if (cursor.after !== undefined && !frozen.anchors.has(cursor.after.hostSessionId) && !frozen.brokenHosts.has(cursor.after.hostSessionId)) {
      return { sourceRead: frozen, limitations: frozen.limitations, invalid: "history cursor continuation is no longer present" };
    }
    return { sourceRead: frozen, limitations: frozen.limitations };
  }

  private async availableSource(
    projectId: string,
    membership: ProjectHistoryMembership,
    read: ReturnType<typeof emptySourceRead>,
    _revision?: number,
  ): Promise<ProjectSessionSource | undefined> {
    const source = await this.readSessionSource(membership.hostSessionId, projectId);
    return this.availableSourceFromRead(projectId, membership, read, source);
  }

  private availableSourceFromRead(
    projectId: string,
    membership: ProjectHistoryMembership,
    read: ReturnType<typeof emptySourceRead>,
    source: ProjectSessionSource | undefined,
  ): ProjectSessionSource | undefined {
    let reason: string | undefined;
    if (source === undefined || source.projectId !== projectId || source.id !== membership.id) {
      reason = `session "${membership.title}" is no longer in this project`;
    } else if (source.role !== "main" && source.role !== "execution") {
      reason = `session "${membership.title}" is not a project work session`;
    } else if (source.sourceLifecycle.kind !== "available") {
      reason = projectSourceUnavailableReason(source.sourceLifecycle.kind);
      if (!read.unavailableSources.some(item => item.hostSessionId === source.hostSessionId)) {
        read.unavailableSources.push({ hostSessionId: source.hostSessionId,
          kind: source.sourceLifecycle.kind, sourceRevision: source.revision });
      }
    }
    if (reason === undefined) {
      this.assertSourceAdmitting(membership.hostSessionId);
      return source;
    }
    read.limitations.push(reason);
    read.brokenHosts.add(membership.hostSessionId);
    return undefined;
  }

  private async revalidateRead(
    projectId: string,
    read: ReturnType<typeof emptySourceRead>,
    signal?: AbortSignal,
  ): Promise<SourceRead> {
    signal?.throwIfAborted();
    let valid: boolean[];
    if (read.cuts.length > 0 && this.readSessionSources !== undefined) {
      const sources = await this.readSessionSources(projectId);
      signal?.throwIfAborted();
      const byHost = new Map<string, ProjectSessionSource>();
      for (const source of sources) {
        if (!byHost.has(source.hostSessionId)) byHost.set(source.hostSessionId, source);
      }
      valid = read.cuts.map(cut =>
        this.availableSourceFromRead(projectId, cut, read, byHost.get(cut.hostSessionId)) !== undefined);
    } else {
      valid = await Promise.all(read.cuts.map(async cut =>
        await this.availableSource(projectId, cut, read, cut.sourceRevision) !== undefined));
    }
    signal?.throwIfAborted();
    const cuts = read.cuts.filter((_, index) => valid[index]);
    const allowed = new Set(cuts.map(cut => cut.hostSessionId));
    return { ...freezeSourceRead(read), cuts, readableSources: cuts.length,
      items: read.items.filter(item => allowed.has(item.position.hostSessionId)) };
  }
}

function pageSearch(
  projectId: string,
  query: FixedQuery,
  sourceRead: SourceRead,
  after: HistoryPosition | undefined,
  additionalLimitations: readonly string[],
  continuation: boolean,
  signal?: AbortSignal,
  cursorState?: Pick<HistoryCursor, 'version' | 'view' | 'message'>,
): ProjectHistorySearchResult {
  signal?.throwIfAborted();
  const limitations = unique([...additionalLimitations, ...sourceRead.limitations]);
  const ordered = sourceRead.items
    .filter(item => after === undefined || comparePosition(item.position, after) > 0)
    .sort((left, right) => comparePosition(left.position, right.position));
  signal?.throwIfAborted();
  const items = ordered.slice(0, query.limit);
  const next = ordered.length > items.length ? items.at(-1) : undefined;
  const cuts = sourceRead.cuts;
  const renderedItems = items.map(entry => {
    const item = entry.item.excerpt === undefined ? searchExcerpt(entry.item, query) : entry.item;
    if (entry.group === undefined) return item;
    return { ...item, messageGroup: { ...entry.group, hostSessionId: entry.position.hostSessionId, latestRecordedTime: entry.position.time,
      versionsCursor: encodeCursor({ version: 3, order: 'recorded-desc-host-seq-kind-id/v1', view: 'message-versions',
        message: { hostSessionId: entry.position.hostSessionId, messageId: entry.group.messageId }, projectId, query,
        cuts: cuts.filter(cut => cut.hostSessionId === entry.position.hostSessionId) }) } };
  });
  const itemLimitations = renderedItems.flatMap(item => item.limitations ?? []);
  const allLimitations = unique([...limitations, ...itemLimitations]);
  const partial = allLimitations.length > 0 || renderedItems.some(item => item.partial === true);
  const status: ProjectHistoryStatus = sourceRead.readableSources === 0 && sourceRead.unavailableSources.length > 0
    ? "unavailable"
    : continuation && allLimitations.length > 0 ? "partial"
    : sourceRead.readableSources === 0 && allLimitations.length > 0
      ? "unavailable"
      : partial ? "partial" : "ok";
  return {
    status,
    items: renderedItems,
    timeField: "recorded", matching: "literal-case-insensitive",
    view: cursorState?.version === 3 ? cursorState.view : 'events',
    ...(items.length === 0 && status === "ok" ? {code:"no-match"} : {}),
    ...(sourceRead.unavailableSources.length === 0 ? {} : { unavailableSources: sourceRead.unavailableSources }),
    limitations: allLimitations,
    ...(next === undefined || cuts.length === 0 ? {} : {
      nextCursor: encodeCursor({ version: cuts.every(cut => cut.directoryCut !== undefined) ? 2 : 1, ...(cuts.every(cut => cut.directoryCut !== undefined) ? { order: 'recorded-desc-host-seq-kind-id/v1' as const } : {}),
        ...cursorState, projectId, query, cuts, after: next.position }),
    }),
  };
}

function unavailableSearch(limitation: string): ProjectHistorySearchResult {
  return { status: "unavailable", items: [], limitations: [limitation] };
}

function normalizeInitialQuery(request: ProjectHistorySearchRequest): FixedQuery | string {
  const basic = validateQueryFields(request);
  if (typeof basic === "string") return basic;
  return {
    ...basic,
    limit: request.limit ?? PROJECT_HISTORY_DEFAULT_LIMIT,
    timeField: "recorded",
  };
}

function queryFromCursorRequest(request: ProjectHistorySearchRequest, query: FixedQuery): FixedQuery | string {
  const basic = validateQueryFields(request, true);
  if (typeof basic === "string") return basic;
  if (request.sessionIds !== undefined && !sameStrings(basic.sessionIds ?? [], query.sessionIds ?? [])) return "history cursor session filter does not match";
  if (request.fromTime !== undefined && basic.fromTime !== query.fromTime) return "history cursor time filter does not match";
  if (request.toTime !== undefined && basic.toTime !== query.toTime) return "history cursor time filter does not match";
  if (request.speaker !== undefined && basic.speaker !== query.speaker) return "history cursor speaker filter does not match";
  if (request.keyword !== undefined && basic.keyword !== query.keyword) return "history cursor keyword filter does not match";
  if (request.hostSessionIds !== undefined && !sameStrings(basic.hostSessionIds ?? [], query.hostSessionIds ?? [])) return "history cursor host filter does not match";
  if (request.producer !== undefined && request.producer !== query.producer) return "history cursor producer filter does not match";
  if (request.recordKinds !== undefined && !sameStrings(basic.recordKinds ?? [], query.recordKinds ?? [])) return "history cursor kind filter does not match";
  if (request.timeField !== undefined && request.timeField !== query.timeField) return "history cursor time field does not match";
  if (request.limit !== undefined && request.limit !== query.limit) return "history cursor page size does not match";
  return query;
}

function validateQueryFields(request: ProjectHistorySearchRequest, allowMissingLimit = false): Omit<FixedQuery, "limit"> | string {
  const sessionIds = request.sessionIds === undefined ? undefined : uniqueStrings(request.sessionIds);
  if (sessionIds === undefined && request.sessionIds !== undefined) return "history session filter is invalid";
  const hostSessionIds = request.hostSessionIds === undefined ? undefined : uniqueStrings(request.hostSessionIds);
  const recordKinds = request.recordKinds === undefined ? undefined : uniqueStrings(request.recordKinds);
  if (request.hostSessionIds !== undefined && hostSessionIds === undefined || request.recordKinds !== undefined && recordKinds === undefined) return "history host/kind filter is invalid";
  if (request.producer !== undefined && (typeof request.producer !== 'string' || request.producer.length === 0)) return "history producer filter is invalid";
  if (request.timeField !== undefined && request.timeField !== 'recorded') return "history time field must be recorded";
  if (!validEpoch(request.fromTime) || !validEpoch(request.toTime)) return "history time filter is invalid";
  if (request.fromTime !== undefined && request.toTime !== undefined && request.fromTime > request.toTime) {
    return "history time range is empty";
  }
  if (request.speaker !== undefined && !isSpeaker(request.speaker)) return "history speaker filter is invalid";
  if (request.keyword !== undefined && typeof request.keyword !== "string") return "history keyword filter is invalid";
  if (request.limit !== undefined && !validLimit(request.limit)) return `history limit must be an integer between 1 and ${PROJECT_HISTORY_LIMIT_MAX}`;
  if (!allowMissingLimit && request.limit === undefined) return { sessionIds, hostSessionIds, recordKinds, producer: request.producer, timeField: "recorded", fromTime: request.fromTime, toTime: request.toTime, speaker: request.speaker, keyword: request.keyword };
  return { sessionIds, hostSessionIds, recordKinds, producer: request.producer, timeField: "recorded", fromTime: request.fromTime, toTime: request.toTime, speaker: request.speaker, keyword: request.keyword };
}

function validEpoch(value: number | undefined): boolean {
  return value === undefined || Number.isSafeInteger(value);
}

function validLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= PROJECT_HISTORY_LIMIT_MAX;
}

function isSpeaker(value: string): value is ProjectHistorySpeaker {
  return value === "user" || value === "assistant" || value === "project-delivery" || value === "system" || value === "tool" || value === "unknown";
}

function uniqueStrings(values: readonly string[]): readonly string[] | undefined {
  if (!values.every(value => typeof value === "string" && value.length > 0)) return undefined;
  return [...new Set(values)].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function selectMembers(memberships: readonly ProjectHistoryMembership[], sessionIds: readonly string[] | undefined,
  hostSessionIds: readonly string[] | undefined): { readonly members: readonly ProjectHistoryMembership[]; readonly limitations: readonly string[] } {
  const members = memberships.filter(member => (sessionIds === undefined || sessionIds.includes(member.id)) && (hostSessionIds === undefined || hostSessionIds.includes(member.hostSessionId)));
  const limitations = [...(sessionIds ?? []).filter(id => !memberships.some(member => member.id === id)).map(id => `project session "${id}" is unavailable`),
    ...(hostSessionIds ?? []).filter(host => !memberships.some(member => member.hostSessionId === host)).map(host => `host session "${host}" is unavailable`)];
  const seen = new Set<string>();
  return { members: members.filter(member => { const key = `${member.id}\u0000${member.hostSessionId}`; if (seen.has(key)) { limitations.push('duplicate carrier membership'); return false; } seen.add(key); return true; }), limitations };
}

function validMembership(value: unknown): value is ProjectHistoryMembership {
  const membership = object(value);
  return typeof membership?.id === "string" && membership.id.length > 0
    && typeof membership.hostSessionId === "string" && membership.hostSessionId.length > 0
    && typeof membership.role === "string"
    && typeof membership.title === "string";
}

function appendProjectedItems(
  destination: OrderedHistoryItem[], projectId: string, membership: ProjectHistoryMembership, events: readonly SessionEvent[], query: FixedQuery,
  signal?: AbortSignal, sessionCreatedAt?: number, formatVersion = 4, after?: HistoryPosition,
): boolean {
  const candidates: Array<OrderedHistoryItem & { render: () => ProjectHistorySearchItem }> = [];
  let anchorPresent = false;
  const entries = query.keyword === undefined ? scanNativeProjectVisibleEvents(membership.hostSessionId, events, signal) : iterateNativeProjectVisibleEvents(membership.hostSessionId, events, signal);
  for (const entry of entries) {
    signal?.throwIfAborted();
    const item = entry.item;
    if (!matchesQuery(item, query)) continue;
    const position: HistoryPosition = { time: item.time, hostSessionId: membership.hostSessionId, eventIndex: entry.eventIndex, kind: item.kind,
      id: `${item.seq}:${item.messageId ?? item.toolCallId ?? ''}` };
    if (after !== undefined) {
      const comparison = comparePosition(position, after);
      if (comparison === 0) anchorPresent = true;
      if (comparison <= 0) continue;
    }
    const index = candidates.findIndex(candidate => comparePosition(position, candidate.position) < 0);
    const insertion = index < 0 ? candidates.length : index;
    if (insertion >= query.limit + 1) continue;
    // Retain only locators and bounded excerpts. Full bodies die before the next record.
    const bounded = query.keyword === undefined ? { ...item, session: membership } : searchExcerpt({ ...item, session: membership }, query);
    const eventIndex = entry.eventIndex, kind = item.kind, messageId = item.messageId, toolCallId = item.toolCallId;
    candidates.splice(insertion, 0, { item: bounded, position, render: () => {
      const exact = selectNativeProjectVisibleEvents(membership.hostSessionId, events, candidate => candidate.eventIndex === eventIndex && candidate.item.kind === kind
        && candidate.item.messageId === messageId && candidate.item.toolCallId === toolCallId, signal, sessionCreatedAt, { projectId, sessionId: membership.id, formatVersion });
      if (exact.length !== 1) throw new Error('The selected history locator no longer resolves uniquely.');
      return searchExcerpt({ ...exact[0]!.item, session: membership }, query);
    } });
    if (candidates.length > query.limit + 1) candidates.pop();
  }
  // Finish this source while its durable graph is in scope. Only bounded DTOs
  // cross the source boundary; never retain events through a deferred closure.
  for (const candidate of candidates) destination.push({ position: candidate.position, item: candidate.render() });
  return anchorPresent;
}

function matchesQuery(item: NativeProjectSourceItem, query: FixedQuery): boolean {
  if (query.fromTime !== undefined && item.time < query.fromTime) return false;
  if (query.toTime !== undefined && item.time > query.toTime) return false;
  if (query.speaker !== undefined && item.speaker !== query.speaker) return false;
  if (query.producer !== undefined && item.sourceKind !== query.producer) return false;
  if (query.recordKinds !== undefined && !query.recordKinds.includes(item.kind)) return false;
  return query.keyword === undefined || item.text.toLowerCase().includes(query.keyword.toLowerCase());
}

async function directorySourceCut(membership: ProjectHistoryMembership, sourceRevision: number,
  directory: Extract<RetainedNativeDirectory, { readable: true }>): Promise<SourceCut> {
  return { ...membership, sourceRevision, sourceKind: 'available', eventCount: directory.cut.nextSeq, cursor: directory.endSeq,
    sourceIdentity: await digest({ id: directory.hostSessionId, createdAt: directory.sessionCreatedAt, version: directory.formatVersion }),
    prefixHash: '', directoryCut: { generation: directory.cut.journalIdentity, nextSeq: directory.cut.nextSeq, byteEnd: directory.cut.byteEnd, commitId: directory.cut.commitId } };
}
async function sameDirectorySource(cut: SourceCut, directory: Extract<RetainedNativeDirectory, { readable: true }>): Promise<boolean> {
  const scope = cut.directoryCut;
  if (scope === undefined || cut.sourceRevision !== directory.sourceRevision || scope.nextSeq !== cut.eventCount
    || scope.generation !== directory.cut.journalIdentity || directory.cut.nextSeq < scope.nextSeq
    || scope.commitId !== `${scope.generation}:${scope.nextSeq}:${scope.byteEnd}`) return false;
  const byteEnd = scope.nextSeq === 0 ? directory.directory.records[0]?.byteStart ?? directory.cut.byteEnd : directory.directory.records[scope.nextSeq - 1]?.byteEnd;
  return byteEnd === scope.byteEnd && cut.sourceIdentity === await digest({ id: directory.hostSessionId, createdAt: directory.sessionCreatedAt, version: directory.formatVersion });
}
function validDirectoryCut(value: unknown): boolean {
  const cut = object(value);
  return cut !== undefined && typeof cut.generation === 'string' && cut.generation.length > 0 && Number.isSafeInteger(cut.nextSeq) && (cut.nextSeq as number) >= 0
    && Number.isSafeInteger(cut.byteEnd) && (cut.byteEnd as number) >= 0 && typeof cut.commitId === 'string';
}

/** Read candidate bodies in recorded order and retain only a bounded page. */
async function appendDirectoryItems(destination: OrderedHistoryItem[], membership: ProjectHistoryMembership,
  directory: Extract<RetainedNativeDirectory, { readable: true }>, query: FixedQuery, after?: HistoryPosition, signal?: AbortSignal): Promise<boolean> {
  const selected: OrderedHistoryItem[] = [];
  const anchorPresent = await directory.withOperation(() => appendDirectoryItemsWithinOperation(selected, membership, directory, query, after, signal));
  // The final source check owns publication too: a failed scope must not leave
  // already-projected items in the caller's otherwise successful sources.
  signal?.throwIfAborted();
  destination.push(...selected);
  return anchorPresent;
}
async function appendDirectoryItemsWithinOperation(destination: OrderedHistoryItem[], membership: ProjectHistoryMembership,
  directory: Extract<RetainedNativeDirectory, { readable: true }>, query: FixedQuery, after?: HistoryPosition, signal?: AbortSignal): Promise<boolean> {
  const keyword = query.keyword !== undefined && query.keyword !== '';
  const preparation = prepareNativeProjectDirectory(directory, signal, keyword);
  const records = preparation.records.filter(record => isProjectVisibleLocator(record) && locatorMatchesQuery(record, query))
    .sort((left, right) => right.time - left.time || right.seq - left.seq);
  if (keyword) {
    const selected = new Set(records.filter(record => after === undefined || !(record.time > after.time || record.time === after.time
      && (membership.hostSessionId < after.hostSessionId || membership.hostSessionId === after.hostSessionId && record.seq > after.eventIndex))).map(record => record.seq));
    const candidates: OrderedHistoryItem[] = [];
    let anchorPresent = false;
    const withRelations = await visitNativeProjectVisibleDirectoryEvents(directory, selected, entry => {
      if (!matchesQuery(entry.item, query)) return;
      const position: HistoryPosition = { time: entry.item.time, hostSessionId: membership.hostSessionId, eventIndex: entry.eventIndex,
        kind: entry.item.kind, id: `${entry.item.seq}:${entry.item.messageId ?? entry.item.toolCallId ?? ''}` };
      if (after !== undefined) { const comparison = comparePosition(position, after); if (comparison === 0) anchorPresent = true; if (comparison <= 0) return; }
      const index = candidates.findIndex(candidate => comparePosition(position, candidate.position) < 0);
      const insertion = index < 0 ? candidates.length : index;
      if (insertion >= query.limit + 1) return;
      candidates.splice(insertion, 0, { position, item: searchExcerpt({ ...entry.item, session: membership }, query) });
      if (candidates.length > query.limit + 1) candidates.pop();
    }, signal, preparation);
    for (const candidate of candidates) destination.push({ position: candidate.position, item: { ...candidate.item, ...withRelations(candidate.item) } });
    return anchorPresent;
  }
  let anchorPresent = false, count = 0;
  for (const record of records) {
    signal?.throwIfAborted();
    if (after !== undefined && (record.time > after.time || record.time === after.time && (membership.hostSessionId < after.hostSessionId
      || membership.hostSessionId === after.hostSessionId && record.seq > after.eventIndex))) continue;
    const entries = await selectNativeProjectVisibleDirectoryEvents(directory, new Set([record.seq]), signal, preparation);
    const ordered = entries.map(entry => ({ entry, position: { time: entry.item.time, hostSessionId: membership.hostSessionId, eventIndex: entry.eventIndex,
      kind: entry.item.kind, id: `${entry.item.seq}:${entry.item.messageId ?? entry.item.toolCallId ?? ''}` } })).sort((left, right) => comparePosition(left.position, right.position));
    for (const { entry, position } of ordered) {
      if (!matchesQuery(entry.item, query)) continue;
      if (after !== undefined) { const comparison = comparePosition(position, after); if (comparison === 0) anchorPresent = true; if (comparison <= 0) continue; }
      destination.push({ position, item: searchExcerpt({ ...entry.item, session: membership }, query) }); count++;
      if (count >= query.limit + 1) break;
    }
    if (count >= query.limit + 1) break;
  }
  await directory.revalidate(); return anchorPresent;
}
function locatorMatchesQuery(record: ProjectRecordLocator, query: FixedQuery): boolean {
  if (query.fromTime !== undefined && record.time < query.fromTime || query.toTime !== undefined && record.time > query.toTime) return false;
  const type = projectRecordSemanticType(record.type);
  if (query.recordKinds !== undefined && !query.recordKinds.includes(type)) return false;
  const producer = record.facts.sourceKind ?? (type.startsWith('assistant/') || type === 'projects/assistant-progress' ? 'model'
    : type.includes('stop-request') ? 'control' : type.includes('tool') ? 'tool' : undefined);
  if (query.producer !== undefined && producer !== undefined && producer !== query.producer) return false;
  const speaker = type.startsWith('assistant/') || type === 'projects/assistant-progress' ? 'assistant' : type.includes('tool') ? 'tool'
    : type.includes('stop-request') ? 'system' : producer === 'user' ? 'user' : producer === 'project-delivery' ? 'project-delivery' : undefined;
  return query.speaker === undefined || speaker === undefined || query.speaker === speaker;
}

function historyPosition(entry: NativeProjectVisibleEvent, hostSessionId: string): HistoryPosition {
  return { time: entry.item.time, hostSessionId, eventIndex: entry.eventIndex, kind: entry.item.kind,
    id: `${entry.item.seq}:${entry.item.messageId ?? entry.item.toolCallId ?? ''}` };
}

/** Group boundaries come from metadata, so a continuation never has to re-read earlier message bodies. */
async function appendGroupedDirectoryItems(destination: OrderedHistoryItem[], membership: ProjectHistoryMembership,
  directory: Extract<RetainedNativeDirectory, { readable: true }>, query: FixedQuery, after?: HistoryPosition, signal?: AbortSignal,
  selectedMessage?: { readonly hostSessionId: string; readonly messageId: string }): Promise<boolean> {
  if (selectedMessage !== undefined && selectedMessage.hostSessionId !== membership.hostSessionId) return false;
  const retained: OrderedHistoryItem[] = [];
  const anchorPresent = await directory.withOperation(async () => {
    const preparation = prepareNativeProjectDirectory(directory, signal, true);
    const relations = prepareNativeProjectDirectoryRelations(preparation, signal);
    const metadata = relations.metadata;
    let anchorPresent = false;
    if (selectedMessage !== undefined) {
      const entries = metadata.filter(entry => entry.item.messageId === selectedMessage.messageId)
        .map(entry => ({ entry, position: historyPosition(entry, membership.hostSessionId) }))
        .sort((left, right) => comparePosition(left.position, right.position));
      anchorPresent = after === undefined || entries.some(entry => comparePosition(entry.position, after) === 0);
      const selected = entries.filter(entry => after === undefined || comparePosition(entry.position, after) > 0).slice(0, query.limit + 1);
      const keys = new Set(selected.map(entry => JSON.stringify(entry.position)));
      await visitNativeProjectVisibleDirectoryEvents(directory, new Set(selected.map(entry => entry.entry.item.seq)), entry => {
        const position = historyPosition(entry, membership.hostSessionId);
        if (keys.has(JSON.stringify(position))) retained.push({ position,
          item: { ...searchExcerpt({ ...entry.item, session: membership }, query), matchesSearch: matchesQuery(entry.item, query) } });
      }, signal, preparation, relations);
    } else {
      type Group = { position: HistoryPosition; entries: NativeProjectVisibleEvent[]; record?: ProjectRecordLocator };
      const groups = new Map<string, Group>(), knownSeqs = new Set<number>();
      for (const entry of metadata) {
        signal?.throwIfAborted(); knownSeqs.add(entry.item.seq);
        const position = historyPosition(entry, membership.hostSessionId);
        const key = entry.item.messageId === undefined ? JSON.stringify(['event', position]) : JSON.stringify(['message', entry.item.messageId]);
        const group = groups.get(key);
        if (group === undefined) groups.set(key, { position, entries: [entry] });
        else { group.entries.push(entry); if (comparePosition(position, group.position) < 0) group.position = position; }
      }
      // Progress visibility needs its real incremental fold; never invent a message identity for it.
      for (const record of preparation.records) if (isProjectVisibleLocator(record) && !knownSeqs.has(record.seq)) {
        const position = { time: record.time, hostSessionId: membership.hostSessionId, eventIndex: record.seq,
          kind: projectRecordSemanticType(record.type), id: `${record.seq}:` };
        groups.set(JSON.stringify(['unprojected', record.seq]), { position, entries: [], record });
      }
      const ordered = [...groups.values()].sort((left, right) => comparePosition(left.position, right.position));
      anchorPresent = after === undefined || ordered.some(group => comparePosition(group.position, after) === 0);
      const keep = (candidate: OrderedHistoryItem) => {
        const index = retained.findIndex(entry => comparePosition(candidate.position, entry.position) < 0);
        retained.splice(index < 0 ? retained.length : index, 0, candidate);
        if (retained.length > query.limit + 1) retained.pop();
      };
      const keyword = query.keyword !== undefined && query.keyword !== '';
      const nonTextQuery = { ...query, keyword: undefined };
      const progressGroup = (group: Group): boolean => {
        const type = group.record === undefined ? group.entries[0]?.item.kind : projectRecordSemanticType(group.record.type);
        return type === 'assistant/progress' || type === 'projects/assistant-progress' || type === 'assistant/attempt';
      };
      // With no text predicate, these ordinary groups are known matches before
      // any body is read. Older standalone progress cannot displace limit+1 of
      // them; only selected newer progress may require an older attempt prefix.
      const ordinaryBoundary = keyword ? undefined : ordered.filter(group => !progressGroup(group)
        && (after === undefined || comparePosition(group.position, after) > 0)
        && group.entries.some(entry => matchesQuery(entry.item, nonTextQuery)))[query.limit]?.position;
      const folded = ordered.filter(group => group.entries.every(entry => entry.item.messageId === undefined)
        && (keyword || progressGroup(group)) && (after === undefined || comparePosition(group.position, after) >= 0)
        && (ordinaryBoundary === undefined || comparePosition(group.position, ordinaryBoundary) <= 0)
        && (group.record === undefined ? group.entries.some(entry => matchesQuery(entry.item, nonTextQuery)) : locatorMatchesQuery(group.record, query)));
      if (folded.length > 0) {
        // Output progress has no messageId. Keep its original single incremental
        // fold for both browse and keyword queries, rather than replaying its
        // cumulative prefix for each standalone candidate.
        const seqs = new Set(folded.flatMap(group => group.record === undefined ? group.entries.map(entry => entry.item.seq) : [group.record.seq]));
        await visitNativeProjectVisibleDirectoryEvents(directory, seqs, entry => {
          if (entry.item.messageId !== undefined || !matchesQuery(entry.item, query)) return;
          const position = historyPosition(entry, membership.hostSessionId);
          if (after !== undefined && comparePosition(position, after) <= 0) return;
          keep({ position, item: searchExcerpt({ ...entry.item, session: membership }, query) });
        }, signal, preparation, relations);
      }
      for (const group of ordered) {
        signal?.throwIfAborted();
        if (after !== undefined) {
          const compared = comparePosition(group.position, after);
          if (compared === 0) anchorPresent = true;
          if (compared <= 0) continue;
        }
        if ((keyword || progressGroup(group)) && group.entries.every(entry => entry.item.messageId === undefined)) continue;
        if (retained.length >= query.limit + 1 && comparePosition(group.position, retained.at(-1)!.position) > 0) break;
        const matchingMetadata = group.entries.filter(entry => matchesQuery(entry.item, nonTextQuery))
          .sort((left, right) => comparePosition(historyPosition(left, membership.hostSessionId), historyPosition(right, membership.hostSessionId)));
        if (group.record === undefined && matchingMetadata.length === 0 || group.record !== undefined && !locatorMatchesQuery(group.record, query)) continue;
        const selectedMetadata = query.keyword === undefined ? matchingMetadata.slice(0, 1) : matchingMetadata;
        const selectedKeys = new Set(selectedMetadata.map(entry => JSON.stringify(historyPosition(entry, membership.hostSessionId))));
        const seqs = new Set(group.record === undefined ? selectedMetadata.map(entry => entry.item.seq) : [group.record.seq]);
        let representative: OrderedHistoryItem | undefined;
        await visitNativeProjectVisibleDirectoryEvents(directory, seqs, entry => {
          const position = historyPosition(entry, membership.hostSessionId);
          if (group.record === undefined && !selectedKeys.has(JSON.stringify(position)) || !matchesQuery(entry.item, query)) return;
          if (representative === undefined || comparePosition(position, representative.position) < 0)
            representative = { position, item: searchExcerpt({ ...entry.item, session: membership }, query) };
        }, signal, preparation, relations);
        if (representative === undefined) continue;
        const latest = group.entries.find(entry => comparePosition(historyPosition(entry, membership.hostSessionId), group.position) === 0);
        const messageId = latest?.item.messageId;
        const locator = latest === undefined ? undefined : preparation.bySeq.get(latest.item.seq);
        keep({ item: representative.item, position: group.position,
          ...(latest === undefined || messageId === undefined || locator === undefined ? {} : { group: { messageId, versionCount: group.entries.length,
            latestSource: decodeNativeEventSource({ kind: 'native-event', version: 1, projectId: directory.projectId, sessionId: directory.sessionId,
              hostSessionId: directory.hostSessionId, sessionCreatedAt: directory.sessionCreatedAt, eventSpace: { kind: 'canonical', formatVersion: directory.formatVersion },
              eventSeq: locator.seq, eventType: locator.type, eventDigest: locator.eventDigest, messageId,
              ...(latest.item.toolCallId === undefined ? {} : { toolCallId: latest.item.toolCallId }) }),
            ...(latest.item.recordPhase === undefined ? {} : { latestRecordPhase: latest.item.recordPhase }),
            representativeIsLatest: comparePosition(representative.position, group.position) === 0 } }) });
      }
    }
    const decorate = relations.decorate();
    for (let index = 0; index < retained.length; index++) retained[index] = { ...retained[index]!, item: { ...retained[index]!.item, ...decorate(retained[index]!.item) } };
    await directory.revalidate();
    return anchorPresent;
  });
  signal?.throwIfAborted(); destination.push(...retained);
  return anchorPresent;
}

async function sameSource(
  cut: SourceCut,
  header: unknown,
  inheritedEventCount: unknown,
  events: readonly SessionEvent[],
  cursor: unknown,
): Promise<boolean> {
  if (events.length < cut.eventCount) return false;
  if (typeof cursor !== "number" || cursor < cut.cursor) return false;
  return cut.sourceIdentity === await digest(header)
    && cut.prefixHash === await digest({ header, inheritedEventCount, events: events.slice(0, cut.eventCount) });
}

function comparePosition(left: HistoryPosition, right: HistoryPosition): number {
  if (left.time !== right.time) return right.time - left.time;
  if (left.hostSessionId !== right.hostSessionId) return left.hostSessionId < right.hostSessionId ? -1 : 1;
  if (left.eventIndex !== right.eventIndex) return right.eventIndex - left.eventIndex;
  if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
  return left.id === right.id ? 0 : left.id < right.id ? -1 : 1;
}

function boundedWindow(value: number | undefined, name: string): number | string {
  const normalized = value ?? 1;
  return Number.isSafeInteger(normalized) && normalized >= 0 && normalized <= PROJECT_HISTORY_CONTEXT_MAX
    ? normalized
    : `${name} must be an integer between 0 and ${PROJECT_HISTORY_CONTEXT_MAX}`;
}

function emptySourceRead(): {
  readonly items: OrderedHistoryItem[];
  readonly cuts: SourceCut[];
  readableSources: number;
  readonly limitations: string[];
  readonly brokenHosts: Set<string>;
  readonly unavailableSources: ProjectHistoryUnavailableSource[];
  readonly anchors: Set<string>;
} {
  return { items: [], cuts: [], readableSources: 0, limitations: [], brokenHosts: new Set<string>(), unavailableSources: [], anchors: new Set<string>() };
}

function freezeSourceRead(value: ReturnType<typeof emptySourceRead>): SourceRead {
  return {
    items: value.items,
    cuts: value.cuts,
    readableSources: value.readableSources,
    limitations: value.limitations,
    brokenHosts: value.brokenHosts,
    unavailableSources: value.unavailableSources,
    anchors: value.anchors,
  };
}

function encodeCursor(cursor: HistoryCursor): string {
  return encodeURIComponent(JSON.stringify(cursor));
}

function decodeCursor(value: string): HistoryCursor | undefined {
  try {
    const parsed = JSON.parse(decodeURIComponent(value));
    return validCursor(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function validCursor(value: unknown): value is HistoryCursor {
  const record = object(value);
  if ((record?.version !== 1 && record?.version !== 2 && record?.version !== 3) || typeof record.projectId !== "string") return false;
  if ((record.version === 2 || record.version === 3) && record.order !== "recorded-desc-host-seq-kind-id/v1") return false;
  if (record.version === 3) {
    if (record.view !== 'messages' && record.view !== 'message-versions') return false;
    const message = object(record.message);
    if (record.view === 'message-versions' ? message === undefined || typeof message.hostSessionId !== 'string' || typeof message.messageId !== 'string' || message.messageId.length === 0 : record.message !== undefined) return false;
  } else if (record.view !== undefined || record.message !== undefined) return false;
  const query = object(record.query);
  const cuts = Array.isArray(record.cuts) ? record.cuts : undefined;
  if (query === undefined || cuts === undefined || !validFixedQuery(query)) return false;
  if (!cuts.every(validSourceCut)) return false;
  if ((record.version === 2 || record.version === 3) && !cuts.every(cut => validDirectoryCut(object(cut)?.directoryCut))) return false;
  if (record.version === 3 && record.view === 'message-versions' && !cuts.every(cut => object(cut)?.hostSessionId === object(record.message)?.hostSessionId)) return false;
  if (record.version === 1 && cuts.some(cut => object(cut)?.directoryCut !== undefined)) return false;
  if (new Set(cuts.map(cut => `${cut.id}\u0000${cut.hostSessionId}`)).size !== cuts.length) return false;
  return record.after === undefined || validPosition(record.after);
}

function validFixedQuery(value: Record<string, unknown>): boolean {
  const sessionIds = value.sessionIds;
  if (value.hostSessionIds !== undefined && (!Array.isArray(value.hostSessionIds) || uniqueStrings(value.hostSessionIds) === undefined)) return false;
  if (value.recordKinds !== undefined && (!Array.isArray(value.recordKinds) || uniqueStrings(value.recordKinds) === undefined)) return false;
  if (value.producer !== undefined && typeof value.producer !== "string" || value.timeField !== undefined && value.timeField !== "recorded") return false;
  return typeof value.limit === "number" && validLimit(value.limit)
    && (sessionIds === undefined || Array.isArray(sessionIds) && uniqueStrings(sessionIds) !== undefined)
    && validEpoch(value.fromTime as number | undefined)
    && validEpoch(value.toTime as number | undefined)
    && (value.fromTime === undefined || value.toTime === undefined || (value.fromTime as number) <= (value.toTime as number))
    && (value.speaker === undefined || isSpeaker(value.speaker as string))
    && (value.keyword === undefined || typeof value.keyword === "string");
}

function validSourceCut(value: unknown): value is SourceCut {
  const record = object(value);
  return record !== undefined
    && validMembership(record)
    && Number.isSafeInteger(record.sourceRevision) && (record.sourceRevision as number) >= 0
    && record.sourceKind === "available"
    && Number.isSafeInteger(record.eventCount) && (record.eventCount as number) >= 0
    && Number.isSafeInteger(record.cursor) && (record.cursor as number) >= -1
    && typeof record.sourceIdentity === "string"
    && typeof record.prefixHash === "string";
}

function validPosition(value: unknown): value is HistoryPosition {
  const record = object(value);
  return record !== undefined
    && validEpoch(record.time as number | undefined)
    && typeof record.hostSessionId === "string"
    && Number.isSafeInteger(record.eventIndex) && (record.eventIndex as number) >= 0
    && typeof record.kind === "string"
    && typeof record.id === "string";
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function digest(value: unknown): Promise<string> {
  const hash = createHash('sha256');
  for (const chunk of canonicalJsonChunks(value, 'history')) hash.update(chunk);
  return hash.digest('hex');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function searchExcerpt(item: ProjectHistorySearchItem, query: FixedQuery): ProjectHistorySearchItem {
  const keyword = query.keyword?.toLowerCase();
  const offset = keyword === undefined ? -1 : item.text.toLowerCase().indexOf(keyword);
  const match = offset < 0 ? undefined : originalMatchRange(item.text, offset, offset + keyword!.length);
  const total = codePointLength(item.text), start = Math.max(0, (match?.start ?? 0) - 64), end = Math.min(total, start + PROJECT_HISTORY_EXCERPT_MAX);
  const { visibleBlocks: _blocks, ...rest } = item;
  return { ...rest, text: sliceCodePoints(item.text, start, end), excerpt: {unit:'unicode-code-points',start,end,total},
    ...(match === undefined ? {} : {match:{method:'literal-case-insensitive',field:'text',...match}}) };
}

/** Whole-string lowercase matching retains contextual sigma; only offset mapping is streamed. */
function originalMatchRange(text: string, foldedStart: number, foldedEnd: number): { start: number; end: number } {
  if (foldedStart === foldedEnd) return { start: 0, end: 0 };
  let foldedOffset = 0, start = 0, index = 0;
  for (const point of text) {
    const nextOffset = foldedOffset + point.toLowerCase().length;
    if (foldedOffset <= foldedStart && foldedStart < nextOffset) start = index;
    if (foldedOffset < foldedEnd && foldedEnd <= nextOffset) return { start, end: index + 1 };
    foldedOffset = nextOffset; index++;
  }
  return { start, end: index };
}

function coverageFor(member: ProjectHistoryMembership, items: readonly NativeProjectSourceItem[]) {
  const first = items.at(0)?.seq, last = items.at(-1)?.seq;
  return {sessionId:member.id,hostSessionId:member.hostSessionId,...(first===undefined?{}:{firstSeq:first}),...(last===undefined?{}:{lastSeq:last})};
}
