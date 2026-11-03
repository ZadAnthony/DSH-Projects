/** 通信的纯数据合同；可由browser/remote/host共同引用，不导入执行或存储实现。 */
import type { ToolInvocationSource } from './invocation-source.ts';
import type { FileBlock, ImageBlock } from '@deepseek-ai/dsh-llm/types';
import type {} from '@deepseek-ai/dsh-llm/message';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';

/** Projects程序提供的实际调用身份；不由模型提供。 */
export type CommunicationInvocationSource = ToolInvocationSource;
export interface CommunicationSessionIdentity {
  readonly hostSessionId: string;
  readonly sessionCreatedAt: number;
}
/** 标题只供显示；路由和归属只使用真实 ID。 */
export interface CommunicationEndpoint {
  readonly sessionId: string;
  readonly hostSessionId: string;
  readonly role: 'main' | 'execution';
  readonly title: string;
}
import type { NativeProjectSource } from '../source-reference-types.ts';
export type CommunicationNativeSource = NativeProjectSource;
/** 保存副本只在本地 holder 读取，原来源失效不改读另一份版本。 */
export interface CommunicationSavedPartSource {
  readonly kind: 'communication-part';
  readonly holder: CommunicationSessionIdentity;
  readonly record: CommunicationRecordLocator;
  readonly deliveryId: string;
  readonly snapshotVersion: 1;
  readonly partId: string;
}
export type CommunicationSource = CommunicationNativeSource | CommunicationSavedPartSource;
/** 消息定位覆盖仍在 Inbox 的副本；不得要求已有 user/message seq。 */
export type CommunicationRecordLocator = {
  readonly kind: 'sender-prepared';
  readonly holder: CommunicationSessionIdentity;
  readonly eventSeq: number;
  readonly invocationSource: CommunicationInvocationSource;
} | {
  readonly kind: 'recipient-message';
  readonly holder: CommunicationSessionIdentity;
  readonly messageId: string;
};
export type CommunicationSpeaker = 'user' | 'assistant' | 'project-delivery' | 'system' | 'tool' | 'unknown';
/** 安全 producer 身份，不复制任意 source 对象中的提示或正文。 */
export interface CommunicationProducer {
  readonly kind: string;
  readonly projectId?: string;
  readonly deliveryId?: string;
  readonly senderSessionId?: string;
  readonly targetSessionId?: string;
  readonly sessionId?: string;
  readonly scheduleId?: string;
  readonly occurrenceId?: string;
  readonly goalId?: string;
  readonly revision?: number;
  readonly round?: number;
}
export interface CommunicationTextBlock {
  readonly type: 'text';
  readonly text: string;
}
/** 保留原生 attachment 全字段；禁止换成旧 NativeProjectAttachment 摘要。 */
export type CommunicationFileBlock = Readonly<FileBlock>;
export type CommunicationImageBlock = Readonly<ImageBlock>;
export type CommunicationPlainVisibleBlock = CommunicationTextBlock | CommunicationFileBlock | CommunicationImageBlock;
/** 作为引用数据保存，绝不能直接变成接收模型的 native tool-call。 */
export interface CommunicationQuotedToolCallBlock {
  readonly type: 'quoted-tool-call';
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: string;
}
export interface CommunicationQuotedToolResultBlock {
  readonly type: 'quoted-tool-result';
  readonly toolCallId: string;
  readonly messageId?: string;
  readonly isError: boolean;
  readonly error?: {
    readonly name?: string;
    readonly code?: string;
    readonly reason?: string;
  };
  readonly content: readonly CommunicationPlainVisibleBlock[];
}
export type CommunicationVisibleBlock = CommunicationPlainVisibleBlock | CommunicationQuotedToolCallBlock | CommunicationQuotedToolResultBlock;
/** 没有原生消息修订号时，仅声明这次读取的准确 cut 和内容身份。 */
export interface CommunicationPartVersion {
  readonly sessionCreatedAt: number;
  readonly prefixEventCount: number;
  readonly contentDigest: string;
}
/** 一个 part 对应一条完整原可见消息/调用/结果；blocks 保持原内部顺序。 */
export interface CommunicationPartV1 {
  readonly id: string;
  /** 同一个 tool 引用可产生 call/result 两个 part；按原 seq 顺序展开。 */
  readonly selectedBy: {
    readonly group: 'user-message' | 'context';
    readonly index: number;
  };
  readonly originalSpeaker: CommunicationSpeaker;
  readonly producer: CommunicationProducer;
  readonly origin: CommunicationNativeSource;
  readonly originEventSeq: number;
  readonly originTime: number;
  readonly acquiredFrom: CommunicationSource;
  readonly version: CommunicationPartVersion;
  readonly sourceChain: readonly CommunicationSource[];
  readonly blocks: readonly CommunicationVisibleBlock[];
}
export interface CommunicationReplyToV1 {
  readonly deliveryId: string;
  /** 证明本会话实际收到该通信，不只是在 metadata 找到一个 ID。 */
  readonly receivedAt: Extract<CommunicationRecordLocator, {
    readonly kind: 'recipient-message';
  }>;
  readonly sender: CommunicationEndpoint;
  readonly format: 'projects-communication/v1' | 'legacy';
}
/** nativeMessageId 不进入 snapshot，避免预创建 UserMessage 时产生自引用。 */
export interface CommunicationSnapshotV1 {
  readonly format: 'projects-communication/v1';
  readonly snapshotVersion: 1;
  readonly projectId: string;
  readonly deliveryId: string;
  readonly operationRef: string;
  readonly sender: CommunicationEndpoint;
  readonly recipient: CommunicationEndpoint;
  readonly createdAt: string;
  readonly replyTo?: CommunicationReplyToV1;
  /** 不 trim、不摘要；是否有实际内容与保存值分别处理。 */
  readonly agentMessage?: string;
  readonly userMessageParts: readonly CommunicationPartV1[];
  readonly contextParts: readonly CommunicationPartV1[];
}
/** 新 source 的必需字段；legacy 单独读取，不给旧记录补 snapshot。 */
export interface CommunicationMessageSourceV1 {
  readonly kind: 'project-delivery';
  readonly communicationFormat: 'projects-communication/v1';
  readonly projectId: string;
  readonly deliveryId: string;
  readonly operationRef: string;
  readonly senderSessionId: string;
  readonly senderHostSessionId: string;
  readonly targetSessionId: string;
  readonly targetHostSessionId: string;
  readonly snapshot: CommunicationSnapshotV1;
}
/** 旧来信只保留当时来源；不补造新版快照或操作身份。 */
export interface LegacyCommunicationMessageSource {
  readonly kind: 'project-delivery';
  readonly projectId: string;
  readonly deliveryId: string;
  readonly senderSessionId: string;
  readonly targetSessionId: string;
  readonly intent: 'assign' | 'change' | 'report' | 'question' | 'coordination' | 'continue';
}
/** 独立reader和browser都从纯合同取得同一来源声明。 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'project-delivery': LegacyCommunicationMessageSource | CommunicationMessageSourceV1;
  }
}
/**
 * 原生 attachment scanner 必须显式读取这些位置：
 * - prepared.snapshot.userMessageParts[*].blocks[*]
 * - prepared.snapshot.contextParts[*].blocks[*]
 * - project-delivery source.snapshot 中相同两处（Inbox 与聊天都适用）
 * - quoted-tool-result.content[*] 内的真实 file/image 块。
 * 顶层 file/image 直接使用原生 {type, attachment, offloaded?} 结构。
 * outcome 无正文；request/dispatch 仍按现有实际 content 引用扫描。
 */
export type CommunicationTranscriptEventProposal = {
  readonly format: 'projects-communication-event/v1';
  readonly phase: 'prepared';
  readonly invocationSource: CommunicationInvocationSource;
  readonly operationRef: string;
  /** native 仅承认 JSON 边界；Projects 冷读后校验为 SnapshotV1。 */
  readonly snapshot: JsonValue;
} | {
  readonly format: 'projects-communication-event/v1';
  readonly phase: 'outcome';
  readonly invocationSource: CommunicationInvocationSource;
  readonly operationRef: string;
  readonly outcome: JsonValue;
};
/** 快照codec仅核格式与内容身份；实际读取准入由来源owner负责。 */
export interface CommunicationSnapshotCodec {
  encode(snapshot: CommunicationSnapshotV1): JsonValue;
  decode(value: JsonValue): CommunicationSnapshotV1;
  /** identity digest 不授予权限，也不能用于恢复已删除正文。 */
  identity(snapshot: CommunicationSnapshotV1): string;
}
/** P3只保存精确来源和缺项，不承载正文、完整参数或任意错误details。 */
export type CommunicationSourceMissingCode = 'SOURCE_UNAVAILABLE' | 'MISSING_BLOCK' | 'UNSUPPORTED_BLOCK' | 'ATTACHMENT_UNAVAILABLE' | 'PARTIAL_RANGE';
export interface CommunicationSourceMissing {
  readonly code: CommunicationSourceMissingCode;
  readonly blockIndex?: number;
}
export interface CommunicationSourceFailure {
  readonly group: CommunicationPartV1['selectedBy']['group'];
  readonly index: number;
  readonly source: CommunicationSource;
  readonly missing: readonly CommunicationSourceMissing[];
}
export interface CommunicationFailure {
  readonly code: string;
  readonly message: string;
  readonly sourceFailures?: readonly CommunicationSourceFailure[];
}

export interface CommunicationVisibleRead {
  readonly source: CommunicationSource;
  readonly visibleComplete: boolean;
  readonly parts: readonly CommunicationPartV1[];
  readonly hiddenExcluded: readonly ('reasoning' | 'internal-instructions')[];
  readonly missingVisible: readonly CommunicationSourceMissing[];
}
export type CommunicationDeliveryMode = 'queued' | 'direct';
export interface CommunicationSendArgs {
  readonly delivery_mode?: CommunicationDeliveryMode;
  readonly target_session_id?: string;
  readonly reply_to_delivery_id?: string;
  readonly message?: string;
  readonly user_message_refs?: readonly CommunicationSource[];
  readonly context_refs?: readonly CommunicationSource[];
}

export type CommunicationInsertion = 'not-attempted' | 'not-inserted' | 'inserted' | 'unknown';
export type CommunicationPersistence = 'not-started' | 'flushed' | 'unavailable' | 'failed' | 'unknown';
export interface CommunicationTransportFacts {
  readonly insertion: CommunicationInsertion;
  readonly recipientPersistence: CommunicationPersistence;
  /** Saving the complete receiver copy and admitting it to Inbox are distinct barriers. */
  readonly admissionPersistence?: CommunicationPersistence;
  /** Observed original Inbox admission, not a promise of model consumption. */
  readonly admissionTarget?: 'next-turn' | 'next-step' | 'unknown';
  readonly wakeup: 'not-requested' | 'requested' | 'unknown';
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}
export type CommunicationOperationPhase = 'registered' | 'preparation-failed' | 'prepared' | 'attempted' | 'settled';

export interface CommunicationOperation {
  readonly format: 'projects-communication-operation/v1';
  readonly projectId: string;
  readonly operationRef: string;
  readonly invocationSource: CommunicationInvocationSource;
  readonly argumentsFormat: 'projects-communication-arguments/v1';
  readonly argumentsDigest: string;
  /** Omitted historical records requested the original queued mode. */
  readonly deliveryMode?: CommunicationDeliveryMode;
  readonly registeredAt: string;
  readonly updatedAt: string;
  readonly phase: CommunicationOperationPhase;
  readonly sender: CommunicationEndpoint;
  readonly deliveryId?: string;
  readonly recipient?: CommunicationEndpoint;
  readonly replyTo?: CommunicationReplyToV1;
  readonly nativeMessageId?: string;
  readonly snapshotDigest?: string;
  readonly senderRecord?: Extract<CommunicationRecordLocator, {
    kind: 'sender-prepared';
  }>;
  readonly recipientRecord?: Extract<CommunicationRecordLocator, {
    kind: 'recipient-message';
  }>;
  readonly senderPersistence: CommunicationPersistence;
  readonly attemptedAt?: string;
  readonly transport: CommunicationTransportFacts;
  readonly failure?: CommunicationFailure;
}
export interface CommunicationOperationCollection {
  readonly format: 'projects-communication-operations/v1';
  readonly operations: readonly CommunicationOperation[];
}
