import type { ProjectMemorySettingsActions, ProjectMemorySourceView, ReadMemorySourceContentRequest, ProjectMemorySourceContentPage } from '../public-types.ts';
import type { ReadProjectCommunicationRequest, ProjectCommunicationRead, ResolveProjectCommunicationNavigationRequest, ProjectCommunicationNavigation, ResolveProjectCommunicationFileRequest, ProjectCommunicationFile } from '../public-types.ts'
import type {
  RemoteResult,
  RemoteStreamHandle,
} from "@deepseek-ai/dsh-typert-protocol";
import type {
  ISessions,
  SessionReference,
  SessionRetainOptions,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type { HostObservable } from "@deepseek-ai/dsh-client-ui-slots";
import type { SessionId } from "@deepseek-ai/dsh-session/types";

import type {
  OverviewClientActions,
  OverviewSourceRef,
  OverviewSourceView,
  OverviewView,
} from "../features/overview/contract.ts";
import type {
  ExecutionDefaults,
  ExecutionDefaultsActions,
  ExecutionDefaultsView,
  ModelCatalog,
  ModelSelection,
  ProjectInstructions,
  ProjectInstructionsActions,
  SessionInstructions,
  SessionInstructionsActions,
  SettingsWriteResult,
} from "../features/settings/types.ts";
import type {
  ProjectUsageActions,
  ProjectUsageQuery,
  ProjectUsageResult,
} from "../features/usage/contract.ts";
import type {
  LibraryAddRequest,
  LibraryClientActions,
  LibraryEntry,
  LibraryEntryRequest,
  LibraryListRequest,
  LibraryListing,
  LibraryTarget,
  LibraryOpenRequest,
  LibraryOpenResult,
} from "../library-contract.ts";
import type {
  MemorySettingsActions,
  MemorySnapshot,
  MemoryWriteResult,
  ProjectMemory,
  SaveMemoryInput,
  StoredMemorySource,
} from "../memory-types.ts";
import type { ProjectMemoryNotice } from "../memory-notices.ts";
import type {
  ExecutionLifecycleActionRequest,
  DeleteExecutionSessionRequest,
  DeleteProjectRequest,
  ProjectDeletionActionResult,
  ExecutionLifecycleActionResult,
  ProjectLifecycleActionRequest,
  ProjectLifecycleActionResult,
  CreateProjectRequest,
  CreateProjectResult,
  CreateProjectSessionRequest,
  GetProjectRequest,
  ProjectDetail,
  ProjectEnvironmentView,
  ProjectHistoryReadRequest,
  ProjectHistoryReadResult,
  ProjectHistorySearchRequest,
  ProjectHistorySearchResult,
  ProjectNativeSourceRead,
  ProjectNavigationTarget,
  ProjectRecord,
  ProjectSessionRecord,
  ProjectSummary,
  ProjectUnavailableSource,
  UpdateProjectRequest,
  RenameExecutionSessionRequest,
  RenameExecutionSessionResult,
} from "../public-types.ts";
import type { NativeProjectSource } from "../source-types.ts";
import { projectSourceNavigation, type ProjectConversationFileRequest, type ReadConversationFile } from './workflow-navigation.ts';
import type {
  ManualRunAdmissionResult, ScheduleSettingsActions, ScheduleSnapshot, ScheduleWriteResult,
} from "../features/schedule/contract.ts";
import type {
  ProjectScheduleReadRequest, ProjectScheduleSaveRequest, ProjectScheduleEnabledRequest,
  ProjectScheduleRemoveRequest, ProjectScheduleRunNowRequest,
} from "../public-types.ts";

declare module "@deepseek-ai/dsh-api-session-controller/client" {
  interface SessionReferenceSourceMap {
    /** Projects main-panel conversations retained while their project is open. */
    projectsPanel: unknown;
  }
}

type ProjectId = ProjectRecord["id"];
type ProjectSessionId = ProjectSessionRecord["id"];

export interface ProjectWatchInterruption {
  readonly projectId: ProjectId;
  readonly message?: string;
}

interface ReadMemoryRequest {
  readonly projectId: ProjectId;
  readonly id: string;
}
interface SaveMemoryRequest {
  readonly projectId: ProjectId;
  readonly input: SaveMemoryInput;
}
interface WithdrawMemoryRequest extends ReadMemoryRequest {
  readonly expectedRevision: number;
}
/** Memory accepts legacy record locators only to make historical sources readable. */
interface ReadMemorySourceRequest {
  readonly projectId: ProjectId;
  readonly source: StoredMemorySource;
}

/** The narrow Projects Remote face used by the public panel. */
export interface ProjectsRemote {
  readCommunication(input: ReadProjectCommunicationRequest, signal?: AbortSignal): Promise<RemoteResult<ProjectCommunicationRead>>;
  resolveCommunicationNavigation(input: ResolveProjectCommunicationNavigationRequest, signal?: AbortSignal): Promise<RemoteResult<ProjectCommunicationNavigation>>;
  resolveCommunicationFile(input: ResolveProjectCommunicationFileRequest, signal?: AbortSignal): Promise<RemoteResult<ProjectCommunicationFile>>;
  renameExecutionSession(input: RenameExecutionSessionRequest): Promise<RemoteResult<RenameExecutionSessionResult>>;
  deleteExecutionSession(input: DeleteExecutionSessionRequest): Promise<RemoteResult<ProjectDeletionActionResult>>;
  deleteProject(input: DeleteProjectRequest): Promise<RemoteResult<ProjectDeletionActionResult>>;
  scheduleRead(input: ProjectScheduleReadRequest, signal?: AbortSignal): Promise<RemoteResult<ScheduleSnapshot>>;
  scheduleSave(input: ProjectScheduleSaveRequest, signal?: AbortSignal): Promise<RemoteResult<ScheduleWriteResult>>;
  scheduleSetEnabled(input: ProjectScheduleEnabledRequest, signal?: AbortSignal): Promise<RemoteResult<ScheduleWriteResult>>;
  scheduleRemove(input: ProjectScheduleRemoveRequest, signal?: AbortSignal): Promise<RemoteResult<ScheduleWriteResult>>;
  scheduleRunNow(input: ProjectScheduleRunNowRequest, signal?: AbortSignal): Promise<RemoteResult<ManualRunAdmissionResult>>;
  executionLifecycle(input: ExecutionLifecycleActionRequest): Promise<RemoteResult<ExecutionLifecycleActionResult>>;
  projectLifecycle(input: ProjectLifecycleActionRequest): Promise<RemoteResult<ProjectLifecycleActionResult>>;
  list(): Promise<RemoteResult<readonly ProjectSummary[]>>;
  create(
    input: CreateProjectRequest,
  ): Promise<RemoteResult<CreateProjectResult>>;
  get(input: GetProjectRequest, signal?: AbortSignal): Promise<RemoteResult<ProjectDetail>>;
  watch(input: GetProjectRequest): RemoteStreamHandle<ProjectDetail, never>;
  createSession(
    input: CreateProjectSessionRequest,
  ): Promise<RemoteResult<ProjectDetail>>;
  update(input: UpdateProjectRequest): Promise<RemoteResult<ProjectDetail>>;
  readSource(input: {
    readonly projectId: ProjectId;
    readonly source: NativeProjectSource;
  }, signal?: AbortSignal): Promise<RemoteResult<ProjectNativeSourceRead>>;
  queryHistory(
    input: { readonly projectId: ProjectId } & ProjectHistorySearchRequest, signal?: AbortSignal,
  ): Promise<RemoteResult<ProjectHistorySearchResult>>;
  readHistory(
    input: { readonly projectId: ProjectId } & ProjectHistoryReadRequest, signal?: AbortSignal,
  ): Promise<RemoteResult<ProjectHistoryReadResult>>;
  libraryList(input: LibraryListRequest, signal?: AbortSignal): Promise<RemoteResult<LibraryListing>>;
  libraryAdd(input: LibraryAddRequest): Promise<RemoteResult<LibraryEntry>>;
  libraryOpen(
    input: LibraryOpenRequest, signal?: AbortSignal,
  ): Promise<RemoteResult<LibraryOpenResult>>;
  libraryRemove(input: LibraryEntryRequest): Promise<RemoteResult<void>>;
  overviewRead(input: GetProjectRequest): Promise<RemoteResult<OverviewView>>;
  overviewSource(input: {
    readonly projectId: ProjectId;
    readonly reference: OverviewSourceRef;
  }): Promise<RemoteResult<OverviewSourceView>>;
  settingsEnvironment(input: {
    readonly projectId: ProjectId;
    readonly sessionId: ProjectSessionId;
  }): Promise<RemoteResult<ProjectEnvironmentView>>;
  settingsCatalog(): Promise<RemoteResult<ModelCatalog>>;
  executionDefaultsRead(
    input: GetProjectRequest,
  ): Promise<RemoteResult<ExecutionDefaultsView>>;
  executionDefaultsSave(input: {
    readonly projectId: ProjectId;
    readonly selection: ModelSelection | null;
    readonly expectedRevision: number;
  }): Promise<RemoteResult<SettingsWriteResult<ExecutionDefaults>>>;
  projectInstructionsRead(input: GetProjectRequest): Promise<RemoteResult<ProjectInstructions>>;
  projectInstructionsSave(input: { readonly projectId: ProjectId; readonly text: string; readonly expectedRevision: number }): Promise<RemoteResult<SettingsWriteResult<ProjectInstructions>>>;
  sessionInstructionsRead(input: {
    readonly projectId: ProjectId;
    readonly sessionId: ProjectSessionId;
  }): Promise<RemoteResult<SessionInstructions>>;
  sessionInstructionsSave(input: {
    readonly projectId: ProjectId;
    readonly sessionId: ProjectSessionId;
    readonly text: string;
    readonly expectedRevision: number;
  }): Promise<RemoteResult<SettingsWriteResult<SessionInstructions>>>;
  usage(input: ProjectUsageQuery, signal?: AbortSignal): Promise<RemoteResult<ProjectUsageResult>>;
  watchUsage(
    input: GetProjectRequest,
  ): RemoteStreamHandle<
    { readonly projectId: ProjectId; readonly revision: number },
    never
  >;
  memoryList(input: GetProjectRequest): Promise<RemoteResult<MemorySnapshot>>;
  memoryRead(
    input: ReadMemoryRequest,
  ): Promise<RemoteResult<ProjectMemory | undefined>>;
  memorySave(
    input: SaveMemoryRequest,
  ): Promise<RemoteResult<MemoryWriteResult>>;
  memoryWithdraw(
    input: WithdrawMemoryRequest,
  ): Promise<RemoteResult<MemoryWriteResult>>;
  memorySource(input: ReadMemorySourceRequest): Promise<RemoteResult<ProjectMemorySourceView>>;
  memorySourceContent(input: ReadMemorySourceContentRequest): Promise<RemoteResult<ProjectMemorySourceContentPage>>;
  watchMemoryChanges(
    input: GetProjectRequest,
    signal?: AbortSignal,
  ): RemoteStreamHandle<ProjectMemoryNotice, never>;
}

export interface NativeFileOpenPort {
  canOpenWorkspacePath(): Promise<RemoteResult<boolean>>;
  openWorkspacePath(input: { readonly path: string }): Promise<RemoteResult<{ readonly opened: true }>>;
}

/** Product presentation mode never alters the stock SessionReference contract. */
export interface ProjectPanelReference {
  readonly reference: SessionReference;
  readonly readOnly: boolean;
  readonly detail: ProjectDetail;
  readonly session: ProjectSessionRecord;
}

/** Exact logical-to-physical binding offered to the stable draft/native owners. */
export interface ProjectLogicalBinding {
  readonly detail: ProjectDetail;
  readonly session: ProjectSessionRecord;
  readonly reference: SessionReference;
  readonly readOnly: boolean;
  readonly previousHostSessionId?: SessionId | undefined;
}

/** Permanent deletion invalidates unsubmitted logical input even if the following RPC fails. */
export type ProjectPermanentDeleteIntent =
  | { readonly kind: 'project'; readonly request: DeleteProjectRequest }
  | { readonly kind: 'execution'; readonly request: DeleteExecutionSessionRequest };

export interface ProjectPanelBindingPort {
  adoptDetail(detail: ProjectDetail): void;
  /** Synchronous: runs before the permanent-delete RPC and before its first await. */
  beforePermanentDelete?(input: ProjectPermanentDeleteIntent): void;
  /** Acquire from the real Live or Reader owner before any follow/history binding is opened. */
  retainPanelSession?(id: SessionId, options: SessionRetainOptions, readOnly: boolean): SessionReference;
  onLogicalBinding(binding: ProjectLogicalBinding): void | Promise<void>;
  /** Original exact source/read, forwarded only after its navigation was accepted. */
  onSourceFocus?(request: { readonly detail: ProjectDetail; readonly source: NativeProjectSource; readonly read: Pick<ProjectNativeSourceRead, 'items'> }): void | Promise<void>;
  /** Called only after every committed product occurrence released this source. */
  sourceInvalidated?(id: SessionId): void;
}

/** References presented by the Projects main panel's two embedded chats. */
export interface ProjectPanelReferences {
  readonly main: ProjectPanelReference;
  readonly mainIdentity: string;
  readonly executionIdentity?: string | undefined;
  /** The new physical binding is ready in the stable logical draft owner before presentation. */
  readonly inputReady?: Promise<void>;
  /** Holds this screen occurrence until its committed Providers unmount. */
  readonly mount: () => () => void;
  readonly execution?: ProjectPanelReference | undefined;
  readonly executionSessionId?: ProjectSessionId | undefined;
}

/** One validated request from a Project tool card to show a Project object in the main panel. */
export interface ProjectPanelNavigation {
  readonly id: number;
  readonly detail: ProjectDetail;
  readonly executionSessionId?: ProjectSessionId | undefined;
  readonly target: ProjectNavigationTarget;
}

/** Plain callbacks injected into the Projects panel. */
export interface ProjectsPanelActions {
  readonly renameExecutionSession: (input: RenameExecutionSessionRequest) => Promise<RenameExecutionSessionResult>;
  readonly deleteExecutionSession: (input: DeleteExecutionSessionRequest) => Promise<ProjectDeletionActionResult>;
  readonly deleteProject: (input: DeleteProjectRequest) => Promise<ProjectDeletionActionResult>;
  readonly executionLifecycle: (input: ExecutionLifecycleActionRequest) => Promise<ExecutionLifecycleActionResult>;
  readonly projectLifecycle: (input: ProjectLifecycleActionRequest) => Promise<ProjectLifecycleActionResult>;
  readonly hooks: {
    readonly projectDetail: HostObservable<ProjectDetail | undefined>;
    readonly projectWatchInterruption: HostObservable<ProjectWatchInterruption | undefined>;
    readonly projectMemoryNotice: HostObservable<ProjectMemoryNotice | undefined>;
    readonly projectNavigation: HostObservable<
      ProjectPanelNavigation | undefined
    >;
    readonly projectFileRequest: HostObservable<ProjectConversationFileRequest | undefined>;
  };
  readonly listProjects: () => Promise<readonly ProjectRecord[]>;
  readonly createProject: (
    input: CreateProjectRequest,
  ) => Promise<CreateProjectResult>;
  readonly getProject: (projectId: ProjectId) => Promise<ProjectDetail>;
  /** A speculative navigation read must not invalidate or replace the displayed bindings. */
  readonly readProjectSnapshot: (projectId: ProjectId, signal?: AbortSignal) => Promise<ProjectDetail>;
  readonly createExecutionSession: (
    input: CreateProjectSessionRequest,
  ) => Promise<ProjectDetail>;
  readonly updateProject: (
    input: UpdateProjectRequest,
  ) => Promise<ProjectDetail>;
  readonly readProjectSource: (
    projectId: ProjectId,
    source: NativeProjectSource, signal?: AbortSignal,
  ) => Promise<ProjectNativeSourceRead>;
  readonly queryHistory: (
    projectId: ProjectId,
    request: ProjectHistorySearchRequest, signal?: AbortSignal,
  ) => Promise<ProjectHistorySearchResult>;
  readonly readHistory: (
    projectId: ProjectId,
    request: ProjectHistoryReadRequest, signal?: AbortSignal,
  ) => Promise<ProjectHistoryReadResult>;
  readonly readConversationFile: ReadConversationFile;
  readonly dismissConversationFile: (id: number) => void;
  readonly returnToFileConversation: (request: ProjectConversationFileRequest) => Promise<void>;
  readonly locateProjectSource: (projectId: ProjectId, source: NativeProjectSource, read: Pick<ProjectNativeSourceRead, 'items'>) => Promise<void>;
  readonly libraryActions: LibraryClientActions;
  readonly openLibraryOriginal: (target: LibraryTarget) => Promise<void>;
  readonly overviewActions: OverviewClientActions;
  readonly overviewSource: (
    projectId: ProjectId,
    reference: OverviewSourceRef,
  ) => Promise<OverviewSourceView>;
  readonly memoryActions: (projectId: ProjectId) => ProjectMemorySettingsActions;
  readonly scheduleActions: (projectId: ProjectId) => ScheduleSettingsActions;
  readonly executionDefaultsActions: (
    projectId: ProjectId,
  ) => ExecutionDefaultsActions;
  readonly projectInstructionsActions: (projectId: ProjectId) => ProjectInstructionsActions;
  readonly sessionInstructionsActions: (
    projectId: ProjectId,
    sessionId: ProjectSessionId,
  ) => SessionInstructionsActions;
  readonly settingsEnvironment: (
    projectId: ProjectId,
    sessionId: ProjectSessionId,
  ) => Promise<ProjectEnvironmentView>;
  readonly usageActions: ProjectUsageActions;
  readonly watchProject: (detail: ProjectDetail) => void;
  /** Claim a viewing intent without changing the current screen; assert after each awaited read. */
  readonly beginNavigation: () => () => void;
  readonly openTarget: (
    projectId: ProjectId,
    target: ProjectNavigationTarget,
    expectedCarrier?: { readonly hostSessionId: string; readonly sessionCreatedAt?: number | undefined },
  ) => Promise<void>;
  readonly activate: (
    detail: ProjectDetail,
    executionSessionId?: ProjectSessionId,
  ) => ProjectPanelReferences;
  readonly focusConversationInput?: (role: "main" | "execution") => void;
  readonly release: () => void;
}

/** Project and navigation callbacks; the product's file owner supplies file actions. */
export type ProjectsPanelCoreActions = Omit<
  ProjectsPanelActions,
  'hooks' | 'readConversationFile' | 'dismissConversationFile' | 'returnToFileConversation'
> & {
  readonly hooks: Omit<ProjectsPanelActions['hooks'], 'projectFileRequest'>;
};

function valueOf<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, details: result.error.details });
  return result.value;
}

function nativeProjectSource(
  source: StoredMemorySource,
): NativeProjectSource | undefined {
  if (source.kind === "native-event") return source;
  if (source.kind === "message")
    return {
      kind: "message",
      hostSessionId: source.hostSessionId,
      messageId: source.messageId,
    };
  if (source.kind === "tool")
    return {
      kind: "tool",
      hostSessionId: source.hostSessionId,
      toolCallId: source.toolCallId,
    };
  return undefined;
}

function nativeSourceText(read: ProjectNativeSourceRead): string {
  if (!read.resolved)
    throw new Error(read.reason ?? "Project source is unavailable");
  const text = read.items
    .filter((item) => item.isTarget)
    .map((item) => item.text)
    .filter((item) => item.trim() !== "")
    .join("\n\n");
  if (text === "")
    throw new Error(read.reason ?? "Project source has no displayable text");
  return read.reason === undefined || read.reason.trim() === ""
    ? text
    : `${text}\n\n${read.reason}`;
}

function mainSession(detail: ProjectDetail): ProjectSessionRecord {
  const session = detail.sessions.find(
    (candidate) => candidate.role === "main",
  );
  if (session === undefined)
    throw new Error(`Projects detail ${detail.project.id} has no main session`);
  return session;
}

function executionSession(
  detail: ProjectDetail,
  sessionId: ProjectSessionId | undefined,
): ProjectSessionRecord | undefined {
  if (sessionId === undefined) return undefined;
  return detail.sessions.find(
    (candidate) => candidate.id === sessionId && candidate.role === "execution",
  );
}

/**
 * Identify a committed carrier using its native header creation time when known.
 * @param session - logical session from the current Store snapshot.
 * @returns exact current carrier comparison key.
 */
export function projectCarrierIdentity(session: ProjectSessionRecord): string {
  const current = session.carriers?.find(carrier => carrier.isCurrent && carrier.hostSessionId === session.hostSessionId);
  return `${session.hostSessionId}:${current?.sessionCreatedAt ?? "unknown"}`;
}

/** Owns one exact reference through retirement and its committed Provider occurrences. */
class ProjectReferenceOwner {
  private mounts = 0;
  private retired = false;
  private released = false;
  constructor(readonly reference: SessionReference, readonly readOnly: boolean, private readonly onRelease: () => void) {}
  mount(): () => void {
    if (this.released) throw new Error("Projects screen reference is retired");
    this.mounts++;
    let mounted = true;
    return () => { if (!mounted) return; mounted = false; this.mounts--; this.finish(); };
  }
  retire(): void { this.retired = true; this.finish(); }
  holdUntil(pending: Promise<void>): void {
    const release = this.mount();
    void pending.then(release, release);
  }
  private finish(): void {
    if (!this.retired || this.mounts !== 0 || this.released) return;
    this.released = true;
    this.reference.release(); this.onRelease();
  }
}

/** Holds the exact two Client Session references while this Projects panel is open. */
export class ProjectsPanelController {
  private currentReferences: ProjectPanelReferences | undefined;
  private readonly bindingHolds = new Set<() => void>();
  private main: ProjectReferenceOwner | undefined;
  private execution: ProjectReferenceOwner | undefined;
  /** Only live screen owners awaiting their committed unmount; no business state is duplicated. */
  private readonly referenceOwners = new Set<ProjectReferenceOwner>();
  private readonly pendingTerminalization = new Set<SessionId>();
  private executionProjectSessionId: ProjectSessionId | undefined;
  private detail: ProjectDetail | undefined;
  private readonly unavailableSources = new Map<string, ProjectUnavailableSource>();
  private readonly detailListeners = new Set<() => void>();
  private navigation: ProjectPanelNavigation | undefined;
  private readonly navigationListeners = new Set<() => void>();
  private navigationId = 0;
  private watchedProjectId: ProjectId | undefined;
  private watch: RemoteStreamHandle<ProjectDetail, never> | undefined;
  private watchEpoch = 0;
  private watchInterruption: ProjectWatchInterruption | undefined;
  private readonly watchInterruptionListeners = new Set<() => void>();
  private readonly watchInterruptionSource: HostObservable<ProjectWatchInterruption | undefined> = {
    getSnapshot: () => this.watchInterruption,
    subscribe: listener => { this.watchInterruptionListeners.add(listener); return () => { this.watchInterruptionListeners.delete(listener); }; },
  };
  private memoryWatch: RemoteStreamHandle<ProjectMemoryNotice, never> | undefined;
  private memoryWatchAbort: AbortController | undefined;
  private memoryNotice: ProjectMemoryNotice | undefined;
  private readonly memoryNoticeListeners = new Set<() => void>();
  private readonly memoryNoticeSource: HostObservable<ProjectMemoryNotice | undefined> = {
    getSnapshot: () => this.memoryNotice,
    subscribe: (listener) => {
      this.memoryNoticeListeners.add(listener);
      return () => { this.memoryNoticeListeners.delete(listener); };
    },
  };
  private readonly unsubscribeGeneration: (() => void) | undefined;
  private readonly detailSource: HostObservable<ProjectDetail | undefined> = {
    getSnapshot: () => this.detail,
    subscribe: (listener) => {
      this.detailListeners.add(listener);
      return () => {
        this.detailListeners.delete(listener);
      };
    },
  };
  private readonly navigationSource: HostObservable<
    ProjectPanelNavigation | undefined
  > = {
    getSnapshot: () => this.navigation,
    subscribe: (listener) => {
      this.navigationListeners.add(listener);
      return () => {
        this.navigationListeners.delete(listener);
      };
    },
  };

  constructor(
    private readonly remote: ProjectsRemote,
    private readonly sessions: Pick<ISessions, "retain">,
    private readonly nativeFiles?: NativeFileOpenPort,
    connectionGeneration?: HostObservable<unknown>,
    private readonly bindings?: ProjectPanelBindingPort,
    private readonly focusInput?: (sessionId: SessionId) => void,
  ) {
    this.unsubscribeGeneration = connectionGeneration?.subscribe(() => {
      if (connectionGeneration.getSnapshot() !== undefined && this.watchedProjectId !== undefined) {
        this.startWatch(this.watchedProjectId);
      } else {
        this.stopMemoryWatching();
      }
    });
  }

  actions(): ProjectsPanelCoreActions {
    return {
      hooks: {
        projectDetail: this.detailSource,
        projectWatchInterruption: this.watchInterruptionSource,
        projectMemoryNotice: this.memoryNoticeSource,
        projectNavigation: this.navigationSource,
      },
      deleteExecutionSession: async input => {
        const epoch = this.watchEpoch;
        this.bindings?.beforePermanentDelete?.({ kind: 'execution', request: input });
        const result = valueOf(await this.remote.deleteExecutionSession(input));
        this.applySourceInvalidations(result.detail);
        if (this.watchedProjectId === input.projectId && this.watchEpoch === epoch) this.watchProject(result.detail);
        return result;
      },
      deleteProject: async input => {
        const epoch = this.watchEpoch;
        this.bindings?.beforePermanentDelete?.({ kind: 'project', request: input });
        const result = valueOf(await this.remote.deleteProject(input));
        this.applySourceInvalidations(result.detail);
        if (this.watchedProjectId === input.projectId && this.watchEpoch === epoch) {
          if (result.detail.project.sourceLifecycle?.kind === "deleted") this.release();
          else this.watchProject(result.detail);
        }
        return result;
      },
      executionLifecycle: async input => {
        const epoch = this.watchEpoch;
        const result = valueOf(await this.remote.executionLifecycle(input));
        this.applySourceInvalidations(result.detail);
        if (this.watchedProjectId === input.projectId && this.watchEpoch === epoch) this.watchProject(result.detail);
        return result;
      },
      projectLifecycle: async input => {
        const epoch = this.watchEpoch;
        const result = valueOf(await this.remote.projectLifecycle(input));
        this.applySourceInvalidations(result.detail);
        if (this.watchedProjectId === input.projectId && this.watchEpoch === epoch) {
          this.watchProject(result.detail);
        }
        return result;
      },
      listProjects: async () => valueOf(await this.remote.list())
        .filter(project => project.sourceLifecycle?.kind !== "deleted"),
      createProject: async (input) => {
        const result = valueOf(await this.remote.create(input));
        this.applySourceInvalidations(result.detail);
        return result;
      },
      getProject: async (projectId) => {
        const detail = valueOf(await this.remote.get({ projectId }));
        this.applySourceInvalidations(detail);
        return detail;
      },
      readProjectSnapshot: async (projectId, signal) => {
        signal?.throwIfAborted();
        try {
          const result = await this.remote.get({ projectId }, signal);
          signal?.throwIfAborted();
          return valueOf(result);
        } catch (error) {
          signal?.throwIfAborted();
          throw error;
        }
      },
      createExecutionSession: async (input) => {
        const detail = valueOf(await this.remote.createSession(input));
        this.applySourceInvalidations(detail);
        return detail;
      },
      renameExecutionSession: async input => {
        const epoch = this.watchEpoch;
        const result = valueOf(await this.remote.renameExecutionSession(input));
        this.applySourceInvalidations(result.detail);
        if (this.watchedProjectId === input.projectId && this.watchEpoch === epoch) this.watchProject(result.detail);
        return result;
      },
      updateProject: async (input) => {
        const epoch = this.watchEpoch;
        let detail: ProjectDetail;
        try { detail = valueOf(await this.remote.update(input)); }
        catch (error) {
          const failure = error as { code?: string; details?: { current?: ProjectDetail } };
          const current = failure.code === 'projects/update-conflict' ? failure.details?.current : undefined;
          if (current?.project.id === input.projectId) {
            this.applySourceInvalidations(current);
            if (this.watchedProjectId === input.projectId && this.watchEpoch === epoch) this.watchProject(current);
          }
          throw error;
        }
        this.applySourceInvalidations(detail);
        // 保存属于打开前的项目；较晚返回不能覆盖已经切换的当前页面。
        if (
          this.watchedProjectId === input.projectId &&
          this.watchEpoch === epoch
        )
          this.watchProject(detail);
        return detail;
      },
      readProjectSource: async (projectId, source, signal) =>
        this.sourceRead(source, valueOf(await this.remote.readSource({ projectId, source }, signal))),
      queryHistory: async (projectId, request, signal) => {
        const result = valueOf(await this.remote.queryHistory({ projectId, ...request }, signal));
        const unavailable = result.items.filter(item => this.unavailableSources.has(item.session.hostSessionId));
        if (unavailable.length === 0) return result;
        const items = result.items.filter(item => !this.unavailableSources.has(item.session.hostSessionId));
        return { status: items.length === 0 ? "unavailable" : "partial", items,
          limitations: [...result.limitations, "部分来源会话正在删除或已删除，原聊天不可读取。"] };
      },
      readHistory: async (projectId, request, signal) => {
        const result = valueOf(await this.remote.readHistory({ projectId, ...request }, signal));
        const unavailable = this.unavailableSources.get(request.source.kind === 'communication-part' ? request.source.holder.hostSessionId : request.source.hostSessionId);
        return unavailable === undefined ? result : { status: "unavailable", found: false, items: [],
          limitations: [], reason: this.unavailableReason(unavailable) };
      },
      locateProjectSource: async (projectId, source, read) => {
        const assertCurrent = this.beginNavigation();
        const detail = await this.readNavigationProject(projectId, assertCurrent);
        this.applySourceInvalidations(detail);
        const target = projectSourceNavigation(detail, source, read);
        if (target === undefined) throw new Error('这条来源没有可定位的原会话坐标；仍可读取原话。');
        const session = detail.sessions.find(row => row.id === target.sessionId);
        const carrier = session?.carriers?.find(row => row.isCurrent && row.hostSessionId === session.hostSessionId);
        assertCurrent();
        const assertOpened = await this.openTarget(projectId, target, target.source === undefined ? { hostSessionId: source.hostSessionId,
          sessionCreatedAt: carrier?.sessionCreatedAt } : undefined);
        assertOpened();
        await this.bindings?.onSourceFocus?.({ detail, source, read });
      },
      openLibraryOriginal: async target => {
        if (target.kind === 'url') throw new Error('网页请使用原网页链接打开。');
        if (this.nativeFiles === undefined || !valueOf(await this.nativeFiles.canOpenWorkspacePath())) {
          throw new Error('当前宿主不支持本机打开；仍可读取实际文件预览。');
        }
        valueOf(await this.nativeFiles.openWorkspacePath({ path: target.path }));
      },
      libraryActions: {
        list: async (input, signal) => {
          signal?.throwIfAborted();
          const value = valueOf(await this.remote.libraryList(input, signal));
          signal?.throwIfAborted();
          return value;
        },
        add: async (input) => valueOf(await this.remote.libraryAdd(input)),
        open: async (input, signal) => {
          signal?.throwIfAborted();
          const value = valueOf(await this.remote.libraryOpen(input, signal));
          signal?.throwIfAborted();
          return value;
        },
        remove: async (input) => {
          await valueOf(await this.remote.libraryRemove(input));
        },
      },
      overviewActions: {
        read: async (input) => valueOf(await this.remote.overviewRead(input)),
      },
      overviewSource: async (projectId, reference) =>
        valueOf(await this.remote.overviewSource({ projectId, reference })),
      memoryActions: (projectId) => this.memoryActions(projectId),
      scheduleActions: (projectId) => ({
        read: async () => valueOf(await this.remote.scheduleRead({ projectId })),
        save: async (input) => valueOf(await this.remote.scheduleSave({
          projectId, input, changeId: crypto.randomUUID(),
        })),
        setEnabled: async (scheduleId, enabled, expectedRevision) => valueOf(await this.remote.scheduleSetEnabled({
          projectId, scheduleId, enabled, expectedRevision, changeId: crypto.randomUUID(),
        })),
        remove: async (scheduleId, expectedRevision) => valueOf(await this.remote.scheduleRemove({
          projectId, scheduleId, expectedRevision, changeId: crypto.randomUUID(),
        })),
        // 一次点击产生的请求身份原样传给 Remote；传输重试不能变成另一项运行。
        runNow: async (input) => valueOf(await this.remote.scheduleRunNow({ projectId, input })),
      }),
      executionDefaultsActions: (projectId) => ({
        read: async () =>
          valueOf(await this.remote.executionDefaultsRead({ projectId })),
        save: async (selection, expectedRevision) =>
          valueOf(
            await this.remote.executionDefaultsSave({
              projectId,
              selection,
              expectedRevision,
            }),
          ),
      }),
      projectInstructionsActions: (projectId) => ({
        read: async () => valueOf(await this.remote.projectInstructionsRead({ projectId })),
        save: async (text, expectedRevision) => valueOf(await this.remote.projectInstructionsSave({ projectId, text, expectedRevision })),
      }),
      sessionInstructionsActions: (projectId, sessionId) => ({
        read: async () =>
          valueOf(
            await this.remote.sessionInstructionsRead({ projectId, sessionId }),
          ),
        save: async (text, expectedRevision) =>
          valueOf(
            await this.remote.sessionInstructionsSave({
              projectId,
              sessionId,
              text,
              expectedRevision,
            }),
          ),
      }),
      settingsEnvironment: async (projectId, sessionId) =>
        valueOf(
          await this.remote.settingsEnvironment({ projectId, sessionId }),
        ),
      usageActions: {
        query: async (query, signal) => valueOf(await this.remote.usage(query, signal)),
        subscribe: (projectId, refresh) => {
          let active = true;
          const stream = this.remote.watchUsage({ projectId });
          void (async () => {
            for await (const frame of stream) {
              if (!active) return;
              if (frame.projectId === projectId) refresh();
            }
          })().catch(() => {
            // Keep manual refresh available; a broken notification stream is not usage data.
          });
          return () => {
            active = false;
            stream.dispose();
          };
        },
      },
      watchProject: (detail) => {
        this.watchProject(detail);
      },
      beginNavigation: () => this.beginNavigation(),
      openTarget: async (projectId, target, expectedCarrier) => {
        await this.openTarget(projectId, target, expectedCarrier);
      },
      focusConversationInput: role => {
        const owner = role === "main" ? this.main : this.execution;
        if (owner !== undefined) this.focusInput?.(owner.reference.sessionId);
      },
      activate: (detail, executionSessionId) =>
        this.activate(detail, executionSessionId),
      release: () => {
        this.release();
      },
    };
  }

  private memoryActions(projectId: ProjectId): ProjectMemorySettingsActions {
    return {
      list: async () => valueOf(await this.remote.memoryList({ projectId })),
      read: async (id) =>
        valueOf(await this.remote.memoryRead({ projectId, id })),
      save: async (input) =>
        valueOf(await this.remote.memorySave({ projectId, input })),
      withdraw: async (id, expectedRevision, expectedGeneration) =>
        valueOf(
          await this.remote.memoryWithdraw({ projectId, id, expectedRevision,
            ...(expectedGeneration === undefined ? {} : { expectedGeneration }) }),
        ),
      readSource: async (source) => this.readMemorySource(projectId, source),
      readSourceEvidence: async source => valueOf(await this.remote.memorySource({ projectId, source })),
      readSourceContent: async content => valueOf(await this.remote.memorySourceContent({ projectId, content })),
    };
  }

  private async readMemorySource(
    projectId: ProjectId,
    source: StoredMemorySource,
  ): Promise<string> {
    const native = nativeProjectSource(source);
    if (native !== undefined)
      return nativeSourceText(
        this.sourceRead(native, valueOf(await this.remote.readSource({ projectId, source: native }))),
      );
    // The Memory owner alone interprets legacy record/file/settings locators; Projects no longer has a record source API.
    const read = valueOf(await this.remote.memorySource({ projectId, source }));
    if (!read.readable) throw new Error(read.reason ?? '来源当前不可读。');
    return [read.text ?? '', ...(read.partial ? ['仅显示有限原文；完整正文请使用来源分页入口。'] : []), ...(read.limitations ?? [])].join('\n');
  }

  activate(
    detail: ProjectDetail,
    executionSessionId?: ProjectSessionId,
  ): ProjectPanelReferences {
    this.applySourceInvalidations(detail);
    if (detail.project.sourceLifecycle !== undefined) throw new Error("项目正在删除或已删除，只能查看处理结果。");
    const main = mainSession(detail);
    if (this.unavailableSources.has(main.hostSessionId)) throw new Error("项目主会话来源已不可用。");
    const candidate = executionSession(detail, executionSessionId);
    const execution = candidate !== undefined && !this.unavailableSources.has(candidate.hostSessionId) ? candidate : undefined;
    const projectReadOnly = detail.project.archived || detail.pendingRestores?.some(item => item.scope === "project") === true;
    const mainReadOnly = projectReadOnly || detail.modelInitializationErrors?.some(item => item.hostSessionId === main.hostSessionId) === true;
    const executionReadOnly = projectReadOnly || execution?.archived === true
      || detail.modelInitializationErrors?.some(item => item.hostSessionId === execution?.hostSessionId) === true
      || detail.pendingRestores?.some(item => item.scope === "session" && item.sessionId === execution?.id) === true;
    this.bindings?.adoptDetail(detail);
    const previousMain = this.main;
    const previousExecution = this.execution;
    const mainIdentity = projectCarrierIdentity(main);
    const previousIdentity = this.currentReferences?.mainIdentity;
    this.main = this.replace(this.main, main.hostSessionId, mainReadOnly, previousIdentity !== undefined && previousIdentity !== mainIdentity);
    this.execution = this.replace(this.execution, execution?.hostSessionId, executionReadOnly, this.currentReferences?.executionIdentity !== undefined && this.currentReferences.executionIdentity !== (execution === undefined ? undefined : projectCarrierIdentity(execution)));
    this.executionProjectSessionId = execution?.id;
    const current = this.currentReferences;
    if (current?.main.reference === this.main.reference && current.execution?.reference === this.execution?.reference
      && current.mainIdentity === mainIdentity && current.executionIdentity === (execution === undefined ? undefined : projectCarrierIdentity(execution)) && current.main.readOnly === mainReadOnly && current.execution?.readOnly === (execution === undefined ? undefined : executionReadOnly)) return current;
    const mainOwner = this.main, executionOwner = this.execution;
    const present = (owner: ProjectReferenceOwner, session: ProjectSessionRecord, readOnly: boolean): ProjectPanelReference => ({
      reference: owner.reference, readOnly, detail, session,
    });
    const pending: Promise<void>[] = [];
    const bind = (owner: ProjectReferenceOwner, session: ProjectSessionRecord, readOnly: boolean, previous: ProjectReferenceOwner | undefined): void => {
      const operation = this.bindings?.onLogicalBinding({ detail, session, reference: owner.reference, readOnly,
        ...(previous === undefined ? {} : { previousHostSessionId: previous.reference.sessionId }) });
      if (operation !== undefined) {
        const ready = Promise.resolve(operation);
        const release = owner.mount();
        this.bindingHolds.add(release);
        void ready.then(() => { this.bindingHolds.delete(release); release(); }, () => { this.bindingHolds.delete(release); release(); });
        pending.push(ready);
      }
    };
    bind(mainOwner, main, mainReadOnly, previousMain);
    if (executionOwner !== undefined && execution !== undefined) bind(executionOwner, execution, executionReadOnly, previousExecution);
    const inputReady = pending.length === 0 ? undefined : Promise.all(pending).then(() => {});
    // Initial presentation may be canceled before React subscribes to this promise.
    void inputReady?.catch(() => {});
    this.currentReferences = {
      main: present(mainOwner, main, mainReadOnly), mainIdentity, executionIdentity: execution === undefined ? undefined : projectCarrierIdentity(execution),
      ...(inputReady === undefined ? {} : { inputReady }),
      execution: executionOwner === undefined || execution === undefined ? undefined : present(executionOwner, execution, executionReadOnly),
      executionSessionId: execution?.id,
      mount: () => {
        const mainUnmount = mainOwner.mount(), executionUnmount = executionOwner?.mount();
        return () => { executionUnmount?.(); mainUnmount(); };
      },
    };
    return this.currentReferences;
  }

  release(): void {
    this.navigationId++;
    this.stopWatching();
    this.publishNavigation(undefined);
    const main = this.main, execution = this.execution;
    this.currentReferences = undefined; this.main = undefined; this.execution = undefined;
    this.executionProjectSessionId = undefined;
    for (const release of this.bindingHolds) release();
    this.bindingHolds.clear();
    execution?.retire(); main?.retire();
  }

  /** End the root controller lifetime, including connection-generation observation. */
  dispose(): void {
    this.unsubscribeGeneration?.();
    this.release();
  }

  /** Publish the current snapshot and consume later commits for this Project only. */
  private watchProject(detail: ProjectDetail): void {
    const projectId = detail.project.id;
    if (this.watchedProjectId === projectId) {
      this.publishDetail(detail);
      return;
    }
    this.stopWatching();
    this.publishDetail(detail);
    this.watchedProjectId = projectId;
    this.startWatch(projectId);
  }

  /** A physical watch ends with its carrier; each ready connection needs a fresh Store snapshot. */
  private startWatch(projectId: ProjectId): void {
    const epoch = ++this.watchEpoch;
    this.stopMemoryWatching();
    const previous = this.watch;
    this.watch = undefined;
    previous?.dispose();
    try {
      const stream = this.remote.watch({ projectId });
      this.watch = stream;
      void this.consumeWatch(projectId, stream, epoch);
    } catch (error: unknown) {
      console.warn("[projects] could not start Project watch:", error);
      this.publishWatchInterruption({ projectId, message: error instanceof Error ? error.message : String(error) });
    }
    if (this.detail?.project.sourceLifecycle === undefined) this.startMemoryWatch(projectId, epoch);
  }

  private startMemoryWatch(projectId: ProjectId, epoch: number): void {
    const abort = new AbortController();
    this.memoryWatchAbort = abort;
    try {
      const stream = this.remote.watchMemoryChanges({ projectId }, abort.signal);
      this.memoryWatch = stream;
      void (async () => {
        for await (const notice of stream) {
          if (this.memoryWatch !== stream || this.watchEpoch !== epoch ||
            this.watchedProjectId !== projectId || abort.signal.aborted) return;
          if (notice.projectId !== projectId) continue;
          this.publishMemoryNotice(notice);
        }
      })().catch(() => {
        // 通知不代表记忆数据；断流后只等现有连接换代重订阅，不重放成功。
      });
    } catch (error: unknown) {
      console.warn("[projects] could not start Memory notice watch:", error);
    }
  }

  private stopMemoryWatching(): void {
    const stream = this.memoryWatch;
    this.memoryWatch = undefined;
    this.memoryWatchAbort?.abort();
    this.memoryWatchAbort = undefined;
    stream?.dispose();
    this.publishMemoryNotice(undefined);
  }

  private publishMemoryNotice(notice: ProjectMemoryNotice | undefined): void {
    if (this.memoryNotice === notice) return;
    this.memoryNotice = notice;
    for (const listener of this.memoryNoticeListeners) listener();
  }

  private async consumeWatch(
    projectId: ProjectId,
    stream: RemoteStreamHandle<ProjectDetail, never>,
    epoch: number,
  ): Promise<void> {
    let message: string | undefined;
    try {
      for await (const detail of stream) {
        if (
          this.watch !== stream ||
          this.watchedProjectId !== projectId ||
          this.watchEpoch !== epoch
        )
          return;
        if (detail.project.id !== projectId) continue;
        this.publishWatchInterruption(undefined);
        this.publishDetail(detail);
      }
    } catch (error: unknown) {
      if (
        this.watch === stream &&
        this.watchedProjectId === projectId &&
        this.watchEpoch === epoch
      ) {
        console.warn("[projects] Project watch stopped:", error);
        message = error instanceof Error ? error.message : String(error);
      }
    } finally {
      // 正常终态同样不再提供更新；切项目、主动关闭和旧连接退出不误报。
      if (this.watch === stream && this.watchedProjectId === projectId && this.watchEpoch === epoch
        && this.detail?.project.sourceLifecycle === undefined) {
        this.publishWatchInterruption({ projectId, ...(message === undefined ? {} : { message }) });
      }
    }
  }

  private publishWatchInterruption(value: ProjectWatchInterruption | undefined): void {
    if (this.watchInterruption === value) return;
    this.watchInterruption = value;
    for (const listener of this.watchInterruptionListeners) listener();
  }

  private stopWatching(): void {
    this.watchEpoch++;
    this.publishWatchInterruption(undefined);
    this.stopMemoryWatching();
    const stream = this.watch;
    this.watch = undefined;
    this.watchedProjectId = undefined;
    stream?.dispose();
    this.publishDetail(undefined);
  }

  private publishDetail(detail: ProjectDetail | undefined): void {
    if (detail !== undefined) { this.bindings?.adoptDetail(detail); this.applySourceInvalidations(detail); }
    if (detail?.project.sourceLifecycle !== undefined) this.stopMemoryWatching();
    if (this.detail === detail) return;
    this.detail = detail;
    for (const listener of this.detailListeners) listener();
  }

  /** Refuse reads immediately; withdraw mounted Providers before terminalizing their binding. */
  private applySourceInvalidations(detail: ProjectDetail): void {
    for (const source of detail.unavailableSources) {
      this.unavailableSources.set(source.hostSessionId, source);
      const id = source.hostSessionId as SessionId;
      this.pendingTerminalization.add(id);
      if (this.main?.reference.sessionId === id) {
        const owner = this.main; this.main = undefined; this.currentReferences = undefined; owner.retire();
      }
      if (this.execution?.reference.sessionId === id) {
        const owner = this.execution; this.execution = undefined; this.currentReferences = undefined;
        this.executionProjectSessionId = undefined; owner.retire();
      }
    }
    this.flushTerminalizations();
  }

  private flushTerminalizations(): void {
    for (const id of this.pendingTerminalization) {
      if ([...this.referenceOwners].some(owner => owner.reference.sessionId === id)) continue;
      this.pendingTerminalization.delete(id);
      this.bindings?.sourceInvalidated?.(id);
    }
  }

  private sourceRead(source: NativeProjectSource, read: ProjectNativeSourceRead): ProjectNativeSourceRead {
    const unavailable = this.unavailableSources.get(source.hostSessionId);
    return unavailable === undefined ? read : { resolved: false, hostSessionId: source.hostSessionId,
      items: [], reason: this.unavailableReason(unavailable) };
  }

  private unavailableReason(source: ProjectUnavailableSource): string {
    return source.kind === "deleted" ? "来源会话已删除。"
      : source.kind === "deleting" ? "来源会话删除处理中。" : "来源会话删除部分完成，原聊天不可读取。";
  }

  private async openTarget(
    projectId: ProjectId,
    target: ProjectNavigationTarget,
    expectedCarrier?: { readonly hostSessionId: string; readonly sessionCreatedAt?: number | undefined },
  ): Promise<() => void> {
    const assertCurrent = this.beginNavigation();
    const requestId = this.navigationId;
    const detail = await this.readNavigationProject(projectId, assertCurrent);
    this.applySourceInvalidations(detail);
    this.assertTarget(detail, target);
    if (expectedCarrier !== undefined) {
      const session = detail.sessions.find(row => row.id === target.sessionId);
      const carrier = session?.carriers?.find(row => row.isCurrent && row.hostSessionId === session.hostSessionId);
      if (session?.hostSessionId !== expectedCarrier.hostSessionId
        || expectedCarrier.sessionCreatedAt !== undefined && carrier?.sessionCreatedAt !== expectedCarrier.sessionCreatedAt)
        throw new Error('原聊天载体已变化；请重新读取来源后定位。');
    }
    const keepExecution =
      this.watchedProjectId === projectId
        ? this.executionProjectSessionId
        : undefined;
    this.watchProject(detail);
    this.publishNavigation({
      id: requestId, detail, target,
      executionSessionId: target.kind === "execution" ? target.sessionId : keepExecution,
    });
    return assertCurrent;
  }

  /** Existing generation is shared by body links, cards, and exact-source navigation. */
  private beginNavigation(): () => void {
    const requestId = ++this.navigationId;
    return () => {
      if (requestId !== this.navigationId) throw new DOMException('Project navigation was superseded or closed', 'AbortError');
    };
  }

  private async readNavigationProject(projectId: ProjectId, assertCurrent: () => void): Promise<ProjectDetail> {
    const result = await this.remote.get({ projectId }).catch(error => { assertCurrent(); throw error; });
    assertCurrent();
    return valueOf(result);
  }

  private assertTarget(
    detail: ProjectDetail,
    target: ProjectNavigationTarget,
  ): void {
    if (detail.project.sourceLifecycle !== undefined) throw new Error("项目正在删除或已删除，来源不可用。");
    const session = detail.sessions.find(
      (candidate) => candidate.id === target.sessionId,
    );
    if (session === undefined || session.role !== target.kind)
      throw new Error(
        `Projects session target is not part of ${detail.project.id}: ${target.sessionId}`,
      );
    if (target.source !== undefined) {
      const source = target.source;
      const carrier = session.carriers?.find(row => row.hostSessionId === source.hostSessionId);
      if (source.kind !== 'native-event' || source.version !== 1 || source.projectId !== detail.project.id || source.sessionId !== session.id
        || carrier?.sourceKind !== 'available' || carrier.sessionCreatedAt !== source.sessionCreatedAt
        || this.unavailableSources.has(source.hostSessionId))
        throw new Error('Exact retained navigation source is unavailable.');
    } else if (this.unavailableSources.has(session.hostSessionId)) {
      throw new Error('Current navigation target is unavailable.');
    }
  }

  private publishNavigation(
    navigation: ProjectPanelNavigation | undefined,
  ): void {
    this.navigation = navigation;
    for (const listener of this.navigationListeners) listener();
  }

  private replace(current: ProjectReferenceOwner | undefined, sessionId: string, readOnly: boolean, force?: boolean): ProjectReferenceOwner;
  private replace(current: ProjectReferenceOwner | undefined, sessionId: string | undefined, readOnly: boolean, force?: boolean): ProjectReferenceOwner | undefined;
  private replace(current: ProjectReferenceOwner | undefined, sessionId: string | undefined, readOnly: boolean, force = false): ProjectReferenceOwner | undefined {
    if (sessionId === undefined) { current?.retire(); return undefined; }
    if (!force && current?.reference.sessionId === sessionId && current.readOnly === readOnly) return current;
    const options: SessionRetainOptions = { source: "projectsPanel" };
    const reference = this.bindings?.retainPanelSession === undefined
      ? this.sessions.retain(sessionId as SessionId, options)
      : this.bindings.retainPanelSession(sessionId as SessionId, options, readOnly);
    const owner = new ProjectReferenceOwner(reference, readOnly, () => { this.referenceOwners.delete(owner); this.flushTerminalizations(); });
    this.referenceOwners.add(owner);
    current?.retire();
    return owner;
  }

}
