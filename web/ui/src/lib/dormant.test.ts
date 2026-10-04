import { describe, expect, it } from 'vitest'

import { ApiError } from '@/api/client'
import type { DormantView } from '@/api/types'
import { dormantCount, dormantErrorMessage, dormantIndex, dormantMember, dormantMeta, dormantMissing, dormantTitles, restoreSummary } from '@/lib/dormant'

const NOW = Date.parse('2026-10-04T12:00:00Z')
const tmux: DormantView = {
  kind: 'tmux',
  target: 'fix-login',
  name: 'fix-login',
  since: '2026-10-04T09:00:00Z',
  windows: 1,
  panes: 2,
  sessions: [{ sessionId: 'aaaa-1', name: 'fix', title: 'Fix login', cwd: '~/Code/project' }],
}
const lone: DormantView = { kind: 'claude', target: 'bbbb-2', name: 'Review PR', since: null, windows: 0, panes: 0, sessions: [{ sessionId: 'bbbb-2', name: null, title: null, cwd: null }] }

describe('dormant helpers', () => {
  it('indexes dormant Claude sessions by host/sessionId', () => {
    const idx = dormantIndex([{ host: 'workstation', views: [tmux, lone] }])
    expect([...idx.keys()]).toEqual(['workstation/aaaa-1', 'workstation/bbbb-2'])
    expect(idx.get('workstation/aaaa-1')).toEqual({ host: 'workstation', id: 'aaaa-1', title: 'Fix login', since: Date.parse('2026-10-04T09:00:00Z') })
    expect(idx.get('workstation/bbbb-2')?.title).toBe('Review PR')
    expect(dormantCount([{ host: 'a', views: [tmux, lone] }, { host: 'b', views: [] }])).toBe(2)
  })

  it('a group member is dormant by the server flag or the dormant list', () => {
    const idx = dormantIndex([{ host: 'laptop', views: [tmux] }])
    expect(dormantMember({ host: 'laptop', id: 'aaaa-1' }, idx)?.title).toBe('Fix login')
    expect(dormantMember({ host: 'laptop', id: 'cccc-3', dormant: true }, idx)).toEqual({ host: 'laptop', id: 'cccc-3', title: 'cccc-3', since: null })
    expect(dormantMember({ host: 'laptop', id: 'cccc-3' }, idx)).toBeNull()
    expect(dormantMember({ host: 'workstation', id: 'aaaa-1' }, idx)).toBeNull()
  })

  it('titles and meta lines', () => {
    expect(dormantTitles(tmux)).toBe('Fix login')
    expect(dormantTitles({ ...tmux, sessions: [] })).toBe('no Claude panes')
    expect(dormantMeta(tmux, NOW)).toBe('tmux · 1 window · 2 panes · down 3h')
    expect(dormantMeta(lone, NOW)).toBe('not in tmux')
  })

  it('errors: old servers are missing, ambiguity lists candidates', () => {
    expect(dormantMissing(new ApiError('not found', 404))).toBe(true)
    expect(dormantMissing(new ApiError('x', 501))).toBe(true)
    expect(dormantMissing(new ApiError('no dormant session matches "x"', 404))).toBe(false)
    expect(dormantErrorMessage(new ApiError('amb', 409, { error: 'amb', candidates: ['a', 'b'] }))).toBe('Ambiguous — matches a, b')
    expect(dormantErrorMessage(new ApiError('no dormant session matches "x"', 404))).toBe('no dormant session matches "x"')
  })

  it('restore summaries', () => {
    const entry = { kind: 'tmux', from: 'fix-login', session: 'fix-login', renamed: false, windows: 1, panes: 2, launched: [{ sessionId: 'aaaa-1', title: 'Fix login', line: '…' }], warnings: [], commands: [], dryRun: false }
    expect(restoreSummary({ host: 'laptop', restored: [entry], failed: [] })).toEqual({ ok: true, title: 'Resumed fix-login', description: '1 Claude session resuming' })
    const partial = restoreSummary({ host: 'laptop', restored: [entry], failed: [{ target: 'x', error: 'boom' }] })
    expect(partial.ok).toBe(false)
    expect(partial.description).toBe('1 Claude session resuming\nx: boom')
    expect(restoreSummary({ host: 'laptop', restored: [], failed: [] }).title).toBe('Nothing resumed')
  })
})
