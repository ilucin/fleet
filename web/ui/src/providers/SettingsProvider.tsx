import { useEffect, useState, type ReactNode } from 'react'

import { api } from '@/api/client'
import { DEFAULT_SETTINGS, SettingsContext, type SettingsState } from '@/hooks/useSettings'

/** Loads /api/settings once; the app renders with defaults until (or if never) it answers. */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<SettingsState>(DEFAULT_SETTINGS)

  useEffect(() => {
    const controller = new AbortController()
    api
      .settings({ signal: controller.signal })
      .then((data) => {
        const quickReplies = Array.isArray(data?.quickReplies)
          ? data.quickReplies.filter((q) => q && typeof q.text === 'string' && q.text)
          : DEFAULT_SETTINGS.quickReplies
        setSettings({
          self: typeof data?.self === 'string' ? data.self : null,
          hosts: Array.isArray(data?.hosts) ? data.hosts : [],
          quickReplies,
          loaded: true,
        })
      })
      .catch(() => {
        if (!controller.signal.aborted) setSettings((s) => ({ ...s, loaded: true }))
      })
    return () => controller.abort()
  }, [])

  return <SettingsContext.Provider value={settings}>{children}</SettingsContext.Provider>
}
