import { expect, test } from 'vitest'

import { paletteFilter } from '@/lib/palette'

test('paletteFilter: substring terms, ranked by prefix', () => {
  const kw = ['360-prep-nikola', '~/Code/work', 'laptop']
  expect(paletteFilter('session laptop/abc', '', kw)).toBe(1)
  expect(paletteFilter('session laptop/abc', '360', kw)).toBe(1)
  expect(paletteFilter('session laptop/abc', 'nikola', kw)).toBe(0.8)
  expect(paletteFilter('session laptop/abc', 'kola', kw)).toBe(0.5)
  expect(paletteFilter('session laptop/abc', 'NIKOLA laptop', kw)).toBe(0.8)
  // Not a subsequence matcher: scattered letters do not match.
  expect(paletteFilter('session laptop/abc', 'nkl', kw)).toBe(0)
  expect(paletteFilter('session laptop/abc', 'nikola workstation', kw)).toBe(0)
  expect(paletteFilter('action new', 'new', ['New session…', 'spawn'])).toBe(1)
  expect(paletteFilter('action new', 'sess', ['New session…'])).toBe(0.8)
})
