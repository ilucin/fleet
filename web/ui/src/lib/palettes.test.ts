/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

import { PALETTES, parsePalette, themeColor, type PaletteMode } from './palettes'

test('parsePalette: known ids pass, anything else is Default', () => {
  expect(parsePalette('earth')).toBe('earth')
  expect(parsePalette('dusk')).toBe('dusk')
  expect(parsePalette('default')).toBe('default')
  expect(parsePalette(null)).toBe('default')
  expect(parsePalette(undefined)).toBe('default')
  expect(parsePalette('')).toBe('default')
  expect(parsePalette('Earth')).toBe('default')
  expect(parsePalette('toString')).toBe('default')
})

test('themeColor: the palette background per mode', () => {
  expect(themeColor('default', 'dark')).toBe('#0b0c0e')
  expect(themeColor('default', 'light')).toBe('#ffffff')
  expect(themeColor('earth', 'light')).toBe('#f7f2ea')
  expect(themeColor('dusk', 'dark')).toBe('#121119')
})

// Read from disk: vitest stubs CSS imports (even `?raw`).
const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')

/** The token block for a palette + mode in index.css. */
function block(id: string, mode: PaletteMode): string {
  const sel = id === 'default' ? (mode === 'dark' ? '.dark' : ':root') : `:root[data-palette="${id}"]${mode === 'dark' ? '.dark' : ''}`
  const start = css.indexOf(`\n${sel} {`)
  expect(start, sel).toBeGreaterThan(-1)
  return css.slice(start, css.indexOf('}', start))
}
const token = (b: string, name: string) => b.match(new RegExp(`--${name}: (#[0-9a-f]{6});`))?.[1]

test('swatches match the index.css tokens', () => {
  for (const p of PALETTES) {
    for (const mode of ['light', 'dark'] as const) {
      const b = block(p.id, mode)
      expect(token(b, 'background'), `${p.id} ${mode}`).toBe(p.swatch[mode].background)
      expect(token(b, 'card'), `${p.id} ${mode}`).toBe(p.swatch[mode].card)
      expect(token(b, 'primary'), `${p.id} ${mode}`).toBe(p.swatch[mode].primary)
    }
  }
})

test('every non-default palette overrides every default token, in both modes', () => {
  const names = (b: string) => [...b.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]).filter((n) => n !== 'radius')
  const light = names(block('default', 'light'))
  const dark = names(block('default', 'dark'))
  expect(light.sort()).toEqual(dark.sort())
  for (const p of PALETTES.filter((x) => x.id !== 'default')) {
    expect(names(block(p.id, 'light')).sort(), p.id).toEqual(light)
    expect(names(block(p.id, 'dark')).sort(), p.id).toEqual(light)
  }
})

test('the index.html pre-paint script knows every palette and its theme-colors', () => {
  for (const p of PALETTES) {
    expect(html).toContain(`${p.id}: ['${themeColor(p.id, 'dark')}', '${themeColor(p.id, 'light')}']`)
  }
})
