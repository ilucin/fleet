import type { ContextUsage } from '@/api/types'
import { ctxLevel, ctxSummary } from '@/lib/format'
import { CTX_FILL, CTX_TEXT } from '@/lib/styles'
import { cn } from '@/lib/utils'

/** Tiny context-window meter: a 4-cell-wide bar plus the percentage, coloured by band. */
export function ContextMeter({ context: c, className }: { context?: ContextUsage | null; className?: string }) {
  if (!c || !Number.isFinite(c.pct)) return null
  const pct = Math.max(0, Math.round(c.pct))
  const level = ctxLevel(pct)
  const title = [`Context ${ctxSummary(c)}`, c.model].filter(Boolean).join(' · ')
  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-1 tabular-nums', CTX_TEXT[level], className)}
      title={title}
      aria-label={title}
    >
      <span className="relative h-1.5 w-5 overflow-hidden rounded-full bg-muted" aria-hidden>
        <span className={cn('absolute inset-y-0 left-0 rounded-full', CTX_FILL[level])} style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
      {pct}%
    </span>
  )
}
