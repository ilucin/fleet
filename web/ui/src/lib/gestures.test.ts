import { describe, expect, test } from 'vitest'

import { pullIntent, swipeAxis, swipeBackBlocked, swipeBackIntent, swipeIntent, type SwipeNode } from './gestures'

describe('swipeIntent', () => {
  test('up opens, down closes, tiny moves are taps', () => {
    expect(swipeIntent(-40)).toBe('open')
    expect(swipeIntent(30)).toBe('close')
    expect(swipeIntent(3)).toBe('tap')
    expect(swipeIntent(-15)).toBeNull()
  })
})

describe('pullIntent', () => {
  test('down opens, up closes, tiny moves are taps', () => {
    expect(pullIntent(0, 40)).toBe('open')
    expect(pullIntent(5, -30)).toBe('close')
    expect(pullIntent(2, 3)).toBe('tap')
    expect(pullIntent(0, 15)).toBeNull()
  })
  test('mostly horizontal moves (chip rows) are ignored', () => {
    expect(pullIntent(60, 30)).toBeNull()
    expect(pullIntent(-40, -30)).toBeNull()
  })
})

describe('swipeAxis', () => {
  test('undecided until the finger moves', () => {
    expect(swipeAxis(4, 6)).toBeNull()
  })
  test('clearly rightwards is back; left, vertical or diagonal is not', () => {
    expect(swipeAxis(20, 5)).toBe('back')
    expect(swipeAxis(-20, 2)).toBe('other')
    expect(swipeAxis(3, 20)).toBe('other')
    expect(swipeAxis(15, 12)).toBe('other')
  })
})

describe('swipeBackIntent', () => {
  test('long or quick horizontal swipes go back', () => {
    expect(swipeBackIntent(130, 10, 800)).toBe(true)
    expect(swipeBackIntent(80, 10, 150)).toBe(true)
  })
  test('short, slow, or too vertical swipes do not', () => {
    expect(swipeBackIntent(60, 0, 50)).toBe(false)
    expect(swipeBackIntent(90, 0, 600)).toBe(false)
    expect(swipeBackIntent(150, 90, 100)).toBe(false)
  })
})

function node(p: Partial<SwipeNode> & { role?: string; overflow?: string }, parent: SwipeNode | null = null): SwipeNode & { overflow?: string } {
  return {
    tagName: 'DIV',
    scrollLeft: 0,
    scrollWidth: 100,
    clientWidth: 100,
    parentElement: parent,
    getAttribute: (n) => (n === 'role' ? (p.role ?? null) : null),
    ...p,
  }
}
const overflowOf = (el: SwipeNode) => (el as { overflow?: string }).overflow ?? 'visible'

describe('swipeBackBlocked', () => {
  const root = node({})
  test('plain content inside the screen is fine', () => {
    expect(swipeBackBlocked(node({ tagName: 'SPAN' }, node({}, root)), root, overflowOf)).toBe(false)
  })
  test('fields and dialogs block', () => {
    expect(swipeBackBlocked(node({ tagName: 'textarea' }, root), root, overflowOf)).toBe(true)
    expect(swipeBackBlocked(node({ tagName: 'INPUT' }, root), root, overflowOf)).toBe(true)
    expect(swipeBackBlocked(node({ isContentEditable: true }, root), root, overflowOf)).toBe(true)
    expect(swipeBackBlocked(node({ tagName: 'SPAN' }, node({ role: 'dialog' }, root)), root, overflowOf)).toBe(true)
  })
  test('a horizontal scroller blocks only while it can still scroll left', () => {
    const scrolled = node({ tagName: 'PRE', overflow: 'auto', scrollWidth: 900, clientWidth: 390, scrollLeft: 120 }, root)
    expect(swipeBackBlocked(node({ tagName: 'SPAN' }, scrolled), root, overflowOf)).toBe(true)
    const atStart = node({ tagName: 'PRE', overflow: 'auto', scrollWidth: 900, clientWidth: 390, scrollLeft: 0 }, root)
    expect(swipeBackBlocked(atStart, root, overflowOf)).toBe(false)
    const hidden = node({ overflow: 'hidden', scrollWidth: 900, clientWidth: 390, scrollLeft: 50 }, root)
    expect(swipeBackBlocked(hidden, root, overflowOf)).toBe(false)
  })
  test('stops at the root', () => {
    const outer = node({ tagName: 'TEXTAREA' })
    const r = node({}, outer)
    expect(swipeBackBlocked(node({}, r), r, overflowOf)).toBe(false)
  })
})
