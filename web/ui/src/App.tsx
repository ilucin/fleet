import { Redirect, Route, Router, Switch } from 'wouter'
import { useHashLocation } from 'wouter/use-hash-location'

import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FleetProvider } from '@/providers/FleetProvider'
import { SettingsProvider } from '@/providers/SettingsProvider'
import { ThemeProvider } from '@/providers/ThemeProvider'
import { ListScreen } from '@/screens/ListScreen'
import { SessionScreen } from '@/screens/SessionScreen'

/**
 * Hash routing, same URLs as the classic UI: `#/` (list), `#/s/<host>/<session_id>` (detail).
 * No server-side SPA fallback needed; the PWA start_url is `/#/`.
 */
export default function App() {
  return (
    <ThemeProvider>
      <SettingsProvider>
        <FleetProvider>
          <TooltipProvider>
            <Router hook={useHashLocation}>
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
            </Router>
            <Toaster position="top-center" />
          </TooltipProvider>
        </FleetProvider>
      </SettingsProvider>
    </ThemeProvider>
  )
}
