import { useState } from 'react'
import { AlarmClockOffIcon, Loader2Icon } from 'lucide-react'
import { toast } from 'sonner'

import { api, sessionErrorMessage } from '@/api/client'
import type { Session } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useFleet } from '@/hooks/useFleet'
import { fromLocalInput, isSnoozed, snoozePresets, snoozeTime, toLocalInput } from '@/lib/snooze'

/**
 * Snooze a session: presets (1 hour, 4 hours, this evening, tomorrow morning, 1 day, next week),
 * each with the time it lands on, and a custom date + time. When the session is snoozed already,
 * also Unsnooze. Times are the browser's local time, sent to the host as epoch ms.
 * `onDone(snoozed)`: after a snooze (true) / unsnooze (false) went through.
 */
export function SnoozePicker({ host, id, session, onDone }: { host: string; id: string; session: Session | null; onDone: (snoozed: boolean) => void }) {
  const { refresh } = useFleet()
  const [now] = useState(() => Date.now())
  const [custom, setCustom] = useState(() => toLocalInput(snoozePresets(now).find((p) => p.id === 'tomorrow')?.until ?? now + 86_400_000))
  const [busy, setBusy] = useState<string | null>(null)
  const snoozed = isSnoozed(session, now)

  const run = async (key: string, body: { until: number } | { clear: true }) => {
    if (busy) return
    setBusy(key)
    try {
      await api.snooze(host, id, body)
      toast.success('until' in body ? `Snoozed until ${snoozeTime(body.until, Date.now())}` : 'Unsnoozed', {
        description: 'until' in body ? 'It keeps running; it comes back to the list then' : undefined,
      })
      refresh()
      onDone('until' in body)
    } catch (err) {
      toast.error('Snooze failed', { description: sessionErrorMessage(err) })
    } finally {
      setBusy(null)
    }
  }

  const customAt = fromLocalInput(custom)
  const customOk = customAt != null && customAt > now

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border bg-card/60 p-2" aria-label="Snooze">
      {snoozed && session?.snooze ? (
        <div className="flex items-center gap-2 px-1 pb-1 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">Snoozed until {snoozeTime(session.snooze.until, now)}</span>
          <Button type="button" variant="outline" size="xs" disabled={!!busy} onClick={() => void run('clear', { clear: true })}>
            {busy === 'clear' ? <Loader2Icon className="animate-spin" /> : <AlarmClockOffIcon />}
            Unsnooze
          </Button>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-1">
        {snoozePresets(now).map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={!!busy}
            onClick={() => void run(p.id, { until: p.until })}
            className="flex min-h-9 flex-col items-start justify-center rounded-md px-2 py-1 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
          >
            <span className="flex items-center gap-1 text-sm">
              {busy === p.id ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              {p.label}
            </span>
            <span className="text-[0.6875rem] text-dimmer tabular-nums">{snoozeTime(p.until, now)}</span>
          </button>
        ))}
      </div>
      <form
        className="flex items-center gap-1.5 border-t pt-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          if (customOk) void run('custom', { until: customAt })
        }}
      >
        <Input
          type="datetime-local"
          aria-label="Snooze until"
          value={custom}
          min={toLocalInput(now)}
          onChange={(e) => setCustom(e.target.value)}
          className="h-8 min-w-0 flex-1 text-sm"
        />
        <Button type="submit" variant="outline" size="sm" disabled={!!busy || !customOk} title={customOk ? `Snooze until ${snoozeTime(customAt, now)}` : 'Pick a time in the future'}>
          {busy === 'custom' ? <Loader2Icon className="animate-spin" /> : null}
          Snooze
        </Button>
      </form>
    </div>
  )
}
