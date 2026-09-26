import { PaperclipIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

/** "Drop to attach" over a drop zone (the parent must be positioned). Never eats the drag. */
export function DropOverlay({ show, hint, className }: { show: boolean; hint?: string; className?: string }) {
  if (!show) return null
  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-2 z-40 flex flex-col items-center justify-center gap-2 rounded-2xl',
        'border-2 border-dashed border-primary/70 bg-background/85 text-foreground backdrop-blur-sm',
        className,
      )}
    >
      <PaperclipIcon className="size-7 text-primary" />
      <span className="text-base font-semibold">Drop to attach</span>
      {hint ? <span className="px-6 text-center text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  )
}
