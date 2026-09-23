import { useCallback, useMemo, useState, type ReactNode } from 'react'

import { api, isAbortError } from '@/api/client'
import type { FleetResponse } from '@/api/types'
import { FleetContext, loadSnapshot, saveSnapshot, type FleetState } from '@/hooks/useFleet'
import { usePoller } from '@/hooks/usePoller'

export const FLEET_POLL_MS = 5000

/** Polls /api/fleet every 5s (paused while the page is hidden) for the whole app. */
export function FleetProvider({ children, pollMs = FLEET_POLL_MS }: { children: ReactNode; pollMs?: number }) {
  const [snap, setSnap] = useState(() => {
    const s = loadSnapshot()
    return { fleet: s?.fleet ?? null, at: s?.at ?? 0 }
  })
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const applyFleet = useCallback((data: FleetResponse) => {
    const at = data?.snapshotAt || Date.now()
    setSnap({ fleet: data, at })
    saveSnapshot({ fleet: data, at })
  }, [])

  const poll = useCallback(
    async (signal: AbortSignal) => {
      setRefreshing(true)
      try {
        applyFleet(await api.fleet({ signal }))
        setError(null)
      } catch (err) {
        if (isAbortError(err)) throw err
        setError((err as Error)?.message || 'request failed')
      } finally {
        if (!signal.aborted) setRefreshing(false)
      }
    },
    [applyFleet],
  )

  const refresh = usePoller(poll, pollMs)

  const value = useMemo<FleetState>(
    () => ({ fleet: snap.fleet, fleetAt: snap.at, error, refreshing, refresh, applyFleet }),
    [snap, error, refreshing, refresh, applyFleet],
  )
  return <FleetContext.Provider value={value}>{children}</FleetContext.Provider>
}
