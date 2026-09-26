// Command palette matching — pure (unit-tested in palette.test.ts).

/**
 * cmdk `filter`: every whitespace-separated term must be a substring of the item's value
 * or keywords (case-insensitive) — predictable, unlike subsequence fuzzy matching, which
 * matches almost everything once session ids are in the value. Returns 0 (hidden) or a
 * rank in (0, 1]: a keyword that starts with the query ranks first, then word starts.
 */
export function paletteFilter(value: string, search: string, keywords: string[] = []): number {
  const q = search.trim().toLowerCase()
  if (!q) return 1
  const fields = [...keywords, value].map((f) => f.toLowerCase())
  const hay = fields.join('\n')
  const terms = q.split(/\s+/)
  if (!terms.every((t) => hay.includes(t))) return 0
  if (fields.some((f) => f.startsWith(q))) return 1
  if (fields.some((f) => f.split(/[\s\-_/.:]+/).some((w) => w.startsWith(terms[0])))) return 0.8
  return 0.5
}
