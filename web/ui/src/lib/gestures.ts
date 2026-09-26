/** Vertical travel (px) that counts as a swipe on the mobile chip drawer. */
const SWIPE_PX = 24

/** Swipe direction from a vertical touch delta: up opens, down closes, small = tap. */
export function swipeIntent(dy: number): 'open' | 'close' | 'tap' | null {
  if (dy <= -SWIPE_PX) return 'open'
  if (dy >= SWIPE_PX) return 'close'
  if (Math.abs(dy) < 8) return 'tap'
  return null
}
