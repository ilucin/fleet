import type { ReactNode } from 'react'

import type { Session } from '@/api/types'
import { HostBadge } from '@/components/HostBadge'
import { StatusDot } from '@/components/StatusDot'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { shortCwd } from '@/lib/format'
import { paletteFilter } from '@/lib/palette'
import { statusLabel } from '@/lib/sessions'
import { sessionKey } from '@/lib/shortcuts'
import { sessionTitle } from '@/lib/title'

export interface PaletteAction {
  id: string
  label: string
  icon?: ReactNode
  shortcut?: string
  /** Extra words cmdk matches on. */
  keywords?: string[]
  run: () => void
}

export interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessions: Session[]
  selectedKey: string | null
  onOpenSession: (s: Session) => void
  actions: { heading: string; items: PaletteAction[] }[]
}

/** ⌘K / Ctrl+K: fuzzy-jump to any session (all hosts, ignoring list filters) or run an action. */
export function CommandPalette({ open, onOpenChange, sessions, selectedKey, onOpenSession, actions }: CommandPaletteProps) {
  const pick = (fn: () => void) => {
    onOpenChange(false)
    fn()
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[18%] translate-y-0 overflow-hidden rounded-xl! p-0 sm:max-w-xl" showCloseButton={false}>
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">Jump to a session or run an action</DialogDescription>
        <Command loop filter={paletteFilter} className="**:data-[slot=command-input-wrapper]:p-2">
          <CommandInput placeholder="Jump to a session or run an action…" aria-label="Command" />
          <CommandList className="max-h-[min(60vh,28rem)]">
            <CommandEmpty>No matches.</CommandEmpty>
            {sessions.length ? (
              <CommandGroup heading="Sessions">
                {sessions.map((s) => {
                  const key = sessionKey(s)
                  return (
                    <CommandItem
                      key={key}
                      value={`session ${key}`}
                      keywords={[s.display_title ?? '', s.name ?? '', s.gen_title ?? '', s.title ?? '', s.cwd ?? '', s.tmux_session ?? '', s.host].filter(Boolean)}
                      onSelect={() => pick(() => onOpenSession(s))}
                      className="gap-2.5 py-2"
                    >
                      <StatusDot status={s.status} className="size-2" />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium">{sessionTitle(s)}</span>
                        {s.cwd ? <span className="ml-2 font-mono text-[11px] text-dimmer">{shortCwd(s.cwd, 40)}</span> : null}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{statusLabel(s)}</span>
                      <HostBadge host={s.host} className="h-4 px-1 text-[10px]" />
                      {key === selectedKey ? <CommandShortcut>open</CommandShortcut> : null}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ) : null}
            {actions.map((g) =>
              g.items.length ? (
                <CommandGroup key={g.heading} heading={g.heading}>
                  {g.items.map((a) => (
                    <CommandItem key={a.id} value={`action ${a.id}`} keywords={[a.label, ...(a.keywords ?? [])]} onSelect={() => pick(a.run)}>
                      {a.icon}
                      {a.label}
                      {a.shortcut ? <CommandShortcut>{a.shortcut}</CommandShortcut> : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null,
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
