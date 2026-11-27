import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AlarmClockIcon, ArrowRightLeftIcon, CodeXmlIcon, FileDiffIcon, GitForkIcon, LayersIcon, Loader2Icon, MoonIcon, PlusIcon, PowerIcon, RefreshCwIcon, SquareTerminalIcon } from 'lucide-react'
import { toast } from 'sonner'

import { api, sessionErrorMessage } from '@/api/client'
import type { Session } from '@/api/types'
import { BeadsSection } from '@/components/session/BeadsSection'
import { BriefSection, type BriefSectionProps } from '@/components/session/BriefSection'
import { ConnectionsSection } from '@/components/ConnectionsSection'
import { SnoozePicker } from '@/components/session/SnoozePicker'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { useDormant } from '@/hooks/useDormant'
import { useNow } from '@/hooks/useNow'
import { useSessionTitle } from '@/hooks/useTitles'
import { canAttachInApp, copyWithToast, sessionAttachCommand, sessionAttachLink } from '@/lib/clipboard'
import { ctxLevel, ctxSummary, shortCwd } from '@/lib/format'
import { harnessLabel } from '@/lib/harness'
import { CTX_TEXT } from '@/lib/styles'
import { isSnoozed, snoozeTime } from '@/lib/snooze'
import { cn } from '@/lib/utils'

export interface DetailsPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  host: string
  id: string
  session: Session | null
  /** Called after a successful close (navigate away). */
  onClosed: () => void
  /** Called after the session was snoozed (mobile: back to the list, where it left for Snoozed). */
  onSnoozed?: () => void
  /** The brief at the top of the panel. */
  brief: Omit<BriefSectionProps, 'desktop' | 'cancelEditRef'>
  /** "New session from here…": the form with Hand off / Sibling (absent: no session row yet). */
  onNewFromHere?: () => void
  /** "Review changes": the diff reviewer (the action row, desktop column and mobile drawer). */
  onReview?: () => void
  /** "VSC": VS Code in Fleet on the session's checkout, the chat beside it. */
  onCode?: () => void
  /** Session stacks: the label and the StackBrief sheet (when in one), and the picker: "Add a session" (to this stack), "Move" (this one out of it) or "+ Stack" (this one joins or starts one). */
  stack?: { label: string | null; onOpen?: () => void; onLink: () => void; onMove?: () => void } | null
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="py-1">
      <h3 className="pt-2 pb-1 text-[0.6875rem] font-semibold tracking-wider text-dimmer uppercase">{title}</h3>
      <div className="divide-y divide-border/60">{children}</div>
    </section>
  )
}

/** ⋯ on mobile: the Details panel as a bottom drawer. Esc while editing the brief cancels the edit, not the drawer. */
export function DetailsDrawer(p: DetailsPanelProps) {
  const cancelEdit = useRef<(() => void) | null>(null)
  // Closing the drawer unmounts the body, which disarms "Close session".
  return (
    <Drawer open={p.open} onOpenChange={p.onOpenChange}>
      <DrawerContent
        className="px-safe"
        onEscapeKeyDown={(e) => {
          if (!cancelEdit.current) return
          e.preventDefault()
          cancelEdit.current()
        }}
      >
        <DetailsPanel {...p} variant="drawer" cancelEditRef={cancelEdit} />
      </DrawerContent>
    </Drawer>
  )
}

/**
 * Details, most used first: header (name + regenerate, host · cwd, context; snooze and close top
 * right), the actions (Review, VSC, New, Attach), managing the session (its Stack, its Connections
 * to Slack / GitHub / Productive / Veranda), then the Brief (summary, PRs, todos collapsed,
 * worktrees, resources) and the ids. `drawer` = inside the mobile drawer; `panel` = the desktop
 * details column (click-to-confirm wording, no drawer chrome). Every button here is one size.
 */
export function DetailsPanel(p: DetailsPanelProps & { variant: 'drawer' | 'panel'; cancelEditRef?: React.RefObject<(() => void) | null> }) {
  const panel = p.variant === 'panel'
  const [naming, setNaming] = useState(false)

  // Regenerate: a fresh model-picked name for this session (`fleet name <id> --apply --refresh`).
  const regenerate = async () => {
    if (naming) return
    setNaming(true)
    try {
      const r = await api.regenerateName(p.host, p.id)
      toast(r.name ? `Renamed to ${r.name}` : 'Name unchanged')
    } catch (err) {
      toast.error((err as Error)?.message || 'Naming failed')
    } finally {
      setNaming(false)
    }
  }

  // Close: two taps. The first arms (for 5s) and offers Deactivate beside Close; Close kills
  // Claude + its terminal, Deactivate does the same but keeps it under Inactive to resume.
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
    if (closing || sleeping) return
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

  const dormant = useDormant()
  const [sleeping, setSleeping] = useState(false)
  const deactivateSession = async () => {
    if (sleeping || closing) return
    clearTimeout(armTimer.current)
    setSleeping(true)
    try {
      const res = await api.sleep(p.host, p.id)
      toast.success(`Deactivated ${res.name || res.title || p.id.slice(0, 8)}`, { description: 'Resume it from Inactive' })
      dormant.refresh()
      onOpenChange(false)
      p.onClosed()
    } catch (err) {
      toast.error('Deactivate failed', { description: sessionErrorMessage(err) })
      setSleeping(false)
      setArmed(false)
    }
  }

  // Snooze: the clock button opens the picker under the header (presets + custom time).
  const [snoozeOpen, setSnoozeOpen] = useState(false)

  const s = p.session
  const now = useNow(30_000)
  const snoozed = isSnoozed(s, now)
  const { title } = useSessionTitle(s, `${p.host}/${p.id}`)
  const attachCmd = sessionAttachCommand(s)
  const attachLink = canAttachInApp() ? sessionAttachLink(s) : null
  const btn = panel ? 'xs' : 'sm'
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
          <Header className={panel ? 'flex flex-row items-start gap-1 pt-3 pb-1 text-left' : 'flex flex-row items-start gap-1 px-0 pt-3 pb-1 text-left'}>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-1">
                <Title className="truncate text-left text-base font-semibold">{s ? title : p.id.slice(0, 8)}</Title>
                {s ? (
                  <Button variant="ghost" size="icon" aria-label="Regenerate name" title="Regenerate name" disabled={naming} onClick={regenerate} className="size-7 shrink-0 rounded-md text-muted-foreground">
                    <RefreshCwIcon className={cn('size-3.5', naming && 'animate-spin')} />
                  </Button>
                ) : null}
              </div>
              <Description className={cn('truncate text-left font-mono text-xs', panel && 'text-muted-foreground')} title={panel ? (s?.cwd ?? undefined) : undefined}>
                {[p.host, s?.cwd ? shortCwd(s.cwd, 60) : null].filter(Boolean).join(' · ')}
              </Description>
              {s?.context ? (
                <p className={cn('truncate text-left text-xs tabular-nums', CTX_TEXT[ctxLevel(s.context.pct)])}>
                  Context {ctxSummary(s.context)}
                  {s.context.model ? <span className="text-dimmer"> · {s.context.model}</span> : null}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {s && !armed && !sleeping ? (
                <Button
                  variant={snoozeOpen || snoozed ? 'secondary' : 'ghost'}
                  size="icon"
                  aria-label="Snooze session"
                  aria-expanded={snoozeOpen}
                  title={snoozed && s.snooze ? `Snoozed until ${snoozeTime(s.snooze.until, now)} — change or unsnooze` : 'Snooze: set it aside until a time (it keeps running)'}
                  disabled={closing}
                  onClick={() => setSnoozeOpen((o) => !o)}
                  className={cn('size-8 shrink-0 rounded-lg', snoozed ? 'text-primary' : 'text-muted-foreground')}
                >
                  <AlarmClockIcon />
                </Button>
              ) : null}
              {armed || sleeping ? (
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="Deactivate session"
                  title={`Deactivate: ends ${harnessLabel(s?.harness)} and its ${s?.backend === 'iterm' ? 'iTerm tab' : 'tmux window'}, keeps it under Inactive to resume later`}
                  disabled={closing || sleeping}
                  onClick={() => void deactivateSession()}
                  className="h-8 rounded-lg px-2.5"
                >
                  {sleeping ? <Loader2Icon className="animate-spin" /> : <MoonIcon />}
                  Deactivate
                </Button>
              ) : null}
              <Button
                variant="destructive"
                size={armed ? 'sm' : 'icon'}
                aria-label={armed ? 'Confirm close session' : 'Close session'}
                title={`Close session: ends ${harnessLabel(s?.harness)} and its ${s?.backend === 'iterm' ? 'iTerm tab' : 'tmux window'}${armed ? '' : ` (${panel ? 'click' : 'tap'} twice; or Deactivate to keep it)`}`}
                disabled={closing || sleeping}
                onClick={closeSession}
                className={cn(
                  'h-8 shrink-0 rounded-lg',
                  armed ? 'bg-destructive px-2.5 text-white hover:bg-destructive/90 dark:bg-destructive dark:hover:bg-destructive/90' : 'w-8',
                )}
              >
                {closing ? <Loader2Icon className="animate-spin" /> : <PowerIcon />}
                {armed ? 'Close' : null}
              </Button>
            </div>
          </Header>

          {snoozeOpen && s ? (
            <div className="pb-2">
              <SnoozePicker
                host={p.host}
                id={p.id}
                session={s}
                onDone={(didSnooze) => {
                  setSnoozeOpen(false)
                  if (didSnooze && p.onSnoozed) {
                    onOpenChange(false)
                    p.onSnoozed()
                  }
                }}
              />
            </div>
          ) : null}

          {/* Actions first: Review, VSC (VS Code in Fleet), New (from here), Attach. One size, icon + word, left-aligned; they wrap when the pane is narrow. */}
          {p.onReview || p.onCode || p.onNewFromHere || attachCmd ? (
            <div className="flex flex-wrap items-center gap-1.5 pt-1 pb-2">
              {p.onReview ? (
                <Button variant="outline" size={btn} aria-label="Review changes" title="Review changes (diff)" onClick={p.onReview}>
                  <FileDiffIcon />
                  Review
                </Button>
              ) : null}
              {p.onCode ? (
                <Button variant="outline" size={btn} aria-label="VS Code in Fleet" title="VS Code in Fleet on this session's checkout, the chat beside it" onClick={p.onCode}>
                  <CodeXmlIcon />
                  VSC
                </Button>
              ) : null}
              {p.onNewFromHere ? (
                <Button variant="outline" size={btn} aria-label="New session from here" title="New session from here… (hand off / sibling)" onClick={p.onNewFromHere}>
                  <GitForkIcon />
                  New
                </Button>
              ) : null}
              {attachLink ? (
                <Button asChild variant="outline" size={btn}>
                  <a href={attachLink} aria-label="Attach in iTerm" title={`Attach in iTerm: ${attachCmd}`}>
                    <SquareTerminalIcon />
                    Attach
                  </a>
                </Button>
              ) : attachCmd ? (
                <Button variant="outline" size={btn} aria-label="Copy attach command" title={`Copy attach command: ${attachCmd}`} onClick={() => void copyWithToast(attachCmd)}>
                  <SquareTerminalIcon />
                  Attach
                </Button>
              ) : null}
            </div>
          ) : null}

          {/* Managing the session: its stack, then who can talk to it (Connections). */}
          {p.stack ? (
            <section className="py-1">
              <div className="flex items-center justify-between gap-2 pt-2 pb-1">
                <h3 className="text-[0.6875rem] font-semibold tracking-wider text-dimmer uppercase">Stack</h3>
                {!p.stack.onOpen ? (
                  <Button variant="outline" size={btn} title="Put this session in a stack: join an existing stack, or start a new one with another session" onClick={p.stack.onLink}>
                    <PlusIcon />
                    Stack
                  </Button>
                ) : null}
              </div>
              {p.stack.onOpen ? (
                <>
                  <p className="truncate py-1 text-sm">{p.stack.label}</p>
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5 pb-1">
                    <Button variant="outline" size={btn} title="StackBrief: the stack's shared brief and its sessions" onClick={p.stack.onOpen}>
                      <LayersIcon />
                      StackBrief
                    </Button>
                    <Button variant="outline" size={btn} title={`Add a session to ${p.stack.label || 'this stack'}: the session you pick joins it`} onClick={p.stack.onLink}>
                      <PlusIcon />
                      Add a session
                    </Button>
                    {p.stack.onMove ? (
                      <Button variant="outline" size={btn} title={`Move this session out of ${p.stack.label || 'this stack'}: to another stack, a new one, or none`} onClick={p.stack.onMove}>
                        <ArrowRightLeftIcon />
                        Move
                      </Button>
                    ) : null}
                  </div>
                </>
              ) : (
                <p className="py-1 text-xs text-dimmer">Not in a stack</p>
              )}
            </section>
          ) : null}

          <ConnectionsSection host={p.host} session={s} size={btn} />

          <BriefSection {...p.brief} desktop={panel} cancelEditRef={p.cancelEditRef} />

          <BeadsSection host={p.host} session={s} />

          <Section title="Session">
            {s ? (
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 py-3 text-xs">
                {(
                  [
                    ['agent', s.harness ? harnessLabel(s.harness) : null],
                    ['model', s.model],
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
          </Section>
        </div>
  )
}

