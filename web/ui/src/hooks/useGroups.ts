import { useCallback, useState } from 'react'
import { toast } from 'sonner'

import { ApiError, api, isAbortError } from '@/api/client'
import type { GroupsResponse } from '@/api/types'
import { usePersistentState } from '@/hooks/usePersistentState'
import { usePoller } from '@/hooks/usePoller'
import { parseViewMode, regroupToast, type ViewMode } from '@/lib/groups'

export const GROUPS_POLL_MS = 30_000
/** While the server says a pass is running: check back sooner. */
export const GROUPS_RUNNING_POLL_MS = 4000

/** `fleet.view`: List | Board. */
export function useViewMode(): [ViewMode, (v: ViewMode) => void] {
  return usePersistentState<ViewMode>('fleet.view', 'list', parseViewMode)
}

/**
 * /api/groups, polled every 30s only while `enabled` (the Board is on screen). A 404 or
 * any error (older server, grouping host unreachable) leaves `groups` null — the board then
 * groups by repo client-side. `run()` is "Regroup now" (POST /api/groups/run) with a toast.
 */
export function useGroups(enabled: boolean) {
  const [groups, setGroups] = useState<GroupsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [running, setRunning] = useState(false)

  const poll = useCallback(async (signal: AbortSignal) => {
    try {
      setGroups(await api.groups({ signal }))
      setError(null)
    } catch (err) {
      if (isAbortError(err)) throw err
      // An older server has no /api/groups: that is "no grouping", not an error to show.
      if (err instanceof ApiError && (err.status === 404 || err.status === 501)) {
        setGroups(null)
        setError(null)
      } else setError((err as Error)?.message || 'request failed')
    } finally {
      if (!signal.aborted) setLoaded(true)
    }
  }, [])

  const busy = running || !!groups?.running
  const refresh = usePoller(poll, busy ? GROUPS_RUNNING_POLL_MS : GROUPS_POLL_MS, { enabled })

  const run = useCallback(async () => {
    if (running) return
    setRunning(true)
    try {
      const res = await api.runGroups()
      setGroups(res)
      setError(null)
      if (res.lastRun?.ok === false) toast.error(regroupToast(res))
      else toast(regroupToast(res))
    } catch (err) {
      const msg =
        err instanceof ApiError && err.status === 501
          ? 'Smart grouping is off (web.grouping.enabled)'
          : (err as Error)?.message || 'Grouping failed'
      toast.error(msg)
    } finally {
      setRunning(false)
    }
  }, [running])

  return { groups, error, loaded, running: busy, refresh, run }
}

export type GroupsState = ReturnType<typeof useGroups>
