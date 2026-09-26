import { useRef, type MouseEvent, type PointerEvent } from 'react'

import { LONG_PRESS_MS } from '@/lib/title'

const SLOP_PX = 10

/**
 * Touch long-press on an element that is also a link: rest a finger for `ms`, lift, and
 * `onLongPress` runs (inside the pointerup, a user gesture — so an input it focuses gets
 * the on-screen keyboard on iOS). The click that follows is swallowed, so the row does
 * not also open. Mouse and pen are ignored: desktop has the pencil and the shortcut.
 */
export function useLongPress(onLongPress: () => void, ms = LONG_PRESS_MS) {
  const start = useRef<{ x: number; y: number; at: number } | null>(null)
  const swallowClick = useRef(false)

  return {
    onPointerDown(e: PointerEvent) {
      swallowClick.current = false
      start.current = e.pointerType === 'touch' ? { x: e.clientX, y: e.clientY, at: Date.now() } : null
    },
    onPointerMove(e: PointerEvent) {
      const s = start.current
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > SLOP_PX) start.current = null
    },
    onPointerUp() {
      const s = start.current
      start.current = null
      if (s && Date.now() - s.at >= ms) {
        swallowClick.current = true
        onLongPress()
      }
    },
    onPointerCancel() {
      start.current = null
    },
    onClickCapture(e: MouseEvent) {
      if (!swallowClick.current) return
      swallowClick.current = false
      e.preventDefault()
      e.stopPropagation()
    },
    onContextMenu(e: MouseEvent) {
      // Android fires this on a long press (and would open the link's menu): it is ours.
      if (!start.current) return
      e.preventDefault()
      start.current = null
      swallowClick.current = true
      onLongPress()
    },
  }
}
