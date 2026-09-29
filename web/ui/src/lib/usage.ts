import type { UsageAccount, UsageLimit, UsageResponse } from '@/api/types'
import type { CtxLevel } from '@/lib/format'

/** One host's answer: its usage, or why there is none. */
export interface HostUsage {
  host: string
  usage: UsageResponse | null
  error: string | null
}

/** One Claude account, with every host logged in to it (the numbers are the account's). */
export interface AccountUsage {
  key: string
  account: UsageAccount | null
  hosts: string[]
  /** The freshest read among those hosts. */
  usage: UsageResponse
}

/** Band for a limit: the endpoint's severity wins, else ≥90% hot, ≥70% warn. */
export function usageLevel(l: Pick<UsageLimit, 'percent' | 'severity'>): CtxLevel {
  if (l.percent >= 90 || ['critical', 'exceeded', 'blocked', 'limited'].includes(l.severity)) return 'hot'
  if (l.percent >= 70 || l.severity === 'warning') return 'warn'
  return 'low'
}

/** `in 45m` / `in 2h 20m` within a day, else `Fri 14:00` (local time). */
export function resetsLabel(iso: string | null, now: number): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const mins = Math.max(0, Math.round((t - now) / 60_000))
  if (mins < 60) return `in ${mins}m`
  if (mins < 24 * 60) return `in ${Math.floor(mins / 60)}h ${mins % 60}m`
  const d = new Date(t)
  const day = d.toLocaleDateString(undefined, { weekday: 'short' })
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${day} ${time}`
}

/** `12.50 USD` style money, or null. */
export function money(n: number | null, currency: string | null): string | null {
  if (n == null || !Number.isFinite(n)) return null
  try {
    return currency ? new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n) : n.toFixed(2)
  } catch {
    return `${n.toFixed(2)} ${currency ?? ''}`.trim()
  }
}

/**
 * Group hosts by the account they're logged in to (uuid, else email): two machines on one
 * subscription show one set of bars. Accounts keep the order their first host appears in.
 */
export function groupByAccount(results: HostUsage[]): AccountUsage[] {
  const out: AccountUsage[] = []
  for (const r of results) {
    const u = r.usage
    if (!u) continue
    const key = u.account?.uuid ?? u.account?.email ?? `host:${r.host}`
    const existing = out.find((a) => a.key === key)
    if (!existing) {
      out.push({ key, account: u.account, hosts: [r.host], usage: u })
      continue
    }
    existing.hosts.push(r.host)
    const fresher = (!u.stale && existing.usage.stale) || (u.stale === existing.usage.stale && Date.parse(u.fetched_at) > Date.parse(existing.usage.fetched_at))
    if (fresher) existing.usage = u
  }
  return out
}
