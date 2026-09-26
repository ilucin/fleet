import { expect, test } from 'vitest'

import { autoNameSummary, autoNameToast } from './autoname'

test('autoNameToast', () => {
  expect(autoNameToast({ ok: true, renamed: [{ from: 'a', to: 'fix-login' }] })).toBe('Renamed 1: fix-login')
  expect(autoNameToast({ ok: true, renamed: [], held: ['x', 'y'] })).toBe('Nothing to rename (2 waiting on you)')
  expect(autoNameToast({ ok: true })).toBe('Nothing to rename')
  expect(autoNameToast({ ok: false, error: 'boom' })).toBe('Naming failed: boom')
})

test('autoNameSummary', () => {
  expect(autoNameSummary({ ok: true, renamed: [{ from: 'a', to: 'b' }], held: ['c'] })).toBe('renamed 1 · 1 held')
  expect(autoNameSummary({ ok: true, errors: ['e1', 'e2'] })).toBe('2 errors')
  expect(autoNameSummary({ ok: true })).toBe('no changes')
  expect(autoNameSummary({ ok: false })).toBe('failed')
})
