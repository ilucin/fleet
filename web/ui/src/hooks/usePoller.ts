import { useCallback, useEffect, useRef } from 'react'

import { isAbortError } from '@/api/client'

export interface PollerOptions {
  /** false stops polling (and aborts the in-flight request). Default true. */
  enabled?: boolean
}

/**
 * setTimeout-chained poller, same behaviour as the classic UI's createPoller:
 * - never overlaps (the next tick is scheduled after the previous one settles);
 * - the first run always happens, even in a hidden/prerendered tab, so a view never
 *   sits on skeletons; after that a hidden document pauses polling;
 * - becoming visible again (visibilitychange / pageshow) polls immediately;
 * - unmount / disable aborts the in-flight request via the AbortSignal passed to `fn`.
 *
 * `fn` may change between renders; the latest one is always called.
 * Returns `refresh()`: abort any in-flight run and poll now.
 */
export function usePoller(fn: (signal: AbortSignal) => Promise<void>, intervalMs: number, { enabled = true }: PollerOptions = {}) {
  const fnRef = useRef(fn)
  useEffect(() => {
    fnRef.current = fn
  }, [fn])

  const refreshRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | null = null
    let stopped = false
    let running = false
    let firstRun = true

    const schedule = (ms = intervalMs) => {
      if (stopped) return
      clearTimeout(timer)
      timer = setTimeout(tick, ms)
    }

    async function tick() {
      if (stopped || running) return
      clearTimeout(timer)
      if (!firstRun && document.visibilityState !== 'visible') {
        schedule()
        return
      }
      firstRun = false
      running = true
      const mine = new AbortController()
      controller = mine
      try {
        await fnRef.current(mine.signal)
      } catch (err) {
        if (!isAbortError(err)) console.warn('poll failed', err)
      } finally {
        // A refresh() may have replaced this run; only the current run reschedules.
        if (controller === mine) {
          running = false
          schedule()
        }
      }
    }

    const refresh = () => {
      if (stopped) return
      if (running && controller) controller.abort()
      controller = null
      running = false
      schedule(0)
    }
    refreshRef.current = refresh

    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pageshow', onVisible)
    tick()

    return () => {
      stopped = true
      clearTimeout(timer)
      controller?.abort()
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pageshow', onVisible)
      refreshRef.current = () => {}
    }
  }, [enabled, intervalMs])

  return useCallback(() => refreshRef.current(), [])
}
