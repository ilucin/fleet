import { useEffect, useRef, useState } from 'react'
import { CheckIcon, FolderIcon, Loader2Icon, PaperclipIcon, PlayIcon } from 'lucide-react'
import { toast } from 'sonner'

import { api, ApiError } from '@/api/client'
import { watchForSpawned } from '@/api/spawnWatch'
import { DropOverlay } from '@/components/DropOverlay'
import { HostDot } from '@/components/HostBadge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useAttach, useFileDrop } from '@/hooks/useAttach'
import { useFleet } from '@/hooks/useFleet'
import { useSettings } from '@/hooks/useSettings'
import { shortCwd } from '@/lib/format'
import { pickModel } from '@/lib/models'
import { storage } from '@/lib/storage'
import { sessionHref, spawnTargets } from '@/lib/sessions'
import { cn } from '@/lib/utils'

// Same keys as the classic UI's sheet.
const HOST_KEY = 'fleet.spawnHost'
const dirKey = (host: string) => `fleet.spawnDirLabel.${host}`
const MODEL_KEY = 'fleet.spawnModel'
// Radix ToggleGroup treats '' as "nothing selected": the default model ('' = no --model) needs a stand-in.
const DEFAULT_MODEL_VALUE = '__default'

// The extra directory row a prefill adds when its dir is not one of the host's spawnDirs.
const PREFILL_DIR_LABEL = 'Same as the session'

/** "Continue in new session": start on this host, in this directory, with this first prompt. Nothing is remembered. */
export interface SpawnPrefill {
  host: string
  /** Absolute on `host` (a session's cwd); must be one of its spawnDirs or beneath one, else the spawn is a 400. */
  dir?: string | null
  prompt?: string
}

export interface NewSessionDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Open the new session once it registers (`#/s/…`). */
  onOpenSession: (href: string) => void
  /** Start from these values (the caret goes to the end of the prompt). */
  prefill?: SpawnPrefill | null
}

const samePath = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

/**
 * `+` in the list header: host, directory (that host's spawnDirs), model and an optional first
 * prompt → POST spawn, then watch the fleet for the new session and open it. No name field:
 * the server's auto-namer names it (tmux `fw-hhmmss` when auto-naming is off).
 */
export function NewSessionDrawer({ open, onOpenChange, onOpenSession, prefill }: NewSessionDrawerProps) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="px-safe" onOpenAutoFocus={prefill?.prompt ? (e) => e.preventDefault() : undefined}>
        {open ? <NewSessionForm onDone={() => onOpenChange(false)} onOpenSession={onOpenSession} prefill={prefill} /> : null}
      </DrawerContent>
    </Drawer>
  )
}

/** Desktop: the same form in a centred dialog (`c` / `n`, the sidebar's `+`, the palette). */
export function NewSessionDialog({ open, onOpenChange, onOpenSession, prefill }: NewSessionDrawerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-4rem)] overflow-hidden p-0 sm:max-w-lg"
        onOpenAutoFocus={prefill?.prompt ? (e) => e.preventDefault() : undefined}
      >
        {open ? <NewSessionForm variant="dialog" onDone={() => onOpenChange(false)} onOpenSession={onOpenSession} prefill={prefill} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function NewSessionForm({
  onDone,
  onOpenSession,
  variant = 'drawer',
  prefill = null,
}: {
  onDone: () => void
  onOpenSession: (href: string) => void
  variant?: 'drawer' | 'dialog'
  prefill?: SpawnPrefill | null
}) {
  const dialog = variant === 'dialog'
  const Header = dialog ? DialogHeader : DrawerHeader
  const Title = dialog ? DialogTitle : DrawerTitle
  const Description = dialog ? DialogDescription : DrawerDescription
  const { fleet, applyFleet } = useFleet()
  const hosts = spawnTargets(fleet)

  const [host, setHost] = useState(() => {
    if (prefill && hosts.some((h) => h.name === prefill.host)) return prefill.host
    const remembered = storage.get(HOST_KEY)
    return hosts.find((h) => h.name === remembered)?.name ?? hosts[0]?.name ?? ''
  })
  const hostDirs = hosts.find((h) => h.name === host)?.dirs ?? []
  // A prefilled dir (the session's cwd) is offered first when it is not one of the spawnDirs, and preselected.
  const prefillDir = prefill?.dir && host === prefill.host ? prefill.dir : null
  const dirs =
    prefillDir && !hostDirs.some((d) => samePath(d.path, prefillDir)) ? [{ label: PREFILL_DIR_LABEL, path: prefillDir }, ...hostDirs] : hostDirs
  const [dirLabels, setDirLabels] = useState<Record<string, string | null>>({})
  const rememberedLabel =
    dirLabels[host] ?? (prefillDir ? dirs.find((d) => samePath(d.path, prefillDir))?.label : null) ?? storage.get(dirKey(host))
  const dir = dirs.find((d) => d.label === rememberedLabel) ?? dirs[0] ?? null

  const { models } = useSettings()
  const [modelChoice, setModelChoice] = useState<string | null>(() => storage.get(MODEL_KEY))
  const model = pickModel(models, modelChoice)
  const [prompt, setPrompt] = useState(() => prefill?.prompt ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Files dropped on the form / pasted / picked: uploaded to the chosen host, paths go into the prompt.
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const { attach, onPaste, progress } = useAttach({ host, textarea: promptRef, setValue: setPrompt })
  const drop = useFileDrop((files) => void attach(files), !busy)

  // Prefilled: the caret goes after the prompt, where the user types what comes next.
  const prefilled = !!prefill?.prompt
  useEffect(() => {
    const el = promptRef.current
    if (!prefilled || !el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    el.scrollTop = el.scrollHeight
  }, [prefilled])

  const pickHost = (h: string) => {
    setHost(h)
    storage.set(HOST_KEY, h)
    setError(null)
  }
  const chooseModel = (id: string) => {
    setModelChoice(id)
    storage.set(MODEL_KEY, id)
  }
  const pickDir = (label: string) => {
    setDirLabels((m) => ({ ...m, [host]: label }))
    if (label !== PREFILL_DIR_LABEL) storage.set(dirKey(host), label)
  }

  const start = async () => {
    if (busy || progress) return
    if (!host) return setError('No reachable host to start a session on.')
    if (!dir) return setError('This host advertises no directories.')
    setBusy(true)
    setError(null)
    try {
      const res = await api.spawn(host, { dir: dir.path, prompt: prompt.trim() ? prompt : undefined, model: model || undefined })
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
      setError(status === 409 ? `${msg} — try again.` : msg)
      setBusy(false)
    }
  }

  return (
    <form
      className={cn(
        'relative',
        dialog
          ? 'no-scrollbar max-h-[calc(100dvh-4rem)] w-full overflow-y-auto px-5 pt-2 pb-5'
          : 'no-scrollbar mx-auto w-full max-w-lg overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))]',
      )}
      {...drop.bind}
      onSubmit={(e) => {
        e.preventDefault()
        void start()
      }}
    >
      <Header className="px-0 pt-3 pb-2 text-left">
        <Title className="text-left text-base font-semibold">{prefill ? 'Continue in new session' : 'New session'}</Title>
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
              <div role="radiogroup" aria-label="Directory" className="grid grid-cols-1 gap-1.5">
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

          {models.length > 1 ? (
            <Field label="Model">
              <ToggleGroup
                type="single"
                value={model || DEFAULT_MODEL_VALUE}
                onValueChange={(v) => v && chooseModel(v === DEFAULT_MODEL_VALUE ? '' : v)}
                aria-label="Model"
                className="no-scrollbar w-full justify-start overflow-x-auto"
              >
                {models.map((m) => (
                  <ToggleGroupItem
                    key={m.id || DEFAULT_MODEL_VALUE}
                    value={m.id || DEFAULT_MODEL_VALUE}
                    title={m.id || "Claude's default model"}
                    className="h-10 shrink-0 rounded-full border border-border bg-card px-4 text-sm data-[state=on]:border-primary/50 data-[state=on]:bg-accent"
                  >
                    {m.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Field>
          ) : null}

          <Field label="First prompt" hint="optional">
            <Textarea
              ref={promptRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onPaste={onPaste}
              rows={3}
              placeholder="What should Claude work on?"
              className="max-h-48 min-h-20 rounded-xl bg-card text-base md:text-base"
            />
            <div className="flex min-w-0 items-center gap-2">
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                tabIndex={-1}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? [])
                  e.target.value = ''
                  void attach(files)
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!host || progress != null}
                onClick={() => picker.current?.click()}
                className="-ml-2 h-9 shrink-0 rounded-lg px-2 text-muted-foreground"
              >
                {progress ? <Loader2Icon className="animate-spin" /> : <PaperclipIcon />}
                Attach files
              </Button>
              <span className="min-w-0 truncate text-xs text-dimmer" role="status">
                {progress
                  ? `Uploading ${progress.name}${progress.total > 1 ? ` (${progress.index}/${progress.total})` : ''}…`
                  : dialog
                    ? `or drop / paste them — stored on ${host}`
                    : `stored on ${host}`}
              </span>
            </div>
          </Field>

          {error ? (
            <Alert variant="destructive">
              <AlertDescription className="break-words">{error}</AlertDescription>
            </Alert>
          ) : null}

          <Button type="submit" className="h-11 w-full rounded-xl text-[15px]" disabled={busy || !dir || progress != null}>
            {busy ? <Loader2Icon className="animate-spin" /> : <PlayIcon />}
            {busy ? 'Starting…' : `Start on ${host}`}
          </Button>
        </div>
      )}
      <DropOverlay show={drop.dragging} hint={host ? `Uploaded to ${host}; the path goes into the first prompt` : undefined} />
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
