import { describe, expect, test } from 'vitest'

import { linkify, parseInline, parseMarkdown, safeHref } from './markdown'

describe('safeHref', () => {
  test('only http(s)', () => {
    expect(safeHref('https://x.dev/a')).toBe('https://x.dev/a')
    expect(safeHref(' http://x ')).toBe('http://x')
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('data:text/html,hi')).toBeNull()
    expect(safeHref('/relative')).toBeNull()
  })
})

describe('linkify', () => {
  test('bare urls, trailing punctuation stripped', () => {
    expect(linkify('see https://a.dev/x. ok')).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'link', href: 'https://a.dev/x', children: [{ t: 'text', v: 'https://a.dev/x' }] },
      { t: 'text', v: '. ok' },
    ])
  })
  test('keeps a balanced closing paren', () => {
    const out = linkify('(https://en.wikipedia.org/wiki/A_(b))')
    expect(out[1]).toMatchObject({ t: 'link', href: 'https://en.wikipedia.org/wiki/A_(b)' })
  })
  test('no url → one text node', () => {
    expect(linkify('plain')).toEqual([{ t: 'text', v: 'plain' }])
  })
})

describe('parseInline', () => {
  test('code, bold, em, link', () => {
    expect(parseInline('`a` **b** *c* [d](https://e.f)')).toEqual([
      { t: 'code', v: 'a' },
      { t: 'text', v: ' ' },
      { t: 'strong', children: [{ t: 'text', v: 'b' }] },
      { t: 'text', v: ' ' },
      { t: 'em', children: [{ t: 'text', v: 'c' }] },
      { t: 'text', v: ' ' },
      { t: 'link', href: 'https://e.f', children: [{ t: 'text', v: 'd' }] },
    ])
  })
  test('unsafe link stays text', () => {
    expect(parseInline('[x](javascript:alert(1))').every((n) => n.t !== 'link')).toBe(true)
  })
  test('snake_case is not emphasis', () => {
    expect(parseInline('my_var_name')).toEqual([{ t: 'text', v: 'my_var_name' }])
  })
  test('html is plain text', () => {
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([{ t: 'text', v: '<img src=x onerror=alert(1)>' }])
  })
})

describe('parseMarkdown', () => {
  test('blocks', () => {
    const src = [
      '# Title',
      'para line 1',
      'para line 2',
      '',
      '- a',
      '  - a1',
      '- b',
      '',
      '1. one',
      '',
      '> quoted',
      '',
      '---',
      '```ts',
      'const x = 1',
      '```',
      '| h1 | h2 |',
      '| --- | --- |',
      '| c1 | c2 |',
    ].join('\n')
    const blocks = parseMarkdown(src)
    expect(blocks.map((b) => b.t)).toEqual(['h', 'p', 'list', 'list', 'quote', 'hr', 'code', 'table'])
    expect(blocks[1]).toMatchObject({ t: 'p', lines: [[{ v: 'para line 1' }], [{ v: 'para line 2' }]] })
    expect(blocks[2]).toMatchObject({ t: 'list', ordered: false, items: [{ sub: { items: [[{ v: 'a1' }]] } }, {}] })
    expect(blocks[3]).toMatchObject({ t: 'list', ordered: true })
    expect(blocks[6]).toEqual({ t: 'code', lang: 'ts', text: 'const x = 1' })
    expect(blocks[7]).toMatchObject({ t: 'table', head: [[{ v: 'h1' }], [{ v: 'h2' }]], rows: [[[{ v: 'c1' }], [{ v: 'c2' }]]] })
  })
  test('unterminated fence swallows the rest', () => {
    expect(parseMarkdown('```\na\nb')).toEqual([{ t: 'code', lang: '', text: 'a\nb' }])
  })
  test('empty / null', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown(null)).toEqual([])
  })
})
