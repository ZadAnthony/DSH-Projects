import type { SessionHeader } from "@deepseek-ai/dsh-session/types";
import type { NativeProjectSource } from "./source-reference-types.ts";

/** 本地 Projects 记录使用的稳定标识。 */
export type ProjectId = string;

/** 单个 Projects 会话绑定的稳定标识。 */
export type ProjectSessionId = string;

/** 只记录项目会话的产品角色；不映射为 DSH 的运行生命周期。 */
export type ProjectWorkSessionRole = "main" | "execution";
export type ProjectSessionRole = ProjectWorkSessionRole | "memory" | "session-manager";

export type SessionCleanupStage =
  | "projection-cache"
  | "file-attachments"
  | "image-attachments"
  | "project-schedules"
  | "native-schedules"
  | "project-files"
  | "session-log"
  | "query-index"
  | "session-instructions"
  | "final-project-record";

/** 保存原四个实际 owner 已完成的有限结果；附件各阶段独立持有。 */
export interface SessionCleanupProgress {
  readonly projectSchedules?: "cleared";
  readonly nativeSchedules?: "cleared";
  readonly projectionCache?: "cleared";
  readonly sessionLog?: "removed" | "already-absent";
  readonly queryIndex?: "cleared" | "not-present";
  readonly sessionInstructions?: "removed" | "already-absent";
}

/** 只记录本次 typed file 身份与最终处理事实，不保存附件 bytes 或尝试历史。 */
export interface SessionFileDeletionResult {
  readonly kind: "file-alias" | "file-object";
  readonly ref: { readonly attachmentId: string; readonly name: string; readonly bytes: number };
  readonly outcome: "deleted" | "missing" | "retained-shared" | "retained-aliases" | "failed" | "unknown";
  readonly message?: string;
}

/** exact root 由首次文件删除 begin 固定；显式继续不能切换到另一个 provider。 */
export interface SessionFileDeletion {
  readonly contract: "file-v1";
  /** 新事务正向接纳的有限候选；旧v8–11继续仍可依原raw。 */
  readonly candidates?: readonly {readonly attachmentId:string;readonly name:string;readonly bytes:number}[];
  readonly root: string;
  readonly complete: boolean;
  readonly results: readonly SessionFileDeletionResult[];
}

/** 规范化后的完整来源身份；展示名与原输入尺寸不参与物理 source 身份。 */
export interface SessionImageDeletionRef {
  readonly attachmentId: string;
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly name?: string;
  readonly originalDimensions?: { readonly width: number; readonly height: number };
}

/** 首次 begin 冻结全部物理项；pending 不能表示已确认清理。 */
export type SessionImageDeletionResult = {
  readonly ref: SessionImageDeletionRef;
  readonly outcome: "pending" | "deleted" | "missing" | "retained-shared" | "failed" | "unknown";
  readonly message?: string;
} & (
  | { readonly kind: "image-object" }
  | { readonly kind: "image-variant"; readonly variantId: string }
  | { readonly kind: "legacy-image-variant"; readonly variantId: string }
);

/** 完整有限选集及 exact provider roots 只在首次 image-v1 begin 保存。 */
export interface SessionImageDeletion {
  readonly contract: "image-v1";
  readonly root: string;
  readonly cacheRoot: string;
  readonly coverage: "source-grouped-v2-and-positive-legacy";
  readonly complete: boolean;
  readonly results: readonly SessionImageDeletionResult[];
}

/** 原 native owner 已确认的 child 创建身份；不创建 Project 会话绑定。 */
export type SessionOwnedSessionHeader = SessionHeader;
/** 本次归档的真实停止结果已由原 owner 调用方确认；不是当前完整关系库。 */
export interface SessionOwnedLifecycle {
  readonly contract: "archive-v1";
  readonly rootHeader: SessionHeader;
  readonly members: readonly {
    readonly header: SessionHeader;
    readonly parentSessionId: string;
    readonly mode: "one-shot" | "continuable";
    readonly provider?: string;
  }[];
}
export interface SessionOwnedCleanupProgress extends Omit<SessionCleanupProgress, "sessionInstructions"> {
  readonly sessionInstructions?: "removed" | "already-absent" | "not-applicable";
}
export interface SessionOwnedDeletionMember {
  readonly header: SessionOwnedSessionHeader;
  readonly parentSessionId: string;
  readonly mode: "one-shot" | "continuable";
  readonly provider?: string;
  readonly progress: SessionOwnedCleanupProgress;
  readonly failure?: SessionCleanupFailure;
}
/** root 自身仍只使用原 progress；此结构只含有限 child 成员。 */
export interface SessionOwnedDeletion {
  readonly contract: "owned-v1";
  readonly members: readonly SessionOwnedDeletionMember[];
}
/** 终态仅留冷来源投影所需身份，不保留清理明细或可接续配置。 */
export interface SessionOwnedDeletedSources {
  readonly contract: "owned-v1";
  readonly members: readonly { readonly header: Pick<SessionOwnedSessionHeader, "id" | "createdAt"> }[];
}

export interface SessionCleanupFailure {
  readonly stage: SessionCleanupStage;
  readonly certainty: "failed" | "known-partial" | "unknown";
  readonly message: string;
  readonly knownRemovedArtifacts?: number;
  readonly knownRemainingArtifacts?: number;
}

export type ProjectSessionSourceLifecycle =
  | { readonly kind: "available" }
  | {
      readonly kind: "deleting";
      readonly requestedAt: string;
      readonly updatedAt: string;
      readonly scheduleDeletion?: true;
      readonly progress: SessionCleanupProgress;
      readonly fileDeletion?: SessionFileDeletion;
      readonly imageDeletion?: SessionImageDeletion;
      readonly ownedDeletion?: SessionOwnedDeletion;
    }
  | {
      readonly kind: "partial";
      readonly requestedAt: string;
      readonly updatedAt: string;
      readonly scheduleDeletion?: true;
      readonly progress: SessionCleanupProgress;
      readonly fileDeletion?: SessionFileDeletion;
      readonly imageDeletion?: SessionImageDeletion;
      readonly ownedDeletion?: SessionOwnedDeletion;
      readonly failure: SessionCleanupFailure;
    }
  | {
      readonly kind: "deleted";
      readonly requestedAt: string;
      readonly deletedAt: string;
      readonly ownedDeletion?: SessionOwnedDeletedSources;
    };

/** 当前记录只接受可以重开原生聊天的精确来源。 */
export type SourceRef = NativeProjectSource;

/**
 * 旧业务台账中的定位器仅供兼容读取；它不属于当前协作模型或写入 API。
 */
export type LegacySourceReference =
  | { kind: "record"; recordKind: string; recordId: string; revision?: number }
  | { kind: "control"; controlId: string };

/** 外部工作区只保存位置引用，不读取、复制或修改其中内容。 */
export interface WorkspaceReference {
  path: string;
}

/** 当前项目基础信息；项目整体目标正文由 overview owner 保存。 */
export interface Project {
  sourceLifecycle?: ProjectSourceLifecycle;
  id: ProjectId;
  name: string;
  workspace?: WorkspaceReference;
  mainSessionId?: ProjectSessionId;
  archived: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type ProjectSourceLifecycle =
  | { readonly kind: "deleting" | "partial"; readonly requestedAt: string; readonly updatedAt: string;
      readonly progress: { readonly projectFiles?: "removed" | "already-absent" };
      readonly failure?: SessionCleanupFailure }
  | { readonly kind: "deleted"; readonly requestedAt: string; readonly deletedAt: string };

/** 逻辑会话的一段真实 root 承载；原生 child 始终由 owned 关系独立表达。 */
export interface ProjectSessionCarrier {
  readonly sequence: number;
  readonly hostSessionId: string;
  readonly header?: SessionHeader;
  readonly isCurrent: boolean;
  /** 真实绑定时点；旧格式没有此事实时保持缺省。 */
  readonly boundAt?: string;
  /** 仅表示 owner 已确认的承载结束／退役，普通 Stop 和临时归档不写此字段。 */
  readonly closed?: { readonly confirmedAt: string; readonly reason: "ended" | "retired" };
  readonly sourceLifecycle: ProjectSessionSourceLifecycle;
  /** 仅旧 terminal：继承的时间是整项目删除边界，逐段真实发生时间未知。 */
  readonly lifecycleTimeBasis?: "project-deletion";
  readonly ownedLifecycle?: SessionOwnedLifecycle;
}

/** 稳定逻辑会话；host/source/owned 字段均从唯一 current carrier 派生。 */
export interface ProjectSession {
  id: ProjectSessionId;
  projectId: ProjectId;
  hostSessionId: string;
  /** Store 输出总有此字段；可选仅为兼容旧 DTO 构造者，不是关系写入入口。 */
  readonly carriers?: readonly ProjectSessionCarrier[];
  /** Exact reserved native roots; unpublished entries never grant working membership. */
  readonly mainPreparations?: readonly MainCarrierPreparation[];
  role: ProjectSessionRole;
  sourceLifecycle: ProjectSessionSourceLifecycle;
  title: string;
  archived: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** active 后只表示上次已确认操作的有限身份，不证明当前仍已停止。 */
  ownedLifecycle?: SessionOwnedLifecycle;
}

/** 项目会话之间一条不含聊天正文的运输记录。 */
export type DeliveryIntent =
  | "assign"
  | "change"
  | "report"
  | "question"
  | "coordination"
  | "continue";

/** 原生消息投递的实际回执。 */
export type DeliveryDispatch = "notDelivered" | "delivered";

/** 接收会话对交付的实际处理状态。 */
export type DeliveryProcessing = "pending" | "claimed" | "responded" | "discardedUnrun";

/** 历史 Delivery 的只读记录；旧处理状态不表示模型已读或已实际回信。 */
export interface LegacyDeliveryRecord {
  id: string;
  intent: DeliveryIntent;
  senderSessionId: ProjectSessionId;
  targetSessionId: ProjectSessionId;
  sources: SourceRef[];
  nativeMessageId?: string;
  continuesDeliveryId?: string;
  dispatch: DeliveryDispatch;
  processing: DeliveryProcessing;
  createdAt: string;
  updatedAt: string;
}

/** 历史读取名称保留，不存在对应旧writer。 */
export type Delivery = LegacyDeliveryRecord;

/** 创建空白项目所需的信息。 */
export interface CreateProjectInput {
  id?: ProjectId;
  name: string;
  workspace?: WorkspaceReference;
}

/** 可修改的项目基本信息。null 表示清除可选字段。 */
export interface ProjectPatch {
  name?: string;
  workspace?: WorkspaceReference | null;
}

/** 生命周期写入前冻结的最小 roster；展示字段不参与归档 CAS。 */
export interface ProjectSessionRosterEntry {
  readonly id: ProjectSessionId;
  readonly hostSessionId: string;
  readonly role: ProjectSessionRole;
  readonly archived: boolean;
  /** 多段逻辑操作必须包含完整、有序的 root host 列表。 */
  readonly carrierHostSessionIds?: readonly string[];
}

export interface ProjectOwnedLifecycleEntry {
  readonly sessionId: ProjectSessionId;
  readonly ownedLifecycle: SessionOwnedLifecycle;
  readonly carrierHostSessionId?: string;
  readonly hostSessionId?: string;
}

/** 只在真实停止、旧输入及保存已确认后调用；Store 不代替停止 owner。 */
export interface CommitExecutionArchiveInput {
  readonly sessionId: ProjectSessionId;
  readonly ownedLifecycle?: SessionOwnedLifecycle;
  readonly carrierLifecycles?: readonly { readonly hostSessionId: string; readonly ownedLifecycle: SessionOwnedLifecycle }[];
  readonly projectId: ProjectId;
  readonly expectedRevision: number;
}

/** 绑定前由 Host 预分配 hostSessionId，再持久化项目归属。 */
export interface BindSessionInput {
  id?: ProjectSessionId;
  hostSessionId: string;
  role: ProjectSessionRole;
  title: string;
  header?: SessionHeader;
}

export interface SessionCarrierMutationInput {
  readonly projectId: ProjectId;
  readonly sessionId: ProjectSessionId;
  readonly expectedRevision: number;
  readonly hostSessionId: string;
}

export interface BindSessionCarrierInput extends SessionCarrierMutationInput {
  readonly header?: SessionHeader;
  readonly boundAt?: string;
}

export interface ConfirmSessionCarrierHeaderInput extends SessionCarrierMutationInput {
  readonly header: SessionHeader;
}

export interface CloseSessionCarrierInput extends SessionCarrierMutationInput {
  readonly confirmedAt: string;
  readonly reason: "ended" | "retired";
}

/** 可修改的会话展示信息。 */
export interface ProjectSessionPatch {
  title?: string;
  archived?: boolean;
}

/** 基于调用方已读取的修订号执行乐观并发更新。 */
export interface RevisionOptions {
  expectedRevision?: number;
}

/** 仅供 Host 在确认预分配的 host session 从未创建后回滚新绑定。 */
export interface RemoveSessionBindingOptions {
  expectedHostSessionId: string;
}

/** 项目字段更新的实际结果。 */
export type ProjectUpdateResult =
  | { kind: "updated"; project: Project }
  | { kind: "conflict"; project: Project };

/** 只供整项目生命周期写入 archived 位的窄结果。 */
export type ProjectArchivedUpdateResult =
  | { kind: "updated"; snapshot: ProjectSnapshot }
  | { kind: "unchanged"; snapshot: ProjectSnapshot }
  | { kind: "conflict"; snapshot: ProjectSnapshot };

/** 会话字段更新的实际结果。 */
export type ProjectSessionUpdateResult =
  | { kind: "updated"; session: ProjectSession }
  | { kind: "conflict"; session: ProjectSession };

/** 删除动作只能在所读取的目标 revision 上推进。 */
export interface ExecutionSourceDeletionInput {
  projectId: ProjectId;
  sessionId: ProjectSessionId;
  expectedRevision: number;
  /** 多段删除必须明确原段；缺省只兼容单段记录。 */
  carrierHostSessionId?: string;
  hostSessionId?: string;
  fileDeletion?: SessionFileDeletion;
  imageDeletion?: SessionImageDeletion;
  ownedDeletion?: SessionOwnedDeletion;
  /** 只由同项目删除事务接管后的私有调用设置。 */
  projectDeletion?: true;
  scheduleDeletion?: true;
}

export interface RecordExecutionSourceDeletionInput extends ExecutionSourceDeletionInput {
  progress: SessionCleanupProgress;
  failure?: SessionCleanupFailure;
}

export type BeginExecutionSourceDeletionResult =
  | { kind: "started"; session: ProjectSession }
  | { kind: "conflict" | "already-deleting" | "already-deleted"; session: ProjectSession };

/** 来源定位所需的最小身份；没有打开、归档或运行资格。 */
export type ProjectSessionSource = Pick<ProjectSession,
  "id" | "projectId" | "hostSessionId" | "role" | "title" | "revision"
  | "createdAt" | "updatedAt" | "sourceLifecycle" | "ownedLifecycle"
> & {
  readonly projectDeletion?: true;
  readonly projectSessionId?: ProjectSessionId;
  readonly carrierSequence?: number;
  readonly isCurrentCarrier?: boolean;
  readonly header?: SessionHeader;
  readonly lifecycleTimeBasis?: "project-deletion";
};

/** 查询的 carrier 保留真实原段，session.hostSessionId 仍只表示当前指定入口。 */
export interface ProjectCarrierMembership extends ProjectMembership {
  readonly projectSessionId: ProjectSessionId;
  readonly carrier: ProjectSessionCarrier;
}

/** 已成功移除的预分配绑定。 */
export interface RemovedSessionBinding {
  project: Project;
  session: ProjectSession;
}

/** 通过 DSH host session id 查询到的项目归属。 */
export interface ProjectMembership {
  project: Project;
  session: ProjectSession;
}

/** 当前项目记录的完整投影，不暴露退休业务台账。 */
export interface ProjectSnapshot {
  project: Project;
  sessions: ProjectSession[];
  deliveries: Delivery[];
}

/** 一次成功落盘后的项目和会话快照。 */
export type ProjectRecordSnapshot = ProjectSnapshot;

/** 已提交项目记录的订阅回调。 */
export type ProjectRecordListener = (snapshot: ProjectRecordSnapshot) => void;

/** ProjectStore-owned preparation; creation and publication are separate durable facts. */
export interface MainCarrierPreparation {
  readonly attemptId: string
  readonly fromHeader: SessionHeader
  readonly toHostSessionId: string
  readonly toHeader?: SessionHeader
  readonly state: 'unpublished' | 'committed' | 'abandoned'
  readonly createdAt: string
  readonly updatedAt: string
  /** Native close does not remove the log, attachments, query index or usage source. */
  readonly retirement?: 'confirmed'
  /** Independent physical deletion owned by the existing whole-project deletion flow. */
  readonly sourceLifecycle?: ProjectSessionSourceLifecycle
}
/** Exact host ownership, including unpublished roots without carrier membership. */
export type ProjectHostOwnership =
  | { readonly kind: 'current' | 'historical'; readonly project: Project; readonly session: ProjectSession; readonly carrier: ProjectSessionCarrier }
  | { readonly kind: 'preparation'; readonly project: Project; readonly session: ProjectSession; readonly preparation: MainCarrierPreparation }
/** CAS input retained across the attempt's own successful technical writes. */
export interface MainPreparationInput {
  readonly projectId: string
  readonly sessionId: string
  readonly attemptId: string
  readonly expectedRevision: number
}
/** Reservation must precede the real native create. */
export interface ReserveMainPreparationInput extends MainPreparationInput {
  readonly fromHeader: SessionHeader
  readonly toHostSessionId: string
}
/** A preparation write returns the exact next revision; conflicts never refresh it silently. */
export type MainPreparationResult =
  | { readonly kind: 'updated'; readonly session: ProjectSession; readonly preparation: MainCarrierPreparation }
  | { readonly kind: 'conflict'; readonly session: ProjectSession }

/** Exact preparation cleanup target; never a carrier or an operational ProjectSession. */
export interface MainPreparationSourceDeletionInput extends MainPreparationInput {
  readonly hostSessionId: string
  readonly fileDeletion?: SessionFileDeletion
  readonly imageDeletion?: SessionImageDeletion
  readonly ownedDeletion?: SessionOwnedDeletion
}
/** Monotonic physical cleanup facts from the original owners. */
export interface RecordMainPreparationSourceDeletionInput extends MainPreparationSourceDeletionInput {
  readonly progress: SessionCleanupProgress
  readonly failure?: SessionCleanupFailure
}
/** The complete project deletion roster includes preparations independently of carriers. */
export interface ProjectPreparationDeletionGroup {
  readonly sessionId: string
  readonly attemptId: string
  readonly hostSessionId: string
  readonly header?: SessionHeader
  readonly sourceLifecycle: ProjectSessionSourceLifecycle
}
