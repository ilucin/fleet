import { EllipsisIcon, GitForkIcon, LayersIcon } from 'lucide-react'

import type { Session } from '@/api/types'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { openSiblingSpawn, openStackSheet } from '@/hooks/useStackUi'
import { cn } from '@/lib/utils'

export interface StackColumnMenuProps {
  stack: { id: string; host: string }
  label: string
  /** The column's sessions: the sibling starts in the first one's cwd (the server uses the stack's). */
  sessions: Session[]
  className?: string
}

/** ⋯ on a stack column / section header: StackBrief (the sheet), Spawn sibling. */
export function StackColumnMenu({ stack, label, sessions, className }: StackColumnMenuProps) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Stack ${label}: actions`}
          onClick={(e) => e.stopPropagation()}
          className={cn('size-7 shrink-0 rounded-md text-muted-foreground', className)}
        >
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      {/* No focus return to the trigger: the item opens a dialog that takes focus. */}
      <DropdownMenuContent align="end" className="w-44" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuItem onSelect={() => openStackSheet(stack.host, stack.id)}>
          <LayersIcon />
          StackBrief
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            openSiblingSpawn({ host: stack.host, stackId: stack.id, cwd: sessions[0]?.cwd ?? null, label, creates: false })
          }
        >
          <GitForkIcon />
          Spawn sibling
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
