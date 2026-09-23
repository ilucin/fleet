import { createContext, useContext } from 'react'

export type ThemeChoice = 'system' | 'dark' | 'light'
export type ResolvedTheme = 'dark' | 'light'

export const THEME_KEY = 'fleet.theme'

export interface ThemeState {
  theme: ThemeChoice
  resolved: ResolvedTheme
  setTheme: (t: ThemeChoice) => void
}

/** Dark first: `system` is light only when the OS explicitly prefers light. */
export function resolveTheme(choice: ThemeChoice, prefersLight: boolean): ResolvedTheme {
  if (choice === 'dark' || choice === 'light') return choice
  return prefersLight ? 'light' : 'dark'
}

export const ThemeContext = createContext<ThemeState>({ theme: 'system', resolved: 'dark', setTheme: () => {} })

export function useTheme(): ThemeState {
  return useContext(ThemeContext)
}
