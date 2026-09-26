import { KanbanIcon, ListIcon } from 'lucide-react'

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { ViewMode } from '@/lib/groups'
import { cn } from '@/lib/utils'

/** List | Board. `size="lg"` on mobile (44px tap targets). */
export function ViewToggle({
  value,
  onChange,
  size = 'sm',
  labels = size === 'sm',
  className,
}: {
  value: ViewMode
  onChange: (v: ViewMode) => void
  size?: 'sm' | 'lg'
  /** Show "List" / "Board" next to the icons. */
  labels?: boolean
  className?: string
}) {
  const item = cn(
    'gap-1 rounded-md px-2 text-muted-foreground data-[state=on]:bg-accent data-[state=on]:text-accent-foreground',
    size === 'lg' ? 'h-10 min-w-11 text-sm' : 'h-7 min-w-7 text-xs',
  )
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as ViewMode)}
      aria-label="View"
      spacing={0}
      className={cn('shrink-0 rounded-lg border border-border bg-card p-0.5', className)}
    >
      <ToggleGroupItem value="list" aria-label="List view" title="List view" className={item}>
        <ListIcon className="size-3.5" />
        {labels ? 'List' : null}
      </ToggleGroupItem>
      <ToggleGroupItem value="board" aria-label="Board view" title="Board view (grouped)" className={item}>
        <KanbanIcon className="size-3.5" />
        {labels ? 'Board' : null}
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
