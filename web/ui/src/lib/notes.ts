// Notes explorer helpers (pure): the folder tree, `#/notes/…` routes, note-to-note links
// (relative markdown links and `[[wiki]]` links) and search-match highlighting.
import type { NoteEntry } from '@/api/types'
import { basename, dirname, normalizePath } from '@/lib/paths'

export interface TreeDir {
  name: string
  /** Root-relative; '' for the root. */
  path: string
  dirs: TreeDir[]
  files: NoteEntry[]
  /** Files anywhere below. */
  count: number
}

/** Flat root-relative entries → nested dirs (dirs first, then files, both by name). */
export function buildTree(files: NoteEntry[]): TreeDir {
  const root: TreeDir = { name: '', path: '', dirs: [], files: [], count: 0 }
  const byPath = new Map<string, TreeDir>([['', root]])
  const dirFor = (p: string): TreeDir => {
    const hit = byPath.get(p)
    if (hit) return hit
    const parent = dirFor(p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
    const d: TreeDir = { name: basename(p), path: p, dirs: [], files: [], count: 0 }
    parent.dirs.push(d)
    byPath.set(p, d)
    return d
  }
  for (const f of files) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
    dirFor(dir).files.push(f)
  }
  const finish = (d: TreeDir): number => {
    d.dirs.sort((a, b) => a.name.localeCompare(b.name))
    d.files.sort((a, b) => basename(a.path).localeCompare(basename(b.path)))
    d.count = d.files.length + d.dirs.reduce((n, c) => n + finish(c), 0)
    return d.count
  }
  finish(root)
  return root
}

/** The dirs that contain `path` ('' excluded): what to expand so the file is visible. */
export function ancestorDirs(path: string): string[] {
  const out: string[] = []
  let d = dirname(path)
  while (d && d !== '.' && d !== '/') {
    out.unshift(d)
    d = dirname(d)
  }
  return out
}

const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/')

/** `#/notes`, `#/notes/<host>`, `#/notes/<host>/<path…>` (segments encoded). */
export function notesHref(host?: string | null, path?: string | null): string {
  if (!host) return '/notes'
  return path ? `/notes/${encodeURIComponent(host)}/${encPath(path)}` : `/notes/${encodeURIComponent(host)}`
}

/** A hash location → the explorer's host + note path, or null when it is not a notes route. */
export function parseNotesLocation(location: string): { host: string | null; path: string | null } | null {
  const m = /^\/notes(?:\/([^/]*)(?:\/(.*))?)?\/?$/.exec(location)
  if (!m) return null
  let host: string | null = null
  try {
    host = m[1] ? decodeURIComponent(m[1]) : null
  } catch {
    return { host: null, path: null }
  }
  return { host, path: decodeNotePath(m[2]) }
}

/** wouter's `*` param (still encoded) → the note path, or null. */
export function decodeNotePath(raw: string | undefined | null): string | null {
  if (!raw) return null
  try {
    const p = raw.split('/').map(decodeURIComponent).join('/')
    return p.replace(/^\/+|\/+$/g, '') || null
  } catch {
    return null
  }
}

const stripExt = (p: string) => p.replace(/\.(md|markdown|mdx|mdown|mkd)$/i, '')

/** Files by lowercase name (without extension) and by lowercase path (without extension). */
export interface NoteIndex {
  byPath: Map<string, NoteEntry>
  byStem: Map<string, NoteEntry[]>
  byNoExt: Map<string, NoteEntry>
}

export function indexNotes(files: NoteEntry[]): NoteIndex {
  const byPath = new Map<string, NoteEntry>()
  const byStem = new Map<string, NoteEntry[]>()
  const byNoExt = new Map<string, NoteEntry>()
  for (const f of files) {
    byPath.set(f.path, f)
    const noExt = stripExt(f.path).toLowerCase()
    if (!byNoExt.has(noExt)) byNoExt.set(noExt, f)
    const stem = basename(noExt)
    byStem.set(stem, [...(byStem.get(stem) ?? []), f])
  }
  return { byPath, byStem, byNoExt }
}

/**
 * A link target inside note `from` → the note it points at, or null. Markdown links are
 * relative to the note's folder (or root-absolute with a leading `/`); `[[wiki]]` targets are
 * matched as a root-relative path, then relative to the note, then by file name (nearest to
 * `from` wins when several share it). The extension is optional; `#heading` is ignored.
 */
export function resolveNoteLink(index: NoteIndex, from: string, href: string, wiki = false): NoteEntry | null {
  let h = String(href ?? '').trim().replace(/[?#].*$/, '')
  try {
    h = decodeURIComponent(h)
  } catch {
    // keep as written
  }
  if (!h || h.startsWith('~') || h.includes('\0')) return null
  const fromDir = dirname(from) === '.' ? '' : dirname(from)
  const candidates: string[] = []
  const rel = normalizePath(fromDir ? `${fromDir}/${h}` : h)
  const abs = normalizePath(h.replace(/^\/+/, ''))
  if (wiki) candidates.push(abs, rel)
  else if (h.startsWith('/')) candidates.push(abs)
  else candidates.push(rel)
  for (const c of candidates) {
    if (c.startsWith('..')) continue
    const exact = index.byPath.get(c)
    if (exact) return exact
    const noExt = index.byNoExt.get(stripExt(c).toLowerCase())
    if (noExt) return noExt
  }
  if (!wiki || h.includes('/')) return null
  const same = index.byStem.get(stripExt(h).toLowerCase())
  if (!same?.length) return null
  return [...same].sort((a, b) => sharedPrefix(b.path, from) - sharedPrefix(a.path, from) || a.path.length - b.path.length)[0]
}

function sharedPrefix(a: string, b: string): number {
  const x = a.split('/')
  const y = b.split('/')
  let n = 0
  while (n < x.length - 1 && n < y.length - 1 && x[n] === y[n]) n++
  return n
}

/** `text` split into plain / matched parts by server ranges. */
export function splitRanges(text: string, ranges: [number, number][]): { v: string; hit: boolean }[] {
  const out: { v: string; hit: boolean }[] = []
  let last = 0
  for (const [s, e] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (s < last || e <= s || e > text.length) continue
    if (s > last) out.push({ v: text.slice(last, s), hit: false })
    out.push({ v: text.slice(s, e), hit: true })
    last = e
  }
  if (last < text.length) out.push({ v: text.slice(last), hit: false })
  return out
}

/** Query → the words to highlight in a rendered note (quoted phrases kept, `#tags` without `#`). */
export function highlightTerms(q: string): string[] {
  const out: string[] = []
  for (const m of String(q ?? '').matchAll(/"([^"]+)"|(\S+)/g)) {
    const v = (m[1] ?? m[2]).replace(/^#/, '').trim().toLowerCase()
    if (v.length >= 2 && !out.includes(v)) out.push(v)
  }
  return out.slice(0, 8)
}

/** Case-insensitive term matches in `text` → ranges (for highlightTerms). */
export function termRanges(text: string, terms: string[]): [number, number][] {
  if (!terms.length) return []
  const lower = text.toLowerCase()
  if (lower.length !== text.length) return []
  const out: [number, number][] = []
  for (const t of terms) {
    for (let i = lower.indexOf(t); i !== -1 && out.length < 200; i = lower.indexOf(t, i + t.length)) out.push([i, i + t.length])
  }
  out.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const r of out) {
    const lastR = merged[merged.length - 1]
    if (lastR && r[0] <= lastR[1]) lastR[1] = Math.max(lastR[1], r[1])
    else merged.push([r[0], r[1]])
  }
  return merged
}

/** A frontmatter value for display: lists joined, long strings kept whole (the UI wraps). */
export function metaText(v: string | string[]): string {
  return Array.isArray(v) ? v.join(', ') : v
}

/** A few recently changed notes (markdown), newest first — the explorer's landing list. */
export function recentNotes(files: NoteEntry[], n = 12): NoteEntry[] {
  return files.filter((f) => f.kind === 'markdown').sort((a, b) => b.mtime - a.mtime).slice(0, n)
}
