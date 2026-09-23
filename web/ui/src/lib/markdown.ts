// Safe Markdown → AST for the subset Claude Code actually emits — a port of the classic
// UI's public/markdown.js. It never produces HTML: components/Markdown.tsx renders the
// tree as React elements (text is escaped by React), and only http(s) URLs ever become
// links. Unknown constructs fall back to plain text. Pure, unit-tested in markdown.test.ts.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'link'; href: string; children: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'strong'; children: Inline[] }
  | { t: 'em'; children: Inline[] }

export interface ListItem {
  content: Inline[]
  sub?: { ordered: boolean; items: Inline[][] }
}

export type Block =
  | { t: 'p'; lines: Inline[][] }
  | { t: 'h'; level: 1 | 2 | 3; content: Inline[] }
  | { t: 'hr' }
  | { t: 'quote'; lines: Inline[][] }
  | { t: 'list'; ordered: boolean; items: ListItem[] }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { t: 'code'; lang: string; text: string }

const URL_RE = /https?:\/\/[^\s<>"'`…]+/g
const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/
// One alternation, no nested quantifiers: code | **b** | __b__ | [t](u) | *i* | _i_
const INLINE_RE = /`([^`\n]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\[([^\]\n]*)\]\(([^)\s]*)\)|\*([^*\n]+)\*|_([^_\n]+)_/g
const ITEM_RE = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/
const HEAD_RE = /^(#{1,3})\s+(.*)$/
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const FENCE_RE = /^\s*```(.*)$/
const QUOTE_RE = /^\s*>/

/** Only http(s) links are ever turned into anchors; anything else stays text. */
export function safeHref(raw: unknown): string | null {
  const u = String(raw ?? '').trim()
  return /^https?:\/\/\S/i.test(u) ? u : null
}

/** Plain text split into text + bare http(s) URL segments (terminal view and markdown text). */
export function linkify(str: string): Inline[] {
  const s = String(str ?? '')
  const out: Inline[] = []
  let last = 0
  for (const m of s.matchAll(URL_RE)) {
    let url = m[0].replace(TRAILING_PUNCT, '')
    // keep one closing ")" when the URL itself opened a "(" (wikipedia-style)
    if (m[0][url.length] === ')' && url.split('(').length > url.split(')').length) url += ')'
    if (!url) continue
    const index = m.index ?? 0
    if (index > last) out.push({ t: 'text', v: s.slice(last, index) })
    out.push({ t: 'link', href: url, children: [{ t: 'text', v: url }] })
    last = index + url.length
  }
  if (last < s.length) out.push({ t: 'text', v: s.slice(last) })
  return out
}

export function parseInline(str: string, depth = 0): Inline[] {
  const s = String(str ?? '')
  if (depth > 3) return linkify(s)
  const out: Inline[] = []
  let last = 0
  for (const m of s.matchAll(INLINE_RE)) {
    const index = m.index ?? 0
    if (index < last) continue
    // `_snake_case_` inside a word is not emphasis
    if (m[7] !== undefined && index > 0 && /\w/.test(s[index - 1])) continue
    let node: Inline
    if (m[1] !== undefined) node = { t: 'code', v: m[1] }
    else if (m[2] !== undefined || m[3] !== undefined) node = { t: 'strong', children: parseInline(m[2] ?? m[3], depth + 1) }
    else if (m[5] !== undefined) {
      const href = safeHref(m[5])
      if (!href) continue // e.g. javascript: — leave the whole construct as text
      node = { t: 'link', href, children: parseInline(m[4] || href, depth + 1) }
    } else node = { t: 'em', children: parseInline(m[6] ?? m[7], depth + 1) }
    if (index > last) out.push(...linkify(s.slice(last, index)))
    out.push(node)
    last = index + m[0].length
  }
  if (last < s.length) out.push(...linkify(s.slice(last)))
  return out
}

const isBlockStart = (line: string) =>
  FENCE_RE.test(line) || HEAD_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) || ITEM_RE.test(line)

function isTableSep(line: string | undefined): boolean {
  const s = String(line || '')
  return /^[\s|:-]+$/.test(s) && s.includes('-') && s.includes('|') && s.trim() !== ''
}

const isTableStart = (lines: string[], i: number) => lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

/** Parse markdown into blocks. */
export function parseMarkdown(src: string | null | undefined): Block[] {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i += 1
      continue
    }
    const fence = FENCE_RE.exec(line)
    if (fence) {
      const buf: string[] = []
      i += 1
      for (; i < lines.length; i += 1) {
        if (/^\s*```\s*$/.test(lines[i])) {
          i += 1
          break
        }
        buf.push(lines[i])
      }
      blocks.push({ t: 'code', lang: fence[1].trim(), text: buf.join('\n') })
      continue
    }
    const head = HEAD_RE.exec(line)
    if (head) {
      blocks.push({ t: 'h', level: head[1].length as 1 | 2 | 3, content: parseInline(head[2].trim()) })
      i += 1
      continue
    }
    if (HR_RE.test(line)) {
      blocks.push({ t: 'hr' })
      i += 1
      continue
    }
    if (QUOTE_RE.test(line)) {
      const q: Inline[][] = []
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        q.push(parseInline(lines[i].replace(/^\s*>\s?/, '')))
        i += 1
      }
      blocks.push({ t: 'quote', lines: q })
      continue
    }
    if (ITEM_RE.test(line)) {
      const raw: { indent: number; ordered: boolean; text: string }[] = []
      let m: RegExpExecArray | null
      while (i < lines.length && (m = ITEM_RE.exec(lines[i]))) {
        raw.push({ indent: m[1].length, ordered: m[2] === undefined, text: m[4] })
        i += 1
      }
      const items: ListItem[] = []
      for (const it of raw) {
        const lastItem = items[items.length - 1]
        if (it.indent >= 2 && lastItem) {
          lastItem.sub ??= { ordered: it.ordered, items: [] }
          lastItem.sub.items.push(parseInline(it.text))
        } else items.push({ content: parseInline(it.text) })
      }
      blocks.push({ t: 'list', ordered: raw[0].ordered, items })
      continue
    }
    if (isTableStart(lines, i)) {
      const head = splitRow(lines[i]).map((c) => parseInline(c))
      const rows: Inline[][][] = []
      i += 2
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(splitRow(lines[i]).map((c) => parseInline(c)))
        i += 1
      }
      blocks.push({ t: 'table', head, rows })
      continue
    }
    const buf: string[] = []
    while (i < lines.length) {
      const l = lines[i]
      if (!l.trim()) {
        i += 1
        break
      }
      if (buf.length && (isBlockStart(l) || isTableStart(lines, i))) break
      buf.push(l)
      i += 1
    }
    blocks.push({ t: 'p', lines: buf.map((l) => parseInline(l.trim())) })
  }
  return blocks
}
