import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/** Sticky, translucent top bar with safe-area padding; content is centred at max-w-3xl. */
export function ScreenHeader({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <header
      className={cn(
        'sticky top-0 z-20 border-b bg-background/90 pt-safe px-safe backdrop-blur-md backdrop-saturate-150',
        className,
      )}
    >
      <div className="mx-auto w-full max-w-3xl px-3 pt-2.5 pb-2">{children}</div>
    </header>
  )
}
