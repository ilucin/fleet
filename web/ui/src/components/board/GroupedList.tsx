import { useState } from 'react'
import { ChevronRightIcon } from 'lucide-react'

import { StatusSummaryDots } from '@/components/board/StatusSummaryDots'
import { SessionRow } from '@/components/SessionRow'
import { parseCollapsed, type BoardColumn } from '@/lib/groups'
import { sessionKey } from '@/lib/shortcuts'
import { storage } from '@/lib/storage'
import { cn } from '@/lib/utils'

const COLLAPSED_KEY = 'fleet.groupsCollapsed'

/** Mobile board: one collapsible section per group (collapsed ids persist in `fleet.groupsCollapsed`). */
export function GroupedList({ columns, now }: { columns: BoardColumn[]; now: number }) {
  const [collapsed, setCollapsed] = useState<string[]>(() => parseCollapsed(storage.getJSON(COLLAPSED_KEY)))
  const toggle = (id: string) => {
    const next = collapsed.includes(id) ? collapsed.filter((x) => x !== id) : [...collapsed, id]
    setCollapsed(next)
    storage.setJSON(COLLAPSED_KEY, next)
  }

  return (
    <div className="flex flex-col gap-3">
      {columns.map((c) => {
        const open = !collapsed.includes(c.id)
        const bodyId = `group-${c.id}`
        return (
          <section key={c.id} aria-label={c.label}>
            <button
              type="button"
              aria-expanded={open}
              aria-controls={bodyId}
              onClick={() => toggle(c.id)}
              className="flex min-h-11 w-full items-center gap-2 rounded-lg px-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <ChevronRightIcon className={cn('size-4 shrink-0 text-dimmer transition-transform', open && 'rotate-90')} />
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-[15px] font-semibold', c.ungrouped && 'text-muted-foreground')}>{c.label}</span>
                {c.description ? <span className="block truncate text-xs text-dimmer">{c.description}</span> : null}
              </span>
              <StatusSummaryDots summary={c.summary} />
              <span className="rounded-md bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">{c.sessions.length}</span>
            </button>
            {open ? (
              <div id={bodyId} className="mt-1 flex flex-col gap-2">
                {c.sessions.map((s) => (
                  <SessionRow key={sessionKey(s)} session={s} now={now} />
                ))}
              </div>
            ) : null}
          </section>
        )
      })}
    </div>
  )
}
