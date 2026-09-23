import { describe, expect, test } from 'vitest'

import { clockTime, firstLine, hostColorSlot, relTime, sessionSubtitle, shortCwd } from './format'

describe('relTime', () => {
  const now = 1_000_000_000_000
  test('seconds, minutes, hours, days', () => {
    expect(relTime(now - 5_000, now)).toBe('5s')
    expect(relTime(now - 5 * 60_000, now)).toBe('5m')
    expect(relTime(now - 3 * 3_600_000, now)).toBe('3h')
    expect(relTime(now - 47 * 3_600_000, now)).toBe('47h')
    expect(relTime(now - 4 * 86_400_000, now)).toBe('4d')
  })
  test('future clamps to 0s; missing is empty', () => {
    expect(relTime(now + 10_000, now)).toBe('0s')
    expect(relTime(0, now)).toBe('')
    expect(relTime(null, now)).toBe('')
    expect(relTime(Number.NaN, now)).toBe('')
  })
})

test('clockTime: time today, date + time otherwise', () => {
  const now = new Date(2026, 6, 3, 18, 0).getTime()
  expect(clockTime(new Date(2026, 6, 3, 14, 3).getTime(), now)).toBe('14:03')
  expect(clockTime(new Date(2026, 6, 2, 9, 5).getTime(), now)).toBe('2.7. 09:05')
  expect(clockTime(undefined, now)).toBe('')
})

test('shortCwd: home → ~, head-truncated', () => {
  expect(shortCwd('/Users/someone/Code/project')).toBe('~/Code/project')
  expect(shortCwd('/home/someone/src')).toBe('~/src')
  expect(shortCwd('/srv/app')).toBe('/srv/app')
  const long = `/srv/${'a'.repeat(60)}/tail`
  const out = shortCwd(long)
  expect(out.length).toBe(46)
  expect(out.startsWith('…')).toBe(true)
  expect(out.endsWith('/tail')).toBe(true)
  expect(shortCwd(null)).toBe('')
})

test('firstLine / sessionSubtitle', () => {
  expect(firstLine('\n  \n  hello \nworld')).toBe('hello')
  expect(firstLine(undefined)).toBe('')
  expect(sessionSubtitle({ gen_title: ' Fix login ', title: 'first prompt' })).toBe('Fix login')
  expect(sessionSubtitle({ gen_title: null, title: '\nfirst prompt\nmore' })).toBe('first prompt')
  expect(sessionSubtitle({ title: 'x'.repeat(300) })).toBe(`${'x'.repeat(240)}…`)
})

test('hostColorSlot: stable, in range, same hash as the classic UI', () => {
  // classic: hash = (hash * 31 + codePoint) >>> 0, slot = hash % 4
  const classic = (s: string) => {
    let h = 0
    for (const ch of s) h = (h * 31 + ch.codePointAt(0)!) >>> 0
    return h % 4
  }
  for (const name of ['laptop', 'workstation', 'local', '', 'ÄÖ-host']) {
    expect(hostColorSlot(name)).toBe(classic(name))
  }
  expect(hostColorSlot('laptop')).toBe(hostColorSlot('laptop'))
})
