import { createRequire } from 'node:module'
import { z } from 'zod'
import type { SchedulePowerFact, SchedulePowerFacts } from './power-facts.ts'

const uint = z.string().regex(/^\d+$/)
const clockSchema = z.object({
  absoluteTicks: uint, continuousTicks: uint, wallSeconds: uint,
  wallMicroseconds: z.number().int().min(0).max(999999), wallRc: z.literal(0), wallErrno: z.literal(0),
})
const fieldSchema = z.object({
  oid: z.string(), domain: z.enum(['kernel-calendar-timeval', 'mach-absolute-ticks']),
  expectedBytes: z.number().int(), queriedBytes: z.number().int(), returnedBytes: z.number().int(),
  queryRc: z.number().int(), queryErrno: z.number().int(), readRc: z.number().int(), readErrno: z.number().int(),
  readAttempted: z.boolean(), decoded: z.boolean(), bytesHex: z.string().regex(/^[a-f0-9]+$/).optional(),
  seconds: uint.optional(), microseconds: z.number().int().min(0).max(999999).optional(), ticks: uint.optional(),
})
const rawSchema = z.object({
  version: z.literal(1), source: z.literal('darwin-sysctl-mach'), byteOrder: z.literal('LE'),
  pointerBytes: z.literal(8), timevalBytes: z.literal(16), timevalSecondsBytes: z.literal(8), timevalMicrosecondsBytes: z.literal(4),
  timebaseRc: z.literal(0), timebaseNumer: z.number().int().positive(), timebaseDenom: z.number().int().positive(),
  before: clockSchema, after: clockSchema,
  epochBefore: fieldSchema, epochAfter: fieldSchema,
  fields: z.object({ sleep: fieldSchema, wake: fieldSchema, sleepAbsolute: fieldSchema, wakeAbsolute: fieldSchema, boot: fieldSchema }),
})
export type DarwinRawSample = z.infer<typeof rawSchema>
export type DarwinClock = z.infer<typeof clockSchema>
export interface DarwinPowerHint {
  kind: 'will-sleep' | 'did-wake'
  source: 'nsworkspace' | 'controlled-native-thread'
  sequence: string
  nativeThread: string
  nodeThread: string
  /** Native 收件时刻；不代表 sleep/wake 的发生时刻。 */
  receipt: DarwinClock
}
export interface DarwinSubscriptionStatus {
  backend: 'nsworkspace' | 'controlled'
  closed: boolean
  subscribed: boolean
  finalized: boolean
  sequence: string
  delivered: string
  dropped: string
  deliveryStatus: number
  error: string
}
export interface DarwinNativeSubscription {
  close(): void
  status(): DarwinSubscriptionStatus
  emitControlled(kind: DarwinPowerHint['kind']): void
}
interface DarwinBinding {
  apiVersion: 1
  napiVersion: number
  buildKind: 'native' | 'controlled-test'
  readRawSync(): unknown
  subscribe(backend: 'nsworkspace' | 'controlled', callback: (hint: DarwinPowerHint) => void): DarwinNativeSubscription
}
export type DarwinRawRead =
  | { kind: 'sample'; observedAt: string; sample: DarwinRawSample; kernelMarker: string }
  | { kind: 'unknown'; reason: string; fault?: 'clock-domain' | 'mixed-epoch'; raw?: unknown }

const fieldDefinitions = {
  sleep: ['kern.sleeptime', 16, 'kernel-calendar-timeval'],
  wake: ['kern.waketime', 16, 'kernel-calendar-timeval'],
  sleepAbsolute: ['kern.sleep_abs_time', 8, 'mach-absolute-ticks'],
  wakeAbsolute: ['kern.wake_abs_time', 8, 'mach-absolute-ticks'],
  boot: ['kern.boottime', 16, 'kernel-calendar-timeval'],
} as const
function wallMicros(clock: DarwinClock): bigint {
  return BigInt(clock.wallSeconds) * 1000000n + BigInt(clock.wallMicroseconds)
}
function fieldMicros(field: z.infer<typeof fieldSchema>): bigint {
  return BigInt(field.seconds!) * 1000000n + BigInt(field.microseconds!)
}

/** 只核 raw 格式、失败与同域矛盾；通过不等于已获得完整 Host 恢复事实。 */
export function inspectDarwinRawSample(raw: unknown): DarwinRawRead {
  const parsed = rawSchema.safeParse(raw)
  if (!parsed.success) return { kind: 'unknown', reason: 'Darwin 原始事实格式或本机布局不相容。', raw }
  const sample = parsed.data
  const definitions = Object.entries(fieldDefinitions).map(([name, definition]) => ({ field: sample.fields[name as keyof typeof fieldDefinitions], definition }))
  definitions.push({ field: sample.epochBefore, definition: fieldDefinitions.sleepAbsolute }, { field: sample.epochAfter, definition: fieldDefinitions.sleepAbsolute })
  for (const { field, definition } of definitions) {
    const [oid, bytes, domain] = definition
    if (field.oid !== oid || field.domain !== domain || field.expectedBytes !== bytes ||
      field.queryRc !== 0 || field.queryErrno !== 0 || !field.readAttempted || field.readRc !== 0 || field.readErrno !== 0 ||
      field.queriedBytes !== bytes || field.returnedBytes !== bytes || !field.decoded || field.bytesHex?.length !== bytes * 2) {
      return { kind: 'unknown', reason: `Darwin 字段 ${oid} 读取失败或尺寸不相容。`, raw }
    }
    const buffer = Buffer.from(field.bytesHex, 'hex')
    if (domain === 'kernel-calendar-timeval') {
      if (field.seconds === undefined || field.microseconds === undefined ||
        buffer.readBigInt64LE(0) !== BigInt(field.seconds) || buffer.readInt32LE(8) !== field.microseconds) {
        return { kind: 'unknown', reason: `Darwin 字段 ${oid} 的解码与原始字节矛盾。`, raw }
      }
    } else if (field.ticks === undefined || buffer.readBigUInt64LE(0) !== BigInt(field.ticks)) {
      return { kind: 'unknown', reason: `Darwin 字段 ${oid} 的时钟域或解码矛盾。`, raw }
    }
  }
  const { before, after, fields } = sample
  const sleep = BigInt(fields.sleepAbsolute.ticks!), wake = BigInt(fields.wakeAbsolute.ticks!)
  const wakeWall = fieldMicros(fields.wake)
  const zeroMarkers = sleep === 0n && wake === 0n && wakeWall === 0n && fieldMicros(fields.sleep) === 0n
  if (sample.epochBefore.ticks !== fields.sleepAbsolute.ticks || sample.epochAfter.ticks !== fields.sleepAbsolute.ticks) {
    return { kind: 'unknown', reason: 'Darwin 睡眠 marker 在本次顺序采样中变化。', fault: 'mixed-epoch', raw }
  }
  if (BigInt(after.absoluteTicks) < BigInt(before.absoluteTicks) || BigInt(after.continuousTicks) < BigInt(before.continuousTicks) ||
    BigInt(before.continuousTicks) < BigInt(before.absoluteTicks) || BigInt(after.continuousTicks) < BigInt(after.absoluteTicks) ||
    wallMicros(after) < wallMicros(before) ||
    wake > BigInt(after.absoluteTicks) || fieldMicros(fields.boot) > wallMicros(after)) {
    return { kind: 'unknown', reason: 'Darwin 样本存在时钟倒序或未来边界。', fault: 'clock-domain', raw }
  }
  if (!zeroMarkers && (sleep === 0n || wake === 0n || wakeWall === 0n || wake < sleep)) {
    return { kind: 'unknown', reason: 'Darwin sleep/wake marker 尚未组成完整样本。', fault: 'mixed-epoch', raw }
  }
  const epochMs = wallMicros(after) / 1000n
  if (epochMs > 8640000000000000n) return { kind: 'unknown', reason: 'Darwin 观测时间超出 UTC 日期范围。', raw }
  return {
    kind: 'sample', observedAt: new Date(Number(epochMs)).toISOString(), sample,
    kernelMarker: [fields.sleepAbsolute.ticks, fields.wakeAbsolute.ticks, fields.wake.seconds, fields.wake.microseconds,
      fields.boot.seconds, fields.boot.microseconds].join(':'),
  }
}

export interface DarwinSchedulePowerFacts extends SchedulePowerFacts {
  readRawSync(): DarwinRawRead
  /** 相同 marker 只是连续性候选；未收到通知也不是无恢复的证明。 */
  continuity(): 'no-baseline' | 'markers-unchanged' | 'markers-changed' | 'unknown' | 'closed'
  subscriptionStatus(): DarwinSubscriptionStatus | undefined
}
export interface DarwinPowerOptions {
  /** 必须由装包者指向本包正常构建的 .node；不搜索旧 /tmp 二进制。 */
  bindingPath: string
  /** 显式订阅；默认仅同步读取，不注册任何系统通知。 */
  subscribe?: boolean
  onHint?: (hint: DarwinPowerHint) => void
}

function epochKey(sample: DarwinRawSample): string {
  return `${sample.fields.sleepAbsolute.ticks}:${sample.fields.wakeAbsolute.ticks}`
}
function bootKey(sample: DarwinRawSample): string {
  return `${sample.fields.boot.seconds}:${sample.fields.boot.microseconds}`
}
function utcMillis(microseconds: bigint, roundUp = false): string {
  const millis = roundUp ? (microseconds + 999n) / 1000n : microseconds / 1000n
  return new Date(Number(millis)).toISOString()
}
function sleepOffsetBounds(sample: DarwinRawSample): [bigint, bigint] {
  const continuous = BigInt(sample.before.continuousTicks)
  return [continuous - BigInt(sample.after.absoluteTicks), continuous - BigInt(sample.before.absoluteTicks)]
}

/** kernel epoch 的事实解释；不接触 plannedAt、投递或 occurrence policy。 */
export class DarwinPowerFactTracker {
  #baseline?: DarwinRawSample
  #baselineAt?: string
  #last?: DarwinRawSample
  #epoch = 0
  #baselineEpoch = 0
  #window?: { lowerBound: string; upperBound: string }
  #invalidated?: string
  #candidate?: Extract<DarwinRawRead, { kind: 'sample' }>
  #readyCandidate?: Extract<DarwinRawRead, { kind: 'sample' }>

  observe(read: DarwinRawRead, allowBaseline = true): SchedulePowerFact {
    if (read.kind === 'unknown') {
      if (this.#baseline && read.fault === 'clock-domain') this.#invalidated = read.reason
      this.#candidate = this.#readyCandidate = undefined
      return { kind: 'unknown', reason: read.reason }
    }
    const sample = read.sample
    if (this.#invalidated) {
      if (this.#readyCandidate === read && allowBaseline || this.#candidate !== undefined && this.#candidate !== read
        && currentSegmentPair(this.#candidate.sample, sample)) {
        if (allowBaseline && this.#epoch < Number.MAX_SAFE_INTEGER) {
          this.#epoch++; this.#baselineEpoch = this.#epoch
          this.#baseline = this.#last = structuredClone(sample); this.#baselineAt = read.observedAt
          this.#window = undefined; this.#invalidated = undefined
          this.#candidate = this.#readyCandidate = undefined
          return this.known(read.observedAt)
        }
        this.#readyCandidate = read
      } else if (this.#candidate !== read) {
        this.#candidate = read; this.#readyCandidate = undefined
      }
      return { kind: 'unknown', observedAt: read.observedAt, reason: this.#invalidated! }
    }
    if (!this.#baseline) {
      if (!allowBaseline) return { kind: 'unknown', reason: 'Darwin 尚未在真实 appReady 后建立业务基线。' }
      // 只有真正 appReady 后的首次业务 read 才能进入；构造与 raw read 都不建此基线。
      this.#baseline = this.#last = structuredClone(sample)
      this.#baselineAt = read.observedAt
    } else {
      const last = this.#last!
      const domainChanged = bootKey(sample) !== bootKey(this.#baseline) || sample.timebaseNumer !== this.#baseline.timebaseNumer ||
        sample.timebaseDenom !== this.#baseline.timebaseDenom || BigInt(sample.after.absoluteTicks) < BigInt(last.after.absoluteTicks) ||
        BigInt(sample.after.continuousTicks) < BigInt(last.after.continuousTicks) || wallMicros(sample.after) < wallMicros(last.after)
      if (domainChanged) {
        this.#invalidated = 'Darwin boot 或时钟域在业务基线之后变化，原恢复排序不能继续使用。'
        this.#candidate = read
        return { kind: 'unknown', observedAt: read.observedAt, reason: this.#invalidated }
      }
      const sameEpoch = epochKey(sample) === epochKey(last)
      if (sameEpoch) {
        const [lastLower, lastUpper] = sleepOffsetBounds(last), [lower, upper] = sleepOffsetBounds(sample)
        if (fieldMicros(sample.fields.wake) !== fieldMicros(last.fields.wake) || lower > lastUpper || upper < lastLower) {
          this.#invalidated = 'Darwin 同一 kernel epoch 的 calendar 或时钟域相互矛盾。'
          this.#candidate = read
          return { kind: 'unknown', observedAt: read.observedAt, reason: this.#invalidated }
        }
        // 偏移区间重叠本身不证明无 sleep；连续性依据是已选定的 kernel epoch 合同。
      } else {
        if (BigInt(sample.fields.sleepAbsolute.ticks!) <= BigInt(last.fields.sleepAbsolute.ticks!) ||
          BigInt(sample.fields.wakeAbsolute.ticks!) < BigInt(last.fields.wakeAbsolute.ticks!)) {
          return { kind: 'unknown', observedAt: read.observedAt, reason: 'Darwin kernel epoch 变化尚不能组成新的完整 sleep/wake 样本。' }
        }
        if (this.#epoch === Number.MAX_SAFE_INTEGER) {
          this.#invalidated = 'Darwin 本进程 epoch 超出安全整数范围。'
          return { kind: 'unknown', observedAt: read.observedAt, reason: this.#invalidated }
        }
        this.#epoch++
        this.#window = {
          lowerBound: utcMillis(wallMicros(last.after)),
          upperBound: utcMillis(wallMicros(sample.after), true),
        }
      }
      this.#last = structuredClone(sample)
    }
    return this.known(read.observedAt)
  }

  private known(observedAt: string): SchedulePowerFact {
    return { kind: 'known', observedAt, available: true, provenance: 'darwin-kernel', epoch: this.#epoch,
      baselineEpoch: this.#baselineEpoch, baselineAt: this.#baselineAt!, ...(this.#window ? { recoveryWindow: { ...this.#window } } : {}) }
  }

  continuity(read: DarwinRawRead): 'no-baseline' | 'markers-unchanged' | 'markers-changed' | 'unknown' {
    if (!this.#baseline) return 'no-baseline'
    if (read.kind !== 'sample' || this.#invalidated) return 'unknown'
    return epochKey(read.sample) === epochKey(this.#baseline) ? 'markers-unchanged' : 'markers-changed'
  }
}

/** 两个独立的有效顺序样本只证明该当前段；旧wake calendar不与新wall强比。 */
function currentSegmentPair(before: DarwinRawSample, after: DarwinRawSample): boolean {
  if (bootKey(before) !== bootKey(after) || before.timebaseNumer !== after.timebaseNumer || before.timebaseDenom !== after.timebaseDenom
    || epochKey(before) !== epochKey(after) || fieldMicros(before.fields.wake) !== fieldMicros(after.fields.wake)
    || BigInt(before.after.absoluteTicks) > BigInt(after.before.absoluteTicks)
    || BigInt(before.after.continuousTicks) > BigInt(after.before.continuousTicks)
    || wallMicros(before.after) > wallMicros(after.before)) return false
  const [oldLower, oldUpper] = sleepOffsetBounds(before), [lower, upper] = sleepOffsetBounds(after)
  return lower <= oldUpper && upper >= oldLower
}

export function createDarwinSchedulePowerFacts(options: DarwinPowerOptions): DarwinSchedulePowerFacts {
  let binding: DarwinBinding | undefined, loadError: string | undefined, closed = false
  let subscription: DarwinNativeSubscription | undefined
  const tracker = new DarwinPowerFactTracker()
  try {
    if (process.platform !== 'darwin') throw new Error('当前平台不是 macOS。')
    const candidate: unknown = createRequire(import.meta.url)(options.bindingPath)
    if (!candidate || typeof candidate !== 'object') throw new Error('原生模块导出缺失。')
    const value = candidate as Partial<DarwinBinding>
    if (value.apiVersion !== 1 || value.buildKind !== 'native' || typeof value.readRawSync !== 'function' || typeof value.subscribe !== 'function') {
      throw new Error('原生模块合同不相容或是受控测试构建。')
    }
    binding = value as DarwinBinding
  } catch (error) { loadError = error instanceof Error ? error.message : String(error) }
  function readRawSync(): DarwinRawRead {
    if (closed) return { kind: 'unknown', reason: 'Darwin 事实来源已关闭。' }
    if (!binding) return { kind: 'unknown', reason: `Darwin 原生模块未加载：${loadError}` }
    let result: DarwinRawRead
    try { result = inspectDarwinRawSample(binding.readRawSync()) }
    catch (error) { result = { kind: 'unknown', reason: `Darwin 原始读取失败：${error instanceof Error ? error.message : String(error)}` } }
    // raw 诊断不提前建基线；已有基线后也不能漏掉诊断读中实际观察到的域变化。
    tracker.observe(result, false)
    return result
  }
  if (binding && options.subscribe) {
    try {
      subscription = binding.subscribe('nsworkspace', (hint) => {
        if (!closed && hint.source === 'nsworkspace') options.onHint?.(hint)
      })
    } catch (error) { loadError = `被动通知未订阅：${error instanceof Error ? error.message : String(error)}` }
  }
  return {
    readRawSync,
    readSync(): SchedulePowerFact {
      if (loadError && binding) return { kind: 'unknown', reason: loadError }
      return tracker.observe(readRawSync())
    },
    continuity() {
      if (closed) return 'closed'
      return tracker.continuity(readRawSync())
    },
    subscriptionStatus: () => subscription?.status(),
    dispose() { if (!closed) { closed = true; subscription?.close() } },
  }
}
