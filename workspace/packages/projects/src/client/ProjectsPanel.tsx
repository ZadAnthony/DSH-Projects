import { projectCarrierIdentity } from "./controller.ts";
import {
  useEffect, useLayoutEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type CSSProperties,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";

import {
  ActionMenu,
  Button,
  EmptyState,
  ErrorState,
  Feedback,
  IconAction,
  Input,
  ListRow,
  LoadingState,
  Menu,
  SegmentedTabs,
  Select,
  StateDot,
  Tooltip,
  IconChevronLeftOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronsUpDownOutlineRegular,
  IconCloseOutlineRegular,
  IconPanelLeftOutlineRegular,
  IconPlusOutlineRegular,
  IconProjectAddOutlineRegular,
  IconSearchOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconSettingsOutlineRegular,
  IconEllipsisOutlineRegular,
  Modal,
  Tag,
} from "./ui/index.ts";
import type { ConversationViewsProps } from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {
  InjectFace,
  PropsLocale,
  PropsRenderFactories,
  PropsRenderSlots,
  PropsRuntime,
} from "@deepseek-ai/dsh-client-ui-slots";

import type { OverviewNavigation, OverviewSourceView } from "../features/overview/contract.ts";
import { OverviewPanel } from "../features/overview/client.ts";
import { ScheduleOverview, SchedulePanel } from "../features/schedule/client.ts";
import { UsageSessionSummary, type ProjectUsageResult } from "../features/usage/client.ts";
import type {
  ProjectDetail,
  LibraryOpenResult,
  ProjectHistoryReadResult,
  ProjectHistorySearchItem,
  ProjectHistorySearchRequest,
  ProjectHistorySearchResult,
  ProjectHistorySpeaker,
  ProjectNativeSourceRead,
  ProjectRecord,
  ProjectLifecycleActionResult,
  ProjectLifecycleSessionOutcome,
  ProjectSessionRecord,
  ProjectSessionDeletionResult,
  ProjectUnavailableSource,
} from "../public-types.ts";
import type { NativeEventSource, NativeProjectSource } from "../source-types.ts";
import { LibraryPanel, LibraryReader, type LibrarySelection } from "./library/index.ts";
import type { LibraryReading, ReadingOrigin, ReadingHint } from "./workflow-reading.ts";
import { ConversationFileReader } from "./ConversationFileReader.tsx";
import type { ProjectConversationFileRequest } from "./workflow-navigation.ts";
import type {
  ProjectPanelNavigation,
  ProjectPanelReferences,
  ProjectPanelReference,
  ProjectWatchInterruption,
  ProjectsPanelActions,
} from "./controller.ts";
import { ProjectSettings } from "./ProjectSettings.tsx";
import { MemoryNoticeNavigationContext } from "./MemoryNotice.tsx";
import { OverviewResizeHandle } from "./OverviewResizeHandle.tsx";
import { DeletionConfirmation, ProjectDeletionResult, SessionDeletionResults, type DeletionTarget } from "./SessionDeletionResults.tsx";

type ProjectPanelProps = PropsRuntime<"main"> &
  PropsRenderSlots<
    "projects.main.conversation" | "projects.execution.conversation" | "projects.main.model"
  > &
  PropsLocale<"projects"> &
  InjectFace<ProjectsPanelActions> & {
    readonly onToggleGlobalSidebar?: () => void;
    readonly pickWorkspaceDirectory?: () => Promise<string | null>;
    readonly renderMainModelControl?: (reference: ProjectPanelReference) => ReactNode;
    readonly renderSourceConversation?: (detail: ProjectDetail, source: NativeEventSource, options: { readonly readOnly: true }) => ReactNode;
    readonly renderConversation?: (reference: ProjectPanelReference, options: { readonly readOnly: boolean; readonly projectName?: string; readonly visible?: boolean; readonly focus?: { readonly id: number; readonly eventSeq: number; readonly messageId?: string | undefined } | undefined }) => ReactNode;
  };

type EmbeddedConversationProps = PropsRuntime<"projects.main.conversation"> &
  PropsRenderFactories;

type Screen =
  | { readonly kind: "loading" }
  | { readonly kind: "list" }
  | { readonly kind: "deletion"; readonly projectId: ProjectRecord["id"] }
  | {
      readonly kind: "project";
      readonly projectId: ProjectRecord["id"];
      readonly references: ProjectPanelReferences;
    };

interface ProjectListReadState {
  readonly owner: ProjectsPanelActions["listProjects"];
  readonly request: number;
  readonly projects?: readonly ProjectRecord[];
  readonly loading: boolean;
  readonly failed: boolean;
}

function ProjectUpdatesInterrupted({ value, t, onReturnToList }: {
  readonly value: ProjectWatchInterruption;
  readonly t: Translate;
  readonly onReturnToList?: () => void;
}): ReactNode {
  return <ErrorState inline title={t("wholeRead.projectUpdates.title")}
    description={t(onReturnToList === undefined ? "wholeRead.projectUpdates.settingsRecovery" : "wholeRead.projectUpdates.previous")}
    retry={onReturnToList} retryLabel={t("project.back")}>
    {onReturnToList !== undefined && <p>{t("wholeRead.projectUpdates.recovery")}</p>}
    {value.message !== undefined && <details><summary>{t("wholeRead.projectUpdates.details")}</summary><p>{value.message}</p></details>}
  </ErrorState>;
}

/** The committed chat screen, rather than its asynchronously refreshed controller, owns these mounts. */
function ProjectConversationLifetime({ references, children }: { readonly references: ProjectPanelReferences; readonly children: ReactNode }): ReactNode {
  useLayoutEffect(() => references.mount(), [references]);
  return children;
}

/** A legal native input is shown only after its logical owner accepted the physical binding. */
function ProjectConversationReady({ ready, commitKey, onContentCommit, children , t}: {
  readonly ready?: Promise<void> | undefined;
  readonly commitKey: ProjectPanelReferences;
  readonly onContentCommit: (committed: boolean) => void;
  readonly children: ReactNode;
 readonly t: Translate }): ReactNode {
  const contentCommit = useRef(onContentCommit);
  contentCommit.current = onContentCommit;
  const [settled, setSettled] = useState<{ readonly ready: Promise<void>; readonly error?: string }>();
  useEffect(() => {
    if (ready === undefined) return;
    let active = true;
    void ready.then(() => { if (active) setSettled({ ready }); }, error => {
      if (active) setSettled({ ready, error: error instanceof Error ? error.message : String(error) });
    });
    return () => { active = false; };
  }, [ready]);
  const contentReady = ready === undefined || settled?.ready === ready && settled.error === undefined;
  useEffect(() => {
    // A binding promise can settle before this component has rendered its children.
    // Child passive mount effects run first; only then may a parent consume input focus.
    if (!contentReady) return;
    const commit = contentCommit.current;
    commit(true);
    // A later mount can reuse cached references; its old DOM commit must not count.
    return () => { commit(false); };
  }, [commitKey, ready, contentReady]);
  if (ready !== undefined && settled?.ready !== ready) return <LoadingState label={t("p5.panel.connectingConversation")} rows={1} />;
  if (ready !== undefined && settled?.ready === ready && settled.error !== undefined) return <ErrorState title={t("p5.panel.conversationConnectionUnavailable")}
    description={t("p5.panel.conversationConnectionRecovery")}>
    <details className="projects-ui__notice-details"><summary>{t("p5.panel.errorDetails")}</summary><p className="projects-ui__diagnostic">{settled.error}</p></details>
  </ErrorState>;
  return children;
}

type SideView =
  | "sessions"
  | "chat"
  | "sources"
  | "library"
  | "board"
  | "schedule"
  | "history"
  | "historyRead"
  | "libraryFile"
  | "conversationFile"
  | "boardSource";

interface ProjectSourcePanelState {
  readonly sources: readonly NativeProjectSource[];
  readonly reads: readonly {
    readonly source: NativeProjectSource;
    readonly value: ProjectNativeSourceRead;
  }[];
  readonly loading: boolean;
  readonly failed: boolean;
}

interface HistoryReadPanelState {
  readonly source: NativeProjectSource;
  readonly result: ProjectHistoryReadResult;
}

function FixedChatView({ renderSlot }: ConversationViewsProps): ReactNode {
  return (
    <>
      {renderSlot("conversation.session", { view: "chat" })}
    </>
  );
}

/** One stable embedded factory occurrence using DSH's ordinary chat view. */
export function EmbeddedConversation({
  sessionId,
  useSession,
  useConversation,
  useSessions,
  renderFactorySlot,
}: EmbeddedConversationProps): ReactNode {
  const session = useSession((snapshot) => snapshot);
  const conversation = useConversation((snapshot) => snapshot);
  const active =
    conversation.activeTargets.size > 0 ||
    (!session.blank && !session.awaitingFirstTurn) ||
    session.running;
  const shellPhase = active
    ? "active"
    : session.promptAttempted
      ? "engaging"
      : "blank";
  const summaryBlank = useSessions((state) => state.byId[sessionId]?.blank);
  const parentAvailabilityPending =
    session.subagent?.address.mode === "continuable" &&
    session.subagent.parentAvailable === undefined;
  const settling =
    (shellPhase === "blank" &&
      session.openState === "loading" &&
      summaryBlank !== true) ||
    parentAvailabilityPending;
  const phase = settling
    ? "settling"
    : shellPhase === "blank"
      ? "hero"
      : "active";
  return renderFactorySlot(
    "conversation.content",
    { variant: "embedded", phase, hero: false },
    {
      slots: { views: FixedChatView },
    },
  );
}

type Translate = ProjectPanelProps["t"];

function projectWorkspace(project: ProjectRecord, empty: string): string {
  return project.workspace?.path || empty;
}

/** Creation can save a real Project before its main carrier is confirmed/readable. */
function confirmedCreatedMain(detail: ProjectDetail): ProjectSessionRecord | undefined {
  const main = detail.sessions.find(session => session.id === detail.project.mainSessionId && session.role === 'main');
  if (main === undefined || main.hostSessionId.trim() === '' || detail.project.sourceLifecycle !== undefined
    || detail.unavailableSources.some(source => source.hostSessionId === main.hostSessionId)) return undefined;
  const carrier = main.carriers?.find(row => row.isCurrent && row.hostSessionId === main.hostSessionId);
  return carrier?.sourceKind === 'available' && carrier.sessionCreatedAt !== undefined ? main : undefined;
}

function lastExecutionSession(
  detail: ProjectDetail,
): ProjectSessionRecord | undefined {
  return [...detail.sessions]
    .reverse()
    .find((session) => session.role === "execution");
}

function sourceRoleText(
  item: ProjectNativeSourceRead["items"][number],
  t: Translate,
): string {
  switch (item.speaker) {
    case "project-delivery":
      return t("project.sources.role.delivery");
    case "user":
      return t("project.sources.role.input");
    case "assistant":
      return t("project.sources.role.assistant");
    case "tool":
      return t("project.sources.role.tool");
    case "unknown":
      return t("project.sources.role.system");
  }
  if (item.sourceKind === "project-delivery")
    return t("project.sources.role.delivery");
  switch (item.role) {
    case "user":
      return t("project.sources.role.input");
    case "assistant":
      return t("project.sources.role.assistant");
    case "tool":
      return t("project.sources.role.tool");
    case "system":
      return t("project.sources.role.system");
  }
}

function sourceSender(
  item: ProjectNativeSourceRead["items"][number],
  detail: ProjectDetail,
): string | undefined {
  const senderSessionId = item.source?.senderSessionId;
  if (senderSessionId === undefined) return undefined;
  return (
    detail.sessions.find((session) => session.id === senderSessionId)?.title ??
    senderSessionId
  );
}

function sourceKey(source: NativeProjectSource): string {
  if (source.kind === "native-event") return JSON.stringify(source);
  return source.kind === "message"
    ? `message:${source.hostSessionId}:${source.messageId}`
    : `tool:${source.hostSessionId}:${source.toolCallId}`;
}

function libraryPositionKey(projectId: string, sessionId: string, selection: LibrarySelection): string {
  const location = selection.location;
  return JSON.stringify([projectId, sessionId, location.kind, location.kind === "project-file"
    ? location.relativePath : location.entryId, location.kind === "reference" ? location.relativePath ?? "" : ""]);
}

function SourceMetadata({ item, detail, t }: {
  readonly item: ProjectNativeSourceRead["items"][number];
  readonly detail: ProjectDetail;
  readonly t: Translate;
}): ReactNode {
  const hostSessionId = item.nativeSource?.hostSessionId ?? item.bodySource?.hostSessionId;
  const session = detail.sessions.find(value => value.hostSessionId === hostSessionId
    || value.carriers?.some(carrier => carrier.hostSessionId === hostSessionId));
  const sender = sourceSender(item, detail);
  return <div className="dsh-projects__source-meta">
    {session !== undefined && <Tag tone="quiet">{session.role === "main" ? t("project.main.label") : session.title}</Tag>}
    <Tag tone="quiet">{sourceRoleText(item, t)}</Tag>
    <span>{t(item.isTarget ? "project.sources.target" : "project.sources.context")}</span>
    <time dateTime={new Date(item.time).toISOString()}>{new Date(item.time).toLocaleString()}</time>
    {sender !== undefined && <span>{t("project.history.sender", { value: sender })}</span>}
  </div>;
}

function VisibleItems({
  items,
  detail,
  t,
}: {
  readonly items: readonly ProjectNativeSourceRead["items"][number][];
  readonly detail: ProjectDetail;
  readonly t: Translate;
}): ReactNode {
  return items.map((item) => {
    const bounded = item.bodyRange !== undefined && (item.bodyRange.start > 0 || item.bodyRange.end < item.bodyRange.total);
    return (
      <article
        key={`${item.seq}:${item.isTarget}:${item.kind}`}
        className="dsh-projects__source-item"
      >
        <SourceMetadata item={item} detail={detail} t={t} />
        {item.partial && <p className="dsh-projects__history-meta" role="status"><Tag tone="warning">{t("project.history.partial")}</Tag></p>}
        <div className="dsh-projects__source-text">{item.text}</div>
        {bounded && <p className="dsh-projects__history-meta" role="status">{t("p3.history.bodyRange", {
          start: String(item.bodyRange!.start + 1), end: String(item.bodyRange!.end), total: String(item.bodyRange!.total),
        })}</p>}
        {(item.limitations ?? []).map((limitation) => (
          <p key={limitation} className="dsh-projects__history-meta">
            {limitation}
          </p>
        ))}
      </article>
    );
  });
}

function unavailableSourceText(kind: ProjectUnavailableSource["kind"], t: Translate): string {
  return t(`project.sources.${kind}`);
}

function sourceInvalidation(detail: ProjectDetail, hostSessionId: string): ProjectUnavailableSource | undefined {
  return detail.unavailableSources.find(source => source.hostSessionId === hostSessionId);
}

function ProjectSourcesPanel({
  state,
  detail,
  t,
  onLocate,
  onRetry,
}: {
  readonly state: ProjectSourcePanelState;
  readonly detail: ProjectDetail;
  readonly t: Translate;
  readonly onLocate?: (source: NativeProjectSource, read: ProjectNativeSourceRead) => void;
  readonly onRetry: () => void;
}): ReactNode {
  return (
    <>
      {state.loading && (
        <LoadingState label={t("project.sources.loading")} />
      )}
      {state.failed && (
        <ErrorState title={t("p3.history.sources.error")} retry={onRetry} retryLabel={t("list.retry")} />
      )}
      <div className="dsh-projects__record-list">
        {state.reads.map(({ source, value }) => (
          <article key={sourceKey(source)} className="dsh-projects__record">
            {sourceInvalidation(detail, source.hostSessionId) !== undefined ? (
              <ErrorState inline title={unavailableSourceText(sourceInvalidation(detail, source.hostSessionId)!.kind, t)} />
            ) : !value.resolved ? (
              <ErrorState inline title={value.reason ?? t("project.sources.unresolved")} />
            ) : value.items.length === 0 ? (
              <p className="dsh-projects__overview-value">
                {t("project.sources.emptyNative")}
              </p>
            ) : (
              <>
                {value.partial && <p className="dsh-projects__history-meta" role="status"><Tag tone="warning">{t("project.history.partial")}</Tag></p>}
                <VisibleItems items={value.items} detail={detail} t={t} />
              </>
            )}
            {(value.limitations ?? []).map(limitation => <p key={limitation} className="dsh-projects__history-meta">{limitation}</p>)}
            {value.resolved && value.items.some(item => item.isTarget) && onLocate !== undefined && sourceInvalidation(detail, source.hostSessionId) === undefined && <div className="dsh-projects__source-location"><Button variant="ghost" size="sm" type="button" onClick={() => onLocate(source, value)}>{t("p3.history.openOriginal")}</Button></div>}
          </article>
        ))}
      </div>
      {!state.loading && !state.failed && state.reads.length === 0 && (
        <EmptyState title={t("project.sources.empty")} />
      )}
    </>
  );
}

function speakerLabel(value: ProjectHistorySpeaker | "", t: Translate): string {
  switch (value) {
    case "":
      return t("project.history.allSpeakers");
    case "user":
      return t("project.history.speaker.user");
    case "assistant":
      return t("project.history.speaker.assistant");
    case "project-delivery":
      return t("project.history.speaker.project-delivery");
    case "system":
      return t("project.history.speaker.system");
    case "tool":
      return t("project.history.speaker.tool");
    case "unknown":
      return t("project.history.speaker.unknown");
  }
}

function HistoryPanel({
  projectId,
  detail,
  queryHistory,
  readHistory,
  t,
}: {
  readonly projectId: string;
  readonly detail: ProjectDetail;
  readonly queryHistory: (
    projectId: string,
    request: ProjectHistorySearchRequest, signal?: AbortSignal,
  ) => Promise<ProjectHistorySearchResult>;
  readonly readHistory: (
    projectId: string,
    source: NativeProjectSource,
    opener?: HTMLElement,
  ) => Promise<void>;
  readonly t: Translate;
}): ReactNode {
  const [sessionId, setSessionId] = useState("");
  const [keyword, setKeyword] = useState("");
  const [fromTime, setFromTime] = useState("");
  const [toTime, setToTime] = useState("");
  const [speaker, setSpeaker] = useState<ProjectHistorySpeaker | "">("");
  const [result, setResult] = useState<ProjectHistorySearchResult>();
  const [resultDisposition, setResultDisposition] = useState("");
  const disposition = detail.unavailableSources.map(source => `${source.hostSessionId}:${source.sourceRevision}`).join("|");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const epoch = useRef(0);
  const abortRef = useRef<AbortController>();
  useEffect(() => () => { epoch.current++; abortRef.current?.abort(); }, [projectId]);
  const changed = (): void => { epoch.current++; abortRef.current?.abort(); setResult(undefined); setLoading(false); setError(undefined); };
  useEffect(() => { changed(); }, [disposition]);

  const search = async (cursor?: string): Promise<void> => {
    const current = ++epoch.current;
    abortRef.current?.abort();
    const abort = new AbortController(); abortRef.current = abort;
    setLoading(true);
    setError(undefined);
    const request: ProjectHistorySearchRequest = {
      ...(sessionId === "" ? {} : { sessionIds: [sessionId] }),
      ...(keyword.trim() === "" ? {} : { keyword: keyword.trim() }),
      ...(speaker === "" ? {} : { speaker }),
      ...(fromTime === "" ? {} : { fromTime: new Date(fromTime).getTime() }),
      ...(toTime === "" ? {} : { toTime: new Date(toTime).getTime() }),
      ...(cursor === undefined ? {} : { cursor }),
    };
    try {
      const value = await queryHistory(projectId, request, abort.signal);
      if (current === epoch.current) { setResult(value); setResultDisposition(disposition); }
    } catch {
      if (current === epoch.current) setError(t("p3.history.error"));
    } finally {
      if (current === epoch.current) setLoading(false);
    }
  };

  const open = async (item: ProjectHistorySearchItem, opener: HTMLElement): Promise<void> => {
    if (item.nativeSource === undefined) return;
    setError(undefined);
    try {
      await readHistory(projectId, item.nativeSource, opener);
    } catch {
      setError(t("p3.history.error"));
    }
  };

  return (
    <section
      className="dsh-projects__history"
      aria-label={t("project.history.title")}
    >
      <form
        className="dsh-projects__history-form dsp-form-section"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label className="dsp-field">
          {t("project.history.session")}
          <Select aria-label={t("project.history.session")}
            value={sessionId}
            onValueChange={(value) => {
              changed(); setSessionId(value);
            }}
          >
            <option value="">{t("project.history.allSessions")}</option>
            {detail.sessions.filter((session) => session.role === "main" || session.role === "execution").map((session) => (
              <option key={session.id} value={session.id}>
                {session.role === "main"
                  ? t("project.main.label")
                  : session.title}
              </option>
            ))}
          </Select>
        </label>
        <label className="dsp-field">
          {t("project.history.speaker")}
          <Select aria-label={t("project.history.speaker")}
            value={speaker}
            onValueChange={(value) => {
              changed(); setSpeaker(value as ProjectHistorySpeaker | "");
            }}
          >
            <option value="">{speakerLabel("", t)}</option>
            {(
              [
                "user",
                "assistant",
                "project-delivery",
                "system",
                "tool",
                "unknown",
              ] as const
            ).map((value) => (
              <option key={value} value={value}>
                {speakerLabel(value, t)}
              </option>
            ))}
          </Select>
        </label>
        <label className="dsp-field">
          {t("project.history.keyword")}
          <Input
            value={keyword}
            placeholder={t("project.history.keyword.placeholder")}
            onChange={(event) => {
              changed(); setKeyword(event.target.value);
            }}
          />
        </label>
        <label className="dsp-field">{t('project.history.fromTime')}<Input type="datetime-local" step="1" value={fromTime}
          onChange={event => { changed(); setFromTime(event.target.value); }} /></label>
        <label className="dsp-field">{t('project.history.toTime')}<Input type="datetime-local" step="1" value={toTime}
          onChange={event => { changed(); setToTime(event.target.value); }} /></label>
        <div className="dsh-projects__history-form-actions">
          <Button variant="primary" size="sm" type="submit" disabled={loading}>
            {loading && <StateDot state="ongoing" />}
            {loading ? t("project.history.searching") : t("project.history.search")}
          </Button>
          <Button variant="outline" size="sm" type="button" onClick={() => {
            changed(); setSessionId(""); setSpeaker(""); setKeyword(""); setFromTime(""); setToTime("");
          }}>{t("p3.history.reset")}</Button>
        </div>
      </form>
      {loading && <LoadingState label={t("project.history.searching")} />}
      {error !== undefined && <ErrorState title={error} retry={() => { void search(); }} retryLabel={t("list.retry")} />}
      {result !== undefined && (
        <>
          {result.status === "partial" && (
            <p className="dsh-projects__history-meta" role="status"><Tag tone="warning">{t("project.history.partial")}</Tag></p>
          )}
          {result.status === "unavailable" && (
            <ErrorState title={t("p3.history.error")} retry={() => { void search(); }} retryLabel={t("list.retry")} />
          )}
          {result.status !== "unavailable" && result.items.length === 0 && (
            <EmptyState icon={<IconSearchOutlineRegular size={32} />} title={t("project.history.empty")} description={t("p3.history.emptyHint")} />
          )}
          {(result.unavailableSources ?? []).map(source => <p key={`${source.hostSessionId}:${source.sourceRevision}`}
            className="dsh-projects__history-meta" role="status"><Tag tone="warning">{unavailableSourceText(source.kind, t)}</Tag></p>)}
          <div className="dsh-projects__record-list">
            {result.items.filter(item => sourceInvalidation(detail, item.session.hostSessionId) === undefined).map((item) => {
              const content = <>
                <span className="dsh-projects__history-result-meta">
                  <time dateTime={new Date(item.time).toISOString()}>{new Date(item.time).toLocaleString()}</time>
                  <span className="dsh-projects__history-result-speaker">{sourceRoleText(item, t)}</span>
                  {item.recordPhase === "accepted" && <Tag>{t("project.history.phaseAccepted")}</Tag>}
                  {item.recordPhase === "edited" && <Tag>{t("project.history.phaseEdited")}</Tag>}
                  {item.recordPhase === "consumed" && <Tag>{t("project.history.phaseConsumed")}</Tag>}
                  {item.messageGroup !== undefined && !item.messageGroup.representativeIsLatest && <Tag>{t("project.history.earlierVersionMatch")}</Tag>}
                  {item.partial && <Tag tone="warning">{t("project.history.partial")}</Tag>}
                </span>
                <span className="dsh-projects__history-result-context">{item.session.title}
                  {sourceSender(item, detail) === undefined ? "" : ` · ${t("project.history.sender", { value: sourceSender(item, detail)! })}`}
                </span>
                {item.messageGroup !== undefined && !item.messageGroup.representativeIsLatest && <span className="dsh-projects__history-result-context">
                  {t('project.history.lastRecorded', { time: new Date(item.messageGroup.latestRecordedTime).toLocaleString() })}
                </span>}
                <span className={`dsh-projects__history-result-summary${item.nativeSource === undefined ? " dsh-projects__history-result-summary--unlinked" : ""}`}>{item.text}</span>
              </>;
              const row = item.nativeSource === undefined
                ? <article key={`${item.session.id}:${item.seq}:${item.kind}`} className="dsh-projects__history-result-row dsh-projects__history-result-row--unlinked">{content}</article>
                : <ListRow key={`${item.session.id}:${item.seq}:${item.kind}`} className="dsh-projects__history-result-row"
                  aria-label={t("p3.history.openResult", { session: item.session.title, role: sourceRoleText(item, t), time: new Date(item.time).toLocaleString() })}
                  onClick={event => { void open(item, event.currentTarget); }}
                  trailing={<IconChevronLeftOutlineRegular className="dsh-projects__entry-arrow" size={14} />}>{content}</ListRow>;
              return <div key={item.messageGroup?.versionsCursor ?? `${item.session.hostSessionId}:${item.seq}:${item.kind}:${item.messageId ?? item.toolCallId ?? ''}`}>
                {row}
                {item.messageGroup !== undefined && item.messageGroup.versionCount > 1 && <HistoryMessageVersions
                  projectId={projectId} item={item} queryHistory={queryHistory} open={open} t={t} onUnavailable={value => {
                    const sources = value.unavailableSources ?? [];
                    if (sources.length === 0) return;
                    const hosts = new Set(sources.map(source => source.hostSessionId));
                    setResult(previous => previous === undefined ? previous : { ...previous, status: 'partial',
                      items: previous.items.filter(row => !hosts.has(row.session.hostSessionId)),
                      unavailableSources: [...(previous.unavailableSources ?? []).filter(source => !hosts.has(source.hostSessionId)), ...sources] });
                  }} />}
              </div>;
            })}
          </div>
          {result.limitations.map((limitation) => (
            <p key={limitation} className="dsh-projects__history-meta">
              {t("project.history.limitations", { value: limitation })}
            </p>
          ))}
          {result.nextCursor !== undefined && resultDisposition === disposition && !result.items.some(item => sourceInvalidation(detail, item.session.hostSessionId) !== undefined) && (
            <Button
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => {
                void search(result.nextCursor);
              }}
            >
              {t("project.history.next")}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

function HistoryMessageVersions({ projectId, item, queryHistory, open, t, onUnavailable }: {
  readonly projectId: string;
  readonly item: ProjectHistorySearchItem;
  readonly queryHistory: (projectId: string, request: ProjectHistorySearchRequest, signal?: AbortSignal) => Promise<ProjectHistorySearchResult>;
  readonly open: (item: ProjectHistorySearchItem, opener: HTMLElement) => Promise<void>;
  readonly t: Translate;
  readonly onUnavailable: (result: ProjectHistorySearchResult) => void;
}): ReactNode {
  const group = item.messageGroup!;
  const [expanded, setExpanded] = useState(false);
  const [result, setResult] = useState<ProjectHistorySearchResult>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const epoch = useRef(0), abortRef = useRef<AbortController>();
  useEffect(() => () => { epoch.current++; abortRef.current?.abort(); }, [group.versionsCursor]);
  const load = async (cursor: string, append = false): Promise<void> => {
    const current = ++epoch.current;
    abortRef.current?.abort();
    const abort = new AbortController(); abortRef.current = abort;
    setLoading(true); setFailed(false);
    try {
      const value = await queryHistory(projectId, { cursor }, abort.signal);
      if (current !== epoch.current) return;
      if (value.status === 'unavailable') { setResult(undefined); setFailed(true); onUnavailable(value); return; }
      setResult(previous => append && previous !== undefined ? { ...value, items: [...previous.items, ...value.items],
        limitations: [...new Set([...previous.limitations, ...value.limitations])] } : value);
    } catch { if (current === epoch.current) setFailed(true); }
    finally { if (current === epoch.current) setLoading(false); }
  };
  return <div className="dsh-projects__history-meta">
    <Button variant="ghost" size="sm" type="button" aria-expanded={expanded} onClick={() => {
      if (expanded) { epoch.current++; abortRef.current?.abort(); setLoading(false); setExpanded(false); }
      else { setExpanded(true); if (result === undefined) void load(group.versionsCursor); }
    }}>{t(expanded ? 'project.history.hideVersions' : 'project.history.showVersions', { count: String(group.versionCount) })}</Button>
    {expanded && <section aria-label={t('project.history.versions')}>
      {loading && <LoadingState label={t('project.history.searching')} />}
      {failed && <ErrorState title={t('p3.history.error')} retry={() => { void load(result?.nextCursor ?? group.versionsCursor, result !== undefined); }} retryLabel={t('list.retry')} />}
      {result?.items.map(version => <ListRow key={`${version.seq}:${version.kind}:${version.messageId ?? ''}`}
        className="dsh-projects__history-result-row" disabled={version.nativeSource === undefined}
        aria-label={t('project.history.openVersion', { phase: version.recordPhase ?? version.kind, time: new Date(version.time).toLocaleString() })}
        onClick={event => { void open(version, event.currentTarget); }}>
        <span className="dsh-projects__history-result-meta">
          <time dateTime={new Date(version.time).toISOString()}>{new Date(version.time).toLocaleString()}</time>
          <Tag>{t(version.recordPhase === 'accepted' ? 'project.history.phaseAccepted' : version.recordPhase === 'edited' ? 'project.history.phaseEdited'
            : version.recordPhase === 'consumed' ? 'project.history.phaseConsumed' : version.recordPhase === 'claimed' ? 'project.history.phaseClaimed'
            : version.recordPhase === 'canceled' ? 'project.history.phaseCanceled' : 'project.history.phaseOther', { phase: version.recordPhase ?? version.kind })}</Tag>
          {version.matchesSearch && <Tag>{t('project.history.versionMatches')}</Tag>}
          {version.partial && <Tag tone="warning">{t('project.history.partial')}</Tag>}
        </span>
        <span className="dsh-projects__history-result-summary">{version.text}</span>
      </ListRow>)}
      {result?.limitations.map(limitation => <p key={limitation}>{t('project.history.limitations', { value: limitation })}</p>)}
      {result?.nextCursor !== undefined && !loading && <Button variant="outline" size="sm" type="button"
        onClick={() => { void load(result.nextCursor!, true); }}>{t('project.history.nextVersions')}</Button>}
    </section>}
  </div>;
}

function HistoryReadPanel({
  state,
  detail,
  t,
  onLocate,
}: {
  readonly state: HistoryReadPanelState;
  readonly detail: ProjectDetail;
  readonly t: Translate;
  readonly onLocate?: (source: NativeProjectSource, read: ProjectHistoryReadResult) => void;
}): ReactNode {
  const unavailable = sourceInvalidation(detail, state.source.hostSessionId);
  const result = unavailable === undefined ? state.result : {
    status: "unavailable" as const, found: false, items: [], limitations: [],
    reason: unavailableSourceText(unavailable.kind, t),
  };
  return (
    <>
      {result.status === "partial" && (
        <p className="dsh-projects__history-meta" role="status"><Tag tone="warning">{t("project.history.partial")}</Tag></p>
      )}
      {result.status === "unavailable" ? (
        <ErrorState title={result.reason ?? t("project.sources.unresolved")} />
      ) : !result.found ? (
        <EmptyState title={result.reason ?? t("project.sources.unresolved")} />
      ) : (
        <div className="dsh-projects__record">
          <VisibleItems items={result.items} detail={detail} t={t} />
          {onLocate !== undefined && result.items.some(item => item.isTarget) && <div className="dsh-projects__source-location"><Button variant="ghost" size="sm" type="button" onClick={() => onLocate(state.source, result)}>{t("p3.history.openOriginal")}</Button></div>}
        </div>
      )}
      {result.limitations.map((limitation) => (
        <p key={limitation} className="dsh-projects__history-meta">
          {t("project.history.limitations", { value: limitation })}
        </p>
      ))}
    </>
  );
}

function ProjectList({
  projects, archived, nameQuery, t, busy, loading, readFailed, hasSnapshot, pendingRestoreProjectId, onRetry, onNameQuery, onArchiveFilter, onOpen, onAction,
}: {
  readonly projects: readonly ProjectRecord[];
  readonly archived: boolean;
  readonly nameQuery: string;
  readonly onNameQuery: (value: string) => void;
  readonly t: Translate;
  readonly busy: boolean;
  readonly loading: boolean;
  readonly readFailed: boolean;
  readonly hasSnapshot: boolean;
  readonly pendingRestoreProjectId?: string | undefined;
  readonly onArchiveFilter: (archived: boolean) => void;
  readonly onOpen: (projectId: ProjectRecord["id"]) => void;
  readonly onAction: (project: ProjectRecord, action: "rename" | "archive" | "restore" | "delete") => void;
  readonly onRetry: () => void;
}): ReactNode {
  const filterId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const [menuTarget, setMenuTarget] = useState<{ readonly projectId: string; readonly trigger: HTMLButtonElement }>();
  const menuProject = menuTarget === undefined ? undefined : projects.find(project => project.id === menuTarget.projectId);
  useEffect(() => {
    if (menuTarget !== undefined && menuProject === undefined) setMenuTarget(undefined);
  }, [menuTarget, menuProject]);
  const currentFilter = archived ? "archived" : "active";
  const showEmpty = projects.length === 0 && hasSnapshot && !loading && !readFailed;
  const searching = nameQuery.trim() !== "";
  return <>
    <div className="dsh-projects__list-tools">
      <div className="dsh-projects__search">
        <Input ref={searchInput} aria-label={t("list.search.label")} value={nameQuery}
          icon={<IconSearchOutlineRegular size={16} />} placeholder={t("list.search.placeholder")}
          onChange={event => onNameQuery(event.target.value)} />
        {nameQuery !== "" && <IconAction type="button"
          icon={<IconCloseOutlineRegular size={14} />} aria-label={t("list.search.clear")}
          onClick={() => { onNameQuery(""); searchInput.current?.focus(); }} />}
      </div>
      <SegmentedTabs className="dsh-projects__filter" label={t("list.filter.label")}
        value={currentFilter} items={[
          { value: "active", label: t("list.filter.active"), id: `${filterId}-active`, panelId: `${filterId}-active-panel` },
          { value: "archived", label: t("list.filter.archived"), id: `${filterId}-archived`, panelId: `${filterId}-archived-panel` },
        ]} onChange={value => onArchiveFilter(value === "archived")} />
    </div>
    <div hidden role="tabpanel" id={`${filterId}-${archived ? "active" : "archived"}-panel`}
      aria-labelledby={`${filterId}-${archived ? "active" : "archived"}`} />
    <div className="dsh-projects__filter-panel" role="tabpanel" aria-busy={loading || undefined} id={`${filterId}-${currentFilter}-panel`}
      aria-labelledby={`${filterId}-${currentFilter}`}>
      {readFailed && <ErrorState title={t("list.error")} description={hasSnapshot ? t("whole.panel.projectListPrevious") : undefined}
        {...(loading ? {} : { retry: onRetry })} retryLabel={t("list.retry")} />}
      {loading && <LoadingState label={t("list.loading")} rows={1} />}
      <div role="status" aria-live="polite" aria-atomic="true">
        {showEmpty && searching && <EmptyState icon={<IconProjectAddOutlineRegular size={32} />}
          title={t("list.search.empty.title")} description={t("list.search.empty.description")} />}
      </div>
      {projects.length === 0 ? showEmpty && !searching && <EmptyState icon={<IconProjectAddOutlineRegular size={32} />}
        title={t(archived ? "list.archived.empty.title" : "list.empty.title")}
        description={t(archived ? "list.archived.empty.description" : "list.empty.description")} />
      : <Menu className="dsh-projects__project-list-menu" open={menuProject !== undefined} portal autoFocus align="end"
        getAnchorRect={() => menuTarget?.trigger.isConnected === true ? menuTarget.trigger.getBoundingClientRect() : null}
        items={menuProject === undefined ? [] : [
          { id: "rename", label: t("project.rename"), disabled: busy || menuProject.sourceLifecycle !== undefined },
          { id: "lifecycle", label: t(pendingRestoreProjectId === menuProject.id ? "p5.panel.continueProjectRestore" : menuProject.archived ? "p5.panel.restoreProject" : "p5.panel.archiveProject"), disabled: busy || menuProject.sourceLifecycle !== undefined },
          { id: "delete", label: t("deletion.project.open"), danger: true, disabled: busy || menuProject.sourceLifecycle !== undefined },
        ]} onClose={() => setMenuTarget(undefined)} onSelect={id => {
          if (menuProject === undefined || busy || menuProject.sourceLifecycle !== undefined || menuTarget?.trigger.disabled) return;
          menuTarget?.trigger.focus();
          flushSync(() => setMenuTarget(undefined));
          if (id === "rename" || id === "delete") onAction(menuProject, id);
          else if (id === "lifecycle") onAction(menuProject, menuProject.archived || pendingRestoreProjectId === menuProject.id ? "restore" : "archive");
        }} anchor={<div className="dsh-projects__projects">
        {projects.map(project => {
          const label = t("whole.panel.projectMenu", { name: project.name });
          return <div key={project.id} className="dsh-projects__project-row-shell"><ListRow
          className="dsh-projects__project-card" data-archived={project.archived}
          aria-label={t("list.open", { name: project.name })} onClick={() => { setMenuTarget(undefined); onOpen(project.id); }}
          icon={<IconProjectAddOutlineRegular size={24} />}
          trailing={<><span className="dsh-projects__project-meta"><time dateTime={project.updatedAt}>
            {new Date(project.updatedAt).toLocaleDateString()}</time></span>
            <span className="dsh-projects__entry-arrow" aria-hidden="true"><IconChevronLeftOutlineRegular size={18} /></span></>}>
          <Tooltip label={project.name}><span className="dsh-projects__project-name projects-ui__list-title">{project.name}{project.archived && <Tag tone="quiet">{t("list.archived.tag")}</Tag>}</span></Tooltip>
          <Tooltip label={projectWorkspace(project, t("project.workspace.empty"))}>
            <span className="dsh-projects__project-workspace projects-ui__list-description">{project.workspace?.path.replaceAll("\\", "/").replace(/\/$/, "").split("/").at(-1) || t("project.workspace.empty")}</span>
          </Tooltip>
          {project.sourceLifecycle !== undefined && <span className="dsh-projects__project-state">{t("list.deletion.pending")}</span>}
        </ListRow><IconAction className="projects-ui__action-menu-trigger" aria-label={label} title={label}
          aria-haspopup="menu" aria-expanded={menuProject?.id === project.id} icon={<IconEllipsisOutlineRegular />}
          onClick={event => {
            const trigger = event.currentTarget;
            if (menuTarget?.projectId === project.id) { trigger.focus(); setMenuTarget(undefined); return; }
            // Reopen the same native Menu so its own effects capture this exact
            // trigger and restart keyboard entry after a switch between rows.
            if (menuTarget !== undefined) flushSync(() => setMenuTarget(undefined));
            trigger.focus();
            setMenuTarget({ projectId: project.id, trigger });
          }} /></div>;
        })}
      </div>} />}
    </div>
  </>;
}

function CreateProjectForm({
  t,
  busy,
  error,
  onSubmit,
  onCancel,
  pickWorkspaceDirectory,
}: {
  readonly t: Translate;
  readonly busy: boolean;
  readonly pickWorkspaceDirectory?: (() => Promise<string | null>) | undefined;
  readonly error?: string | undefined;
  readonly onSubmit: (input: {
    readonly name: string;
    readonly workspace: string;
  }) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const workspaceFieldId = useId();
  const nameFieldId = useId();
  const nameErrorId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [nameInvalid, setNameInvalid] = useState(false);
  const [workspace, setWorkspace] = useState("");
  const [discardOpen, setDiscardOpen] = useState(false);
  const [choosingDirectory, setChoosingDirectory] = useState(false);
  const [directoryError, setDirectoryError] = useState<string>();
  const directoryRequest = useRef(0);
  useEffect(() => () => { directoryRequest.current++; }, []);
  const chooseDirectory = async (): Promise<void> => {
    if (pickWorkspaceDirectory === undefined || busy || choosingDirectory) return;
    const request = ++directoryRequest.current;
    setChoosingDirectory(true); setDirectoryError(undefined);
    try {
      const path = await pickWorkspaceDirectory();
      if (request === directoryRequest.current && path !== null) setWorkspace(path);
    } catch {
      if (request === directoryRequest.current) setDirectoryError(t("create.workspace.choose.error"));
    } finally { if (request === directoryRequest.current) setChoosingDirectory(false); }
  };
  const requestClose = (): void => {
    if (busy) return;
    if (name !== "" || workspace !== "") setDiscardOpen(true);
    else onCancel();
  };
  return (
    <>
    <Modal open title={t("create.title")} closeLabel={t("create.cancel")} onClose={requestClose}
      className="dsh-projects__create-dialog">
    <form
      className="dsp-form-section"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        if (name.trim() === "") { setNameInvalid(true); nameInput.current?.focus(); return; }
        setNameInvalid(false);
        onSubmit({ name, workspace });
      }}
    >
      {error !== undefined && <ErrorState inline title={error} />}
      <div className="dsh-projects__field dsp-field">
        <label htmlFor={nameFieldId}>{t("create.name.label")}</label>
        <Input
          id={nameFieldId}
          ref={nameInput}
          data-modal-autofocus
          required
          aria-invalid={nameInvalid || undefined}
          aria-describedby={nameInvalid ? nameErrorId : undefined}
          value={name}
          placeholder={t("create.name.placeholder")}
          disabled={busy}
          onChange={(event) => {
            setName(event.target.value);
            if (event.target.value.trim() !== "") setNameInvalid(false);
          }}
        />
        {nameInvalid && <span id={nameErrorId} className="projects-ui__field-error" role="alert">{t("whole.panel.projectNameRequired")}</span>}
      </div>
      <div className="dsh-projects__field dsp-field">
        <label htmlFor={workspaceFieldId}>{t("create.workspace.label")}</label>
        <span className="dsh-projects__workspace-picker">
        {pickWorkspaceDirectory !== undefined && <Button variant="outline" size="sm" type="button"
          icon={<IconFolderOpenOutlineRegular size={16} />} disabled={busy || choosingDirectory}
          onClick={() => { void chooseDirectory(); }}>{t(choosingDirectory ? "create.workspace.choosing" : "create.workspace.choose")}</Button>}
        <Input id={workspaceFieldId}
          value={workspace}
          placeholder={t("create.workspace.placeholder")}
          disabled={busy}
          onChange={(event) => {
            setWorkspace(event.target.value);
          }}
        />
        </span>
        {directoryError !== undefined && <ErrorState inline title={directoryError} />}
        <span className="dsh-projects__hint">{t("create.workspace.note")}</span>
      </div>
      <div className="dsh-projects__form-actions">
        <Button variant="outline" size="md" type="button" disabled={busy} onClick={requestClose}>
          {t("create.cancel")}
        </Button>
        <Button variant="primary" size="md" type="submit" disabled={busy}>
          {busy && <StateDot state="ongoing" />}
          {t("create.submit")}
        </Button>
      </div>
    </form>
    </Modal>
    {discardOpen && <Modal open title={t("create.discard.title")} description={t("create.discard.description")}
      closeLabel={t("create.discard.keep")} onClose={() => setDiscardOpen(false)}
      footer={<><Button variant="ghost" size="md" type="button" data-modal-autofocus onClick={() => setDiscardOpen(false)}>{t("create.discard.keep")}</Button>
        <Button variant="primary" size="md" type="button" onClick={onCancel}>{t("create.discard.submit")}</Button></>} />}
    </>
  );
}

function CreateExecutionSessionForm({
  t,
  busy,
  onSubmit,
  onCancel,
}: {
  readonly t: Translate;
  readonly busy: boolean;
  readonly onSubmit: (title: string, workspace?: { readonly path: string } | null) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("default");
  const [workspace, setWorkspace] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const input = nameInput.current;
    if (input !== null && !input.disabled && input.closest("[hidden], [inert], [aria-hidden='true']") === null) input.focus({ preventScroll: true });
  }, []);
  return (
    <form
      className="dsh-projects__form dsp-form-section"
      onSubmit={(event) => {
        event.preventDefault();
        if (location === "other" && workspace.trim() === "") return;
        onSubmit(title, location === "project" ? null : location === "other" ? { path: workspace.trim() } : undefined);
      }}
    >
      <label className="dsh-projects__field dsp-field">
        <span>{t("sessions.new.label")}</span>
        <Input
          ref={nameInput}
          value={title}
          placeholder={t("sessions.new.placeholder")}
          disabled={busy}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />
      </label>
      <label className="dsh-projects__field dsp-field">
        <span>{t("sessions.new.location")}</span>
        <Select aria-label={t("sessions.new.location")} value={location} disabled={busy} onValueChange={value => { setLocation(value); }}>
          <option value="default">{t("sessions.new.location.default")}</option>
          <option value="project">{t("sessions.new.location.project")}</option>
          <option value="other">{t("sessions.new.location.other")}</option>
        </Select>
      </label>
      {location === "other" && <label className="dsh-projects__field dsp-field">
        <span>{t("sessions.new.location.path")}</span>
        <Input aria-label={t("sessions.new.location.path")} required value={workspace}
          disabled={busy} onChange={event => { setWorkspace(event.target.value); }} />
      </label>}
      <p className="dsh-projects__hint">{t("sessions.new.location.note")}</p>
      <div className="dsh-projects__form-actions">
        <Button variant="ghost" size="sm" type="button" disabled={busy} onClick={onCancel}>
          {t("sessions.new.cancel")}
        </Button>
        <Button variant="primary" size="sm" type="submit" disabled={busy}>
          {busy && <StateDot state="ongoing" />}
          {t("sessions.new.submit")}
        </Button>
      </div>
    </form>
  );
}

function ExecutionSessionSelector({ sessions, selected, t, busy, onSelect, onShowAll }: {
  readonly sessions: readonly ProjectSessionRecord[];
  readonly selected: ProjectSessionRecord;
  readonly t: Translate;
  readonly busy: boolean;
  readonly onSelect: (session: ProjectSessionRecord) => void;
  readonly onShowAll: () => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const executions = sessions.filter(session => session.role === "execution");
  return <Menu className="dsh-projects__execution-selector" listClassName="dsh-projects__execution-menu"
    open={open} portal autoFocus selectedId={`session:${selected.id}`} onClose={() => setOpen(false)}
    items={[
      { id: "all", label: t("sessions.all") },
      ...([false, true] as const).flatMap(archived => {
        const group = executions.filter(session => session.archived === archived);
        return group.length === 0 ? [] : [
          { type: "separator" as const, id: `separator:${archived}` },
          { type: "label" as const, id: `group:${archived}`, text: t(archived ? "list.filter.archived" : "list.filter.active") },
          ...group.map(session => ({ id: `session:${session.id}`,
            label: <>{session.archived ? t("sessions.switch.archived", { name: session.title }) : session.title}
              {session.id === selected.id && <span className="projects-ui__visually-hidden">{t("sessions.switch.selected")}</span>}</> })),
        ];
      }),
    ]} onSelect={id => {
      flushSync(() => setOpen(false));
      if (id === "all") onShowAll();
      else {
        const session = executions.find(session => `session:${session.id}` === id);
        if (session !== undefined) onSelect(session);
      }
    }} anchor={<Button className="dsh-projects__execution-trigger" variant="ghost" size="sm" type="button"
      aria-haspopup="menu" aria-expanded={open} disabled={busy} title={selected.title}
      aria-label={t("sessions.switch.current", { name: selected.title })} onClick={() => setOpen(value => !value)}>
      <span className="dsh-projects__execution-current-name">{selected.title}</span><IconChevronDownOutlineRegular size={14} />
    </Button>} />;
}

function SessionsOverview({
  detail,
  t,
  creatingSession,
  busy,
  allowCreate,
  onShowCreate,
  onCreate,
  onOpenExecution,
  onContinueDeletion,
  onOpenHistory,
  onOpenInstructions,
  onOpenSchedule,
  onRename,
  onLifecycle,
  onDelete,
}: {
  readonly detail: ProjectDetail;
  readonly t: Translate;
  readonly creatingSession: boolean;
  readonly busy: boolean;
  readonly allowCreate: boolean;
  readonly onShowCreate: () => void;
  readonly onCreate: (title: string, workspace?: { readonly path: string } | null) => void;
  readonly onOpenExecution: (session: ProjectSessionRecord) => void;
  readonly onContinueDeletion: (result: ProjectSessionDeletionResult) => void;
  readonly onOpenHistory: (opener?: HTMLElement) => void;
  readonly onOpenInstructions: (session: ProjectSessionRecord) => void;
  readonly onOpenSchedule: (session: ProjectSessionRecord) => void;
  readonly onRename: (session: ProjectSessionRecord) => void;
  readonly onLifecycle: (session: ProjectSessionRecord) => void;
  readonly onDelete: (session: ProjectSessionRecord) => void;
}): ReactNode {
  const [archivedList, setArchivedList] = useState(false);
  const filterId = useId();
  const createTriggers = useRef<(HTMLButtonElement | null)[]>([]);
  const createOpener = useRef(0);
  const cancelFocus = useRef(false);
  useLayoutEffect(() => {
    if (creatingSession || !cancelFocus.current) return;
    cancelFocus.current = false;
    const trigger = createTriggers.current[createOpener.current] ?? createTriggers.current[0];
    if (trigger?.isConnected && !trigger.disabled && trigger.closest("[hidden], [inert], [aria-hidden='true']") === null) trigger.focus({ preventScroll: true });
  }, [creatingSession]);
  const executions = detail.sessions.filter(
    (session) => session.role === "execution" && session.archived === archivedList,
  );
  return (
    <section className="dsh-projects__overview-block dsh-projects__sessions-overview">
      <div className="dsh-projects__session-head">
        <h2>{t("sessions.title")}</h2>
        <div className="dsh-projects__session-actions">
        <Button variant="ghost" size="sm" type="button" onClick={event => onOpenHistory(event.currentTarget)}>{t("project.history.search")}</Button>
        {allowCreate && !creatingSession && (
          <Button
            ref={element => { createTriggers.current[0] = element; }}
            variant="primary"
            size="md"
            icon={<IconPlusOutlineRegular size={14} />}
            onClick={() => { createOpener.current = 0; onShowCreate(); }}
          >
            {t("sessions.new")}
          </Button>
        )}
        </div>
      </div>
      <SegmentedTabs className="dsh-projects__filter" label={t("sessions.title")} value={archivedList ? "archived" : "active"}
        items={[
          { value: "active", label: t("list.filter.active"), id: `${filterId}-active`, panelId: `${filterId}-active-panel` },
          { value: "archived", label: t("list.filter.archived"), id: `${filterId}-archived`, panelId: `${filterId}-archived-panel` },
        ]} onChange={value => setArchivedList(value === "archived")} />
      {allowCreate && creatingSession && (
        <CreateExecutionSessionForm
          t={t}
          busy={busy}
          onSubmit={onCreate}
          onCancel={() => { cancelFocus.current = true; onShowCreate(); }}
        />
      )}
      <div hidden role="tabpanel" id={`${filterId}-${archivedList ? "active" : "archived"}-panel`}
        aria-labelledby={`${filterId}-${archivedList ? "active" : "archived"}`} />
      <div className="dsh-projects__filter-panel" role="tabpanel" id={`${filterId}-${archivedList ? "archived" : "active"}-panel`}
        aria-labelledby={`${filterId}-${archivedList ? "archived" : "active"}`}>
      {executions.length === 0 ? (
        <EmptyState icon={<IconProjectAddOutlineRegular size={32} />} title={t("sessions.empty")}
          description={t("p3.history.sessions.emptyHint")}
          actions={allowCreate && !creatingSession ? <Button ref={element => { createTriggers.current[1] = element; }} variant="outline" size="sm"
            onClick={() => { createOpener.current = 1; onShowCreate(); }}>{t("sessions.new")}</Button> : undefined} />
      ) : (
        <div className="dsh-projects__session-list">
          {executions.map((session) => (
            <div key={session.id} className="dsh-projects__session-row-shell">
            <ListRow className="dsh-projects__session-row"
              aria-label={t("sessions.open", { name: session.title })} onClick={() => onOpenExecution(session)}>
              <Tooltip label={session.title}><span className="dsh-projects__session-name projects-ui__list-title">{session.title}</span></Tooltip>
              <span className="dsh-projects__session-subtitle projects-ui__list-description">
                {t("project.conversation.execution")} · {t(session.archived ? "list.filter.archived" : "list.filter.active")}
                {" · "}<time dateTime={session.updatedAt}>{new Date(session.updatedAt).toLocaleDateString()}</time>
              </span>
            </ListRow>
            <ActionMenu label={t("p3.history.sessions.menu", { name: session.title })} items={[
              { id: "open", label: t("p3.history.sessions.open"), disabled: busy },
              { id: "rename", label: t("p5.common.rename"), disabled: busy },
              { id: "instructions", label: t("p3.history.sessions.instructions"), disabled: busy },
              { id: "schedule", label: t("p3.history.schedule.title"), disabled: busy },
              { id: "lifecycle", label: t(detail.pendingRestores?.some(item => item.scope === "session" && item.sessionId === session.id)
                ? "p5.panel.continueExecutionRestore" : session.archived ? "p5.panel.restoreExecution" : "p5.panel.archiveExecution"),
                disabled: busy || detail.pendingRestores?.some(item => item.scope === "project") === true || session.archived && detail.project.archived },
              { id: "delete", label: t("deletion.execution.open"), danger: true, disabled: busy },
            ]} onSelect={id => {
              if (busy) return;
              if (id === "open") onOpenExecution(session);
              else if (id === "rename") onRename(session);
              else if (id === "instructions") onOpenInstructions(session);
              else if (id === "schedule") onOpenSchedule(session);
              else if (id === "lifecycle") onLifecycle(session);
              else if (id === "delete") onDelete(session);
            }} />
            </div>
          ))}
        </div>
      )}
      </div>
      <SessionDeletionResults results={detail.deletionResults} t={t} busy={busy} onContinue={onContinueDeletion} />
    </section>
  );
}

function ProjectLifecycleReport({
  result,
 t}: {
  readonly result: Pick<ProjectLifecycleActionResult, "stage" | "sessions">;
 readonly t: Translate }): ReactNode {
  return (
    <section className="dsh-projects__lifecycle-report" aria-label={t("p5.panel.lifecycleResults")}>
      <p>{t("p5.panel.lifecycleOperationPrefix")}{lifecycleStageText(result.stage, t)}</p>
      <ul>
        {result.sessions.filter((session) => session.role === "main" || session.role === "execution").map((session: ProjectLifecycleSessionOutcome) => (
          <li key={session.sessionId}>
            {session.role === "main" ? t("project.conversation.main") : t("project.conversation.execution")}{t("p5.common.colon")}{lifecycleOutcomeText(session.quiescence, t)}
            {session.reason === undefined ? "" : t("p5.common.punctuationTemplate1", { value: session.reason })}
          </li>
        ))}
      </ul>
    </section>
  );
}

function lifecycleStageText(stage: ProjectLifecycleActionResult["stage"], t: Translate): string {
  switch (stage) {
    case "complete": return t("tool.card.completed")
    case "schedule-preflight": return t("p5.panel.lifecycleCheckSchedules")
    case "prepare-archive-targets": return t("p5.panel.lifecycleConfirmSessionScope")
    case "stop-current-work": return t("p5.panel.lifecycleStopWork")
    case "schedule-post-stop": return t("p5.panel.lifecycleRecheckSchedules")
    case "save-project-archive": return t("p5.panel.lifecycleSaveArchive")
    case "prepare-project-restore": return t("p5.panel.lifecyclePrepareRestore")
    case "save-project-restore": return t("p5.panel.lifecycleSaveRestore")
  }
}

function lifecycleOutcomeText(outcome: ProjectLifecycleSessionOutcome["quiescence"], t: Translate): string {
  switch (outcome) {
    case "settled": return t("p5.panel.lifecycleWorkStoppedSaved")
    case "no-live-instance": return t("p5.panel.lifecycleNoRunningSession")
    case "already-session-archived": return t("p5.panel.lifecyclePreviouslyArchived")
    case "unknown": return t("p5.panel.lifecycleStopUnconfirmed")
    case "not-checked": return t("p5.panel.lifecycleNotStopped")
  }
}

/** A pending focus may use the native port only after the real editable DOM is present and visible. */
function observeConversationInput(region: HTMLElement, current: () => boolean, focus: () => void): () => void {
  let active = true;
  let observer: MutationObserver | undefined;
  const attempt = (): void => {
    if (!active || !current() || !region.isConnected || region.closest("[hidden], [inert], [aria-hidden='true']") !== null) return;
    const input = [...region.querySelectorAll<HTMLElement>("[contenteditable='true']")].find(element =>
      element.isConnected && element.closest("[hidden], [inert], [aria-hidden='true']") === null,
    );
    if (input === undefined) return;
    active = false; observer?.disconnect();
    focus();
  };
  observer = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(attempt);
  observer?.observe(region, { subtree: true, childList: true, attributes: true,
    attributeFilter: ["contenteditable", "hidden", "inert", "aria-hidden"] });
  attempt();
  return () => { active = false; observer?.disconnect(); };
}

/** Observe the actual workspace as host side panels resize it; never poll or remount seats. */
function useWorkspaceSize(element: HTMLElement | null): { readonly width: number; readonly viewportWidth: number } {
  const [size, setSize] = useState({ width: 0, viewportWidth: typeof window === "undefined" ? 0 : window.innerWidth });
  useLayoutEffect(() => {
    if (element === null) return;
    const update = (): void => {
      const width = element.getBoundingClientRect().width;
      const viewportWidth = window.innerWidth;
      setSize(previous => previous.width === width && previous.viewportWidth === viewportWidth ? previous : { width, viewportWidth });
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    observer?.observe(element);
    window.addEventListener("resize", update);
    return () => { observer?.disconnect(); window.removeEventListener("resize", update); };
  }, [element]);
  return size;
}

/** Projects main panel: native chats, project-local navigation, and read-only module surfaces. */
export function ProjectsPanel({
  SessionProvider,
  createExecutionSession,
  renameExecutionSession,
  executionLifecycle,
  projectLifecycle,
  deleteExecutionSession,
  deleteProject,
  createProject,
  getProject,
  libraryActions,
  openLibraryOriginal,
  listProjects,
  readProjectSource,
  queryHistory,
  readHistory,
  memoryActions,
  scheduleActions,
  updateProject,
  overviewActions,
  overviewSource,
  executionDefaultsActions,
  sessionInstructionsActions,
  projectInstructionsActions,
  settingsEnvironment,
  usageActions,
  activate,
  focusConversationInput,
  locateProjectSource,
  readConversationFile,
  dismissConversationFile,
  returnToFileConversation,
  useProjectFileRequest,
  release,
  renderSlot,
  t,
  useProjectDetail,
  useProjectWatchInterruption,
  useProjectNavigation,
  watchProject,
  onToggleGlobalSidebar,
  pickWorkspaceDirectory,
  renderConversation,
  renderSourceConversation,
  renderMainModelControl,
}: ProjectPanelProps): ReactNode {
  const projectDetail = useProjectDetail((detail) => detail);
  const projectWatchInterruption = useProjectWatchInterruption((value) => value);
  const projectNavigation = useProjectNavigation((navigation) => navigation);
  const conversationFileRequest = useProjectFileRequest(request => request);
  const [conversationReading, setConversationReading] = useState<{ readonly request: ProjectConversationFileRequest; readonly scrollTop: number; readonly offset: number }>();
  const handledHistoryNavigation = useRef<number>();
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const listReadOwner = useRef(listProjects);
  listReadOwner.current = listProjects;
  const [listRead, setListRead] = useState<ProjectListReadState>({ owner: listProjects, request: 0, loading: true, failed: false });
  const currentListRead: ProjectListReadState = listRead.owner === listProjects ? listRead
    : { owner: listProjects, request: 0, loading: true, failed: false };
  const sideTabsId = useId();
  const restoreFocus = useRef<{
    readonly target: "main" | "execution" | HTMLElement;
    readonly references: ProjectPanelReferences;
    readonly epoch: number;
    readonly projectId: string;
    readonly navigationId: number | undefined;
  }>();
  const mainRegion = useRef<HTMLElement>(null);
  const executionRegion = useRef<HTMLElement>(null);
  const [conversationCommits, setConversationCommits] = useState<{
    readonly main: ProjectPanelReferences | undefined;
    readonly execution: ProjectPanelReferences | undefined;
  }>({ main: undefined, execution: undefined });
  const [showCreate, setShowCreate] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [visibleConversation, setVisibleConversation] = useState<"main" | "execution">("main");
  const [showExecutionList, setShowExecutionList] = useState(false);
  const executionListRegion = useRef<HTMLElement>(null);
  const executionListFocus = useRef(false);
  const [overviewPreferredWidth, setOverviewPreferredWidth] = useState(360);
  const [overviewWidthMenuOpen, setOverviewWidthMenuOpen] = useState(false);
  const [workspaceElement, setWorkspaceElement] = useState<HTMLDivElement | null>(null);
  const workspaceSize = useWorkspaceSize(workspaceElement);
  useEffect(() => {
    if (!overviewOpen || workspaceSize.viewportWidth < 1024) setOverviewWidthMenuOpen(false);
  }, [overviewOpen, workspaceSize.viewportWidth]);
  const overviewTrigger = useRef<HTMLButtonElement>(null);
  const overviewClose = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (overviewOpen && !["libraryFile", "conversationFile", "sources", "history", "historyRead"].includes(sideView)) overviewClose.current?.focus({ preventScroll: true });
  }, [overviewOpen, screen.kind]);
  const conversationTabsId = useId();
  const conversationTabTraversal = useRef(false);
  useLayoutEffect(() => {
    if (screen.kind !== "project" || visibleConversation !== "execution" || !showExecutionList || !executionListFocus.current) return;
    executionListFocus.current = false;
    executionListRegion.current?.focus({ preventScroll: true });
  }, [screen.kind, visibleConversation, showExecutionList]);
  const [sideView, setSideView] = useState<SideView>("sessions");
  const sideRegion = useRef<HTMLDivElement>(null);
  const sideBack = useRef<HTMLButtonElement>(null);
  const libraryRegion = useRef<HTMLDivElement>(null);
  const libraryOpener = useRef<HTMLElement>();
  const libraryFocusSource = useRef<NativeProjectSource>();
  const sideOpeners = useRef<Partial<Record<SideView, HTMLElement>>>({});
  const sideFocusRequest = useRef<{ readonly view: SideView; readonly target?: HTMLElement }>();
  useLayoutEffect(() => {
    const request = sideFocusRequest.current;
    if (!overviewOpen || screen.kind !== "project") { sideFocusRequest.current = undefined; return; }
    if (request === undefined || request.view !== sideView) return;
    sideFocusRequest.current = undefined;
    const target = request.target;
    const fallback = sideView === "library" ? libraryRegion.current : sideBack.current ?? sideRegion.current;
    (target?.isConnected && target !== document.body && target !== document.documentElement && !target.matches(":disabled")
      && target.closest("[hidden], [inert], [aria-hidden='true']") === null ? target : fallback)?.focus({ preventScroll: true });
  }, [overviewOpen, screen.kind, sideView]);
  const [settingsWindow, setSettingsWindow] = useState<{
    readonly page?: "general" | "memory" | "execution" | "usage";
    readonly sessionId?: string;
    readonly memoryId?: string;
    readonly nameEditing?: boolean;
  }>();
  const [listActionProjectId, setListActionProjectId] = useState<string>();
  const [scheduleWindow, setScheduleWindow] = useState<{ readonly sessionId?: string; readonly scheduleId?: string; readonly create?: boolean }>();
  const [scheduleCloseConfirmation, setScheduleCloseConfirmation] = useState(false);
  const scheduleDirty = useRef(false);
  const [scheduleViewRevision, setScheduleViewRevision] = useState(0);
  const [sourceReturnView, setSourceReturnView] = useState<SideView>("sessions");
  const [libraryReturnView, setLibraryReturnView] = useState<"chat" | "sessions">("sessions");
  const [executionCreateOrigin, setExecutionCreateOrigin] = useState<"central" | "overview">();
  const [renameDraft, setRenameDraft] = useState<{ readonly projectId: string; readonly sessionId: string; readonly expectedRevision: number; readonly title: string }>();
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameNotice, setRenameNotice] = useState("");
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);
  const [projectNameQuery, setProjectNameQuery] = useState("");
  const [titleUsageRead, setTitleUsageRead] = useState<{
    readonly scope: string;
    readonly value?: ProjectUsageResult;
    readonly loading: boolean;
    readonly failed: boolean;
  }>();
  const usageRef = useRef(usageActions);
  usageRef.current = usageActions;
  const [busy, setBusy] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const lifecycleOperation = useRef<symbol>();
  const [deletionConfirmation, setDeletionConfirmation] = useState<DeletionTarget>();
  const [archiveConfirmation, setArchiveConfirmation] = useState<{
    readonly kind: "project" | "execution";
    readonly projectId: string;
    readonly sessionId?: string;
    readonly name: string;
  }>();
  const [pendingDeletion, setPendingDeletion] = useState<DeletionTarget>();
  const [sourcePanel, setSourcePanel] = useState<ProjectSourcePanelState>();
  const [historyReadPanel, setHistoryReadPanel] = useState<HistoryReadPanelState>();
  const [libraryReading, setLibraryReading] = useState<LibraryReading>();
  const libraryPositions = useRef(new Map<string, number>());
  const [readingHints, setReadingHints] = useState<Record<string, ReadingHint | { readonly conversation: { readonly request: ProjectConversationFileRequest; readonly scrollTop: number; readonly offset: number }; readonly mode: "feedback" }>>({});
  const [sourceReadingReturn, setSourceReadingReturn] = useState<LibraryReading>();
  const libraryOrigin = useRef<ReadingOrigin>({ kind: "library" });
  const libraryReadEpoch = useRef(0);
  const libraryReadAbort = useRef<AbortController>();
  const [libraryScopeSessionId, setLibraryScopeSessionId] = useState<string>();
  const [feedbackFocus, setFeedbackFocus] = useState<string>();
  const [boardSource, setBoardSource] = useState<OverviewSourceView>();
  const sourceAbort = useRef<AbortController>();
  const [error, setError] = useState<string>();
  const [warning, setWarning] = useState<string>();
  const [lifecycleNotice, setLifecycleNotice] = useState<string>();
  const [projectLifecycleResult, setProjectLifecycleResult] = useState<
    Pick<ProjectLifecycleActionResult, "stage" | "sessions"> | undefined
  >();
  const [referenceRefresh, setReferenceRefresh] = useState<{
    readonly detail: ProjectDetail;
    readonly epoch?: number;
    readonly navigationId?: number;
    readonly executionSessionId?: ProjectSessionRecord["id"] | undefined;
  }>();
  const viewEpoch = useRef(0);
  const handledNavigation = useRef<ProjectPanelNavigation["id"]>();
  const sourceRequest = useRef(0);
  const focusView = useRef({ screen, visibleConversation, showExecutionList, overviewOpen, epoch: viewEpoch.current, navigationId: projectNavigation?.id });
  focusView.current = { screen, visibleConversation, showExecutionList, overviewOpen, epoch: viewEpoch.current, navigationId: projectNavigation?.id };

  const unavailableDisposition = projectDetail?.unavailableSources
    .map(source => `${source.hostSessionId}:${source.sourceRevision}`).join("|") ?? "";
  useEffect(() => {
    if (projectDetail === undefined || projectDetail.unavailableSources.length === 0) return;
    const unavailable = new Map(projectDetail.unavailableSources.map(source => [source.hostSessionId, source]));
    // Already rendered reads are scrubbed too; a late request cannot repopulate them.
    sourceRequest.current++;
    sourceAbort.current?.abort();
    setSourcePanel(current => current === undefined ? current : { ...current, loading: false,
      reads: current.reads.map(read => {
        const retired = unavailable.get(read.source.hostSessionId);
        return retired === undefined ? read : { source: read.source, value: {
          resolved: false, hostSessionId: read.source.hostSessionId, items: [], reason: unavailableSourceText(retired.kind, t),
        } };
      }) });
    setHistoryReadPanel(current => {
      const retired = current === undefined ? undefined : unavailable.get(current.source.hostSessionId);
      return current === undefined || retired === undefined ? current : { source: current.source,
        result: { status: "unavailable", found: false, items: [], limitations: [], reason: unavailableSourceText(retired.kind, t) } };
    });
  }, [unavailableDisposition]);

  const usageProjectId = screen.kind === "project" && projectDetail?.project.id === screen.projectId
    ? screen.projectId : undefined;
  const usageMembership = projectDetail?.sessions.map(item => `${item.id}:${projectCarrierIdentity(item)}:${item.carriers?.map(carrier => `${carrier.hostSessionId}:${carrier.sessionCreatedAt ?? "unknown"}`).join(",") ?? ""}`).join("|");
  const usageScope = JSON.stringify([usageProjectId, usageMembership, unavailableDisposition]);
  const titleUsage = titleUsageRead?.scope === usageScope ? titleUsageRead.value : undefined;
  const titleUsageLoading = usageProjectId !== undefined && (titleUsageRead?.scope !== usageScope || titleUsageRead.loading);
  const titleUsageError = titleUsageRead?.scope === usageScope && titleUsageRead.failed;
  useEffect(() => {
    let active = true;
    let reading = false;
    let refreshPending = false;
    let abort: AbortController | undefined;
    if (usageProjectId === undefined) return;
    const refresh = (): void => {
      // Finish this scope's admitted read. Later notifications request one fresh
      // pass rather than repeatedly canceling it before any result can render.
      if (reading) { refreshPending = true; return; }
      reading = true;
      refreshPending = false;
      abort = new AbortController();
      // 标题始终查询该项目全部历史；设置页筛选不参与此结果。
      setTitleUsageRead(previous => ({ scope: usageScope, loading: true, failed: false,
        ...(previous?.scope === usageScope && previous.value !== undefined ? { value: previous.value } : {}) }));
      void usageRef.current.query({ projectId: usageProjectId }, abort.signal).then(value => {
        if (!active) return;
        if (value.projectId !== usageProjectId || value.query.projectId !== usageProjectId
          || value.query.sessionId !== undefined || value.query.model !== undefined
          || value.query.from !== undefined || value.query.to !== undefined) throw new Error(t("p5.panel.titleUsageScopeMismatch"));
        setTitleUsageRead({ scope: usageScope, value, loading: false, failed: false });
      }).catch(() => { if (active) setTitleUsageRead(previous => ({ scope: usageScope, loading: false, failed: true,
        ...(previous?.scope === usageScope && previous.value !== undefined ? { value: previous.value } : {}) })); })
        .finally(() => { reading = false; if (active && refreshPending) refresh(); });
    };
    refresh();
    const unsubscribe = usageRef.current.subscribe?.(usageProjectId, refresh);
    return () => { active = false; abort?.abort(); unsubscribe?.(); };
  }, [usageProjectId, usageScope]);

  useEffect(() => {
    if (conversationFileRequest === undefined || screen.kind !== "project" || conversationFileRequest.projectId !== screen.projectId || conversationFileRequest.signal.aborted) return;
    setConversationReading({ request: conversationFileRequest, scrollTop: 0, offset: conversationFileRequest.line ?? 1 });
    setOverviewOpen(true); setSideView("conversationFile");
  }, [conversationFileRequest]);

  const resetSide = (): void => {
    libraryReadEpoch.current++; libraryReadAbort.current?.abort();
    libraryPositions.current.clear();
    setConversationReading(undefined); setReadingHints({}); setSourceReadingReturn(undefined); setLibraryScopeSessionId(undefined);
    libraryOrigin.current = { kind: "library" };
    setScheduleWindow(undefined);
    setScheduleCloseConfirmation(false);
    setSourceReturnView("sessions");
    setLibraryReturnView("sessions");
    setRenameDraft(undefined); setRenameNotice(""); setRenameBusy(false);
    setSideView("sessions");
    setVisibleConversation("main"); setShowExecutionList(false); executionListFocus.current = false;
    setFeedbackFocus(undefined);
    setExecutionCreateOrigin(undefined);
    sourceRequest.current++;
    setSourcePanel(undefined);
    setHistoryReadPanel(undefined);
    setLibraryReading(undefined);
    setBoardSource(undefined);
    sourceAbort.current?.abort();
    setDeletionConfirmation(undefined);
    setArchiveConfirmation(undefined);
  };

  const refreshList = async (): Promise<void> => {
    const owner = listProjects;
    if (listReadOwner.current !== owner) return;
    const epoch = ++viewEpoch.current;
    setBusy(true);
    setError(undefined);
    setWarning(undefined); setLifecycleNotice(undefined); setProjectLifecycleResult(undefined);
    setScreen({ kind: "list" });
    setListRead(current => ({ owner, request: epoch, loading: true, failed: current.owner === owner && current.failed,
      ...(current.owner === owner && current.projects !== undefined ? { projects: current.projects } : {}) }));
    try {
      const projects = await owner();
      if (viewEpoch.current !== epoch || listReadOwner.current !== owner) return;
      setListRead({ owner, request: epoch, projects, loading: false, failed: false });
    } catch {
      if (viewEpoch.current !== epoch || listReadOwner.current !== owner) return;
      setListRead(current => current.owner !== owner || current.request !== epoch ? current : { ...current, loading: false, failed: true });
    } finally {
      // Superseded reads release only their own pending marker, never a newer
      // list request or the operation/navigation that superseded them.
      if (listReadOwner.current === owner) setListRead(current => current.owner !== owner || current.request !== epoch || !current.loading
        ? current : { ...current, loading: false });
      if (viewEpoch.current === epoch && listReadOwner.current === owner) setBusy(false);
    }
  };

  useEffect(() => {
    void refreshList();
  }, [listProjects]);
  useEffect(() => {
    if (projectDetail === undefined) return;
    setListRead(current => current.owner !== listProjects || !current.projects?.some(project => project.id === projectDetail.project.id && project !== projectDetail.project)
      ? current : { ...current, projects: current.projects.map(project => project.id === projectDetail.project.id ? projectDetail.project : project) });
  }, [projectDetail, listProjects]);
  useEffect(
    () => () => {
      viewEpoch.current++;
      sourceRequest.current++;
      libraryReadEpoch.current++;
      sourceAbort.current?.abort();
      libraryReadAbort.current?.abort();
      lifecycleOperation.current = undefined;
      release();
    },
    [release],
  );

  useEffect(() => {
    // A controller release withdraws detail first. Drop the old screen before a later
    // same-project snapshot can make its retired references renderable again.
    if (projectDetail === undefined && screen.kind === "project") {
      setReferenceRefresh(undefined); setScreen({ kind: "loading" });
    }
  }, [projectDetail, screen.kind]);

  useEffect(() => {
    if (
      projectNavigation === undefined ||
      handledNavigation.current === projectNavigation.id
    )
      return;
    handledNavigation.current = projectNavigation.id;
    const epoch = ++viewEpoch.current;
    const readingCurrentProject = projectNavigation.target.source !== undefined
      && screen.kind === "project" && screen.projectId === projectNavigation.detail.project.id;
    if (!readingCurrentProject) {
      setReferenceRefresh({ detail: projectNavigation.detail, executionSessionId: projectNavigation.executionSessionId,
        epoch, navigationId: projectNavigation.id });
      setScreen({ kind: "loading" });
    }
    setVisibleConversation(projectNavigation.target.kind); setShowExecutionList(false); executionListFocus.current = false;
    setOverviewOpen(projectNavigation.target.source !== undefined);
    setSideView(projectNavigation.target.source !== undefined ? "historyRead" : "sessions");
    setFeedbackFocus(projectNavigation.target.source === undefined && projectNavigation.target.focusEventSeq === undefined
      ? projectNavigation.target.sessionId : undefined);
    setExecutionCreateOrigin(undefined);
    setSettingsWindow(undefined);
    sourceRequest.current++;
    setSourcePanel(undefined);
    setHistoryReadPanel(undefined);
    setLibraryReading(undefined);
    setBoardSource(undefined);
    sourceAbort.current?.abort();
    setBusy(false);
    setError(undefined);
    setWarning(undefined); setLifecycleNotice(undefined); setProjectLifecycleResult(undefined);
  }, [projectNavigation]);

  useEffect(() => {
    if (referenceRefresh === undefined || screen.kind !== "loading") return;
    if (referenceRefresh.epoch !== undefined && referenceRefresh.epoch !== viewEpoch.current
      || referenceRefresh.navigationId !== undefined && referenceRefresh.navigationId !== projectNavigation?.id) {
      setReferenceRefresh(undefined); return;
    }
    // 此时前一帧的 SessionProvider 已卸载，才能安全替换只读引用。
    setReferenceRefresh(undefined);
    const detail = projectDetail?.project.id === referenceRefresh.detail.project.id ? projectDetail : referenceRefresh.detail;
    if (detail.project.sourceLifecycle !== undefined || detail.unavailableSources.some(source =>
      detail.sessions.some(session => session.role === "main" && session.hostSessionId === source.hostSessionId))) {
      setScreen({ kind: "deletion", projectId: detail.project.id }); return;
    }
    const references = activate(detail, referenceRefresh.executionSessionId);
    const epoch = viewEpoch.current;
    const present = (): void => {
      if (epoch !== viewEpoch.current) return;
      setScreen({ kind: "project", projectId: detail.project.id, references });
    };
    if (references.inputReady === undefined) present();
    else void references.inputReady.then(present, () => {
      if (epoch !== viewEpoch.current) return;
      setError(t("project.handoff.error"));
      present();
    });
  }, [activate, referenceRefresh, screen.kind, projectNavigation, projectDetail]);

  useEffect(() => {
    if (
      referenceRefresh !== undefined ||
      screen.kind !== "project" ||
      projectDetail?.project.id !== screen.projectId
    )
      return;
    if (projectDetail.project.sourceLifecycle !== undefined) {
      setSettingsWindow(undefined);
      resetSide();
      setScreen({ kind: "deletion", projectId: screen.projectId });
      return;
    }
    const unavailable = new Set(projectDetail.unavailableSources.map(source => source.hostSessionId));
    if (unavailable.has(screen.references.main.reference.sessionId)) {
      setScreen({ kind: "deletion", projectId: screen.projectId }); return;
    }
    const execution = projectDetail.sessions.find(
      (item) => item.id === screen.references.executionSessionId && !unavailable.has(item.hostSessionId),
    );
    const main = projectDetail.sessions.find(item => item.id === projectDetail.project.mainSessionId && item.role === "main");
    if (main === undefined) return;
    const projectReadOnly = projectDetail.project.archived || projectDetail.pendingRestores?.some(item => item.scope === "project") === true;
    const mainReadOnly = projectReadOnly || projectDetail.modelInitializationErrors?.some(item => item.hostSessionId === main.hostSessionId) === true;
    const executionReadOnly = projectReadOnly || execution?.archived === true
       || projectDetail.modelInitializationErrors?.some(item => item.hostSessionId === execution?.hostSessionId) === true
      || projectDetail.pendingRestores?.some(item => item.scope === "session" && item.sessionId === execution?.id) === true;
    if (
      screen.references.mainIdentity === projectCarrierIdentity(main) &&
      (screen.references.main.readOnly === true) === mainReadOnly &&
      (screen.references.execution === undefined ||
        execution !== undefined && screen.references.executionIdentity === projectCarrierIdentity(execution) && (screen.references.execution.readOnly === true) === executionReadOnly)
    )
      return;
    const focused = document.activeElement;
    const target = !(focused instanceof HTMLElement) || focused === document.body || focused === document.documentElement ? undefined
      : focused.getAttribute("contenteditable") === "true" && mainRegion.current?.contains(focused) === true ? "main"
      : focused.getAttribute("contenteditable") === "true" && executionRegion.current?.contains(focused) === true ? "execution" : focused;
    restoreFocus.current = target === undefined ? undefined : {
      target, references: screen.references, epoch: viewEpoch.current,
      projectId: screen.projectId, navigationId: projectNavigation?.id,
    };
    // 外部 watch 更新也先让旧 Provider 卸载，不能直接释放正在渲染的引用。
    setReferenceRefresh({
      detail: projectDetail,
      ...(execution === undefined ? {} : { executionSessionId: execution.id }),
    });
    if (execution === undefined && screen.references.execution !== undefined) {
      setSideView("sessions"); setVisibleConversation("main");
    }
    setScreen({ kind: "loading" });
  }, [projectDetail, referenceRefresh, screen, projectNavigation?.id]);

  // 先提交无聊天的结果视图，卸载旧 Provider 后才调用可能使来源失效的删除动作。
  useEffect(() => {
    if (pendingDeletion === undefined) return;
    const target = pendingDeletion;
    const epoch = viewEpoch.current;
    const operation = lifecycleOperation.current;
    setPendingDeletion(undefined);
    void (async () => {
      try {
        const result = target.kind === "project"
          ? await deleteProject({ projectId: target.projectId, expectedRevision: target.expectedRevision })
          : await deleteExecutionSession({ projectId: target.projectId, sessionId: target.sessionId, expectedRevision: target.expectedRevision });
        if (viewEpoch.current !== epoch) return;
        if (result.detail.project.sourceLifecycle?.kind === "deleted") {
          setListRead(current => current.owner !== listProjects || current.projects === undefined ? current
            : { ...current, projects: current.projects.filter(project => project.id !== target.projectId) });
          release();
          await refreshList();
          setLifecycleNotice(result.message);
          return;
        }
        watchProject(result.detail);
        if (result.detail.project.sourceLifecycle === undefined) {
          setScreen({ kind: "project", projectId: target.projectId, references: activate(result.detail) });
          setOverviewOpen(target.kind === "execution");
          setSideView("sessions");
        }
        if (result.kind === "deleted") setLifecycleNotice(result.message);
        else setError(result.message);
      } catch (error: unknown) {
        if (viewEpoch.current === epoch) setError(error instanceof Error ? error.message : t("deletion.error"));
      } finally {
        finishLifecycle(operation);
      }
    })();
  }, [pendingDeletion]);

  useEffect(() => {
    if (projectDetail?.project.sourceLifecycle?.kind !== "deleted" || lifecycleBusy ||
      (screen.kind !== "project" && screen.kind !== "deletion") || screen.projectId !== projectDetail.project.id) return;
    release();
    resetSide();
    setSettingsWindow(undefined);
    void refreshList();
  }, [projectDetail, lifecycleBusy, screen]);

  const finishLifecycle = (operation: symbol | undefined): void => {
    if (operation === undefined || lifecycleOperation.current !== operation) return;
    lifecycleOperation.current = undefined;
    setLifecycleBusy(false);
  };

  const beginDeletion = (target: DeletionTarget): void => {
    if (lifecycleOperation.current !== undefined) return;
    lifecycleOperation.current = Symbol();
    setLifecycleBusy(true);
    setError(undefined);
    setLifecycleNotice(undefined);
    setProjectLifecycleResult(undefined);
    setSettingsWindow(undefined);
    resetSide();
    setReferenceRefresh(undefined);
    setScreen({ kind: "deletion", projectId: target.projectId });
    setPendingDeletion(target);
  };

  const continueExecutionDeletion = (result: ProjectSessionDeletionResult): void => {
    beginDeletion({ kind: "execution", projectId: result.projectId, sessionId: result.id,
      name: result.title, expectedRevision: result.revision });
  };

  const saveExecutionName = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (renameDraft === undefined || renameBusy) return;
    const title = renameDraft.title.trim();
    if (title === "") { setRenameNotice(t("p5.panel.executionNameRequired")); return; }
    const epoch = viewEpoch.current;
    setRenameBusy(true); setRenameNotice("");
    try {
      const result = await renameExecutionSession({ ...renameDraft, title });
      if (epoch !== viewEpoch.current) return;
      watchProject(result.detail);
      setRenameNotice(result.message);
      if (result.kind === "renamed") { setRenameDraft(undefined); setRenameNotice(""); setLifecycleNotice(result.message); }
      else {
        const current = result.detail.sessions.find(item => item.id === renameDraft.sessionId);
        if (current !== undefined) setRenameDraft(previous => previous === undefined ? undefined : { ...previous, expectedRevision: current.revision });
      }
    } catch (error) {
      if (epoch === viewEpoch.current) setRenameNotice(error instanceof Error ? error.message : t("p5.panel.nameSaveUnconfirmed"));
    } finally { if (epoch === viewEpoch.current) setRenameBusy(false); }
  };

  const changeLifecycle = async (action: 'archive' | 'restore', targetSessionId?: string): Promise<void> => {
    if (screen.kind !== 'project' || projectDetail?.project.id !== screen.projectId || lifecycleOperation.current !== undefined) return;
    const sessionId = targetSessionId ?? screen.references.executionSessionId;
    if (sessionId === undefined || !projectDetail.sessions.some(session => session.id === sessionId && session.role === "execution")) return;
    const epoch = viewEpoch.current;
    const operation = Symbol();
    lifecycleOperation.current = operation;
    setLifecycleBusy(true); setError(undefined); setWarning(undefined); setLifecycleNotice(undefined); setProjectLifecycleResult(undefined);
    try {
      const result = await executionLifecycle({ projectId: screen.projectId, sessionId, action });
      if (viewEpoch.current !== epoch) return;
      watchProject(result.detail);
      // The existing detail effect refreshes a changed visible binding. A list action
      // must not select its target or replace either unrelated conversation owner.
      if (result.kind === 'failed') setError(result.message); else setLifecycleNotice(result.message);
    } catch (error) {
      if (viewEpoch.current === epoch) setError(error instanceof Error ? error.message : t("p5.panel.stateUnreadableCompletionUnconfirmed"));
    } finally { finishLifecycle(operation); }
  };

  const changeProjectLifecycle = async (action: 'archive' | 'restore', targetDetail?: ProjectDetail): Promise<void> => {
    const projectId = targetDetail?.project.id ?? (screen.kind === "project" ? screen.projectId : undefined);
    if (projectId === undefined || (targetDetail ?? projectDetail)?.project.id !== projectId || lifecycleOperation.current !== undefined) return;
    const epoch = viewEpoch.current;
    const operation = Symbol();
    lifecycleOperation.current = operation;
    setLifecycleBusy(true); setError(undefined); setWarning(undefined); setLifecycleNotice(undefined); setProjectLifecycleResult(undefined);
    try {
      const result = await projectLifecycle({ projectId, action });
      if (viewEpoch.current !== epoch) return;
      watchProject(result.detail);
      if (screen.kind === "project" && (result.kind === "archived" || result.kind === "restored")) {
        // 先卸载旧会话视图，再替换 normal/readonly 引用，避免已释放引用短暂留在 Provider 中。
        setReferenceRefresh({
          detail: result.detail,
          executionSessionId: screen.references.executionSessionId,
        });
        setScreen({ kind: "loading" });
      }
      setExecutionCreateOrigin(undefined);
      setProjectLifecycleResult({ stage: result.stage, sessions: result.sessions });
      if (result.kind === 'failed') setError(result.message); else setLifecycleNotice(result.message);
    } catch (error) {
      if (viewEpoch.current === epoch) setError(error instanceof Error ? error.message : t("p5.panel.projectStateUnreadableCompletionUnconfirmed"));
    } finally {
      finishLifecycle(operation);
    }
  };

  const openProject = async (projectId: ProjectRecord["id"], executionSessionId?: string): Promise<void> => {
    const epoch = ++viewEpoch.current;
    setBusy(true);
    setError(undefined);
    setWarning(undefined); setLifecycleNotice(undefined); setProjectLifecycleResult(undefined);
    try {
      const detail = await getProject(projectId);
      if (viewEpoch.current !== epoch) return;
      watchProject(detail);
      if (detail.project.sourceLifecycle !== undefined) {
        setScreen({ kind: "deletion", projectId });
        resetSide();
        setSettingsWindow(undefined);
        return;
      }
      setScreen({
        kind: "project",
        projectId: detail.project.id,
        references: activate(detail, executionSessionId),
      });
      setOverviewOpen(false);
      resetSide();
      setVisibleConversation(executionSessionId === undefined ? "main" : "execution");
      setSettingsWindow(undefined);
    } catch {
      if (viewEpoch.current === epoch) setError(t("project.error"));
    } finally {
      if (viewEpoch.current === epoch) setBusy(false);
    }
  };

  const openProjectListAction = async (project: ProjectRecord, action: "rename" | "archive" | "restore" | "delete"): Promise<void> => {
    if (busy || lifecycleOperation.current !== undefined) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const epoch = ++viewEpoch.current;
    setBusy(true); setError(undefined); setLifecycleNotice(undefined); setProjectLifecycleResult(undefined);
    try {
      // Reading and watching the real object supplies current revisions without
      // activating any conversation, restoring work, or consuming pending work.
      const detail = await getProject(project.id);
      if (epoch !== viewEpoch.current || opener?.isConnected === false) return;
      if (detail.project.id !== project.id || detail.project.sourceLifecycle !== undefined) throw new Error(t("project.error"));
      watchProject(detail);
      setListActionProjectId(project.id);
      if (action === "rename") setSettingsWindow({ page: "general", nameEditing: true });
      else if (action === "delete") setDeletionConfirmation({ kind: "project", projectId: detail.project.id,
        name: detail.project.name, expectedRevision: detail.project.revision });
      else if (action === "restore") {
        void changeProjectLifecycle("restore", detail);
      } else if (detail.pendingRestores?.some(item => item.scope === "project")) setError(t("p3.history.projectRestoreRequired"));
      else setArchiveConfirmation({ kind: "project", projectId: detail.project.id, name: detail.project.name });
    } catch (error) {
      if (epoch === viewEpoch.current) setError(error instanceof Error ? error.message : t("project.error"));
    } finally { if (epoch === viewEpoch.current) setBusy(false); }
  };

  const createProjectFromForm = async (input: {
    readonly name: string;
    readonly workspace: string;
  }): Promise<void> => {
    if (input.name.trim() === "") {
      setError(t("create.error"));
      return;
    }
    const epoch = ++viewEpoch.current;
    setBusy(true);
    setError(undefined);
    setWarning(undefined); setLifecycleNotice(undefined); setProjectLifecycleResult(undefined);
    let savedProject: ProjectRecord | undefined;
    let creationWarning: string | undefined;
    try {
      const created = await createProject({
        name: input.name.trim(),
        ...(input.workspace.trim() === ""
          ? {}
          : { workspace: { path: input.workspace.trim() } }),
      });
      if (viewEpoch.current !== epoch) return;
      const detail = created.detail;
      savedProject = detail.project;
      creationWarning = created.warning?.trim() === "" ? undefined : created.warning;
      // RPC success may be partial: preserve its saved object and exact reason before native acquisition can fail.
      setListRead(current => current.owner !== listProjects ? current : { ...current,
        projects: [detail.project, ...(current.projects ?? []).filter(project => project.id !== detail.project.id)],
      });
      setWarning(creationWarning);
      setShowCreate(false);
      if (confirmedCreatedMain(detail) === undefined) {
        if (creationWarning === undefined) setWarning(t('create.mainUnavailable'));
        return;
      }
      const references = activate(detail);
      watchProject(detail);
      setScreen({ kind: "project", projectId: detail.project.id, references });
      setOverviewOpen(false);
      resetSide();
      setSettingsWindow(undefined);
    } catch {
      if (viewEpoch.current === epoch) {
        if (savedProject === undefined) setError(t("create.error"));
        else setWarning(creationWarning ?? t('create.mainUnavailable'));
      }
    } finally {
      if (viewEpoch.current === epoch) setBusy(false);
    }
  };

  const returnToList = (): void => {
    viewEpoch.current++;
    release();
    setReferenceRefresh(undefined);
    setScreen({ kind: "loading" });
    setWarning(undefined); setLifecycleNotice(undefined); setProjectLifecycleResult(undefined);
    setOverviewOpen(false);
    resetSide();
    setSettingsWindow(undefined);
    void refreshList();
  };

  const selectExecution = (
    detail: ProjectDetail,
    session: ProjectSessionRecord,
  ): void => {
    if (screen.kind === "project" && screen.projectId === detail.project.id && screen.references.executionSessionId === session.id) {
      setVisibleConversation("execution"); setShowExecutionList(false); setOverviewOpen(false); setSideView("sessions");
      setSettingsWindow(undefined); setFeedbackFocus(session.id); return;
    }
    viewEpoch.current++;
    setRenameDraft(undefined); setRenameNotice(""); setRenameBusy(false);
    try {
      watchProject(detail);
      setScreen({
        kind: "project",
        projectId: detail.project.id,
        references: activate(detail, session.id),
      });
      setVisibleConversation("execution"); setShowExecutionList(false);
      setOverviewOpen(false);
      setSideView("sessions");
      setFeedbackFocus(session.id);
      setExecutionCreateOrigin(undefined);
      setSettingsWindow(undefined);
      setError(undefined);
    } catch {
      setError(t("sessions.unavailable"));
    }
  };

  const createExecution = async (title: string, workspace?: { readonly path: string } | null): Promise<void> => {
    if (
      screen.kind !== "project" ||
      projectDetail?.project.id !== screen.projectId ||
      projectDetail.project.archived
    )
      return;
    const epoch = ++viewEpoch.current;
    setBusy(true);
    setError(undefined);
    try {
      const detail = await createExecutionSession({
        projectId: projectDetail.project.id,
        ...(title.trim() === "" ? {} : { title: title.trim() }),
        ...(workspace === undefined ? {} : { workspace }),
      });
      if (viewEpoch.current !== epoch) return;
      const session = lastExecutionSession(detail);
      if (session === undefined)
        throw new Error("Projects createSession returned no execution session");
      watchProject(detail);
      setScreen({
        kind: "project",
        projectId: detail.project.id,
        references: activate(detail, session.id),
      });
      setVisibleConversation("execution"); setShowExecutionList(false);
      setOverviewOpen(false);
      setSideView("sessions");
      setFeedbackFocus(session.id);
      setExecutionCreateOrigin(undefined);
      setSettingsWindow(undefined);
    } catch {
      if (viewEpoch.current === epoch) setError(t("sessions.new.error"));
    } finally {
      if (viewEpoch.current === epoch) setBusy(false);
    }
  };

  const openSources = async (
    sources: readonly NativeProjectSource[],
    returnView: SideView = visibleConversation === "execution" && !overviewOpen ? "chat" : sideView,
    opener?: HTMLElement,
  ): Promise<void> => {
    if (
      screen.kind !== "project" ||
      projectDetail?.project.id !== screen.projectId
    )
      return;
    if (sideView !== "sources") {
      const target = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
      sideOpeners.current.sources = target;
      sideFocusRequest.current = { view: "sources" };
    }
    if (returnView !== "libraryFile") setSourceReadingReturn(undefined);
    const request = ++sourceRequest.current;
    setSourcePanel({
      sources,
      reads: [],
      loading: sources.length > 0,
      failed: false,
    });
    setHistoryReadPanel(undefined);
    setLibraryReading(undefined);
    setBoardSource(undefined);
    sourceAbort.current?.abort();
    const abort = new AbortController();
    sourceAbort.current = abort;
    setOverviewOpen(true);
    setSourceReturnView(returnView);
    setSideView("sources");
    if (sources.length === 0) return;
    const reads = await Promise.allSettled(
      sources.map(async (source) => ({
        source,
        value: await readProjectSource(projectDetail.project.id, source, abort.signal),
      })),
    );
    if (sourceRequest.current !== request || abort.signal.aborted) return;
    setSourcePanel({
      sources,
      reads: reads
        .filter(
          (
            result,
          ): result is PromiseFulfilledResult<{
            readonly source: NativeProjectSource;
            readonly value: ProjectNativeSourceRead;
          }> => result.status === "fulfilled",
        )
        .map((result) => result.value),
      loading: false,
      failed: reads.some((result) => result.status === "rejected"),
    });
  };

  const openLibraryReading = async (selection: LibrarySelection, origin: ReadingOrigin = libraryOrigin.current, ownerSessionId?: string, opener?: HTMLElement): Promise<void> => {
    if (screen.kind !== "project" || projectDetail?.project.id !== screen.projectId) return;
    const session = projectDetail.sessions.find(item => item.id === (ownerSessionId ?? libraryScopeSessionId))
      ?? projectDetail.sessions.find(item => item.role === "main");
    if (session === undefined) return;
    if (selection !== libraryReading?.selection) {
      libraryOpener.current = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
      libraryFocusSource.current = undefined;
    }
    libraryOrigin.current = origin;
    setLibraryScopeSessionId(session.id);
    const epoch = ++libraryReadEpoch.current;
    libraryReadAbort.current?.abort();
    const abort = new AbortController(); libraryReadAbort.current = abort;
    const scrollTop = libraryPositions.current.get(libraryPositionKey(screen.projectId, session.id, selection)) ?? 0;
    setLibraryReading({ selection, sessionId: session.id, origin, loading: true, scrollTop });
    setOverviewOpen(true); setSideView("libraryFile");
    try {
      const value = await libraryActions.open({ projectId: screen.projectId, sessionId: session.id, location: selection.location }, abort.signal);
      if (epoch === libraryReadEpoch.current && !abort.signal.aborted)
        setLibraryReading({ selection: { ...selection, name: value.name }, sessionId: session.id, origin, value, scrollTop });
    } catch (error) {
      if (epoch === libraryReadEpoch.current && !abort.signal.aborted)
        setLibraryReading({ selection, sessionId: session.id, origin, error: error instanceof Error ? error.message : String(error), scrollTop });
    }
  };

  const restoreLibraryReading = (reading: LibraryReading): void => {
    libraryReadEpoch.current++; libraryReadAbort.current?.abort();
    libraryOrigin.current = reading.origin; setLibraryScopeSessionId(reading.sessionId);
    setLibraryReading(reading); setOverviewOpen(true); setSideView("libraryFile");
  };

  const returnReadingToWork = (reading: LibraryReading): void => {
    if (screen.kind !== "project" || projectDetail?.project.id !== screen.projectId) return;
    if (reading.origin.kind === "board") { setSideView("board"); return; }
    if (reading.origin.kind !== "session") { setSideView("library"); return; }
    const id = reading.origin.sessionId;
    const session = projectDetail.sessions.find(item => item.id === id);
    if (session === undefined) { setError(t("p5.panel.originalSessionUnavailable")); return; }
    setReadingHints(previous => ({ ...previous, [id]: { reading, mode: "feedback" } }));
    if (session.role === "execution") selectExecution(projectDetail, session);
    else { setSideView("sessions"); setOverviewOpen(false); setVisibleConversation("main"); }
    setFeedbackFocus(id);
  };

  useEffect(() => {
    if (screen.kind !== "project") {
      if (screen.kind !== "loading") restoreFocus.current = undefined;
      return;
    }
    const references = screen.references;
    const epoch = viewEpoch.current;
    const navigationId = projectNavigation?.id;
    const currentView = (): boolean => {
      const view = focusView.current;
      return view.screen.kind === "project" && view.screen.references === references
        && viewEpoch.current === epoch && view.epoch === epoch && view.navigationId === navigationId;
    };
    const restoration = restoreFocus.current;
    const validRestoration = restoration !== undefined && references !== restoration.references
      && restoration.epoch === epoch && restoration.projectId === screen.projectId && restoration.navigationId === navigationId;
    if (restoration !== undefined && !validRestoration && references !== restoration.references) restoreFocus.current = undefined;
    if (feedbackFocus === undefined && !validRestoration) return;
    // Restoring an external control must follow both native children, whose mount focus may otherwise win.
    if (feedbackFocus === undefined && validRestoration && typeof restoration.target !== "string") {
      if (conversationCommits.main !== references || references.execution !== undefined && conversationCommits.execution !== references) return;
      if (currentView() && restoration.target.isConnected && restoration.target.closest("[hidden], [inert]") === null) {
        restoration.target.focus({ preventScroll: true });
        if (restoreFocus.current === restoration) restoreFocus.current = undefined;
      }
      return;
    }
    const session = feedbackFocus === undefined ? undefined : projectDetail?.project.id === screen.projectId
      ? projectDetail.sessions.find(item => item.id === feedbackFocus) : undefined;
    const role = feedbackFocus === undefined && validRestoration && typeof restoration.target === "string"
      ? restoration.target : session?.role;
    if (role === undefined || overviewOpen || role !== visibleConversation || role === "execution" && showExecutionList) return;
    const reference = role === "main" ? references.main : references.execution;
    if (reference === undefined || reference.readOnly) {
      if (reference?.readOnly && feedbackFocus !== undefined && currentView()) {
        (role === "main" ? mainRegion.current : executionRegion.current)?.focus({ preventScroll: true });
      }
      if (feedbackFocus !== undefined) setFeedbackFocus(undefined);
      else if (restoreFocus.current === restoration) restoreFocus.current = undefined;
      return;
    }
    if (role === "execution" && feedbackFocus !== undefined && references.executionSessionId !== feedbackFocus
      || conversationCommits[role] !== references) return;
    const region = role === "main" ? mainRegion.current : executionRegion.current;
    if (region === null) return;
    return observeConversationInput(region, () => currentView()
      && !focusView.current.overviewOpen && focusView.current.visibleConversation === role
      && !(role === "execution" && focusView.current.showExecutionList), () => {
      focusConversationInput?.(role);
      if (feedbackFocus !== undefined) {
        setFeedbackFocus(current => current === feedbackFocus ? undefined : current);
        // An explicit destination supersedes the preceding carrier's restoration request.
        restoreFocus.current = undefined;
      } else if (restoreFocus.current === restoration) restoreFocus.current = undefined;
    });
  }, [feedbackFocus, screen, projectDetail, projectNavigation?.id, visibleConversation, showExecutionList, overviewOpen, conversationCommits, focusConversationInput]);

  const locateSource = async (source: NativeProjectSource, read: { readonly items: readonly import("../source-types.ts").NativeProjectSourceItem[] }): Promise<void> => {
    if (screen.kind !== "project" || projectDetail?.project.id !== screen.projectId) return;
    const session = projectDetail.sessions.find(item => item.hostSessionId === source.hostSessionId || item.carriers?.some(carrier => carrier.hostSessionId === source.hostSessionId));
    if (session !== undefined && sourceReadingReturn !== undefined)
      setReadingHints(previous => ({ ...previous, [session.id]: { reading: sourceReadingReturn, mode: "source" } }));
    try { await locateProjectSource(screen.projectId, source, read); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };

  const returnConversationReading = async (reading: { readonly request: ProjectConversationFileRequest; readonly scrollTop: number; readonly offset: number }, feedback: boolean): Promise<void> => {
    if (reading.request.signal.aborted) { setError(t("p5.panel.readingContextEnded")); return; }
    try {
      if (feedback) setReadingHints(previous => ({ ...previous, [reading.request.sessionId]: { conversation: reading, mode: "feedback" } }));
      await returnToFileConversation(reading.request);
      // 反馈后的续读仍消费这份活跃请求；真实文件 owner 的 close 会使它失效。
      if (!feedback) dismissConversationFile(reading.request.id);
      if (feedback) setFeedbackFocus(reading.request.sessionId);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };

  const renderReadingHint = (sessionId: string): ReactNode => {
    const hint = readingHints[sessionId];
    if (hint === undefined) return null;
    const title = "reading" in hint ? hint.reading.selection.name : hint.conversation.request.path.replaceAll("\\", "/").split("/").at(-1) || hint.conversation.request.path;
    return <div className="dsh-projects__reading-context">
      <span>{hint.mode === "source" ? t("p5.panel.checkingSource") : t("p5.panel.aboutReadFile")}</span>
      <Button variant="ghost" size="sm" type="button" onClick={() => {
        if ("reading" in hint) restoreLibraryReading(hint.reading);
        else if (!hint.conversation.request.signal.aborted) { setConversationReading(hint.conversation); setOverviewOpen(true); setSideView("conversationFile"); }
        else setError(t("p5.panel.readingContextEnded"));
      }}>{title}</Button>
      <Button variant="ghost" size="sm" type="button" aria-label={t("p5.panel.hideReadingHint")} onClick={() => setReadingHints(previous => { const next = { ...previous }; delete next[sessionId]; return next; })}>{t("p5.common.hide")}</Button>
    </div>;
  };

  const navigateOverview = async (
    target: OverviewNavigation,
  ): Promise<void> => {
    if (
      screen.kind !== "project" ||
      projectDetail?.project.id !== screen.projectId
    )
      return;
    if (target.kind === "source") {
      const reference = target.reference;
      switch (reference.kind) {
        case "native":
          await openSources([reference.source]);
          return;
        case "library":
        case "memory": {
          const epoch = viewEpoch.current;
          const request = ++sourceRequest.current;
          sourceAbort.current?.abort();
          const abort = new AbortController(); sourceAbort.current = abort;
          try {
            if (reference.kind === 'library') {
              const session = projectDetail.sessions.find(item => item.role === 'main');
              if (session === undefined) throw new Error(t('project.library.sessionUnavailable'));
              await openLibraryReading({ location: reference.location, name: reference.location.kind === "project-file" ? reference.location.relativePath.split("/").at(-1) || reference.location.relativePath : t("p5.panel.referencedFile") }, { kind: "board" }, session.id);
              if (epoch !== viewEpoch.current || request !== sourceRequest.current) return;
            } else {
              const value = await overviewSource(projectDetail.project.id, reference);
              if (epoch !== viewEpoch.current || request !== sourceRequest.current) return;
              setBoardSource(value); setSideView('boardSource');
            }
            setOverviewOpen(true);
          } catch (error) {
            if (epoch === viewEpoch.current && request === sourceRequest.current && !abort.signal.aborted)
              setError(error instanceof Error ? error.message : String(error));
          }
          return;
        }
        case "session": {
          const session = projectDetail.sessions.find(
            (item) => item.id === reference.id,
          );
          if (session?.role === "execution")
            selectExecution(projectDetail, session);
          else if (session?.role === "main") {
      setVisibleConversation("main"); setOverviewOpen(false); setFeedbackFocus(session.id);
    }
          return;
        }
      }
    }
    const session = projectDetail.sessions.find(
      (item) => item.id === target.sessionId,
    );
    if (session?.role === "execution") selectExecution(projectDetail, session);
    else if (session?.role === "main") {
      setVisibleConversation("main"); setOverviewOpen(false); setFeedbackFocus(session.id);
    }
  };

  const readHistoryContext = async (
    projectId: string,
    source: NativeProjectSource,
    opener?: HTMLElement,
  ): Promise<void> => {
    const focusOpener = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
    setSourceReadingReturn(undefined);
    const epoch = viewEpoch.current;
    const request = ++sourceRequest.current;
    sourceAbort.current?.abort();
    const abort = new AbortController(); sourceAbort.current = abort;
    const result = await readHistory(projectId, { source, before: 1, after: 1 }, abort.signal);
    if (epoch !== viewEpoch.current || request !== sourceRequest.current) return;
    sideOpeners.current.historyRead = focusOpener;
    sideFocusRequest.current = { view: "historyRead" };
    setHistoryReadPanel({ source, result });
    setOverviewOpen(true);
    setSideView("historyRead");
  };

  useEffect(() => {
    if (projectNavigation === undefined) return;
    const source = projectNavigation.target.source;
    if (source === undefined || screen.kind !== "project"
      || screen.projectId !== projectNavigation.detail.project.id
      || handledHistoryNavigation.current === projectNavigation.id) return;
    handledHistoryNavigation.current = projectNavigation.id;
    const epoch = viewEpoch.current;
    const reading = readHistoryContext(screen.projectId, source);
    const request = sourceRequest.current, abort = sourceAbort.current;
    void reading.catch(() => {
      if (epoch === viewEpoch.current && request === sourceRequest.current
        && abort === sourceAbort.current && !abort?.signal.aborted) setError(t("project.history.error"));
    });
  }, [projectNavigation, screen]);

  const settingsActions = {
    updateProject, memoryActions, executionDefaultsActions, sessionInstructionsActions,
    projectInstructionsActions, settingsEnvironment, usageActions,
  };
  const operationDialogs = <>
    {deletionConfirmation !== undefined && <Modal open className="dsp-theme dsh-projects__confirmation"
      title={t("deletion.confirm.title", { name: deletionConfirmation.name })}
      closeLabel={t("deletion.cancel")} onClose={() => setDeletionConfirmation(undefined)}>
      {deletionConfirmation.kind === "project" && <p className="dsh-projects__deletion-summary">{t("p3.history.deletion.summary")}</p>}
      <DeletionConfirmation target={deletionConfirmation} t={t}
        onCancel={() => setDeletionConfirmation(undefined)} onConfirm={() => beginDeletion(deletionConfirmation)} />
    </Modal>}
    {archiveConfirmation !== undefined && archiveConfirmation.projectId === projectDetail?.project.id
      && (archiveConfirmation.kind === "project" || projectDetail.sessions.some(session => session.id === archiveConfirmation.sessionId && session.role === "execution"))
      && <Modal open className="dsh-projects__confirmation"
      title={t(archiveConfirmation.kind === "project" ? "project.archive.confirm.title" : "sessions.archive.confirm.title", { name: archiveConfirmation.name })}
      description={t(archiveConfirmation.kind === "project" ? "project.archive.confirm.description" : "sessions.archive.confirm.description")}
      closeLabel={t("deletion.cancel")} onClose={() => setArchiveConfirmation(undefined)}
      footer={<><Button variant="ghost" size="md" type="button" data-modal-autofocus onClick={() => setArchiveConfirmation(undefined)}>{t("deletion.cancel")}</Button>
        <Button variant="primary" size="md" type="button" disabled={lifecycleBusy} onClick={() => {
          const target = archiveConfirmation;
          setArchiveConfirmation(undefined);
          if (target.kind === "project") void changeProjectLifecycle("archive", projectDetail);
          else void changeLifecycle("archive", target.sessionId);
        }}>{t("archive.confirm.submit")}</Button></>} />}
    {renameDraft !== undefined && renameDraft.projectId === projectDetail?.project.id
      && projectDetail.sessions.some(session => session.id === renameDraft.sessionId && session.role === "execution")
      && <Modal open title={t("p5.panel.renameExecutionSession")} closeLabel={t("p5.panel.cancelRename")}
      onClose={() => { if (!renameBusy) { setRenameDraft(undefined); setRenameNotice(""); } }}>
      <form aria-label={t("p5.panel.renameExecutionSession")} className="dsp-form-section" onSubmit={event => { void saveExecutionName(event); }}>
        <label className="dsp-field">{t("p5.panel.executionSessionName")}<Input aria-label={t("p5.panel.executionSessionName")} data-modal-autofocus value={renameDraft.title} disabled={renameBusy}
          onChange={event => setRenameDraft(previous => previous === undefined ? undefined : { ...previous, title: event.target.value })} /></label>
        {renameNotice !== "" && <ErrorState inline title={renameNotice} />}
        <div className="dsh-projects__form-actions">
          <Button variant="ghost" size="md" type="button" disabled={renameBusy} onClick={() => { setRenameDraft(undefined); setRenameNotice(""); }}>{t("p5.panel.cancelRename")}</Button>
          <Button variant="primary" size="md" type="submit" disabled={renameBusy}>{renameBusy && <StateDot state="ongoing" />}{renameBusy ? t("p3.settings.saving") : t("p5.panel.saveSessionName")}</Button>
        </div>
      </form>
    </Modal>}
  </>;

  if (screen.kind === "loading" || screen.kind === "list" && currentListRead.loading && currentListRead.projects === undefined && !currentListRead.failed) {
    return (
      <main className="dsh-projects dsp-theme">
        <div className="dsh-projects__list-page">
          <LoadingState label={t("list.loading")} />
        </div>
      </main>
    );
  }

  if (screen.kind === "list") {
    return (
      <main className="dsh-projects dsp-theme">
        {operationDialogs}
        {settingsWindow !== undefined && projectDetail !== undefined && listActionProjectId === projectDetail.project.id && <ProjectSettings
          runtimeNotice={projectWatchInterruption?.projectId === projectDetail.project.id
            ? <ProjectUpdatesInterrupted value={projectWatchInterruption} t={t} /> : undefined}
          detail={projectDetail} translate={t} actions={settingsActions} initialPage={settingsWindow.page}
          initialNameEditing={settingsWindow.nameEditing} onClose={() => setSettingsWindow(undefined)}
          onOpenNativeModel={sessionId => { void openProject(projectDetail.project.id,
            projectDetail.sessions.find(session => session.id === sessionId)?.role === "execution" ? sessionId : undefined); }} />}
        <div className="dsh-projects__list-page">
          <div className="dsh-projects__list-column">
            <header className="dsh-projects__page-head">
              <div>
                <h1>{t("list.title")}</h1>
                <p className="dsh-projects__copy">{t("list.description")}</p>
              </div>
              <Button
                variant="primary"
                size="md"
                icon={<IconProjectAddOutlineRegular size={16} />}
                onClick={() => {
                  setShowCreate(true);
                }}
              >
                {t("create.open")}
              </Button>
            </header>
            {error !== undefined && !showCreate && <ErrorState title={error}
              {...(busy ? {} : { retry: () => { void refreshList(); } })} retryLabel={t("list.retry")} />}
            {warning !== undefined && <><Feedback key={warning} text={warning} tone="warning" onDone={() => {}} />
              <p className="dsh-projects__operation-result" role="alert"><StateDot state="warning" />{warning}</p></>}
            {lifecycleNotice !== undefined && <><Feedback key={lifecycleNotice} text={lifecycleNotice} tone="info" onDone={() => {}} />
              <p className="dsh-projects__operation-result" role="status">{lifecycleNotice}</p></>}
            {projectLifecycleResult !== undefined && <ProjectLifecycleReport t={t} result={projectLifecycleResult} />}
            {showCreate && (
              <CreateProjectForm
                t={t}
                busy={busy}
                error={error}
                pickWorkspaceDirectory={pickWorkspaceDirectory}
                onSubmit={(input) => {
                  void createProjectFromForm(input);
                }}
                onCancel={() => {
                  setShowCreate(false);
                }}
              />
            )}
            {busy && !showCreate && !currentListRead.loading && <LoadingState label={t("list.loading")} rows={1} />}
            <ProjectList
              projects={(currentListRead.projects ?? []).filter((project) => project.sourceLifecycle?.kind !== "deleted" &&
                (project.sourceLifecycle !== undefined || project.archived === showArchivedProjects) &&
                project.name.toLocaleLowerCase().includes(projectNameQuery.trim().toLocaleLowerCase()))}
              archived={showArchivedProjects}
              nameQuery={projectNameQuery}
              busy={busy || lifecycleBusy || renameBusy}
              loading={currentListRead.loading}
              readFailed={currentListRead.failed}
              hasSnapshot={currentListRead.projects !== undefined}
              onRetry={() => { void refreshList(); }}
              pendingRestoreProjectId={projectDetail?.pendingRestores?.some(item => item.scope === "project") ? projectDetail.project.id : undefined}
              onNameQuery={setProjectNameQuery}
              t={t}
              onArchiveFilter={setShowArchivedProjects}
              onOpen={(projectId) => {
                void openProject(projectId);
              }}
              onAction={(project, action) => { void openProjectListAction(project, action); }}
            />
          </div>
        </div>
      </main>
    );
  }

  if (
    projectDetail === undefined ||
    projectDetail.project.id !== screen.projectId
  ) {
    return (
      <main className="dsh-projects dsp-theme">
        <div className="dsh-projects__list-page">
          <LoadingState label={t("project.loading")} />
        </div>
      </main>
    );
  }

  const detail = projectDetail;
  if (screen.kind === "deletion" || detail.project.sourceLifecycle !== undefined) {
    return <main className="dsh-projects dsp-theme">
      <div className="dsh-projects__list-page"><div className="dsh-projects__list-column dsh-projects__deletion-page">
      <Button variant="ghost" size="sm"  type="button" onClick={returnToList}>{t("project.back")}</Button>
      <header className="dsh-projects__page-head"><div><p className="dsh-projects__eyebrow">{t("p5.panel.projectDeletionResults")}</p><h1>{detail.project.name}</h1></div></header>
      {error !== undefined && <ErrorState title={error} {...(lifecycleBusy ? {} : { retry: () => { void openProject(detail.project.id); } })} retryLabel={t("deletion.refresh")} />}
      {detail.project.sourceLifecycle === undefined ? lifecycleBusy ? <LoadingState label={t("deletion.processing")} rows={1} /> : <ErrorState title={t("deletion.error")} />
        : <ProjectDeletionResult project={detail.project} results={detail.deletionResults} t={t} busy={lifecycleBusy}
          onContinue={() => beginDeletion({ kind: "project", projectId: detail.project.id,
            name: detail.project.name, expectedRevision: detail.project.revision })} />}
      {!lifecycleBusy && <Button variant="ghost" size="sm"  type="button" onClick={() => { void openProject(detail.project.id); }}>{t("deletion.refresh")}</Button>}
      </div></div>
    </main>;
  }
  const selectedExecution =
    screen.references.executionSessionId === undefined
      ? undefined
      : detail.sessions.find(
          (session) => session.id === screen.references.executionSessionId,
        );
  const mainModelError = detail.modelInitializationErrors?.find(item => item.hostSessionId === screen.references.main.reference.sessionId);
  const executionModelError = detail.modelInitializationErrors?.find(item => item.hostSessionId === selectedExecution?.hostSessionId);
  const pendingProjectRestore = detail.pendingRestores?.some(item => item.scope === "project") === true;
  const pendingExecutionRestore = !pendingProjectRestore && detail.pendingRestores?.some(item =>
    item.scope === "session" && item.sessionId === selectedExecution?.id,
  ) === true;
  const librarySession = detail.sessions.find(session => session.id === libraryScopeSessionId)
    ?? detail.sessions.find(session => session.role === "main");
  const showExecutionChat = selectedExecution !== undefined && screen.references.execution !== undefined;
  const executionListVisible = visibleConversation === "execution" && (showExecutionList || !showExecutionChat);
  const executionPanelId = `${conversationTabsId}-${showExecutionList || !showExecutionChat ? "execution-list" : "execution"}-panel`;
  const splitConversations = showExecutionChat && !executionListVisible && workspaceSize.viewportWidth >= 1600 && workspaceSize.width >= 1184;
  const overviewMode = workspaceSize.viewportWidth < 1024 ? "fullscreen"
    : !showExecutionChat && workspaceSize.viewportWidth >= 1440 && workspaceSize.width >= 1160 ? "inline" : "overlay";
  const availableWidth = Math.max(0, workspaceSize.width);
  const overviewMinWidth = Math.min(280, availableWidth);
  const overviewMaxWidth = Math.min(availableWidth, Math.max(overviewMinWidth, Math.min(720, availableWidth - (overviewMode === "inline" ? 680 : 240))));
  const overviewWidth = Math.min(overviewMaxWidth, Math.max(overviewMinWidth, overviewPreferredWidth));
  const showAllExecutions = (): void => {
    setFeedbackFocus(undefined); restoreFocus.current = undefined;
    executionListFocus.current = true;
    setShowExecutionList(true); setVisibleConversation("execution"); setOverviewOpen(false);
  };
  const navigateConversation = (role: "main" | "execution"): void => {
    const showList = role === "execution" && !showExecutionChat;
    setShowExecutionList(showList); setVisibleConversation(role); setOverviewOpen(false);
    executionListFocus.current = showList && !conversationTabTraversal.current;
    const id = role === "main" ? detail.project.mainSessionId : selectedExecution?.id;
    if (conversationTabTraversal.current || showList) { setFeedbackFocus(undefined); restoreFocus.current = undefined; }
    else if (id !== undefined) setFeedbackFocus(id);
  };
  const closeOverview = (): void => { setOverviewOpen(false); overviewTrigger.current?.focus({ preventScroll: true }); };
  const showSources = sideView === "sources" && sourcePanel !== undefined;
  const showLibrary = sideView === "library";
  const showHistory = sideView === "history";
  const showHistoryRead =
    sideView === "historyRead" && historyReadPanel !== undefined;
  const openSessionFromSettings = (sessionId: string): void => {
    setSettingsWindow(undefined);
    scheduleDirty.current = false; setScheduleCloseConfirmation(false); setScheduleWindow(undefined);
    const session = detail.sessions.find((item) => item.id === sessionId);
    if (session?.role === "execution") selectExecution(detail, session);
    else if (session?.role === "main") {
      setVisibleConversation("main"); setOverviewOpen(false); setFeedbackFocus(session.id);
    }
  };
  const sideBackView: SideView = showSources ? sourceReturnView
    : showHistoryRead ? "history"
    : sideView === "libraryFile" || sideView === "boardSource" ? "board"
    : showLibrary ? libraryReturnView : "sessions";
  const sideBackLabel = sideBackView === "chat" && selectedExecution !== undefined
    ? t("sessions.chat.return", { name: selectedExecution.title })
    : sideBackView === "libraryFile" ? t("p3.history.returnConversation", { name: sourceReadingReturn?.selection.name ?? t("project.library.title") })
    : sideBackView === "library" ? t("project.library.back")
    : sideBackView === "history" ? t("project.history.title")
    : sideBackView === "board" ? t("project.board.back")
    : sideBackView === "schedule" ? t("project.schedule.back")
    : t("sessions.chat.back");
  const sideTab = sideView === "libraryFile" || sideView === "conversationFile" ? "library"
    : sideView === "boardSource" ? "board"
    : sideView === "library" || sideView === "board" || sideView === "schedule" ? sideView : "sessions";
  const sideBackControl = <Tooltip label={sideBackLabel}><Button
    ref={sideBack}
    variant="ghost"
    size="sm"
    icon={<IconChevronLeftOutlineRegular size={14} />}
    aria-label={sideBackLabel}
    onClick={() => {
      sourceRequest.current++; sourceAbort.current?.abort();
      if (sideBackView === "chat" && selectedExecution !== undefined) {
        setVisibleConversation("execution"); setShowExecutionList(false); setOverviewOpen(false); setFeedbackFocus(selectedExecution.id);
      } else if (sideBackView === "libraryFile" && sourceReadingReturn !== undefined) restoreLibraryReading(sourceReadingReturn);
      else {
        sideFocusRequest.current = { view: sideBackView, target: sideOpeners.current[sideView] };
        setSideView(sideBackView);
      }
    }}
  /></Tooltip>;

  const sessionsOverview = (origin: "central" | "overview"): ReactNode => (
    <SessionsOverview detail={detail} t={t}
      creatingSession={executionCreateOrigin === origin}
      busy={busy || lifecycleBusy || renameBusy}
      allowCreate={!detail.project.archived && !screen.references.main.readOnly && !pendingProjectRestore}
      onShowCreate={() => {
        if (!detail.project.archived && !screen.references.main.readOnly) setExecutionCreateOrigin(current => current === origin ? undefined : origin);
      }}
      onCreate={(title, workspace) => { void createExecution(title, workspace); }}
      onOpenExecution={session => selectExecution(detail, session)}
      onContinueDeletion={continueExecutionDeletion}
      onOpenHistory={opener => {
        sideOpeners.current.history = opener; sideFocusRequest.current = { view: "history" };
        setOverviewOpen(true); setSideView("history");
      }}
      onOpenInstructions={session => setSettingsWindow({ page: "execution", sessionId: session.id })}
      onOpenSchedule={session => setScheduleWindow({ sessionId: session.id })}
      onRename={session => {
        setRenameDraft({ projectId: detail.project.id, sessionId: session.id, title: session.title, expectedRevision: session.revision }); setRenameNotice("");
      }}
      onLifecycle={session => {
        if (session.archived || detail.pendingRestores?.some(item => item.scope === "session" && item.sessionId === session.id)) void changeLifecycle("restore", session.id);
        else setArchiveConfirmation({ kind: "execution", projectId: detail.project.id, sessionId: session.id, name: session.title });
      }}
      onDelete={session => setDeletionConfirmation({ kind: "execution", projectId: detail.project.id,
        sessionId: session.id, name: session.title, expectedRevision: session.revision })}
    />
  );
  const executionControls = showExecutionChat ? <div className="dsh-projects__execution-controls"
    hidden={!splitConversations && (executionListVisible || visibleConversation !== "execution")}
    onFocusCapture={() => {
      if (conversationCommits.execution === screen.references && visibleConversation !== "execution") setVisibleConversation("execution");
    }}>
    <ExecutionSessionSelector sessions={detail.sessions} selected={selectedExecution} t={t} busy={busy || lifecycleBusy}
      onSelect={session => selectExecution(detail, session)} onShowAll={showAllExecutions} />
    {selectedExecution.archived && <Tag tone="quiet">{t("list.archived.tag")}</Tag>}
    <div className="dsh-projects__session-options">
      <ActionMenu label={t("p5.panel.sessionActions")} items={[
        { id: "rename", label: t("p5.common.rename"), disabled: lifecycleBusy || renameBusy },
        { id: "schedule", label: t("p3.history.schedule.title") },
        { id: "delete", label: t("deletion.execution.open"), danger: true, disabled: lifecycleBusy },
        { id: "lifecycle", label: pendingExecutionRestore ? t("p5.panel.continueExecutionRestore") : selectedExecution.archived ? t("p5.panel.restoreExecution") : t("p5.panel.archiveExecution"),
          disabled: lifecycleBusy || pendingProjectRestore || (selectedExecution.archived && detail.project.archived) },
        { id: "instructions", label: t("p3.history.sessions.instructions") },
      ]} onSelect={id => {
        if (id === "rename") {
          setRenameDraft({ projectId: detail.project.id, sessionId: selectedExecution.id,
            title: selectedExecution.title, expectedRevision: selectedExecution.revision }); setRenameNotice("");
        } else if (id === "schedule") setScheduleWindow({ sessionId: selectedExecution.id });
        else if (id === "delete") setDeletionConfirmation({ kind: "execution",
          projectId: detail.project.id, sessionId: selectedExecution.id, name: selectedExecution.title,
          expectedRevision: selectedExecution.revision });
        else if (id === "lifecycle") {
          if (pendingExecutionRestore || selectedExecution.archived) void changeLifecycle("restore");
          else setArchiveConfirmation({ kind: "execution", projectId: detail.project.id, sessionId: selectedExecution.id, name: selectedExecution.title });
        } else if (id === "instructions") setSettingsWindow({ page: "execution", sessionId: selectedExecution.id });
      }} />
    </div>
  </div> : null;

  return (
    <ProjectConversationLifetime references={screen.references}><MemoryNoticeNavigationContext.Provider value={notice => {
      if (notice.projectId !== detail.project.id || settingsWindow !== undefined) return;
      setSettingsWindow({ page: "memory", memoryId: notice.memoryIds[0] });
    }}><main className="dsh-projects dsp-theme">
      {operationDialogs}
      {error !== undefined && <><Feedback key={error} text={error} tone="error" onDone={() => {}} />
        <ErrorState title={error} {...(busy || lifecycleBusy ? {} : { retry: () => { void openProject(detail.project.id); } })} retryLabel={t("list.retry")} /></>}
      {lifecycleNotice !== undefined && <><Feedback key={lifecycleNotice} text={lifecycleNotice} tone="info" onDone={() => {}} />
        <p className="dsh-projects__operation-result" role="status">{lifecycleNotice}</p></>}
      {projectLifecycleResult !== undefined && <ProjectLifecycleReport t={t} result={projectLifecycleResult} />}
      {warning !== undefined && (
        <><Feedback key={warning} text={t("create.partialWarning", { value: warning })} tone="warning" onDone={() => {}} />
        <p className="dsh-projects__operation-result" role="alert"><StateDot state="warning" />
          {t("create.partialWarning", { value: warning })}
        </p></>
      )}
      {projectWatchInterruption?.projectId === detail.project.id && <ProjectUpdatesInterrupted
        value={projectWatchInterruption} t={t} onReturnToList={returnToList} />}
          <header className="dsh-projects__project-head">
            <div className="dsh-projects__project-ident">
              {onToggleGlobalSidebar !== undefined && <Tooltip label={t("project.navigation.open")}><IconAction
                className="dsh-projects__global-navigation"
                icon={<IconPanelLeftOutlineRegular size={14} />}
                aria-label={t("project.navigation.open")}
                onClick={onToggleGlobalSidebar}
              /></Tooltip>}
              <Tooltip label={t("project.back")}><IconAction
                icon={<IconChevronLeftOutlineRegular size={14} />}
                aria-label={t("project.back")}
                onClick={returnToList}
              /></Tooltip>
              <Tooltip label={detail.project.name}><h1 className="dsh-projects__project-title">
                {detail.project.name}
              </h1></Tooltip>

            </div>
            <nav className="dsh-projects__project-actions" aria-label={t("project.actions.label")}>
            <Tooltip label={overviewOpen ? t("project.overview.close") : t("project.overview.open")}><IconAction
              ref={overviewTrigger} className="dsh-projects__overview-trigger" aria-expanded={overviewOpen} aria-controls={`${sideTabsId}-sidebar`}
              icon={<IconPanelLeftOutlineRegular size={16} className="dsh-projects__overview-icon" />}
              aria-label={overviewOpen ? t("project.overview.close") : t("project.overview.open")}
              onClick={() => {
                setOverviewOpen((open) => !open);
                if (!overviewOpen) setSideView("sessions");
              }}
            /></Tooltip>
            <Tooltip label={t("project.settings.open")}><IconAction
              icon={<IconSettingsOutlineRegular size={16} />} aria-label={t("project.settings.open")}
              onClick={() => { setSettingsWindow({ page: "general" }); }}
            /></Tooltip>
            <Tooltip label={t("project.lifecycle.scope")}><span>
              <ActionMenu className="dsh-projects__project-more" label={t("project.more")}
                items={[
                  { id: "rename", label: t("project.rename") },
                  { id: "lifecycle", label: pendingProjectRestore ? t("p5.panel.continueProjectRestore") : detail.project.archived ? t("p5.panel.restoreProject") : t("p5.panel.archiveProject"), disabled: lifecycleBusy },
                  { id: "delete", label: t("deletion.project.open"), danger: true, disabled: lifecycleBusy },
                ]}
                onSelect={id => {
                  if (id === "rename") setSettingsWindow({ page: "general" });
                  else if (id === "lifecycle") {
                    if (pendingProjectRestore || detail.project.archived) void changeProjectLifecycle("restore");
                    else setArchiveConfirmation({ kind: "project", projectId: detail.project.id, name: detail.project.name });
                  } else if (id === "delete") setDeletionConfirmation({ kind: "project",
                    projectId: detail.project.id, name: detail.project.name, expectedRevision: detail.project.revision });
                }} />
            </span></Tooltip>
            </nav>
          </header>
      <div ref={setWorkspaceElement} className="dsh-projects__workspace"
        style={{ "--dsh-projects-overview-width": `${overviewWidth}px` } as CSSProperties}
        data-layout={splitConversations ? "split" : "single"} data-overview={overviewOpen ? overviewMode : "closed"}>
        <div hidden={overviewOpen && overviewMode === "fullscreen"} className="dsh-projects__conversation-toolbar">
        <div className="dsh-projects__conversation-tabs"
          onKeyDownCapture={event => { conversationTabTraversal.current = ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key); }}
          onKeyUpCapture={() => { conversationTabTraversal.current = false; }}
          onClickCapture={() => { conversationTabTraversal.current = false; }}>
          {splitConversations ? <div role="group" aria-label={t("project.conversations.label")} className="dsh-projects__conversation-focus-actions">
            {(["main", "execution"] as const).map(role => <Button key={role} variant="ghost" size="sm" type="button"
              aria-pressed={visibleConversation === role} onClick={() => navigateConversation(role)}>{t(`project.conversation.${role}`)}</Button>)}
          </div> : <SegmentedTabs className="dsh-projects__conversation-tab-list" label={t("project.conversations.label")} value={visibleConversation}
            items={[
              { value: "main", label: t("project.conversation.main"), id: `${conversationTabsId}-main`, panelId: `${conversationTabsId}-main-panel` },
              { value: "execution", label: t("project.conversation.execution"), id: `${conversationTabsId}-execution`, panelId: executionPanelId },
            ]} onChange={navigateConversation} />}
        </div>
        {executionControls}
        </div>
        <div className="dsh-projects__conversations" hidden={overviewOpen && overviewMode === "fullscreen"}>
        <section ref={executionListRegion} tabIndex={-1} hidden={!executionListVisible}
          id={`${conversationTabsId}-execution-list-panel`} role="tabpanel" aria-labelledby={`${conversationTabsId}-execution`}
          className="dsh-projects__conversation-seat" data-role="execution-list">
          <div className="dsh-projects__execution-directory">{sessionsOverview("central")}</div>
        </section>
        <section
          ref={mainRegion} tabIndex={-1} hidden={!splitConversations && visibleConversation === "execution"}
          id={`${conversationTabsId}-main-panel`} role={!splitConversations ? "tabpanel" : "region"}
          aria-labelledby={!splitConversations ? `${conversationTabsId}-main` : undefined}
          onFocusCapture={() => {
            if (conversationCommits.main === screen.references && visibleConversation !== "main") setVisibleConversation("main");
          }}
          className="dsh-projects__conversation-seat" data-role="main"
          aria-label={t("project.main.label")}
        >
          <div className="dsh-projects__conversation-heading" hidden={!splitConversations}>
              <Tag className="dsh-projects__conversation-role" tone="quiet">{t("project.conversation.main")}</Tag>

          </div>
          {(detail.project.archived || pendingProjectRestore) && <details className="dsh-projects__readonly">
            <summary><span role="status">{t(pendingProjectRestore ? "p3.history.restoreReadonly" : "p3.history.archiveReadonly")}</span></summary>
            <p>{t(pendingProjectRestore ? "p3.history.projectRestoreDetails" : "p3.history.projectArchiveDetails")}</p>
          </details>}
          {mainModelError !== undefined && <p className="dsh-projects__readonly" role="status">{t("p5.panel.mainModelUnknownReadOnly")}{mainModelError.message}
          </p>}
          {detail.project.mainSessionId !== undefined && renderReadingHint(detail.project.mainSessionId)}
          <div className="dsh-projects__project-main">
            <ProjectConversationReady t={t} ready={screen.references.inputReady} commitKey={screen.references}
              onContentCommit={committed => setConversationCommits(current => committed
                ? current.main === screen.references ? current : { ...current, main: screen.references }
                : current.main === screen.references ? { ...current, main: undefined } : current)}>{renderConversation === undefined ? <SessionProvider session={screen.references.main.reference}>
              {renderSlot("projects.main.conversation", { focus: projectNavigation?.target.source === undefined && projectNavigation?.detail.project.id === detail.project.id && projectNavigation.target.kind === "main" && projectNavigation.target.sessionId === detail.project.mainSessionId && projectNavigation.target.focusEventSeq !== undefined ? { id: projectNavigation.id, eventSeq: projectNavigation.target.focusEventSeq, messageId: projectNavigation.target.focusMessageId } : undefined })}
            </SessionProvider> : renderConversation(screen.references.main, { readOnly: screen.references.main.readOnly, projectName: detail.project.name,
              visible: !(overviewOpen && overviewMode === "fullscreen") && (splitConversations || visibleConversation === "main"),
              focus: projectNavigation?.target.source === undefined && projectNavigation?.detail.project.id === detail.project.id && projectNavigation.target.kind === "main" && projectNavigation.target.sessionId === detail.project.mainSessionId && projectNavigation.target.focusEventSeq !== undefined ? { id: projectNavigation.id, eventSeq: projectNavigation.target.focusEventSeq, messageId: projectNavigation.target.focusMessageId } : undefined })}</ProjectConversationReady>
          </div>
          <footer className="dsh-projects__conversation-footer"><small aria-label={t("p5.panel.mainUsageSummary")}><UsageSessionSummary translate={t} scope="session-history"
                sessions={titleUsage?.projectId === detail.project.id ? titleUsage.sessions.filter(item => item.sessionId === detail.project.mainSessionId) : undefined}
                loading={titleUsageLoading} failed={titleUsageError} /></small></footer>
        </section>
        {showExecutionChat && <section ref={executionRegion} tabIndex={-1}
          hidden={executionListVisible || !splitConversations && visibleConversation !== "execution"}
          id={`${conversationTabsId}-execution-panel`} role={splitConversations ? "region" : "tabpanel"}
          aria-labelledby={splitConversations ? undefined : `${conversationTabsId}-execution`}
          onFocusCapture={() => {
            if (conversationCommits.execution === screen.references && visibleConversation !== "execution") setVisibleConversation("execution");
          }}
          className="dsh-projects__conversation-seat" data-role="execution"
          aria-label={t("sessions.chat.label", { name: selectedExecution.title })}>
          <div className="dsh-projects__conversation-heading" hidden={!splitConversations}>
            <Tag className="dsh-projects__conversation-role" tone="quiet">{t("project.conversation.execution")}</Tag>
          </div>
          {pendingProjectRestore && <p className="dsh-projects__readonly" role="status">{t("p3.history.projectRestoreRequired")}</p>}
            {showExecutionChat && (selectedExecution.archived || pendingExecutionRestore) && <details className="dsh-projects__readonly">
              <summary><span role="status">{t(pendingExecutionRestore ? "p3.history.restoreReadonly" : "p3.history.archiveReadonly")}</span></summary>
              <p>{t(pendingExecutionRestore ? "p3.history.executionRestoreDetails" : "p3.history.executionArchiveDetails")}
                {detail.project.archived ? t("p3.history.projectRestoreFirst") : ""}</p>
            </details>}
            {showExecutionChat && executionModelError !== undefined && <p className="dsh-projects__readonly" role="status">{t("p5.panel.executionModelUnknownReadOnly")}{executionModelError.message}
            </p>}
            {showExecutionChat && renderReadingHint(selectedExecution.id)}
            {showExecutionChat && lifecycleBusy && <LoadingState label={t("p5.panel.processingExecution")} rows={1} />}
            {selectedExecution !== undefined && screen.references.execution !== undefined && (
              <div hidden={!showExecutionChat || lifecycleBusy}
                className="dsh-projects__session-chat"
                aria-label={t("sessions.chat.label", {
                  name: selectedExecution.title,
                })}
              >
                <ProjectConversationReady t={t} ready={screen.references.inputReady} commitKey={screen.references}
                  onContentCommit={committed => setConversationCommits(current => committed
                    ? current.execution === screen.references ? current : { ...current, execution: screen.references }
                    : current.execution === screen.references ? { ...current, execution: undefined } : current)}>{renderConversation === undefined ? <SessionProvider session={screen.references.execution.reference}>
                  {renderSlot("projects.execution.conversation", { focus: projectNavigation?.target.source === undefined && projectNavigation?.detail.project.id === detail.project.id && projectNavigation.target.kind === "execution" && projectNavigation.target.sessionId === selectedExecution.id && projectNavigation.target.focusEventSeq !== undefined ? { id: projectNavigation.id, eventSeq: projectNavigation.target.focusEventSeq, messageId: projectNavigation.target.focusMessageId } : undefined })}
                </SessionProvider> : renderConversation(screen.references.execution, { readOnly: screen.references.execution.readOnly, projectName: detail.project.name,
                  visible: !(overviewOpen && overviewMode === "fullscreen") && showExecutionChat && !executionListVisible && (splitConversations || visibleConversation === "execution") && !lifecycleBusy,
                  focus: projectNavigation?.target.source === undefined && projectNavigation?.detail.project.id === detail.project.id && projectNavigation.target.kind === "execution" && projectNavigation.target.sessionId === selectedExecution.id && projectNavigation.target.focusEventSeq !== undefined ? { id: projectNavigation.id, eventSeq: projectNavigation.target.focusEventSeq, messageId: projectNavigation.target.focusMessageId } : undefined })}</ProjectConversationReady>
              </div>
            )}
          <footer className="dsh-projects__conversation-footer"><small aria-label={t("p5.panel.executionUsageSummary")}><UsageSessionSummary translate={t} scope="session-history"
              sessions={titleUsage?.projectId === detail.project.id ? titleUsage.sessions.filter(item => item.sessionId === selectedExecution.id) : undefined}
              loading={titleUsageLoading} failed={titleUsageError} /></small></footer>
        </section>}
        </div>
        {!overviewOpen ? null : (
          <aside id={`${sideTabsId}-sidebar`} className="dsh-projects__overview-panel" data-mode={overviewMode}
            aria-label={t("project.overview.panelTitle")} onKeyDown={event => {
              if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.defaultPrevented) { event.preventDefault(); event.stopPropagation(); closeOverview(); }
            }}>
            {overviewMode !== "fullscreen" && <OverviewResizeHandle width={overviewWidth} min={overviewMinWidth} max={overviewMaxWidth}
              onResize={setOverviewPreferredWidth} controls={`${sideTabsId}-sidebar`} label={t("project.overview.resize")}
              formatValue={width => t("project.overview.width", { width })} />}
            <header className="dsh-projects__overview-head">
              {overviewMode === "fullscreen" && <IconAction
                icon={<IconChevronLeftOutlineRegular size={16} />} aria-label={t("project.overview.back")} onClick={closeOverview} />}
              <h2>{t("project.overview.panelTitle")}</h2>
              {overviewMode !== "fullscreen" && <Menu open={overviewWidthMenuOpen} portal autoFocus
                onClose={() => setOverviewWidthMenuOpen(false)}
                items={[
                  { id: "narrower", label: t("project.overview.narrower"), disabled: overviewWidth <= overviewMinWidth },
                  { id: "wider", label: t("project.overview.wider"), disabled: overviewWidth >= overviewMaxWidth },
                  { id: "default", label: t("project.overview.defaultWidth"), disabled: overviewPreferredWidth === 360 },
                ]} onSelect={id => {
                  setOverviewWidthMenuOpen(false);
                  if (id === "default") setOverviewPreferredWidth(360);
                  else setOverviewPreferredWidth(Math.min(overviewMaxWidth, Math.max(overviewMinWidth, overviewWidth + (id === "wider" ? 32 : -32))));
                }} anchor={<Tooltip label={t("project.overview.widthOptions")}><IconAction
                  icon={<IconChevronsUpDownOutlineRegular size={16} className="dsh-projects__width-options-icon" />}
                  aria-label={t("project.overview.widthOptions")} aria-haspopup="menu" aria-expanded={overviewWidthMenuOpen}
                  onClick={() => setOverviewWidthMenuOpen(value => !value)} /></Tooltip>} />}
              <IconAction ref={overviewClose} icon={<IconCloseOutlineRegular size={16} />}
                aria-label={t("project.overview.close")} onClick={closeOverview} />
            </header>
            <nav className="dsh-projects__side-tabs" aria-label={t("p3.history.sidebar")}>
              <SegmentedTabs className="dsh-projects__side-tab-items" label={t("p3.history.sidebar")}
                value={sideTab} items={[
                  { value: "sessions", label: t("project.overview.title"), id: `${sideTabsId}-sessions`, panelId: `${sideTabsId}-sessions-panel` },
                  { value: "library", label: t("project.library.title"), id: `${sideTabsId}-library`, panelId: `${sideTabsId}-library-panel` },
                  { value: "schedule", label: t("p3.history.schedule.tab"), id: `${sideTabsId}-schedule`, panelId: `${sideTabsId}-schedule-panel` },
                  { value: "board", label: t("p3.history.board.tab"), id: `${sideTabsId}-board`, panelId: `${sideTabsId}-board-panel` },
                ]} onChange={view => {
                  if (view === "library" && sideView !== "library") {
                    setLibraryReturnView(visibleConversation === "execution" && showExecutionChat ? "chat" : "sessions");
                    const originSession = visibleConversation === "execution" && showExecutionChat ? selectedExecution : detail.sessions.find(session => session.role === "main");
                    libraryOrigin.current = originSession === undefined ? { kind: "library" } : { kind: "session", sessionId: originSession.id };
                    setLibraryScopeSessionId(originSession?.id);
                  }
                  setSideView(view);
                }} />
            </nav>
            {(["sessions", "library", "schedule", "board"] as const).filter(view => view !== sideTab).map(view =>
              <div key={view} hidden role="tabpanel" id={`${sideTabsId}-${view}-panel`} aria-labelledby={`${sideTabsId}-${view}`} />)}
            {/* Leaf content keeps its existing reader/request owner; conversations live in the sibling workspace. */}
            <div ref={sideRegion} tabIndex={-1} className="dsh-projects__side-panel dsh-projects__overview-body" role="tabpanel" id={`${sideTabsId}-${sideTab}-panel`} aria-labelledby={`${sideTabsId}-${sideTab}`}>
            {(showSources || showLibrary && librarySession === undefined || showHistory || showHistoryRead || sideView === "boardSource") && <header className="dsh-projects__side-head">
              <h2 className="dsh-projects__side-title">{showSources || sideView === "boardSource" ? t("project.sources.title") : showLibrary ? t("project.library.title") : t("project.history.title")}</h2>
              {sideBackControl}
            </header>}
            {(
              <div ref={libraryRegion} tabIndex={-1} hidden={!showLibrary} className="dsh-projects__side-body dsh-projects__side-body--flush">
                {librarySession === undefined ? (
                  <ErrorState title={t("project.library.sessionUnavailable")} retry={() => { void openProject(detail.project.id); }} retryLabel={t("list.retry")} />
                ) : (
                  <LibraryPanel
                    translate={t}
                    headerLeading={showLibrary ? sideBackControl : undefined}
                    projectId={detail.project.id}
                    sessionId={librarySession.id}
                    actions={libraryActions}
                    onRead={(selection, opener) => { void openLibraryReading(selection, undefined, undefined, opener); }}
                    onOpenOriginal={openLibraryOriginal}
                    onOpenSource={(source) => {
                      void openSources([source]);
                    }}
                  />
                )}
              </div>
            )}
            {(showHistory || showHistoryRead) && <div hidden={!showHistory} className="dsh-projects__side-body">
              <HistoryPanel
                key={detail.project.id}
                projectId={detail.project.id}
                detail={detail}
                queryHistory={queryHistory}
                readHistory={readHistoryContext}
                t={t}
              />
            </div>}
            {showSources ? (
              <div className="dsh-projects__side-body">
                <ProjectSourcesPanel
                  state={sourcePanel}
                  detail={detail}
                  t={t}
                  onLocate={(source, read) => { void locateSource(source, read); }}
                  onRetry={() => { void openSources(sourcePanel.sources, sourceReturnView); }}
                />
              </div>
            ) : showHistory ? null : showHistoryRead ? (
              <div className="dsh-projects__side-body">
                {renderSourceConversation !== undefined && historyReadPanel?.source.kind === 'native-event'
                  && historyReadPanel.result.found && historyReadPanel.result.status !== 'unavailable'
                  && sourceInvalidation(detail, historyReadPanel.source.hostSessionId) === undefined
                  ? <>
                    {historyReadPanel.result.items.filter(item => item.isTarget).map(item => <SourceMetadata key={`${item.seq}:${item.kind}`} item={item} detail={detail} t={t} />)}
                    {historyReadPanel.result.status === 'partial' && <p className="dsh-projects__history-meta" role="status"><Tag tone="warning">{t('project.history.partial')}</Tag></p>}
                    {renderSourceConversation(detail, historyReadPanel.source, { readOnly: true })}
                    {historyReadPanel.result.limitations.map((limitation, index) => <p className="dsh-projects__history-meta" key={index}>{t('project.history.limitations', { value: limitation })}</p>)}
                  </>
                  : <HistoryReadPanel
                    state={historyReadPanel}
                    detail={detail}
                    t={t}
                    onLocate={(source, read) => { void locateSource(source, read); }}
                  />}
              </div>
            ) : sideView === "conversationFile" && conversationReading !== undefined ? (
              <div className="dsh-projects__side-body dsh-projects__side-body--reader dsh-projects__side-body--flush">
                <ConversationFileReader translate={t} request={conversationReading.request} readConversationFile={readConversationFile}
                  initialScrollTop={conversationReading.scrollTop} initialOffset={conversationReading.offset}
                  onReadingPosition={({ offset, scrollTop }) => setConversationReading(previous => previous === undefined ? previous : { ...previous, offset, scrollTop })}
                  onBack={() => { void returnConversationReading(conversationReading, false); }} backLabel={t("p3.history.returnConversation", { name: conversationReading.request.role === "main" ? t("project.main.label") : conversationReading.request.sessionTitle })}
                  onFeedback={() => { void returnConversationReading(conversationReading, true); }} feedbackLabel={t("p3.history.feedbackConversation", { name: conversationReading.request.role === "main" ? t("project.main.label") : conversationReading.request.sessionTitle })}
                />
              </div>
            ) : sideView === 'libraryFile' && libraryReading !== undefined ? (
              <div className="dsh-projects__side-body dsh-projects__side-body--reader dsh-projects__side-body--flush">
                <LibraryReader translate={t} selection={libraryReading.selection} value={libraryReading.value}
                  initialFocusSource={libraryFocusSource.current}
                  loading={libraryReading.loading} error={libraryReading.error}
                  initialScrollTop={libraryReading.scrollTop}
                  onReadingScroll={scrollTop => setLibraryReading(previous => {
                    if (previous === undefined) return previous;
                    libraryPositions.current.set(libraryPositionKey(detail.project.id, previous.sessionId, previous.selection), scrollTop);
                    return { ...previous, scrollTop };
                  })}
                  onReload={() => { void openLibraryReading(libraryReading.selection, libraryReading.origin, libraryReading.sessionId); }}
                  onRead={selection => { void openLibraryReading(selection, libraryReading.origin, libraryReading.sessionId, libraryOpener.current); }}
                  onBack={() => { sideFocusRequest.current = { view: "library", target: libraryOpener.current }; setSideView("library"); }} backLabel={t("p3.history.libraryList")}
                  onOpenOriginal={openLibraryOriginal}
                  onOpenSource={(source, opener) => { libraryFocusSource.current = source; setSourceReadingReturn(libraryReading); void openSources([source], "libraryFile", opener); }}
                  footer={<div className="dsh-projects__reader-footer">
                    {libraryReading.origin.kind !== "library" && <Button variant="ghost" size="sm" type="button"
                      onClick={() => returnReadingToWork(libraryReading)}>
                      {libraryReading.origin.kind === "board" ? t("p3.history.returnBoard") : t("p3.history.feedbackConversation", { name: detail.sessions.find(session => session.id === (libraryReading.origin.kind === "session" ? libraryReading.origin.sessionId : ""))?.title ?? t("p3.history.originalConversation") })}
                    </Button>}
                    {libraryReading.origin.kind === "session" && <small>{t("p3.history.draftKept")}</small>}
                  </div>}
                />
              </div>
            ) : sideView === 'boardSource' && boardSource !== undefined ? (
              <div className="dsh-projects__side-body">
                <h3>{boardSource.label}</h3>
                {boardSource.message !== undefined && <p role="status">{boardSource.message}</p>}
                {boardSource.rows.map(row => <article key={row.id} className="dsh-projects__record"><h4>{row.title}</h4>
                  {row.fields.map((field, index) => <p key={index} className="dsh-projects__overview-value"><strong>{field.label}{t("p5.common.colon")}</strong>{field.value}</p>)}
                  {row.ownerUpdatedAt !== undefined && <p>{new Date(row.ownerUpdatedAt).toLocaleString()}</p>}
                </article>)}
                {boardSource.reference.kind === 'memory' && <Button variant="outline" size="sm" onClick={() => setSettingsWindow({ page: 'memory' })}>
                  {t('project.memory.editSettings')}
                </Button>}
              </div>
            ) : sideView === "schedule" ? (
              <div className="dsh-projects__side-body"><ScheduleOverview key={detail.project.id} refreshRevision={scheduleViewRevision}
                translate={t} projectId={detail.project.id} actions={scheduleActions(detail.project.id)}
                onManage={(sessionId, scheduleId, create) => setScheduleWindow({ sessionId, scheduleId, create })} /></div>
            ) : sideView === "board" ? (
              <div className="dsh-projects__side-body dsh-projects__side-body--flush">
                <OverviewPanel
                  translate={t}
                  key={`${detail.project.updatedAt}:${unavailableDisposition}`}
                  projectId={detail.project.id}
                  actions={overviewActions}
                  onNavigate={(target) => {
                    void navigateOverview(target);
                  }}
                />
              </div>
            ) : showLibrary ? null : (
              <div className="dsh-projects__side-body">
                {sessionsOverview("overview")}
              </div>
            )}
            </div>
          </aside>
        )}
      </div>
      {settingsWindow !== undefined && (
        <ProjectSettings
          runtimeNotice={projectWatchInterruption?.projectId === detail.project.id
            ? <ProjectUpdatesInterrupted value={projectWatchInterruption} t={t} /> : undefined}
          detail={detail}
          translate={t}
          actions={settingsActions}
          initialPage={settingsWindow.page}
          initialSessionId={settingsWindow.sessionId}
          initialMemoryId={settingsWindow.memoryId}
          initialNameEditing={settingsWindow.nameEditing}
          mainModelControl={renderMainModelControl === undefined ? <SessionProvider session={screen.references.main.reference}>
            {renderSlot("projects.main.model", {})}
          </SessionProvider> : renderMainModelControl(screen.references.main)}
          onClose={() => {
            setSettingsWindow(undefined);
          }}
          onOpenNativeModel={openSessionFromSettings}
        />
      )}
      {scheduleWindow !== undefined && <Modal open title={t("p3.history.schedule.title")} className="dsh-projects-schedule dsp-theme dsh-schedule-manager-modal"
        contentClassName="dsh-schedule-manager-content" closeLabel={t("p3.history.schedule.close")} onClose={() => {
          if (scheduleDirty.current) { setScheduleCloseConfirmation(true); return; }
          scheduleDirty.current = false; setScheduleWindow(undefined);
          setScheduleViewRevision(previous => previous + 1);
        }}>
        <SchedulePanel key={`${detail.project.id}:${scheduleWindow.sessionId ?? "all"}`}
          translate={t}
          projectId={detail.project.id} initialSessionId={scheduleWindow.sessionId}
          initialScheduleId={scheduleWindow.scheduleId} initialCreate={scheduleWindow.create}
          onDirtyChange={dirty => { scheduleDirty.current = dirty; }}
          actions={scheduleActions(detail.project.id)}
          onOpenSource={source => {
            if (source.kind !== "message" && source.kind !== "tool" && source.kind !== "native-event") return;
            scheduleDirty.current = false; setScheduleCloseConfirmation(false); setScheduleWindow(undefined);
            void openSources([source], "schedule");
          }}
          onOpenSession={openSessionFromSettings}
        />
      </Modal>}
      {scheduleWindow !== undefined && scheduleCloseConfirmation && <Modal open title={t("p3.history.schedule.discard")}
        closeLabel={t("create.discard.keep")} onClose={() => setScheduleCloseConfirmation(false)}
        footer={<><Button variant="ghost" size="md" type="button" data-modal-autofocus onClick={() => setScheduleCloseConfirmation(false)}>{t("create.discard.keep")}</Button>
          <Button variant="primary" size="md" type="button" onClick={() => {
            scheduleDirty.current = false; setScheduleCloseConfirmation(false); setScheduleWindow(undefined);
            setScheduleViewRevision(previous => previous + 1);
          }}>{t("create.discard.submit")}</Button></>} />}
    </main></MemoryNoticeNavigationContext.Provider></ProjectConversationLifetime>
  );
}
