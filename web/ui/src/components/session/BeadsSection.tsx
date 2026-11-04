import { useCallback, useState } from 'react'
import { ArrowLeftIcon, CheckCircle2Icon, ChevronRightIcon, CircleAlertIcon, CircleDotIcon, CircleIcon, ClockIcon, Loader2Icon } from 'lucide-react'

import { api, isAbortError, sessionErrorMessage } from '@/api/client'
import type { BeadDetail, BeadIssue, BeadSummary, Session } from '@/api/types'
import { Markdown } from '@/components/Markdown'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { usePoller } from '@/hooks/usePoller'
import { cn } from '@/lib/utils'

// Beads (bd issues, web/lib/beads.mjs): the Details section lists the session's top-level beads
// (epics, or issues without a parent); a click opens the viewer — the issue, its children,
// their links and comments — where a child opens in place (Back returns).

const BEADS_POLL_MS = 30_000

function StatusIcon({ status, className }: { status: string; className?: string }) {
  const c = cn('size-3.5 shrink-0', className)
  if (status === 'closed') return <CheckCircle2Icon aria-label="closed" className={cn(c, 'text-status-busy')} />
  if (status === 'in_progress') return <CircleDotIcon aria-label="in progress" className={cn(c, 'text-primary')} />
  if (status === 'blocked') return <CircleAlertIcon aria-label="blocked" className={cn(c, 'text-status-waiting')} />
  if (status === 'deferred') return <ClockIcon aria-label="deferred" className={cn(c, 'text-dimmer')} />
  return <CircleIcon aria-label={status || 'open'} className={cn(c, 'text-muted-foreground')} />
}

function Progress({ c }: { c: BeadSummary['children'] }) {
  if (!c.total) return null
  const pct = Math.round((c.closed / c.total) * 100)
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[0.6875rem] text-dimmer tabular-nums" title={`${c.closed} of ${c.total} closed${c.inProgress ? `, ${c.inProgress} in progress` : ''}`}>
      <span className="h-1 w-10 overflow-hidden rounded-full bg-muted">
        <span className="block h-full bg-status-busy" style={{ width: `${pct}%` }} />
      </span>
      {c.closed}/{c.total}
    </span>
  )
}

/** Details → Beads: nothing when the session never ran `bd` (or its host has no bd). */
export function BeadsSection({ host, session: s }: { host: string; session: Session | null }) {
  const sid = s?.session_id ?? null
  const key = `${host}/${sid}`
  const [state, setState] = useState<{ key: string; beads: BeadSummary[] } | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const poll = useCallback(
    async (signal: AbortSignal) => {
      if (!sid) return
      try {
        const r = await api.beads(host, sid, { signal })
        setState({ key, beads: r.enabled ? r.beads : [] })
      } catch (err) {
        if (isAbortError(err)) throw err
        // An older server (no route) or no bd: no section.
      }
    },
    [host, sid, key],
  )
  usePoller(poll, BEADS_POLL_MS, { enabled: !!sid })

  const beads = state?.key === key ? state.beads : []
  if (!sid || !beads.length) return null
  return (
    <section>
      <h3 className="pt-2 pb-1 text-[0.6875rem] font-semibold tracking-wider text-dimmer uppercase">Beads</h3>
      <ul className="flex flex-col">
        {beads.map((b) => (
          <li key={b.id}>
            <button
              type="button"
              onClick={() => setOpen(b.id)}
              className="-mx-1 flex min-h-9 w-[calc(100%+0.5rem)] items-center gap-2 rounded-md px-1 text-left outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50"
              title={`${b.id}: ${b.title}`}
            >
              <StatusIcon status={b.status} />
              <span className="min-w-0 flex-1 truncate text-sm">{b.title}</span>
              <span className="shrink-0 font-mono text-[0.6875rem] text-dimmer">{b.id}</span>
              <Progress c={b.children} />
            </button>
          </li>
        ))}
      </ul>
      <BeadsViewer host={host} sessionId={sid} beadId={open} onClose={() => setOpen(null)} />
    </section>
  )
}

/** The viewer: one bead with its children; a child opens in place, Back goes up the trail. */
export function BeadsViewer({ host, sessionId, beadId, onClose }: { host: string; sessionId: string; beadId: string | null; onClose: () => void }) {
  const [trail, setTrail] = useState<string[]>([])
  const [rootOf, setRootOf] = useState<string | null>(null)
  if (beadId !== rootOf) {
    setRootOf(beadId)
    setTrail(beadId ? [beadId] : [])
  }
  const current = trail[trail.length - 1] ?? null
  const [data, setData] = useState<{ id: string; detail: BeadDetail } | null>(null)
  const [error, setError] = useState<{ id: string; message: string } | null>(null)

  const poll = useCallback(
    async (signal: AbortSignal) => {
      if (!current) return
      try {
        const d = await api.bead(host, sessionId, current, { signal })
        setData({ id: current, detail: d })
        setError(null)
      } catch (err) {
        if (isAbortError(err)) throw err
        setError({ id: current, message: sessionErrorMessage(err) })
      }
    },
    [host, sessionId, current],
  )
  usePoller(poll, BEADS_POLL_MS, { enabled: !!current })

  const d = data?.id === current ? data.detail : null
  const err = error?.id === current ? error.message : null
  const go = (id: string) => setTrail((t) => [...t, id])
  const back = () => setTrail((t) => t.slice(0, -1))

  return (
    <Dialog open={!!beadId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <div className="flex items-center gap-2 text-xs text-dimmer">
            {trail.length > 1 ? (
              <Button variant="ghost" size="xs" onClick={back} aria-label="Back">
                <ArrowLeftIcon /> {trail[trail.length - 2]}
              </Button>
            ) : d?.parent ? (
              <Button variant="ghost" size="xs" onClick={() => go(d.parent!.id)} title={d.parent.title}>
                ↑ {d.parent.id}
              </Button>
            ) : null}
            <span className="font-mono">{current}</span>
            {d ? <Meta i={d.issue} /> : null}
          </div>
          <DialogTitle className="flex items-start gap-2">
            {d ? <StatusIcon status={d.issue.status} className="mt-1 size-4" /> : null}
            <span>{d?.issue.title ?? current}</span>
          </DialogTitle>
          <DialogDescription className="sr-only">Beads issue {current}</DialogDescription>
        </DialogHeader>

        {!d && !err ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" /> Loading…
          </div>
        ) : null}
        {err && !d ? <p className="py-4 text-sm text-status-error">{err}</p> : null}

        {d ? (
          <div className="flex min-w-0 flex-col gap-4">
            <Links i={d.issue} onOpen={go} />
            {d.issue.closeReason ? <p className="text-sm text-muted-foreground">Closed: {d.issue.closeReason}</p> : null}
            <TextBlock title="Description" text={d.issue.description} />
            <TextBlock title="Design" text={d.issue.design} />
            <TextBlock title="Acceptance criteria" text={d.issue.acceptance} />
            <TextBlock title="Notes" text={d.issue.notes} />

            {d.children.length ? (
              <div>
                <h4 className="flex items-center gap-2 pb-1 text-[0.6875rem] font-semibold tracking-wider text-dimmer uppercase">
                  Children
                  <Progress
                    c={{
                      total: d.children.length,
                      closed: d.children.filter((c) => c.status === 'closed').length,
                      inProgress: d.children.filter((c) => c.status === 'in_progress').length,
                    }}
                  />
                </h4>
                <ul className="flex flex-col divide-y divide-border rounded-md border">
                  {sortChildren(d.children).map((c) => (
                    <ChildRow key={c.id} c={c} onOpen={go} />
                  ))}
                </ul>
              </div>
            ) : null}

            {d.comments.length ? (
              <div>
                <h4 className="pb-1 text-[0.6875rem] font-semibold tracking-wider text-dimmer uppercase">Comments</h4>
                <ul className="flex flex-col gap-3">
                  {d.comments.map((c, i) => (
                    <li key={i} className="rounded-md bg-muted/40 p-2">
                      <div className="pb-1 text-xs text-dimmer">
                        {c.author ?? 'someone'}
                        {c.createdAt ? ` · ${fmtDate(c.createdAt)}` : ''}
                      </div>
                      <Markdown text={c.text} className="text-sm" />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

const STATUS_ORDER: Record<string, number> = { in_progress: 0, blocked: 1, open: 2, deferred: 3, closed: 4 }

/** Hierarchical ids in number order (bd-x.2 before bd-x.10). */
function sortChildren(list: BeadIssue[]) {
  const num = (id: string) => id.split('.').slice(1).map(Number)
  return [...list].sort((a, b) => {
    const na = num(a.id)
    const nb = num(b.id)
    for (let i = 0; i < Math.max(na.length, nb.length); i++) {
      const d = (na[i] ?? -1) - (nb[i] ?? -1)
      if (d) return d
    }
    return (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || a.id.localeCompare(b.id)
  })
}

function fmtDate(iso: string) {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function Meta({ i }: { i: BeadIssue }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      {i.type ? <Chip>{i.type}</Chip> : null}
      {i.priority != null ? <Chip>P{i.priority}</Chip> : null}
      <Chip>{i.status.replace('_', ' ')}</Chip>
      {i.labels.map((l) => (
        <Chip key={l}>{l}</Chip>
      ))}
      {i.assignee ? <span>→ {i.assignee}</span> : null}
    </span>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="rounded-[5px] border px-1 text-[0.6875rem] leading-4 text-muted-foreground">{children}</span>
}

function IdButton({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  return (
    <button type="button" onClick={() => onOpen(id)} className="font-mono text-primary underline decoration-primary/40 underline-offset-2">
      {id}
    </button>
  )
}

function Links({ i, onOpen }: { i: BeadIssue; onOpen: (id: string) => void }) {
  if (!i.blockedBy.length && !i.related.length) return null
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      {i.blockedBy.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          Blocked by
          {i.blockedBy.map((id) => (
            <IdButton key={id} id={id} onOpen={onOpen} />
          ))}
        </div>
      ) : null}
      {i.related.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          Related
          {i.related.map((id) => (
            <IdButton key={id} id={id} onOpen={onOpen} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function TextBlock({ title, text }: { title: string; text: string }) {
  if (!text?.trim()) return null
  return (
    <div className="min-w-0">
      <h4 className="pb-1 text-[0.6875rem] font-semibold tracking-wider text-dimmer uppercase">{title}</h4>
      <Markdown text={text} className="text-sm" />
    </div>
  )
}

/** A child: a summary line that expands to its description; its id opens it in the viewer. */
function ChildRow({ c, onOpen }: { c: BeadIssue; onOpen: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <li className="min-w-0">
      <div className="flex min-h-9 items-center gap-2 px-2">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ChevronRightIcon className={cn('size-3.5 shrink-0 text-dimmer transition-transform', expanded && 'rotate-90')} />
          <StatusIcon status={c.status} />
          <span className={cn('min-w-0 flex-1 truncate text-sm', c.status === 'closed' && 'text-muted-foreground line-through decoration-muted-foreground/40')}>{c.title}</span>
          {c.priority != null ? <span className="shrink-0 text-[0.6875rem] text-dimmer">P{c.priority}</span> : null}
          {c.blockedBy.length ? (
            <span className="shrink-0 text-[0.6875rem] text-status-waiting" title={`Blocked by ${c.blockedBy.join(', ')}`}>
              ⛔ {c.blockedBy.length}
            </span>
          ) : null}
        </button>
        <IdButton id={c.id} onOpen={onOpen} />
      </div>
      {expanded ? (
        <div className="flex min-w-0 flex-col gap-2 px-8 pb-3">
          <Links i={c} onOpen={onOpen} />
          {c.closeReason ? <p className="text-xs text-muted-foreground">Closed: {c.closeReason}</p> : null}
          {c.description.trim() ? <Markdown text={c.description} className="text-sm" /> : <p className="text-xs text-dimmer">No description.</p>}
          {c.notes.trim() ? (
            <div>
              <div className="text-[0.6875rem] font-semibold tracking-wider text-dimmer uppercase">Notes</div>
              <Markdown text={c.notes} className="text-sm" />
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}
