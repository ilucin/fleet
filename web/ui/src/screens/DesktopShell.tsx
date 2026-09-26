import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  FilterIcon,
  KeyboardIcon,
  MessageSquareTextIcon,
  MonitorIcon,
  MoonIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PlusIcon,
  RefreshCwIcon,
  SquareTerminalIcon,
  SunIcon,
} from 'lucide-react'
import { Redirect, useLocation, useRoute } from 'wouter'

import type { Session } from '@/api/types'
import { CommandPalette, type PaletteAction } from '@/components/desktop/CommandPalette'
import { ShortcutsDialog } from '@/components/desktop/ShortcutsDialog'
import { Sidebar, SidebarRail } from '@/components/desktop/Sidebar'
import { NewSessionDialog } from '@/components/NewSessionDrawer'
import { StatusDot } from '@/components/StatusDot'
import { Kbd } from '@/components/ui/kbd'
import { useFleet } from '@/hooks/useFleet'
import { WIDE_QUERY } from '@/hooks/useMediaQuery'
import { useNow } from '@/hooks/useNow'
import { usePersistentState } from '@/hooks/usePersistentState'
import { useSessionList } from '@/hooks/useSessionList'
import { useTheme } from '@/hooks/useTheme'
import { STATUS_FILTERS, allSessions, byLastActivity, findSession, sessionHref, statusLabel } from '@/lib/sessions'
import { clampSidebarWidth, SIDEBAR_DEFAULT_W, SIDEBAR_MAX_W, SIDEBAR_MIN_W } from '@/lib/layout'
import { isMacPlatform, isTypingTarget, matchShortcut, sessionKey, stepCursor, type ShortcutAction } from '@/lib/shortcuts'
import { cn } from '@/lib/utils'
import { SessionScreen, type PaneApi } from '@/screens/SessionScreen'

const parseBool01 = (raw: string) => (raw === '1' ? true : raw === '0' ? false : undefined)
const CHORD_MS = 1200

/**
 * ≥ lg: master–detail. Resizable / collapsible sidebar (the session list) + the selected
 * session as a pane (+ an optional details column). Same hash routes as mobile:
 * `#/` = nothing selected, `#/s/:host/:id` = that session open. One window keydown
 * listener drives the keyboard shortcuts (lib/shortcuts.ts).
 */
export function DesktopShell() {
  const now = useNow(1000)
  const list = useSessionList(now)
  const { fleet, refresh } = useFleet()
  const { setTheme } = useTheme()
  const [location, navigate] = useLocation()
  const [match, params] = useRoute('/s/:host/:id')
  const selected = match ? { host: params.host, id: params.id } : null
  const selectedKey = selected ? `${selected.host}/${selected.id}` : null
  const selectedSession = selected ? findSession(fleet, selected.host, selected.id) : null

  const [sidebarRaw, setSidebarRaw] = usePersistentState<string>('fleet.sidebar', '1', (r) => (parseBool01(r) === undefined ? undefined : r))
  const sidebarOpen = sidebarRaw === '1'
  const [sidebarW, setSidebarW] = usePersistentState<number>('fleet.sidebarWidth', SIDEBAR_DEFAULT_W, (r) => clampSidebarWidth(Number(r)))
  const [inspectorRaw, setInspectorRaw] = usePersistentState<string>(
    'fleet.inspector',
    typeof window !== 'undefined' && window.matchMedia?.(WIDE_QUERY).matches ? '1' : '0',
    (r) => (parseBool01(r) === undefined ? undefined : r),
  )
  const inspector = inspectorRaw === '1'
  const toggleSidebar = () => setSidebarRaw(sidebarOpen ? '0' : '1')
  const toggleInspector = () => setInspectorRaw(inspector ? '0' : '1')

  const [newOpen, setNewOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const modKey = isMacPlatform() ? '⌘' : 'Ctrl'

  // --- cursor (j/k) — follows the selection when it changes ------------------
  const [cursor, setCursor] = useState<string | null>(selectedKey)
  const [prevSelected, setPrevSelected] = useState(selectedKey)
  if (prevSelected !== selectedKey) {
    setPrevSelected(selectedKey)
    if (selectedKey) setCursor(selectedKey)
  }
  const keys = useMemo(() => list.view.sessions.map(sessionKey), [list.view.sessions])
  const byKey = useMemo(() => new Map(list.view.sessions.map((s) => [sessionKey(s), s])), [list.view.sessions])
  const cursorKey = cursor && keys.includes(cursor) ? cursor : null

  // Opened with Enter → the new pane focuses its composer on mount.
  const [focusOnOpen, setFocusOnOpen] = useState<string | null>(null)
  const paneRef = useRef<PaneApi | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const openSession = useCallback(
    (s: Session, focus: boolean) => {
      const key = sessionKey(s)
      setCursor(key)
      if (key === selectedKey) {
        if (focus) paneRef.current?.focusComposer()
        return
      }
      setFocusOnOpen(focus ? key : null)
      navigate(sessionHref(s))
    },
    [navigate, selectedKey],
  )

  // Focus moves that must wait for the next commit (the sidebar may be collapsed, the
  // cursor row not rendered yet). An effect, not requestAnimationFrame: rAF never fires
  // in a background tab, and a late focus would steal the caret from the composer.
  const [focusReq, setFocusReq] = useState<{ to: 'search' | 'row'; key?: string; n: number } | null>(null)
  useEffect(() => {
    if (!focusReq) return
    if (focusReq.to === 'search') {
      searchRef.current?.focus()
      searchRef.current?.select()
    } else if (focusReq.key) {
      document.querySelector<HTMLElement>(`[data-session-list] [data-session-key="${CSS.escape(focusReq.key)}"]`)?.focus()
    }
  }, [focusReq])

  const focusSearch = () => {
    if (!sidebarOpen) setSidebarRaw('1')
    setFocusReq((r) => ({ to: 'search', n: (r?.n ?? 0) + 1 }))
  }

  const moveCursor = (delta: number) => {
    const next = stepCursor(keys, cursorKey ?? selectedKey, delta)
    setCursor(next)
    // Keyboard focus on a row follows the cursor (Tab-then-j/k stays coherent).
    if (next && document.activeElement?.closest('[data-session-list]')) setFocusReq((r) => ({ to: 'row', key: next, n: (r?.n ?? 0) + 1 }))
  }

  // --- document title: "(2) name · Fleet" -------------------------------------
  const waiting = list.summary.waiting
  useEffect(() => {
    const name = selectedSession?.name
    document.title = `${waiting > 0 ? `(${waiting}) ` : ''}${name ? `${name} · ` : ''}Fleet`
  }, [waiting, selectedSession?.name])
  useEffect(() => () => void (document.title = 'Fleet'), [])

  // --- keyboard ----------------------------------------------------------------
  const pending = useRef<{ key: string; at: number } | null>(null)
  const dialogOpen = newOpen || paletteOpen || helpOpen

  const run = (action: ShortcutAction, target: HTMLElement | null): boolean => {
    const cur = cursorKey ? byKey.get(cursorKey) : null
    switch (action) {
      case 'next':
        moveCursor(1)
        return true
      case 'prev':
        moveCursor(-1)
        return true
      case 'first':
        setCursor(keys[0] ?? null)
        return true
      case 'last':
        setCursor(keys[keys.length - 1] ?? null)
        return true
      case 'open':
      case 'openAndReply': {
        // A focused link / button handles Enter itself.
        if (action === 'openAndReply' && target?.closest('a, button, [role="button"], [role="radio"], [role="option"], [role="switch"]'))
          return false
        const s = cur ?? (selectedKey ? null : list.view.sessions[0])
        if (s) openSession(s, action === 'openAndReply')
        else if (selectedKey && action === 'openAndReply') paneRef.current?.focusComposer()
        return true
      }
      case 'reply':
        paneRef.current?.focusComposer()
        return !!paneRef.current
      case 'search':
        focusSearch()
        return true
      case 'new':
        setNewOpen(true)
        return true
      case 'back':
        if (selectedKey) {
          navigate('/')
          return true
        }
        return false
      case 'blur':
        target?.blur()
        return true
      case 'chat':
      case 'term':
        paneRef.current?.setMode(action)
        return !!paneRef.current
      case 'sidebar':
        toggleSidebar()
        return true
      case 'inspector':
        if (!selectedKey) return false
        toggleInspector()
        return true
      case 'palette':
        setPaletteOpen((o) => !o)
        return true
      case 'help':
        setHelpOpen(true)
        return true
      case 'refresh':
        refresh()
        return true
    }
  }
  const runRef = useRef(run)
  useEffect(() => {
    runRef.current = run
  })
  const dialogOpenRef = useRef(dialogOpen)
  useEffect(() => {
    dialogOpenRef.current = dialogOpen
  }, [dialogOpen])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const target = (e.target instanceof HTMLElement ? e.target : null) as HTMLElement | null
      const anyDialog = dialogOpenRef.current || !!document.querySelector('[role="dialog"][data-state="open"], [data-vaul-drawer][data-state="open"]')
      const typing = isTypingTarget(target)
      const arrowsFree = !target || target === document.body || !!target.closest('[data-session-list]')
      const p = pending.current && Date.now() - pending.current.at < CHORD_MS ? pending.current.key : null
      const res = matchShortcut(e, { typing, arrowsFree, pending: p })
      pending.current = res.pending ? { key: res.pending, at: Date.now() } : null
      if (!res.action) return
      // With a dialog open only ⌘K toggles the palette; the dialog owns every other key.
      if (anyDialog && res.action !== 'palette') return
      if (runRef.current(res.action, target)) e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // --- sidebar resize ------------------------------------------------------------
  const drag = useRef<{ x: number; w: number } | null>(null)
  const onResizeDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, w: sidebarW }
  }
  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    setSidebarW(clampSidebarWidth(drag.current.w + e.clientX - drag.current.x))
  }
  const onResizeUp = () => {
    drag.current = null
  }

  // --- palette actions -----------------------------------------------------------
  const paletteSessions = useMemo(() => allSessions(fleet).sort(byLastActivity), [fleet])
  const actions: { heading: string; items: PaletteAction[] }[] = [
    {
      heading: 'Actions',
      items: [
        { id: 'new', label: 'New session…', icon: <PlusIcon />, shortcut: 'C', keywords: ['spawn', 'start'], run: () => setNewOpen(true) },
        ...(selectedKey
          ? [
              { id: 'chat', label: 'Chat view', icon: <MessageSquareTextIcon />, shortcut: 'G C', run: () => paneRef.current?.setMode('chat') },
              { id: 'term', label: 'Terminal view', icon: <SquareTerminalIcon />, shortcut: 'G T', run: () => paneRef.current?.setMode('term') },
              {
                id: 'inspector',
                label: inspector ? 'Hide details panel' : 'Show details panel',
                icon: <PanelRightIcon />,
                shortcut: 'I',
                run: toggleInspector,
              },
            ]
          : []),
        { id: 'sidebar', label: sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar', icon: <PanelLeftIcon />, shortcut: '[', run: toggleSidebar },
        { id: 'refresh', label: 'Refresh now', icon: <RefreshCwIcon />, shortcut: 'G R', run: refresh },
        { id: 'help', label: 'Keyboard shortcuts', icon: <KeyboardIcon />, shortcut: '?', run: () => setHelpOpen(true) },
      ],
    },
    {
      heading: 'Filter',
      items: STATUS_FILTERS.map((f) => ({
        id: `filter-${f.id}`,
        label: `Show: ${f.label}`,
        icon: <FilterIcon />,
        keywords: ['filter', 'status'],
        run: () => list.setStatus(f.id),
      })),
    },
    {
      heading: 'Theme',
      items: [
        { id: 'theme-system', label: 'Theme: system', icon: <MonitorIcon />, run: () => setTheme('system') },
        { id: 'theme-dark', label: 'Theme: dark', icon: <MoonIcon />, run: () => setTheme('dark') },
        { id: 'theme-light', label: 'Theme: light', icon: <SunIcon />, run: () => setTheme('light') },
      ],
    },
  ]

  // Anything but `/` and `/s/:host/:id` → the list (same as mobile).
  if (!match && location !== '/') return <Redirect to="/" replace />

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      {sidebarOpen ? (
        <aside aria-label="Session list" className="relative shrink-0 border-r bg-background" style={{ width: sidebarW }}>
          <Sidebar
            list={list}
            now={now}
            cursorKey={cursorKey}
            selectedKey={selectedKey}
            modKey={modKey}
            searchRef={searchRef}
            onSearchNav={(a) => {
              if (a === 'open') {
                const s = (cursorKey && byKey.get(cursorKey)) || list.view.sessions[0]
                if (s) openSession(s, true)
              } else moveCursor(a === 'next' ? 1 : -1)
            }}
            onNew={() => setNewOpen(true)}
            onCollapse={toggleSidebar}
            onPalette={() => setPaletteOpen(true)}
            onHelp={() => setHelpOpen(true)}
          />
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuemin={SIDEBAR_MIN_W}
            aria-valuemax={SIDEBAR_MAX_W}
            aria-valuenow={sidebarW}
            tabIndex={0}
            title="Drag to resize · double-click to reset"
            onPointerDown={onResizeDown}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onPointerCancel={onResizeUp}
            onDoubleClick={() => setSidebarW(SIDEBAR_DEFAULT_W)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault()
                setSidebarW(clampSidebarWidth(sidebarW + (e.key === 'ArrowRight' ? 24 : -24)))
              }
            }}
            className={cn(
              'absolute inset-y-0 -right-1 z-30 w-2 cursor-col-resize touch-none outline-none',
              'after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:transition-colors',
              'hover:after:w-0.5 hover:after:bg-primary/50 focus-visible:after:w-0.5 focus-visible:after:bg-ring',
            )}
          />
        </aside>
      ) : (
        <SidebarRail
          waiting={waiting}
          onExpand={toggleSidebar}
          onNew={() => setNewOpen(true)}
          onPalette={() => setPaletteOpen(true)}
          onHelp={() => setHelpOpen(true)}
        />
      )}

      <main className="flex min-w-0 flex-1">
        {selected ? (
          <SessionScreen
            key={selectedKey}
            host={selected.host}
            id={selected.id}
            layout="pane"
            inspector={inspector}
            onToggleInspector={toggleInspector}
            paneRef={paneRef}
            autoFocusComposer={focusOnOpen === selectedKey}
          />
        ) : (
          <EmptyPane
            waitingSessions={paletteSessions.filter((s) => s.status === 'waiting').slice(0, 6)}
            modKey={modKey}
            onOpen={(s) => openSession(s, true)}
          />
        )}
      </main>

      <NewSessionDialog open={newOpen} onOpenChange={setNewOpen} onOpenSession={(href) => navigate(href)} />
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        sessions={paletteSessions}
        selectedKey={selectedKey}
        onOpenSession={(s) => openSession(s, false)}
        actions={actions}
      />
      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} modKey={modKey} />
    </div>
  )
}

function EmptyPane({ waitingSessions, modKey, onOpen }: { waitingSessions: Session[]; modKey: string; onOpen: (s: Session) => void }) {
  const hints: [string[], string][] = [
    [['j', 'k'], 'move'],
    [['Enter'], 'open'],
    [['/'], 'search'],
    [['c'], 'new session'],
    [[`${modKey}K`], 'jump'],
    [['?'], 'all shortcuts'],
  ]
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
      <div>
        <p className="text-base font-semibold">No session open</p>
        <p className="mt-1 text-sm text-dimmer">Pick one from the list, or use the keyboard.</p>
      </div>
      <ul className="flex flex-wrap justify-center gap-x-4 gap-y-2 text-xs text-muted-foreground" aria-label="Keyboard hints">
        {hints.map(([ks, label]) => (
          <li key={label} className="flex items-center gap-1">
            {ks.map((k) => (
              <Kbd key={k}>{k}</Kbd>
            ))}
            <span className="ml-0.5">{label}</span>
          </li>
        ))}
      </ul>
      {waitingSessions.length ? (
        <section aria-label="Needs you" className="w-full max-w-md text-left">
          <h2 className="pb-1.5 text-[11px] font-semibold tracking-wider text-status-waiting uppercase">Needs you</h2>
          <div className="flex flex-col gap-1.5">
            {waitingSessions.map((s) => (
              <button
                key={sessionKey(s)}
                type="button"
                onClick={() => onOpen(s)}
                className="flex items-center gap-2 rounded-lg border border-status-waiting/35 bg-card px-3 py-2 text-left text-sm outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <StatusDot status={s.status} className="size-2" />
                <span className="min-w-0 flex-1 truncate font-medium">{s.name || '(unnamed)'}</span>
                <span className="shrink-0 truncate text-xs text-status-waiting">{statusLabel(s)}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
