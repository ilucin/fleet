import { useState } from 'react'
import { AlarmClockIcon, ChevronRightIcon } from 'lucide-react'

import type { Session } from '@/api/types'
import { SessionRow } from '@/components/SessionRow'
import { sessionKey } from '@/lib/shortcuts'
import { cn } from '@/lib/utils'

/**
 * Sessions snoozed until a time (`fleet snooze`), every host in one list, soonest back first:
 * they keep running, out of the way. Collapsed until expanded, like Inactive and Closed; a search
 * shows its matches expanded. Each row is a normal session row (opens the session) with its
 * snooze time; Snooze in the session's details changes or ends it. Nothing when none.
 * `sessions`: the snoozed sessions to show (`useSessionList().snoozed`). `selectedKey`: the
 * session open in the desktop detail pane.
 */
export function SnoozedSection({
  sessions,
  now,
  query = '',
  selectedKey = null,
  className,
}: {
  sessions: Session[]
  now: number
  query?: string
  selectedKey?: string | null
  className?: string
}) {
  const [open, setOpen] = useState(false)
  if (!sessions.length) return null
  const expanded = open || !!query.trim()
  return (
    <section aria-label="Snoozed sessions" className={cn('flex flex-col gap-2', className)}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOpen((o) => !o)}
        title="Set aside until a time: they keep running and come back to the list by themselves"
        className="flex min-h-8 items-center gap-1.5 rounded-md px-1 text-left text-xs font-semibold text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ChevronRightIcon className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
        <AlarmClockIcon className="size-3.5" />
        Snoozed
        <span className="font-normal text-dimmer tabular-nums">· {sessions.length}</span>
      </button>
      {expanded ? (
        <div className="flex flex-col gap-1.5 opacity-80">
          {sessions.map((s) => (
            <SessionRow key={sessionKey(s)} session={s} now={now} selected={sessionKey(s) === selectedKey} />
          ))}
        </div>
      ) : null}
    </section>
  )
}
