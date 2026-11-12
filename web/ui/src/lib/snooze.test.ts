import { describe, expect, it } from 'vitest'

import { fromLocalInput, isBack, isSnoozed, snoozePresets, snoozeTime, toLocalInput } from './snooze'

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()

describe('snoozePresets', () => {
  it('offers this evening before 17:00, tomorrow 9:00 and next Monday', () => {
    const now = local(2026, 11, 12, 10, 30) // a Thursday
    const p = Object.fromEntries(snoozePresets(now).map((x) => [x.id, x.until]))
    expect(p['1h']).toBe(now + 3_600_000)
    expect(p['4h']).toBe(now + 4 * 3_600_000)
    expect(p.evening).toBe(local(2026, 11, 12, 18))
    expect(p.tomorrow).toBe(local(2026, 11, 13, 9))
    expect(p['1d']).toBe(now + 24 * 3_600_000)
    expect(p.week).toBe(local(2026, 11, 16, 9))
  })

  it('drops this evening late in the day; on a Monday next week is 7 days on', () => {
    const late = snoozePresets(local(2026, 11, 12, 17, 5))
    expect(late.some((x) => x.id === 'evening')).toBe(false)
    const monday = snoozePresets(local(2026, 11, 16, 8))
    expect(monday.find((x) => x.id === 'week')?.until).toBe(local(2026, 11, 23, 9))
  })

  it('every preset is in the future', () => {
    const now = local(2026, 11, 12, 23, 59)
    for (const p of snoozePresets(now)) expect(p.until).toBeGreaterThan(now)
  })
})

describe('snoozeTime', () => {
  const now = local(2026, 11, 12, 10)
  it('reads relative to today', () => {
    expect(snoozeTime(local(2026, 11, 12, 14, 5), now)).toBe('14:05')
    expect(snoozeTime(local(2026, 11, 13, 9), now)).toBe('tomorrow 9:00')
    expect(snoozeTime(local(2026, 11, 16, 9), now)).toBe('Mon 9:00')
    expect(snoozeTime(local(2026, 11, 20, 9), now)).toBe('20.11. 9:00')
  })
})

describe('local input', () => {
  it('round-trips', () => {
    const t = local(2026, 11, 13, 9, 15)
    expect(toLocalInput(t)).toBe('2026-11-13T09:15')
    expect(fromLocalInput('2026-11-13T09:15')).toBe(t)
    expect(fromLocalInput('')).toBeNull()
  })
})

describe('isSnoozed / isBack', () => {
  it('splits on until', () => {
    const s = { snooze: { at: 1, until: 100 } }
    expect(isSnoozed(s, 50)).toBe(true)
    expect(isBack(s, 50)).toBe(false)
    expect(isSnoozed(s, 100)).toBe(false)
    expect(isBack(s, 100)).toBe(true)
    expect(isSnoozed({ snooze: null }, 50)).toBe(false)
    expect(isBack({}, 50)).toBe(false)
  })
})
