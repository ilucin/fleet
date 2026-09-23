import { ChevronLeftIcon } from 'lucide-react'
import { useLocation } from 'wouter'

import { HostBadge } from '@/components/HostBadge'
import { ScreenHeader } from '@/components/ScreenHeader'
import { StatusDot } from '@/components/StatusDot'
import { STATUS_TEXT } from '@/lib/styles'
import { Button } from '@/components/ui/button'
import { useFleet } from '@/hooks/useFleet'
import { useNow } from '@/hooks/useNow'
import { relTime, sessionSubtitle, shortCwd } from '@/lib/format'
import { findSession, statusLabel, statusMeta } from '@/lib/sessions'
import { cn } from '@/lib/utils'

/**
 * Session detail — `#/s/:host/:id`. PHASE 1 PLACEHOLDER: shows the session's list
 * metadata only. Phase 2 builds Chat | Term views, the composer, quick replies/keys
 * and the ⋯ menu here (see web/ui/README.md → "Phase 2").
 */
export function SessionScreen({ host, id }: { host: string; id: string }) {
  const { fleet } = useFleet()
  const [, navigate] = useLocation()
  const now = useNow(1000)
  const s = findSession(fleet, host, id)
  const meta = statusMeta(s?.status)

  const back = () => {
    if (window.history.length > 1) window.history.back()
    else navigate('/', { replace: true })
  }

  return (
    <div className="flex min-h-app flex-col">
      <ScreenHeader>
        <div className="flex min-h-9 items-center gap-2">
          <Button variant="ghost" size="icon-lg" aria-label="Back" onClick={back} className="-ml-2">
            <ChevronLeftIcon className="size-6" />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-bold">{s?.name || id.slice(0, 8)}</div>
            <div className="flex min-w-0 items-center gap-1.5 text-xs">
              <StatusDot status={s?.status} className="size-2" />
              <span className={cn('truncate', STATUS_TEXT[meta.key])}>{s ? statusLabel(s) : 'unknown'}</span>
              {s?.updated_at ? <span className="text-dimmer tabular-nums">· {relTime(s.updated_at, now)}</span> : null}
            </div>
          </div>
          <HostBadge host={host} />
        </div>
      </ScreenHeader>

      <main className="flex-1 pb-safe px-safe">
        <div className="mx-auto w-full max-w-3xl space-y-3 px-3 py-4 text-sm">
          {s ? (
            <>
              {sessionSubtitle(s) ? <p className="text-muted-foreground">{sessionSubtitle(s)}</p> : null}
              {s.cwd ? <p className="font-mono text-xs text-dimmer">{shortCwd(s.cwd, 80)}</p> : null}
            </>
          ) : fleet ? (
            <p className="text-muted-foreground">Session not found on {host} — it may have ended.</p>
          ) : null}
          <p className="rounded-lg border border-dashed p-4 text-center text-dimmer">Chat and terminal views are coming next.</p>
        </div>
      </main>
    </div>
  )
}
