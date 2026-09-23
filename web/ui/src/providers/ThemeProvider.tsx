import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'

import { THEME_KEY, ThemeContext, resolveTheme, type ThemeChoice } from '@/hooks/useTheme'
import { storage } from '@/lib/storage'

const LIGHT_QUERY = '(prefers-color-scheme: light)'
// Must match --background in index.css (the PWA status bar / overscroll colour).
const THEME_COLORS = { dark: '#0b0c0e', light: '#ffffff' } as const

function subscribe(cb: () => void) {
  const mq = window.matchMedia(LIGHT_QUERY)
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}
const prefersLight = () => window.matchMedia(LIGHT_QUERY).matches

function readChoice(): ThemeChoice {
  const v = storage.get(THEME_KEY)
  return v === 'dark' || v === 'light' ? v : 'system'
}

/**
 * Toggles the `dark` class on <html> (shadcn's convention). index.html sets it before
 * first paint with the same rule, so there is no light flash.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeChoice>(readChoice)
  const light = useSyncExternalStore(subscribe, prefersLight, () => false)
  const resolved = resolveTheme(theme, light)

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', resolved === 'dark')
    root.style.colorScheme = resolved
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[resolved])
  }, [resolved])

  const value = useMemo(
    () => ({
      theme,
      resolved,
      setTheme: (t: ThemeChoice) => {
        setThemeState(t)
        if (t === 'system') storage.remove(THEME_KEY)
        else storage.set(THEME_KEY, t)
      },
    }),
    [theme, resolved],
  )
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
