/**
 * iOS Safari: 100dvh does not shrink for the software keyboard, visualViewport does.
 * Keep `--app-h` (used by the `h-app` / `min-h-app` utilities) in sync so a bottom
 * composer stays above the keyboard, and `--app-top` (the visual viewport's offset
 * into the layout viewport — iOS scrolls the page when an input focuses) so a fixed
 * full-screen layout (`fixed-app`) follows the visible area. Call once at startup.
 *
 * Home-screen web app (standalone, `black-translucent` + `viewport-fit=cover`): iOS reports
 * innerHeight / visualViewport short by the status bar although the page fills the whole
 * screen, which left an empty band under the composer. With no keyboard up, use the screen.
 */
export function installViewportHeight(): void {
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true || window.matchMedia?.('(display-mode: standalone)').matches
  const sync = () => {
    const vv = window.visualViewport
    let height = vv ? vv.height : window.innerHeight
    if (standalone && window.innerHeight - height < 100) {
      const portrait = window.innerHeight >= window.innerWidth
      const full = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height)
      height = Math.max(height, full)
    }
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
