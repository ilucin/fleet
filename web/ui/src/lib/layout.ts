// Desktop layout constants + pure helpers (unit-tested in layout.test.ts).

export const SIDEBAR_MIN_W = 280
export const SIDEBAR_MAX_W = 560
export const SIDEBAR_DEFAULT_W = 360

/** A sidebar width within bounds; anything non-numeric is the default. */
export function clampSidebarWidth(w: number): number {
  if (!Number.isFinite(w)) return SIDEBAR_DEFAULT_W
  return Math.round(Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, w)))
}
