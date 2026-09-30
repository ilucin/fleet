import { LayersIcon } from 'lucide-react'

import type { Session } from '@/api/types'
import { useStackLabel } from '@/hooks/useStackLabels'
import { openStackSheet } from '@/hooks/useStackUi'
import { cn } from '@/lib/utils'

/**
 * The session's stack on a list row: layers icon + label (truncated). A click opens the Stack
 * sheet — never the row (the row is a link around it).
 */
export function StackChip({ session: s, className }: { session: Session; className?: string }) {
  const st = s.stack
  // A rename in flight shows here at once (hooks/useStackLabels.ts).
  const { label } = useStackLabel(s.host, st?.id, st?.label || st?.id || '')
  if (!st?.id) return null
  return (
    <button
      type="button"
      title={`Session stack: ${label}`}
      aria-label={`Session stack ${label}: open its StackBrief`}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        openStackSheet(s.host, st.id)
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      className={cn(
        'relative inline-flex h-4.5 max-w-[45%] min-w-0 shrink items-center gap-1 rounded-[5px] border border-primary/30 bg-primary/5 px-1 text-[0.6875rem] text-primary',
        'outline-none after:absolute after:-inset-1.5 hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring/50',
        className,
      )}
    >
      <LayersIcon className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
}
