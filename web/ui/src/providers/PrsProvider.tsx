import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { ApiError, api, isAbortError } from '@/api/client'
import type { PrColumnId, PrsResponse, PullRequest } from '@/api/types'
import { useFleet } from '@/hooks/useFleet'
import { usePoller } from '@/hooks/usePoller'
import { PrsContext, type PrsState } from '@/hooks/usePrs'
import { linkSessions, prRef } from '@/lib/prs'
import { allSessions } from '@/lib/sessions'

// The CLI refetches once its cache is older than `prs.refresh` (5m); polling reads the cache.
const POLL_MS = 60_000

/**
 * The PRs that need you, as one host's `gh` sees them (its login, its checkouts for
 * `local`), polled app-wide so session rows can show the PR they work on. The host: the one
 * this UI is served from (every host is the same you on GitHub).
 */
export function PrsProvider({ children }: { children: ReactNode }) {
  const { fleet } = useFleet()
  const hosts = useMemo(() => (fleet?.hosts ?? []).filter((h) => h.ok).map((h) => h.name), [fleet])
  const host = fleet?.self && hosts.includes(fleet.self) ? fleet.self : (hosts[0] ?? null)

  // Last answer and failure per host (switching back paints at once; null error = ok).
  const [answers, setAnswers] = useState<Record<string, PrsResponse>>({})
  const [errors, setErrors] = useState<Record<string, string | null>>({})
  const data = host ? (answers[host] ?? null) : null
  const error = host ? (errors[host] ?? null) : null
  const loading = !!host && !data && !(host in errors)

  const load = useCallback(
    async (signal: AbortSignal, refresh = false) => {
      if (!host) return
      try {
        const r = await api.prs(host, { signal, refresh })
        setAnswers((a) => ({ ...a, [host]: r }))
        setErrors((e) => ({ ...e, [host]: null }))
      } catch (err) {
        if (isAbortError(err)) throw err
        // 404/501: that host's server or CLI predates `fleet prs`.
        const old = err instanceof ApiError && (err.status === 404 || err.status === 501)
        const msg = old ? `${host} runs an older fleet — update it to see pull requests` : (err as Error)?.message || 'could not load pull requests'
        setErrors((e) => ({ ...e, [host]: msg }))
      }
    },
    [host],
  )

  const reload = usePoller((signal) => load(signal).catch(() => {}), POLL_MS, { enabled: !!host })
  const [refreshing, setRefreshing] = useState(false)
  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await load(new AbortController().signal, true)
    } catch {
      reload()
    } finally {
      setRefreshing(false)
    }
  }, [load, reload])

  const markSeen = useCallback(
    async (p: PullRequest) => {
      if (!host) return
      await api.prSeen(host, prRef(p))
      reload()
    },
    [host, reload],
  )

  /** Put the answer's PR where the CLI's cache has it now (null: gone), without waiting for a read. */
  const place = useCallback(
    (p: PullRequest, column: PrColumnId | null) => {
      if (!host) return
      setAnswers((a) => {
        const r = a[host]
        if (!r) return a
        const prs = column ? r.prs.map((x) => (x.url === p.url ? { ...x, column } : x)) : r.prs.filter((x) => x.url !== p.url)
        return { ...a, [host]: { ...r, prs } }
      })
    },
    [host],
  )

  const approve = useCallback(
    async (p: PullRequest, body = '') => {
      if (!host) return
      const r = await api.prApprove(host, prRef(p), body)
      place(p, r.column)
      reload()
    },
    [host, place, reload],
  )

  const dismiss = useCallback(
    async (p: PullRequest, undo = false) => {
      if (!host) return
      await api.prDismiss(host, prRef(p), undo)
      if (!undo) place(p, null)
      reload()
    },
    [host, place, reload],
  )

  // PRs opened on GitHub from Fleet: when Fleet has the focus again, fetch just those (an
  // approval, a merge there takes them off the board without a full refresh).
  const watched = useRef(new Map<string, PullRequest>())
  const watch = useCallback((p: PullRequest) => {
    watched.current.set(p.url, p)
  }, [])
  useEffect(() => {
    if (!host) return
    const onBack = () => {
      if (document.visibilityState !== 'visible' || !watched.current.size) return
      const prs = [...watched.current.values()]
      watched.current.clear()
      void Promise.allSettled(
        prs.map(async (p) => {
          const r = await api.prSync(host, prRef(p))
          place(p, r.column)
        }),
      ).then(() => reload())
    }
    window.addEventListener('focus', onBack)
    document.addEventListener('visibilitychange', onBack)
    return () => {
      window.removeEventListener('focus', onBack)
      document.removeEventListener('visibilitychange', onBack)
    }
  }, [host, place, reload])

  const links = useMemo(() => linkSessions(data?.prs ?? [], data ? host : null, allSessions(fleet)), [data, host, fleet])
  const value = useMemo<PrsState>(
    () => ({ host, data, error, loading, refresh, refreshing, reload, markSeen, approve, dismiss, watch, links }),
    [host, data, error, loading, refresh, refreshing, reload, markSeen, approve, dismiss, watch, links],
  )
  return <PrsContext.Provider value={value}>{children}</PrsContext.Provider>
}
