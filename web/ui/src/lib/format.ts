// Pure display helpers (no React, no DOM) — unit-tested in format.test.ts.
import type { ContextUsage, Session } from '@/api/types'

/** "12s", "5m", "3h", "4d" since `ms` (epoch ms); '' for missing/invalid. */
export function relTime(ms: number | null | undefined, now = Date.now()): string {
  const t = Number(ms)
  if (!Number.isFinite(t) || t <= 0) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const hr = Math.round(m / 60)
  if (hr < 48) return `${hr}h`
  return `${Math.round(hr / 24)}d`
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** "14:03" today, else "3.7. 14:03". */
export function clockTime(ms: number | null | undefined, now = Date.now()): string {
  const t = Number(ms)
  if (!Number.isFinite(t) || t <= 0) return ''
  const d = new Date(t)
  const today = new Date(now)
  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  const sameDay =
    d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  return sameDay ? hhmm : `${d.getDate()}.${d.getMonth() + 1}. ${hhmm}`
}

/** Home-dir prefix → `~`, head-truncated to `max` chars (the tail of a path is the informative part). */
export function shortCwd(cwd: string | null | undefined, max = 46): string {
  const p = String(cwd || '').replace(/^\/(?:Users|home)\/[^/]+/, '~')
  return p.length <= max ? p : `…${p.slice(-(max - 1))}`
}

export function firstLine(text: string | null | undefined): string {
  if (typeof text !== 'string') return ''
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t) return t
  }
  return ''
}

/**
 * The one-line description under a session's title: its first prompt. The title itself
 * (`sessionTitle`, lib/title.ts) already carries the generated title, so it is not repeated.
 */
export function sessionSubtitle(s: Pick<Session, 'title'>): string {
  const line = firstLine(s.title)
  return line.length > 240 ? `${line.slice(0, 240)}…` : line
}

export const HOST_COLOR_SLOTS = 4

/** Stable colour slot 0..3 per host name, whatever the host is called (same hash as the classic UI). */
export function hostColorSlot(host: string | null | undefined): number {
  let hash = 0
  for (const ch of String(host || '')) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return hash % HOST_COLOR_SLOTS
}

export type CtxLevel = 'low' | 'warn' | 'hot'

/** Same bands as the CLI: <60 calm, 60–85 warn, >85 hot. */
export function ctxLevel(pct: number): CtxLevel {
  if (pct > 85) return 'hot'
  if (pct >= 60) return 'warn'
  return 'low'
}

/** 950 → "950", 124_300 → "124k", 1_000_000 → "1M", 1_250_000 → "1.3M". */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?'
  if (n < 1000) return String(Math.round(n))
  if (n < 999_500) return `${Math.round(n / 1000)}k`
  const m = n / 1_000_000
  return `${Number.isInteger(Math.round(m * 10) / 10) ? Math.round(m) : m.toFixed(1)}M`
}

/** "124k / 200k · 62%" — '' for a missing or malformed context. */
export function ctxSummary(c: ContextUsage | null | undefined): string {
  if (!c || !Number.isFinite(c.used) || !Number.isFinite(c.window)) return ''
  return `${fmtTokens(c.used)} / ${fmtTokens(c.window)} · ${Math.round(c.pct)}%`
}
