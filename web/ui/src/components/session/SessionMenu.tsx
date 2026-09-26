import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AArrowDownIcon,
  AArrowUpIcon,
  Loader2Icon,
  MessageSquareTextIcon,
  MonitorIcon,
  MoonIcon,
  PowerIcon,
  SparklesIcon,
  SquareTerminalIcon,
  SunIcon,
} from 'lucide-react'
import { toast } from 'sonner'

import { api, sessionErrorMessage } from '@/api/client'
import type { AutoNameRun, Session } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTheme, type ThemeChoice } from '@/hooks/useTheme'
import { autoNameSummary, autoNameToast } from '@/lib/autoname'
import type { DetailMode } from '@/lib/chat'
import { ctxLevel, ctxSummary, relTime, shortCwd } from '@/lib/format'
import { CTX_TEXT } from '@/lib/styles'
import { cn } from '@/lib/utils'

// Last naming pass per host seen by this tab (a peer's /api/health is not reachable
// through the proxy, so for peers this is only what "Run now" returned).
const lastRuns = new Map<string, AutoNameRun>()

export interface SessionMenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  host: string
  id: string
  session: Session | null
  isSelfHost: boolean
  mode: DetailMode
  onMode: (m: DetailMode) => void
  hideNotes: boolean
  onHideNotes: (v: boolean) => void
  fontSize: number
  fontSizes: readonly number[]
  onFont: (dir: 1 | -1) => void
  termLines: number
  onTermLines: (n: number) => void
  /** Called after a successful close (navigate away). */
  onClosed: () => void
}

const segItem =
  'h-9 flex-1 gap-1.5 rounded-md px-3 text-[13px] text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm dark:data-[state=on]:bg-accent'

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {hint ? <div className="truncate text-xs text-dimmer">{hint}</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{children}</div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="py-1">
      <h3 className="pt-2 pb-1 text-[11px] font-semibold tracking-wider text-dimmer uppercase">{title}</h3>
      <div className="divide-y divide-border/60">{children}</div>
    </section>
  )
}

/** ⋯ on mobile: the session menu as a bottom drawer. */
export function SessionMenu(p: SessionMenuProps) {
  // Closing the drawer unmounts the body, which disarms "Close session".
  return (
    <Drawer open={p.open} onOpenChange={p.onOpenChange}>
      <DrawerContent className="px-safe">
        <SessionMenuBody {...p} variant="drawer" />
      </DrawerContent>
    </Drawer>
  )
}

/**
 * The menu's content: header (name, host · cwd, context), View, Session (auto-name,
 * details, close). `drawer` = inside the mobile drawer; `panel` = the desktop details
 * column (always open, click-to-confirm wording, no drawer chrome).
 */
export function SessionMenuBody(p: SessionMenuProps & { variant: 'drawer' | 'panel' }) {
  const panel = p.variant === 'panel'
  const { theme, setTheme } = useTheme()
  const [lastRun, setLastRun] = useState<AutoNameRun | null>(() => lastRuns.get(p.host) ?? null)
  const [autoName, setAutoName] = useState<{ enabled: boolean; intervalMinutes: number } | null>(null)
  const [naming, setNaming] = useState(false)

  // Last run + schedule for this host's server (only answerable for self).
  useEffect(() => {
    if (!p.open || !p.isSelfHost) return
    const ctl = new AbortController()
    api
      .health({ signal: ctl.signal })
      .then((h) => {
        setAutoName({ enabled: h.autoName?.enabled === true, intervalMinutes: h.autoName?.intervalMinutes ?? 5 })
        const run = h.autoName?.lastRun
        if (run) {
          lastRuns.set(p.host, run)
          setLastRun(run)
        }
      })
      .catch(() => {})
    return () => ctl.abort()
  }, [p.open, p.isSelfHost, p.host])

  const runNow = async () => {
    if (naming) return
    setNaming(true)
    try {
      const run = await api.autoname(p.host)
      lastRuns.set(p.host, run)
      setLastRun(run)
      toast(autoNameToast(run))
    } catch (err) {
      toast.error((err as Error)?.message || 'Naming failed')
    } finally {
      setNaming(false)
    }
  }

  // Close: two taps. The first arms (for 5s), the second kills Claude + its terminal.
  const [armed, setArmed] = useState(false)
  const [closing, setClosing] = useState(false)
  const armTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(armTimer.current), [])
  const onOpenChange = (open: boolean) => {
    if (!open && !closing) {
      clearTimeout(armTimer.current)
      setArmed(false)
    }
    p.onOpenChange(open)
  }

  const closeSession = async () => {
    if (closing) return
    if (!armed) {
      setArmed(true)
      clearTimeout(armTimer.current)
      armTimer.current = setTimeout(() => setArmed(false), 5000)
      return
    }
    clearTimeout(armTimer.current)
    setClosing(true)
    try {
      const res = await api.kill(p.host, p.id)
      toast.success(`Closed ${res.name || p.id.slice(0, 8)}`, { description: String(res.terminal || 'done').replace(/-/g, ' ') })
      onOpenChange(false)
      p.onClosed()
    } catch (err) {
      toast.error('Close failed', { description: sessionErrorMessage(err) })
      setClosing(false)
      setArmed(false)
    }
  }

  const s = p.session
  const lastRunHint = lastRun?.at
    ? `last run ${relTime(lastRun.at)} ago · ${autoNameSummary(lastRun)}`
    : autoName
      ? autoName.enabled
        ? `every ${autoName.intervalMinutes} min · not run yet`
        : 'scheduled runs off'
      : `on ${p.host}`

  const Header = panel ? 'div' : DrawerHeader
  const Title = panel ? 'h2' : DrawerTitle
  const Description = panel ? 'p' : DrawerDescription

  return (
        <div
          className={
            panel
              ? 'no-scrollbar h-full w-full overflow-y-auto px-4 pb-4'
              : 'no-scrollbar mx-auto w-full max-w-lg overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))]'
          }
        >
          <Header className={panel ? 'flex flex-col gap-0.5 pt-3 pb-1 text-left' : 'px-0 pt-3 pb-1 text-left'}>
            <Title className="truncate text-left text-base font-semibold">{s?.name || p.id.slice(0, 8)}</Title>
            <Description className={cn('truncate text-left font-mono text-xs', panel && 'text-muted-foreground')} title={panel ? (s?.cwd ?? undefined) : undefined}>
              {[p.host, s?.cwd ? shortCwd(s.cwd, 60) : null].filter(Boolean).join(' · ')}
            </Description>
            {s?.context ? (
              <p className={cn('truncate text-left text-xs tabular-nums', CTX_TEXT[ctxLevel(s.context.pct)])}>
                Context {ctxSummary(s.context)}
                {s.context.model ? <span className="text-dimmer"> · {s.context.model}</span> : null}
              </p>
            ) : null}
          </Header>

          <Section title="View">
            <div className="py-2">
              <ToggleGroup
                type="single"
                value={p.mode}
                onValueChange={(v) => v && p.onMode(v as DetailMode)}
                spacing={0}
                aria-label="View mode"
                className="w-full rounded-lg bg-muted p-1"
              >
                <ToggleGroupItem value="chat" className={segItem}>
                  <MessageSquareTextIcon /> Chat
                </ToggleGroupItem>
                <ToggleGroupItem value="term" className={segItem}>
                  <SquareTerminalIcon /> Terminal
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
            {p.mode === 'chat' ? (
              <Row label="Progress notes" hint="Narration between tool calls">
                <Switch checked={!p.hideNotes} onCheckedChange={(v) => p.onHideNotes(!v)} aria-label="Show progress notes" />
              </Row>
            ) : (
              <Row label="Scrollback" hint="Lines captured from the pane">
                <ToggleGroup
                  type="single"
                  value={String(p.termLines)}
                  onValueChange={(v) => v && p.onTermLines(Number(v))}
                  spacing={0}
                  className="rounded-lg bg-muted p-1"
                >
                  {[200, 600].map((n) => (
                    <ToggleGroupItem key={n} value={String(n)} className={cn(segItem, 'h-8 flex-none px-3 tabular-nums')}>
                      {n}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Row>
            )}
            <Row label="Text size" hint={p.mode === 'chat' ? 'Conversation' : 'Terminal'}>
              <Button
                variant="outline"
                size="icon-lg"
                aria-label="Smaller text"
                disabled={p.fontSize === p.fontSizes[0]}
                onClick={() => p.onFont(-1)}
              >
                <AArrowDownIcon />
              </Button>
              <span className="w-10 text-center text-xs text-muted-foreground tabular-nums">{p.fontSize}px</span>
              <Button
                variant="outline"
                size="icon-lg"
                aria-label="Larger text"
                disabled={p.fontSize === p.fontSizes[p.fontSizes.length - 1]}
                onClick={() => p.onFont(1)}
              >
                <AArrowUpIcon />
              </Button>
            </Row>
            <Row label="Theme">
              <ToggleGroup
                type="single"
                value={theme}
                onValueChange={(v) => v && setTheme(v as ThemeChoice)}
                spacing={0}
                aria-label="Theme"
                className="rounded-lg bg-muted p-1"
              >
                <ToggleGroupItem value="system" aria-label="System theme" className={cn(segItem, 'h-8 flex-none px-2.5')}>
                  <MonitorIcon />
                </ToggleGroupItem>
                <ToggleGroupItem value="dark" aria-label="Dark theme" className={cn(segItem, 'h-8 flex-none px-2.5')}>
                  <MoonIcon />
                </ToggleGroupItem>
                <ToggleGroupItem value="light" aria-label="Light theme" className={cn(segItem, 'h-8 flex-none px-2.5')}>
                  <SunIcon />
                </ToggleGroupItem>
              </ToggleGroup>
            </Row>
          </Section>

          <Section title="Session">
            <Row label={`Auto-name (${p.host})`} hint={lastRunHint}>
              <Button variant="outline" className="h-9 px-3" disabled={naming} onClick={runNow}>
                {naming ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />}
                {naming ? 'Naming…' : 'Run now'}
              </Button>
            </Row>
            {s ? (
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 py-3 text-xs">
                {(
                  [
                    ['tmux', s.tmux_session],
                    ['backend', s.backend],
                    ['pid', s.pid],
                    ['session', s.session_id],
                  ] as const
                )
                  .filter(([, v]) => v != null && v !== '')
                  .map(([k, v]) => (
                    <div key={k} className="contents">
                      <span className="text-dimmer">{k}</span>
                      <span className="truncate font-mono text-muted-foreground select-all">{String(v)}</span>
                    </div>
                  ))}
              </div>
            ) : null}
            <div className="py-3">
              <Button
                variant="destructive"
                className={cn('h-11 w-full text-sm', armed && 'bg-destructive text-white hover:bg-destructive/90 dark:bg-destructive dark:hover:bg-destructive/90')}
                disabled={closing}
                onClick={closeSession}
              >
                {closing ? <Loader2Icon className="animate-spin" /> : <PowerIcon />}
                {closing ? 'Closing…' : armed ? (panel ? 'Click again to close' : 'Tap again to close') : 'Close session…'}
              </Button>
              <p className="pt-1.5 text-center text-xs text-dimmer">
                Ends Claude and its {s?.backend === 'iterm' ? 'iTerm tab' : 'tmux window'}.
              </p>
            </div>
          </Section>
        </div>
  )
}
