/** Slash popup projection of upstream ui-permission-presets/index.ts. */
import type { PermissionCatalog } from '@deepseek-ai/dsh-permission-presets/client'
import type { SelectOption } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { PERMISSION_ACCESS_NS } from './locales.ts'
import { AUTO_REVIEW_PRESET, displayPermissionPreset, FULL_ACCESS_PRESET } from './presentation.ts'

export function permissionOptions(catalog: PermissionCatalog, currentValue: string, t: TranslateNS<typeof PERMISSION_ACCESS_NS>): SelectOption[] {
  return catalog.options.map(option => ({
    id: option.value,
    label: option.value === AUTO_REVIEW_PRESET ? t('auto.label') : displayPermissionPreset(option.value, option.name, t),
    ...(option.value === AUTO_REVIEW_PRESET ? { badge: t('auto.badge'), detail: t('auto.description') } : option.description === undefined ? {} : { detail: option.description }),
    ...(option.value === currentValue ? { active: true } : {}),
    ...(option.value === FULL_ACCESS_PRESET || option.value === AUTO_REVIEW_PRESET ? {
      confirmation: {
        title: t(option.value === AUTO_REVIEW_PRESET ? 'auto.confirm.title' : 'confirm.title'),
        description: t(option.value === AUTO_REVIEW_PRESET ? 'auto.confirm.description' : 'confirm.description'),
        acknowledgeLabel: t(option.value === AUTO_REVIEW_PRESET ? 'auto.confirm.acknowledge' : 'confirm.acknowledge'),
        cancelLabel: t('confirm.cancel'),
        confirmLabel: t(option.value === AUTO_REVIEW_PRESET ? 'auto.confirm.enable' : 'confirm.enable'),
      },
    } : {}),
  }))
}
