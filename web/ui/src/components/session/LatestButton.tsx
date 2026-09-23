import { ArrowDownIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

/** Floating "↓ Latest" pill shown while the user has scrolled up (follow paused). */
export function LatestButton({ show, onClick }: { show: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-hidden={!show}
      tabIndex={show ? 0 : -1}
      className={cn(
        'absolute right-3 bottom-3 z-10 flex h-10 items-center gap-1.5 rounded-full border border-primary/40 bg-popover/95 px-3.5 text-[13px] font-medium text-foreground shadow-lg backdrop-blur-sm transition-all duration-200',
        show ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0',
      )}
    >
      <ArrowDownIcon className="size-4" />
      Latest
    </button>
  )
}
