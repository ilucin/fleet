import type { ModelOption } from '@/api/types'

/** What the New session form offers before /api/settings answers (or from an older server). Mirrors lib/config.mjs. */
export const DEFAULT_MODELS: ModelOption[] = [
  { id: '', label: 'Default' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]

/** `/api/settings` → `models`: keep well-formed entries; absent / empty / broken → the defaults. */
export function normalizeModels(raw: unknown): ModelOption[] {
  if (!Array.isArray(raw)) return DEFAULT_MODELS
  const seen = new Set<string>()
  const out: ModelOption[] = []
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue
    const { id, label } = m as Partial<ModelOption>
    if (typeof id !== 'string' || seen.has(id)) continue
    seen.add(id)
    out.push({ id, label: typeof label === 'string' && label ? label : id || 'Default' })
  }
  return out.length ? out : DEFAULT_MODELS
}

/** The remembered choice when it is still offered, else the first option ('' when there are none). */
export function pickModel(models: ModelOption[], remembered: string | null): string {
  if (remembered != null && models.some((m) => m.id === remembered)) return remembered
  return models[0]?.id ?? ''
}
