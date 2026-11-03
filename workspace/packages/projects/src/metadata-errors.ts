/** Browser-safe metadata save effects; no filesystem, native addon or Node imports. */
import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'projects/metadata-write-failed': { readonly stage: DurableMutationStage; readonly effect: DurableMutationEffect }
    'projects/metadata-write-unconfirmed': { readonly stage: DurableMutationStage; readonly effect: DurableMutationEffect }
  }
}
export type DurableMutationEffect = 'none' | 'published-durability-unknown' | 'durable'
export type DurableMutationStage = 'write' | 'file-sync' | 'rename' | 'directory-sync' | 'remove' | 'source-publication'

/** A rejected publish is not necessarily a mutation with no effect. */
export class DurableMutationError extends Error {
  readonly isDSHRemoteError: true = true
  readonly details: { readonly stage: DurableMutationStage; readonly effect: DurableMutationEffect }
  readonly code: 'projects/metadata-write-failed' | 'projects/metadata-write-unconfirmed'
  constructor(readonly stage: DurableMutationStage, readonly effect: DurableMutationEffect, cause: unknown) {
    super((effect === 'none' ? `元数据保存失败（${stage}），本次未提交。`
      : effect === 'durable' ? `元数据已保存，但后续来源发布未确认（${stage}）；请核对，勿直接重做。`
      : `元数据保存结果未确认（${stage}），内容可能已更新；请核对当前内容，勿直接重做。`) + (cause instanceof Error ? ` ${cause.message}` : ''), { cause })
    this.name = 'DurableMutationError'
    this.details = { stage, effect }
    this.code = effect === 'none' ? 'projects/metadata-write-failed' : 'projects/metadata-write-unconfirmed'
  }
}

/** Structural decoding also works across Remote/tool error serialization. */
export function durableMutationDetails(error: unknown): { code: string; stage: DurableMutationStage; effect: DurableMutationEffect; message: string } | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const value = error as Partial<DurableMutationError>
  const stage = value.stage ?? value.details?.stage
  const effect = value.effect ?? value.details?.effect
  if ((value.code !== 'projects/metadata-write-failed' && value.code !== 'projects/metadata-write-unconfirmed')
    || !['none', 'published-durability-unknown', 'durable'].includes(String(effect))
    || !['write', 'file-sync', 'rename', 'directory-sync', 'remove', 'source-publication'].includes(String(stage))) return undefined
  return { code: value.code, stage: stage!, effect: effect!, message: String(value.message ?? value.code) }
}
