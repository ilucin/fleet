import { useCallback, useSyncExternalStore } from 'react'

/** Live `matchMedia(query).matches` (false where matchMedia is missing). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia?.(query)
      mql?.addEventListener('change', onChange)
      return () => mql?.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(subscribe, () => window.matchMedia?.(query).matches ?? false, () => false)
}

/** Tailwind's `lg` (1024px): the desktop master–detail layout; below it, the mobile screens. */
export const DESKTOP_QUERY = '(min-width: 1024px)'
/**
 * Wide enough to show the details panel by default (sidebar 360 + panel 320 still leaves a
 * ~760px chat column). Narrower desktops start with it closed; `i` toggles it anywhere.
 */
export const WIDE_QUERY = '(min-width: 1440px)'

export const useIsDesktop = () => useMediaQuery(DESKTOP_QUERY)
