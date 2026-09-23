import { createContext, useContext } from 'react'

import type { QuickReply, SessionKey } from '@/api/types'

export interface SettingsState {
  /** This host's name (null until /api/settings answered). */
  self: string | null
  /** Every configured host name (self + peers). */
  hosts: string[]
  /** Composer text chips (config `web.quickReplies`). */
  quickReplies: QuickReply[]
  loaded: boolean
}

export const DEFAULT_QUICK_REPLIES: QuickReply[] = [
  { label: 'Continue', text: 'Continue.' },
  { label: 'Yes', text: 'Yes' },
  { label: 'No', text: 'No' },
  { label: '1', text: '1' },
  { label: '2', text: '2' },
]

/** Key chips are built in (not configurable), as in the classic UI. */
export const QUICK_KEYS: { label: string; key: SessionKey }[] = [
  { label: 'Esc', key: 'Escape' },
  { label: '↵', key: 'Enter' },
  { label: '↑', key: 'Up' },
  { label: '↓', key: 'Down' },
]

export const DEFAULT_SETTINGS: SettingsState = { self: null, hosts: [], quickReplies: DEFAULT_QUICK_REPLIES, loaded: false }

export const SettingsContext = createContext<SettingsState>(DEFAULT_SETTINGS)

export function useSettings(): SettingsState {
  return useContext(SettingsContext)
}
