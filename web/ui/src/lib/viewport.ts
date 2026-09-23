/**
 * iOS Safari: 100dvh does not shrink for the software keyboard, visualViewport does.
 * Keep `--app-h` (used by the `h-app` / `min-h-app` utilities) in sync so a bottom
 * composer stays above the keyboard, and `--app-top` (the visual viewport's offset
 * into the layout viewport — iOS scrolls the page when an input focuses) so a fixed
 * full-screen layout (`fixed-app`) follows the visible area. Call once at startup.
 */
export function installViewportHeight(): void {
  const sync = () => {
    const vv = window.visualViewport
    const height = vv ? vv.height : window.innerHeight
    const top = vv ? Math.max(0, vv.offsetTop) : 0
    const root = document.documentElement.style
    root.setProperty('--app-h', `${Math.round(height)}px`)
    root.setProperty('--app-top', `${Math.round(top)}px`)
  }
  window.visualViewport?.addEventListener('resize', sync)
  window.visualViewport?.addEventListener('scroll', sync)
  window.addEventListener('resize', sync)
  window.addEventListener('orientationchange', sync)
  sync()
}
