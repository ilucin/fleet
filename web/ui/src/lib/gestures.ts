/** Vertical travel (px) that counts as a swipe on the mobile chip drawer. */
const SWIPE_PX = 24

/** Swipe direction from a vertical touch delta: up opens, down closes, small = tap. */
export function swipeIntent(dy: number): 'open' | 'close' | 'tap' | null {
  if (dy <= -SWIPE_PX) return 'open'
  if (dy >= SWIPE_PX) return 'close'
  if (Math.abs(dy) < 8) return 'tap'
  return null
}

/**
 * The mobile list's filter drawer hangs under the search field: a vertical swipe DOWN opens it,
 * up closes it. Mostly-horizontal moves (scrolling a chip row) are ignored.
 */
export function pullIntent(dx: number, dy: number): 'open' | 'close' | 'tap' | null {
  if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) >= 8) return null
  return swipeIntent(-dy)
}

/** Swipe right → back (mobile session screen). */
export const BACK_MIN_PX = 70
/** Moves under this (px) do not decide the axis yet. */
const AXIS_SLOP_PX = 10

/**
 * Decides once the finger has moved a little: `back` = rightwards and clearly horizontal (the
 * screen starts following the finger), `other` = anything else (the gesture is left alone).
 */
export function swipeAxis(dx: number, dy: number): 'back' | 'other' | null {
  if (Math.abs(dx) < AXIS_SLOP_PX && Math.abs(dy) < AXIS_SLOP_PX) return null
  return dx > 0 && dx > Math.abs(dy) * 1.5 ? 'back' : 'other'
}

/** On release: far enough right, mostly horizontal, and either long (≥ 120px) or quick (≥ 0.3px/ms). */
export function swipeBackIntent(dx: number, dy: number, ms: number): boolean {
  if (dx < BACK_MIN_PX || Math.abs(dy) > dx * 0.5) return false
  return dx >= 120 || dx / Math.max(ms, 1) >= 0.3
}

/** The bits of an Element that swipeBackBlocked() reads (so tests can use plain objects). */
export interface SwipeNode {
  tagName: string
  isContentEditable?: boolean
  scrollLeft: number
  scrollWidth: number
  clientWidth: number
  parentElement: SwipeNode | null
  getAttribute(name: string): string | null
}

/**
 * Whether a swipe-back starting on `target` must be left alone: fields (typing, selecting),
 * dialogs / sheets, and anything between `target` and `root` that can still scroll left —
 * a swipe right there scrolls it (wide terminal lines, chip rows, code blocks).
 */
export function swipeBackBlocked(target: SwipeNode | null, root: SwipeNode | null, overflowX: (el: SwipeNode) => string): boolean {
  for (let el = target; el; el = el.parentElement) {
    const tag = el.tagName.toUpperCase()
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true
    const role = el.getAttribute('role')
    if (role === 'dialog' || role === 'alertdialog') return true
    if (el.scrollLeft > 0 && el.scrollWidth > el.clientWidth && /auto|scroll/.test(overflowX(el))) return true
    if (el === root) return false
  }
  return false
}
