import { expect, test } from 'vitest'

import type { FleetResponse, Session } from '@/api/types'
import { findSession, listView, matchesSearch, sessionHref, statusLabel, statusMeta } from './sessions'

const s = (over: Partial<Session>): Session => ({ host: 'laptop', session_id: 'id', status: 'idle', ...over })

const fleet: FleetResponse = {
  self: 'laptop',
  hosts: [
    {
      name: 'laptop',
      ok: true,
      sessions: [
        s({ session_id: 'a', name: 'alpha', status: 'busy', updated_at: 100 }),
        s({ session_id: 'b', name: 'beta', status: 'waiting', updated_at: 300, waiting_for: 'permission' }),
      ],
    },
    {
      name: 'workstation',
      ok: true,
      sessions: [s({ host: 'workstation', session_id: 'c', name: 'gamma', status: 'idle', updated_at: 200, cwd: '/srv/api' })],
    },
    { name: 'down', ok: false, error: 'timeout', sessions: [] },
  ],
}

test('statusMeta / statusLabel', () => {
  expect(statusMeta('BUSY').key).toBe('busy')
  expect(statusMeta('weird').key).toBe('unknown')
  expect(statusMeta(null).label).toBe('unknown')
  expect(statusLabel({ status: 'waiting', waiting_for: ' permission ' })).toBe('needs you · permission')
  expect(statusLabel({ status: 'waiting', waiting_for: null })).toBe('needs you')
  expect(statusLabel({ status: 'busy', waiting_for: 'x' })).toBe('working')
})

test('listView: flat, sorted by last activity, counts per status', () => {
  const v = listView(fleet, {})
  expect(v.sessions.map((x) => x.session_id)).toEqual(['b', 'c', 'a'])
  expect(v.counts).toEqual({ all: 3, waiting: 1, busy: 1, idle: 1 })
})

test('listView: host + status + search filters', () => {
  expect(listView(fleet, { host: 'workstation' }).sessions.map((x) => x.session_id)).toEqual(['c'])
  expect(listView(fleet, { host: 'workstation' }).counts.all).toBe(1)
  expect(listView(fleet, { status: 'waiting' }).sessions.map((x) => x.session_id)).toEqual(['b'])
  // counts ignore the status filter (the chips show every status)
  expect(listView(fleet, { status: 'waiting' }).counts.all).toBe(3)
  expect(listView(fleet, { query: 'srv/API' }).sessions.map((x) => x.session_id)).toEqual(['c'])
  expect(listView(null, {}).sessions).toEqual([])
})

test('matchesSearch covers name, titles, cwd, tmux session, host', () => {
  const x = s({ name: 'n', gen_title: 'Gen', title: 'T', cwd: '/c', tmux_session: 'tm', host: 'hh' })
  for (const q of ['n', 'gen', 't', '/c', 'tm', 'hh', '  ']) expect(matchesSearch(x, q)).toBe(true)
  expect(matchesSearch(x, 'zzz')).toBe(false)
})

test('findSession / sessionHref', () => {
  expect(findSession(fleet, 'workstation', 'c')?.name).toBe('gamma')
  expect(findSession(fleet, 'laptop', 'c')).toBeNull()
  expect(sessionHref({ host: 'a b', session_id: 'x/y' })).toBe('/s/a%20b/x%2Fy')
})
