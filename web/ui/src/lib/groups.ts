// Board view logic: join live sessions with the smart groups from /api/groups, the
// client-side fallback (group by repo), per-column status summaries and ordering —
// pure, unit-tested in groups.test.ts.
import type { GroupRun, GroupsResponse, Session, SessionGroup } from '@/api/types'
import { relTime } from '@/lib/format'
import { byLastActivity, statusMeta, type StatusKey } from '@/lib/sessions'

export const UNGROUPED_ID = '__ungrouped__'

export type StatusSummary = Record<StatusKey, number>

export interface BoardColumn {
  id: string
  label: string
  description: string | null
  source: string
  /** The "Ungrouped" column: live sessions no group claims yet. */
  ungrouped: boolean
  /** Waiting first, then most recent activity. */
  sessions: Session[]
  summary: StatusSummary
}

/** The key a group member and a live session share: `host/session_id` (or `host/pid`). */
export const memberKey = (host: string, id: string) => `${host}/${id}`

function sessionKeys(s: Session): string[] {
  const keys = [memberKey(s.host, s.session_id)]
  if (s.pid != null) keys.push(memberKey(s.host, String(s.pid)))
  return keys
}

const WORKTREE_RE = /\/(?:\.claude\/worktrees|\.worktrees|worktrees)\/[^/]+(?:\/.*)?$/

/**
 * The repo a cwd belongs to: `{ id, label }`, worktree-aware — a cwd under
 * `<repo>/.worktrees/<x>`, `<repo>/worktrees/<x>` or `<repo>/.claude/worktrees/<x>` is `<repo>`.
 */
export function repoOf(cwd: string | null | undefined): { id: string; label: string } | null {
  let p = String(cwd || '').trim().replace(/\/+$/, '')
  if (!p) return null
  p = p.replace(WORKTREE_RE, '') || '/'
  const label = p.split('/').filter(Boolean).pop() || p
  return { id: `repo:${p}`, label }
}

/** Deterministic grouping when the server has none: one group per repo (cwd). */
export function fallbackGroups(sessions: Session[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>()
  for (const s of sessions) {
    const repo = repoOf(s.cwd)
    if (!repo) continue
    let g = groups.get(repo.id)
    if (!g) {
      g = { id: repo.id, label: repo.label, description: null, source: 'fallback', members: [] }
      groups.set(repo.id, g)
    }
    g.members.push({ host: s.host, id: s.session_id })
  }
  return [...groups.values()]
}

/** The groups to draw: the server's when grouping is on, else the client fallback. */
export function effectiveGroups(resp: GroupsResponse | null | undefined, sessions: Session[]): { groups: SessionGroup[]; fallback: boolean } {
  if (resp?.enabled && Array.isArray(resp.groups)) return { groups: resp.groups, fallback: false }
  return { groups: fallbackGroups(sessions), fallback: true }
}

export function statusSummary(sessions: Session[]): StatusSummary {
  const out: StatusSummary = { waiting: 0, busy: 0, idle: 0, unknown: 0 }
  for (const s of sessions) out[statusMeta(s.status).key] += 1
  return out
}

const byUrgency = (a: Session, b: Session) => {
  const wa = statusMeta(a.status).key === 'waiting' ? 0 : 1
  const wb = statusMeta(b.status).key === 'waiting' ? 0 : 1
  return wa - wb || byLastActivity(a, b)
}

/** Columns with sessions that need you first, then busy ones, then larger, then by label. Ungrouped last. */
export function compareColumns(a: BoardColumn, b: BoardColumn): number {
  if (a.ungrouped !== b.ungrouped) return a.ungrouped ? 1 : -1
  const w = Number(b.summary.waiting > 0) - Number(a.summary.waiting > 0)
  if (w) return w
  const busy = Number(b.summary.busy > 0) - Number(a.summary.busy > 0)
  if (busy) return busy
  return b.sessions.length - a.sessions.length || a.label.localeCompare(b.label)
}

/**
 * Join `sessions` (already filtered by search/host/status) with `groups`: every session
 * lands in exactly one column (the first group that claims it), sessions no group claims
 * go to "Ungrouped", members that are not live are dropped, and empty groups disappear.
 */
export function boardColumns(sessions: Session[], groups: SessionGroup[]): BoardColumn[] {
  const owner = new Map<string, number>()
  groups.forEach((g, i) => {
    for (const m of g.members ?? []) {
      const k = memberKey(m.host, m.id)
      if (!owner.has(k)) owner.set(k, i)
    }
  })
  const buckets: Session[][] = groups.map(() => [])
  const ungrouped: Session[] = []
  for (const s of sessions) {
    const idx = sessionKeys(s)
      .map((k) => owner.get(k))
      .find((i) => i !== undefined)
    if (idx === undefined) ungrouped.push(s)
    else buckets[idx].push(s)
  }
  const cols: BoardColumn[] = []
  groups.forEach((g, i) => {
    if (!buckets[i].length) return
    const list = buckets[i].sort(byUrgency)
    cols.push({
      id: g.id,
      label: g.label || g.id,
      description: g.description ?? null,
      source: String(g.source ?? 'llm'),
      ungrouped: false,
      sessions: list,
      summary: statusSummary(list),
    })
  })
  if (ungrouped.length) {
    const list = ungrouped.sort(byUrgency)
    cols.push({
      id: UNGROUPED_ID,
      label: 'Ungrouped',
      description: 'Not grouped yet',
      source: 'none',
      ungrouped: true,
      sessions: list,
      summary: statusSummary(list),
    })
  }
  return cols.sort(compareColumns)
}

/** Sessions in board order (columns left→right, cards top→bottom) — the j/k cursor order. */
export function boardOrder(columns: BoardColumn[]): Session[] {
  return columns.flatMap((c) => c.sessions)
}

/** "grouped 3m ago · 1 model call", "fallback: by repo", "grouping failed 2m ago". */
export function groupsStatusText(resp: GroupsResponse | null | undefined, now = Date.now()): string {
  if (!resp || !resp.enabled) return 'fallback: by repo'
  if (resp.running) return 'grouping…'
  const run: GroupRun | null = resp.lastRun
  if (!run) return resp.updatedAt ? `grouped ${relTime(resp.updatedAt, now)} ago` : 'not grouped yet'
  const ago = relTime(run.at, now)
  if (!run.ok) return `grouping failed ${ago} ago`
  const calls = run.modelCalls ?? 0
  const at = resp.updatedAt && resp.updatedAt > run.at ? relTime(resp.updatedAt, now) : ago
  const suffix = run.mode === 'fallback' ? ' · fallback' : ` · ${calls} model call${calls === 1 ? '' : 's'}`
  return `grouped ${at} ago${suffix}`
}

/** One line for the toast after "Regroup now". */
export function regroupToast(resp: GroupsResponse): string {
  const run = resp.lastRun
  if (!run) return 'Grouping done'
  if (!run.ok) return `Grouping failed: ${run.error || 'unknown error'}`
  const n = resp.groups?.length ?? 0
  if (run.mode === 'noop') return `No changes · ${n} group${n === 1 ? '' : 's'}`
  const calls = run.modelCalls ?? 0
  const classified = run.classified ?? 0
  return `Grouped ${classified} session${classified === 1 ? '' : 's'} into ${n} group${n === 1 ? '' : 's'} · ${calls} model call${calls === 1 ? '' : 's'}`
}

/** `fleet.groupsCollapsed`: collapsed group ids (mobile board). */
export function parseCollapsed(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
}

export type ViewMode = 'list' | 'board'
export const parseViewMode = (raw: string): ViewMode | undefined => (raw === 'list' || raw === 'board' ? raw : undefined)
