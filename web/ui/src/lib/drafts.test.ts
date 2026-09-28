import { expect, test } from 'vitest'

import { DRAFT_TTL_MS, joinDraft, pruneDrafts } from './drafts'

test('pruneDrafts drops expired, empty and malformed drafts', () => {
  const now = 10 * DRAFT_TTL_MS
  expect(
    pruneDrafts(
      {
        'laptop/a': { text: 'keep', at: now - 1000 },
        'laptop/b': { text: 'old', at: now - DRAFT_TTL_MS },
        'laptop/c': { text: '', at: now },
        'laptop/d': { text: 42, at: now },
        'laptop/e': null,
      },
      now,
    ),
  ).toEqual({ 'laptop/a': { text: 'keep', at: now - 1000 } })
  expect(pruneDrafts(null, now)).toEqual({})
  expect(pruneDrafts('junk', now)).toEqual({})
})

test('joinDraft appends a parked draft to the saved one', () => {
  expect(joinDraft('', '~/a.md ')).toBe('~/a.md ')
  expect(joinDraft('look at', '')).toBe('look at')
  expect(joinDraft('look at', '~/a.md ')).toBe('look at ~/a.md ')
  expect(joinDraft('look at\n', '~/a.md ')).toBe('look at\n~/a.md ')
})
