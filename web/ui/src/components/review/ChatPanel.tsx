import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'

import { usePersistentState } from '@/hooks/usePersistentState'
import { CHAT_MIN_W, clampChatWidth, defaultChatWidth } from '@/lib/chatWidth'
import { cn } from '@/lib/utils'

const KEY_STEP = 16

const parseWidth = (r: string) => {
  const n = Number(r)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/**
 * The session's chat beside the diff: drag its left edge (or ←/→ on it) to resize, double-click
 * to reset. The width is remembered (`fleet.reviewChatWidth`; 0 = the default).
 */
export function ChatPanel({ children }: { children: ReactNode }) {
  const [pref, setPref] = usePersistentState<number>('fleet.reviewChatWidth', 0, parseWidth)
  const ref = useRef<HTMLElement>(null)
  const drag = useRef<{ x: number; w: number; room: number } | null>(null)
  // The row it shares with the diff, kept current (a narrower window narrows a wide chat).
  const [room, setRoom] = useState(() => window.innerWidth)
  useEffect(() => {
    const row = ref.current?.parentElement
    if (!row || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => entry && entry.contentRect.width > 0 && setRoom(entry.contentRect.width))
    ro.observe(row)
    return () => ro.disconnect()
  }, [])
  const width = pref ? clampChatWidth(pref, room) : defaultChatWidth(window.innerWidth)

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, w: width, room }
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    // The handle is on the left edge: dragging left widens the chat.
    setPref(clampChatWidth(d.w + d.x - e.clientX, d.room))
  }
  const onUp = () => {
    drag.current = null
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const step = e.shiftKey ? KEY_STEP * 4 : KEY_STEP
    setPref(clampChatWidth(width + (e.key === 'ArrowLeft' ? step : -step), room))
  }

  return (
    <aside ref={ref} aria-label="Session" className="relative flex shrink-0 border-l" style={{ width }}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize session panel"
        aria-valuemin={CHAT_MIN_W}
        aria-valuenow={width}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={() => setPref(0)}
        onKeyDown={onKey}
        className={cn(
          'group/grip absolute inset-y-0 -left-1 z-30 w-2 cursor-col-resize touch-none outline-none',
          'after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:transition-colors',
          'hover:after:w-0.5 hover:after:bg-primary/50 focus-visible:after:w-0.5 focus-visible:after:bg-ring',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'absolute top-1/2 left-1/2 h-10 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full border bg-background opacity-0 shadow-sm transition-opacity',
            'group-hover/grip:opacity-100 group-focus-visible/grip:opacity-100',
          )}
        />
      </div>
      {children}
    </aside>
  )
}
