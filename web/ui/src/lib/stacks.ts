// Session stacks (a StackBrief shared by N sibling sessions): pure helpers for the Stack sheet,
// the session screen's stack bar and the sibling form — unit-tested in stacks.test.ts. The list /
// board placement lives next to its peers: clusterByStack() (lib/sessions.ts) and
// withStackColumns() (lib/groups.ts).
import { ApiError } from '@/api/client'
import type { Session, StackMember, StackView } from '@/api/types'

/** A member is live while `closed` is null (the server's `live` wins when present). */
export function memberLive(m: Pick<StackMember, 'live' | 'closed'>): boolean {
  return typeof m.live === 'boolean' ? m.live : m.closed == null
}

/** Live and closed member counts. */
export function memberCounts(stack: Pick<StackView, 'members'> | null | undefined): { live: number; closed: number } {
  let live = 0
  let closed = 0
  for (const m of stack?.members ?? []) {
    if (memberLive(m)) live += 1
    else closed += 1
  }
  return { live, closed }
}

/** "2 live · 1 closed" ("2 live" when none closed). */
export function memberCountsText(stack: Pick<StackView, 'members'> | null | undefined): string {
  const { live, closed } = memberCounts(stack)
  return closed ? `${live} live · ${closed} closed` : `${live} live`
}

/** Live members first (in stack order), then closed ones, most recently closed first. */
export function sortedMembers(members: readonly StackMember[] | null | undefined): StackMember[] {
  const list = [...(members ?? [])]
  const live = list.filter(memberLive)
  const closed = list.filter((m) => !memberLive(m)).sort((a, b) => String(b.closed ?? '').localeCompare(String(a.closed ?? '')))
  return [...live, ...closed]
}

/**
 * The server (or that host's peer) predates stacks: a 501, or the router's generic 404
 * "not found" (an unknown stack is a 404 with its own message).
 */
export function stacksMissing(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 501 || (err.status === 404 && (err.message === 'not found' || /^HTTP 404$/.test(err.message))))
}

/** Does this session's host know stacks at all? Newer CLIs send `stack: null` on every row; older ones omit it. */
export function stacksKnown(s: Pick<Session, 'stack'> | null | undefined): boolean {
  return !!s && s.stack !== undefined
}

/** One line for a failed stack request (toasts / the sheet). */
export function stackErrorMessage(err: unknown): string {
  if (stacksMissing(err)) return 'This host’s fleet web server predates session stacks — update and restart it'
  if (err instanceof ApiError) {
    if (err.status === 0) return 'network unreachable'
    if (err.status === 502 || err.status === 504) return 'host unreachable'
    return err.message || `HTTP ${err.status}`
  }
  return (err as Error)?.message || 'request failed'
}

/** The stored `updated` a 409 carries (`{ error, updated }`), if any. */
export function conflictUpdated(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null
  const u = (err.data as { updated?: unknown } | null)?.updated
  return typeof u === 'string' ? u : null
}

/** The Stack sheet's member → a session route (`#/s/<host>/<id>`). */
export function memberSession(m: Pick<StackMember, 'host' | 'session'>, stackHost: string): { host: string; session_id: string } {
  return { host: m.host || stackHost, session_id: m.session }
}
