// Desktop keyboard shortcuts — pure key → action mapping (unit-tested in shortcuts.test.ts).
// The desktop shell owns the single window keydown listener and dispatches these actions.

export type ShortcutAction =
  | 'next'
  | 'prev'
  | 'first'
  | 'last'
  | 'open'
  | 'openAndReply'
  | 'reply'
  | 'search'
  | 'new'
  | 'back'
  | 'blur'
  | 'chat'
  | 'term'
  | 'sidebar'
  | 'inspector'
  | 'palette'
  | 'help'
  | 'refresh'
  | 'view'
  | 'rename'

export interface KeyLike {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  isComposing?: boolean
}

export interface ShortcutContext {
  /** Focus is in a text field (input / textarea / select / contenteditable). */
  typing: boolean
  /** Arrow keys are free to move the list cursor (focus is not in a scrollable pane). */
  arrowsFree: boolean
  /** The first key of a chord (`g`) pressed just before, or null. */
  pending: string | null
}

export interface ShortcutResult {
  action: ShortcutAction | null
  /** Chord state to carry to the next keydown. */
  pending: string | null
}

const NONE: ShortcutResult = { action: null, pending: null }

/** Second key of a `g …` chord. */
const G_CHORDS: Record<string, ShortcutAction> = {
  c: 'chat',
  t: 'term',
  g: 'first',
  r: 'refresh',
}

const PLAIN: Record<string, ShortcutAction> = {
  j: 'next',
  k: 'prev',
  G: 'last',
  Enter: 'openAndReply',
  o: 'open',
  r: 'reply',
  '/': 'search',
  c: 'new',
  n: 'new',
  Escape: 'back',
  '[': 'sidebar',
  i: 'inspector',
  b: 'view',
  e: 'rename',
  F2: 'rename',
  '?': 'help',
}

/**
 * Map a keydown to an action. Never steals keys while typing, except ⌘K / Ctrl+K
 * (palette) and Esc (blur the field). Other modifier combos are left to the browser,
 * except ⌘B / Ctrl+B (sidebar).
 */
export function matchShortcut(e: KeyLike, ctx: ShortcutContext): ShortcutResult {
  if (e.isComposing) return NONE
  const mod = !!(e.metaKey || e.ctrlKey)
  const key = e.key

  if (mod && !e.altKey && !e.shiftKey && key.toLowerCase() === 'k') return { action: 'palette', pending: null }
  if (ctx.typing) return key === 'Escape' && !mod && !e.altKey ? { action: 'blur', pending: null } : NONE
  if (mod && !e.altKey && !e.shiftKey && key.toLowerCase() === 'b') return { action: 'sidebar', pending: null }
  if (mod || e.altKey) return NONE

  if (ctx.pending === 'g') return { action: G_CHORDS[key] ?? null, pending: null }
  if (key === 'g') return { action: null, pending: 'g' }

  if (key === 'ArrowDown' || key === 'ArrowUp') {
    if (!ctx.arrowsFree) return NONE
    return { action: key === 'ArrowDown' ? 'next' : 'prev', pending: null }
  }
  return { action: PLAIN[key] ?? null, pending: null }
}

/** Is this element a text-entry control (where single-key shortcuts must not fire)? */
export function isTypingTarget(el: { tagName?: string; isContentEditable?: boolean; type?: string } | null | undefined): boolean {
  if (!el || typeof el.tagName !== 'string') return false
  if (el.isContentEditable) return true
  const tag = el.tagName.toUpperCase()
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag !== 'INPUT') return false
  const type = (el.type || 'text').toLowerCase()
  return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file', 'image'].includes(type)
}

/**
 * Move a list cursor by `delta` over `keys`, clamped at both ends. A cursor that is not
 * in the list starts at the first (moving down) or last (moving up) entry.
 */
export function stepCursor(keys: readonly string[], current: string | null, delta: number): string | null {
  if (keys.length === 0) return null
  const i = current == null ? -1 : keys.indexOf(current)
  if (i < 0) return delta >= 0 ? keys[0] : keys[keys.length - 1]
  return keys[Math.max(0, Math.min(keys.length - 1, i + delta))]
}

/** `laptop/abc…` — the cursor / selection identity of a session. */
export const sessionKey = (s: { host: string; session_id: string }) => `${s.host}/${s.session_id}`

export function isMacPlatform(nav: { platform?: string; userAgent?: string } | undefined = globalThis.navigator): boolean {
  const p = `${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`
  return /Mac|iPhone|iPad|iPod/.test(p)
}

export interface ShortcutHelp {
  keys: string[][]
  label: string
}

/** What the `?` dialog shows. `mod` is rendered as ⌘ on macOS, Ctrl elsewhere. */
export const SHORTCUT_HELP: { title: string; items: ShortcutHelp[] }[] = [
  {
    title: 'Sessions',
    items: [
      { keys: [['j'], ['↓']], label: 'Next session' },
      { keys: [['k'], ['↑']], label: 'Previous session' },
      { keys: [['g', 'g'], ['G']], label: 'First / last session' },
      { keys: [['Enter']], label: 'Open and focus the composer' },
      { keys: [['o']], label: 'Open' },
      { keys: [['/']], label: 'Search (↑ ↓ Enter work in the field)' },
      { keys: [['c'], ['n']], label: 'New session' },
      { keys: [['mod', 'K']], label: 'Command palette: jump to a session, run an action' },
    ],
  },
  {
    title: 'Session',
    items: [
      { keys: [['r']], label: 'Reply (focus the composer)' },
      { keys: [['e'], ['F2']], label: 'Rename (the open session, else the cursor row)' },
      { keys: [['g', 'c']], label: 'Chat view' },
      { keys: [['g', 't']], label: 'Terminal view' },
      { keys: [['Enter']], label: 'Send (in the composer; also mod+Enter)' },
      { keys: [['Shift', 'Enter']], label: 'New line' },
      { keys: [['Esc']], label: 'Leave the field / close the session pane' },
    ],
  },
  {
    title: 'Layout',
    items: [
      { keys: [['['], ['mod', 'B']], label: 'Toggle the sidebar' },
      { keys: [['b']], label: 'Switch List / Board (sessions grouped by work)' },
      { keys: [['i']], label: 'Toggle the details panel' },
      { keys: [['g', 'r']], label: 'Refresh now' },
      { keys: [['?']], label: 'This help' },
    ],
  },
]
