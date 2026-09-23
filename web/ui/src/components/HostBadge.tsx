import { hostBadgeClass, hostDotClass } from '@/lib/styles'
import { cn } from '@/lib/utils'

export function HostBadge({ host, className }: { host: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded-md border px-1.5 text-[11px] font-semibold tracking-wide whitespace-nowrap',
        hostBadgeClass(host),
        className,
      )}
    >
      {host}
    </span>
  )
}

export function HostDot({ host, className }: { host: string; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', hostDotClass(host), className)} />
}
