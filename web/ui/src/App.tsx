import { Redirect, Route, Router, Switch } from 'wouter'
import { useHashLocation } from 'wouter/use-hash-location'

import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FleetProvider } from '@/providers/FleetProvider'
import { SettingsProvider } from '@/providers/SettingsProvider'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import { ThemeProvider } from '@/providers/ThemeProvider'
import { DesktopShell } from '@/screens/DesktopShell'
import { ListScreen } from '@/screens/ListScreen'
import { SessionScreen } from '@/screens/SessionScreen'

/**
 * Hash routing, same URLs as the classic UI: `#/` (list), `#/s/<host>/<session_id>` (detail).
 * No server-side SPA fallback needed; the PWA start_url is `/#/`. Desktop and mobile use the
 * same routes, so links work across both.
 */
export default function App() {
  // ≥ lg: master–detail shell; below it the mobile screens, untouched. Crossing the
  // breakpoint swaps trees (the hash route is shared, so the open session stays open).
  const desktop = useIsDesktop()
  return (
    <ThemeProvider>
      <SettingsProvider>
        <FleetProvider>
          <TooltipProvider>
            <Router hook={useHashLocation}>
              {desktop ? (
                <DesktopShell />
              ) : (
                <Switch>
                  <Route path="/">
                    <ListScreen />
                  </Route>
                  <Route path="/s/:host/:id">
                    {(p) => <SessionScreen key={`${p.host}/${p.id}`} host={p.host} id={p.id} />}
                  </Route>
                  <Route>
                    <Redirect to="/" replace />
                  </Route>
                </Switch>
              )}
            </Router>
            <Toaster position={desktop ? 'bottom-right' : 'top-center'} offset={desktop ? { bottom: 112, right: 16 } : undefined} />
          </TooltipProvider>
        </FleetProvider>
      </SettingsProvider>
    </ThemeProvider>
  )
}
