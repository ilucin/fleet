import { describe, expect, it } from 'vitest'

import type { RepoRow, ReposSettings } from '@/api/types'

import { repoKey, repoPosition, rowInterval, sameSettings, setRowInterval, spanLabel, spanSeconds, syncSummary } from './repos'

const row = (name: string, path = `~/Code/${name}`): RepoRow => ({ name, path, every: 86400, excluded: false, due: false, branch: 'main', ahead: 0, behind: 0, dirty: 0 })
const S: ReposSettings = { roots: ['~/Code'], every: '24h', overrides: {}, exclude: [] }

describe('repos helpers', () => {
  it('spans', () => {
    expect(spanSeconds('30m')).toBe(1800)
    expect(spanSeconds('0m')).toBeNull()
    expect(spanSeconds('1w')).toBeNull()
    expect(spanLabel(1800)).toBe('30m')
    expect(spanLabel(86400)).toBe('24h')
    expect(spanLabel(7 * 86400)).toBe('7d')
  })

  it('keys use the path only for duplicate names', () => {
    const rows = [row('a'), row('x', '~/Code/x'), row('x', '~/Code/work/repos/x')]
    expect(repoKey(rows[0], rows)).toBe('a')
    expect(repoKey(rows[2], rows)).toBe('~/Code/work/repos/x')
  })

  it('per-repo interval round trip', () => {
    const rows = [row('a'), row('b')]
    let s = setRowInterval(S, rows[0], rows, '30m')
    expect(s.overrides).toEqual({ a: '30m' })
    expect(rowInterval(s, rows[0])).toBe('30m')
    s = setRowInterval(s, rows[0], rows, 'off')
    expect(s).toMatchObject({ overrides: {}, exclude: ['a'] })
    expect(rowInterval(s, rows[0])).toBe('off')
    expect(rowInterval(s, rows[1])).toBe('default')
    s = setRowInterval(s, rows[0], rows, 'default')
    expect(sameSettings(s, S)).toBe(true)
    // A path key set by hand still matches.
    expect(rowInterval({ ...S, overrides: { '~/Code/b': '1h' } }, rows[1])).toBe('1h')
  })

  it('position and summary', () => {
    expect(repoPosition({ ahead: 1, behind: 3, dirty: 2 })).toBe('↓3 ↑1 ✎2')
    expect(repoPosition({ ahead: 0, behind: 0, dirty: 0 })).toBe('=')
    const s = syncSummary([
      { name: 'a', path: '~/a', outcome: 'updated', pulled: 2 },
      { name: 'b', path: '~/b', outcome: 'diverged', pulled: 0, detail: '1 local, 2 upstream' },
      { name: 'c', path: '~/c', outcome: 'current', pulled: 0 },
    ])
    expect(s.title).toBe('1 updated, 1 needs attention')
    expect(s.bad).toBe(true)
    expect(s.description).toContain('b: diverged — 1 local, 2 upstream')
  })
})
