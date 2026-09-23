import { Skeleton } from '@/components/ui/skeleton'

/** Placeholder rows shaped like SessionRow, for the first load with no snapshot. */
export function SessionListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading sessions">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="rounded-xl border border-border/70 bg-card px-3.5 py-3">
          <div className="flex items-center gap-2">
            <Skeleton className="size-2.5 rounded-full" />
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="ml-auto h-4 w-16" />
          </div>
          <Skeleton className="mt-2.5 h-3 w-4/5" />
          <Skeleton className="mt-2 h-3 w-1/2" />
        </div>
      ))}
    </div>
  )
}
