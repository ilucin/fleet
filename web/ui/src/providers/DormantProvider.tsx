import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { toast } from 'sonner'

import { api, isAbortError } from '@/api/client'
import { DormantContext, type DormantState } from '@/hooks/useDormant'
import { useFleet } from '@/hooks/useFleet'
import { usePoller } from '@/hooks/usePoller'
import { dormantCount, dormantErrorMessage, dormantIndex, dormantMissing, restoreSummary, type HostDormant } from '@/lib/dormant'

/** Dormant sessions change only on a reboot or a resume / forget (which refresh at once). */
export const DORMANT_POLL_MS = 30_000

/** Polls GET /api/hosts/:host/dormant for every reachable host; restore / forget with toasts. */
export function DormantProvider({ children }: { children: ReactNode }) {
  const { fleet, refresh: refreshFleet } = useFleet()
  const hostNames = useMemo(() => (fleet?.hosts ?? []).filter((h) => h.ok).map((h) => h.name), [fleet])
  const hostsKey = hostNames.join('\n')
  const [hosts, setHosts] = useState<HostDormant[]>([])
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())

  const poll = useCallback(
    async (signal: AbortSignal) => {
      const names = hostsKey ? hostsKey.split('\n') : []
      const next = await Promise.all(
        names.map(async (host): Promise<HostDormant | null> => {
          try {
            const r = await api.dormant(host, { signal })
            return { host, views: Array.isArray(r.dormant) ? r.dormant : [] }
          } catch (err) {
            if (isAbortError(err)) throw err
            if (dormantMissing(err)) return { host, views: [] } // older server / CLI: nothing to show
            return null // transient: keep what we had
          }
        }),
      )
      setHosts((prev) =>
        names
          .map((host, i) => next[i] ?? prev.find((h) => h.host === host) ?? null)
          .filter((h): h is HostDormant => !!h && h.views.length > 0),
      )
    },
    [hostsKey],
  )
  const refresh = usePoller(poll, DORMANT_POLL_MS, { enabled: !!hostsKey })

  const track = useCallback(
    async (key: string, fn: () => Promise<void>) => {
      setBusy((b) => new Set(b).add(key))
      try {
        await fn()
      } finally {
        setBusy((b) => {
          const n = new Set(b)
          n.delete(key)
          return n
        })
        refresh()
        refreshFleet()
      }
    },
    [refresh, refreshFleet],
  )

  const restore = useCallback(
    (host: string, body: { target: string } | { all: true }) =>
      track(`${host}/${'all' in body ? '*' : body.target}`, async () => {
        try {
          const s = restoreSummary(await api.restoreDormant(host, body))
          if (s.ok) toast.success(s.title, { description: s.description || undefined })
          else toast.error(s.title, { description: s.description || undefined })
        } catch (err) {
          toast.error('Resume failed', { description: dormantErrorMessage(err) })
        }
      }),
    [track],
  )

  const forget = useCallback(
    (host: string, target: string) =>
      track(`${host}/${target}`, async () => {
        try {
          const r = await api.forgetDormant(host, { target })
          toast.success(`Forgot ${r.forgotten.join(', ') || target}`, { description: 'It will not come back.' })
        } catch (err) {
          toast.error('Forget failed', { description: dormantErrorMessage(err) })
        }
      }),
    [track],
  )

  const value = useMemo<DormantState>(
    () => ({
      hosts,
      index: dormantIndex(hosts),
      count: dormantCount(hosts),
      busy,
      resume: (host, target) => restore(host, { target }),
      resumeAll: (host) => restore(host, { all: true }),
      forget,
      refresh,
    }),
    [hosts, busy, restore, forget, refresh],
  )
  return <DormantContext.Provider value={value}>{children}</DormantContext.Provider>
}
