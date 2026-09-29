import { describe, expect, test } from 'vitest'

import type { GroupsResponse, Session, SessionGroup } from '@/api/types'
import {
  BOARD_ORDER_MAX,
  applyGroupEdit,
  memberId,
  reorderColumns,
  UNGROUPED_ID,
  type BoardColumn,
  boardColumns,
  boardOrder,
  effectiveGroups,
  fallbackGroups,
  groupsStatusText,
  parseIdList,
  parseViewMode,
  regroupToast,
  repoOf,
  statusSummary,
  stickyColumns,
} from './groups'

const s = (over: Partial<Session>): Session => ({ host: 'laptop', session_id: 'id', status: 'idle', ...over })
const g = (id: string, members: [string, string][], over: Partial<SessionGroup> = {}): SessionGroup => ({
  id,
  label: id,
  description: null,
  source: 'llm',
  members: members.map(([host, id]) => ({ host, id })),
  ...over,
})
const resp = (over: Partial<GroupsResponse>): GroupsResponse => ({
  enabled: true,
  host: 'laptop',
  intervalMinutes: 10,
  running: false,
  updatedAt: null,
  lastRun: null,
  groups: [],
  ...over,
})

describe('repoOf', () => {
  test('basename of the cwd', () => {
    expect(repoOf('~/Code/project')).toEqual({ id: 'repo:~/Code/project', label: 'project' })
    expect(repoOf('/srv/app/')).toEqual({ id: 'repo:/srv/app', label: 'app' })
  })
  test('worktrees group under their repo', () => {
    for (const cwd of ['~/Code/project/.worktrees/fix-a', '~/Code/project/worktrees/b/sub', '~/Code/project/.claude/worktrees/c'])
      expect(repoOf(cwd)?.id).toBe('repo:~/Code/project')
  })
  test('nothing for an empty cwd', () => {
    expect(repoOf(null)).toBeNull()
    expect(repoOf('  ')).toBeNull()
  })
})

test('fallbackGroups: one group per repo, across hosts', () => {
  const groups = fallbackGroups([
    s({ session_id: 'a', cwd: '~/Code/project' }),
    s({ session_id: 'b', host: 'workstation', cwd: '~/Code/project/.worktrees/x' }),
    s({ session_id: 'c', cwd: '~/Code/other' }),
    s({ session_id: 'd', cwd: null }),
  ])
  expect(groups.map((x) => [x.label, x.source, x.members.length])).toEqual([
    ['project', 'fallback', 2],
    ['other', 'fallback', 1],
  ])
})

test('effectiveGroups: server groups when enabled, else the fallback', () => {
  const sessions = [s({ session_id: 'a', cwd: '~/Code/project' })]
  expect(effectiveGroups(resp({ groups: [g('g1', [])] }), sessions)).toEqual({ groups: [g('g1', [])], fallback: false })
  expect(effectiveGroups(resp({ enabled: false }), sessions).fallback).toBe(true)
  expect(effectiveGroups(null, sessions).groups[0].label).toBe('project')
})

describe('boardColumns', () => {
  const sessions = [
    s({ session_id: 'a', status: 'idle', updated_at: 1 }),
    s({ session_id: 'b', status: 'busy', updated_at: 2 }),
    s({ session_id: 'c', status: 'waiting', updated_at: 3 }),
    s({ session_id: 'd', host: 'workstation', status: 'idle', updated_at: 5 }),
    s({ session_id: 'e', status: 'idle', updated_at: 4 }),
  ]

  test('joins, drops dead members and empty groups, puts the rest in Ungrouped (last)', () => {
    const cols = boardColumns(sessions, [
      g('quiet', [['laptop', 'a'], ['laptop', 'gone']]),
      g('empty', [['laptop', 'gone2']]),
      g('hot', [['laptop', 'b'], ['laptop', 'c'], ['workstation', 'd']]),
    ])
    expect(cols.map((c) => c.id)).toEqual(['hot', 'quiet', UNGROUPED_ID])
    expect(cols[0].sessions.map((x) => x.session_id)).toEqual(['c', 'd', 'b']) // waiting first, then recency
    expect(cols[0].summary).toEqual({ waiting: 1, busy: 1, idle: 1, unknown: 0 })
    expect(cols[2]).toMatchObject({ label: 'Ungrouped', ungrouped: true })
    expect(cols[2].sessions.map((x) => x.session_id)).toEqual(['e'])
  })

  test('a session claimed twice lands in the first group only', () => {
    const cols = boardColumns([sessions[0]], [g('one', [['laptop', 'a']]), g('two', [['laptop', 'a']])])
    expect(cols.map((c) => c.id)).toEqual(['one'])
  })

  test('members match by host too, and by pid when that is the id', () => {
    const cols = boardColumns(
      [s({ session_id: 'x', pid: 42 }), s({ session_id: 'y', host: 'workstation' })],
      [g('pid', [['laptop', '42']]), g('wrong-host', [['laptop', 'y']])],
    )
    expect(cols.map((c) => [c.id, c.sessions.map((x) => x.session_id)])).toEqual([
      ['pid', ['x']],
      [UNGROUPED_ID, ['y']],
    ])
  })

  test('ordering: waiting > busy > size > label', () => {
    const cols = boardColumns(
      [
        s({ session_id: 'a' }),
        s({ session_id: 'b' }),
        s({ session_id: 'c' }),
        s({ session_id: 'd', status: 'busy' }),
        s({ session_id: 'e', status: 'waiting' }),
        s({ session_id: 'f' }),
      ],
      [g('big', [['laptop', 'a'], ['laptop', 'b']]), g('busy', [['laptop', 'd']]), g('beta', [['laptop', 'c']]), g('alpha', [['laptop', 'f']]), g('wait', [['laptop', 'e']])],
    )
    expect(cols.map((c) => c.id)).toEqual(['wait', 'busy', 'big', 'alpha', 'beta'])
    expect(boardOrder(cols).map((x) => x.session_id)).toEqual(['e', 'd', 'a', 'b', 'f', 'c'])
  })

  test('filtered-out sessions simply do not appear', () => {
    expect(boardColumns([], [g('g', [['laptop', 'a']])])).toEqual([])
  })
})

test('statusSummary counts unknown statuses as unknown', () => {
  expect(statusSummary([s({ status: 'weird' }), s({ status: 'busy' })])).toEqual({ waiting: 0, busy: 1, idle: 0, unknown: 1 })
})

describe('groupsStatusText', () => {
  const now = 1_000_000
  test('disabled / missing → fallback', () => {
    expect(groupsStatusText(null, now)).toBe('fallback: by repo')
    expect(groupsStatusText(resp({ enabled: false }), now)).toBe('fallback: by repo')
  })
  test('running, never run, ok, failed', () => {
    expect(groupsStatusText(resp({ running: true }), now)).toBe('grouping…')
    expect(groupsStatusText(resp({}), now)).toBe('not grouped yet')
    expect(groupsStatusText(resp({ lastRun: { at: now - 180_000, ms: 1, ok: true, mode: 'incremental', modelCalls: 1 } }), now)).toBe(
      'grouped 3m ago · 1 model call',
    )
    expect(groupsStatusText(resp({ lastRun: { at: now - 60_000, ms: 1, ok: true, mode: 'noop', modelCalls: 0 } }), now)).toBe(
      'grouped 1m ago · 0 model calls',
    )
    expect(groupsStatusText(resp({ lastRun: { at: now - 60_000, ms: 1, ok: true, mode: 'fallback' } }), now)).toBe('grouped 1m ago · fallback')
    expect(groupsStatusText(resp({ lastRun: { at: now - 120_000, ms: 1, ok: false, error: 'x' } }), now)).toBe('grouping failed 2m ago')
  })
})

test('regroupToast', () => {
  expect(regroupToast(resp({ lastRun: { at: 1, ms: 1, ok: false, error: 'claude missing' } }))).toBe('Grouping failed: claude missing')
  expect(regroupToast(resp({ groups: [g('a', [])], lastRun: { at: 1, ms: 1, ok: true, mode: 'noop', modelCalls: 0 } }))).toBe(
    'No changes · 1 group',
  )
  expect(
    regroupToast(resp({ groups: [g('a', []), g('b', [])], lastRun: { at: 1, ms: 1, ok: true, mode: 'incremental', modelCalls: 2, classified: 3 } })),
  ).toBe('Grouped 3 sessions into 2 groups · 2 model calls')
})

test('parseIdList / parseViewMode', () => {
  expect(parseIdList(['a', 1, 'b'])).toEqual(['a', 'b'])
  expect(parseIdList('nope')).toEqual([])
  expect(parseViewMode('board')).toBe('board')
  expect(parseViewMode('grid')).toBeUndefined()
})

describe('stickyColumns', () => {
  const col = (id: string, over: Partial<BoardColumn> = {}): BoardColumn => ({
    id,
    label: id,
    description: null,
    source: 'llm',
    ungrouped: id === UNGROUPED_ID,
    sessions: [],
    summary: { waiting: 0, busy: 0, idle: 0, unknown: 0 },
    ...over,
  })
  const ids = (cols: BoardColumn[]) => cols.map((c) => c.id)

  test('first run keeps the incoming order and remembers it (Ungrouped not remembered, always last)', () => {
    const r = stickyColumns([col('b'), col('a'), col(UNGROUPED_ID)], [])
    expect(ids(r.columns)).toEqual(['b', 'a', UNGROUPED_ID])
    expect(r.order).toEqual(['b', 'a'])
  })

  test('known columns keep their place when the incoming order changes; new ones are appended', () => {
    const r = stickyColumns([col(UNGROUPED_ID), col('new'), col('a'), col('b')], ['b', 'a'])
    expect(ids(r.columns)).toEqual(['b', 'a', 'new', UNGROUPED_ID])
    expect(r.order).toEqual(['b', 'a', 'new'])
  })

  test('a column that disappears keeps its slot for when it comes back', () => {
    const gone = stickyColumns([col('c'), col('a')], ['a', 'b', 'c'])
    expect(ids(gone.columns)).toEqual(['a', 'c'])
    expect(gone.order).toEqual(['a', 'b', 'c'])
    expect(ids(stickyColumns([col('c'), col('b'), col('a')], gone.order).columns)).toEqual(['a', 'b', 'c'])
  })

  test('over the cap, absent ids are forgotten first', () => {
    const prev = Array.from({ length: BOARD_ORDER_MAX }, (_, i) => `old${i}`)
    const r = stickyColumns([col('old50'), col('new')], prev)
    expect(r.order).toHaveLength(BOARD_ORDER_MAX)
    expect(r.order).toContain('old50')
    expect(r.order).not.toContain('old0')
    expect(r.order.at(-1)).toBe('new')
  })
})

describe('applyGroupEdit', () => {
  const base = resp({ groups: [g('g-1', [['laptop', 'a'], ['laptop', 'b']]), g('g-2', [['workstation', 'c']], { label: 'Reviews' })] })

  test('rename changes only that label', () => {
    const r = applyGroupEdit(base, { op: 'rename', id: 'g-2', label: 'Code Reviews' })
    expect(r.groups.map((x) => x.label)).toEqual(['g-1', 'Code Reviews'])
    expect(base.groups[1].label).toBe('Reviews')
  })

  test('move into a group; an emptied group goes', () => {
    const r = applyGroupEdit(base, { op: 'move', host: 'workstation', session: 'c', to: 'g-1' })
    expect(r.groups.map((x) => [x.id, x.members.map((m) => m.id)])).toEqual([['g-1', ['a', 'b', 'c']]])
  })

  test('move to a new group, or to the one that already has that name', () => {
    const r = applyGroupEdit(base, { op: 'move', host: 'laptop', session: 'a', label: 'Spike' })
    expect(r.groups.at(-1)).toMatchObject({ id: 'pending:Spike', label: 'Spike', source: 'manual', members: [{ host: 'laptop', id: 'a' }] })
    const reused = applyGroupEdit(base, { op: 'move', host: 'laptop', session: 'a', label: 'reviews' })
    expect(reused.groups.find((x) => x.id === 'g-2')?.members.map((m) => m.id)).toEqual(['c', 'a'])
  })

  test('memberId: the session id, else the pid', () => {
    expect(memberId(s({ session_id: 'x' }))).toBe('x')
    expect(memberId(s({ session_id: '', pid: 42 }))).toBe('42')
  })
})

test('reorderColumns', () => {
  expect(reorderColumns(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
  expect(reorderColumns(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a'])
  expect(reorderColumns(['a', 'b', 'c'], 'a', UNGROUPED_ID)).toEqual(['b', 'c', 'a'])
  expect(reorderColumns(['a', 'b'], 'x', 'b')).toEqual(['a', 'x', 'b'])
  expect(reorderColumns(['a', 'b'], 'a', 'a')).toEqual(['a', 'b'])
})
