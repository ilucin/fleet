import { FileTextIcon, GitForkIcon, LayersIcon } from 'lucide-react'

import type { Session } from '@/api/types'
import { Button } from '@/components/ui/button'
import { STACK_BAR_POLL_MS, useStack } from '@/hooks/useStack'
import { openSiblingSpawn, openStackSheet } from '@/hooks/useStackUi'
import { memberCountsText } from '@/lib/stacks'
import { cn } from '@/lib/utils'

/**
 * Under the session header when the session is in a stack: layers icon + label, "2 live · 1
 * closed" once the stack loaded, StackBrief and Spawn sibling. Hidden when the host's server
 * predates stacks.
 */
export function StackBar({ session, pane = false }: { session: Session; pane?: boolean }) {
  const ref = session.stack
  const st = useStack(session.host, ref?.id ?? null, !!ref?.id, STACK_BAR_POLL_MS)
  if (!ref?.id || st.missing) return null
  const label = st.stack?.label || ref.label || ref.id
  const open = () => openStackSheet(session.host, ref.id)
  return (
    <div className="shrink-0 border-b bg-muted/30 px-safe">
      <div className={cn('mx-auto flex w-full items-center gap-1.5 py-1 text-xs', pane ? 'px-4' : 'max-w-3xl px-3')}>
        <button
          type="button"
          onClick={open}
          title={`Session stack: ${label}`}
          className={cn('flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50', pane ? 'min-h-9' : '-my-1 min-h-11')}
        >
          <LayersIcon className="size-3.5 shrink-0 text-primary" />
          <span className="min-w-0 truncate font-medium text-foreground">{label}</span>
          {st.stack ? <span className="shrink-0 text-dimmer tabular-nums">{memberCountsText(st.stack)}</span> : null}
        </button>
        {/* Mobile: icon buttons, so the label keeps its room. */}
        <Button
          variant="ghost"
          size="sm"
          aria-label="StackBrief"
          title="StackBrief"
          className={cn('shrink-0 rounded-lg text-xs', pane ? 'h-8 px-2' : '-my-1 size-11 px-0')}
          onClick={open}
        >
          <FileTextIcon />
          {pane ? 'StackBrief' : null}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Spawn sibling"
          title="Spawn sibling"
          className={cn('shrink-0 rounded-lg text-xs', pane ? 'h-8 px-2' : '-my-1 size-11 px-0')}
          onClick={() =>
            openSiblingSpawn({ host: session.host, sessionId: session.session_id, cwd: session.cwd ?? null, label, creates: false })
          }
        >
          <GitForkIcon />
          {pane ? 'Spawn sibling' : null}
        </Button>
      </div>
    </div>
  )
}
