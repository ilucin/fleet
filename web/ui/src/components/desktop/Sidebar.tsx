import { useEffect, useRef, type KeyboardEvent, type Ref } from 'react'
import { CommandIcon, KeyboardIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, PlusIcon, SearchIcon, XIcon } from 'lucide-react'

import { HostDot } from '@/components/HostBadge'
import { SessionListSkeleton } from '@/components/SessionListSkeleton'
import { SessionRow } from '@/components/SessionRow'
import { StatusDot } from '@/components/StatusDot'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ALL_HOSTS, type SessionListState } from '@/hooks/useSessionList'
import { STATUS_FILTERS, allSessions, type StatusFilterId } from '@/lib/sessions'
import { sessionKey } from '@/lib/shortcuts'
import { cn } from '@/lib/utils'

const chip = cn(
  'h-7 shrink-0 gap-1 rounded-full border border-border bg-card px-2.5 text-xs text-muted-foreground',
  'data-[state=on]:border-primary/50 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground',
)

export interface SidebarProps {
  list: SessionListState
  now: number
  cursorKey: string | null
  selectedKey: string | null
  modKey: string
  searchRef: Ref<HTMLInputElement>
  /** ↑ / ↓ / Enter inside the search field drive the list cursor. */
  onSearchNav: (action: 'next' | 'prev' | 'open') => void
  onNew: () => void
  onCollapse: () => void
  onPalette: () => void
  onHelp: () => void
}

/** Desktop left column: header + summary, search, status/host filters, the session list. */
export function Sidebar({ list, now, cursorKey, selectedKey, modKey, searchRef, onSearchNav, onNew, onCollapse, onPalette, onHelp }: SidebarProps) {
  const { fleet, error, query, setQuery, status, setStatus, setHostFilter, hosts, hostNames, host, view, hostCounts, summary, unreachable, note } = list
  const listRef = useRef<HTMLDivElement>(null)

  // Keep the cursor row visible (j/k past the edge).
  useEffect(() => {
    if (!cursorKey) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-session-key="${CSS.escape(cursorKey)}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [cursorKey])

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      onSearchNav(e.key === 'ArrowDown' ? 'next' : 'prev')
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onSearchNav('open')
    } else if (e.key === 'Escape' && query) {
      // First Esc clears, the second leaves the field (window handler).
      e.preventDefault()
      e.stopPropagation()
      setQuery('')
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="shrink-0 space-y-2 border-b px-3 pt-3 pb-2.5">
        <div className="flex min-h-8 items-center gap-2">
          <h1 className="text-lg font-bold tracking-tight">Fleet</h1>
          {fleet ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums" aria-label="Status summary">
              {summary.waiting > 0 ? (
                <span className="flex items-center gap-1 font-semibold text-status-waiting" title="Needs you">
                  <StatusDot status="waiting" className="size-2" />
                  {summary.waiting}
                </span>
              ) : null}
              <span className="flex items-center gap-1" title="Busy">
                <StatusDot status="busy" className="size-2" />
                {summary.busy}
              </span>
              <span className="flex items-center gap-1" title="Idle">
                <StatusDot status="idle" className="size-2" />
                {summary.idle}
              </span>
            </div>
          ) : null}
          <span
            className={cn('ml-auto truncate text-right text-[11px] tabular-nums', note.error ? 'text-destructive' : 'text-dimmer')}
            aria-live="polite"
          >
            {note.text}
          </span>
          <Button size="icon" aria-label="New session" title="New session (c)" onClick={onNew} className="shrink-0 rounded-full">
            <PlusIcon />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Collapse sidebar" title="Collapse sidebar ([)" onClick={onCollapse} className="shrink-0">
            <PanelLeftCloseIcon />
          </Button>
        </div>

        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-dimmer" />
          <Input
            ref={searchRef}
            type="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="Search name, title, cwd…"
            aria-label="Search sessions"
            aria-keyshortcuts="/"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            className="h-9 rounded-lg bg-card pr-9 pl-8 [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery('')}
              className="absolute inset-y-0 right-0 grid w-9 place-items-center rounded-r-lg text-dimmer outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <XIcon className="size-4" />
            </button>
          ) : (
            <Kbd className="absolute top-1/2 right-2 -translate-y-1/2">/</Kbd>
          )}
        </div>

        <ToggleGroup
          type="single"
          value={status}
          onValueChange={(v) => v && setStatus(v as StatusFilterId)}
          aria-label="Filter by status"
          className="no-scrollbar w-full flex-wrap"
        >
          {STATUS_FILTERS.map((f) => (
            <ToggleGroupItem key={f.id} value={f.id} className={chip}>
              {f.label}
              <span className="text-[11px] text-dimmer tabular-nums group-data-[state=on]/toggle:text-accent-foreground/70">
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
            className="no-scrollbar w-full flex-wrap"
          >
            <ToggleGroupItem value={ALL_HOSTS} className={chip}>
              All hosts
            </ToggleGroupItem>
            {hosts.map((h) => (
              <ToggleGroupItem key={h.name} value={h.name} className={chip}>
                <HostDot host={h.name} />
                <span className={cn(h.ok === false && 'text-destructive')}>{h.name}</span>
                <span className="text-[11px] text-dimmer tabular-nums">{h.ok === false ? '!' : (hostCounts.get(h.name) ?? 0)}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : null}
      </div>

      <div ref={listRef} data-session-list className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
        {error ? (
          <Alert variant="destructive" className="mb-2">
            <AlertDescription>
              {fleet ? `Refresh failed: ${error} — showing last known data` : `Could not reach fleet web: ${error}`}
            </AlertDescription>
          </Alert>
        ) : null}
        {unreachable.map((h) => (
          <Alert key={h.name} variant="destructive" className="mb-2">
            <AlertDescription className="break-words">
              {h.name} unreachable: {h.error || 'no response'}
            </AlertDescription>
          </Alert>
        ))}
        {!fleet ? (
          <SessionListSkeleton />
        ) : view.sessions.length > 0 ? (
          <nav aria-label="Sessions" className="flex flex-col gap-1.5">
            {view.sessions.map((s) => {
              const key = sessionKey(s)
              return <SessionRow key={key} session={s} now={now} selected={key === selectedKey} cursor={key === cursorKey && key !== selectedKey} />
            })}
          </nav>
        ) : unreachable.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-dimmer">
            {allSessions(fleet).length > 0 ? 'Nothing matches.' : 'No Claude sessions running.'}
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1 border-t px-2 py-1.5 text-xs text-dimmer">
        <Button variant="ghost" size="sm" onClick={onPalette} className="text-dimmer hover:text-foreground">
          <CommandIcon /> Jump
          <Kbd className="ml-1">{modKey}K</Kbd>
        </Button>
        <Button variant="ghost" size="sm" onClick={onHelp} className="ml-auto text-dimmer hover:text-foreground">
          <KeyboardIcon /> Shortcuts
          <Kbd className="ml-1">?</Kbd>
        </Button>
      </div>
    </div>
  )
}

/** The collapsed sidebar: a thin rail with the essentials. */
export function SidebarRail({
  waiting,
  onExpand,
  onNew,
  onPalette,
  onHelp,
}: {
  waiting: number
  onExpand: () => void
  onNew: () => void
  onPalette: () => void
  onHelp: () => void
}) {
  return (
    <div className="flex h-full w-12 shrink-0 flex-col items-center gap-1 border-r py-3">
      <Button variant="ghost" size="icon" aria-label="Expand sidebar" title="Expand sidebar ([)" onClick={onExpand}>
        <PanelLeftOpenIcon />
      </Button>
      <Button size="icon" aria-label="New session" title="New session (c)" onClick={onNew} className="rounded-full">
        <PlusIcon />
      </Button>
      <Button variant="ghost" size="icon" aria-label="Jump to a session" title="Jump to a session (⌘K)" onClick={onPalette}>
        <SearchIcon />
      </Button>
      {waiting > 0 ? (
        <span
          className="mt-1 flex items-center gap-1 text-xs font-semibold text-status-waiting tabular-nums"
          title={`${waiting} need you`}
          aria-label={`${waiting} sessions need you`}
        >
          <StatusDot status="waiting" className="size-2" />
          {waiting}
        </span>
      ) : null}
      <Button variant="ghost" size="icon" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={onHelp} className="mt-auto">
        <KeyboardIcon />
      </Button>
    </div>
  )
}
