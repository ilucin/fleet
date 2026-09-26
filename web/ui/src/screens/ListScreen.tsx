import { useMemo, useState } from 'react'
import { PlusIcon, SearchIcon, XIcon } from 'lucide-react'
import { useLocation } from 'wouter'

import { GroupedList } from '@/components/board/GroupedList'
import { GroupsStatus } from '@/components/board/GroupsStatus'
import { HostDot } from '@/components/HostBadge'
import { NewSessionDrawer } from '@/components/NewSessionDrawer'
import { ScreenHeader } from '@/components/ScreenHeader'
import { SessionListSkeleton } from '@/components/SessionListSkeleton'
import { SessionRow } from '@/components/SessionRow'
import { StatusDot } from '@/components/StatusDot'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ViewToggle } from '@/components/ViewToggle'
import { useGroups, useViewMode } from '@/hooks/useGroups'
import { useNow } from '@/hooks/useNow'
import { ALL_HOSTS, useSessionList } from '@/hooks/useSessionList'
import { boardColumns, effectiveGroups } from '@/lib/groups'
import { STATUS_FILTERS, allSessions, type StatusFilterId } from '@/lib/sessions'
import { cn } from '@/lib/utils'

const chipClass = cn(
  'h-9 shrink-0 gap-1.5 rounded-full border border-border bg-card px-3.5 text-sm text-muted-foreground',
  'data-[state=on]:border-primary/50 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground',
)

export function ListScreen() {
  const now = useNow(1000)
  const { fleet, error, query, setQuery, status, setStatus, setHostFilter, hosts, hostNames, host, view, hostCounts, summary, unreachable, note } =
    useSessionList(now)
  const [newOpen, setNewOpen] = useState(false)
  const [, navigate] = useLocation()
  const [mode, setMode] = useViewMode()
  const board = mode === 'board'
  const groups = useGroups(board)
  const columns = useMemo(
    () => (board ? boardColumns(view.sessions, effectiveGroups(groups.groups, allSessions(fleet)).groups) : []),
    [board, view.sessions, groups.groups, fleet],
  )

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
          <Button
            size="icon"
            aria-label="New session"
            title="New session"
            onClick={() => setNewOpen(true)}
            className="-my-1 size-10 shrink-0 rounded-full [&_svg:not([class*='size-'])]:size-5"
          >
            <PlusIcon />
          </Button>
        </div>

        <div className="mt-2 flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
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
          <ViewToggle value={mode} onChange={setMode} size="lg" />
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

        {board ? <GroupsStatus state={groups} now={now} size="lg" className="mt-1 -mb-1 justify-between" /> : null}
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
          ) : board && columns.length > 0 ? (
            <GroupedList columns={columns} now={now} />
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

      <NewSessionDrawer open={newOpen} onOpenChange={setNewOpen} onOpenSession={(href) => navigate(href)} />
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
