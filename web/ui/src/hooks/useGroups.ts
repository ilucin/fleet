import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { ApiError, api, isAbortError } from '@/api/client'
import type { FleetResponse, GroupsResponse, Session } from '@/api/types'
import { usePersistentState } from '@/hooks/usePersistentState'
import { usePoller } from '@/hooks/usePoller'
import { boardColumns, effectiveGroups, parseIdList, parseViewMode, regroupToast, stickyColumns, type BoardColumn, type ViewMode } from '@/lib/groups'
import { allSessions } from '@/lib/sessions'
import { storage } from '@/lib/storage'

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

const ORDER_KEY = 'fleet.boardOrder'

/**
 * The board's columns for `sessions` (already filtered), in a sticky order remembered in
 * `fleet.boardOrder`: a column keeps its place while statuses change; new ones are appended.
 */
export function useBoardColumns(enabled: boolean, sessions: Session[], groups: GroupsResponse | null, fleet: FleetResponse | null): BoardColumn[] {
  const [order, setOrder] = useState<string[]>(() => parseIdList(storage.getJSON(ORDER_KEY)))
  const sticky = useMemo(
    () => (enabled ? stickyColumns(boardColumns(sessions, effectiveGroups(groups, allSessions(fleet)).groups), order) : null),
    [enabled, sessions, groups, fleet, order],
  )
  if (sticky && (sticky.order.length !== order.length || sticky.order.some((id, i) => id !== order[i]))) setOrder(sticky.order)
  useEffect(() => {
    storage.set(ORDER_KEY, JSON.stringify(order))
  }, [order])
  return sticky?.columns ?? []
}
