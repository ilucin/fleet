import { LayersIcon } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/api/client'
import type { Session } from '@/api/types'
import { HostBadge } from '@/components/HostBadge'
import { StatusDot } from '@/components/StatusDot'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useFleet } from '@/hooks/useFleet'
import { shortCwd } from '@/lib/format'
import { paletteFilter } from '@/lib/palette'
import { allSessions, byLastActivity, findSession } from '@/lib/sessions'
import { sessionKey } from '@/lib/shortcuts'
import { linkPlan, stackErrorMessage, stackHome, type LinkPlan } from '@/lib/stacks'
import { sessionTitle } from '@/lib/title'

/** A choice in the picker: what picking it does, said as who joins whom. */
interface Choice {
  key: string
  plan: LinkPlan
  /** The session the row shows (for a stack: its most recently active member). */
  s: Session
  /** For a stack row: its label and live member count. */
  stack?: { label: string; members: number }
}

async function runLink(plan: LinkPlan, source: Session, other: Session, refresh: () => void) {
  if (plan.kind === 'same' || plan.kind === 'conflict') return
  const me = sessionTitle(source)
  const them = sessionTitle(other)
  // Who joins whom: a new stack holds both; a join moves the one without a stack into the other's.
  const joiner = plan.kind === 'join' ? (plan.other.session === source.session_id && plan.other.host === source.host ? me : them) : null
  const id = toast.loading(plan.kind === 'create' ? `Starting a stack with ${me} and ${them}…` : `Adding ${joiner} to ${plan.label}…`)
  try {
    const r =
      plan.kind === 'create'
        ? await api.linkToStack(plan.host, plan.sessionId, plan.other)
        : await api.addToStack(plan.host, plan.stackId, plan.other)
    toast.success(plan.kind === 'create' ? `New stack ${r.stack.label}: ${me} and ${them}` : `${joiner} joined ${r.stack.label}`, { id })
    refresh()
  } catch (err) {
    toast.error(`Not added: ${stackErrorMessage(err)}`, { id })
  }
}

/**
 * The stack picker, worded by who joins whom. For a session in a stack: "Add a session to <stack>"
 * — the picked session (one in no stack) joins it. For a session in none: "Add <session> to a
 * stack" — join an existing stack (one row per stack), or start a new one with a session that is
 * in none (one model call names it). Sessions in another stack are not offered: a session is in
 * one stack at a time.
 */
export function StackLinkDialog({ target, onClose }: { target: { host: string; id: string } | null; onClose: () => void }) {
  const { fleet, refresh } = useFleet()
  const found = target ? findSession(fleet, target.host, target.id) : null
  const source = found && target ? { ...found, host: target.host } : null
  const inStack = source?.stack?.id ? source.stack.label || source.stack.id : null
  const others = source ? allSessions(fleet).filter((s) => sessionKey(s) !== sessionKey(source)).sort(byLastActivity) : []

  // Sessions in no stack: they join this session's stack, or start a new one with it.
  const loose: Choice[] = source ? others.filter((s) => !s.stack?.id).map((s) => ({ key: sessionKey(s), s, plan: linkPlan(source, s) })) : []
  // Existing stacks (only when this session is in none): one row each, its newest member stands for it.
  const stacks: Choice[] = []
  if (source && !inStack) {
    const seen = new Map<string, Choice>()
    for (const s of others) {
      if (!s.stack?.id) continue
      const k = `${stackHome(s)}/${s.stack.id}`
      const c = seen.get(k)
      if (c) c.stack!.members++
      else {
        const choice = { key: `stack ${k}`, s, plan: linkPlan(source, s), stack: { label: s.stack.label || s.stack.id, members: 1 } }
        seen.set(k, choice)
        stacks.push(choice)
      }
    }
  }
  const me = source ? sessionTitle(source) : 'this session'
  const pick = (c: Choice) => {
    onClose()
    if (source) void runLink(c.plan, source, c.s, refresh)
  }

  return (
    <Dialog open={target != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="top-[18%] translate-y-0 overflow-hidden rounded-xl! p-0 sm:max-w-xl" showCloseButton={false}>
        <div className="px-4 pt-3.5">
          <DialogTitle className="flex items-center gap-1.5 text-sm">
            <LayersIcon className="size-4 text-primary" />
            {inStack ? `Add a session to ${inStack}` : `Add ${me} to a stack`}
          </DialogTitle>
          <DialogDescription className="mt-0.5 text-xs">
            {inStack
              ? `The session you pick joins ${inStack}. Sessions already in another stack are not listed.`
              : `${me} joins the stack you pick, or starts a new stack with the session you pick.`}
          </DialogDescription>
        </div>
        <Command loop filter={paletteFilter} className="**:data-[slot=command-input-wrapper]:p-2">
          <CommandInput placeholder={inStack ? 'Find a session…' : 'Find a stack or a session…'} aria-label="Stack or session" />
          <CommandList className="max-h-[min(60vh,28rem)]">
            <CommandEmpty>{source ? 'No matches.' : 'This session is not live.'}</CommandEmpty>
            {stacks.length ? (
              <CommandGroup heading={`Join a stack — ${me} joins it`}>
                {stacks.map((c) => (
                  <CommandItem key={c.key} value={c.key} keywords={[c.stack!.label, 'stack']} onSelect={() => pick(c)} className="gap-2.5 py-2">
                    <LayersIcon className="size-3.5 text-primary" />
                    <span className="min-w-0 flex-1 truncate font-medium">{c.stack!.label}</span>
                    <span className="shrink-0 text-[0.6875rem] text-dimmer tabular-nums">
                      {c.stack!.members} session{c.stack!.members === 1 ? '' : 's'}
                    </span>
                    <HostBadge host={stackHome(c.s)} className="h-4 px-1 text-[0.625rem]" />
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {loose.length ? (
              <CommandGroup heading={inStack ? `Sessions in no stack — the one you pick joins ${inStack}` : `Start a new stack — with ${me} and the one you pick`}>
                {loose.map((c) => (
                  <CommandItem
                    key={c.key}
                    value={`session ${c.key}`}
                    keywords={[c.s.display_title ?? '', c.s.name ?? '', c.s.gen_title ?? '', c.s.title ?? '', c.s.cwd ?? '', c.s.tmux_session ?? '', c.s.host].filter(Boolean)}
                    onSelect={() => pick(c)}
                    className="gap-2.5 py-2"
                  >
                    <StatusDot status={c.s.status} className="size-2" />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{sessionTitle(c.s)}</span>
                      {c.s.cwd ? <span className="ml-2 font-mono text-[0.6875rem] text-dimmer">{shortCwd(c.s.cwd, 40)}</span> : null}
                    </span>
                    <HostBadge host={c.s.host} className="h-4 px-1 text-[0.625rem]" />
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
