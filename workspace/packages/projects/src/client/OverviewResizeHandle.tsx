import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

export interface OverviewResizeHandleProps {
  readonly width: number
  readonly min: number
  readonly max: number
  readonly onResize: (width: number) => void
  readonly label: string
  readonly controls?: string
  readonly formatValue?: (width: number) => string
  readonly disabled?: boolean
}

interface Drag {
  readonly pointerId: number
  readonly startX: number
  readonly startWidth: number
  readonly target: HTMLDivElement
}

const keyboardStep = 16
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** 右侧概览的物理分隔线；布局、有效边界和宽度保存由调用方负责。 */
export function OverviewResizeHandle({ width, min, max, onResize, label, controls, formatValue, disabled = false }: OverviewResizeHandleProps): ReactNode {
  const drag = useRef<Drag | null>(null)
  const [dragging, setDragging] = useState(false)
  const enabled = !disabled && max > min
  const value = clamp(width, min, max)

  const endDrag = useCallback((pointerId?: number, updateState = true) => {
    const active = drag.current
    if (!active || (pointerId !== undefined && pointerId !== active.pointerId)) return
    drag.current = null
    if (active.target.hasPointerCapture(active.pointerId)) active.target.releasePointerCapture(active.pointerId)
    if (updateState) setDragging(false)
  }, [])

  useEffect(() => { if (!enabled) endDrag() }, [enabled, endDrag])
  useEffect(() => () => endDrag(undefined, false), [endDrag])

  return <div className="dsh-projects__overview-resizer" data-dragging={dragging ? 'true' : 'false'}
    role="separator" aria-orientation="vertical" aria-label={label} aria-controls={controls}
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={formatValue?.(value)}
    aria-disabled={!enabled || undefined} tabIndex={enabled ? 0 : -1}
    onPointerDown={event => {
      if (!enabled || drag.current || event.button !== 0 || !event.isPrimary) return
      event.preventDefault()
      event.currentTarget.focus({ preventScroll: true })
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: value, target: event.currentTarget }
      setDragging(true)
    }}
    onPointerMove={event => {
      const active = drag.current
      if (!enabled || !active || event.pointerId !== active.pointerId) return
      event.preventDefault()
      const next = clamp(active.startWidth + active.startX - event.clientX, min, max)
      if (next !== value) onResize(next)
    }}
    onPointerUp={event => endDrag(event.pointerId)}
    onPointerCancel={event => endDrag(event.pointerId)}
    onLostPointerCapture={event => endDrag(event.pointerId)}
    onKeyDown={event => {
      if (!enabled) return
      let next: number
      switch (event.key) {
        case 'ArrowLeft': next = value + keyboardStep; break
        case 'ArrowRight': next = value - keyboardStep; break
        case 'Home': next = min; break
        case 'End': next = max; break
        default: return
      }
      event.preventDefault()
      next = clamp(next, min, max)
      if (next !== value) onResize(next)
    }} />
}
