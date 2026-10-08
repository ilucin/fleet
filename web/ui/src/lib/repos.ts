// Settings → Git repos: pure helpers (docs/cli.md → Repos).
import type { RepoOutcome, RepoRow, RepoSyncResult, ReposSettings } from '@/api/types'

/** The intervals offered per repo and as the default. `off` = excluded. */
export const REPO_INTERVALS = ['30m', '1h', '6h', '24h', '7d'] as const

const UNIT: Record<string, number> = { m: 60, h: 3600, d: 86400 }

/** `30m` → 1800; null when it isn't one (mirrors the CLI: ≥ 1m). */
export function spanSeconds(v: string): number | null {
  const m = /^(\d{1,5})([mhd])$/.exec(v.trim())
  if (!m) return null
  const s = Number(m[1]) * UNIT[m[2]]
  return s >= 60 ? s : null
}

/** 1800 → `30m`, 86400 → `24h`, 604800 → `7d`. */
export function spanLabel(secs: number): string {
  if (secs > 86400 && secs % 86400 === 0) return `${secs / 86400}d`
  if (secs % 3600 === 0) return `${secs / 3600}h`
  return `${Math.round(secs / 60)}m`
}

/** The config key for a repo: its name, or its `~/…` path when another listed repo has the same name. */
export function repoKey(row: RepoRow, rows: RepoRow[]): string {
  return rows.filter((r) => r.name === row.name).length > 1 ? row.path : row.name
}

/** Does a config key name this repo? (a name, or a path — anything with a `/`). */
export function keyMatches(key: string, row: RepoRow): boolean {
  return key.includes('/') ? key.replace(/\/+$/, '') === row.path : key === row.name
}

/** A repo's setting in a draft: `off` (excluded), an override, or `default`. */
export function rowInterval(s: ReposSettings, row: RepoRow): string {
  if (s.exclude.some((k) => keyMatches(k, row))) return 'off'
  const o = Object.entries(s.overrides).find(([k]) => keyMatches(k, row))
  return o ? o[1] : 'default'
}

/** The draft with one repo set to `value` (`default` | `off` | an interval). Other keys stay. */
export function setRowInterval(s: ReposSettings, row: RepoRow, rows: RepoRow[], value: string): ReposSettings {
  const overrides = Object.fromEntries(Object.entries(s.overrides).filter(([k]) => !keyMatches(k, row)))
  const exclude = s.exclude.filter((k) => !keyMatches(k, row))
  const key = repoKey(row, rows)
  if (value === 'off') exclude.push(key)
  else if (value !== 'default') overrides[key] = value
  return { ...s, overrides, exclude }
}

export function sameSettings(a: ReposSettings, b: ReposSettings): boolean {
  const norm = (s: ReposSettings) =>
    JSON.stringify({
      roots: s.roots.map((r) => r.trim()).filter(Boolean),
      every: s.every,
      overrides: Object.entries(s.overrides).sort(([x], [y]) => x.localeCompare(y)),
      exclude: [...s.exclude].sort(),
    })
  return norm(a) === norm(b)
}

/** A root that the server will refuse, or null. */
export function rootProblem(r: string): string | null {
  const p = r.trim()
  if (!p) return 'Empty'
  if (!(p === '~' || p.startsWith('~/') || p.startsWith('/'))) return 'Absolute or ~/…'
  return null
}

/** `↓3 ↑1 ✎2`, or `=` when in step with upstream and clean. */
export function repoPosition(r: Pick<RepoRow, 'ahead' | 'behind' | 'dirty'>): string {
  const parts: string[] = []
  if (r.behind) parts.push(`↓${r.behind}`)
  if (r.ahead) parts.push(`↑${r.ahead}`)
  if (r.dirty) parts.push(`✎${r.dirty}`)
  return parts.join(' ') || '='
}

export const OUTCOME_LABEL: Record<RepoOutcome, string> = {
  updated: 'updated',
  current: 'up to date',
  ahead: 'ahead',
  diverged: 'diverged',
  blocked: 'blocked',
  busy: 'busy',
  noUpstream: 'no upstream',
  noRemote: 'no remote',
  fetchFailed: 'fetch failed',
}

export type OutcomeTone = 'ok' | 'warn' | 'bad' | 'muted'

export function outcomeTone(o: RepoOutcome | null | undefined): OutcomeTone {
  if (o === 'diverged' || o === 'blocked' || o === 'fetchFailed') return 'bad'
  if (o === 'busy' || o === 'noUpstream' || o === 'noRemote') return 'warn'
  if (o === 'updated' || o === 'current' || o === 'ahead') return 'ok'
  return 'muted'
}

/** Toast copy for a sync run. */
export function syncSummary(results: RepoSyncResult[]): { title: string; description: string; bad: boolean } {
  const updated = results.filter((r) => r.pulled > 0 || r.defaultBranch)
  const bad = results.filter((r) => outcomeTone(r.outcome) === 'bad')
  const title = !results.length
    ? 'Nothing to sync'
    : `${updated.length} updated${bad.length ? `, ${bad.length} need${bad.length === 1 ? 's' : ''} attention` : ''}`
  const description = [
    ...bad.map((r) => `${r.name}: ${OUTCOME_LABEL[r.outcome]}${r.detail ? ` — ${r.detail}` : ''}`),
    ...updated.map((r) => `${r.name}: +${r.pulled}${r.defaultBranch ? ` (${r.defaultBranch.branch} +${r.defaultBranch.pulled})` : ''}`),
  ]
    .slice(0, 8)
    .join('\n')
  return { title, description: description || `${results.length} repos up to date`, bad: bad.length > 0 }
}
