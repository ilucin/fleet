/** Narrowest the chat gets, and the room it always leaves the diff. */
export const CHAT_MIN_W = 320
export const DIFF_MIN_W = 480

/** The default width before you drag (28rem; 32rem on wide screens). */
export const defaultChatWidth = (viewport: number) => (viewport >= 1280 ? 512 : 448)

/** A dragged width kept between CHAT_MIN_W and what leaves the diff DIFF_MIN_W of `room`. */
export function clampChatWidth(w: number, room: number): number {
  const max = Math.max(CHAT_MIN_W, room - DIFF_MIN_W)
  return Math.round(Math.min(max, Math.max(CHAT_MIN_W, w)))
}
