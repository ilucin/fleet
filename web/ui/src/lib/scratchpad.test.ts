import { describe, expect, it } from 'vitest'

import { MIN_H, MIN_W, clampRect, defaultRect, parseRect, scratchpad } from '@/lib/scratchpad'

describe('scratchpad rect', () => {
  it('starts bottom-right, inside the viewport', () => {
    const r = defaultRect(1440, 900)
    expect(r.w).toBe(440)
    expect(r.x + r.w).toBeLessThanOrEqual(1440)
    expect(r.y + r.h).toBeLessThanOrEqual(900)
    expect(clampRect(r, 1440, 900)).toEqual(r)
  })

  it('keeps a moved / resized panel on screen and above the minimum size', () => {
    expect(clampRect({ x: -50, y: 2000, w: 100, h: 50 }, 1200, 800)).toEqual({ x: 0, y: 800 - MIN_H, w: MIN_W, h: MIN_H })
    expect(clampRect({ x: 1100, y: 10, w: 400, h: 300 }, 1200, 800)).toEqual({ x: 800, y: 10, w: 400, h: 300 })
    // A viewport smaller than the panel: the viewport wins.
    expect(clampRect({ x: 0, y: 0, w: 900, h: 900 }, 600, 400)).toEqual({ x: 0, y: 0, w: 600, h: 400 })
  })

  it('rejects malformed stored rects', () => {
    expect(parseRect(null)).toBeNull()
    expect(parseRect({ x: 1, y: 2, w: 'a', h: 4 })).toBeNull()
    expect(parseRect({ x: 1, y: 2, w: 3, h: 4 })).toEqual({ x: 1, y: 2, w: 3, h: 4 })
  })
})

describe('scratchpad toggle', () => {
  it('opens, focuses when open elsewhere, closes when focused', () => {
    scratchpad.hide()
    const t0 = scratchpad.focusTick()
    scratchpad.toggle(false)
    expect(scratchpad.isOpen()).toBe(true)
    scratchpad.toggle(false)
    expect(scratchpad.isOpen()).toBe(true)
    expect(scratchpad.focusTick()).toBe(t0 + 2)
    scratchpad.toggle(true)
    expect(scratchpad.isOpen()).toBe(false)
  })
})
