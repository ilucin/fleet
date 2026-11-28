/** The room a side panel always leaves the diff beside it. */
export const DIFF_MIN_W = 480

/** The session chat: narrowest width, and its default (28rem; 32rem on wide screens). */
export const CHAT_MIN_W = 320
export const defaultChatWidth = (viewport: number) => (viewport >= 1280 ? 512 : 448)

/** The changed-files list: narrowest width, and its default (16rem). */
export const TREE_MIN_W = 160
export const defaultTreeWidth = () => 256

/** A dragged width kept between `min` and what leaves the diff DIFF_MIN_W of `room`. */
export function clampPanelWidth(w: number, room: number, min: number): number {
  const max = Math.max(min, room - DIFF_MIN_W)
  return Math.round(Math.min(max, Math.max(min, w)))
}
