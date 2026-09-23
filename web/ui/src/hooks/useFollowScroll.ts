import { useCallback, useEffect, useRef, useState } from 'react'

import { nearBottom } from '@/lib/chat'

/**
 * "Follow the tail" for a scroll container (chat / terminal), as in the classic UI:
 * - following → every content change (call `stick()` from a layout effect) and every
 *   resize of the scroller (keyboard, composer growing, font size) keeps it at the bottom;
 * - scrolling more than `slack` px up stops following (show a "↓ latest" button);
 *   scrolling back down resumes.
 * Programmatic scrolls are remembered and their scroll events ignored, so a re-render
 * that momentarily clamps scrollTop is never mistaken for the user moving.
 */
export function useFollowScroll<T extends HTMLElement>(slack: number) {
  const ref = useRef<T>(null)
  const followRef = useRef(true)
  const [following, setFollowing] = useState(true)
  const selfTop = useRef(-1)

  const setFollow = useCallback((v: boolean) => {
    followRef.current = v
    setFollowing(v)
  }, [])

  const setTop = useCallback((top: number) => {
    const el = ref.current
    if (!el) return
    el.scrollTop = top
    selfTop.current = Math.round(el.scrollTop)
  }, [])

  const toBottom = useCallback(() => {
    const el = ref.current
    if (el) setTop(el.scrollHeight)
  }, [setTop])

  /** After content changed: stay at the bottom when following. */
  const stick = useCallback(() => {
    if (followRef.current) toBottom()
  }, [toBottom])

  /** "↓ latest" / after sending: follow again and jump to the bottom. */
  const jump = useCallback(() => {
    setFollow(true)
    toBottom()
  }, [setFollow, toBottom])

  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    if (Math.round(el.scrollTop) === selfTop.current) return
    selfTop.current = -1
    const at = nearBottom(el, slack)
    if (at !== followRef.current) setFollow(at)
  }, [slack, setFollow])

  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (followRef.current) toBottom()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [toBottom])

  return { ref, following, followRef, setFollow, setTop, toBottom, stick, jump, onScroll }
}
