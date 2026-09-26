import { describe, expect, test } from 'vitest'

import { swipeIntent } from './gestures'

describe('swipeIntent', () => {
  test('up opens, down closes, tiny moves are taps', () => {
    expect(swipeIntent(-40)).toBe('open')
    expect(swipeIntent(30)).toBe('close')
    expect(swipeIntent(3)).toBe('tap')
    expect(swipeIntent(-15)).toBeNull()
  })
})
