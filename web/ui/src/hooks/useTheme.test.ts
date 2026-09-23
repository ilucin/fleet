import { expect, test } from 'vitest'

import { resolveTheme } from './useTheme'

test('resolveTheme: dark first, light only when chosen or OS-preferred', () => {
  expect(resolveTheme('system', false)).toBe('dark')
  expect(resolveTheme('system', true)).toBe('light')
  expect(resolveTheme('dark', true)).toBe('dark')
  expect(resolveTheme('light', false)).toBe('light')
})
