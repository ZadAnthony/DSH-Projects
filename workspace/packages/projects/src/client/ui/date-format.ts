import type { ProjectsTranslate } from './copy.ts'

export interface UiDateOptions {
  /** Include the time (hours and minutes). Defaults to true. */
  readonly time?: boolean
  /** Include seconds when time is shown. */
  readonly seconds?: boolean
  /** Show only the date, even when time or seconds is requested. */
  readonly dateOnly?: boolean
  /** Preserve a caller's time-zone basis, such as UTC for usage-day attribution. */
  readonly timeZone?: string
}

/** Format an actual timestamp with the Projects UI language, retaining the caller's time zone. */
export function formatUiDate(
  value: string | number | Date | null | undefined,
  translate: ProjectsTranslate,
  options: UiDateOptions = {},
): string {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return translate('p5.common.unknown')
  }
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return translate('p5.common.unknown')

  const showTime = options.dateOnly !== true && options.time !== false
  try {
    return new Intl.DateTimeFormat(translate('experience.dateLocale'), {
      dateStyle: 'medium',
      ...(showTime ? { timeStyle: options.seconds === true ? 'medium' : 'short' } as const : {}),
      ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    }).format(date)
  } catch {
    // An invalid locale/time zone cannot truthfully produce a date for this UI.
    return translate('p5.common.unknown')
  }
}
