import { Link } from 'wouter'

import type { Session } from '@/api/types'
import { ContextMeter } from '@/components/ContextMeter'
import { EditableTitle } from '@/components/EditableTitle'
import { HostBadge } from '@/components/HostBadge'
import { StatusDot } from '@/components/StatusDot'
import { useLongPress } from '@/hooks/useLongPress'
import { openTitleEditor, useSessionTitle } from '@/hooks/useTitles'
import { STATUS_TEXT } from '@/lib/styles'
import { relTime, sessionSubtitle, shortCwd } from '@/lib/format'
import { sessionHref, statusLabel, statusMeta } from '@/lib/sessions'
import { sessionKey } from '@/lib/shortcuts'
import { echoesTitle } from '@/lib/title'
import { cn } from '@/lib/utils'

const chip = 'inline-flex h-4.5 shrink-0 items-center rounded-[5px] border px-1 text-[11px] whitespace-nowrap'

export interface SessionRowProps {
  session: Session
  now: number
  /** Desktop sidebar: this row is the session open in the detail pane. */
  selected?: boolean
  /** Desktop sidebar: the keyboard cursor (j/k) is on this row. */
  cursor?: boolean
}

/**
 * One session in the list: status, title, host, status label / waiting_for, first prompt,
 * cwd, backend, context, age. The title is editable in place: the pencil on hover
 * (desktop), `e` / F2 on the cursor row, or a long press (touch). Clicking the row opens it.
 */
export function SessionRow({ session: s, now, selected, cursor }: SessionRowProps) {
  const meta = statusMeta(s.status)
  const { title } = useSessionTitle(s)
  const prompt = sessionSubtitle(s)
  // The first prompt, unless the title is just its slug (no generated title yet).
  const subtitle = echoesTitle(title, prompt) ? '' : prompt
  const cwd = shortCwd(s.cwd)
  const backend = String(s.backend || 'unknown')
  const waiting = meta.key === 'waiting'
  const longPress = useLongPress(() => openTitleEditor('row', sessionKey(s)))

  return (
    <Link
      href={sessionHref(s)}
      {...longPress}
      aria-current={selected ? 'page' : undefined}
      data-session-key={selected || cursor ? `${s.host}/${s.session_id}` : undefined}
      className={cn(
        'group/row block min-h-16 rounded-xl border bg-card px-3.5 py-3 text-card-foreground transition-colors [-webkit-touch-callout:none]',
        'outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 active:bg-muted',
        waiting ? 'border-status-waiting/35' : 'border-border/70',
        selected && 'border-primary/60 bg-accent/60 hover:bg-accent/70',
        cursor && 'border-primary/40 ring-2 ring-primary/40',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot status={s.status} />
        <EditableTitle session={s} scope="row" className="text-[15px] font-bold" />
        <HostBadge host={s.host} />
        <span className={cn('max-w-[45%] shrink-0 truncate text-xs', STATUS_TEXT[meta.key])}>{statusLabel(s)}</span>
      </div>
      {subtitle ? <p className="mt-1 line-clamp-2 text-[13px] break-words text-muted-foreground">{subtitle}</p> : null}
      <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[11px] text-dimmer">
        {cwd ? <span className="min-w-0 truncate font-mono">{cwd}</span> : null}
        {backend !== 'unknown' ? <span className={cn(chip, 'border-border')}>{backend}</span> : null}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <ContextMeter context={s.context} />
          <span className="tabular-nums">{relTime(s.updated_at, now)}</span>
        </span>
      </div>
    </Link>
  )
}
