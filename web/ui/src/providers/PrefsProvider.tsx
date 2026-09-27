import { useEffect, useMemo, type ReactNode } from 'react'

import { PrefsContext } from '@/hooks/usePrefs'
import { usePersistentState } from '@/hooks/usePersistentState'
import {
  DEFAULT_TERM_FONT,
  DEFAULT_TEXT_SIZE,
  HIDE_NOTES_KEY,
  TERM_FONT_KEY,
  TEXT_SIZE_KEY,
  parseTermFont,
  parseTextSize,
  rootFontSize,
} from '@/lib/prefs'

const parseBool01 = (raw: string) => (raw === '1' || raw === '0' ? raw : undefined)

/**
 * Text size, terminal text size and progress notes for the whole app. The text size sets the
 * root font-size on <html> (index.html applies the same rule before first paint), so every rem
 * scales with it.
 */
export function PrefsProvider({ children }: { children: ReactNode }) {
  const [textSize, setTextSize] = usePersistentState<number>(TEXT_SIZE_KEY, DEFAULT_TEXT_SIZE, parseTextSize)
  const [termFont, setTermFont] = usePersistentState<number>(TERM_FONT_KEY, DEFAULT_TERM_FONT, parseTermFont)
  const [hideNotesRaw, setHideNotesRaw] = usePersistentState<string>(HIDE_NOTES_KEY, '0', parseBool01)

  useEffect(() => {
    const root = document.documentElement
    root.style.fontSize = rootFontSize(textSize)
    root.dataset.textSize = String(textSize)
  }, [textSize])

  const value = useMemo(
    () => ({
      textSize,
      setTextSize,
      termFont,
      setTermFont,
      hideNotes: hideNotesRaw === '1',
      setHideNotes: (v: boolean) => setHideNotesRaw(v ? '1' : '0'),
    }),
    [textSize, setTextSize, termFont, setTermFont, hideNotesRaw, setHideNotesRaw],
  )
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>
}
