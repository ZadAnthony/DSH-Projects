import { projectCopy, type ProjectsTranslate } from './ui/copy.ts'
import React, { type ReactNode } from 'react'
import { Button, IconRefreshOutlineRegular } from './ui/index.ts'

export interface RefreshButtonProps {
  readonly onClick: () => void
  readonly loading?: boolean
  readonly disabled?: boolean
  readonly label?: string
  readonly ariaLabel?: string
  readonly translate?: ProjectsTranslate
}

/** 同类读取操作共用紧凑外观，具体读取范围由调用方命名。 */
export function RefreshButton({ onClick, loading = false, disabled = false, translate, label = projectCopy(translate)("p5.common.refresh"), ariaLabel }: RefreshButtonProps): ReactNode {
  return <Button variant="outline" size="sm" type="button"
    icon={<IconRefreshOutlineRegular size={16} />} disabled={disabled || loading} aria-busy={loading}
    aria-label={ariaLabel ?? label} onClick={onClick}>{label}</Button>
}
