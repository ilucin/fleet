import { useEffect, useRef, type RefObject } from 'react'

import { swipeAxis, swipeBackBlocked, swipeBackIntent, type SwipeNode } from '@/lib/gestures'

/** Outside the installed PWA, touches this close to the left edge belong to the browser's own back swipe. */
const EDGE_PX = 20
const SNAP = 'transform 180ms ease-out, opacity 180ms ease-out'
const OUT_MS = 120

const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true

const hasSelection = () => {
  const sel = window.getSelection()
  return !!sel && !sel.isCollapsed
}

/**
 * Mobile: swipe right on `ref` → `onBack()`. The element follows the finger (translateX + fade)
 * once the gesture is clearly horizontal and snaps back when cancelled. Native listeners, so
 * portaled sheets / dialogs never reach it; see swipeBackBlocked() for what else is left alone.
 */
export function useSwipeBack(ref: RefObject<HTMLElement | null>, onBack: () => void, enabled: boolean) {
  const cb = useRef(onBack)
  useEffect(() => {
    cb.current = onBack
  }, [onBack])

  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    let start: { x: number; y: number; t: number } | null = null
    let axis: 'back' | 'other' | null = null
    let timer: ReturnType<typeof setTimeout> | undefined

    const style = (transform: string, opacity: string, transition: string) => {
      el.style.transition = transition
      el.style.transform = transform
      el.style.opacity = opacity
    }
    const snapBack = () => {
      style('', '', SNAP)
      clearTimeout(timer)
      timer = setTimeout(() => (el.style.transition = ''), 200)
    }

    const onStart = (e: TouchEvent) => {
      start = null
      axis = null
      if (e.touches.length !== 1) return
      const t = e.touches[0]
      if (t.clientX < EDGE_PX && !isStandalone()) return
      if (hasSelection()) return
      const target = e.target instanceof Element ? e.target : null
      const overflowX = (n: SwipeNode) => getComputedStyle(n as unknown as Element).overflowX
      if (swipeBackBlocked(target as SwipeNode | null, el as unknown as SwipeNode, overflowX)) return
      start = { x: t.clientX, y: t.clientY, t: e.timeStamp }
    }
    const onMove = (e: TouchEvent) => {
      if (!start) return
      if (e.touches.length !== 1) {
        start = null
        if (axis === 'back') snapBack()
        return
      }
      const t = e.touches[0]
      const dx = t.clientX - start.x
      const dy = t.clientY - start.y
      if (axis == null) {
        axis = swipeAxis(dx, dy)
        if (axis !== 'back') {
          if (axis === 'other') start = null
          return
        }
      }
      if (e.cancelable) e.preventDefault() // no vertical scrolling while the screen follows the finger
      const shift = Math.max(0, dx) * 0.6
      style(`translateX(${shift}px)`, String(1 - Math.min(0.4, shift / (el.clientWidth || 1))), 'none')
    }
    const onEnd = (e: TouchEvent) => {
      const s = start
      const followed = axis === 'back'
      start = null
      axis = null
      if (!s || !followed) return
      const t = e.changedTouches[0]
      if (!hasSelection() && swipeBackIntent(t.clientX - s.x, t.clientY - s.y, e.timeStamp - s.t)) {
        style(`translateX(${el.clientWidth}px)`, '0', `transform ${OUT_MS}ms ease-out, opacity ${OUT_MS}ms ease-out`)
        clearTimeout(timer)
        timer = setTimeout(() => {
          cb.current()
          // Still mounted a moment later (nowhere to go back to): show the screen again.
          timer = setTimeout(() => style('', '', ''), 600)
        }, OUT_MS)
      } else snapBack()
    }
    const onCancel = () => {
      if (start && axis === 'back') snapBack()
      start = null
      axis = null
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onCancel)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onCancel)
      clearTimeout(timer)
      style('', '', '')
    }
  }, [ref, enabled])
}
