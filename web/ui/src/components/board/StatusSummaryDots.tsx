import { StatusDot } from '@/components/StatusDot'
import type { StatusSummary } from '@/lib/groups'
import { cn } from '@/lib/utils'

/** "● 2  ● 1  ● 4" — waiting (only when > 0), busy, idle. */
export function StatusSummaryDots({ summary, className }: { summary: StatusSummary; className?: string }) {
  const parts: [keyof StatusSummary, string][] = [
    ['waiting', 'need you'],
    ['busy', 'busy'],
    ['idle', 'idle'],
  ]
  return (
    <span className={cn('flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums', className)}>
      {parts
        .filter(([k]) => summary[k] > 0)
        .map(([k, label]) => (
          <span
            key={k}
            className={cn('flex items-center gap-0.5', k === 'waiting' && 'font-semibold text-status-waiting')}
            title={`${summary[k]} ${label}`}
          >
            <StatusDot status={k} className="size-1.5 ring-0" />
            {summary[k]}
          </span>
        ))}
    </span>
  )
}
