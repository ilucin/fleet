// Auto-name run summaries — pure, unit-tested in autoname.test.ts.
import type { AutoNameRun } from '@/api/types'

/** One-line result of a naming pass, for a toast. */
export function autoNameToast(run: AutoNameRun): string {
  if (run.ok === false || run.error) return `Naming failed: ${run.error || run.reason || 'unknown error'}`
  const renamed = run.renamed ?? []
  const held = run.held?.length ?? 0
  if (renamed.length) return `Renamed ${renamed.length}: ${renamed.map((r) => r.to).join(', ')}`
  return `Nothing to rename${held ? ` (${held} waiting on you)` : ''}`
}

/** Short "what happened" for the ⋯ menu: "renamed 2 · 1 held", "failed", "no changes". */
export function autoNameSummary(run: AutoNameRun): string {
  if (run.ok === false || run.error) return 'failed'
  const parts: string[] = []
  if (run.renamed?.length) parts.push(`renamed ${run.renamed.length}`)
  if (run.held?.length) parts.push(`${run.held.length} held`)
  if (run.errors?.length) parts.push(`${run.errors.length} error${run.errors.length > 1 ? 's' : ''}`)
  return parts.length ? parts.join(' · ') : 'no changes'
}
