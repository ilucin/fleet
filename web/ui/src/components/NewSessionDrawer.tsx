import { useState } from 'react'
import { CheckIcon, FolderIcon, Loader2Icon, PlayIcon } from 'lucide-react'
import { toast } from 'sonner'

import { api, ApiError } from '@/api/client'
import { watchForSpawned } from '@/api/spawnWatch'
import { HostDot } from '@/components/HostBadge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useFleet } from '@/hooks/useFleet'
import { shortCwd } from '@/lib/format'
import { storage } from '@/lib/storage'
import { sessionHref, spawnTargets } from '@/lib/sessions'
import { cn } from '@/lib/utils'

// Same keys as the classic UI's sheet.
const HOST_KEY = 'fleet.spawnHost'
const dirKey = (host: string) => `fleet.spawnDirLabel.${host}`

export interface NewSessionDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Open the new session once it registers (`#/s/…`). */
  onOpenSession: (href: string) => void
}

/**
 * `+` in the list header: host, directory (that host's spawnDirs), optional name and first
 * prompt → POST spawn, then watch the fleet for the new session and open it.
 */
export function NewSessionDrawer({ open, onOpenChange, onOpenSession }: NewSessionDrawerProps) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="px-safe">
        {open ? <NewSessionForm onDone={() => onOpenChange(false)} onOpenSession={onOpenSession} /> : null}
      </DrawerContent>
    </Drawer>
  )
}

/** Desktop: the same form in a centred dialog (`c` / `n`, the sidebar's `+`, the palette). */
export function NewSessionDialog({ open, onOpenChange, onOpenSession }: NewSessionDrawerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-4rem)] overflow-hidden p-0 sm:max-w-lg">
        {open ? <NewSessionForm variant="dialog" onDone={() => onOpenChange(false)} onOpenSession={onOpenSession} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function NewSessionForm({
  onDone,
  onOpenSession,
  variant = 'drawer',
}: {
  onDone: () => void
  onOpenSession: (href: string) => void
  variant?: 'drawer' | 'dialog'
}) {
  const dialog = variant === 'dialog'
  const Header = dialog ? DialogHeader : DrawerHeader
  const Title = dialog ? DialogTitle : DrawerTitle
  const Description = dialog ? DialogDescription : DrawerDescription
  const { fleet, applyFleet } = useFleet()
  const hosts = spawnTargets(fleet)

  const [host, setHost] = useState(() => {
    const remembered = storage.get(HOST_KEY)
    return hosts.find((h) => h.name === remembered)?.name ?? hosts[0]?.name ?? ''
  })
  const dirs = hosts.find((h) => h.name === host)?.dirs ?? []
  const [dirLabels, setDirLabels] = useState<Record<string, string | null>>({})
  const rememberedLabel = dirLabels[host] ?? storage.get(dirKey(host))
  const dir = dirs.find((d) => d.label === rememberedLabel) ?? dirs[0] ?? null

  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const pickHost = (h: string) => {
    setHost(h)
    storage.set(HOST_KEY, h)
    setError(null)
  }
  const pickDir = (label: string) => {
    setDirLabels((m) => ({ ...m, [host]: label }))
    storage.set(dirKey(host), label)
  }

  const start = async () => {
    if (busy) return
    if (!host) return setError('No reachable host to start a session on.')
    if (!dir) return setError('This host advertises no directories.')
    setBusy(true)
    setError(null)
    try {
      const res = await api.spawn(host, { name: name.trim() || undefined, dir: dir.path, prompt: prompt.trim() ? prompt : undefined })
      onDone()
      const id = toast.loading(`Starting ${res.name} on ${host}…`, { description: 'Waiting for Claude to register' })
      watchForSpawned(
        { host, name: res.name, tmuxSession: res.tmuxSession },
        {
          onFleet: applyFleet,
          onFound: (s) => {
            toast.success(`${res.name} is up`, { id, description: undefined })
            onOpenSession(sessionHref(s))
          },
          onTimeout: () =>
            toast.error(`${res.name} has not shown up yet`, { id, description: 'Check the list in a moment' }),
        },
      )
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0
      const msg = (err as Error)?.message || 'Failed to start'
      setError(status === 409 ? `${msg} — pick another name.` : msg)
      setBusy(false)
    }
  }

  return (
    <form
      className={
        dialog
          ? 'no-scrollbar max-h-[calc(100dvh-4rem)] w-full overflow-y-auto px-5 pt-2 pb-5'
          : 'no-scrollbar mx-auto w-full max-w-lg overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))]'
      }
      onSubmit={(e) => {
        e.preventDefault()
        void start()
      }}
    >
      <Header className="px-0 pt-3 pb-2 text-left">
        <Title className="text-left text-base font-semibold">New session</Title>
        <Description className="text-left text-xs">
          Starts Claude in a new tmux session. A first-run folder trust prompt is accepted for you.
        </Description>
      </Header>

      {hosts.length === 0 ? (
        <Alert variant="destructive" className="my-2">
          <AlertDescription>No reachable host to start a session on.</AlertDescription>
        </Alert>
      ) : (
        <div className="space-y-4 pt-1">
          {hosts.length > 1 ? (
            <Field label="Host">
              <ToggleGroup
                type="single"
                value={host}
                onValueChange={(v) => v && pickHost(v)}
                aria-label="Host"
                className="no-scrollbar w-full overflow-x-auto"
              >
                {hosts.map((h) => (
                  <ToggleGroupItem
                    key={h.name}
                    value={h.name}
                    className="h-10 gap-2 rounded-full border border-border bg-card px-4 text-sm data-[state=on]:border-primary/50 data-[state=on]:bg-accent"
                  >
                    <HostDot host={h.name} />
                    {h.name}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Field>
          ) : null}

          <Field label="Directory">
            {dirs.length ? (
              <div role="radiogroup" aria-label="Directory" className="grid gap-1.5">
                {dirs.map((d) => {
                  const on = d === dir
                  return (
                    <button
                      key={d.label}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => pickDir(d.label)}
                      className={cn(
                        'flex min-h-12 items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors',
                        on ? 'border-primary/50 bg-accent' : 'border-border bg-card active:bg-muted',
                      )}
                    >
                      <FolderIcon className={cn('size-4 shrink-0', on ? 'text-primary' : 'text-dimmer')} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{d.label}</span>
                        <span className="block truncate font-mono text-[11px] text-dimmer">{shortCwd(d.path, 60)}</span>
                      </span>
                      {on ? <CheckIcon className="size-4 shrink-0 text-primary" /> : null}
                    </button>
                  )
                })}
              </div>
            ) : (
              <p className="text-sm text-dimmer">{host} advertises no directories.</p>
            )}
          </Field>

          <Field label="Name" hint="optional · a-z 0-9 - _">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="auto"
              maxLength={40}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              className="h-11 rounded-xl bg-card text-base md:text-base"
            />
          </Field>

          <Field label="First prompt" hint="optional">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder="What should Claude work on?"
              className="max-h-48 min-h-20 rounded-xl bg-card text-base md:text-base"
            />
          </Field>

          {error ? (
            <Alert variant="destructive">
              <AlertDescription className="break-words">{error}</AlertDescription>
            </Alert>
          ) : null}

          <Button type="submit" className="h-11 w-full rounded-xl text-[15px]" disabled={busy || !dir}>
            {busy ? <Loader2Icon className="animate-spin" /> : <PlayIcon />}
            {busy ? 'Starting…' : `Start on ${host}`}
          </Button>
        </div>
      )}
    </form>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-baseline gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
        {hint ? <span className="font-normal tracking-normal text-dimmer normal-case">{hint}</span> : null}
      </Label>
      {children}
    </div>
  )
}
