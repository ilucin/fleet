// Snooze: the picker's presets and how a snooze time reads — pure, unit-tested in snooze.test.ts.
import type { Session } from '@/api/types'

const HOUR = 3_600_000
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad2 = (n: number) => String(n).padStart(2, '0')

/** `now`'s local day, `days` later, at `h`:00. */
function at(now: number, days: number, h: number): number {
  const d = new Date(now)
  d.setDate(d.getDate() + days)
  d.setHours(h, 0, 0, 0)
  return d.getTime()
}

export interface SnoozePreset {
  id: string
  label: string
  until: number
}

/**
 * The picker's choices from `now` (local time): 1 hour, 4 hours, this evening (18:00, before
 * 17:00 only), tomorrow 9:00, 1 day, next Monday 9:00. Each is a future time.
 */
export function snoozePresets(now: number): SnoozePreset[] {
  const out: SnoozePreset[] = [
    { id: '1h', label: '1 hour', until: now + HOUR },
    { id: '4h', label: '4 hours', until: now + 4 * HOUR },
  ]
  if (new Date(now).getHours() < 17) out.push({ id: 'evening', label: 'This evening', until: at(now, 0, 18) })
  out.push({ id: 'tomorrow', label: 'Tomorrow morning', until: at(now, 1, 9) })
  out.push({ id: '1d', label: '1 day', until: now + 24 * HOUR })
  const dow = new Date(now).getDay()
  out.push({ id: 'week', label: 'Next week', until: at(now, ((8 - dow) % 7) || 7, 9) })
  return out
}

/** "14:30" today, "tomorrow 9:00", "Fri 9:00" within the week, else "20.11. 9:00". */
export function snoozeTime(ms: number, now: number): string {
  const d = new Date(ms)
  const hm = `${d.getHours()}:${pad2(d.getMinutes())}`
  const days = Math.round((at(ms, 0, 0) - at(now, 0, 0)) / (24 * HOUR))
  if (days === 0) return hm
  if (days === 1) return `tomorrow ${hm}`
  if (days > 1 && days < 7) return `${DAYS[d.getDay()]} ${hm}`
  return `${d.getDate()}.${d.getMonth() + 1}. ${hm}`
}

/** A `<input type="datetime-local">` value for `ms` (local time). */
export function toLocalInput(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** A `<input type="datetime-local">` value → epoch ms (local time); null when empty or invalid. */
export function fromLocalInput(v: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return null
  const t = new Date(v).getTime()
  return Number.isFinite(t) ? t : null
}

/** Snoozed: its snooze time is still ahead (the list leaves it out, Snoozed shows it). */
export function isSnoozed(s: Pick<Session, 'snooze'> | null | undefined, now: number): boolean {
  return !!s?.snooze && s.snooze.until > now
}

/** Back from a snooze: the time has passed and nobody prompted it or opened it since. */
export function isBack(s: Pick<Session, 'snooze'> | null | undefined, now: number): boolean {
  return !!s?.snooze && s.snooze.until <= now
}
