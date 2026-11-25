import { ChevronLeftIcon, ExternalLinkIcon, MessageSquareTextIcon } from 'lucide-react'
import { useMemo } from 'react'
import { useLocation } from 'wouter'

import type { BriefWorktree } from '@/api/types'
import { HostBadge } from '@/components/HostBadge'
import { Button } from '@/components/ui/button'
import { useBrief } from '@/hooks/useBrief'
import { useFleet } from '@/hooks/useFleet'
import { usePersistentState } from '@/hooks/usePersistentState'
import { useSessionTitle } from '@/hooks/useTitles'
import { codeHref, parseCodeLocation } from '@/lib/code'
import { findSession, sessionHref } from '@/lib/sessions'
import { cn } from '@/lib/utils'
import { SessionScreen } from '@/screens/SessionScreen'

const parseBool = (r: string) => (r === 'true' ? true : r === 'false' ? false : undefined)

/**
 * `#/code/:host/:id[/root/:root]`: VS Code (the host's `code serve-web`, through this server's
 * `/code/<host>/`) on one of the session's checkouts, with the session's chat beside it. Without
 * a root: the first linked worktree, else the brief's git root (the cwd's checkout).
 */
export function CodeScreen({ layout = 'screen' }: { layout?: 'screen' | 'pane' }) {
  const [location, navigate] = useLocation()
  const loc = parseCodeLocation(location)
  if (!loc) return null
  return <CodeView key={`${loc.host}/${loc.id}`} host={loc.host} id={loc.id} root={loc.root ?? null} layout={layout} onRoot={(r) => navigate(codeHref(loc.host, loc.id, r), { replace: true })} />
}

function CodeView({ host, id, root, layout, onRoot }: { host: string; id: string; root: string | null; layout: 'screen' | 'pane'; onRoot: (root: string) => void }) {
  const [, navigate] = useLocation()
  const { fleet } = useFleet()
  const session = findSession(fleet, host, id)
  const { title } = useSessionTitle(session, `${host}/${id}`)
  const { brief, error } = useBrief(host, id, true)
  const pane = layout === 'pane'
  const [showChat, setShowChat] = usePersistentState<boolean>('fleet.codeChat', true, parseBool)

  const worktrees: BriefWorktree[] = useMemo(() => brief?.worktrees ?? [], [brief])
  // Default: the first linked worktree (where the work usually is), else the cwd's checkout.
  const chosen = root ?? worktrees.find((w) => w.linked)?.path ?? brief?.gitRoot ?? worktrees[0]?.path ?? brief?.absCwd ?? null
  const current = worktrees.find((w) => w.path === chosen) ?? null
  const src = current?.codeUrl ?? (chosen && chosen === brief?.gitRoot ? brief?.codeUrl : null) ?? null
  const desktopUrl = current?.editorUrl ?? (chosen === brief?.gitRoot ? brief?.editorUrl : null) ?? null

  const back = () => navigate(session ? sessionHref(session) : `/s/${encodeURIComponent(host)}/${encodeURIComponent(id)}`)

  return (
    <div className="flex h-dvh min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header data-tauri-drag-region={pane ? 'deep' : undefined} className="z-20 shrink-0 border-b bg-background/90 pt-safe px-safe backdrop-blur-md">
        <div className={cn('flex w-full items-center gap-1.5 py-1.5 pr-2', pane ? 'titlebar titlebar-lead pl-2 [--titlebar-pad:0.5rem]' : 'pl-1')}>
          <Button variant="ghost" size="icon" aria-label="Back to session" title="Back to session (Esc, when focus is outside VS Code)" onClick={back} className="size-11 shrink-0 rounded-xl">
            <ChevronLeftIcon className="size-6" />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[0.9375rem] leading-tight font-bold">Code · {title}</div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-xs whitespace-nowrap text-muted-foreground">
              <HostBadge host={host} className="h-4 px-1 text-[0.625rem]" />
              <span className="truncate font-mono" title={chosen ?? undefined}>
                {current ? `${current.branch ?? 'detached'} · ${current.display}` : (chosen ?? '')}
              </span>
            </div>
          </div>
          {worktrees.length > 1 ? (
            <select
              aria-label="Checkout"
              title="Which checkout VS Code shows"
              value={chosen ?? ''}
              onChange={(e) => onRoot(e.target.value)}
              className="h-8 max-w-[22rem] shrink truncate rounded-lg border bg-background px-2 font-mono text-xs"
            >
              {worktrees.map((w) => (
                <option key={w.path} value={w.path}>
                  {w.branch ?? 'detached'} · {w.display}
                </option>
              ))}
            </select>
          ) : null}
          {desktopUrl ? (
            <Button asChild variant="outline" size="sm" className="shrink-0 pointer-coarse:hidden">
              <a href={desktopUrl} title="Open this checkout in the VS Code app">
                VS Code app
              </a>
            </Button>
          ) : null}
          {src ? (
            <Button asChild variant="ghost" size="icon" className="size-10 shrink-0 rounded-xl">
              <a href={src} target="_blank" rel="noreferrer" aria-label="Open in a new tab" title="Open in a new tab">
                <ExternalLinkIcon className="size-5" />
              </a>
            </Button>
          ) : null}
          <Button variant="ghost" size="icon" aria-label="Session" title="Session" aria-pressed={showChat} onClick={() => setShowChat(!showChat)} className={cn('size-10 shrink-0 rounded-xl', showChat && 'bg-muted text-foreground')}>
            <MessageSquareTextIcon className="size-5" />
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1">
          {src ? (
            <iframe key={src} src={src} title={`VS Code · ${chosen}`} className="h-full w-full border-0 bg-background" allow="clipboard-read; clipboard-write" />
          ) : (
            <div className="m-auto max-w-md p-6 text-center text-sm text-muted-foreground">
              {error ? error : !brief ? 'Loading…' : 'This session works in no checkout this server can open in VS Code (web.code is off, or the session is outside git).'}
            </div>
          )}
        </div>
        {showChat ? (
          <aside aria-label="Session" className="flex w-[28rem] shrink-0 border-l xl:w-[32rem]">
            <SessionScreen key={`${host}/${id}`} host={host} id={id} layout="pane" embedded />
          </aside>
        ) : null}
      </div>
    </div>
  )
}
