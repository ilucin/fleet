// The Stack sheet and the Spawn sibling form are app-wide overlays (mounted once by
// components/stack/StackUi.tsx): anything — a list row's chip, a board column, the session
// screen — opens them through this tiny module store (useSyncExternalStore), like useTitles.
import { useSyncExternalStore } from 'react'

/** Who a sibling is spawned from: a session (its stack, created on demand) or a stack. */
export interface SiblingTarget {
  host: string
  /** A session: POST …/sessions/:id/stack/spawn (creates the stack when it has none). */
  sessionId?: string
  /** A stack: POST …/stacks/:id/spawn (used when there is no source session). */
  stackId?: string
  /** Where the sibling starts (the source session's / stack's cwd), shown read-only. */
  cwd: string | null
  /** The stack's label, or the source session's title when it creates the stack. */
  label: string | null
  /** No stack yet: this spawn creates one (one model call). */
  creates: boolean
}

interface State {
  sheet: { host: string; id: string } | null
  sibling: SiblingTarget | null
}

let state: State = { sheet: null, sibling: null }
const listeners = new Set<() => void>()
let pendingSibling: ReturnType<typeof setTimeout> | undefined

function update(next: Partial<State>) {
  state = { ...state, ...next }
  for (const l of listeners) l()
}
function subscribe(l: () => void) {
  listeners.add(l)
  return () => void listeners.delete(l)
}

export function openStackSheet(host: string, id: string) {
  clearTimeout(pendingSibling)
  update({ sheet: { host, id }, sibling: null })
}

export function closeStackSheet() {
  if (state.sheet) update({ sheet: null })
}

/** Open the sibling form; an open Stack sheet closes first (one overlay at a time). */
export function openSiblingSpawn(target: SiblingTarget) {
  clearTimeout(pendingSibling)
  if (!state.sheet) return update({ sibling: target })
  update({ sheet: null })
  pendingSibling = setTimeout(() => update({ sibling: target }), 250)
}

export function closeSiblingSpawn() {
  if (state.sibling) update({ sibling: null })
}

export function useStackUi(): State {
  return useSyncExternalStore(subscribe, () => state)
}
