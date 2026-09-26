import { expect, test } from 'vitest'

import { SIDEBAR_DEFAULT_W, SIDEBAR_MAX_W, SIDEBAR_MIN_W, clampSidebarWidth } from '@/lib/layout'

test('clampSidebarWidth keeps the sidebar within bounds', () => {
  expect(clampSidebarWidth(400)).toBe(400)
  expect(clampSidebarWidth(401.6)).toBe(402)
  expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN_W)
  expect(clampSidebarWidth(5000)).toBe(SIDEBAR_MAX_W)
  expect(clampSidebarWidth(Number('abc'))).toBe(SIDEBAR_DEFAULT_W)
  expect(clampSidebarWidth(Number(''))).toBe(SIDEBAR_MIN_W) // Number('') is 0
})
