/**
 * iOS Safari: 100dvh does not shrink for the software keyboard, visualViewport does.
 * Keep `--app-h` (used by the `h-app` / `min-h-app` utilities) in sync so a bottom
 * composer stays above the keyboard. Call once at startup.
 */
export function installViewportHeight(): void {
  const sync = () => {
    const vv = window.visualViewport
    const height = vv ? vv.height : window.innerHeight
    document.documentElement.style.setProperty('--app-h', `${Math.round(height)}px`)
  }
  window.visualViewport?.addEventListener('resize', sync)
  window.visualViewport?.addEventListener('scroll', sync)
  window.addEventListener('resize', sync)
  window.addEventListener('orientationchange', sync)
  sync()
}
