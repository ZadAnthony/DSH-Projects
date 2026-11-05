export type DurationUnit = 'seconds' | 'minutes' | 'hours' | 'days'

export interface DurationDraft {
  readonly amount: string
  readonly unit: DurationUnit
}

const unitSeconds: Record<DurationUnit, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86400 }

/** Existing integer seconds always open without changing their duration or precision. */
export function draftForDuration(seconds: number): DurationDraft {
  const unit = (['days', 'hours', 'minutes'] as const).find(unit => seconds % unitSeconds[unit] === 0) ?? 'seconds'
  return { amount: String(seconds / unitSeconds[unit]), unit }
}

/** Convert decimal/scientific input exactly; never round a fractional or unsafe second. */
export function secondsForDuration({ amount, unit }: DurationDraft): number | undefined {
  const match = /^\+?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(amount.trim())
  if (match === null) return undefined
  const fraction = match[2] ?? ''
  const digits = (match[1]! + fraction).replace(/^0+/, '')
  if (digits === '') return undefined
  const significant = digits.replace(/0+$/, '')
  const scale = Number(match[3] ?? 0) - fraction.length + digits.length - significant.length
  // These bounds also keep arbitrary form text from allocating an unbounded BigInt.
  // A day contains 2^7, so an exact integer-second amount can need seven decimal places.
  if (!Number.isSafeInteger(scale) || scale < -7 || scale > 16 || significant.length + scale > 16) return undefined
  const numerator = BigInt(significant) * BigInt(unitSeconds[unit])
  const divisor = scale < 0 ? 10n ** BigInt(-scale) : 1n
  const seconds = scale < 0 ? numerator / divisor : numerator * 10n ** BigInt(scale)
  if (numerator % divisor !== 0n || seconds < 1n || seconds > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
  return Number(seconds)
}
