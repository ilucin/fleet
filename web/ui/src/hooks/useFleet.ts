import { createContext, useContext } from 'react'

import type { FleetResponse } from '@/api/types'
import { storage } from '@/lib/storage'

export interface FleetState {
  /** Last good /api/fleet body (or the localStorage snapshot before the first poll). */
  fleet: FleetResponse | null
  /** When `fleet` was built (server `snapshotAt`, else receive time); 0 = never. */
  fleetAt: number
  /** Last poll error message; null after a successful poll. */
  error: string | null
  /** A poll is in flight. */
  refreshing: boolean
  /** Poll now (e.g. after a spawn/kill). */
  refresh: () => void
  /** Record a fresh /api/fleet body fetched elsewhere (e.g. a spawn watcher). */
  applyFleet: (data: FleetResponse) => void
}

export const FleetContext = createContext<FleetState | null>(null)

export function useFleet(): FleetState {
  const ctx = useContext(FleetContext)
  if (!ctx) throw new Error('useFleet() outside <FleetProvider>')
  return ctx
}

// Shared with the classic UI (same origin, same shape): a reload paints the
// last list instantly while the first poll runs.
export const SNAPSHOT_KEY = 'fleet.snapshot'
export const SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000

export interface FleetSnapshot {
  fleet: FleetResponse
  at: number
}

export function loadSnapshot(now = Date.now()): FleetSnapshot | null {
  const parsed = storage.getJSON<FleetSnapshot>(SNAPSHOT_KEY)
  if (!parsed || !Array.isArray(parsed.fleet?.hosts) || !parsed.at) return null
  if (now - parsed.at > SNAPSHOT_MAX_AGE_MS) return null
  return parsed
}

export function saveSnapshot(snap: FleetSnapshot): void {
  storage.setJSON(SNAPSHOT_KEY, snap)
}
