import { decodeOperation, decodeOperationCollection, type CommunicationOperation, type CommunicationOperationCollection } from './communication/records.ts';
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { DurableMutationError, durableMutationDetails, removeFileDurable, syncDirectory, withRootWriteLock, writeFileDurable, type RootWriteScope } from "./metadata-files.ts";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type {
  BindSessionInput,
  MainCarrierPreparation, MainPreparationInput, MainPreparationResult, ReserveMainPreparationInput, ProjectHostOwnership,
  MainPreparationSourceDeletionInput, RecordMainPreparationSourceDeletionInput, ProjectPreparationDeletionGroup,
  BindSessionCarrierInput,
  ConfirmSessionCarrierHeaderInput,
  CloseSessionCarrierInput,
  BeginExecutionSourceDeletionResult,
  CommitExecutionArchiveInput,
  CreateProjectInput,
  Delivery,
  DeliveryIntent,
  ExecutionSourceDeletionInput,
  LegacySourceReference,
  Project,
  ProjectArchivedUpdateResult,
  ProjectId,
  ProjectMembership,
  ProjectCarrierMembership,
  ProjectOwnedLifecycleEntry,
  ProjectPatch,
  ProjectRecordListener,
  ProjectRecordSnapshot,
  ProjectSession,
  ProjectSessionCarrier,
  ProjectSessionId,
  ProjectSessionPatch,
  ProjectSessionRosterEntry,
  ProjectSessionSource,
  ProjectSessionSourceLifecycle,
  ProjectSessionUpdateResult,
  ProjectSnapshot,
  ProjectUpdateResult,
  RemoveSessionBindingOptions,
  RemovedSessionBinding,
  RevisionOptions,
  RecordExecutionSourceDeletionInput,
  SessionCleanupFailure,
  SessionCleanupProgress,
  SessionFileDeletion,
  SessionFileDeletionResult,
  SessionImageDeletion,
  SessionImageDeletionResult,
  SessionImageDeletionRef,
  SessionOwnedDeletion,
  SessionOwnedDeletionMember,
  SessionOwnedCleanupProgress,
  SessionOwnedDeletedSources,
  SessionOwnedSessionHeader,
  SessionOwnedLifecycle,
  ProjectSourceLifecycle,
  SourceRef,
  WorkspaceReference,
} from "./records-types.ts";
import type { NativeProjectSource } from "./source-reference-types.ts";
import { decodeNativeProjectSource, encodeNativeProjectSource, nativeProjectSourceKey } from "./native-source.ts";

const LEGACY_CURRENT_RECORD_VERSION = 5;
const DELETION_RECORD_VERSION = 6;
const MEMORY_RECORD_VERSION = 7;
const CARRIER_RECORD_VERSION = 14;
const CONTINUITY_RECORD_VERSION = 15;
const RECORD_VERSION = CONTINUITY_RECORD_VERSION;
const FILE_DELETION_RECORD_VERSION = 8;
const IMAGE_DELETION_RECORD_VERSION = 9;
const OWNED_DELETION_RECORD_VERSION = 10;
const OWNED_LIFECYCLE_RECORD_VERSION = 11;
const PROJECT_DELETION_RECORD_VERSION = 12;
const COMMUNICATION_RECORD_VERSION = 13;
const DELETED_SOURCE_TITLE = "来源已删除";
const RECORD_FILE_NAME = "record.json";

type RecordVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;
type JsonObject = Record<string, unknown>;
type ProjectRawField =
  | "sourceLifecycle"
  | "name"
  | "workspace"
  | "archived"
  | "mainSessionId"
  | "revision"
  | "updatedAt";
type SessionRawField = "title" | "archived" | "revision" | "updatedAt" | "sourceLifecycle" | "ownedLifecycle" | "carriers" | "mainPreparations";

interface PersistedProjectRecord {
  readonly version: RecordVersion;
  readonly raw: JsonObject;
  readonly project: Project;
  readonly sessions: ProjectSession[];
  readonly deliveries: Delivery[];
}

/** Same-read decoding is consumed before mutation; it is never spread into a persisted record. */
interface ProjectRecordRead {
  readonly record: PersistedProjectRecord;
  readonly communications?: CommunicationOperationCollection;
}

function recordFileStamp(value: BigIntStats): string {
  return [value.dev, value.ino, value.mode, value.size, value.mtimeNs, value.ctimeNs, value.birthtimeNs].join(":");
}

/** Only the parsed file boundary is shared; mutations build new record envelopes. */
function immutableRecordRead(read: ProjectRecordRead): ProjectRecordRead {
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(read);
  return read;
}

/** A stale full operation cannot replace facts already advanced by another writer. */
export class CommunicationOperationConflictError extends Error {
  readonly code = 'COMMUNICATION_OPERATION_CONFLICT';
  constructor(readonly current: CommunicationOperation) {
    super('Communication operation changed before this update; current facts were retained.');
    this.name = 'CommunicationOperationConflictError';
  }
}

/** 只属于本次真实提交的有限source发布责任，不持久化也不构成归档事实。 */
export interface LifecycleStoreCommit {
  readonly snapshot: ProjectSnapshot;
  confirmSource(): Promise<ProjectSnapshot>;
}
/** Internal one-shot lock authority for one already accepted owner's final settlement. */
export interface MetadataSettlementWriter {
  write<T>(action: (scope: RootWriteScope, fresh: ProjectSnapshot) => Promise<T>, signal?: AbortSignal): Promise<T>;
  release(): void;
}

interface LifecyclePublication {
  readonly sources: readonly ProjectRecordListener[];
  readonly confirmed: Set<ProjectRecordListener>;
  displayed: boolean;
}

/**
 * 当前 Projects 记录的唯一保存入口。
 *
 * 旧业务台账仍留在私有 JSON 封套中。当前投影和写入只处理项目、会话归属和
 * Delivery 回执，因此一次合法更新不会重建或归一化历史对象。
 */
export class ProjectStore {
  readonly #rootDirectory: string;
  readonly #listeners = new Set<ProjectRecordListener>();
  readonly #sourceDispositionListeners = new Set<ProjectRecordListener>();
  readonly #observerFailure: (error: unknown) => void;
  #serial: Promise<void> = Promise.resolve();
  readonly #writeLifetime = new AbortController();
  readonly #recordReads = new Map<string, { readonly stamp: string; readonly read: ProjectRecordRead }>();

  constructor(rootDirectory: string, observerFailure: (error: unknown) => void = error => { console.warn("ProjectStore display observer failed after committed source publication", error); }) {
    this.#rootDirectory = rootDirectory;
    this.#observerFailure = observerFailure;
  }

  async init(): Promise<void> {
    await this.#enqueue(async () => {
      await this.#ensureRootDirectory();
    });
  }

  async listProjects(): Promise<Project[]> {
    return this.#enqueue(async () => {
      const records = await this.#readAllRecords();
      return records
        .filter((record) => record.project.sourceLifecycle?.kind !== "deleted")
        .map((record) => copyProject(record.project))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    });
  }

  /** 失效来源加载独立于普通列表；terminal也必须在Host ready前发布。 */
  async listRetainedSnapshots(): Promise<ProjectSnapshot[]> {
    return this.#enqueue(async () => (await this.#readAllRecords()).map(recordSnapshot));
  }

  async getProject(projectId: ProjectId): Promise<Project | undefined> {
    return this.#enqueue(async () => {
      const record = (await this.#readProjectRecord(projectId))?.record;
      return record === undefined ? undefined : copyProject(record.project);
    });
  }

  /** 同次完整快照；仅项目目录确实不存在时返回 undefined，损坏记录仍拒绝。 */
  async findSnapshot(projectId: ProjectId): Promise<ProjectSnapshot | undefined> {
    return this.#enqueue(async () => {
      const record = (await this.#readProjectRecord(projectId))?.record;
      return record === undefined ? undefined : recordSnapshot(record);
    });
  }

  /** 返回当前项目、会话和 Delivery 的同一次读取快照。 */
  async getSnapshot(projectId: ProjectId): Promise<ProjectSnapshot> {
    return this.#enqueue(async () => recordSnapshot(await this.#requireProjectRecord(projectId)));
  }

  /** 创建最小 v7 项目封套，不写入旧业务台账字段。 */
  async createProject(input: CreateProjectInput): Promise<Project> {
    return this.#mutate(async () => {
      await this.#ensureRootDirectory();
      const id = safeIdentifier(input.id ?? randomUUID(), "project id");
      const now = new Date().toISOString();
      const project: Project = {
        id,
        name: requiredText(input.name, "project name"),
        archived: false,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      if (input.workspace !== undefined) project.workspace = copyWorkspace(input.workspace);

      const record: PersistedProjectRecord = {
        version: RECORD_VERSION,
        raw: {
          version: RECORD_VERSION,
          project: projectToRaw(project),
          sessions: [],
          deliveries: [],
        },
        project,
        sessions: [],
        deliveries: [],
      };
      await this.#createProjectRecord(record);
      this.#publishCommitted(record);
      return copyProject(project);
    });
  }

  async updateProject(
    projectId: ProjectId,
    patch: ProjectPatch,
    options: RevisionOptions = {},
  ): Promise<ProjectUpdateResult> {
    return this.#mutate(async () => {
      const record = await this.#requireProjectRecord(projectId);
      assertProjectAvailable(record.project);
      if (hasRevisionConflict(record.project.revision, options)) {
        return { kind: "conflict", project: copyProject(record.project) };
      }
      const project = applyProjectPatch(record.project, patch);
      const changed = new Set<ProjectRawField>(["revision", "updatedAt"]);
      if (patch.name !== undefined) changed.add("name");
      if (patch.workspace !== undefined) changed.add("workspace");
      const next = withProject(record, project, changed);
      await this.#writeProjectRecord(next);
      this.#publishCommitted(next);
      return { kind: "updated", project: copyProject(project) };
    });
  }

  /**
   * 项目归档位的唯一写入口。比较与保存共用 Store serial slot，避免异步
   * 生命周期准备期间漏掉新增、换绑或已单独归档的会话。
   */
  async setProjectArchived(
    projectId: ProjectId,
    archived: boolean,
    expectedRoster: readonly ProjectSessionRosterEntry[],
    ownedLifecycles?: readonly ProjectOwnedLifecycleEntry[],
    committed?: (commit: LifecycleStoreCommit) => void,
  ): Promise<ProjectArchivedUpdateResult> {
    return this.#mutate(async () => {
      const records = ownedLifecycles === undefined
        ? [await this.#requireProjectRecord(projectId)] : await this.#readAllRecords();
      const record = findRecord(records, projectId);
      if (record === undefined) throw new Error("Project not found: " + projectId);
      assertProjectAvailable(record.project);
      if (!sameSessionRoster(lifecycleSessions(record), expectedRoster)) {
        return { kind: "conflict", snapshot: recordSnapshot(record) };
      }
      let next = record;
      if (ownedLifecycles !== undefined) {
        // 恢复项目只释放未被单独归档的 root，不改独立归档位或其已存身份。
        const roots = lifecycleSessions(record).filter((session) => archived || !session.archived);
        const expected = roots.flatMap(session => sessionCarriers(session).filter(carrier => carrier.sourceLifecycle.kind === "available")
          .map(carrier => ({ session, carrier })));
        const supplied = new Map(ownedLifecycles.map(entry => {
          const session = requireSession(record, entry.sessionId);
          const host = carrierHostInput(entry) ?? (sessionCarriers(session).length === 1 ? session.hostSessionId : undefined);
          if (host === undefined) throw new Error("Multi-carrier archive requires exact carrier host identities");
          return [entry.sessionId + ":" + host, entry.ownedLifecycle] as const;
        }));
        if (supplied.size !== ownedLifecycles.length || supplied.size !== expected.length
          || expected.some(({ session, carrier }) => !supplied.has(session.id + ":" + carrier.hostSessionId))) {
          throw new Error("Owned lifecycle must cover the exact project root set");
        }
        const now = new Date().toISOString();
        for (const current of roots) {
          const session = archiveCarriers(current, sessionCarriers(current).filter(carrier => carrier.sourceLifecycle.kind === "available")
            .map(carrier => ({ hostSessionId: carrier.hostSessionId, ownedLifecycle: supplied.get(current.id + ":" + carrier.hostSessionId)! })));
          next = withOwnedLifecycleSession(next, { ...session,
            revision: current.revision + 1, updatedAt: now });
        }
        validateOwnedRecordClaims(records, next);
      }
      if (record.project.archived === archived && ownedLifecycles === undefined) {
        return { kind: "unchanged", snapshot: recordSnapshot(record) };
      }
      const project = {
        ...record.project,
        archived: booleanValue(archived, "project archived"),
        revision: record.project.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      next = withProject(
        next,
        project,
        new Set<ProjectRawField>(["archived", "revision", "updatedAt"]),
      );
      await this.#writeProjectRecord(next);
      // 本次真实rename已完成；只把原动作的source交接责任交回，不补造已停事实。
      const publication = this.#lifecyclePublication(next, committed);
      this.#publishCommitted(next, publication);
      return { kind: "updated", snapshot: recordSnapshot(next) };
    });
  }

  async listSessions(projectId: ProjectId): Promise<ProjectSession[]> {
    return this.#enqueue(async () => {
      const record = await this.#requireProjectRecord(projectId);
      return record.sessions
        .map(copySession)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    });
  }

  async getSession(
    projectId: ProjectId,
    sessionId: ProjectSessionId,
  ): Promise<ProjectSession | undefined> {
    return this.#enqueue(async () => {
      const record = await this.#requireProjectRecord(projectId);
      const session = record.sessions.find((candidate) => candidate.id === sessionId);
      return session === undefined ? undefined : copySession(session);
    });
  }

  /**
   * 持久化预分配的 host session id。一个 host session 只能属于一个项目，
   * 一个项目也只能各有一个 main 与 memory 会话。
   */
  async bindSession(projectId: ProjectId, input: BindSessionInput): Promise<ProjectSession> {
    return this.#mutate(async () => {
      const records = await this.#readAllRecords();
      const record = findRecord(records, projectId);
      if (record === undefined) throw new Error("Project not found: " + projectId);
      assertProjectAvailable(record.project);
      if (record.project.archived) {
        throw new Error("Cannot bind a session to an archived project: " + projectId);
      }

      const hostSessionId = requiredText(input.hostSessionId, "host session id");
      if (hasClaimedHost(records, hostSessionId)) {
        throw new Error("Host session is already bound: " + hostSessionId);
      }
      if (records.some((record) => record.sessions.some((session) => ownedMemberIds(session).includes(hostSessionId)))) {
        throw new Error("Host session is an owned unavailable source: " + hostSessionId);
      }
      const existingMembership = findMembership(records, hostSessionId);
      if (existingMembership !== undefined) {
        throw new Error(
          "Host session is already bound to "
          + existingMembership.project.id
          + "/"
          + existingMembership.session.id,
        );
      }
      const id = safeIdentifier(input.id ?? randomUUID(), "project session id");
      if (record.sessions.some((session) => session.id === id)) {
        throw new Error("Project session already exists: " + projectId + "/" + id);
      }
      if (input.role === "main" && record.project.mainSessionId !== undefined) {
        throw new Error("Project already has a main session: " + projectId);
      }
      if (input.role === "memory" && record.sessions.some((session) => session.role === "memory")) {
        throw new Error("Project already has a memory session: " + projectId);
      }
      if (input.role === "session-manager" && record.sessions.some(session => session.role === "session-manager")) throw new Error("Project already has a session manager");
      if (input.role !== "main" && input.role !== "execution" && input.role !== "memory" && input.role !== "session-manager") {
        throw new Error("Unsupported project session role: " + String(input.role));
      }

      const now = new Date().toISOString();
      const header = input.header === undefined ? undefined : carrierHeader(input.header, hostSessionId);
      const session: ProjectSession = {
        id,
        projectId: record.project.id,
        hostSessionId,
        role: input.role,
        sourceLifecycle: { kind: "available" },
        title: requiredText(input.title, "project session title"),
        archived: false,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        carriers: [{ sequence: 1, hostSessionId, isCurrent: true, boundAt: now,
          sourceLifecycle: { kind: "available" }, ...(header === undefined ? {} : { header }) }],
      };
      const project = touchProject(record.project, now);
      if (session.role === "main") project.mainSessionId = session.id;
      const next = appendSession(
        withProject(
          record,
          project,
          new Set<ProjectRawField>(["mainSessionId", "revision", "updatedAt"]),
        ),
        session,
      );
      await this.#writeProjectRecord(next);
      this.#publishCommitted(next);
      return copySession(session);
    });
  }

  /** 只转换关系封套，显式迁移调用者负责选择隔离副本；普通读取不落盘。 */
  async upgradeCarrierRelations(projectId: ProjectId): Promise<ProjectSnapshot> {
    return this.#mutate(async () => {
      const record = await this.#requireProjectRecord(projectId);
      if (record.version >= CARRIER_RECORD_VERSION) return recordSnapshot(record);
      const next = withCarrierFormat(record);
      await this.#writeProjectRecord(next);
      this.#publishCommitted(next);
      return recordSnapshot(next);
    });
  }

  async listSessionCarriers(projectId: ProjectId, sessionId: ProjectSessionId): Promise<readonly ProjectSessionCarrier[]> {
    return this.#enqueue(async () => sessionCarriers(requireSession(await this.#requireProjectRecord(projectId), sessionId)).map(copyCarrier));
  }

  async listProjectCarriers(projectId: ProjectId): Promise<readonly ProjectCarrierMembership[]> {
    return this.#enqueue(async () => {
      const record = await this.#requireProjectRecord(projectId);
      return record.sessions.flatMap(session => sessionCarriers(session).map(carrier => carrierMembership(record.project, session, carrier)));
    });
  }

  async findCarrierByHostSessionId(hostSessionId: string): Promise<ProjectCarrierMembership | undefined> {
    return this.#enqueue(async () => {
      for (const record of await this.#readAllRecords()) for (const session of record.sessions) {
        const carrier = sessionCarriers(session).find(row => row.hostSessionId === hostSessionId);
        if (carrier !== undefined) return carrierMembership(record.project, session, carrier);
      }
      return undefined;
    });
  }

  /** 只解析指定运行入口；归档等暂时资格仍由原生命周期 owner 裁决。 */
  async resolveCurrentCarrier(projectId: ProjectId, sessionId: ProjectSessionId): Promise<ProjectSessionCarrier | undefined> {
    return this.#enqueue(async () => {
      const record = await this.#requireProjectRecord(projectId);
      if (record.project.sourceLifecycle !== undefined) return undefined;
      const session = requireSession(record, sessionId), carrier = currentCarrier(session);
      return carrier.sourceLifecycle.kind !== "available" || carrier.closed !== undefined ? undefined : copyCarrier(carrier);
    });
  }

  /** 追加与全库唯一性检查在同一 Store 串行更新中完成，不关闭旧段的未完调用。 */
  async bindSessionCarrier(input: BindSessionCarrierInput): Promise<ProjectSessionUpdateResult> {
    return this.#mutate(async () => {
      const records = await this.#readAllRecords(), record = findRecord(records, input.projectId);
      if (record === undefined) throw new Error("Project not found: " + input.projectId);
      assertProjectAvailable(record.project);
      const current = requireSession(record, input.sessionId);
      if (current.revision !== input.expectedRevision) return { kind: "conflict", session: copySession(current) };
      if (record.project.archived || current.archived) throw new Error("Cannot bind a carrier to an archived session");
      assertAvailableSession(current);
      const hostSessionId = requiredText(input.hostSessionId, "carrier host session id");
      if (hasClaimedHost(records, hostSessionId)) throw new Error("Host session is already claimed: " + hostSessionId);
      const header = input.header === undefined ? undefined : carrierHeader(input.header, hostSessionId);
      const now = new Date().toISOString(), carriers = sessionCarriers(current);
      const session = projectCurrentCarrier({ ...current, revision: current.revision + 1, updatedAt: now,
        carriers: [...carriers.map(carrier => ({ ...carrier, isCurrent: false })),
          { sequence: carriers.length + 1, hostSessionId, isCurrent: true,
            boundAt: input.boundAt === undefined ? now : requiredText(input.boundAt, "carrier boundAt"),
            sourceLifecycle: { kind: "available" }, ...(header === undefined ? {} : { header }) }] });
      const next = withSession(withCarrierFormat(record), session, new Set(["carriers", "revision", "updatedAt"]));
      validateOwnedRecordClaims(records, next);
      await this.#writeProjectRecord(next); this.#publishCommitted(next);
      return { kind: "updated", session: copySession(session) };
    });
  }

  /** Resolve persisted ownership without promoting a preparation to a work membership. */
  async resolveHostOwnership(hostSessionId: string, owner?: { readonly projectId: string; readonly logicalSessionId?: string }): Promise<ProjectHostOwnership | undefined> {
    return this.#enqueue(async () => {
      const scoped = owner === undefined ? undefined : (await this.#readProjectRecord(owner.projectId))?.record;
      if (owner?.logicalSessionId !== undefined && scoped === undefined) throw new Error('PROJECT_SOURCE_IDENTITY_MISMATCH');
      const records = owner === undefined ? await this.#readAllRecords() : scoped === undefined ? [] : [scoped];
      for (const record of records) for (const session of record.sessions) {
        const carrier = sessionCarriers(session).find(row => row.hostSessionId === hostSessionId);
        if (carrier !== undefined) {
          if (owner?.logicalSessionId !== undefined && session.id !== owner.logicalSessionId) throw new Error('PROJECT_SOURCE_IDENTITY_MISMATCH');
          return { kind: carrier.isCurrent ? 'current' : 'historical', project: copyProject(record.project), session: copySession(session), carrier: copyCarrier(carrier) };
        }
        const preparation = session.mainPreparations?.find(row => row.toHostSessionId === hostSessionId && row.state !== 'committed');
        if (preparation !== undefined) {
          if (owner?.logicalSessionId !== undefined && session.id !== owner.logicalSessionId) throw new Error('PROJECT_SOURCE_IDENTITY_MISMATCH');
          return { kind: 'preparation', project: copyProject(record.project), session: copySession(session), preparation: structuredClone(preparation) };
        }
      }
      return undefined;
    });
  }

  /** Reserve the exact new root before native creation starts. */
  async reserveMainPreparation(input: ReserveMainPreparationInput): Promise<MainPreparationResult> {
    return this.#mutate(async () => {
      const records = await this.#readAllRecords(), record = findRecord(records, input.projectId);
      if (record === undefined) throw new Error('Project not found: ' + input.projectId);
      assertProjectAvailable(record.project);
      const current = requireSession(record, input.sessionId), from = currentCarrier(current);
      assertAvailableSession(current);
      if (current.revision !== input.expectedRevision) return { kind: 'conflict', session: copySession(current) };
      if (current.role !== 'main' || current.archived || record.project.archived || from.closed !== undefined
        || from.header === undefined || !sameOwnedLifecycleHeader(from.header, input.fromHeader)) throw new Error('Main preparation requires the exact available current header');
      if ((current.mainPreparations ?? []).some(row => row.attemptId === input.attemptId)) throw new Error('Main attempt already exists');
      const now = new Date().toISOString(), preparation: MainCarrierPreparation = { attemptId: requiredText(input.attemptId, 'attempt id'),
        fromHeader: carrierHeader(input.fromHeader, current.hostSessionId), toHostSessionId: requiredText(input.toHostSessionId, 'prepared host id'),
        state: 'unpublished', createdAt: now, updatedAt: now };
      const session = { ...current, revision: current.revision + 1, updatedAt: now, mainPreparations: [...(current.mainPreparations ?? []), preparation] };
      const next = withContinuityFormat(withSession(withCarrierFormat(record), session, new Set(['mainPreparations', 'revision', 'updatedAt'])));
      validateOwnedRecordClaims(records, next); await this.#writeProjectRecord(next); this.#publishCommitted(next);
      return { kind: 'updated', session: copySession(session), preparation: structuredClone(preparation) };
    });
  }

  /** Discard only a never-materialized, already abandoned technical reservation. */
  async discardAbsentMainPreparation(input: MainPreparationInput, proof: { readonly id: string; assertCurrent(): void }): Promise<ProjectSessionUpdateResult> {
    return this.#mutate(async () => {
      const record = await this.#requireProjectRecord(input.projectId), current = requireSession(record, input.sessionId);
      if (current.revision !== input.expectedRevision) return { kind: 'conflict', session: copySession(current) };
      const preparation = current.mainPreparations?.find(row => row.attemptId === input.attemptId);
      if (preparation === undefined || preparation.toHostSessionId !== proof.id || preparation.state !== 'abandoned'
        || preparation.retirement !== 'confirmed' || preparation.toHeader !== undefined || preparation.sourceLifecycle !== undefined) {
        throw new Error('Only the exact confirmed absent abandoned preparation can be discarded');
      }
      proof.assertCurrent();
      const remaining = current.mainPreparations!.filter(row => row.attemptId !== input.attemptId);
      const session = { ...current, revision: current.revision + 1, updatedAt: new Date().toISOString(), mainPreparations: remaining };
      const next = withSession(record, session, new Set(['mainPreparations', 'revision', 'updatedAt']));
      await this.#writeProjectRecord(next, () => proof.assertCurrent());
      this.#publishCommitted(next);
      return { kind: 'updated', session: copySession(session) };
    });
  }

  /** Confirm the header minted by the real create, consuming only this attempt's receipt revision. */
  async confirmPreparedHeader(input: MainPreparationInput & { readonly header: import('@deepseek-ai/dsh-session').SessionHeader }): Promise<MainPreparationResult> {
    return this.#updateMainPreparation(input, preparation => {
      if (preparation.state !== 'unpublished' || preparation.sourceLifecycle !== undefined) throw new Error('Preparation is already settled or deleting');
      const header = carrierHeader(input.header, preparation.toHostSessionId);
      if (preparation.toHeader !== undefined && !sameOwnedLifecycleHeader(preparation.toHeader, header)) throw new Error('Prepared creation identity changed');
      return { ...preparation, toHeader: header, updatedAt: new Date().toISOString() };
    });
  }

  /** Keep failed ownership until the actual native close is confirmed. */
  async abandonMainPreparation(input: MainPreparationInput & { readonly retirementConfirmed: boolean }): Promise<MainPreparationResult> {
    return this.#updateMainPreparation(input, preparation => {
      if (preparation.state === 'committed' || preparation.sourceLifecycle !== undefined) throw new Error('Committed or deleting preparation cannot be abandoned');
      return { ...preparation, state: 'abandoned', updatedAt: new Date().toISOString(), ...(input.retirementConfirmed ? { retirement: 'confirmed' as const } : {}) };
    });
  }

  async #updateMainPreparation(input: MainPreparationInput, change: (preparation: MainCarrierPreparation) => MainCarrierPreparation): Promise<MainPreparationResult> {
    return this.#mutate(async () => {
      const record = await this.#requireProjectRecord(input.projectId), current = requireSession(record, input.sessionId);
      if (current.revision !== input.expectedRevision) return { kind: 'conflict', session: copySession(current) };
      const previous = current.mainPreparations?.find(row => row.attemptId === input.attemptId);
      if (previous === undefined) throw new Error('Main preparation does not exist');
      const preparation = change(previous), session = { ...current, revision: current.revision + 1, updatedAt: new Date().toISOString(),
        mainPreparations: current.mainPreparations!.map(row => row.attemptId === input.attemptId ? preparation : row) };
      const next = withContinuityFormat(withSession(record, session, new Set(['mainPreparations', 'revision', 'updatedAt'])));
      validateOwnedRecordClaims(await this.#readAllRecords(), next); await this.#writeProjectRecord(next); this.#publishCommitted(next);
      return { kind: 'updated', session: copySession(session), preparation: structuredClone(preparation) };
    });
  }

  /** The single durable commit retires old, publishes new and commits its preparation together. */
  async publishMainCarrier(input: MainPreparationInput & { readonly expectedOldHeader: import('@deepseek-ai/dsh-session').SessionHeader; readonly preparedHeader: import('@deepseek-ai/dsh-session').SessionHeader; readonly assertValid?: () => void }): Promise<MainPreparationResult> {
    return this.#mutate(async () => {
      const record = await this.#requireProjectRecord(input.projectId), current = requireSession(record, input.sessionId);
      if (current.revision !== input.expectedRevision) return { kind: 'conflict', session: copySession(current) };
      assertProjectAvailable(record.project); assertAvailableSession(current);
      const previous = current.mainPreparations?.find(row => row.attemptId === input.attemptId), from = currentCarrier(current);
      if (current.role !== 'main' || current.archived || record.project.archived || from.closed !== undefined || previous?.state !== 'unpublished'
        || previous?.sourceLifecycle !== undefined || from.header === undefined || !sameOwnedLifecycleHeader(from.header, input.expectedOldHeader)
        || !sameOwnedLifecycleHeader(previous.fromHeader, input.expectedOldHeader) || previous.toHeader === undefined
        || !sameOwnedLifecycleHeader(previous.toHeader, input.preparedHeader)) throw new Error('Main publication requires exact prepared and current creation identities');
      const now = new Date().toISOString(), preparation: MainCarrierPreparation = { ...previous, state: 'committed', updatedAt: now };
      const carriers = sessionCarriers(current), session = projectCurrentCarrier({ ...current, revision: current.revision + 1, updatedAt: now,
        mainPreparations: current.mainPreparations!.map(row => row.attemptId === input.attemptId ? preparation : row),
        carriers: [...carriers.map(row => row.isCurrent ? { ...row, isCurrent: false, closed: { confirmedAt: now, reason: 'retired' as const } } : row),
          { sequence: carriers.length + 1, hostSessionId: previous.toHostSessionId, header: previous.toHeader, isCurrent: true, boundAt: now, sourceLifecycle: { kind: 'available' } }] });
      const next = withContinuityFormat(withSession(record, session, new Set(['mainPreparations', 'carriers', 'revision', 'updatedAt'])));
      validateOwnedRecordClaims(await this.#readAllRecords(), next); await this.#writeProjectRecord(next, input.assertValid); this.#publishCommitted(next);
      return { kind: 'updated', session: copySession(session), preparation: structuredClone(preparation) };
    });
  }

  async confirmSessionCarrierHeader(input: ConfirmSessionCarrierHeaderInput): Promise<ProjectSessionUpdateResult> {
    return this.#mutate(async () => {
      const record = await this.#requireProjectRecord(input.projectId), current = requireSession(record, input.sessionId);
      if (current.revision !== input.expectedRevision) return { kind: "conflict", session: copySession(current) };
      const carrier = requireCarrier(current, input.hostSessionId), header = carrierHeader(input.header, input.hostSessionId);
      if (carrier.header !== undefined && !sameOwnedLifecycleHeader(carrier.header, header)) throw new Error("Carrier creation identity cannot change");
      const session = projectCurrentCarrier({ ...current, revision: current.revision + 1, updatedAt: new Date().toISOString(),
        carriers: sessionCarriers(current).map(row => row.hostSessionId === input.hostSessionId ? { ...row, header } : row) });
      const next = withSession(withCarrierFormat(record), session, new Set(["carriers", "revision", "updatedAt"]));
      validateCurrentConsistency(next);
      await this.#writeProjectRecord(next); this.#publishCommitted(next);
      return { kind: "updated", session: copySession(session) };
    });
  }

  async closeSessionCarrier(input: CloseSessionCarrierInput): Promise<ProjectSessionUpdateResult> {
    return this.#mutate(async () => {
      const record = await this.#requireProjectRecord(input.projectId), current = requireSession(record, input.sessionId);
      if (current.revision !== input.expectedRevision) return { kind: "conflict", session: copySession(current) };
      const carrier = requireCarrier(current, input.hostSessionId);
      const closed = parseCarrierClosed({ confirmedAt: input.confirmedAt, reason: input.reason });
      if (carrier.closed !== undefined && JSON.stringify(carrier.closed) !== JSON.stringify(closed)) throw new Error("Carrier confirmed ending cannot change");
      const session = projectCurrentCarrier({ ...current, revision: current.revision + 1, updatedAt: new Date().toISOString(),
        carriers: sessionCarriers(current).map(row => row.hostSessionId === input.hostSessionId ? { ...row, closed } : row) });
      const next = withSession(withCarrierFormat(record), session, new Set(["carriers", "revision", "updatedAt"]));
      await this.#writeProjectRecord(next); this.#publishCommitted(next);
      return { kind: "updated", session: copySession(session) };
    });
  }

  async updateSession(
    projectId: ProjectId,
    sessionId: ProjectSessionId,
    patch: ProjectSessionPatch,
    options: RevisionOptions = {},
    committed?: (commit: LifecycleStoreCommit) => void,
  ): Promise<ProjectSessionUpdateResult> {
    return this.#mutate(async () => {
      const record = await this.#requireProjectRecord(projectId);
      assertProjectAvailable(record.project);
      const index = record.sessions.findIndex((session) => session.id === sessionId);
      if (index < 0) throw new Error("Project session not found: " + projectId + "/" + sessionId);
      const current = record.sessions[index];
      if (current === undefined) throw new Error("Project session not found: " + projectId + "/" + sessionId);
      assertAvailableSession(current);
      if (hasRevisionConflict(current.revision, options)) {
        return { kind: "conflict", session: copySession(current) };
      }
      const session = applySessionPatch(current, patch);
      const changed = new Set<SessionRawField>(["revision", "updatedAt"]);
      if (patch.title !== undefined) changed.add("title");
      if (patch.archived !== undefined) changed.add("archived");
      const next = withSession(record, session, changed);
      await this.#writeProjectRecord(next);
      // 本次真实rename已完成；只把原动作的source交接责任交回，不补造已停事实。
      const publication = this.#lifecyclePublication(next, committed);
      this.#publishCommitted(next, publication);
      return { kind: "updated", session: copySession(session) };
    });
  }

  /** 先核同一 execution 的 CAS，再提交原生标题；回调只持有已取得的标题 owner，不得回读 Store。 */
  async renameExecutionSession(
    input: { readonly projectId: string; readonly sessionId: string; readonly hostSessionId: string; readonly expectedRevision: number },
    saveNativeTitle: () => Promise<string>,
  ): Promise<ProjectSessionUpdateResult> {
    return this.#mutate(async () => {
      const record = await this.#requireProjectRecord(input.projectId);
      assertProjectAvailable(record.project);
      const current = record.sessions.find(session => session.id === input.sessionId);
      if (current === undefined || current.role !== "execution" || current.hostSessionId !== input.hostSessionId) {
        throw new Error("改名目标不是本项目的原执行会话。");
      }
      assertAvailableSession(current);
      if (hasRevisionConflict(current.revision, input)) return { kind: "conflict", session: copySession(current) };
      const title = await saveNativeTitle();
      const session = applySessionPatch(current, { title });
      const next = withSession(record, session, new Set<SessionRawField>(["title", "revision", "updatedAt"]));
      await this.#writeProjectRecord(next);
      this.#publishCommitted(next);
      return { kind: "updated", session: copySession(session) };
    });
  }

  /** 单 execution 的停止确认与唯一 archive 位在同一 revision CAS 内保存。 */
  async commitExecutionArchive(input: CommitExecutionArchiveInput): Promise<ProjectSessionUpdateResult> {
    return this.#mutate(async () => {
      const records = await this.#readAllRecords();
      const record = findRecord(records, input.projectId);
      if (record === undefined) throw new Error("Project not found: " + input.projectId);
      const current = record.sessions.find((session) => session.id === input.sessionId);
      if (current === undefined) throw new Error("Project session not found: " + input.projectId + "/" + input.sessionId);
      assertAvailableSession(current);
      if (current.role !== "execution") throw new Error("Execution archive requires an execution session");
      if (current.revision !== input.expectedRevision) return { kind: "conflict", session: copySession(current) };
      if ((input.ownedLifecycle === undefined) === (input.carrierLifecycles === undefined)) throw new Error("Archive requires exactly one complete carrier proof set");
      if (input.ownedLifecycle !== undefined && sessionCarriers(current).length !== 1) throw new Error("Multi-carrier archive requires all carrier lifecycles");
      const proofs = input.carrierLifecycles ?? [{ hostSessionId: current.hostSessionId, ownedLifecycle: input.ownedLifecycle! }];
      const session = { ...archiveCarriers(current, proofs), archived: true,
        revision: current.revision + 1, updatedAt: new Date().toISOString() };
      const next = withOwnedLifecycleSession(record, session);
      validateOwnedRecordClaims(records, next);
      await this.#writeProjectRecord(next);
      this.#publishCommitted(next);
      return { kind: "updated", session: copySession(session) };
    });
  }

  /** 已停稳的全roster和既有source分组由同一Store一次接管。 */
  async beginProjectSourceDeletion(input: {projectId:string; expectedRevision:number; sessions:readonly ProjectSession[]; preparations?:readonly ProjectPreparationDeletionGroup[]},
    committed?: (commit:LifecycleStoreCommit)=>void): Promise<ProjectSnapshot> {
    return this.#mutate(async () => {
      const record = await this.#requireProjectRecord(input.projectId);
      assertProjectAvailable(record.project);
      const proposedSessions = groupProjectDeletionSessions(record, input.sessions);
      if (record.project.revision !== input.expectedRevision || record.sessions.length !== proposedSessions.length
        || record.sessions.some(current => !proposedSessions.some(row => row.id === current.id && row.hostSessionId === current.hostSessionId && row.revision === current.revision))) throw new Error("Project deletion roster revision conflict");
      const prepared = input.preparations ?? [];
      const roots = record.sessions.flatMap(session => (session.mainPreparations ?? []).filter(row => row.state !== 'committed').map(preparation => ({ session, preparation })));
      if (prepared.length !== roots.length || new Set(prepared.map(row => row.hostSessionId)).size !== roots.length
        || roots.some(({session, preparation}) => !prepared.some(row => row.sessionId === session.id && row.attemptId === preparation.attemptId && row.hostSessionId === preparation.toHostSessionId))) throw new Error('Project deletion requires the complete exact preparation roster');
      const now = new Date().toISOString();
      let next = record;
      for (const supplied of proposedSessions) {
        const current = record.sessions.find(row => row.id === supplied.id)!;
        const carriers = sessionCarriers(current);
        if (carriers.length > 1) {
          if (supplied.carriers === undefined || supplied.carriers.length !== carriers.length
            || carriers.some((carrier, index) => supplied.carriers![index]?.hostSessionId !== carrier.hostSessionId
              || supplied.carriers![index]?.sequence !== carrier.sequence || supplied.carriers![index]?.isCurrent !== carrier.isCurrent)) {
            throw new Error("Project deletion requires the complete exact carrier roster");
          }
          const session = projectCurrentCarrier({ ...current, revision: current.revision + 1, updatedAt: now,
            carriers: carriers.map((carrier, index) => {
              if (carrier.sourceLifecycle.kind === "deleted") return carrier;
              const proposed = supplied.carriers![index]!.sourceLifecycle;
              if (proposed.kind !== "deleting" && proposed.kind !== "partial") throw new Error("Missing exact project carrier deletion group");
              const prior = carrier.sourceLifecycle;
              return { ...carrier, sourceLifecycle: { ...copySourceLifecycle(prior.kind === "available" ? proposed : prior), scheduleDeletion: true } as ProjectSessionSourceLifecycle };
            }) });
          next = withSession(next, session, new Set(["carriers", "revision", "updatedAt"]));
          continue;
        }
        if (current.sourceLifecycle.kind === "deleted") continue;
        const prior = current.sourceLifecycle;
        const proposed = supplied.sourceLifecycle;
        if (proposed.kind !== "deleting" && proposed.kind !== "partial") throw new Error("Missing exact project deletion group");
        const session:ProjectSession = {...current,revision:current.revision+1,updatedAt:now,sourceLifecycle:
          prior.kind === "available" ? {...copySourceLifecycle(proposed),scheduleDeletion:true} as ProjectSessionSourceLifecycle
            : {...copySourceLifecycle(prior),scheduleDeletion:true} as ProjectSessionSourceLifecycle};
        next = withDeletionSession(next,session);
      }
      for (const supplied of prepared) {
        const current = requireSession(next, supplied.sessionId), original = current.mainPreparations!.find(row => row.attemptId === supplied.attemptId)!;
        const prior = original.sourceLifecycle ?? {kind:'available' as const};
        if (prior.kind === 'deleted') continue;
        const proposed = supplied.sourceLifecycle;
        if (proposed.kind !== 'deleting' && proposed.kind !== 'partial') throw new Error('Missing exact preparation deletion group');
        const header = supplied.header === undefined ? original.toHeader : carrierHeader(supplied.header, original.toHostSessionId);
        if (original.toHeader !== undefined && header !== undefined && !sameOwnedLifecycleHeader(original.toHeader, header)) throw new Error('Prepared creation identity changed');
        if (header === undefined) throw new Error('Preparation deletion requires actual creation identity');
        const preparation:MainCarrierPreparation = {...original,toHeader:header,updatedAt:now,sourceLifecycle:{...copySourceLifecycle(prior.kind === 'available' ? proposed : prior),scheduleDeletion:true} as ProjectSessionSourceLifecycle};
        const session = {...current,revision:current.revision+1,updatedAt:now,mainPreparations:current.mainPreparations!.map(row => row.attemptId === preparation.attemptId ? preparation : row)};
        next = withSession(next,session,new Set(['mainPreparations','revision','updatedAt']));
      }
      const project:Project = {...record.project,revision:record.project.revision+1,updatedAt:now,
        sourceLifecycle:{kind:"deleting",requestedAt:now,updatedAt:now,progress:{}}};
      next = withProject(next,project,new Set(["sourceLifecycle","revision","updatedAt"]));
      const deletionVersion = Math.max(next.version, PROJECT_DELETION_RECORD_VERSION) as RecordVersion;
      next = {...next,version:deletionVersion,raw:{...next.raw,version:deletionVersion}};
      validateOwnedRecordClaims(await this.#readAllRecords(),next);
      await this.#writeProjectRecord(next); this.#publishCommitted(next,this.#lifecyclePublication(next,committed));
      return recordSnapshot(next);
    });
  }

  async confirmDeletionSources(projectId:string):Promise<ProjectSnapshot>{return this.#enqueue(async()=>{const record=await this.#requireProjectRecord(projectId);this.#publish(record);return recordSnapshot(record)})}

  async recordProjectSourceDeletion(projectId:string, failure?:SessionCleanupFailure, projectFiles?:"removed"|"already-absent"):Promise<ProjectSnapshot> {
    return this.#mutate(async () => {
      const record = await this.#requireProjectRecord(projectId), prior=record.project.sourceLifecycle;
      if (prior === undefined || prior.kind === "deleted") throw new Error("Project deletion is not in progress");
      const now=new Date().toISOString();
      const project:Project={...record.project,revision:record.project.revision+1,updatedAt:now,sourceLifecycle:{
        kind:failure===undefined?"deleting":"partial",requestedAt:prior.requestedAt,updatedAt:now,
        progress:{...prior.progress,...(projectFiles===undefined?{}:{projectFiles})},...(failure===undefined?{}:{failure:parseCleanupFailure(failure)})}};
      const next=withProject(record,project,new Set(["sourceLifecycle","revision","updatedAt"]));
      await this.#writeProjectRecord(next);this.#publishCommitted(next);return recordSnapshot(next);
    });
  }

  async completeProjectSourceDeletion(projectId:string, committed?:(commit:LifecycleStoreCommit)=>void):Promise<ProjectSnapshot> {
    return this.#mutate(async () => {
      const record=await this.#requireProjectRecord(projectId),prior=record.project.sourceLifecycle;
      if (prior?.kind === "deleted") return recordSnapshot(record);
      if (prior===undefined || prior.progress.projectFiles===undefined || record.sessions.some(row=>sessionCarriers(row).some(carrier=>carrier.sourceLifecycle.kind!=="deleted") || (row.mainPreparations??[]).some(preparation=>preparation.state!=='committed'&&preparation.sourceLifecycle?.kind!=='deleted'))) throw new Error("Project deletion owners are not complete");
      const now=new Date().toISOString(),revision=record.project.revision+1;
      const raw:JsonObject={version:record.version >= CONTINUITY_RECORD_VERSION ? CONTINUITY_RECORD_VERSION : record.version >= CARRIER_RECORD_VERSION ? CARRIER_RECORD_VERSION : PROJECT_DELETION_RECORD_VERSION,terminal:true,project:{id:projectId,revision,sourceLifecycle:{kind:"deleted",requestedAt:prior.requestedAt,deletedAt:now}},
        sources:record.sessions.map(row=>record.version >= CARRIER_RECORD_VERSION
          ? {id:row.id,role:row.role,revision:Math.max(revision,row.revision+1),carriers:sessionCarriers(row).map(carrierToRaw),...(row.mainPreparations===undefined?{}:{mainPreparations:structuredClone(row.mainPreparations)})}
          : ({id:row.id,hostSessionId:row.hostSessionId,role:row.role,revision:Math.max(revision,row.revision+1),
          ...(row.sourceLifecycle.kind!=="deleted" || row.sourceLifecycle.ownedDeletion===undefined?{}:{ownedDeletion:row.sourceLifecycle.ownedDeletion})}))};
      const next=parseTerminalRecord(raw,projectId);await this.#writeProjectRecord(next);this.#publishCommitted(next,this.#lifecyclePublication(next,committed));return recordSnapshot(next);
    });
  }

  async beginExecutionSourceDeletion(
    input: ExecutionSourceDeletionInput,
    committed?: (commit: LifecycleStoreCommit) => void,
  ): Promise<BeginExecutionSourceDeletionResult> {
    return this.#mutate(async () => {
      const record = await this.#requireProjectRecord(input.projectId);
      const current = requireDeletionSession(record, input);
      if (current.revision !== input.expectedRevision) {
        return { kind: "conflict", session: copySession(current) };
      }
      const lifecycle = current.sourceLifecycle;
      if (lifecycle.kind === "deleted") return { kind: "already-deleted", session: copySession(current) };
      const fileDeletion = fileDeletionForBegin(lifecycle, input.fileDeletion);
      const imageDeletion = imageDeletionForBegin(lifecycle, input.imageDeletion);
      const ownedDeletion = ownedDeletionForBegin(current, input.ownedDeletion);
      if (lifecycle.kind === "deleting") return { kind: "already-deleting", session: copySession(current) };
      const now = new Date().toISOString();
      const session: ProjectSession = {
        ...current,
        revision: current.revision + 1,
        updatedAt: now,
        sourceLifecycle: {
          kind: "deleting",
          requestedAt: lifecycle.kind === "partial" ? lifecycle.requestedAt : now,
          updatedAt: now,
          ...(input.scheduleDeletion || (lifecycle.kind !== "available" && lifecycle.scheduleDeletion) ? { scheduleDeletion: true as const } : {}),
          progress: lifecycle.kind === "partial" ? { ...lifecycle.progress } : {},
          ...(fileDeletion === undefined ? {} : { fileDeletion }),
          ...(imageDeletion === undefined ? {} : { imageDeletion }),
          ...(ownedDeletion === undefined ? {} : { ownedDeletion }),
        },
      };
      const next = withDeletionSession(record, session);
      validateOwnedRecordClaims(await this.#readAllRecords(), next);
      await this.#writeProjectRecord(next);
      this.#publishCommitted(next, this.#lifecyclePublication(next, committed));
      return { kind: "started", session: copySession(session) };
    });
  }

  async recordExecutionSourceDeletion(
    input: RecordExecutionSourceDeletionInput,
  ): Promise<ProjectSessionUpdateResult> {
    return this.#mutate(async () => {
      const record = await this.#requireProjectRecord(input.projectId);
      const current = requireDeletionSession(record, input);
      if (current.revision !== input.expectedRevision) {
        return { kind: "conflict", session: copySession(current) };
      }
      const lifecycle = requireDeletionInProgress(current);
      const progress = mergeCleanupProgress(lifecycle.progress, parseCleanupProgress(input.progress));
      // 后续 owner 的事实只能建立在此前已落盘的附件完成之上，不能同次更新跳过边界。
      assertFileDeletionBeforeLog(lifecycle.fileDeletion, progress);
      assertImageDeletionBeforeLog(lifecycle.imageDeletion, progress);
      const fileDeletion = mergeFileDeletion(lifecycle.fileDeletion, input.fileDeletion);
      const imageDeletion = mergeImageDeletion(lifecycle.imageDeletion, input.imageDeletion);
      const ownedDeletion = mergeOwnedDeletion(lifecycle.ownedDeletion, input.ownedDeletion);
      assertOwnedDeletionBeforeLogs(lifecycle.fileDeletion, lifecycle.imageDeletion, ownedDeletion);
      const failure = input.failure === undefined ? undefined : parseCleanupFailure(input.failure);
      if (failure?.stage === "file-attachments" && fileDeletion === undefined) {
        throw new Error("File attachment failure requires the file deletion contract");
      }
      if (failure?.stage === "image-attachments" && imageDeletion === undefined) {
        throw new Error("Image attachment failure requires the image deletion contract");
      }
      const now = new Date().toISOString();
      const common = { requestedAt: lifecycle.requestedAt, updatedAt: now, progress,
        ...(input.scheduleDeletion || lifecycle.scheduleDeletion ? {scheduleDeletion:true as const} : {}),
        ...(fileDeletion === undefined ? {} : { fileDeletion }),
        ...(imageDeletion === undefined ? {} : { imageDeletion }),
        ...(ownedDeletion === undefined ? {} : { ownedDeletion }) };
      const session: ProjectSession = {
        ...current,
        revision: current.revision + 1,
        updatedAt: now,
        sourceLifecycle: failure === undefined
          ? { kind: "deleting", ...common }
          : { kind: "partial", ...common, failure },
      };
      const next = withDeletionSession(record, session);
      await this.#writeProjectRecord(next);
      this.#publishCommitted(next);
      return { kind: "updated", session: copySession(session) };
    });
  }

  async completeExecutionSourceDeletion(
    input: ExecutionSourceDeletionInput,
    committed?: (commit: LifecycleStoreCommit) => void,
  ): Promise<ProjectSessionUpdateResult> {
    return this.#mutate(async () => {
      const record = await this.#requireProjectRecord(input.projectId);
      const current = requireDeletionSession(record, input);
      if (current.revision !== input.expectedRevision) {
        return { kind: "conflict", session: copySession(current) };
      }
      const lifecycle = requireDeletionInProgress(current);
      if (input.fileDeletion !== undefined) mergeFileDeletion(lifecycle.fileDeletion, input.fileDeletion);
      if (input.imageDeletion !== undefined) mergeImageDeletion(lifecycle.imageDeletion, input.imageDeletion);
      if (input.ownedDeletion !== undefined) mergeOwnedDeletion(lifecycle.ownedDeletion, input.ownedDeletion);
      const progress = lifecycle.progress;
      if (lifecycle.fileDeletion !== undefined && !lifecycle.fileDeletion.complete) {
        throw new Error("Cannot complete source deletion before file attachments are confirmed");
      }
      if (lifecycle.imageDeletion !== undefined && !lifecycle.imageDeletion.complete) {
        throw new Error("Cannot complete source deletion before image attachments are confirmed");
      }
      if (lifecycle.scheduleDeletion && (progress.projectSchedules !== "cleared" || progress.nativeSchedules !== "cleared" || lifecycle.ownedDeletion?.members.some(row=>row.progress.nativeSchedules!=="cleared"))) throw new Error("Cannot complete deletion before schedules are confirmed");
      if (progress.projectionCache === undefined || progress.sessionLog === undefined
        || progress.queryIndex === undefined || progress.sessionInstructions === undefined) {
        throw new Error("Cannot complete source deletion before all cleanup owners are confirmed");
      }
      if (lifecycle.ownedDeletion?.members.some((member) => !cleanupOwnersComplete(member.progress))) {
        throw new Error("Cannot complete source deletion before all owned member cleanup owners are confirmed");
      }
      const now = new Date().toISOString();
      const allDeleted = sessionCarriers(current).every(carrier => carrier.hostSessionId === current.hostSessionId || carrier.sourceLifecycle.kind === "deleted");
      const session: ProjectSession = {
        ...current,
        title: allDeleted ? DELETED_SOURCE_TITLE : current.title,
        archived: allDeleted ? false : current.archived,
        revision: current.revision + 1,
        updatedAt: now,
        sourceLifecycle: { kind: "deleted", requestedAt: lifecycle.requestedAt, deletedAt: now,
          ...(lifecycle.ownedDeletion === undefined ? {} : { ownedDeletion: ownedDeletedSources(lifecycle.ownedDeletion) }) },
      };
      delete session.ownedLifecycle;
      const next = withDeletionSession(record, session);
      await this.#writeProjectRecord(next);
      this.#publishCommitted(next, this.#lifecyclePublication(next, committed));
      return { kind: "updated", session: copySession(session) };
    });
  }

  /** Whole-project deletion updates a preparation without creating work membership. */
  async beginMainPreparationSourceDeletion(input: MainPreparationSourceDeletionInput, committed?: (commit:LifecycleStoreCommit)=>void): Promise<MainPreparationResult> {
    return this.#updatePreparationDeletion(input, previous => {
      const life = previous.sourceLifecycle ?? {kind:'available' as const};
      if (life.kind === 'deleted' || life.kind === 'deleting') return previous;
      const now = new Date().toISOString();
      const fileDeletion = fileDeletionForBegin(life,input.fileDeletion), imageDeletion = imageDeletionForBegin(life,input.imageDeletion);
      const ownedDeletion = life.kind === 'partial' ? mergeOwnedDeletion(life.ownedDeletion,input.ownedDeletion) : input.ownedDeletion;
      return {...previous,updatedAt:now,sourceLifecycle:{kind:'deleting',requestedAt:life.kind==='partial'?life.requestedAt:now,updatedAt:now,scheduleDeletion:true,progress:life.kind==='partial'?life.progress:{},
        ...(fileDeletion===undefined?{}:{fileDeletion}),...(imageDeletion===undefined?{}:{imageDeletion}),...(ownedDeletion===undefined?{}:{ownedDeletion})}};
    },committed);
  }

  /** Persist only monotonic cleanup owner facts for this exact preparation. */
  async recordMainPreparationSourceDeletion(input: RecordMainPreparationSourceDeletionInput): Promise<MainPreparationResult> {
    return this.#updatePreparationDeletion(input, previous => {
      const life = previous.sourceLifecycle;
      if (life?.kind !== 'deleting' && life?.kind !== 'partial') throw new Error('Preparation deletion is not in progress');
      const progress = mergeCleanupProgress(life.progress,parseCleanupProgress(input.progress));
      assertFileDeletionBeforeLog(life.fileDeletion,progress); assertImageDeletionBeforeLog(life.imageDeletion,progress);
      const fileDeletion=mergeFileDeletion(life.fileDeletion,input.fileDeletion),imageDeletion=mergeImageDeletion(life.imageDeletion,input.imageDeletion),ownedDeletion=mergeOwnedDeletion(life.ownedDeletion,input.ownedDeletion);
      assertOwnedDeletionBeforeLogs(life.fileDeletion,life.imageDeletion,ownedDeletion);
      const failure=input.failure===undefined?undefined:parseCleanupFailure(input.failure),now=new Date().toISOString();
      if(failure?.stage==='file-attachments'&&fileDeletion===undefined)throw new Error('File attachment failure requires the file deletion contract');
      if(failure?.stage==='image-attachments'&&imageDeletion===undefined)throw new Error('Image attachment failure requires the image deletion contract');
      const common={requestedAt:life.requestedAt,updatedAt:now,scheduleDeletion:true as const,progress,...(fileDeletion===undefined?{}:{fileDeletion}),...(imageDeletion===undefined?{}:{imageDeletion}),...(ownedDeletion===undefined?{}:{ownedDeletion})};
      return {...previous,updatedAt:now,sourceLifecycle:failure===undefined?{kind:'deleting',...common}:{kind:'partial',...common,failure}};
    });
  }

  /** Confirm physical deletion only after every original cleanup owner completed. */
  async completeMainPreparationSourceDeletion(input: MainPreparationSourceDeletionInput, committed?: (commit:LifecycleStoreCommit)=>void): Promise<MainPreparationResult> {
    return this.#updatePreparationDeletion(input, previous => {
      const life=previous.sourceLifecycle;
      if(life?.kind!=='deleting'&&life?.kind!=='partial')throw new Error('Preparation deletion is not in progress');
      if(life.fileDeletion!==undefined&&!life.fileDeletion.complete||life.imageDeletion!==undefined&&!life.imageDeletion.complete)throw new Error('Preparation attachments are not complete');
      if(!cleanupOwnersComplete(life.progress)||life.progress.projectSchedules!=='cleared'||life.progress.nativeSchedules!=='cleared'||life.ownedDeletion?.members.some(member=>!cleanupOwnersComplete(member.progress)||member.progress.nativeSchedules!=='cleared'))throw new Error('Preparation cleanup owners are not complete');
      const now=new Date().toISOString();
      return {...previous,updatedAt:now,sourceLifecycle:{kind:'deleted',requestedAt:life.requestedAt,deletedAt:now,...(life.ownedDeletion===undefined?{}:{ownedDeletion:ownedDeletedSources(life.ownedDeletion)})}};
    },committed);
  }

  async #updatePreparationDeletion(input: MainPreparationSourceDeletionInput, change:(preparation:MainCarrierPreparation)=>MainCarrierPreparation, committed?:(commit:LifecycleStoreCommit)=>void):Promise<MainPreparationResult>{
    return this.#mutate(async()=>{
      const record=await this.#requireProjectRecord(input.projectId),current=requireSession(record,input.sessionId);
      if(record.project.sourceLifecycle===undefined||record.project.sourceLifecycle.kind==='deleted')throw new Error('Preparation cleanup requires active whole-project deletion');
      if(current.revision!==input.expectedRevision)return {kind:'conflict',session:copySession(current)};
      const previous=current.mainPreparations?.find(row=>row.attemptId===input.attemptId);
      if(previous===undefined||previous.state==='committed'||previous.toHostSessionId!==input.hostSessionId||previous.toHeader===undefined)throw new Error('Exact preparation cleanup identity is unavailable');
      const preparation=change(previous),session={...current,revision:current.revision+1,updatedAt:new Date().toISOString(),mainPreparations:current.mainPreparations!.map(row=>row.attemptId===input.attemptId?preparation:row)};
      const next=withSession(record,session,new Set(['mainPreparations','revision','updatedAt']));
      validateOwnedRecordClaims(await this.#readAllRecords(),next);await this.#writeProjectRecord(next);this.#publishCommitted(next,committed===undefined?undefined:this.#lifecyclePublication(next,committed));
      return {kind:'updated',session:copySession(session),preparation:structuredClone(preparation)};
    });
  }

  async listDeliveries(projectId: ProjectId): Promise<Delivery[]> {
    return this.#enqueue(async () => {
      const record = await this.#requireProjectRecord(projectId);
      return record.deliveries.map(copyDelivery).sort(byCreatedAt);
    });
  }

  async getDelivery(projectId: ProjectId, deliveryId: string): Promise<Delivery | undefined> {
    return this.#enqueue(async () => {
      const record = await this.#requireProjectRecord(projectId);
      const delivery = record.deliveries.find((candidate) => candidate.id === deliveryId);
      return delivery === undefined ? undefined : copyDelivery(delivery);
    });
  }

  /** Independent versioned collection; commits share the actual Store serial/atomic boundary. */
  async listCommunicationOperations(projectId: ProjectId): Promise<readonly CommunicationOperation[]> {
    return this.#enqueue(async () => {
      const read = await this.#requireProjectRead(projectId);
      return (read.communications ?? decodeOperationCollection(read.record.raw.communicationOperations)).operations;
    });
  }

  async registerCommunicationOperation(input: CommunicationOperation): Promise<{ readonly created: boolean; readonly operation: CommunicationOperation }> {
    const operation = decodeOperation(input);
    return this.#mutate(async () => {
      const read = await this.#requireProjectRead(operation.projectId), record = read.record;
      assertProjectAvailable(record.project);
      const collection = read.communications ?? decodeOperationCollection(record.raw.communicationOperations);
      const prior = collection.operations.find(row => row.operationRef === operation.operationRef);
      if (prior !== undefined) return { created: false, operation: prior };
      const version = Math.max(record.version, COMMUNICATION_RECORD_VERSION) as RecordVersion;
      const next = { ...record, version, raw: { ...record.raw, version,
        communicationOperations: decodeOperationCollection({ format: collection.format, operations: [...collection.operations, operation] }) } };
      await this.#writeProjectRecord(next);
      this.#publishCommitted(next);
      return { created: true, operation };
    });
  }

  async updateCommunicationOperation(input: CommunicationOperation, expectedPrevious?: CommunicationOperation): Promise<CommunicationOperation> {
    const operation = decodeOperation(input);
    return this.#mutate(async () => {
      const read = await this.#requireProjectRead(operation.projectId), record = read.record;
      const collection = read.communications ?? decodeOperationCollection(record.raw.communicationOperations);
      const prior = collection.operations.find(row => row.operationRef === operation.operationRef);
      if (prior === undefined) throw new Error('Communication operation was not registered');
      if (expectedPrevious !== undefined && !isDeepStrictEqual(prior, decodeOperation(expectedPrevious))) throw new CommunicationOperationConflictError(prior);
      if (prior.argumentsDigest !== operation.argumentsDigest || JSON.stringify(prior.invocationSource) !== JSON.stringify(operation.invocationSource)
        || prior.projectId !== operation.projectId || prior.registeredAt !== operation.registeredAt
        || (prior.deliveryId !== undefined && (prior.deliveryId !== operation.deliveryId || prior.nativeMessageId !== operation.nativeMessageId || prior.snapshotDigest !== operation.snapshotDigest))
        || (prior.attemptedAt !== undefined && prior.attemptedAt !== operation.attemptedAt)) throw new Error('Communication immutable identity conflict');
      const version = Math.max(record.version, COMMUNICATION_RECORD_VERSION) as RecordVersion;
      const next = { ...record, version, raw: { ...record.raw, version,
        communicationOperations: decodeOperationCollection({ format: collection.format, operations: collection.operations.map(row => row.operationRef === operation.operationRef ? operation : row) }) } };
      await this.#writeProjectRecord(next);
      this.#publishCommitted(next);
      return operation;
    });
  }

  /**
   * 只解析旧封套中的直接原生 locator；不会返回旧业务正文或把它重新投影为当前记录。
   */
  async readLegacySourceLocators(
    projectId: ProjectId,
    reference: LegacySourceReference,
  ): Promise<{ sources: NativeProjectSource[]; reason: string }> {
    return this.#enqueue(async () => {
      const record = await this.#requireProjectRecord(projectId);
      return legacySourceLocators(record.raw, reference);
    });
  }

  /**
   * 仅供 Host 在确认真实 DSH 会话尚未创建时撤销新绑定。
   */
  async removeSessionBinding(
    projectId: ProjectId,
    sessionId: ProjectSessionId,
    options: RemoveSessionBindingOptions,
  ): Promise<RemovedSessionBinding> {
    return this.#mutate(async () => {
      const record = await this.#requireProjectRecord(projectId);
      assertProjectAvailable(record.project);
      const index = record.sessions.findIndex((session) => session.id === sessionId);
      if (index < 0) throw new Error("Project session not found: " + projectId + "/" + sessionId);
      const session = record.sessions[index];
      if (session === undefined) throw new Error("Project session not found: " + projectId + "/" + sessionId);
      assertAvailableSession(session);
      if (sessionCarriers(session).length !== 1) throw new Error("Cannot roll back a materialized multi-carrier binding");
      if (currentCarrier(session).header !== undefined) throw new Error("Cannot roll back a binding with confirmed native creation identity");
      if (session.hostSessionId !== options.expectedHostSessionId) {
        throw new Error("Host session id does not match binding: " + projectId + "/" + sessionId);
      }
      const now = new Date().toISOString();
      const project = touchProject(record.project, now);
      if (project.mainSessionId === session.id) delete project.mainSessionId;
      const next = removeSession(
        withProject(
          record,
          project,
          new Set<ProjectRawField>(["mainSessionId", "revision", "updatedAt"]),
        ),
        session.id,
      );
      await this.#writeProjectRecord(next);
      this.#publishCommitted(next);
      return { project: copyProject(project), session: copySession(session) };
    });
  }

  /**
   * 只回滚未物化 Host 会话留下的最小 v5/v7 空项目；历史或未知字段一律保留。
   */
  async removeEmptyProject(
    projectId: ProjectId,
    expected: { expectedCreatedAt: string; expectedRevision: number },
  ): Promise<boolean> {
    return this.#mutate(async () => {
      const record = (await this.#readProjectRecord(projectId))?.record;
      if (record === undefined) return false;
      if (
        record.project.createdAt !== expected.expectedCreatedAt
        || record.project.revision !== expected.expectedRevision
        || !isRemovableEmptyProject(record)
      ) {
        return false;
      }
      const directory = this.#projectDirectory(projectId);
      const entries = await readdir(directory);
      if (entries.length !== 1 || entries[0] !== RECORD_FILE_NAME) return false;
      await removeFileDurable(this.#recordPath(projectId));
      this.#recordReads.delete(projectId);
      try { await rmdir(directory); await syncDirectory(this.#rootDirectory); }
      catch (error) { throw new DurableMutationError('directory-sync', 'published-durability-unknown', error); }
      return true;
    });
  }

  async listMemberships(): Promise<ProjectMembership[]> {
    return this.listOperationalMemberships();
  }

  async findMembershipByHostSessionId(
    hostSessionId: string,
  ): Promise<ProjectMembership | undefined> {
    return this.findOperationalMembershipByHostSessionId(hostSessionId);
  }

  async listOperationalMemberships(): Promise<ProjectMembership[]> {
    return this.#enqueue(async () => membershipsFromRecords(await this.#readAllRecords()));
  }

  async findOperationalMembershipByHostSessionId(
    hostSessionId: string,
  ): Promise<ProjectMembership | undefined> {
    return this.#enqueue(async () => {
      const membership = findMembership(await this.#readAllRecords(), hostSessionId);
      return membership === undefined || membership.project.sourceLifecycle !== undefined
        || membership.session.sourceLifecycle.kind !== "available" || currentCarrier(membership.session).closed !== undefined
        ? undefined : copyMembership(membership);
    });
  }

  async listProjectLifecycleTargets(projectId: ProjectId): Promise<ProjectSession[]> {
    return this.#enqueue(async () => lifecycleSessions(await this.#requireProjectRecord(projectId))
      .map(copySession).sort(byCreatedAt));
  }

  async listDispatchTargets(projectId: ProjectId): Promise<ProjectSession[]> {
    return this.#enqueue(async () => operationalSessions(await this.#requireProjectRecord(projectId))
      .filter((session) => session.role === "main" || session.role === "execution")
      .map(copySession).sort(byCreatedAt));
  }

  async findDispatchTarget(
    projectId: ProjectId,
    sessionId: ProjectSessionId,
  ): Promise<ProjectSession | undefined> {
    return this.#enqueue(async () => {
      const record = await this.#requireProjectRecord(projectId);
      const session = operationalSessions(record).find((candidate) => candidate.id === sessionId
        && (candidate.role === "main" || candidate.role === "execution"));
      return session === undefined ? undefined : copySession(session);
    });
  }

  async listRetainedSessionSources(projectId?: ProjectId): Promise<ProjectSessionSource[]> {
    return this.#enqueue(async () => {
      const scoped = projectId === undefined ? undefined : (await this.#readProjectRecord(projectId))?.record;
      const records = projectId === undefined ? await this.#readAllRecords() : scoped === undefined ? [] : [scoped];
      return records.flatMap(retainedSources).sort(byCreatedAt);
    });
  }

  async findSessionSourceByHostSessionId(hostSessionId: string, owner?: { readonly projectId: string; readonly logicalSessionId?: string }): Promise<ProjectSessionSource | undefined> {
    return this.#enqueue(async () => {
      const scoped = owner === undefined ? undefined : (await this.#readProjectRecord(owner.projectId))?.record;
      if (owner?.logicalSessionId !== undefined && scoped === undefined) throw new Error('PROJECT_SOURCE_IDENTITY_MISMATCH');
      const records = owner === undefined ? await this.#readAllRecords() : scoped === undefined ? [] : [scoped];
      for (const record of records) for (const session of record.sessions) {
        const carrier = sessionCarriers(session).find(row => row.hostSessionId === hostSessionId);
        if (carrier !== undefined) {
          if (owner?.logicalSessionId !== undefined && session.id !== owner.logicalSessionId) throw new Error('PROJECT_SOURCE_IDENTITY_MISMATCH');
          return {...copySessionSource(session, carrier), ...(record.project.sourceLifecycle === undefined ? {} : {projectDeletion:true as const})};
        }
      }
      return undefined;
    });
  }

  async listCatalogClaims(): Promise<string[]> {
    return this.#enqueue(async () => (await this.#readAllRecords())
      .flatMap((record) => record.sessions.flatMap((session) => sessionCarriers(session).map(carrier => carrier.hostSessionId))));
  }

  /** native 接纳投影必须在任何普通发布前同步替换；不可在回调中异步读取 Store。 */
  addSourceDispositionListener(listener: ProjectRecordListener): () => void {
    this.#sourceDispositionListeners.add(listener);
    return () => { this.#sourceDispositionListeners.delete(listener); };
  }

  subscribe(listener: ProjectRecordListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async #ensureRootDirectory(): Promise<void> {
    await mkdir(this.#rootDirectory, { recursive: true });
  }

  #projectDirectory(projectId: ProjectId): string {
    return join(this.#rootDirectory, safeIdentifier(projectId, "project id"));
  }

  #recordPath(projectId: ProjectId): string {
    return join(this.#projectDirectory(projectId), RECORD_FILE_NAME);
  }

  async #readAllRecords(): Promise<PersistedProjectRecord[]> {
    await this.#ensureRootDirectory();
    const entries = await readdir(this.#rootDirectory, { withFileTypes: true });
    const projectIds = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => safeIdentifier(entry.name, "project id"))
      .sort();
    const records: PersistedProjectRecord[] = [];
    const present = new Set(projectIds);
    for (const id of this.#recordReads.keys()) if (!present.has(id)) this.#recordReads.delete(id);
    const hostSessionIds = new Set<string>();
    for (const projectId of projectIds) {
      const record = await this.#requireProjectRecord(projectId);
      for (const session of record.sessions) {
        for (const carrier of sessionCarriers(session)) {
          if (hostSessionIds.has(carrier.hostSessionId)) {
            throw new Error("Duplicate host session binding in local records: " + carrier.hostSessionId);
          }
          hostSessionIds.add(carrier.hostSessionId);
        }
      }
      for (const session of record.sessions) {
        for (const memberId of ownedMemberIds(session)) {
          if (hostSessionIds.has(memberId)) throw new Error("Duplicate owned source identity in local records: " + memberId);
          hostSessionIds.add(memberId);
        }
      }
      records.push(record);
    }
    return records;
  }

  async #readProjectRecord(projectId: ProjectId): Promise<ProjectRecordRead | undefined> {
    const id = safeIdentifier(projectId, "project id");
    const directory = this.#projectDirectory(id);
    const path = this.#recordPath(id);
    try {
      // This remains a fresh filesystem observation on every read, including
      // reads issued through another Store or after another process commits.
      const stamp = recordFileStamp(await stat(path, { bigint: true }));
      const previous = this.#recordReads.get(id);
      if (previous?.stamp === stamp) return previous.read;
      this.#recordReads.delete(id);
      const file = await open(path, "r");
      let serialized: string;
      let confirmed: string | undefined;
      try {
        const before = recordFileStamp(await file.stat({ bigint: true }));
        serialized = await file.readFile("utf8");
        const after = recordFileStamp(await file.stat({ bigint: true }));
        if (before === after) {
          // A concurrent atomic replacement does not invalidate this opened
          // file's legal snapshot. It only prevents reuse under the new path.
          try { if (after === recordFileStamp(await stat(path, { bigint: true }))) confirmed = after; }
          catch { /* The opened read remains valid; the next call checks the path afresh. */ }
        }
      } finally { await file.close(); }
      let parsed: unknown;
      try { parsed = JSON.parse(serialized); }
      catch (error) { throw new Error("Project record contains invalid JSON: " + id, { cause: error }); }
      const read = parseProjectRecord(parsed, id);
      if (confirmed !== undefined) this.#recordReads.set(id, { stamp: confirmed, read: immutableRecordRead(read) });
      return read;
    } catch (error) {
      this.#recordReads.delete(id);
      if (errorCode(error) !== "ENOENT") throw error;
      try {
        const directoryStatus = await stat(directory);
        if (directoryStatus.isDirectory()) throw new Error("Project record is missing: " + id);
        throw new Error("Project path is not a directory: " + id);
      } catch (statusError) {
        if (errorCode(statusError) === "ENOENT") return undefined;
        throw statusError;
      }
    }
  }

  async #requireProjectRecord(projectId: ProjectId): Promise<PersistedProjectRecord> {
    return (await this.#requireProjectRead(projectId)).record;
  }

  async #requireProjectRead(projectId: ProjectId): Promise<ProjectRecordRead> {
    const record = await this.#readProjectRecord(projectId);
    if (record === undefined) throw new Error("Project not found: " + projectId);
    return record;
  }

  async #writeProjectRecord(record: PersistedProjectRecord, beforeCommit?: () => void): Promise<void> {
    try {
      await writeFileDurable(this.#recordPath(record.project.id), JSON.stringify(record.raw, undefined, 2) + "\n",
        beforeCommit === undefined ? undefined : { beforePublish: beforeCommit });
    } finally { this.#recordReads.delete(record.project.id); }
  }

  /** Publish only a complete new directory; incomplete staging never enters the record catalog. */
  async #createProjectRecord(record: PersistedProjectRecord): Promise<void> {
    const directory = this.#projectDirectory(record.project.id);
    try {
      await lstat(directory);
      throw new Error("Project already exists: " + record.project.id);
    } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    const root = resolve(this.#rootDirectory), parent = dirname(root);
    // A sibling avoids reserving an id or hiding malformed directories inside the catalog.
    const staging = await mkdtemp(join(parent, "." + basename(root) + ".create-"));
    let stage: "write" | "rename" | "directory-sync" = "write";
    let published = false;
    let identity: { readonly dev: bigint; readonly ino: bigint } | undefined;
    try {
      identity = await lstat(staging, { bigint: true });
      await writeFileDurable(join(staging, RECORD_FILE_NAME), JSON.stringify(record.raw, undefined, 2) + "\n");
      stage = "rename";
      await rename(staging, directory);
      published = true;
      stage = "directory-sync";
      await syncDirectory(root);
      await syncDirectory(parent);
    } catch (error) {
      let effect: "none" | "published-durability-unknown" = published ? "published-durability-unknown" : "none";
      if (!published && stage === "rename") {
        try {
          const actual = await lstat(directory, { bigint: true });
          if (identity === undefined || actual.dev === identity.dev && actual.ino === identity.ino) effect = "published-durability-unknown";
        } catch (readError) { if (errorCode(readError) !== "ENOENT") effect = "published-durability-unknown"; }
      }
      if (effect === "none") {
        try { await rm(staging, { recursive: true, force: true }); await syncDirectory(parent); }
        catch (cleanup) { console.warn("Unpublished project staging cleanup failed", cleanup); }
      }
      // An inner record may exist in staging; only the directory rename publishes the Project.
      const details = durableMutationDetails(error);
      throw new DurableMutationError(stage === "write" ? details?.stage ?? stage : stage, effect,
        error instanceof DurableMutationError ? error.cause ?? error : error);
    }
  }

  /** Internal final commit seam. The callback uses explicit Within methods, never a public mutation. */
  withMetadataWrite<T>(
    projectId: string,
    authorize: (fresh: ProjectSnapshot) => void,
    action: (scope: RootWriteScope, fresh: ProjectSnapshot) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.#mutate(async scope => {
      signal?.throwIfAborted();
      const fresh = recordSnapshot(await this.#requireProjectRecord(projectId));
      authorize(fresh);
      return action(scope, fresh);
    }, signal);
  }

  /**
   * Retain before ordinary admission closes. The caller publishes this capability
   * only after its prepare commits; it never admits a new business mutation.
   * Settlement still acquires the original root lock and authorizes fresh facts.
   */
  retainMetadataSettlement(projectId: string, authorize: (fresh: ProjectSnapshot) => void): MetadataSettlementWriter {
    this.#writeLifetime.signal.throwIfAborted();
    let used = false;
    return {
      write: <T>(action: (scope: RootWriteScope, fresh: ProjectSnapshot) => Promise<T>, signal?: AbortSignal): Promise<T> => {
        if (used) return Promise.reject(new Error('Metadata settlement writer is already released'));
        used = true;
        return this.#enqueue(() => withRootWriteLock({ root: this.#rootDirectory, anchor: ".metadata.lock", signal }, async scope => {
          const fresh = recordSnapshot(await this.#requireProjectRecord(projectId));
          authorize(fresh);
          return action(scope, fresh);
        }));
      },
      release: () => { used = true; },
    };
  }

  /** Closing cancels pending acquisition only; an entered action still drains its original I/O. */
  cancelPendingWrites(reason: unknown = new Error('Projects metadata owner is closing')): void {
    this.#writeLifetime.abort(reason);
  }

  #mutate<T>(operation: (scope: RootWriteScope) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const lifetime = signal === undefined ? this.#writeLifetime.signal : AbortSignal.any([signal, this.#writeLifetime.signal]);
    return this.#enqueue(() => withRootWriteLock({ root: this.#rootDirectory, anchor: ".metadata.lock", signal: lifetime }, operation));
  }

  #lifecyclePublication(record: PersistedProjectRecord, committed?: (commit: LifecycleStoreCommit) => void): LifecyclePublication | undefined {
    if (committed === undefined) return undefined;
    const publication: LifecyclePublication = { sources: [...this.#sourceDispositionListeners], confirmed: new Set(), displayed: false };
    try { committed({ snapshot: recordSnapshot(record), confirmSource: () => this.#enqueue(async () => {
      const current = await this.#requireProjectRecord(record.project.id);
      this.#publish(current, publication);
      return recordSnapshot(current);
    }) }); } catch (error) { throw new DurableMutationError('source-publication', 'durable', error); }
    return publication;
  }

  #publishCommitted(record: PersistedProjectRecord, publication?: LifecyclePublication): void {
    try { this.#publish(record, publication); }
    catch (error) { throw new DurableMutationError('source-publication', 'durable', error); }
  }

  #publish(record: PersistedProjectRecord, publication?: LifecyclePublication): void {
    for (const listener of publication?.sources ?? [...this.#sourceDispositionListeners]) {
      if (publication?.confirmed.has(listener)) continue;
      listener(recordSnapshot(record));
      publication?.confirmed.add(listener);
    }
    if (publication?.displayed) return;
    if (publication !== undefined) publication.displayed = true;
    // 普通显示订阅不能把已提交且source已确认的事实改报为保存失败；不重发通知。
    for (const listener of [...this.#listeners]) {
      try { listener(recordSnapshot(record)); }
      catch (error) { this.#observerFailure(error); }
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#serial.then(operation, operation);
    this.#serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function parseProjectRecord(value: unknown, expectedProjectId: ProjectId): ProjectRecordRead {
  const raw = objectValue(value, "project record");
  const version = recordVersion(raw.version, expectedProjectId);
  if (version >= PROJECT_DELETION_RECORD_VERSION && raw.terminal === true) return { record: parseTerminalRecord(raw, expectedProjectId) };
  if (raw.communicationOperations !== undefined && version < COMMUNICATION_RECORD_VERSION) throw new Error('Communication operations require project record v13');
  const communications = decodeOperationCollection(raw.communicationOperations);
  if (communications.operations.some(row => row.projectId !== expectedProjectId)) throw new Error('Communication operation belongs to another project');
  const project = parseProject(raw.project, expectedProjectId);
  if(project.sourceLifecycle!==undefined&&version<PROJECT_DELETION_RECORD_VERSION)throw new Error("Project deletion requires record v12");
  const sessions = arrayValue(raw.sessions, "project record sessions: " + expectedProjectId).map(
    (session) => parseProjectSession(session, project.id, version),
  );
  let deliveryValues: unknown[];
  if (raw.deliveries === undefined) {
    if (version === LEGACY_CURRENT_RECORD_VERSION) {
      throw new Error("Project record deliveries must be an array: " + expectedProjectId);
    }
    deliveryValues = [];
  } else {
    deliveryValues = arrayValue(raw.deliveries, "project record deliveries: " + expectedProjectId);
  }
  // v6/v7/v8 可由历史封套局部升级，不能借删除或 Bot 绑定归一化旧 locator。
  const deliveries = deliveryValues.map((delivery) => parseDelivery(delivery, version === LEGACY_CURRENT_RECORD_VERSION));
  const record: PersistedProjectRecord = { version, raw, project, sessions, deliveries };
  if (record.project.sourceLifecycle===undefined && record.sessions.some(row=>row.role!=="execution" && (sessionCarriers(row).some(carrier=>carrier.sourceLifecycle.kind!=="available") || (row.mainPreparations??[]).some(preparation=>preparation.sourceLifecycle!==undefined)))) throw new Error("Nonexecution deletion requires project ownership");
  validateCurrentConsistency(record);
  return { record, communications };
}

function recordVersion(value: unknown, projectId: string): RecordVersion {
  if (value === 1 || value === 2 || value === 3 || value === 4
    || value === LEGACY_CURRENT_RECORD_VERSION || value === DELETION_RECORD_VERSION
    || value === MEMORY_RECORD_VERSION || value === FILE_DELETION_RECORD_VERSION
    || value === IMAGE_DELETION_RECORD_VERSION || value === OWNED_DELETION_RECORD_VERSION
    || value === OWNED_LIFECYCLE_RECORD_VERSION || value === PROJECT_DELETION_RECORD_VERSION || value === COMMUNICATION_RECORD_VERSION
    || value === CARRIER_RECORD_VERSION || value === CONTINUITY_RECORD_VERSION) {
    return value;
  }
  throw new Error("Unsupported project record version for " + projectId);
}

function parseProject(value: unknown, expectedProjectId: ProjectId): Project {
  const source = objectValue(value, "project");
  const id = safeIdentifier(stringValue(source.id, "project id"), "project id");
  if (id !== expectedProjectId) {
    throw new Error("Project record id does not match its directory: " + expectedProjectId);
  }
  const project: Project = {
    id,
    name: requiredText(stringValue(source.name, "project name"), "project name"),
    archived: source.archived === undefined ? false : booleanValue(source.archived, "project archived"),
    revision: revisionValue(source.revision, "project revision"),
    createdAt: requiredText(stringValue(source.createdAt, "project createdAt"), "project createdAt"),
    updatedAt: requiredText(stringValue(source.updatedAt, "project updatedAt"), "project updatedAt"),
  };
  if (source.sourceLifecycle !== undefined) project.sourceLifecycle = parseProjectSourceLifecycle(source.sourceLifecycle);
  if (source.workspace !== undefined) project.workspace = parseWorkspace(source.workspace);
  if (source.mainSessionId !== undefined) {
    project.mainSessionId = safeIdentifier(
      stringValue(source.mainSessionId, "main session id"),
      "main session id",
    );
  }
  return project;
}

function parseProjectSession(value: unknown, projectId: ProjectId, version: RecordVersion): ProjectSession {
  const source = objectValue(value, "project session");
  const storedProjectId = safeIdentifier(
    stringValue(source.projectId, "project session project id"),
    "project session project id",
  );
  if (storedProjectId !== projectId) {
    throw new Error("Project session has a different project id: " + storedProjectId);
  }
  const role = stringValue(source.role, "project session role");
  if (role !== "main" && role !== "execution" && !(version >= MEMORY_RECORD_VERSION && role === "memory") && !(version >= CONTINUITY_RECORD_VERSION && role === "session-manager")) {
    throw new Error("Unsupported project session role in local record: " + role);
  }
  if (version >= CARRIER_RECORD_VERSION) {
    if ("hostSessionId" in source || "sourceLifecycle" in source || "ownedLifecycle" in source) {
      throw new Error("Carrier record cannot contain legacy single-host truth");
    }
    const carriers = arrayValue(source.carriers, "project session carriers").map(parseCarrier);
    const first = carriers[0];
    if (first === undefined) throw new Error("Project session must retain at least one carrier");
    const session = projectCurrentCarrier({
      id: safeIdentifier(stringValue(source.id, "project session id"), "project session id"), projectId, role,
      hostSessionId: first.hostSessionId, sourceLifecycle: first.sourceLifecycle, carriers,
      ...(source.mainPreparations === undefined ? {} : { mainPreparations: parseMainPreparations(source.mainPreparations, version) }),
      title: requiredText(stringValue(source.title, "project session title"), "project session title"),
      archived: source.archived === undefined ? false : booleanValue(source.archived, "project session archived"),
      revision: revisionValue(source.revision, "project session revision"),
      createdAt: requiredText(stringValue(source.createdAt, "project session createdAt"), "project session createdAt"),
      updatedAt: requiredText(stringValue(source.updatedAt, "project session updatedAt"), "project session updatedAt"),
    });
    validateCarriers(session);
    return session;
  }
  if (source.carriers !== undefined) throw new Error("Carrier relations require project record v14");
  const sourceLifecycle = parseSourceLifecycle(source.sourceLifecycle, version);
  if (source.ownedLifecycle !== undefined && version < OWNED_LIFECYCLE_RECORD_VERSION) {
    throw new Error("Owned lifecycle requires project record version 11");
  }
  if (sourceLifecycle.kind !== "available"
    && (version < DELETION_RECORD_VERSION || (role !== "execution" && version < PROJECT_DELETION_RECORD_VERSION))) {
    throw new Error("Nonavailable execution source requires project record version 6, 7, 8 or 9");
  }
  const session: ProjectSession = {
    id: safeIdentifier(stringValue(source.id, "project session id"), "project session id"),
    projectId: storedProjectId,
    hostSessionId: requiredText(
      stringValue(source.hostSessionId, "host session id"),
      "host session id",
    ),
    role,
    sourceLifecycle,
    ...(source.ownedLifecycle === undefined ? {} : { ownedLifecycle: parseOwnedLifecycle(source.ownedLifecycle) }),
    title: requiredText(stringValue(source.title, "project session title"), "project session title"),
    archived: source.archived === undefined
      ? false
      : booleanValue(source.archived, "project session archived"),
    revision: revisionValue(source.revision, "project session revision"),
    createdAt: requiredText(
      stringValue(source.createdAt, "project session createdAt"),
      "project session createdAt",
    ),
    updatedAt: requiredText(
      stringValue(source.updatedAt, "project session updatedAt"),
      "project session updatedAt",
    ),
  };
  return { ...session, carriers: sessionCarriers(session) };
}

function parseCarrier(value: unknown): ProjectSessionCarrier {
  const source = objectValue(value, "session carrier");
  const hostSessionId = requiredText(stringValue(source.hostSessionId, "carrier host session id"), "carrier host session id");
  const sequence = revisionValue(source.sequence, "carrier sequence");
  const sourceLifecycle = parseSourceLifecycle(source.sourceLifecycle, CARRIER_RECORD_VERSION);
  if (source.lifecycleTimeBasis !== undefined && (source.lifecycleTimeBasis !== "project-deletion" || sourceLifecycle.kind !== "deleted")) {
    throw new Error("Invalid legacy carrier lifecycle time basis");
  }
  return { sequence, hostSessionId, isCurrent: booleanValue(source.isCurrent, "carrier isCurrent"), sourceLifecycle,
    ...(source.lifecycleTimeBasis === undefined ? {} : { lifecycleTimeBasis: "project-deletion" as const }),
    ...(source.boundAt === undefined ? {} : { boundAt: requiredText(stringValue(source.boundAt, "carrier boundAt"), "carrier boundAt") }),
    ...(source.header === undefined ? {} : { header: carrierHeader(source.header, hostSessionId) }),
    ...(source.closed === undefined ? {} : { closed: parseCarrierClosed(source.closed) }),
    ...(source.ownedLifecycle === undefined ? {} : { ownedLifecycle: parseOwnedLifecycle(source.ownedLifecycle) }) };
}

function parseCarrierClosed(value: unknown): NonNullable<ProjectSessionCarrier["closed"]> {
  const source = ownedObject(value, ["confirmedAt", "reason"], "carrier closed");
  if (source.reason !== "ended" && source.reason !== "retired") throw new Error("Unsupported carrier ending reason");
  return { confirmedAt: requiredText(stringValue(source.confirmedAt, "carrier confirmedAt"), "carrier confirmedAt"), reason: source.reason };
}

function carrierHeader(value: unknown, hostSessionId: string): SessionOwnedSessionHeader {
  const header = parseCreationHeader(value, false);
  if (header.id !== hostSessionId || header.parentSession !== undefined || header.origin === "subagent") {
    throw new Error("Carrier requires its exact native root creation identity");
  }
  return header;
}

function sessionCarriers(session: ProjectSession): readonly ProjectSessionCarrier[] {
  return session.carriers ?? [{ sequence: 1, hostSessionId: session.hostSessionId, isCurrent: true,
    sourceLifecycle: session.sourceLifecycle,
    ...(session.ownedLifecycle === undefined ? {} : { ownedLifecycle: session.ownedLifecycle, header: session.ownedLifecycle.rootHeader }) }];
}

function currentCarrier(session: ProjectSession): ProjectSessionCarrier {
  const carriers = sessionCarriers(session), current = carriers.filter(carrier => carrier.isCurrent);
  if (current.length !== 1) throw new Error("Project session must have exactly one current carrier");
  return current[0]!;
}

function projectCurrentCarrier(session: ProjectSession): ProjectSession {
  const carrier = currentCarrier(session), next = { ...session, carriers: sessionCarriers(session),
    hostSessionId: carrier.hostSessionId, sourceLifecycle: carrier.sourceLifecycle };
  if (carrier.ownedLifecycle === undefined) delete next.ownedLifecycle;
  else next.ownedLifecycle = carrier.ownedLifecycle;
  return next;
}

function requireSession(record: PersistedProjectRecord, sessionId: string): ProjectSession {
  const session = record.sessions.find(row => row.id === sessionId);
  if (session === undefined) throw new Error("Project session not found: " + record.project.id + "/" + sessionId);
  return session;
}

function requireCarrier(session: ProjectSession, hostSessionId: string): ProjectSessionCarrier {
  const carrier = sessionCarriers(session).find(row => row.hostSessionId === hostSessionId);
  if (carrier === undefined) throw new Error("Host is not a carrier of this Project session: " + hostSessionId);
  return carrier;
}

/** 内部 owner 算法临时使用原段投影；它绝不作为当前入口 DTO 发布。 */
function sessionAtCarrier(session: ProjectSession, carrier: ProjectSessionCarrier): ProjectSession {
  const next = { ...session, hostSessionId: carrier.hostSessionId, sourceLifecycle: carrier.sourceLifecycle };
  if (carrier.ownedLifecycle === undefined) delete next.ownedLifecycle;
  else next.ownedLifecycle = carrier.ownedLifecycle;
  return next;
}

function copyCarrier(carrier: ProjectSessionCarrier): ProjectSessionCarrier {
  return { ...carrier, sourceLifecycle: copySourceLifecycle(carrier.sourceLifecycle),
    ...(carrier.header === undefined ? {} : { header: { ...carrier.header } }),
    ...(carrier.closed === undefined ? {} : { closed: { ...carrier.closed } }),
    ...(carrier.ownedLifecycle === undefined ? {} : { ownedLifecycle: copyOwnedLifecycle(carrier.ownedLifecycle) }) };
}

function carrierMembership(project: Project, session: ProjectSession, carrier: ProjectSessionCarrier): ProjectCarrierMembership {
  return { project: copyProject(project), session: copySession(session), projectSessionId: session.id, carrier: copyCarrier(carrier) };
}

function validateCarriers(session: ProjectSession): void {
  const carriers = sessionCarriers(session); currentCarrier(session);
  for (const [index, carrier] of carriers.entries()) {
    if (carrier.sequence !== index + 1) throw new Error("Carrier sequence must retain original contiguous order");
    if (carrier.header !== undefined) carrierHeader(carrier.header, carrier.hostSessionId);
    const root = sessionAtCarrier(session, carrier);
    validateOwnedMembers(root); validateOwnedLifecycle(root);
    if (carrier.header !== undefined && carrier.ownedLifecycle !== undefined
      && !sameOwnedLifecycleHeader(carrier.header, carrier.ownedLifecycle.rootHeader)) throw new Error("Carrier and owned creation identities conflict");
  }
}

function archiveCarriers(session: ProjectSession, proofs: readonly { readonly hostSessionId: string; readonly ownedLifecycle: SessionOwnedLifecycle }[]): ProjectSession {
  const expected = sessionCarriers(session).filter(carrier => carrier.sourceLifecycle.kind === "available");
  const supplied = new Map(proofs.map(proof => [proof.hostSessionId, proof.ownedLifecycle]));
  if (supplied.size !== proofs.length || supplied.size !== expected.length || expected.some(carrier => !supplied.has(carrier.hostSessionId))) {
    throw new Error("Archive proof must cover the complete exact carrier roster");
  }
  return projectCurrentCarrier({ ...session, carriers: sessionCarriers(session).map(carrier => {
    const proof = supplied.get(carrier.hostSessionId);
    if (proof === undefined) return carrier;
    const ownedLifecycle = mergeOwnedLifecycle(sessionAtCarrier(session, carrier), proof);
    if (carrier.header !== undefined && !sameOwnedLifecycleHeader(carrier.header, ownedLifecycle.rootHeader)) throw new Error("Carrier and archive creation identities conflict");
    return { ...carrier, ownedLifecycle, header: carrier.header ?? ownedLifecycle.rootHeader };
  }) });
}

function parseDelivery(value: unknown, strictSources: boolean): Delivery {
  const source = objectValue(value, "delivery");
  const dispatch = deliveryDispatchValue(source.dispatch);
  const nativeMessageId = source.nativeMessageId === undefined
    ? undefined
    : requiredText(
      stringValue(source.nativeMessageId, "delivery native message id"),
      "delivery native message id",
    );
  if ((dispatch === "delivered") !== (nativeMessageId !== undefined)) {
    throw new Error("Delivery dispatch and native message receipt are inconsistent");
  }
  const delivery: Delivery = {
    id: safeIdentifier(stringValue(source.id, "delivery id"), "delivery id"),
    intent: deliveryIntentValue(source.intent),
    senderSessionId: safeIdentifier(
      stringValue(source.senderSessionId, "delivery sender session id"),
      "delivery sender session id",
    ),
    targetSessionId: safeIdentifier(
      stringValue(source.targetSessionId, "delivery target session id"),
      "delivery target session id",
    ),
    sources: parseDeliverySources(source.sources, strictSources),
    dispatch,
    processing: deliveryProcessingValue(source.processing),
    createdAt: requiredText(
      stringValue(source.createdAt, "delivery createdAt"),
      "delivery createdAt",
    ),
    updatedAt: requiredText(
      stringValue(source.updatedAt, "delivery updatedAt"),
      "delivery updatedAt",
    ),
  };
  if (nativeMessageId !== undefined) delivery.nativeMessageId = nativeMessageId;
  if (source.continuesDeliveryId !== undefined) {
    try {
      delivery.continuesDeliveryId = safeIdentifier(
        stringValue(source.continuesDeliveryId, "delivery continuation id"),
        "delivery continuation id",
      );
    } catch (error) {
      if (strictSources) throw error;
    }
  }
  return delivery;
}

function parseDeliverySources(value: unknown, strict: boolean): SourceRef[] {
  if (!Array.isArray(value) && !strict) return [];
  const values = arrayValue(value, "delivery sources");
  const sources: SourceRef[] = [];
  for (const source of values) {
    const parsed = parseNativeSource(source);
    if (parsed !== undefined) {
      sources.push(parsed);
    } else if (strict) {
      throw new Error("Delivery source must be a native message or tool locator");
    }
  }
  return uniqueNativeSources(sources);
}

function validateCurrentConsistency(record: PersistedProjectRecord): void {
  validateSessionConsistency(record.project, record.sessions);
  for (const session of record.sessions) {
    validateCarriers(session);
  }
  validateOwnedSourceClaims(record.sessions);
  const sessions = new Set(record.sessions.map((session) => session.id));
  const deliveryIds = new Set<string>();
  for (const delivery of record.deliveries) {
    if (deliveryIds.has(delivery.id)) {
      throw new Error("Duplicate delivery id in local record: " + delivery.id);
    }
    deliveryIds.add(delivery.id);
    if (!sessions.has(delivery.senderSessionId) || !sessions.has(delivery.targetSessionId)) {
      throw new Error("Delivery session is not in this project: " + delivery.id);
    }
  }
}

function validateSessionConsistency(project: Project, sessions: ProjectSession[]): void {
  const sessionIds = new Set<string>();
  const hostSessionIds = new Set<string>();
  const mainSessions = sessions.filter((session) => session.role === "main");
  const memorySessions = sessions.filter((session) => session.role === "memory");
  if (sessions.filter(session => session.role === "session-manager").length > 1) throw new Error("Project has multiple session managers");
  for (const session of sessions) {
    if (sessionIds.has(session.id)) {
      throw new Error("Duplicate project session id in local record: " + session.id);
    }
    sessionIds.add(session.id);
    for (const carrier of sessionCarriers(session)) {
      if (hostSessionIds.has(carrier.hostSessionId)) throw new Error("Duplicate host session id in local record: " + carrier.hostSessionId);
      hostSessionIds.add(carrier.hostSessionId);
    }
  }
  if (mainSessions.length > 1) throw new Error("Project has multiple main sessions: " + project.id);
  if (memorySessions.length > 1) throw new Error("Project has multiple memory sessions: " + project.id);
  if (project.mainSessionId === undefined && mainSessions.length === 0) return;
  if (
    project.mainSessionId === undefined
    || mainSessions.length !== 1
    || mainSessions[0]?.id !== project.mainSessionId
  ) {
    throw new Error("Project main session binding is inconsistent: " + project.id);
  }
}

function applyProjectPatch(project: Project, patch: ProjectPatch): Project {
  if (patch.name === undefined && patch.workspace === undefined) {
    throw new Error("Project patch must update at least one field");
  }
  const next = touchProject(project, new Date().toISOString());
  if (patch.name !== undefined) next.name = requiredText(patch.name, "project name");
  if (patch.workspace !== undefined) {
    if (patch.workspace === null) {
      delete next.workspace;
    } else {
      next.workspace = copyWorkspace(patch.workspace);
    }
  }
  return next;
}

function applySessionPatch(session: ProjectSession, patch: ProjectSessionPatch): ProjectSession {
  if (patch.title === undefined && patch.archived === undefined) {
    throw new Error("Project session patch must update at least one field");
  }
  const next: ProjectSession = {
    ...session,
    revision: session.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  if (patch.title !== undefined) next.title = requiredText(patch.title, "project session title");
  if (patch.archived !== undefined) {
    next.archived = booleanValue(patch.archived, "project session archived");
  }
  return next;
}

function touchProject(project: Project, now: string): Project {
  return { ...project, revision: project.revision + 1, updatedAt: now };
}

function withProject(
  record: PersistedProjectRecord,
  project: Project,
  changed: ReadonlySet<ProjectRawField>,
): PersistedProjectRecord {
  const rawProject = objectValue(record.raw.project, "project");
  return {
    ...record,
    project,
    raw: {
      ...record.raw,
      project: mergeProjectRaw(rawProject, project, changed),
    },
  };
}

function appendSession(record: PersistedProjectRecord, session: ProjectSession): PersistedProjectRecord {
  record = withCarrierFormat(record);
  if (session.role === "session-manager") record = withContinuityFormat(record);
  const rawSessions = arrayValue(record.raw.sessions, "project record sessions");
  const version = session.role === "memory" && record.version < MEMORY_RECORD_VERSION
    ? MEMORY_RECORD_VERSION : record.version;
  return {
    ...record,
    version,
    sessions: [...record.sessions, session],
    raw: {
      ...record.raw,
      version,
      sessions: [...rawSessions, sessionToRaw(session)],
    },
  };
}

function withSession(
  record: PersistedProjectRecord,
  session: ProjectSession,
  changed: ReadonlySet<SessionRawField>,
): PersistedProjectRecord {
  session = synchronizeCarrierFields(session, changed);
  const sessions = record.sessions.map((candidate) => candidate.id === session.id ? session : candidate);
  const rawSessions = replaceRawEntryById(
    arrayValue(record.raw.sessions, "project record sessions"),
    session.id,
    (existing) => mergeSessionRaw(existing, session, changed),
    "project session",
  );
  return { ...record, sessions, raw: { ...record.raw, sessions: rawSessions } };
}

function withOwnedLifecycleSession(record: PersistedProjectRecord, session: ProjectSession): PersistedProjectRecord {
  const next = withSession(record, session, new Set(["ownedLifecycle", "archived", "revision", "updatedAt"]));
  return { ...next, version: Math.max(record.version, OWNED_LIFECYCLE_RECORD_VERSION) as RecordVersion,
    raw: { ...next.raw, version: Math.max(record.version, OWNED_LIFECYCLE_RECORD_VERSION) } };
}

function withDeletionSession(record: PersistedProjectRecord, session: ProjectSession): PersistedProjectRecord {
  const next = withSession(record, session, new Set(["title", "archived", "sourceLifecycle", "revision", "updatedAt", "ownedLifecycle"]));
  if ((session.sourceLifecycle.kind === "deleting" || session.sourceLifecycle.kind === "partial") && session.sourceLifecycle.scheduleDeletion) {
    const version = Math.max(next.version, PROJECT_DELETION_RECORD_VERSION) as RecordVersion;
    (next as {version:RecordVersion}).version = version; next.raw.version = version;
  }
  if (session.sourceLifecycle.kind === "deleted" && sessionCarriers(requireSession(next, session.id)).every(carrier => carrier.sourceLifecycle.kind === "deleted")) {
    next.raw.sessions = replaceRawEntryById(
      arrayValue(next.raw.sessions, "project record sessions"),
      session.id,
      () => {
        const retained = requireSession(next, session.id);
        const raw = record.version >= CARRIER_RECORD_VERSION ? sessionToRaw(retained) : {
          id: retained.id, projectId: retained.projectId, hostSessionId: retained.hostSessionId, role: retained.role,
          title: retained.title, revision: retained.revision, createdAt: retained.createdAt, updatedAt: retained.updatedAt,
          sourceLifecycle: copySourceLifecycle(retained.sourceLifecycle),
        };
        delete raw.archived;
        return raw;
      },
      "project session",
    );
  }
  const lifecycle = session.sourceLifecycle;
  const hasFileDeletion = (lifecycle.kind === "deleting" || lifecycle.kind === "partial")
    && lifecycle.fileDeletion !== undefined;
  const hasImageDeletion = (lifecycle.kind === "deleting" || lifecycle.kind === "partial")
    && lifecycle.imageDeletion !== undefined;
  validateOwnedMembers(session);
  validateOwnedLifecycle(session);
  validateOwnedSourceClaims(next.sessions);
  const requiredVersion = lifecycle.kind !== "available" && lifecycle.ownedDeletion !== undefined
    ? OWNED_DELETION_RECORD_VERSION : hasImageDeletion ? IMAGE_DELETION_RECORD_VERSION
    : hasFileDeletion ? FILE_DELETION_RECORD_VERSION : DELETION_RECORD_VERSION;
  const scheduleVersion=(lifecycle.kind==="deleting"||lifecycle.kind==="partial")&&(lifecycle.scheduleDeletion||lifecycle.progress.projectSchedules!==undefined||lifecycle.progress.nativeSchedules!==undefined)?PROJECT_DELETION_RECORD_VERSION:0;
  const version = Math.max(next.version, requiredVersion,scheduleVersion) as RecordVersion;
  return { ...next, version, raw: { ...next.raw, version } };
}

function removeSession(record: PersistedProjectRecord, sessionId: string): PersistedProjectRecord {
  const rawSessions = arrayValue(record.raw.sessions, "project record sessions");
  let removed = false;
  const sessions = rawSessions.filter((item) => {
    const matches = objectOrUndefined(item)?.id === sessionId;
    if (matches) removed = true;
    return !matches;
  });
  if (!removed) throw new Error("Project session is missing from raw record: " + sessionId);
  return {
    ...record,
    sessions: record.sessions.filter((session) => session.id !== sessionId),
    raw: { ...record.raw, sessions },
  };
}

function mergeProjectRaw(
  existing: JsonObject,
  project: Project,
  changed: ReadonlySet<ProjectRawField>,
): JsonObject {
  const next: JsonObject = { ...existing };
  if (changed.has("sourceLifecycle")) next.sourceLifecycle = structuredClone(project.sourceLifecycle);
  if (changed.has("name")) next.name = project.name;
  if (changed.has("workspace")) {
    if (project.workspace === undefined) {
      delete next.workspace;
    } else {
      next.workspace = mergeWorkspaceRaw(next.workspace, project.workspace);
    }
  }
  if (changed.has("archived")) next.archived = project.archived;
  if (changed.has("mainSessionId")) {
    if (project.mainSessionId === undefined) {
      delete next.mainSessionId;
    } else {
      next.mainSessionId = project.mainSessionId;
    }
  }
  if (changed.has("revision")) next.revision = project.revision;
  if (changed.has("updatedAt")) next.updatedAt = project.updatedAt;
  return next;
}

function mergeWorkspaceRaw(existing: unknown, workspace: WorkspaceReference): JsonObject {
  return { ...(objectOrUndefined(existing) ?? {}), path: workspace.path };
}

function mergeSessionRaw(
  existing: JsonObject,
  session: ProjectSession,
  changed: ReadonlySet<SessionRawField>,
): JsonObject {
  const next: JsonObject = { ...existing };
  if (changed.has("mainPreparations")) next.mainPreparations = structuredClone(session.mainPreparations ?? []);
  if (changed.has("title")) next.title = session.title;
  if (changed.has("archived")) next.archived = session.archived;
  if (changed.has("revision")) next.revision = session.revision;
  if (changed.has("updatedAt")) next.updatedAt = session.updatedAt;
  if (existing.carriers !== undefined || changed.has("carriers")) {
    const previous = Array.isArray(existing.carriers) ? existing.carriers.map(value => objectValue(value, "carrier")) : [];
    next.carriers = sessionCarriers(session).map(carrier => {
      const raw = { ...(previous.find(row => row.hostSessionId === carrier.hostSessionId) ?? {}), ...carrierToRaw(carrier) };
      if (carrier.ownedLifecycle === undefined) delete raw.ownedLifecycle;
      return raw;
    });
    delete next.hostSessionId; delete next.sourceLifecycle; delete next.ownedLifecycle;
    return next;
  }
  if (changed.has("sourceLifecycle")) next.sourceLifecycle = copySourceLifecycle(session.sourceLifecycle);
  if (changed.has("ownedLifecycle")) {
    if (session.ownedLifecycle === undefined) delete next.ownedLifecycle;
    else next.ownedLifecycle = copyOwnedLifecycle(session.ownedLifecycle);
  }
  return next;
}

function replaceRawEntryById(
  values: unknown[],
  id: string,
  replace: (existing: JsonObject) => JsonObject,
  label: string,
): unknown[] {
  let found = false;
  const next = values.map((value) => {
    const entry = objectOrUndefined(value);
    if (entry?.id !== id) return value;
    found = true;
    return replace(entry);
  });
  if (!found) throw new Error(label + " is missing from raw record: " + id);
  return next;
}

function projectToRaw(project: Project): JsonObject {
  const raw: JsonObject = {
    id: project.id,
    name: project.name,
    ...(project.sourceLifecycle===undefined?{}:{sourceLifecycle:structuredClone(project.sourceLifecycle)}),
    archived: project.archived,
    revision: project.revision,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
  if (project.workspace !== undefined) raw.workspace = { path: project.workspace.path };
  if (project.mainSessionId !== undefined) raw.mainSessionId = project.mainSessionId;
  return raw;
}

function sessionToRaw(session: ProjectSession): JsonObject {
  const raw: JsonObject = {
    id: session.id,
    projectId: session.projectId,
    carriers: sessionCarriers(session).map(carrierToRaw),
    role: session.role,
    ...(session.mainPreparations === undefined ? {} : { mainPreparations: structuredClone(session.mainPreparations) }),
    title: session.title,
    archived: session.archived,
    revision: session.revision,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
  return raw;
}

function carrierToRaw(carrier: ProjectSessionCarrier): JsonObject {
  return { sequence: carrier.sequence, hostSessionId: carrier.hostSessionId, isCurrent: carrier.isCurrent,
    sourceLifecycle: copySourceLifecycle(carrier.sourceLifecycle),
    ...(carrier.lifecycleTimeBasis === undefined ? {} : { lifecycleTimeBasis: carrier.lifecycleTimeBasis }),
    ...(carrier.boundAt === undefined ? {} : { boundAt: carrier.boundAt }),
    ...(carrier.header === undefined ? {} : { header: { ...carrier.header } }),
    ...(carrier.closed === undefined ? {} : { closed: { ...carrier.closed } }),
    ...(carrier.ownedLifecycle === undefined ? {} : { ownedLifecycle: copyOwnedLifecycle(carrier.ownedLifecycle) }) };
}

function synchronizeCarrierFields(session: ProjectSession, changed: ReadonlySet<SessionRawField>): ProjectSession {
  if (changed.has("carriers")) return projectCurrentCarrier(session);
  const carriers = sessionCarriers(session).map(carrier => {
    if (carrier.hostSessionId !== session.hostSessionId) return carrier;
    const next = { ...carrier };
    if (changed.has("sourceLifecycle")) (next as { sourceLifecycle: ProjectSessionSourceLifecycle }).sourceLifecycle = session.sourceLifecycle;
    if (changed.has("ownedLifecycle")) {
      if (session.ownedLifecycle === undefined) delete (next as { ownedLifecycle?: SessionOwnedLifecycle }).ownedLifecycle;
      else (next as { ownedLifecycle?: SessionOwnedLifecycle }).ownedLifecycle = session.ownedLifecycle;
    }
    return next;
  });
  return projectCurrentCarrier({ ...session, carriers });
}

function withCarrierFormat(record: PersistedProjectRecord): PersistedProjectRecord {
  if (record.version >= CARRIER_RECORD_VERSION) return record;
  if (record.raw.terminal === true) {
    const existing = arrayValue(record.raw.sources, "terminal sources").map(value => objectValue(value, "terminal source"));
    const raw = { ...record.raw, version: CARRIER_RECORD_VERSION,
      sources: record.sessions.map(session => {
        const source = { ...existing.find(row => row.id === session.id), id: session.id, role: session.role, revision: session.revision,
          carriers: sessionCarriers(session).map(carrierToRaw) } as JsonObject;
        delete source.hostSessionId; delete source.ownedDeletion;
        return source;
      }) };
    return { ...record, version: CARRIER_RECORD_VERSION, raw };
  }
  const rawSessions = arrayValue(record.raw.sessions, "project record sessions").map(value => {
    const raw = { ...objectValue(value, "project session") }, session = requireSession(record, stringValue(raw.id, "project session id"));
    delete raw.hostSessionId; delete raw.sourceLifecycle; delete raw.ownedLifecycle;
    return { ...raw, carriers: sessionCarriers(session).map(carrierToRaw) };
  });
  return { ...record, version: CARRIER_RECORD_VERSION, raw: { ...record.raw, version: CARRIER_RECORD_VERSION, sessions: rawSessions } };
}

function sourceToRaw(source: SourceRef): JsonObject {
  return { ...encodeNativeProjectSource(source) };
}

function isRemovableEmptyProject(record: PersistedProjectRecord): boolean {
  if ((record.version !== RECORD_VERSION && record.version !== LEGACY_CURRENT_RECORD_VERSION)
    || record.sessions.length !== 0 || record.deliveries.length !== 0) {
    return false;
  }
  const allowedTopLevel = new Set(["version", "project", "sessions", "deliveries"]);
  if (Object.keys(record.raw).some((key) => !allowedTopLevel.has(key))) return false;
  const rawProject = objectOrUndefined(record.raw.project);
  if (rawProject === undefined) return false;
  const allowedProject = new Set([
    "id",
    "name",
    "workspace",
    "mainSessionId",
    "archived",
    "revision",
    "createdAt",
    "updatedAt",
  ]);
  return Object.keys(rawProject).every((key) => allowedProject.has(key));
}

function membershipsFromRecords(records: PersistedProjectRecord[]): ProjectMembership[] {
  return records
    .flatMap((record) =>
      operationalSessions(record).map((session) => ({
        project: copyProject(record.project),
        session: copySession(session),
      })),
    )
    .sort((left, right) => {
      const projectOrder = left.project.createdAt.localeCompare(right.project.createdAt);
      return projectOrder === 0
        ? left.session.createdAt.localeCompare(right.session.createdAt)
        : projectOrder;
    });
}

function findMembership(
  records: PersistedProjectRecord[],
  hostSessionId: string,
): ProjectMembership | undefined {
  for (const record of records) {
    const session = record.sessions.find((candidate) => candidate.hostSessionId === hostSessionId);
    if (session !== undefined) return { project: record.project, session };
  }
  return undefined;
}

function findRecord(
  records: PersistedProjectRecord[],
  projectId: ProjectId,
): PersistedProjectRecord | undefined {
  return records.find((record) => record.project.id === projectId);
}

function sameSessionRoster(
  sessions: readonly ProjectSession[],
  expected: readonly ProjectSessionRosterEntry[],
): boolean {
  if (new Set(expected.map(row => row.id)).size !== expected.length) {
    const roots = sessions.flatMap(session => sessionCarriers(session).map(carrier => ({ session, carrier })));
    const byHost = new Map(expected.map(row => [row.id + ":" + row.hostSessionId, row]));
    return roots.length === expected.length && byHost.size === expected.length && roots.every(({ session, carrier }) => {
      const row = byHost.get(session.id + ":" + carrier.hostSessionId);
      return row !== undefined && row.role === session.role && row.archived === session.archived;
    });
  }
  if (sessions.length !== expected.length) return false;
  const byId = new Map(expected.map((session) => [session.id, session]));
  if (byId.size !== expected.length) return false;
  return sessions.every((session) => {
    const candidate = byId.get(session.id);
    return candidate !== undefined
      && candidate.hostSessionId === session.hostSessionId
      && candidate.role === session.role
      && candidate.archived === session.archived
      && (candidate.carrierHostSessionIds === undefined ? sessionCarriers(session).length === 1
        : JSON.stringify(candidate.carrierHostSessionIds) === JSON.stringify(sessionCarriers(session).map(carrier => carrier.hostSessionId)));
  });
}

function recordSnapshot(record: PersistedProjectRecord): ProjectRecordSnapshot {
  return {
    project: copyProject(record.project),
    sessions: record.sessions.map(copySession),
    deliveries: record.deliveries.map(copyDelivery),
  };
}

function copyProject(project: Project): Project {
  const copy: Project = { ...project, ...(project.sourceLifecycle === undefined ? {} : {sourceLifecycle:structuredClone(project.sourceLifecycle)}) };
  if (project.workspace !== undefined) copy.workspace = copyWorkspace(project.workspace);
  return copy;
}

function copySession(session: ProjectSession): ProjectSession {
  const current = synchronizeCarrierFields(session, new Set(["sourceLifecycle", "ownedLifecycle"]));
  return projectCurrentCarrier({ ...current, ...(current.mainPreparations === undefined ? {} : { mainPreparations: structuredClone(current.mainPreparations) }), carriers: sessionCarriers(current).map(copyCarrier) });
}

function copySessionSource(session: ProjectSession, carrier: ProjectSessionCarrier = currentCarrier(session)): ProjectSessionSource {
  const { id, projectId, role, title, revision, createdAt, updatedAt } = session;
  const hostSessionId = carrier.hostSessionId;
  return { id, projectId, hostSessionId, role, title, revision, createdAt, updatedAt,
    projectSessionId: id, carrierSequence: carrier.sequence, isCurrentCarrier: carrier.isCurrent,
    sourceLifecycle: copySourceLifecycle(carrier.sourceLifecycle),
    ...(carrier.lifecycleTimeBasis === undefined ? {} : { lifecycleTimeBasis: carrier.lifecycleTimeBasis }),
    ...(carrier.header === undefined ? {} : { header: { ...carrier.header } }),
    ...(carrier.ownedLifecycle === undefined ? {} : { ownedLifecycle: copyOwnedLifecycle(carrier.ownedLifecycle) }) };
}

function copySourceLifecycle(lifecycle: ProjectSessionSourceLifecycle): ProjectSessionSourceLifecycle {
  switch (lifecycle.kind) {
    case "available": return { kind: "available" };
    case "deleted": return { ...lifecycle,
      ...(lifecycle.ownedDeletion === undefined ? {} : { ownedDeletion: ownedDeletedSources(lifecycle.ownedDeletion) }) };
    case "deleting": return { ...lifecycle, progress: { ...lifecycle.progress },
      ...(lifecycle.fileDeletion === undefined ? {} : { fileDeletion: copyFileDeletion(lifecycle.fileDeletion) }),
      ...(lifecycle.imageDeletion === undefined ? {} : { imageDeletion: copyImageDeletion(lifecycle.imageDeletion) }),
      ...(lifecycle.ownedDeletion === undefined ? {} : { ownedDeletion: copyOwnedDeletion(lifecycle.ownedDeletion) }) };
    case "partial": return { ...lifecycle, progress: { ...lifecycle.progress }, failure: { ...lifecycle.failure },
      ...(lifecycle.fileDeletion === undefined ? {} : { fileDeletion: copyFileDeletion(lifecycle.fileDeletion) }),
      ...(lifecycle.imageDeletion === undefined ? {} : { imageDeletion: copyImageDeletion(lifecycle.imageDeletion) }),
      ...(lifecycle.ownedDeletion === undefined ? {} : { ownedDeletion: copyOwnedDeletion(lifecycle.ownedDeletion) }) };
  }
}

function assertAvailableSession(session: ProjectSession): void {
  if (session.sourceLifecycle.kind !== "available") {
    throw new Error("Project session source is unavailable: " + session.projectId + "/" + session.id);
  }
}

function requireDeletionSession(record: PersistedProjectRecord, input: ExecutionSourceDeletionInput): ProjectSession {
  revisionValue(input.expectedRevision, "source deletion expected revision");
  const session = record.sessions.find((candidate) => candidate.id === input.sessionId);
  if (session === undefined) throw new Error("Project session not found: " + input.projectId + "/" + input.sessionId);
  if(!input.projectDeletion&&session.role!=="execution")throw new Error("Source deletion requires an execution session");
  if (input.projectDeletion ? record.project.sourceLifecycle === undefined : record.project.sourceLifecycle !== undefined) throw new Error("Source deletion is owned by a different project action");
  const hostSessionId = carrierHostInput(input) ?? (sessionCarriers(session).length === 1 ? session.hostSessionId : undefined);
  if (hostSessionId === undefined) throw new Error("Multi-carrier deletion requires carrierHostSessionId");
  return sessionAtCarrier(session, requireCarrier(session, hostSessionId));
}

function carrierHostInput(input: { readonly carrierHostSessionId?: string; readonly hostSessionId?: string }): string | undefined {
  if (input.carrierHostSessionId !== undefined && input.hostSessionId !== undefined && input.carrierHostSessionId !== input.hostSessionId) {
    throw new Error("Conflicting carrier host identities");
  }
  return input.carrierHostSessionId ?? input.hostSessionId;
}

function groupProjectDeletionSessions(record: PersistedProjectRecord, supplied: readonly ProjectSession[]): readonly ProjectSession[] {
  if (new Set(supplied.map(row => row.id)).size === supplied.length) return supplied;
  const roots = record.sessions.flatMap(session => sessionCarriers(session).map(carrier => ({ session, carrier })));
  const byHost = new Map(supplied.map(row => [row.id + ":" + row.hostSessionId, row]));
  if (roots.length !== supplied.length || byHost.size !== supplied.length
    || roots.some(({ session, carrier }) => {
      const row = byHost.get(session.id + ":" + carrier.hostSessionId);
      return row === undefined || row.revision !== session.revision || row.role !== session.role;
    })) throw new Error("Project deletion requires the complete exact carrier roster");
  return record.sessions.map(session => projectCurrentCarrier({ ...session, carriers: sessionCarriers(session).map(carrier => {
    const row = byHost.get(session.id + ":" + carrier.hostSessionId)!;
    return { ...carrier, sourceLifecycle: row.sourceLifecycle };
  }) }));
}

function requireDeletionInProgress(session: ProjectSession): Extract<ProjectSessionSourceLifecycle,
  { kind: "deleting" | "partial" }
> {
  const lifecycle = session.sourceLifecycle;
  if (lifecycle.kind !== "deleting" && lifecycle.kind !== "partial") {
    throw new Error("Project session source deletion is not in progress: " + session.id);
  }
  return lifecycle;
}

function parseSourceLifecycle(value: unknown, version: RecordVersion): ProjectSessionSourceLifecycle {
  if (value === undefined) return { kind: "available" };
  const source = objectValue(value, "source lifecycle");
  if (source.fileDeletion !== undefined
    && (version < FILE_DELETION_RECORD_VERSION || (source.kind !== "deleting" && source.kind !== "partial"))) {
    throw new Error("File deletion requires an in-progress version 8, 9 or 10 source lifecycle");
  }
  if (source.imageDeletion !== undefined
    && (version < IMAGE_DELETION_RECORD_VERSION || (source.kind !== "deleting" && source.kind !== "partial"))) {
    throw new Error("Image deletion requires an in-progress version 9 or 10 source lifecycle");
  }
  if (source.ownedDeletion !== undefined
    && (version < OWNED_DELETION_RECORD_VERSION || source.kind === "available")) {
    throw new Error("Owned deletion requires an unavailable version 10 source lifecycle");
  }
  if (source.kind === "available") return { kind: "available" };
  const requestedAt = requiredText(stringValue(source.requestedAt, "deletion requestedAt"), "deletion requestedAt");
  if (source.kind === "deleted") {
    return { kind: "deleted", requestedAt,
      deletedAt: requiredText(stringValue(source.deletedAt, "deletion deletedAt"), "deletion deletedAt"),
      ...(source.ownedDeletion === undefined ? {} : { ownedDeletion: parseOwnedDeletedSources(source.ownedDeletion) }) };
  }
  if (source.scheduleDeletion !== undefined && (version < PROJECT_DELETION_RECORD_VERSION || source.scheduleDeletion !== true)) throw new Error("Invalid schedule deletion contract");
  if(version<PROJECT_DELETION_RECORD_VERSION&&((source.fileDeletion as JsonObject|undefined)?.candidates!==undefined||(source.progress as JsonObject|undefined)?.projectSchedules!==undefined||(source.progress as JsonObject|undefined)?.nativeSchedules!==undefined))throw new Error("New deletion obligations require record v12");
  const common = { requestedAt,
    ...(source.scheduleDeletion === true ? {scheduleDeletion:true as const} : {}),
    updatedAt: requiredText(stringValue(source.updatedAt, "deletion updatedAt"), "deletion updatedAt"),
    progress: parseCleanupProgress(source.progress),
    ...(source.fileDeletion === undefined ? {} : { fileDeletion: parseFileDeletion(source.fileDeletion) }),
    ...(source.imageDeletion === undefined ? {} : { imageDeletion: parseImageDeletion(source.imageDeletion) }),
    ...(source.ownedDeletion === undefined ? {} : { ownedDeletion: parseOwnedDeletion(source.ownedDeletion) }) };
  assertFileDeletionBeforeLog(common.fileDeletion, common.progress);
  assertImageDeletionBeforeLog(common.imageDeletion, common.progress);
  assertOwnedDeletionBeforeLogs(common.fileDeletion, common.imageDeletion, common.ownedDeletion);
  if (source.kind === "deleting") return { kind: "deleting", ...common };
  if (source.kind === "partial") {
    const failure = parseCleanupFailure(source.failure);
    if (failure.stage === "file-attachments" && common.fileDeletion === undefined) {
      throw new Error("File attachment failure requires the file deletion contract");
    }
    if (failure.stage === "image-attachments" && common.imageDeletion === undefined) {
      throw new Error("Image attachment failure requires the image deletion contract");
    }
    return { kind: "partial", ...common, failure };
  }
  throw new Error("Unsupported project source lifecycle: " + String(source.kind));
}

function copyOwnedDeletion(value: SessionOwnedDeletion): SessionOwnedDeletion {
  return { contract: "owned-v1", members: value.members.map((member) => ({ ...member,
    header: { ...member.header }, progress: { ...member.progress },
    ...(member.failure === undefined ? {} : { failure: { ...member.failure } }) })) };
}

function copyOwnedLifecycle(value: SessionOwnedLifecycle): SessionOwnedLifecycle {
  return { contract: "archive-v1", rootHeader: { ...value.rootHeader },
    members: value.members.map((member) => ({ ...member, header: { ...member.header } })) };
}

/** 与原 Session owner 一致：未存 depth 与 cold 读取补出的 0 是同一创建身份。 */
function sameOwnedLifecycleHeader(left: SessionOwnedSessionHeader, right: SessionOwnedSessionHeader): boolean {
  return left.version === right.version && left.id === right.id && left.createdAt === right.createdAt
    && left.cwd === right.cwd && left.parentSession === right.parentSession
    && left.isSeeded === right.isSeeded && left.origin === right.origin
    && (left.delegationDepth ?? 0) === (right.delegationDepth ?? 0) && left.agentPreset === right.agentPreset;
}

function parseOwnedLifecycle(value: unknown): SessionOwnedLifecycle {
  const source = ownedObject(value, ["contract", "rootHeader", "members"], "owned lifecycle");
  if (source.contract !== "archive-v1") throw new Error("Unsupported owned lifecycle contract");
  const rootHeader = parseCreationHeader(source.rootHeader, false);
  const members = arrayValue(source.members, "owned lifecycle members").map((value): SessionOwnedLifecycle["members"][number] => {
    const member = ownedObject(value, ["header", "parentSessionId", "mode", "provider"], "owned lifecycle member");
    const header = parseOwnedHeader(member.header);
    const parentSessionId = requiredText(stringValue(member.parentSessionId, "owned parentSessionId"), "owned parentSessionId");
    if (header.parentSession !== parentSessionId) throw new Error("Owned lifecycle member header and edge conflict");
    if (member.mode !== "one-shot" && member.mode !== "continuable") throw new Error("Unsupported owned member mode");
    const provider = member.provider === undefined ? undefined
      : requiredText(stringValue(member.provider, "owned provider"), "owned provider");
    if (member.mode === "continuable" && provider === undefined) throw new Error("Continuable owned member requires its provider");
    return { header, parentSessionId, mode: member.mode, ...(provider === undefined ? {} : { provider }) };
  });
  if (new Set(members.map((member) => member.header.id)).size !== members.length) throw new Error("Duplicate owned lifecycle member identity");
  return { contract: "archive-v1", rootHeader, members };
}

function validateOwnedLifecycle(session: ProjectSession): void {
  const lifecycle = session.ownedLifecycle;
  if (lifecycle === undefined) return;
  if (session.sourceLifecycle.kind === "deleted") throw new Error("Deleted source cannot retain owned lifecycle details");
  if (lifecycle.rootHeader.id !== session.hostSessionId) throw new Error("Owned lifecycle root creation identity conflicts with binding");
  const members = new Map(lifecycle.members.map((member) => [String(member.header.id), member]));
  for (const member of lifecycle.members) {
    if (member.header.id === session.hostSessionId) throw new Error("Owned lifecycle cannot repeat its root");
    let parent = member.parentSessionId;
    const seen = new Set<string>([member.header.id]);
    while (parent !== session.hostSessionId) {
      if (seen.has(parent)) throw new Error("Owned lifecycle member edges contain a cycle");
      seen.add(parent);
      const ancestor = members.get(parent);
      if (ancestor === undefined) throw new Error("Owned lifecycle member edge is outside the frozen root set");
      parent = ancestor.parentSessionId;
    }
  }
  if (session.sourceLifecycle.kind === "deleting" || session.sourceLifecycle.kind === "partial") {
    for (const member of session.sourceLifecycle.ownedDeletion?.members ?? []) {
      const retained = members.get(String(member.header.id));
      if (retained !== undefined && (!sameOwnedLifecycleHeader(retained.header, member.header)
        || retained.parentSessionId !== member.parentSessionId
        || retained.mode !== member.mode
        || retained.provider !== member.provider)) {
        throw new Error("Owned lifecycle and deletion creation identity conflict");
      }
    }
  }
}

function mergeOwnedLifecycle(session: ProjectSession, supplied: SessionOwnedLifecycle): SessionOwnedLifecycle {
  const added = parseOwnedLifecycle(supplied);
  validateOwnedLifecycle({ ...session, ownedLifecycle: added });
  const current = session.ownedLifecycle;
  if (current === undefined) return added;
  if (!sameOwnedLifecycleHeader(current.rootHeader, added.rootHeader)) {
    throw new Error("Owned lifecycle root creation identity cannot change");
  }
  const members = new Map(current.members.map((member) => [member.header.id, member]));
  for (const member of added.members) {
    const prior = members.get(member.header.id);
    if (prior !== undefined && (!sameOwnedLifecycleHeader(prior.header, member.header)
      || prior.parentSessionId !== member.parentSessionId || prior.mode !== member.mode || prior.provider !== member.provider)) {
      throw new Error("Owned lifecycle member creation identity and edge cannot change");
    }
    members.set(member.header.id, member);
  }
  return copyOwnedLifecycle({ contract: "archive-v1", rootHeader: current.rootHeader, members: [...members.values()] });
}

function retainedSources(record: PersistedProjectRecord): ProjectSessionSource[] {
  return record.sessions.flatMap(session => sessionCarriers(session).map(carrier =>
    ({ ...copySessionSource(session, carrier), ...(record.project.sourceLifecycle === undefined ? {} : { projectDeletion: true as const }) })));
}

function validateOwnedRecordClaims(records: readonly PersistedProjectRecord[], replacement: PersistedProjectRecord): void {
  validateCurrentConsistency(replacement);
  const sessions = records.flatMap(record => record.project.id === replacement.project.id ? replacement.sessions : record.sessions);
  validateOwnedSourceClaims(sessions);
}

function ownedDeletedSources(value: SessionOwnedDeletion | SessionOwnedDeletedSources): SessionOwnedDeletedSources {
  return { contract: "owned-v1", members: value.members.map(({ header }) => ({
    header: { id: header.id, createdAt: header.createdAt },
  })) };
}

function ownedObject(value: unknown, allowed: readonly string[], label: string): JsonObject {
  const source = objectValue(value, label);
  if (Object.keys(source).some((key) => !allowed.includes(key))) throw new Error("Unknown " + label + " field");
  return source;
}

function ownedCreatedAt(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Owned member createdAt must be a nonnegative safe integer");
  }
  return value;
}

function parseOwnedHeader(value: unknown): SessionOwnedSessionHeader {
  return parseCreationHeader(value, true);
}

function parseCreationHeader(value: unknown, child: boolean): SessionOwnedSessionHeader {
  const source = ownedObject(value, ["version", "id", "createdAt", "cwd", "parentSession", "isSeeded",
    "origin", "delegationDepth", "agentPreset"], "owned member header");
  if (source.version !== 4 || (source.origin !== undefined && source.origin !== "subagent")
    || (child && source.origin !== "subagent")) throw new Error("Unsupported owned member header identity");
  const optional: { cwd?: string; delegationDepth?: number; agentPreset?: string } = {};
  if (source.cwd !== undefined) optional.cwd = requiredText(stringValue(source.cwd, "owned cwd"), "owned cwd");
  if (source.agentPreset !== undefined) optional.agentPreset = requiredText(stringValue(source.agentPreset, "owned agentPreset"), "owned agentPreset");
  if (source.delegationDepth !== undefined) {
    if (typeof source.delegationDepth !== "number" || !Number.isSafeInteger(source.delegationDepth) || source.delegationDepth < 0) {
      throw new Error("Invalid owned member delegation depth");
    }
    optional.delegationDepth = source.delegationDepth;
  }
  return { version: 4,
    id: requiredText(stringValue(source.id, "owned member id"), "owned member id") as SessionOwnedSessionHeader["id"],
    createdAt: ownedCreatedAt(source.createdAt),
    ...(source.parentSession === undefined && !child ? {} : { parentSession:
      requiredText(stringValue(source.parentSession, "owned parent session"), "owned parent session") as SessionOwnedSessionHeader["id"] }),
    isSeeded: booleanValue(source.isSeeded, "owned isSeeded"),
    ...(source.origin === undefined ? {} : { origin: "subagent" as const }), ...optional };
}

function parseOwnedProgress(value: unknown): SessionOwnedCleanupProgress {
  const source = objectValue(value, "owned cleanup progress");
  const notApplicable = source.sessionInstructions === "not-applicable";
  const progress = parseCleanupProgress(notApplicable ? { ...source, sessionInstructions: undefined } : source);
  return { ...progress, ...(notApplicable ? { sessionInstructions: "not-applicable" as const } : {}) };
}

function parseOwnedDeletion(value: unknown): SessionOwnedDeletion {
  const source = ownedObject(value, ["contract", "members"], "owned deletion");
  if (source.contract !== "owned-v1") throw new Error("Unsupported owned deletion contract");
  const members = arrayValue(source.members, "owned deletion members").map((value): SessionOwnedDeletionMember => {
    const member = ownedObject(value, ["header", "parentSessionId", "mode", "provider", "progress", "failure"], "owned deletion member");
    if (member.mode !== "one-shot" && member.mode !== "continuable") throw new Error("Unsupported owned member mode");
    const provider = member.provider === undefined ? undefined : requiredText(stringValue(member.provider, "owned provider"), "owned provider");
    if (member.mode === "continuable" && provider === undefined) throw new Error("Continuable owned member requires its provider");
    const header = parseOwnedHeader(member.header);
    const parentSessionId = requiredText(stringValue(member.parentSessionId, "owned parentSessionId"), "owned parentSessionId");
    if (header.parentSession !== parentSessionId) throw new Error("Owned member header and edge conflict");
    return { header, parentSessionId, mode: member.mode, ...(provider === undefined ? {} : { provider }),
      progress: parseOwnedProgress(member.progress),
      ...(member.failure === undefined ? {} : { failure: parseCleanupFailure(member.failure) }) };
  });
  if (new Set(members.map((member) => member.header.id)).size !== members.length) throw new Error("Duplicate owned member identity");
  return { contract: "owned-v1", members };
}

function parseOwnedDeletedSources(value: unknown): SessionOwnedDeletedSources {
  const source = ownedObject(value, ["contract", "members"], "owned deleted sources");
  if (source.contract !== "owned-v1") throw new Error("Unsupported owned deletion contract");
  const members = arrayValue(source.members, "owned deleted members").map((value) => {
    const member = ownedObject(value, ["header"], "owned deleted member");
    const header = ownedObject(member.header, ["id", "createdAt"], "owned deleted header");
    return { header: {
      id: requiredText(stringValue(header.id, "owned deleted id"), "owned deleted id") as SessionOwnedSessionHeader["id"],
      createdAt: ownedCreatedAt(header.createdAt),
    } };
  });
  if (new Set(members.map((member) => member.header.id)).size !== members.length) throw new Error("Duplicate owned deleted member identity");
  return { contract: "owned-v1", members };
}

function ownedMemberIds(session: ProjectSession): string[] {
  return [...new Set(sessionCarriers(session).flatMap(carrier => {
    const lifecycle = carrier.sourceLifecycle;
    return [...(carrier.ownedLifecycle?.members.map((member) => String(member.header.id)) ?? []),
      ...(lifecycle.kind === "available" ? [] : (lifecycle.ownedDeletion?.members.map((member) => String(member.header.id)) ?? []))];
  }))];
}

function validateOwnedSourceClaims(sessions: readonly ProjectSession[]): void {
  const ids = new Set<string>();
  for (const session of sessions) for (const carrier of sessionCarriers(session)) {
    if (ids.has(carrier.hostSessionId)) throw new Error("Duplicate Project source: " + carrier.hostSessionId);
    ids.add(carrier.hostSessionId);
  }
  for (const session of sessions) for (const preparation of session.mainPreparations ?? []) {
    if (session.role !== 'main') throw new Error('Only a main session can own preparations');
    const predecessor=sessionCarriers(session).find(carrier=>carrier.hostSessionId===preparation.fromHeader.id);
    if(predecessor?.header===undefined||!sameOwnedLifecycleHeader(predecessor.header,preparation.fromHeader))throw new Error('Prepared predecessor identity is not an exact retained carrier');
    if(preparation.state==='committed'){
      const carrier=sessionCarriers(session).find(carrier=>carrier.hostSessionId===preparation.toHostSessionId);
      if(preparation.toHeader===undefined||carrier?.header===undefined||!sameOwnedLifecycleHeader(carrier.header,preparation.toHeader)||preparation.sourceLifecycle!==undefined)throw new Error('Committed preparation requires its exact carrier');
      continue;
    }
    if(ids.has(preparation.toHostSessionId))throw new Error('Prepared native host is already claimed: '+preparation.toHostSessionId);
    ids.add(preparation.toHostSessionId);
    if(preparation.sourceLifecycle!==undefined){
      if(preparation.toHeader===undefined)throw new Error('Preparation cleanup requires actual creation identity');
      validateOwnedMembers({hostSessionId:preparation.toHostSessionId,sourceLifecycle:preparation.sourceLifecycle});
      if(preparation.sourceLifecycle.kind!=='available')for(const member of preparation.sourceLifecycle.ownedDeletion?.members??[]){
        if(ids.has(member.header.id))throw new Error('Prepared owned member conflicts with another source: '+member.header.id);
        ids.add(member.header.id);
      }
    }
  }
  for (const session of sessions) {
    const local = new Set<string>();
    for (const carrier of sessionCarriers(session)) for (const id of ownedMemberIds(sessionAtCarrier({ ...session, carriers: [carrier] }, carrier))) {
      if (local.has(id)) throw new Error("Owned member belongs to more than one carrier: " + id);
      if (ids.has(id)) throw new Error("Owned member conflicts with another Project source: " + id);
      ids.add(id); local.add(id);
    }
  }
}

function validateOwnedMembers(session: Pick<ProjectSession,"hostSessionId"|"sourceLifecycle">): void {
  const lifecycle = session.sourceLifecycle;
  if (lifecycle.kind === "available" || lifecycle.ownedDeletion === undefined) return;

  const members = lifecycle.ownedDeletion.members;
  if (members.some((member) => member.header.id === session.hostSessionId)) throw new Error("Owned deletion cannot repeat its root");
  if (lifecycle.kind === "deleted") return;
  const byId = new Map(lifecycle.ownedDeletion.members.map((member) => [String(member.header.id), member]));
  for (const member of lifecycle.ownedDeletion.members) {
    let parent = member.parentSessionId;
    const seen = new Set<string>([member.header.id]);
    while (parent !== session.hostSessionId) {
      if (seen.has(parent)) throw new Error("Owned member edges contain a cycle");
      seen.add(parent);
      const ancestor = byId.get(parent);
      if (ancestor === undefined) throw new Error("Owned member edge is outside the frozen root set");
      parent = ancestor.parentSessionId;
    }
  }
}

function ownedDeletionForBegin(session: ProjectSession, supplied: SessionOwnedDeletion | undefined): SessionOwnedDeletion | undefined {
  const lifecycle = session.sourceLifecycle;
  if (lifecycle.kind === "available") {
    if (supplied === undefined) return undefined;
    const added = parseOwnedDeletion(supplied);
    for (const member of added.members) {
      if (Object.entries(member.progress).some(([key, value]) => key !== "sessionInstructions" || value !== "not-applicable")
        || member.failure !== undefined) {
        throw new Error("Owned deletion must begin with unconfirmed member cleanup");
      }
    }
    return added;
  }
  if (lifecycle.kind === "deleted") throw new Error("Owned deletion source is already deleted");
  if (supplied !== undefined) mergeOwnedDeletion(lifecycle.ownedDeletion, supplied);
  return lifecycle.ownedDeletion === undefined ? undefined : copyOwnedDeletion(lifecycle.ownedDeletion);
}

function mergeOwnedDeletion(current: SessionOwnedDeletion | undefined, supplied: SessionOwnedDeletion | undefined): SessionOwnedDeletion | undefined {
  if (supplied === undefined) return current === undefined ? undefined : copyOwnedDeletion(current);
  if (current === undefined) throw new Error("Owned deletion contract cannot change after begin");
  const added = parseOwnedDeletion(supplied);
  if (current.members.length !== added.members.length) throw new Error("Owned deletion member set cannot change");
  const byId = new Map(added.members.map((member) => [member.header.id, member]));
  return { contract: "owned-v1", members: current.members.map((member) => {
    const next = byId.get(member.header.id);
    if (next === undefined || JSON.stringify({ header: member.header, parentSessionId: member.parentSessionId,
      mode: member.mode, provider: member.provider }) !== JSON.stringify({ header: next.header,
      parentSessionId: next.parentSessionId, mode: next.mode, provider: next.provider })) {
      throw new Error("Owned member creation identity and edge cannot change");
    }
    for (const key of Object.keys(next.progress) as (keyof SessionOwnedCleanupProgress)[]) {
      if (member.progress[key] !== undefined && member.progress[key] !== next.progress[key]) {
        throw new Error("Confirmed owned member cleanup result cannot be replaced: " + key);
      }
    }
    return { ...next, progress: { ...member.progress, ...next.progress } };
  }) };
}

function assertOwnedDeletionBeforeLogs(file: SessionFileDeletion | undefined, image: SessionImageDeletion | undefined,
  owned: SessionOwnedDeletion | undefined): void {
  for (const member of owned?.members ?? []) {
    const progress = { ...member.progress,
      sessionInstructions: member.progress.sessionInstructions === "not-applicable" ? undefined : member.progress.sessionInstructions };
    assertFileDeletionBeforeLog(file, progress);
    assertImageDeletionBeforeLog(image, progress);
  }
}

function cleanupOwnersComplete(progress: SessionOwnedCleanupProgress): boolean {
  return progress.projectionCache !== undefined && progress.sessionLog !== undefined
    && progress.queryIndex !== undefined && progress.sessionInstructions !== undefined;
}

function copyFileDeletion(value: SessionFileDeletion): SessionFileDeletion {
  return { ...value, ...(value.candidates===undefined?{}:{candidates:value.candidates.map(ref=>({...ref}))}), results: value.results.map((result) => ({ ...result, ref: { ...result.ref } })) };
}

function fileDeletionForBegin(
  lifecycle: Exclude<ProjectSessionSourceLifecycle, { kind: "deleted" }>,
  supplied: SessionFileDeletion | undefined,
): SessionFileDeletion | undefined {
  const added = supplied === undefined ? undefined : parseFileDeletion(supplied);
  if (lifecycle.kind === "available") {
    if (added !== undefined && (added.complete || added.results.length !== 0)) {
      throw new Error("File deletion must begin before recording attachment cleanup results");
    }
    return added;
  }
  const current = lifecycle.fileDeletion;
  if (added !== undefined && (current === undefined || added.root !== current.root || added.contract !== current.contract)) {
    throw new Error("File deletion contract and root cannot change after begin");
  }
  return current === undefined ? undefined : copyFileDeletion(current);
}

function parseFileDeletion(value: unknown): SessionFileDeletion {
  const source = objectValue(value, "file deletion");
  assertKnownFields(source, ["contract", "root", "complete", "results", "candidates"], "file deletion");
  if (source.contract !== "file-v1") throw new Error("Unsupported file deletion contract");
  const root = stringValue(source.root, "file deletion root");
  if (root.includes("\0") || !isAbsolute(root) || resolve(root) !== root) {
    throw new Error("File deletion root must be an exact normalized local absolute path");
  }
  const complete = booleanValue(source.complete, "file deletion complete");
  const results = arrayValue(source.results, "file deletion results").map(parseFileDeletionResult);
  const identities = new Set<string>();
  const sizes = new Map<string, number>();
  for (const result of results) {
    const key = fileDeletionIdentity(result);
    if (identities.has(key)) throw new Error("Duplicate file deletion result identity");
    identities.add(key);
    const previousSize = sizes.get(result.ref.attachmentId);
    if (previousSize !== undefined && previousSize !== result.ref.bytes) {
      throw new Error("File deletion references disagree on content-addressed byte size");
    }
    sizes.set(result.ref.attachmentId, result.ref.bytes);
  }
  if (complete && (results.length === 0 || results.some((result) => !confirmedFileDeletionResult(result)))) {
    throw new Error("File deletion completion requires confirmed attachment results");
  }
  const candidates=source.candidates===undefined?undefined:arrayValue(source.candidates,"file deletion candidates").map(value=>parseFileDeletionResult({kind:"file-alias",ref:value,outcome:"missing"}).ref);
  if(candidates!==undefined&&(candidates.length===0||new Set(candidates.map(ref=>ref.attachmentId+":"+ref.name)).size!==candidates.length))throw new Error("Invalid finite file candidates");
  return { contract: "file-v1", root, complete, results, ...(candidates===undefined?{}:{candidates}) };
}

function parseFileDeletionResult(value: unknown): SessionFileDeletionResult {
  const source = objectValue(value, "file deletion result");
  assertKnownFields(source, ["kind", "ref", "outcome", "message"], "file deletion result");
  const kind = source.kind;
  if (kind !== "file-alias" && kind !== "file-object") throw new Error("Invalid file deletion result kind");
  const rawRef = objectValue(source.ref, "file deletion reference");
  assertKnownFields(rawRef, ["attachmentId", "name", "bytes"], "file deletion reference");
  const attachmentId = stringValue(rawRef.attachmentId, "file attachment id");
  if (!/^sha256:[a-f0-9]{64}$/.test(attachmentId)) throw new Error("Invalid file attachment id");
  const name = safeIdentifier(stringValue(rawRef.name, "file attachment name"), "file attachment name");
  // 与本地 provider 的已净化 leaf 合同一致；这里拒绝非精确身份，不改写来源。
  const stem = name.split(".")[0]!.replace(/[. ]+$/u, "");
  if (name !== name.trim() || /[\u0000-\u001f\u007f<>:"|?*]/u.test(name)
    || /[. ]$/u.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(stem)
    || Buffer.byteLength(name, "utf8") > 255 || Buffer.from(name).toString("utf8") !== name) {
    throw new Error("File attachment name must be an exact sanitized leaf");
  }
  const bytes = rawRef.bytes;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error("File attachment bytes must be a nonnegative safe integer");
  }
  const outcome = source.outcome;
  if (outcome !== "deleted" && outcome !== "missing" && outcome !== "retained-shared"
    && outcome !== "retained-aliases" && outcome !== "failed" && outcome !== "unknown") {
    throw new Error("Invalid file deletion result outcome");
  }
  if (outcome === "retained-aliases" && kind !== "file-object") {
    throw new Error("Only a file object can be retained for other aliases");
  }
  const message = source.message === undefined ? undefined
    : requiredText(stringValue(source.message, "file deletion result message"), "file deletion result message");
  return { kind, ref: { attachmentId, name, bytes }, outcome, ...(message === undefined ? {} : { message }) };
}

function assertKnownFields(source: JsonObject, fields: readonly string[], label: string): void {
  if (Object.keys(source).some((key) => !fields.includes(key))) throw new Error("Unknown " + label + " field");
}

function fileDeletionIdentity(result: SessionFileDeletionResult): string {
  return result.kind === "file-object" ? "object:" + result.ref.attachmentId
    : "alias:" + result.ref.attachmentId + ":" + result.ref.name;
}

function confirmedFileDeletionResult(result: SessionFileDeletionResult): boolean {
  return result.outcome !== "failed" && result.outcome !== "unknown";
}

function mergeFileDeletion(
  current: SessionFileDeletion | undefined,
  supplied: SessionFileDeletion | undefined,
): SessionFileDeletion | undefined {
  if (supplied === undefined) return current === undefined ? undefined : copyFileDeletion(current);
  const added = parseFileDeletion(supplied);
  if (current === undefined || added.contract !== current.contract || added.root !== current.root) {
    throw new Error("File deletion contract and root cannot change after begin");
  }
  if(JSON.stringify(current.candidates)!==JSON.stringify(added.candidates))throw new Error("Finite file candidates cannot change");
  if (current.complete && !added.complete) throw new Error("Confirmed file deletion completion cannot be reversed");
  const byIdentity = new Map(added.results.map((result) => [fileDeletionIdentity(result), result]));
  for (const result of current.results) {
    const next = byIdentity.get(fileDeletionIdentity(result));
    if (next === undefined) throw new Error("Stored file deletion result identity cannot be dropped");
    if (next.ref.attachmentId !== result.ref.attachmentId || next.ref.name !== result.ref.name
      || next.ref.bytes !== result.ref.bytes) {
      throw new Error("Stored file deletion reference cannot be replaced");
    }
    if (confirmedFileDeletionResult(result)
      && (next.outcome !== result.outcome || next.message !== result.message)) {
      throw new Error("Confirmed file deletion result cannot be replaced");
    }
  }
  if (current.complete && added.results.length !== current.results.length) {
    throw new Error("Completed file deletion cannot acquire new attachment identities");
  }
  return added;
}

function assertFileDeletionBeforeLog(
  fileDeletion: SessionFileDeletion | undefined,
  progress: SessionCleanupProgress,
): void {
  if (fileDeletion !== undefined && !fileDeletion.complete
    && (progress.sessionLog !== undefined || progress.queryIndex !== undefined || progress.sessionInstructions !== undefined)) {
    throw new Error("Cannot confirm log or later cleanup before file attachments are confirmed");
  }
}

function copyImageDeletion(value: SessionImageDeletion): SessionImageDeletion {
  return { ...value, results: value.results.map((result) => ({ ...result, ref: {
    ...result.ref,
    ...(result.ref.originalDimensions === undefined ? {} : {
      originalDimensions: { ...result.ref.originalDimensions },
    }),
  } })) };
}

function imageDeletionForBegin(
  lifecycle: Exclude<ProjectSessionSourceLifecycle, { kind: "deleted" }>,
  supplied: SessionImageDeletion | undefined,
): SessionImageDeletion | undefined {
  const added = supplied === undefined ? undefined : parseImageDeletion(supplied);
  if (lifecycle.kind === "available") {
    if (added !== undefined && (added.complete || added.results.some((result) => result.outcome !== "pending"))) {
      throw new Error("Image deletion must begin with its complete finite pending plan");
    }
    return added;
  }
  if (added !== undefined) mergeImageDeletion(lifecycle.imageDeletion, added);
  return lifecycle.imageDeletion === undefined ? undefined : copyImageDeletion(lifecycle.imageDeletion);
}

function parseImageDeletion(value: unknown): SessionImageDeletion {
  const source = objectValue(value, "image deletion");
  assertKnownFields(source, ["contract", "root", "cacheRoot", "coverage", "complete", "results"], "image deletion");
  if (source.contract !== "image-v1") throw new Error("Unsupported image deletion contract");
  if (source.coverage !== "source-grouped-v2-and-positive-legacy") throw new Error("Unsupported image deletion coverage");
  const root = imageDeletionRoot(source.root, "image deletion root");
  const cacheRoot = imageDeletionRoot(source.cacheRoot, "image deletion cache root");
  const complete = booleanValue(source.complete, "image deletion complete");
  const results = arrayValue(source.results, "image deletion results").map(parseImageDeletionResult);
  if (results.length === 0) throw new Error("Image deletion requires a nonempty complete finite plan");
  const identities = new Set<string>();
  const canonical = new Set<string>();
  const sources = new Map<string, SessionImageDeletionRef>();
  for (const result of results) {
    const key = imageDeletionIdentity(result);
    if (identities.has(key)) throw new Error("Duplicate image deletion result physical identity");
    identities.add(key);
    if (result.kind === "image-object") canonical.add(result.ref.attachmentId);
    const previous = sources.get(result.ref.attachmentId);
    if (previous !== undefined && !sameImageSource(previous, result.ref)) {
      throw new Error("Image deletion references disagree on immutable source metadata");
    }
    sources.set(result.ref.attachmentId, result.ref);
  }
  for (const id of sources.keys()) {
    if (!canonical.has(id)) throw new Error("Image deletion requires a canonical item for every source");
  }
  if (complete && results.some((result) => !confirmedImageDeletionResult(result))) {
    throw new Error("Image deletion completion requires confirmed attachment results");
  }
  return { contract: "image-v1", root, cacheRoot, coverage: "source-grouped-v2-and-positive-legacy", complete, results };
}

function imageDeletionRoot(value: unknown, label: string): string {
  const root = stringValue(value, label);
  if (root.includes("\0") || !isAbsolute(root) || resolve(root) !== root) {
    throw new Error("Image deletion roots must be exact normalized local absolute paths");
  }
  return root;
}

function parseImageDeletionResult(value: unknown): SessionImageDeletionResult {
  const source = objectValue(value, "image deletion result");
  const kind = source.kind;
  if (kind !== "image-object" && kind !== "image-variant" && kind !== "legacy-image-variant") {
    throw new Error("Invalid image deletion result kind");
  }
  assertKnownFields(source, kind === "image-object" ? ["kind", "ref", "outcome", "message"]
    : ["kind", "ref", "variantId", "outcome", "message"], "image deletion result");
  const ref = parseImageDeletionRef(source.ref);
  const outcome = source.outcome;
  if (outcome !== "pending" && outcome !== "deleted" && outcome !== "missing"
    && outcome !== "retained-shared" && outcome !== "failed" && outcome !== "unknown") {
    throw new Error("Invalid image deletion result outcome");
  }
  const message = source.message === undefined ? undefined
    : requiredText(stringValue(source.message, "image deletion result message"), "image deletion result message");
  const common: Pick<SessionImageDeletionResult, "ref" | "outcome" | "message"> = {
    ref, outcome, ...(message === undefined ? {} : { message }),
  };
  if (kind === "image-object") return { kind, ...common };
  const variantId = stringValue(source.variantId, "image deletion variant id");
  if (!/^sha256:[a-f0-9]{64}$/.test(variantId)) throw new Error("Invalid image deletion variant id");
  if (kind === "image-variant") return { kind, variantId, ...common };
  return { kind, variantId, ...common };
}

function parseImageDeletionRef(value: unknown): SessionImageDeletionRef {
  const source = objectValue(value, "image deletion reference");
  assertKnownFields(source, ["attachmentId", "mediaType", "bytes", "width", "height", "name", "originalDimensions"], "image deletion reference");
  const attachmentId = stringValue(source.attachmentId, "image attachment id");
  if (!/^sha256:[a-f0-9]{64}$/.test(attachmentId)) throw new Error("Invalid image attachment id");
  const mediaType = source.mediaType;
  if (mediaType !== "image/png" && mediaType !== "image/jpeg" && mediaType !== "image/webp" && mediaType !== "image/gif") {
    throw new Error("Invalid image attachment media type");
  }
  const bytes = source.bytes;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error("Image attachment bytes must be a nonnegative safe integer");
  }
  const width = imageDimension(source.width);
  const height = imageDimension(source.height);
  const name = source.name === undefined ? undefined : stringValue(source.name, "image attachment name");
  let originalDimensions: SessionImageDeletionRef["originalDimensions"];
  if (source.originalDimensions !== undefined) {
    const dimensions = objectValue(source.originalDimensions, "image original dimensions");
    assertKnownFields(dimensions, ["width", "height"], "image original dimensions");
    originalDimensions = { width: imageDimension(dimensions.width), height: imageDimension(dimensions.height) };
  }
  return { attachmentId, mediaType, bytes, width, height, ...(name === undefined ? {} : { name }),
    ...(originalDimensions === undefined ? {} : { originalDimensions }) };
}

function imageDimension(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("Image dimensions must be positive safe integers");
  }
  return value;
}

function sameImageSource(left: SessionImageDeletionRef, right: SessionImageDeletionRef): boolean {
  return left.attachmentId === right.attachmentId && left.mediaType === right.mediaType
    && left.bytes === right.bytes && left.width === right.width && left.height === right.height;
}

function sameImageDeletionRef(left: SessionImageDeletionRef, right: SessionImageDeletionRef): boolean {
  return sameImageSource(left, right) && left.name === right.name
    && left.originalDimensions?.width === right.originalDimensions?.width
    && left.originalDimensions?.height === right.originalDimensions?.height;
}

function imageDeletionIdentity(result: SessionImageDeletionResult): string {
  if (result.kind === "image-object") return "object:" + result.ref.attachmentId;
  // legacy 缓存的物理路径只有 variant id；不能因声称另一 source 便获得第二项。
  if (result.kind === "legacy-image-variant") return "legacy:" + result.variantId;
  return "variant:" + result.ref.attachmentId + ":" + result.variantId;
}

function confirmedImageDeletionResult(result: SessionImageDeletionResult): boolean {
  return result.outcome === "deleted" || result.outcome === "missing" || result.outcome === "retained-shared";
}

function mergeImageDeletion(
  current: SessionImageDeletion | undefined,
  supplied: SessionImageDeletion | undefined,
): SessionImageDeletion | undefined {
  if (supplied === undefined) return current === undefined ? undefined : copyImageDeletion(current);
  const added = parseImageDeletion(supplied);
  if (current === undefined || added.contract !== current.contract || added.root !== current.root
    || added.cacheRoot !== current.cacheRoot || added.coverage !== current.coverage) {
    throw new Error("Image deletion contract, roots and coverage cannot change after begin");
  }
  if (current.complete && !added.complete) throw new Error("Confirmed image deletion completion cannot be reversed");
  if (added.results.length !== current.results.length) throw new Error("Image deletion finite plan cannot acquire or drop identities");
  const byIdentity = new Map(added.results.map((result) => [imageDeletionIdentity(result), result]));
  for (const result of current.results) {
    const next = byIdentity.get(imageDeletionIdentity(result));
    if (next === undefined || !sameImageDeletionRef(result.ref, next.ref)) {
      throw new Error("Stored image deletion source and finite physical identity cannot be replaced");
    }
    if (confirmedImageDeletionResult(result)
      && (next.outcome !== result.outcome || next.message !== result.message)) {
      throw new Error("Confirmed image deletion result cannot be replaced");
    }
  }
  return added;
}

function assertImageDeletionBeforeLog(
  imageDeletion: SessionImageDeletion | undefined,
  progress: SessionCleanupProgress,
): void {
  if (imageDeletion !== undefined && !imageDeletion.complete
    && (progress.sessionLog !== undefined || progress.queryIndex !== undefined || progress.sessionInstructions !== undefined)) {
    throw new Error("Cannot confirm log or later cleanup before image attachments are confirmed");
  }
}

function parseCleanupProgress(value: unknown): SessionCleanupProgress {
  const source = objectValue(value, "source cleanup progress");
  const allowed = new Set(["projectionCache", "sessionLog", "queryIndex", "sessionInstructions", "projectSchedules", "nativeSchedules"]);
  if (Object.keys(source).some((key) => !allowed.has(key))) throw new Error("Unknown source cleanup progress owner");
  const progress: { -readonly [K in keyof SessionCleanupProgress]: SessionCleanupProgress[K] } = {};
  if (source.projectionCache !== undefined) {
    if (source.projectionCache !== "cleared") throw new Error("Invalid projection cache cleanup result");
    progress.projectionCache = source.projectionCache;
  }
  if (source.sessionLog !== undefined) {
    if (source.sessionLog !== "removed" && source.sessionLog !== "already-absent") throw new Error("Invalid session log cleanup result");
    progress.sessionLog = source.sessionLog;
  }
  if (source.queryIndex !== undefined) {
    if (source.queryIndex !== "cleared" && source.queryIndex !== "not-present") throw new Error("Invalid query index cleanup result");
    progress.queryIndex = source.queryIndex;
  }
  if (source.sessionInstructions !== undefined) {
    if (source.sessionInstructions !== "removed" && source.sessionInstructions !== "already-absent") throw new Error("Invalid session instructions cleanup result");
    progress.sessionInstructions = source.sessionInstructions;
  }
  for(const key of ["projectSchedules","nativeSchedules"] as const) {
    if(source[key]!==undefined) {if(source[key]!=="cleared") throw new Error("Invalid schedule cleanup result");progress[key]="cleared";}
  }
  return progress;
}

function mergeCleanupProgress(current: SessionCleanupProgress, added: SessionCleanupProgress): SessionCleanupProgress {
  for (const key of Object.keys(added) as (keyof SessionCleanupProgress)[]) {
    if (current[key] !== undefined && current[key] !== added[key]) {
      throw new Error("Confirmed source cleanup result cannot be replaced: " + key);
    }
  }
  return {...current, ...added};
}

function parseCleanupFailure(value: unknown): SessionCleanupFailure {
  const source = objectValue(value, "source cleanup failure");
  const allowed = new Set(["stage", "certainty", "message", "knownRemovedArtifacts", "knownRemainingArtifacts"]);
  if (Object.keys(source).some((key) => !allowed.has(key))) throw new Error("Unknown source cleanup failure field");
  const stage = source.stage;
  if (stage !== "project-schedules" && stage !== "native-schedules" && stage !== "project-files" && stage !== "projection-cache" && stage !== "file-attachments" && stage !== "image-attachments"
    && stage !== "session-log" && stage !== "query-index"
    && stage !== "session-instructions" && stage !== "final-project-record") {
    throw new Error("Invalid source cleanup failure stage");
  }
  const certainty = source.certainty;
  if (certainty !== "failed" && certainty !== "known-partial" && certainty !== "unknown") {
    throw new Error("Invalid source cleanup failure certainty");
  }
  const failure: { -readonly [K in keyof SessionCleanupFailure]: SessionCleanupFailure[K] } = {
    stage, certainty, message: requiredText(stringValue(source.message, "cleanup failure message"), "cleanup failure message"),
  };
  for (const key of ["knownRemovedArtifacts", "knownRemainingArtifacts"] as const) {
    const count = source[key];
    if (count === undefined) continue;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new Error("Known cleanup artifact count must be a nonnegative integer");
    }
    failure[key] = count;
  }
  return failure;
}

function operationalSessions(record: PersistedProjectRecord): ProjectSession[] {
  if (record.project.sourceLifecycle !== undefined) return [];
  return record.sessions.filter((session) => session.sourceLifecycle.kind === "available" && currentCarrier(session).closed === undefined);
}

function lifecycleSessions(record: PersistedProjectRecord): ProjectSession[] {
  return record.sessions.filter(session => sessionCarriers(session).some(carrier => carrier.sourceLifecycle.kind === "available"));
}

function copyDelivery(delivery: Delivery): Delivery {
  return { ...delivery, sources: copySources(delivery.sources) };
}

function copyMembership(membership: ProjectMembership): ProjectMembership {
  return { project: copyProject(membership.project), session: copySession(membership.session) };
}

function copyWorkspace(workspace: WorkspaceReference): WorkspaceReference {
  return { path: requiredText(workspace.path, "workspace path") };
}

function copySources(sources: readonly SourceRef[]): SourceRef[] {
  return uniqueNativeSources(sources.map((source) => {
    const copied = parseNativeSource(source);
    if (copied === undefined) {
      throw new Error("Delivery source must be a native message or tool locator");
    }
    return copied;
  }));
}

function uniqueNativeSources(sources: readonly NativeProjectSource[]): NativeProjectSource[] {
  const keys = new Set<string>();
  return sources
    .filter((source) => {
      const key = nativeProjectSourceKey(source);
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    })
    .map(encodeNativeProjectSource);
}

function parseNativeSource(value: unknown): NativeProjectSource | undefined {
  if (objectOrUndefined(value)?.kind === "native-event") {
    try { return decodeNativeProjectSource(value); } catch { return undefined; }
  }
  const source = objectOrUndefined(value);
  if (source?.kind === "message") {
    if (typeof source.hostSessionId !== "string" || typeof source.messageId !== "string") {
      return undefined;
    }
    return {
      kind: "message",
      hostSessionId: requiredText(source.hostSessionId, "message source host session id"),
      messageId: requiredText(source.messageId, "message source id"),
    };
  }
  if (source?.kind === "tool") {
    if (typeof source.hostSessionId !== "string" || typeof source.toolCallId !== "string") {
      return undefined;
    }
    return {
      kind: "tool",
      hostSessionId: requiredText(source.hostSessionId, "tool source host session id"),
      toolCallId: requiredText(source.toolCallId, "tool source id"),
    };
  }
  return undefined;
}

function legacySourceLocators(
  raw: JsonObject,
  reference: LegacySourceReference,
): { sources: NativeProjectSource[]; reason: string } {
  if (reference.kind === "control") {
    const controlId = safeIdentifier(reference.controlId, "legacy control id");
    const control = findLegacyEntry(raw.controls, controlId);
    if (control === undefined) return { sources: [], reason: "legacy control is unavailable" };
    return legacyLocatorResult(control);
  }
  const recordKind = requiredText(reference.recordKind, "legacy record kind");
  const recordId = safeIdentifier(reference.recordId, "legacy record id");
  const field = legacyCollectionField(recordKind);
  if (field === undefined) {
    return { sources: [], reason: "legacy " + recordKind + " record is unavailable" };
  }
  const entry = findLegacyEntry(raw[field], recordId);
  if (entry === undefined) {
    return { sources: [], reason: "legacy " + recordKind + " record is unavailable" };
  }
  return legacyLocatorResult(entry, reference.revision);
}

function legacyCollectionField(recordKind: string): string | undefined {
  switch (recordKind) {
    case "requirement":
      return "requirements";
    case "work":
      return "work";
    case "delivery":
      return "deliveries";
    case "control":
      return "controls";
    case "result":
      return "results";
    case "artifact":
      return "artifacts";
    case "review":
    case "recognition":
      return "reviews";
    default:
      return undefined;
  }
}

function findLegacyEntry(value: unknown, id: string): JsonObject | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(objectOrUndefined).find((entry) => entry?.id === id);
}

function legacyLocatorResult(
  entry: JsonObject,
  expectedRevision?: number,
): { sources: NativeProjectSource[]; reason: string } {
  if (expectedRevision !== undefined) revisionValue(expectedRevision, "legacy source revision");
  const sources = legacyDirectNativeSources(entry);
  const revisionMatches = expectedRevision === undefined || entry.revision === expectedRevision;
  if (!revisionMatches) {
    return {
      sources,
      reason: sources.length === 0
        ? "stored current historical revision is not exact-old; no direct native source locator is stored"
        : "stored current historical revision is not exact-old; direct native source locators are from the stored record",
    };
  }
  return {
    sources,
    reason: sources.length === 0
      ? "legacy record has no direct native source locator"
      : "direct native source locators were read from the stored legacy record",
  };
}

function legacyDirectNativeSources(entry: JsonObject): NativeProjectSource[] {
  const sources: NativeProjectSource[] = [];
  const add = (value: unknown): void => {
    const source = parseNativeSource(value);
    if (source !== undefined) sources.push(source);
  };
  const addMany = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const item of value) add(item);
  };
  addMany(entry.sources);
  add(entry.source);
  add(entry.decisionSource);
  addMany(entry.evidence);
  const correction = objectOrUndefined(entry.correction);
  if (correction !== undefined) {
    add(correction.source);
    addMany(correction.evidence);
  }
  const statement = objectOrUndefined(entry.statement);
  if (statement !== undefined) {
    add(statement.source);
    addMany(statement.evidence);
  }
  if (Array.isArray(entry.revisions)) {
    for (const revision of entry.revisions) {
      addMany(objectOrUndefined(revision)?.sources);
    }
  }
  return uniqueNativeSources(sources);
}

function hasRevisionConflict(currentRevision: number, options: RevisionOptions): boolean {
  return options.expectedRevision !== undefined && options.expectedRevision !== currentRevision;
}

function deliveryIntentValue(value: unknown): DeliveryIntent {
  if (
    value === "assign"
    || value === "change"
    || value === "report"
    || value === "question"
    || value === "coordination"
    || value === "continue"
  ) {
    return value;
  }
  throw new Error("Unsupported delivery intent: " + String(value));
}

function deliveryDispatchValue(value: unknown): Delivery["dispatch"] {
  if (value === "notDelivered" || value === "delivered") return value;
  throw new Error("Unsupported delivery dispatch state: " + String(value));
}

function deliveryProcessingValue(value: unknown): Delivery["processing"] {
  if (
    value === "pending"
    || value === "claimed"
    || value === "responded"
    || value === "discardedUnrun"
  ) {
    return value;
  }
  throw new Error("Unsupported delivery processing state: " + String(value));
}

function byCreatedAt<T extends { createdAt: string }>(left: T, right: T): number {
  return left.createdAt.localeCompare(right.createdAt);
}

function optionalArrayValue(value: unknown, label: string): unknown[] {
  return value === undefined ? [] : arrayValue(value, label);
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(label + " must be an array");
  return value;
}

function objectValue(value: unknown, label: string): JsonObject {
  const object = objectOrUndefined(value);
  if (object === undefined) throw new Error(label + " must be an object");
  return object;
}

function objectOrUndefined(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(label + " must be a string");
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(label + " must be a boolean");
  return value;
}

function requiredText(value: string, label: string): string {
  if (value.trim().length === 0) throw new Error(label + " must not be empty");
  return value;
}

function revisionValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(label + " must be a positive integer");
  }
  return value;
}

function safeIdentifier(value: string, label: string): string {
  if (
    value.length === 0
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
    || value.includes("\0")
  ) {
    throw new Error(label + " must be a single path segment");
  }
  return value;
}

function parseWorkspace(value: unknown): WorkspaceReference {
  const source = objectValue(value, "workspace reference");
  return { path: requiredText(stringValue(source.path, "workspace path"), "workspace path") };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function assertProjectAvailable(project:Project):void { if(project.sourceLifecycle!==undefined) throw new Error("Project source is unavailable: "+project.id); }
function parseProjectSourceLifecycle(value:unknown):ProjectSourceLifecycle {
  const source=objectValue(value,"project source lifecycle"),requestedAt=requiredText(stringValue(source.requestedAt,"project deletion time"),"project deletion time");
  if(source.kind==="deleted") return {kind:"deleted",requestedAt,deletedAt:requiredText(stringValue(source.deletedAt,"project deletedAt"),"project deletedAt")};
  if(source.kind!=="deleting"&&source.kind!=="partial") throw new Error("Invalid project deletion state");
  const progress=objectValue(source.progress,"project cleanup progress");
  if(progress.projectFiles!==undefined&&progress.projectFiles!=="removed"&&progress.projectFiles!=="already-absent") throw new Error("Invalid project files result");
  return {kind:source.kind,requestedAt,updatedAt:requiredText(stringValue(source.updatedAt,"project deletion updatedAt"),"project deletion updatedAt"),
    progress:{...(progress.projectFiles===undefined?{}:{projectFiles:progress.projectFiles})},...(source.failure===undefined?{}:{failure:parseCleanupFailure(source.failure)})};
}
function parseTerminalRecord(raw:JsonObject,projectId:string):PersistedProjectRecord {
  const p=objectValue(raw.project,"terminal project"),life=parseProjectSourceLifecycle(p.sourceLifecycle);
  if(p.id!==projectId||life.kind!=="deleted") throw new Error("Invalid terminal project identity");
  const revision=revisionValue(p.revision,"terminal revision"), time=life.deletedAt;
  const project:Project={id:projectId,name:DELETED_SOURCE_TITLE,revision,archived:false,createdAt:life.requestedAt,updatedAt:time,sourceLifecycle:life};
  const sessions=arrayValue(raw.sources,"terminal sources").map((value):ProjectSession=>{
    const row=objectValue(value,"terminal source"),role=row.role;
    if(role!=="main"&&role!=="execution"&&role!=="memory"&&(role!=="session-manager"||raw.version!==CONTINUITY_RECORD_VERSION)) throw new Error("Invalid terminal role");
    if (raw.version === CARRIER_RECORD_VERSION || raw.version === CONTINUITY_RECORD_VERSION) {
      if ("hostSessionId" in row || "ownedDeletion" in row) throw new Error("Terminal carrier record cannot contain legacy host truth");
      const carriers = arrayValue(row.carriers, "terminal carriers").map(parseCarrier), first = carriers[0];
      if (first === undefined || carriers.some(carrier => carrier.sourceLifecycle.kind !== "deleted")) throw new Error("Terminal carrier source is not deleted");
      const session = projectCurrentCarrier({ id:safeIdentifier(stringValue(row.id,"terminal binding"),"terminal binding"),projectId,
        hostSessionId:first.hostSessionId,sourceLifecycle:first.sourceLifecycle,carriers,role,
        ...(row.mainPreparations===undefined?{}:{mainPreparations:parseMainPreparations(row.mainPreparations,raw.version as RecordVersion)}),
        revision:revisionValue(row.revision,"terminal source revision"),title:DELETED_SOURCE_TITLE,archived:false,createdAt:life.requestedAt,updatedAt:time });
      validateCarriers(session); if ((session.mainPreparations??[]).some(preparation=>preparation.state!=='committed'&&preparation.sourceLifecycle?.kind!=='deleted')) throw new Error('Terminal preparation source is not deleted'); return session;
    }
    const session: ProjectSession = {id:safeIdentifier(stringValue(row.id,"terminal binding"),"terminal binding"),projectId,hostSessionId:requiredText(stringValue(row.hostSessionId,"terminal hostID"),"terminal hostID"),role,
      revision:revisionValue(row.revision,"terminal source revision"),title:DELETED_SOURCE_TITLE,archived:false,createdAt:life.requestedAt,updatedAt:time,
      sourceLifecycle:{kind:"deleted",requestedAt:life.requestedAt,deletedAt:time,...(row.ownedDeletion===undefined?{}:{ownedDeletion:parseOwnedDeletedSources(row.ownedDeletion)})}};
    return { ...session, carriers: [{ sequence: 1, hostSessionId: session.hostSessionId, isCurrent: true,
      sourceLifecycle: session.sourceLifecycle, lifecycleTimeBasis: "project-deletion" }] };
  });
  if(new Set(sessions.map(row=>row.id)).size!==sessions.length||new Set(sessions.map(row=>row.hostSessionId)).size!==sessions.length) throw new Error("Duplicate terminal source");
  validateOwnedSourceClaims(sessions);return {version:raw.version === CONTINUITY_RECORD_VERSION ? CONTINUITY_RECORD_VERSION : raw.version === CARRIER_RECORD_VERSION ? CARRIER_RECORD_VERSION : PROJECT_DELETION_RECORD_VERSION,raw,project,sessions,deliveries:[]};
}

function withContinuityFormat(record: PersistedProjectRecord): PersistedProjectRecord {
  return { ...record, version: CONTINUITY_RECORD_VERSION, raw: { ...record.raw, version: CONTINUITY_RECORD_VERSION } };
}
function parseMainPreparations(value: unknown, version: RecordVersion): readonly MainCarrierPreparation[] {
  if (version < CONTINUITY_RECORD_VERSION) throw new Error('Main preparations require project record v15');
  const ids = new Set<string>();
  return arrayValue(value, 'main preparations').map(value => {
    const row = ownedObject(value, ['attemptId', 'fromHeader', 'toHostSessionId', 'toHeader', 'state', 'createdAt', 'updatedAt', 'retirement', 'sourceLifecycle'], 'main preparation');
    const attemptId = requiredText(stringValue(row.attemptId, 'attempt id'), 'attempt id');
    if (ids.has(attemptId)) throw new Error('Duplicate main preparation attempt'); ids.add(attemptId);
    const state = row.state;
    if (state !== 'unpublished' && state !== 'committed' && state !== 'abandoned') throw new Error('Invalid main preparation state');
    if (row.retirement !== undefined && (row.retirement !== 'confirmed' || state !== 'abandoned')) throw new Error('Invalid preparation retirement');
    const toHostSessionId = requiredText(stringValue(row.toHostSessionId, 'prepared host id'), 'prepared host id');
    return { attemptId, fromHeader: parseCreationHeader(row.fromHeader, false), toHostSessionId, state,
      ...(row.toHeader === undefined ? {} : { toHeader: carrierHeader(parseCreationHeader(row.toHeader, false), toHostSessionId) }),
      ...(row.retirement === 'confirmed' ? { retirement: 'confirmed' as const } : {}),
      ...(row.sourceLifecycle === undefined ? {} : { sourceLifecycle: parseSourceLifecycle(row.sourceLifecycle, version) }),
      createdAt: requiredText(stringValue(row.createdAt, 'preparation createdAt'), 'preparation createdAt'),
      updatedAt: requiredText(stringValue(row.updatedAt, 'preparation updatedAt'), 'preparation updatedAt') };
  });
}

function hasClaimedHost(records: readonly PersistedProjectRecord[], hostSessionId: string): boolean {
  return records.some(record => record.sessions.some(session => sessionCarriers(session).some(carrier => carrier.hostSessionId === hostSessionId)
    || ownedMemberIds(session).includes(hostSessionId) || (session.mainPreparations ?? []).some(preparation => preparation.toHostSessionId === hostSessionId || (preparation.sourceLifecycle!==undefined&&preparation.sourceLifecycle.kind!=='available'&&preparation.sourceLifecycle.ownedDeletion?.members.some(member=>member.header.id===hostSessionId)))));
}
