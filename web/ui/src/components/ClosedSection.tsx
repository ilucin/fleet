import { useState } from 'react'
import { ChevronRightIcon, HistoryIcon, Loader2Icon, PlayIcon } from 'lucide-react'

import type { ClosedView } from '@/api/types'
import { ArmButton } from '@/components/DormantSection'
import { HostBadge } from '@/components/HostBadge'
import { Button } from '@/components/ui/button'
import { useDormant } from '@/hooks/useDormant'
import { closedMeta, dormantTitles } from '@/lib/dormant'
import { cn } from '@/lib/utils'

/**
 * Sessions closed recently within a boot (Close, kill, /exit), per host — collapsed by default.
 * Resume (one at a time: a whole tmux session with its layout, or a Claude session in a new
 * window of its tmux session when that lives on) and Forget. Unlike Dormant: no Resume all, and
 * never on the Board. Nothing when no host has any. `host`: only that host.
 */
export function ClosedSection({ now, host = null, desktop = false, className }: { now: number; host?: string | null; desktop?: boolean; className?: string }) {
  const { hosts, busy, resumeClosed, forgetClosed } = useDormant()
  const [open, setOpen] = useState(false)
  const shown = (host ? hosts.filter((h) => h.host === host) : hosts).filter((h) => h.closed.length > 0)
  if (!shown.length) return null
  const total = shown.reduce((n, h) => n + h.closed.length, 0)
  const size = desktop ? 'sm' : 'lg'
  return (
    <section aria-label="Recently closed sessions" className={cn('flex flex-col gap-2', className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-8 items-center gap-1.5 rounded-md px-1 text-left text-xs font-semibold text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ChevronRightIcon className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        <HistoryIcon className="size-3.5" />
        Recently closed
        <span className="font-normal text-dimmer tabular-nums">· {total}</span>
      </button>
      {open
        ? shown.map((h) => (
            <div key={h.host} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 px-1">
                <HostBadge host={h.host} />
                <span className="text-xs text-dimmer tabular-nums">{h.closed.length}</span>
              </div>
              {h.closed.map((v) => (
                <ClosedRow
                  key={`${v.kind}/${v.target}`}
                  view={v}
                  now={now}
                  size={size}
                  busy={busy.has(`${h.host}/closed/${v.target}`)}
                  onResume={() => void resumeClosed(h.host, v.target)}
                  onForget={() => void forgetClosed(h.host, v.target)}
                />
              ))}
            </div>
          ))
        : null}
    </section>
  )
}

function ClosedRow({
  view: v,
  now,
  size,
  busy,
  onResume,
  onForget,
}: {
  view: ClosedView
  now: number
  size: 'sm' | 'lg'
  busy: boolean
  onResume: () => void
  onForget: () => void
}) {
  const titles = dormantTitles(v)
  const how = v.kind === 'tmux' ? 'Recreate the tmux session and resume its Claude sessions' : v.tmuxSession ? `Resume it in a new window of ${v.tmuxSession}` : 'Resume it in a new tmux session'
  return (
    <div className="rounded-lg border border-dashed border-border/50 bg-card/30 px-3 py-2">
      <div className="min-w-0 opacity-70">
        <p className="truncate text-sm font-semibold" title={v.name}>
          {v.name}
        </p>
        {titles && titles !== v.name ? <p className="line-clamp-2 text-xs break-words text-muted-foreground">{titles}</p> : null}
        <p className="mt-0.5 truncate text-[0.6875rem] text-dimmer tabular-nums">{closedMeta(v, now)}</p>
      </div>
      <div className="mt-1.5 flex items-center justify-end gap-1">
        <ArmButton confirm="Forget?" onConfirm={onForget} size={size} className="text-dimmer" title="Drop it from the list">
          Forget
        </ArmButton>
        <Button type="button" variant="outline" size={size} disabled={busy} onClick={onResume} title={how}>
          {busy ? <Loader2Icon className="animate-spin" /> : <PlayIcon />}
          Resume
        </Button>
      </div>
    </div>
  )
}
