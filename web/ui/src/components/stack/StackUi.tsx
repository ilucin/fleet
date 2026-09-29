import { useLocation } from 'wouter'

import { NewSessionDialog, NewSessionDrawer } from '@/components/NewSessionDrawer'
import { StackSheet } from '@/components/stack/StackSheet'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import { closeSiblingSpawn, closeStackSheet, useStackUi } from '@/hooks/useStackUi'

/** The app-wide Stack sheet and Spawn sibling form (opened through hooks/useStackUi.ts). Mount once, inside the router. */
export function StackUi() {
  const { sheet, sibling } = useStackUi()
  const desktop = useIsDesktop()
  const [, navigate] = useLocation()
  const NewSession = desktop ? NewSessionDialog : NewSessionDrawer
  return (
    <>
      <StackSheet target={sheet} onClose={closeStackSheet} onNavigate={navigate} desktop={desktop} />
      <NewSession open={sibling != null} onOpenChange={(o) => !o && closeSiblingSpawn()} onOpenSession={(href) => navigate(href)} sibling={sibling} />
    </>
  )
}
