import { describe, expect, test } from 'vitest'

import type { BriefResource } from '@/api/types'

import { briefBody, briefTime, continueDraft, groupResources, planProgress, retryMinutes, setPlanItem } from './brief'

const md = `---
session: 0000-aaaa
updated: 2026-01-02T03:04:05.000Z
---
## Summary
Fixing the login loop; see - [ ] not a plan item here.

## Resources
- Branch: \`fix-login\`
- [ ] odd resource line

## Plan
- [x] reproduce the loop
* [ ] fix the redirect (in progress)
text between
- [X] write a test

## Notes
- [ ] not in the plan either
`

describe('briefBody', () => {
  test('drops the frontmatter, keeps the body', () => {
    expect(briefBody(md).startsWith('## Summary\n')).toBe(true)
    expect(briefBody('## Summary\nx\n')).toBe('## Summary\nx\n')
    expect(briefBody(null)).toBe('')
  })
})

describe('setPlanItem', () => {
  test('toggles the nth checkbox of ## Plan only', () => {
    const out = setPlanItem(md, 1, true)!
    expect(out).toContain('* [x] fix the redirect (in progress)')
    // Everything else is untouched: other sections' checkboxes, other plan items, free text.
    expect(out).toContain('- [ ] odd resource line')
    expect(out).toContain('- [ ] not in the plan either')
    expect(out).toContain('- [x] reproduce the loop')
    expect(out).toContain('text between')
    expect(out).not.toContain('session: 0000-aaaa')
  })

  test('unchecks (also an upper-case X) and indexes past free text', () => {
    expect(setPlanItem(md, 2, false)).toContain('- [ ] write a test')
    expect(setPlanItem(md, 0, false)).toContain('- [ ] reproduce the loop')
  })

  test('headings are case-insensitive; a missing item is null', () => {
    expect(setPlanItem('## plan\n- [ ] a\n', 0, true)).toBe('## plan\n- [x] a\n')
    expect(setPlanItem(md, 3, true)).toBeNull()
    expect(setPlanItem('## Summary\n- [ ] a\n', 0, true)).toBeNull()
  })

  test('toggling twice builds on the previous result', () => {
    const once = setPlanItem(md, 1, true)!
    const twice = setPlanItem(once, 0, false)!
    expect(twice).toContain('- [ ] reproduce the loop')
    expect(twice).toContain('* [x] fix the redirect')
  })
})

const res = (kind: string | null, label: string): BriefResource => ({ kind, label, url: null, path: label, text: label })

describe('groupResources', () => {
  test('groups by kind in display order, notes last, order kept inside a group', () => {
    const groups = groupResources([
      res('Link', 'l1'),
      res(null, 'note'),
      res('File', 'f1'),
      res('PR', 'p1'),
      res('Future', 'x'),
      res('File', 'f2'),
    ])
    expect(groups.map((g) => [g.kind, g.label, g.items.map((i) => i.label)])).toEqual([
      ['PR', 'Pull requests', ['p1']],
      ['File', 'Files', ['f1', 'f2']],
      ['Link', 'Links', ['l1']],
      ['Future', 'Future', ['x']],
      [null, 'Notes', ['note']],
    ])
  })

  test('nothing → no groups', () => {
    expect(groupResources([])).toEqual([])
    expect(groupResources(undefined)).toEqual([])
  })
})

test('planProgress', () => {
  expect(planProgress([{ done: true }, { done: false }, { done: true }])).toEqual({ done: 2, total: 3 })
  expect(planProgress([])).toBeNull()
  expect(planProgress(null)).toBeNull()
})

test('continueDraft ends with a blank line for the caret', () => {
  expect(continueDraft('Continue the work.\n')).toBe('Continue the work.\n\n')
  expect(continueDraft('')).toBe('')
})

test('retryMinutes rounds up, at least 1', () => {
  expect(retryMinutes(61_000)).toBe(2)
  expect(retryMinutes(1)).toBe(1)
  expect(retryMinutes(undefined)).toBe(1)
})

test('briefTime', () => {
  expect(briefTime('2026-01-02T03:04:05.000Z')).toBe(Date.UTC(2026, 0, 2, 3, 4, 5))
  expect(briefTime(null)).toBeNull()
  expect(briefTime('nope')).toBeNull()
})
