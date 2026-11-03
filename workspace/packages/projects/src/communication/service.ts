/** 新通信的唯一执行owner；不调用已退出的Delivery写链。 */
import { randomUUID } from 'node:crypto';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { ProjectInvocationPort } from '../stock/project-ports.ts';
import { canonicalJson, canonicalSendArgs, decodeCommunicationFailure, decodeCommunicationSourceFailures, CommunicationError, communicationError, jsonFrozen, operationReference, snapshotCodec, validateSendArgs } from './contract.ts';
import type { CommunicationEndpoint, CommunicationFailure, CommunicationInvocationSource, CommunicationPartV1, CommunicationReplyToV1, CommunicationSendArgs, CommunicationSnapshotV1, CommunicationSessionIdentity, CommunicationSource, CommunicationSourceFailure } from './contract.ts';
import { CommunicationOperationRepository, communicationOperationConflict, type CommunicationOperation, type CommunicationTransportFacts } from './records.ts';
import { CommunicationTranscript, CommunicationPreparedSaveError } from './transcript.ts';
import { CommunicationQuery } from './query.ts';
import { NativeInputPort } from './native-input.ts';
import { durableMutationDetails } from '../metadata-files.ts';
export interface CommunicationAccess {
  readonly projectId: string;
  readonly sender: CommunicationEndpoint;
  readonly agent: Agent;
}
export interface CommunicationSourceResolverInput {
  readonly projectId: string;
  readonly sender: CommunicationEndpoint;
  readonly userMessageRefs: readonly CommunicationSource[];
  readonly contextRefs: readonly CommunicationSource[];
  readonly signal: AbortSignal;
}
export type CommunicationSourceResolver = (input: CommunicationSourceResolverInput) => Promise<{
  readonly userMessageParts: readonly CommunicationPartV1[];
  readonly contextParts: readonly CommunicationPartV1[];
}>;
export interface CommunicationServiceDependencies {
  readonly invocations: ProjectInvocationPort;
  access(exec: ToolRunContext): Promise<CommunicationAccess>;
  authorizeNew(exec: ToolRunContext, access: CommunicationAccess): Promise<void>;
  /** Acquire the stable recipient before resolving its current carrier; retain it through settlement. */
  withTarget<T>(projectId: string, targetSessionId: string, operation: string,
    run: (recipient: CommunicationEndpoint, assertCurrent: () => void) => Promise<T>): Promise<T>;
  /** Exact retained carriers of this stable work session; never origin chains or owned child sessions. */
  replyHolders(projectId: string, sessionId: string): Promise<readonly CommunicationSessionIdentity[]>;
  withHolder<T>(hostSessionId: string, run: () => Promise<T>): Promise<T>;
  sessionCreatedAt(projectId: string, hostSessionId: string): Promise<number>;
  resolveSources?: CommunicationSourceResolver;
}
export class CommunicationService {
  private readonly inFlight = new Map<string, {
    readonly digest: string;
    readonly promise: Promise<JsonValue>;
  }>();
  constructor(
    private readonly repository: CommunicationOperationRepository,
    private readonly transcript: CommunicationTranscript,
    private readonly native: NativeInputPort,
    private readonly query: CommunicationQuery,
    private readonly deps: CommunicationServiceDependencies) { }
  send(exec: ToolRunContext, input: CommunicationSendArgs): Promise<JsonValue> {
    let args: CommunicationSendArgs, source: CommunicationInvocationSource;
    try {
      args = validateSendArgs(input);
      const invocation = this.deps.invocations.get(exec);
      if (invocation === undefined)
        throw communicationError('COMMUNICATION_INVOCATION_REQUIRED', 'New communication requires a native tool invocation occurrence');
      source = invocation;
    }
    catch (error) {
      return Promise.reject(error);
    }
    const operationRef = operationReference(source), binding = canonicalSendArgs(args);
    const pending = this.inFlight.get(operationRef);
    if (pending !== undefined) {
      if (pending.digest !== binding.digest)
        return Promise.reject(communicationError('COMMUNICATION_ARGUMENT_CONFLICT', 'This tool occurrence is already bound to different send arguments'));
      return this.deps.access(exec).then(() => pending.promise);
    }
    // 在任何许可、来源、目标await前同步登记同调用责任。
    const task = Promise.withResolvers<JsonValue>();
    this.inFlight.set(operationRef, { digest: binding.digest, promise: task.promise });
    void this.run(exec, args, source, operationRef, binding).then(task.resolve, task.reject).finally(() => {
      if (this.inFlight.get(operationRef)?.promise === task.promise)
        this.inFlight.delete(operationRef);
    });
    return task.promise;
  }
  private async run(
    exec: ToolRunContext,
    args: CommunicationSendArgs,
    source: CommunicationInvocationSource,
    operationRef: string,
    binding: ReturnType<typeof canonicalSendArgs>): Promise<JsonValue> {
    const access = await this.deps.access(exec);
    const previous = await this.repository.get(access.projectId, operationRef);
    if (previous !== undefined) {
      this.assertBinding(previous, binding.digest);
      return await this.query.read(access.projectId, { operationRef }) as unknown as JsonValue;
    }
    await this.deps.authorizeNew(exec, access);
    this.transcript.assertInvocation(access.agent, source);
    return await this.deps.withHolder(access.sender.hostSessionId, async () => {
      const now = new Date().toISOString();
      const registered = await this.repository.register({
        format: 'projects-communication-operation/v1',
        projectId: access.projectId,
        operationRef,
        invocationSource: source,
        argumentsFormat: binding.format,
        argumentsDigest: binding.digest,
        deliveryMode: args.delivery_mode ?? 'queued',
        registeredAt: now,
        updatedAt: now,
        phase: 'registered',
        sender: access.sender,
        senderPersistence: 'not-started',
        transport: { insertion: 'not-attempted', recipientPersistence: 'not-started', wakeup: 'not-requested' }
      });
      if (!registered.created) {
        this.assertBinding(registered.operation, binding.digest);
        return await this.query.read(access.projectId, { operationRef }) as unknown as JsonValue;
      }
      const operation = registered.operation;
      let replyTo: CommunicationReplyToV1 | undefined;
      try {
        exec.signal.throwIfAborted();
        if (args.reply_to_delivery_id !== undefined) {
          for (const holder of await this.deps.replyHolders(access.projectId, access.sender.sessionId)) {
            exec.signal.throwIfAborted();
            replyTo = await this.transcript.findReceived(access.projectId, holder, args.reply_to_delivery_id, exec.signal);
            if (replyTo !== undefined) break;
          }
          if (replyTo === undefined)
            throw communicationError('COMMUNICATION_REPLY_NOT_RECEIVED', 'The reply id is not an actual received communication in this work session');
        }
      } catch (error) {
        return this.preparationFailure(access, source, operation, error, exec.signal);
      }
      let entered = false;
      try {
        return await this.deps.withTarget(access.projectId, replyTo?.sender.sessionId ?? args.target_session_id!, operationRef,
          async (recipient, assertCurrent) => {
            entered = true;
            return this.deliver(exec, args, source, access, operation, recipient, replyTo, assertCurrent);
          });
      } catch (error) {
        // Once entered, transport/query failures retain their existing owner and are never reclassified.
        if (entered) throw error;
        const failure = replyTo !== undefined && !exec.signal.aborted
          ? communicationError('COMMUNICATION_REPLY_TARGET_UNAVAILABLE', `The original sender has no available current recipient; no alternate target was selected. ${errorText(error)}`) : error;
        return this.preparationFailure(access, source, operation, failure, exec.signal);
      }
    });
  }
  private async deliver(exec: ToolRunContext, args: CommunicationSendArgs, source: CommunicationInvocationSource,
    access: CommunicationAccess, operation: CommunicationOperation, recipient: CommunicationEndpoint,
    replyTo: CommunicationReplyToV1 | undefined, assertCurrent: () => void): Promise<JsonValue> {
    const operationRef = operation.operationRef;
    let snapshot: CommunicationSnapshotV1;
    let message: ReturnType<NativeInputPort['prepare']>;
    try {
      exec.signal.throwIfAborted();
      assertCurrent();
      if (recipient.sessionId === access.sender.sessionId)
        throw communicationError('COMMUNICATION_SELF_TARGET', 'Cannot send communication to its sender session');
      if (args.delivery_mode === 'direct' && (access.sender.role !== 'main' || recipient.role !== 'execution'))
        throw communicationError('COMMUNICATION_DIRECT_FORBIDDEN', 'Direct delivery is available only from the actual main session to an execution session');
      if (replyTo !== undefined && replyTo.format !== 'legacy') {
        const originalSenders = await this.deps.replyHolders(access.projectId, replyTo.sender.sessionId);
        if (recipient.sessionId !== replyTo.sender.sessionId || !originalSenders.some(holder => holder.hostSessionId === replyTo.sender.hostSessionId))
          throw communicationError('COMMUNICATION_REPLY_TARGET_UNAVAILABLE', 'The original sender is unavailable; no alternate target was selected');
      }
      const selected = {
        projectId: access.projectId,
        sender: access.sender,
        userMessageRefs: args.user_message_refs ?? [],
        contextRefs: args.context_refs ?? [],
        signal: exec.signal
      };
      const preparedInput = await this.withSelectedSourceHolders(selected, async () => {
        const parts = this.deps.resolveSources === undefined ? await this.noReferences(selected) : await this.deps.resolveSources(selected);
        exec.signal.throwIfAborted();
        const snapshot = snapshotCodec.decode({
          format: 'projects-communication/v1',
          snapshotVersion: 1,
          projectId: access.projectId,
          deliveryId: randomUUID(),
          operationRef,
          sender: access.sender,
          recipient,
          createdAt: new Date().toISOString(),
          ...(replyTo === undefined ? {} : { replyTo }),
          ...(args.message === undefined ? {} : { agentMessage: args.message }),
          ...parts
        } as unknown as JsonValue);
        const message = this.native.prepare(snapshot);
        const recipientCreatedAt = await this.deps.sessionCreatedAt(access.projectId, recipient.hostSessionId);
        operation = await this.repository.update({
          ...operation,
          phase: 'prepared',
          deliveryId: snapshot.deliveryId,
          recipient,
          ...(replyTo === undefined ? {} : { replyTo }),
          nativeMessageId: String(message.id),
          snapshotDigest: snapshotCodec.identity(snapshot),
          recipientRecord: {
            kind: 'recipient-message',
            holder: { hostSessionId: recipient.hostSessionId, sessionCreatedAt: recipientCreatedAt },
            messageId: String(message.id)
          },
          updatedAt: new Date().toISOString()
        }, operation);
        const senderRecord = await this.transcript.appendPrepared(access.agent, source, snapshot, exec.signal);
        operation = await this.repository.update({ ...operation, senderRecord, senderPersistence: 'flushed', updatedAt: new Date().toISOString() }, operation);
        return { snapshot, message };
      });
      snapshot = preparedInput.snapshot;
      message = preparedInput.message;
    }
    catch (error) {
      return this.preparationFailure(access, source, operation, error, exec.signal);
    }
    let actualTransport: CommunicationTransportFacts | undefined;
    let recordError: { code: string; message: string } | undefined;
    try {
      assertCurrent();
      exec.signal.throwIfAborted();
      operation = await this.repository.update({
        ...operation,
        phase: 'attempted',
        attemptedAt: new Date().toISOString(),
        transport: { insertion: 'unknown', recipientPersistence: 'not-started', wakeup: 'unknown' },
        updatedAt: new Date().toISOString()
      }, operation);
      actualTransport = await this.native.send(snapshot.recipient, message, exec.signal, assertCurrent, operation.deliveryMode ?? 'queued');
      operation = await this.repository.update({ ...operation, phase: 'settled', transport: actualTransport, updatedAt: new Date().toISOString() }, operation);
    }
    catch (error) {
      const current = communicationOperationConflict(error);
      const durability = durableMutationDetails(error);
      if (current !== undefined) {
        operation = current;
        recordError = { code: 'COMMUNICATION_OPERATION_CONFLICT', message: errorText(error) };
      } else if (durability !== undefined && durability.effect !== 'none') {
        // A possibly published phase is not an old phase available for a failure rewrite.
        recordError = { code: durability.code, message: durability.message };
      } else {
        const failure = describe(error, exec.signal);
        // attempted已提交则保留可能发生投递的边界；只结算事实，不再次send。
        try {
          operation = await this.repository.update({ ...operation, failure, updatedAt: new Date().toISOString() }, operation);
        }
        catch (saveError) {
          const concurrent = communicationOperationConflict(saveError);
          if (concurrent !== undefined) operation = concurrent;
          recordError = { code: concurrent === undefined ? 'COMMUNICATION_RESULT_RECORD_FAILED' : 'COMMUNICATION_OPERATION_CONFLICT', message: errorText(saveError) };
        }
      }
    }
    const outcomeError = await this.outcome(access, source, {
      operation_ref: operationRef,
      phase: operation.phase,
      transport: actualTransport ?? operation.transport,
      ...(operation.failure === undefined ? {} : { failure: operation.failure })
    } as unknown as JsonValue);
    const receipt = await this.query.read(access.projectId, { operationRef });
    return jsonFrozen({
      ...receipt,
      ...(recordError === undefined ? {} : { record_error: recordError }),
      ...(outcomeError === undefined ? {} : { sender_outcome_error: outcomeError })
    }) as unknown as JsonValue;
  }
  private async preparationFailure(access: CommunicationAccess, source: CommunicationInvocationSource,
    operation: CommunicationOperation, error: unknown, signal: AbortSignal): Promise<JsonValue> {
    if (communicationOperationConflict(error) !== undefined)
      return this.receiptWithFailure(access.projectId, operation.operationRef, 'COMMUNICATION_OPERATION_CONFLICT', errorText(error));
    const durability = durableMutationDetails(error);
    if (durability !== undefined && durability.effect !== 'none')
      return this.receiptWithFailure(access.projectId, operation.operationRef, durability.code, durability.message);
    const failure = describe(error, signal);
    const previous = operation;
    if (error instanceof CommunicationPreparedSaveError)
      operation = { ...operation, senderRecord: error.record, senderPersistence: error.persistence };
    try {
      operation = await this.repository.update({ ...operation, phase: 'preparation-failed', failure, updatedAt: new Date().toISOString() }, previous);
    } catch (saveError) {
      return this.receiptWithFailure(access.projectId, operation.operationRef,
        communicationOperationConflict(saveError) === undefined ? 'COMMUNICATION_PREPARATION_RECORD_FAILED' : 'COMMUNICATION_OPERATION_CONFLICT', errorText(saveError));
    }
    await this.outcome(access, source, jsonFrozen({ operation_ref: operation.operationRef, phase: operation.phase, failure }) as unknown as JsonValue);
    return await this.query.read(access.projectId, { operationRef: operation.operationRef }) as unknown as JsonValue;
  }
  /** 来源只读责任持续到新的durable sender副本确立；不沿origin/sourceChain追锁旧来源。 */
  private async withSelectedSourceHolders<T>(input: CommunicationSourceResolverInput, run: () => Promise<T>): Promise<T> {
    const holders = new Map<string, Array<Pick<CommunicationSourceFailure, 'group' | 'index' | 'source'>>>();
    for (const [group, refs] of [['user-message', input.userMessageRefs], ['context', input.contextRefs]] as const) {
      for (const [index, source] of refs.entries()) {
        const host = source.kind === 'communication-part' ? source.record.holder.hostSessionId : source.hostSessionId;
        const selected = holders.get(host) ?? [];
        selected.push({ group, index, source });
        holders.set(host, selected);
      }
    }
    const unavailable: CommunicationSourceFailure[] = [];
    const unavailableSelections = new Set<string>();
    const markUnavailable = (selected: readonly Pick<CommunicationSourceFailure, 'group' | 'index' | 'source'>[]) => {
      for (const item of selected) {
        const key = `${item.group}:${item.index}`;
        if (unavailableSelections.has(key)) continue;
        unavailableSelections.add(key);
        unavailable.push(...missingSourceSelections([item]));
      }
    };
    for (const [host, selected] of holders) {
      input.signal.throwIfAborted();
      let createdAt: number;
      try {
        // 先沿真实Project/source owner验证归属，不能为未验证的外项目holder登记责任。
        createdAt = await this.deps.sessionCreatedAt(input.projectId, host);
      } catch {
        input.signal.throwIfAborted();
        markUnavailable(selected);
        continue;
      }
      input.signal.throwIfAborted();
      for (const item of selected) {
        if (item.source.kind === 'communication-part' && item.source.record.holder.sessionCreatedAt !== createdAt) {
          markUnavailable([item]);
        }
      }
    }
    // sender已有外层责任；相同source holder只登记一次。
    const selectedHolders = [...holders]
      .map(([host, selected]) => [host, selected.filter(item => !unavailableSelections.has(`${item.group}:${item.index}`))] as const)
      .filter(([host, selected]) => host !== input.sender.hostSessionId && selected.length > 0);
    type Preparation = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
    const protect = async (index: number): Promise<Preparation> => {
      if (index === selectedHolders.length) {
        try {
          if (unavailable.length > 0) await this.completeSourceFailures(input, unavailable, unavailableSelections);
          return { ok: true, value: await run() };
        }
        catch (error) { return { ok: false, error }; }
      }
      const [host, selected] = selectedHolders[index]!;
      let entered = false;
      try {
        return await this.deps.withHolder(host, () => {
          entered = true;
          return protect(index + 1);
        });
      } catch (error) {
        // 只有接纳前封口才是该来源缺失；内部读取/仓库/flush原错误不能被改名。
        if (!entered && !input.signal.aborted) {
          markUnavailable(selected);
          return protect(index + 1);
        }
        return { ok: false, error };
      }
    };
    const prepared = await protect(0);
    // 内层错误作为有限结果退出guard，释放只读责任后再交Service记录原失败；
    // 不把准备失败误报成原来源有未结算写入，阻塞正在等待的正常删除。
    if (!prepared.ok) throw prepared.error;
    return prepared.value;
  }

  /** 有holder先封口时，仍诊断其它已获准来源；压缩读取索引只在此处映回原选择。 */
  private async completeSourceFailures(input: CommunicationSourceResolverInput, unavailable: CommunicationSourceFailure[], unavailableSelections: ReadonlySet<string>): Promise<never> {
    const selected = (refs: readonly CommunicationSource[], group: CommunicationSourceFailure['group']) => refs
      .map((source, index) => ({ group, index, source }))
      .filter(item => !unavailableSelections.has(`${group}:${item.index}`));
    const user = selected(input.userMessageRefs, 'user-message');
    const context = selected(input.contextRefs, 'context');
    if (user.length > 0 || context.length > 0) {
      const remaining = { ...input, userMessageRefs: user.map(item => item.source), contextRefs: context.map(item => item.source) };
      try {
        if (this.deps.resolveSources === undefined) await this.noReferences(remaining);
        else await this.deps.resolveSources(remaining);
      } catch (error) {
        if (!(error instanceof CommunicationError) || error.code !== 'COMMUNICATION_SOURCES_INCOMPLETE' || error.details === undefined) throw error;
        for (const failure of decodeCommunicationSourceFailures(error.details)) {
          const original = (failure.group === 'user-message' ? user : context)[failure.index];
          if (original === undefined || canonicalJson(original.source) !== canonicalJson(failure.source)) throw error;
          unavailable.push({ ...original, missing: failure.missing });
        }
      }
    }
    input.signal.throwIfAborted();
    unavailable.sort((a, b) => (a.group === b.group ? a.index - b.index : a.group === 'user-message' ? -1 : 1));
    throw unavailableSources(unavailable);
  }

  private async noReferences(input: CommunicationSourceResolverInput) {
    if (input.userMessageRefs.length || input.contextRefs.length)
      throw communicationError('COMMUNICATION_REFERENCES_NOT_READY', 'Selected-source reading is unavailable for this sender; nothing was delivered');
    return { userMessageParts: [], contextParts: [] };
  }
  private assertBinding(operation: CommunicationOperation, digest: string): void {
    if (operation.argumentsDigest !== digest)
      throw communicationError('COMMUNICATION_ARGUMENT_CONFLICT', 'This tool occurrence is already bound to different send arguments');
  }
  private async outcome(access: CommunicationAccess, source: CommunicationInvocationSource, outcome: JsonValue): Promise<string | undefined> {
    try {
      await this.transcript.appendOutcome(access.agent, source, outcome);
      return undefined;
    }
    catch (error) {
      return errorText(error);
    }
  }
  private async receiptWithFailure(projectId: string, operationRef: string, code: string, message: string): Promise<JsonValue> { return jsonFrozen({ ...await this.query.read(projectId, { operationRef }), record_error: { code, message } }) as unknown as JsonValue; }
}
function describe(error: unknown, signal: AbortSignal): CommunicationFailure {
  const cancelled = signal.aborted && error === signal.reason || error instanceof Error && error.name === 'AbortError';
  const failure: CommunicationFailure = {
    code: error instanceof CommunicationError ? error.code : cancelled ? 'COMMUNICATION_CANCELLED' : 'COMMUNICATION_PREPARATION_FAILED',
    message: cancelled && !(error instanceof Error) && typeof error !== 'string' ? 'Communication was cancelled' : errorText(error),
    ...(error instanceof CommunicationError && error.code === 'COMMUNICATION_SOURCES_INCOMPLETE' && error.details !== undefined
      ? { sourceFailures: decodeCommunicationSourceFailures(error.details) }
      : {}),
  };
  return decodeCommunicationFailure(failure);
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function missingSourceSelections(selected: readonly Pick<CommunicationSourceFailure, 'group' | 'index' | 'source'>[]): CommunicationSourceFailure[] {
  return selected.map(item => ({ ...item, missing: [{ code: 'SOURCE_UNAVAILABLE' }] }));
}
function unavailableSources(failures: readonly CommunicationSourceFailure[]): CommunicationError {
  return communicationError('COMMUNICATION_SOURCES_INCOMPLETE', 'Selected source holder is unavailable; no communication was delivered', jsonFrozen(failures) as unknown as JsonValue);
}
