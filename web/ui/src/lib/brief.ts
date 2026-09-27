// Session briefs — pure helpers for the brief panel (unit-tested in brief.test.ts).
// The file format is the server's contract (docs/architecture.md → "Session briefs"); these
// only touch the body the way a human editor would: toggle a checkbox, keep every other line.
import type { BriefResource, BriefResourceKind } from '@/api/types'

const FRONTMATTER_RE = /^---\n[\s\S]*?\n---[ \t]*(?:\n|$)/
const HEADING_RE = /^##\s+(.+?)\s*#*\s*$/
const CHECK_RE = /^(\s*[-*+]\s+\[)([ xX])(\]\s+.*)$/

/** The markdown without its `---` frontmatter (what the editor shows; the server keeps its own keys). */
export function briefBody(markdown: string | null | undefined): string {
  const src = String(markdown ?? '').replace(/\r\n/g, '\n')
  return src.replace(FRONTMATTER_RE, '').replace(/^\n+/, '')
}

/**
 * Set plan item `index` (0-based, the order of `parsed.plan`: checkbox lines of `## Plan`) to
 * `done`. → the new body (frontmatter dropped), or null when there is no such item.
 */
export function setPlanItem(markdown: string, index: number, done: boolean): string | null {
  const lines = briefBody(markdown).split('\n')
  let inPlan = false
  let n = 0
  for (let i = 0; i < lines.length; i++) {
    const h = HEADING_RE.exec(lines[i])
    if (h) {
      inPlan = h[1].trim().toLowerCase() === 'plan'
      continue
    }
    if (!inPlan) continue
    const m = CHECK_RE.exec(lines[i])
    if (!m) continue
    if (n === index) {
      lines[i] = `${m[1]}${done ? 'x' : ' '}${m[3]}`
      return lines.join('\n')
    }
    n += 1
  }
  return null
}

/** Display order of resource groups; hand-written lines (`kind: null`) come last as Notes. */
export const RESOURCE_ORDER: BriefResourceKind[] = ['PR', 'Issue', 'Artifact', 'Spec', 'File', 'Branch', 'Worktree', 'Link']

const GROUP_LABEL: Record<string, string> = {
  PR: 'Pull requests',
  Issue: 'Issues',
  Artifact: 'Artifacts',
  Spec: 'Specs',
  File: 'Files',
  Branch: 'Branch',
  Worktree: 'Worktree',
  Link: 'Links',
}

export interface ResourceGroup {
  /** A kind, or null for hand-written lines. Unknown kinds from a newer server group on their own. */
  kind: string | null
  label: string
  items: BriefResource[]
}

/** Group resources by kind in RESOURCE_ORDER (unknown kinds after, then notes); order inside a group is kept. */
export function groupResources(resources: readonly BriefResource[] | null | undefined): ResourceGroup[] {
  const by = new Map<string | null, BriefResource[]>()
  for (const r of resources ?? []) {
    const k = r.kind ?? null
    const list = by.get(k)
    if (list) list.push(r)
    else by.set(k, [r])
  }
  const rank = (k: string | null) => {
    if (k == null) return 1000
    const i = RESOURCE_ORDER.indexOf(k as BriefResourceKind)
    return i >= 0 ? i : 500
  }
  return [...by.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([kind, items]) => ({ kind, label: kind == null ? 'Notes' : (GROUP_LABEL[kind] ?? kind), items }))
}

/** "3/7" progress of a plan; null when it has no items. */
export function planProgress(plan: readonly { done: boolean }[] | null | undefined): { done: number; total: number } | null {
  if (!plan?.length) return null
  return { done: plan.filter((i) => i.done).length, total: plan.length }
}

/** The New session prompt for "Continue in new session": the brief's prompt, a blank line, the caret. */
export function continueDraft(prompt: string | null | undefined): string {
  const p = String(prompt ?? '').trimEnd()
  return p ? `${p}\n\n` : ''
}

/** Whole minutes (≥ 1) until the hourly cap frees up. */
export function retryMinutes(ms: number | null | undefined): number {
  const n = Number(ms)
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.ceil(n / 60_000)) : 1
}

/** ISO (frontmatter) or epoch ms → epoch ms; null when missing / unparsable. */
export function briefTime(v: string | number | null | undefined): number | null {
  if (v == null || v === '') return null
  const t = typeof v === 'number' ? v : Date.parse(v)
  return Number.isFinite(t) && t > 0 ? t : null
}
