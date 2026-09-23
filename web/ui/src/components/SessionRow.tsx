import { Link } from 'wouter'

import type { Session } from '@/api/types'
import { HostBadge } from '@/components/HostBadge'
import { StatusDot } from '@/components/StatusDot'
import { STATUS_TEXT } from '@/lib/styles'
import { relTime, sessionSubtitle, shortCwd } from '@/lib/format'
import { sessionHref, statusLabel, statusMeta } from '@/lib/sessions'
import { cn } from '@/lib/utils'

const chip = 'inline-flex h-4.5 shrink-0 items-center rounded-[5px] border px-1 text-[11px] whitespace-nowrap'

/** One session in the list: status, name, host, status label / waiting_for, subtitle, cwd, tmux, backend, age. */
export function SessionRow({ session: s, now }: { session: Session; now: number }) {
  const meta = statusMeta(s.status)
  const subtitle = sessionSubtitle(s)
  const cwd = shortCwd(s.cwd)
  const backend = String(s.backend || 'unknown')
  const waiting = meta.key === 'waiting'

  return (
    <Link
      href={sessionHref(s)}
      className={cn(
        'block min-h-16 rounded-xl border bg-card px-3.5 py-3 text-card-foreground transition-colors',
        'outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 active:bg-muted',
        waiting ? 'border-status-waiting/35' : 'border-border/70',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot status={s.status} />
        <span className="min-w-0 flex-1 truncate text-[15px] font-bold">{s.name || '(unnamed)'}</span>
        <HostBadge host={s.host} />
        <span className={cn('max-w-[45%] shrink-0 truncate text-xs', STATUS_TEXT[meta.key])}>{statusLabel(s)}</span>
      </div>
      {subtitle ? <p className="mt-1 line-clamp-2 text-[13px] break-words text-muted-foreground">{subtitle}</p> : null}
      <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[11px] text-dimmer">
        {cwd ? <span className="min-w-0 truncate font-mono">{cwd}</span> : null}
        {s.tmux_session ? <span className={cn(chip, 'border-border text-status-busy/80')}>{s.tmux_session}</span> : null}
        {backend !== 'unknown' ? <span className={cn(chip, 'border-border')}>{backend}</span> : null}
        <span className="ml-auto shrink-0 tabular-nums">{relTime(s.updated_at, now)}</span>
      </div>
    </Link>
  )
}
