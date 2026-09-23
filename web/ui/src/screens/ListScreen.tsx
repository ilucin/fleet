import { useMemo, useState } from 'react'
import { SearchIcon, XIcon } from 'lucide-react'

import { HostDot } from '@/components/HostBadge'
import { ScreenHeader } from '@/components/ScreenHeader'
import { SessionListSkeleton } from '@/components/SessionListSkeleton'
import { SessionRow } from '@/components/SessionRow'
import { StatusDot } from '@/components/StatusDot'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useFleet } from '@/hooks/useFleet'
import { useNow } from '@/hooks/useNow'
import { usePersistentState } from '@/hooks/usePersistentState'
import { relTime } from '@/lib/format'
import { STATUS_FILTERS, allSessions, findStatusFilter, listView, type StatusFilterId } from '@/lib/sessions'
import { cn } from '@/lib/utils'

const ALL_HOSTS = '*'

const chipClass = cn(
  'h-9 shrink-0 gap-1.5 rounded-full border border-border bg-card px-3.5 text-sm text-muted-foreground',
  'data-[state=on]:border-primary/50 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground',
)

export function ListScreen() {
  const { fleet, fleetAt, error, refreshing } = useFleet()
  const now = useNow(1000)
  const [query, setQuery] = useState('')
  // `fleet.filter` is shared with the classic UI (same ids).
  const [status, setStatus] = usePersistentState<StatusFilterId>('fleet.filter', 'all', (raw) => findStatusFilter(raw).id)
  const [hostFilter, setHostFilter] = usePersistentState<string>('fleet.hostFilter', ALL_HOSTS)

  const hosts = fleet?.hosts ?? []
  const hostNames = hosts.map((h) => h.name)
  // A remembered host that is no longer configured means "all".
  const host = hostFilter !== ALL_HOSTS && hostNames.includes(hostFilter) ? hostFilter : null

  const view = useMemo(() => listView(fleet, { query, host, status }), [fleet, query, host, status])
  const hostCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of allSessions(fleet)) counts.set(s.host, (counts.get(s.host) ?? 0) + 1)
    return counts
  }, [fleet])
  const summary = useMemo(() => listView(fleet, { status: 'all' }).counts, [fleet])

  const unreachable = hosts.filter((h) => h.ok === false && (host == null || h.name === host))

  let note: { text: string; error?: boolean }
  if (!fleet && refreshing) note = { text: 'loading…' }
  else if (error) note = { text: 'offline — retrying', error: true }
  else if (refreshing) note = { text: 'refreshing…' }
  else note = { text: fleetAt ? `updated ${relTime(fleetAt, now)} ago` : '' }

  return (
    <div className="flex min-h-app flex-col">
      <ScreenHeader>
        <div className="flex min-h-8 items-center gap-2.5">
          <h1 className="text-xl font-bold tracking-tight">Fleet</h1>
          {fleet ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums" aria-label="Status summary">
              {summary.waiting > 0 ? (
                <span className="flex items-center gap-1 font-semibold text-status-waiting">
                  <StatusDot status="waiting" className="size-2" />
                  {summary.waiting}
                </span>
              ) : null}
              <span className="flex items-center gap-1">
                <StatusDot status="busy" className="size-2" />
                {summary.busy}
              </span>
              <span className="flex items-center gap-1">
                <StatusDot status="idle" className="size-2" />
                {summary.idle}
              </span>
            </div>
          ) : null}
          <span
            className={cn('ml-auto text-right text-xs tabular-nums', note.error ? 'text-destructive' : 'text-dimmer')}
            aria-live="polite"
          >
            {note.text}
          </span>
          {/* Phase 2: the "+" New-session button goes here. */}
        </div>

        <div className="relative mt-2">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-dimmer" />
          <Input
            type="search"
            inputMode="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="Search name, title, cwd…"
            aria-label="Search sessions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-11 rounded-xl bg-card pr-10 pl-9 text-base md:text-base [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery('')}
              className="absolute inset-y-0 right-0 grid w-11 place-items-center text-dimmer"
            >
              <XIcon className="size-4" />
            </button>
          ) : null}
        </div>

        <ToggleGroup
          type="single"
          value={status}
          onValueChange={(v) => v && setStatus(v as StatusFilterId)}
          aria-label="Filter by status"
          className="no-scrollbar mt-2 w-full overflow-x-auto"
        >
          {STATUS_FILTERS.map((f) => (
            <ToggleGroupItem key={f.id} value={f.id} className={chipClass}>
              {f.label}
              <span className="text-xs text-dimmer tabular-nums group-data-[state=on]/toggle:text-accent-foreground/70">
                {fleet ? view.counts[f.id] : ''}
              </span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        {hostNames.length > 1 ? (
          <ToggleGroup
            type="single"
            value={host ?? ALL_HOSTS}
            onValueChange={(v) => v && setHostFilter(v)}
            aria-label="Filter by host"
            className="no-scrollbar mt-2 w-full overflow-x-auto"
          >
            <ToggleGroupItem value={ALL_HOSTS} className={cn(chipClass, 'h-8 text-[13px]')}>
              All hosts
            </ToggleGroupItem>
            {hosts.map((h) => (
              <ToggleGroupItem key={h.name} value={h.name} className={cn(chipClass, 'h-8 text-[13px]')}>
                <HostDot host={h.name} />
                <span className={cn(h.ok === false && 'text-destructive')}>{h.name}</span>
                <span className="text-xs text-dimmer tabular-nums">{h.ok === false ? '!' : (hostCounts.get(h.name) ?? 0)}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : null}
      </ScreenHeader>

      <main className="flex-1 pb-safe px-safe">
        <div className="mx-auto w-full max-w-3xl px-3 pt-2 pb-8">
          {error ? (
            <Alert variant="destructive" className="my-2">
              <AlertDescription>
                {fleet ? `Refresh failed: ${error} — showing last known data` : `Could not reach fleet web: ${error}`}
              </AlertDescription>
            </Alert>
          ) : null}

          {unreachable.map((h) => (
            <Alert key={h.name} variant="destructive" className="my-2">
              <AlertDescription className="break-words">
                {h.name} unreachable: {h.error || 'no response'}
              </AlertDescription>
            </Alert>
          ))}

          {!fleet ? (
            <SessionListSkeleton />
          ) : view.sessions.length > 0 ? (
            <div className="flex flex-col gap-2">
              {view.sessions.map((s) => (
                <SessionRow key={`${s.host}/${s.session_id}`} session={s} now={now} />
              ))}
            </div>
          ) : unreachable.length === 0 ? (
            <EmptyState anySessions={allSessions(fleet).length > 0} />
          ) : null}
        </div>
      </main>
    </div>
  )
}

function EmptyState({ anySessions }: { anySessions: boolean }) {
  return (
    <div className="px-4 py-10 text-center text-sm text-dimmer">
      {anySessions ? 'Nothing matches.' : 'No Claude sessions running.'}
    </div>
  )
}
