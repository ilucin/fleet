import { describe, expect, test } from 'vitest'

import { dragHasFiles, formatBytes, formatPath, insertPaths, overLimit, uploadName } from './attach'

describe('formatPath', () => {
  test('plain paths stay plain; whitespace / quotes get double quotes', () => {
    expect(formatPath('/u/x/2026-09-26/ab12cd-shot.png')).toBe('/u/x/2026-09-26/ab12cd-shot.png')
    expect(formatPath('/Volumes/My Drive/a.png')).toBe('"/Volumes/My Drive/a.png"')
    expect(formatPath('/tmp/say "hi".txt')).toBe('"/tmp/say \\"hi\\".txt"')
  })
})

describe('insertPaths', () => {
  test('into an empty field: path + trailing space, caret at the end', () => {
    expect(insertPaths('', 0, 0, ['/a.png'])).toEqual({ value: '/a.png ', cursor: 7 })
  })
  test('appends after text without gluing onto the last word', () => {
    expect(insertPaths('look at', 7, 7, ['/a.png'])).toEqual({ value: 'look at /a.png ', cursor: 15 })
    expect(insertPaths('look at ', 8, 8, ['/a.png'])).toEqual({ value: 'look at /a.png ', cursor: 15 })
  })
  test('in the middle: padded on both sides, no double spaces', () => {
    expect(insertPaths('see  please', 4, 4, ['/a'])).toEqual({ value: 'see /a please', cursor: 6 })
    expect(insertPaths('seeplease', 3, 3, ['/a'])).toEqual({ value: 'see /a please', cursor: 7 })
  })
  test('several paths are space-separated; a selection is replaced', () => {
    expect(insertPaths('x SEL y', 2, 5, ['/a', '/b c'])).toEqual({ value: 'x /a "/b c" y', cursor: 11 })
  })
  test('out-of-range selections are clamped; no paths = no change', () => {
    expect(insertPaths('ab', 10, 20, ['/p']).value).toBe('ab /p ')
    expect(insertPaths('ab', 1, 1, [])).toEqual({ value: 'ab', cursor: 1 })
  })
})

describe('uploadName', () => {
  const now = new Date(2026, 8, 26, 9, 5, 7)
  test('real names are kept', () => {
    expect(uploadName({ name: 'report.pdf', type: 'application/pdf' }, now)).toBe('report.pdf')
  })
  test('clipboard images get a timestamped name', () => {
    expect(uploadName({ name: 'image.png', type: 'image/png' }, now)).toBe('pasted-20260926-090507.png')
    expect(uploadName({ name: '', type: 'image/jpeg' }, now)).toBe('pasted-20260926-090507.jpg')
    expect(uploadName({ type: 'application/x-weird' }, now)).toBe('pasted-20260926-090507.bin')
  })
})

describe('limits + display', () => {
  test('overLimit', () => {
    expect(overLimit(5 * 1024 * 1024, 5)).toBe(false)
    expect(overLimit(5 * 1024 * 1024 + 1, 5)).toBe(true)
    expect(overLimit(1e12, null)).toBe(false)
  })
  test('formatBytes', () => {
    expect(formatBytes(12)).toBe('12 B')
    expect(formatBytes(340 * 1024)).toBe('340 KB')
    expect(formatBytes(1.25 * 1024 * 1024)).toBe('1.3 MB')
    expect(formatBytes(120 * 1024 * 1024)).toBe('120 MB')
  })
  test('dragHasFiles', () => {
    expect(dragHasFiles({ types: ['text/plain', 'Files'] })).toBe(true)
    expect(dragHasFiles({ types: ['text/uri-list'] })).toBe(false)
    expect(dragHasFiles(null)).toBe(false)
  })
})
