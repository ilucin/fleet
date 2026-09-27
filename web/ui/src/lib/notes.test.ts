import { describe, expect, it } from 'vitest'

import type { NoteEntry } from '@/api/types'
import { parseMarkdown } from '@/lib/markdown'
import {
  ancestorDirs,
  buildTree,
  decodeNotePath,
  parseNotesLocation,
  highlightTerms,
  indexNotes,
  notesHref,
  recentNotes,
  resolveNoteLink,
  splitRanges,
  termRanges,
} from '@/lib/notes'

const f = (path: string, mtime = 1, kind: NoteEntry['kind'] = 'markdown'): NoteEntry => ({ path, kind, size: 1, mtime })
const FILES = [f('index.md', 5), f('recipes/soup.md', 9), f('recipes/pasta.md', 2), f('recipes/img/plate.png', 3, 'image'), f('garden/soup.md', 1), f('b.md', 4), f('a/deep/x.md', 7)]

describe('buildTree', () => {
  it('nests dirs (sorted, first) and counts files below', () => {
    const t = buildTree(FILES)
    expect(t.dirs.map((d) => d.name)).toEqual(['a', 'garden', 'recipes'])
    expect(t.files.map((x) => x.path)).toEqual(['b.md', 'index.md'])
    expect(t.count).toBe(7)
    const recipes = t.dirs[2]
    expect(recipes.path).toBe('recipes')
    expect(recipes.count).toBe(3)
    expect(recipes.dirs[0].path).toBe('recipes/img')
    expect(t.dirs[0].dirs[0].path).toBe('a/deep')
  })
  it('ancestorDirs', () => {
    expect(ancestorDirs('a/deep/x.md')).toEqual(['a', 'a/deep'])
    expect(ancestorDirs('index.md')).toEqual([])
  })
})

describe('routes', () => {
  it('encodes each segment and decodes back', () => {
    expect(notesHref()).toBe('/notes')
    expect(notesHref('work station')).toBe('/notes/work%20station')
    expect(notesHref('ws', 'a b/c#d.md')).toBe('/notes/ws/a%20b/c%23d.md')
    expect(decodeNotePath('a%20b/c%23d.md')).toBe('a b/c#d.md')
    expect(decodeNotePath('')).toBeNull()
    expect(decodeNotePath('%E0%A4%A')).toBeNull()
    expect(parseNotesLocation('/notes')).toEqual({ host: null, path: null })
    expect(parseNotesLocation('/notes/ws')).toEqual({ host: 'ws', path: null })
    expect(parseNotesLocation('/notes/work%20station/a%20b/c.md')).toEqual({ host: 'work station', path: 'a b/c.md' })
    expect(parseNotesLocation('/notesx')).toBeNull()
    expect(parseNotesLocation('/s/ws/id')).toBeNull()
  })
})

describe('resolveNoteLink', () => {
  const idx = indexNotes(FILES)
  it('relative markdown links, with or without extension, #anchors dropped', () => {
    expect(resolveNoteLink(idx, 'recipes/soup.md', 'pasta.md')?.path).toBe('recipes/pasta.md')
    expect(resolveNoteLink(idx, 'recipes/soup.md', './pasta#serving')?.path).toBe('recipes/pasta.md')
    expect(resolveNoteLink(idx, 'recipes/soup.md', '../index.md')?.path).toBe('index.md')
    expect(resolveNoteLink(idx, 'recipes/soup.md', '/b.md')?.path).toBe('b.md')
    expect(resolveNoteLink(idx, 'recipes/soup.md', 'img/plate.png')?.path).toBe('recipes/img/plate.png')
    expect(resolveNoteLink(idx, 'recipes/soup.md', '../../etc/passwd')).toBeNull()
    expect(resolveNoteLink(idx, 'recipes/soup.md', 'missing.md')).toBeNull()
    expect(resolveNoteLink(idx, 'index.md', 'b%2Emd')?.path).toBe('b.md')
  })
  it('wiki links: root path, relative, then by name (nearest wins)', () => {
    expect(resolveNoteLink(idx, 'index.md', 'recipes/soup', true)?.path).toBe('recipes/soup.md')
    expect(resolveNoteLink(idx, 'recipes/pasta.md', 'soup', true)?.path).toBe('recipes/soup.md')
    expect(resolveNoteLink(idx, 'garden/x.md', 'soup', true)?.path).toBe('garden/soup.md')
    expect(resolveNoteLink(idx, 'index.md', 'X#top', true)?.path).toBe('a/deep/x.md')
    expect(resolveNoteLink(idx, 'index.md', 'nope', true)).toBeNull()
  })
})

describe('highlighting', () => {
  it('splitRanges ignores bad / overlapping ranges', () => {
    expect(splitRanges('hello world', [[6, 11], [0, 5]])).toEqual([
      { v: 'hello', hit: true },
      { v: ' ', hit: false },
      { v: 'world', hit: true },
    ])
    expect(splitRanges('abc', [[1, 9], [2, 1]])).toEqual([{ v: 'abc', hit: false }])
  })
  it('highlightTerms / termRanges', () => {
    expect(highlightTerms('Soup "two words" #tag a')).toEqual(['soup', 'two words', 'tag'])
    expect(termRanges('Soup and soups', ['soup'])).toEqual([[0, 4], [9, 13]])
    expect(termRanges('x', [])).toEqual([])
  })
  it('recentNotes: markdown only, newest first', () => {
    expect(recentNotes(FILES, 3).map((x) => x.path)).toEqual(['recipes/soup.md', 'a/deep/x.md', 'index.md'])
  })
})

describe('markdown notes mode', () => {
  it('wiki links, h4–h6, comment lines; chat mode unchanged', () => {
    const blocks = parseMarkdown('<!-- note -->\n#### Deep\nSee [[recipes/soup|Soup]] and [[pasta#x]].', { notes: true })
    expect(blocks[0]).toEqual({ t: 'h', level: 3, content: [{ t: 'text', v: 'Deep' }] })
    expect(blocks[1]).toEqual({
      t: 'p',
      lines: [[
        { t: 'text', v: 'See ' },
        { t: 'wiki', target: 'recipes/soup', label: 'Soup', raw: '[[recipes/soup|Soup]]' },
        { t: 'text', v: ' and ' },
        { t: 'wiki', target: 'pasta#x', label: 'pasta', raw: '[[pasta#x]]' },
        { t: 'text', v: '.' },
      ]],
    })
    const chat = parseMarkdown('#### Deep\n[[x]]')
    expect(chat).toEqual([{ t: 'p', lines: [[{ t: 'text', v: '#### Deep' }], [{ t: 'text', v: '[[x]]' }]] }])
  })
})
