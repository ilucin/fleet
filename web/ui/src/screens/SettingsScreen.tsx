import { useRef, type ReactNode } from 'react'
import { ChevronLeftIcon, MonitorIcon, MoonIcon, SunIcon, XIcon } from 'lucide-react'
import { useLocation } from 'wouter'

import { ScreenHeader } from '@/components/ScreenHeader'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { usePrefs } from '@/hooks/usePrefs'
import { useSwipeBack } from '@/hooks/useSwipeBack'
import { useTheme, type ThemeChoice } from '@/hooks/useTheme'
import { TERM_FONT_SIZES, TEXT_SIZES, TEXT_SIZE_LABELS } from '@/lib/prefs'

const segItem =
  'h-9 flex-1 gap-1.5 rounded-md px-3 text-[0.8125rem] text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm dark:data-[state=on]:bg-accent'

/**
 * `#/settings`: the viewer's global preferences — text size (scales the whole app), terminal
 * text, theme, progress notes. Stored in this browser (localStorage). `screen` = the mobile page
 * (back button, swipe back); `pane` = the desktop main pane (✕ / Esc back to `#/`).
 */
export function SettingsScreen({ layout = 'screen' }: { layout?: 'screen' | 'pane' }) {
  const pane = layout === 'pane'
  const [, navigate] = useLocation()
  const { theme, setTheme } = useTheme()
  const { textSize, setTextSize, termFont, setTermFont, hideNotes, setHideNotes } = usePrefs()

  const back = () => {
    if (!pane && window.history.length > 1) window.history.back()
    else navigate('/', { replace: !pane })
  }
  const screenRef = useRef<HTMLDivElement>(null)
  useSwipeBack(screenRef, back, !pane)

  const content = (
    <div className="mx-auto w-full max-w-lg px-4 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <Section title="Appearance">
        <Stacked label="Text size" hint="Scales the whole app">
          <ToggleGroup
            type="single"
            value={String(textSize)}
            onValueChange={(v) => v && setTextSize(Number(v))}
            spacing={0}
            aria-label="Text size"
            className="w-full rounded-lg bg-muted p-1"
          >
            {TEXT_SIZES.map((n) => (
              <ToggleGroupItem key={n} value={String(n)} className={segItem}>
                {TEXT_SIZE_LABELS[n] ?? `${n}px`}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Stacked>
        <Stacked label="Terminal text" hint="The terminal view; follows the text size">
          <ToggleGroup
            type="single"
            value={String(termFont)}
            onValueChange={(v) => v && setTermFont(Number(v))}
            spacing={0}
            aria-label="Terminal text size"
            className="w-full rounded-lg bg-muted p-1"
          >
            {TERM_FONT_SIZES.map((n, i) => (
              <ToggleGroupItem key={n} value={String(n)} className={segItem}>
                {['Small', 'Default', 'Large'][i] ?? `${n}px`}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Stacked>
        <Stacked label="Theme">
          <ToggleGroup
            type="single"
            value={theme}
            onValueChange={(v) => v && setTheme(v as ThemeChoice)}
            spacing={0}
            aria-label="Theme"
            className="w-full rounded-lg bg-muted p-1"
          >
            <ToggleGroupItem value="system" className={segItem}>
              <MonitorIcon /> System
            </ToggleGroupItem>
            <ToggleGroupItem value="dark" className={segItem}>
              <MoonIcon /> Dark
            </ToggleGroupItem>
            <ToggleGroupItem value="light" className={segItem}>
              <SunIcon /> Light
            </ToggleGroupItem>
          </ToggleGroup>
        </Stacked>
      </Section>

      <Section title="Chat">
        <div className="flex min-h-12 items-center justify-between gap-3 py-2">
          <div className="min-w-0">
            <div className="text-sm">Progress notes</div>
            <div className="text-xs text-dimmer">Claude’s narration between tool calls</div>
          </div>
          <Switch checked={!hideNotes} onCheckedChange={(v) => setHideNotes(!v)} aria-label="Show progress notes" />
        </div>
      </Section>

      <p className="pt-4 text-xs text-dimmer">Saved in this browser; every session uses them.</p>
    </div>
  )

  if (pane) {
    return (
      <section aria-label="Settings" className="flex h-full min-w-0 flex-1 flex-col bg-background">
        <header className="flex shrink-0 items-center gap-1 border-b py-1.5 pr-2 pl-4">
          <h1 className="min-w-0 flex-1 text-[0.9375rem] leading-tight font-bold">Settings</h1>
          <Button variant="ghost" size="icon" aria-label="Close settings" title="Close (Esc)" onClick={back} className="size-11 shrink-0 rounded-xl">
            <XIcon className="size-5" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{content}</div>
      </section>
    )
  }

  return (
    <div ref={screenRef} className="flex min-h-app flex-col bg-background">
      <ScreenHeader>
        <div className="-ml-2 flex min-h-8 items-center gap-1">
          <Button variant="ghost" size="icon" aria-label="Back" onClick={back} className="-my-1.5 size-11 shrink-0 rounded-xl">
            <ChevronLeftIcon className="size-6" />
          </Button>
          <h1 className="text-xl font-bold tracking-tight">Settings</h1>
        </div>
      </ScreenHeader>
      {content}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="py-1">
      <h2 className="pt-3 pb-1 text-[0.6875rem] font-semibold tracking-wider text-dimmer uppercase">{title}</h2>
      <div className="divide-y divide-border/60">{children}</div>
    </section>
  )
}

function Stacked({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-2 py-3">
      <div>
        <div className="text-sm">{label}</div>
        {hint ? <div className="text-xs text-dimmer">{hint}</div> : null}
      </div>
      {children}
    </div>
  )
}
