import { Link } from 'wouter'

import type { Session } from '@/api/types'
import { ContextMeter } from '@/components/ContextMeter'
import { EditableTitle } from '@/components/EditableTitle'
import { HostBadge } from '@/components/HostBadge'
import { StatusDot } from '@/components/StatusDot'
import { useLongPress } from '@/hooks/useLongPress'
import { openTitleEditor, useSessionTitle } from '@/hooks/useTitles'
import { relTime, sessionSubtitle } from '@/lib/format'
import { sessionHref, statusLabel, statusMeta } from '@/lib/sessions'
import { sessionKey } from '@/lib/shortcuts'
import { STATUS_TEXT } from '@/lib/styles'
import { echoesTitle } from '@/lib/title'
import { cn } from '@/lib/utils'

export interface BoardCardProps {
  session: Session
  now: number
  selected?: boolean
  cursor?: boolean
  /** Desktop: open through the shell (cursor + focus handling) instead of plain navigation. */
  onOpen?: (s: Session) => void
}

/** One session on the desktop board: status, title (editable in place, see SessionRow), host, subtitle, status / waiting_for, context, age. */
export function BoardCard({ session: s, now, selected, cursor, onOpen }: BoardCardProps) {
  const meta = statusMeta(s.status)
  const { title } = useSessionTitle(s)
  const prompt = sessionSubtitle(s)
  // The first prompt, unless the title is just its slug (no generated title yet).
  const subtitle = echoesTitle(title, prompt) ? '' : prompt
  const waiting = meta.key === 'waiting'
  const longPress = useLongPress(() => openTitleEditor('card', sessionKey(s)))
  return (
    <Link
      href={sessionHref(s)}
      {...longPress}
      onClick={(e) => {
        if (!onOpen || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        onOpen(s)
      }}
      aria-current={selected ? 'page' : undefined}
      data-session-key={sessionKey(s)}
      className={cn(
        'group/row block rounded-lg border bg-card px-3 py-2.5 text-card-foreground transition-colors [-webkit-touch-callout:none]',
        'outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 active:bg-muted',
        waiting ? 'border-status-waiting/35' : 'border-border/70',
        selected && 'border-primary/60 bg-accent/60 hover:bg-accent/70',
        cursor && 'border-primary/40 ring-2 ring-primary/40',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot status={s.status} className="size-2" />
        <EditableTitle session={s} scope="card" className="text-sm font-semibold" />
        <HostBadge host={s.host} className="h-4.5 px-1 text-[10px]" />
      </div>
      {subtitle ? <p className="mt-1 line-clamp-2 text-xs break-words text-muted-foreground">{subtitle}</p> : null}
      <div className="mt-1.5 flex min-w-0 items-center gap-2 text-[11px] text-dimmer">
        <span className={cn('min-w-0 truncate', STATUS_TEXT[meta.key])}>{statusLabel(s)}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <ContextMeter context={s.context} />
          <span className="tabular-nums">{relTime(s.updated_at, now)}</span>
        </span>
      </div>
    </Link>
  )
}
