import { statusMeta } from '@/lib/sessions'
import { STATUS_DOT } from '@/lib/styles'
import { cn } from '@/lib/utils'

export function StatusDot({ status, className }: { status: string | null | undefined; className?: string }) {
  const meta = statusMeta(status)
  return (
    <span
      role="img"
      aria-label={meta.label}
      className={cn('inline-block size-2.5 shrink-0 rounded-full', STATUS_DOT[meta.key], className)}
    />
  )
}
