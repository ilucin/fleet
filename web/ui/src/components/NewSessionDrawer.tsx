import { useEffect, useRef, useState } from 'react'
import { CheckIcon, FolderIcon, GitForkIcon, LayersIcon, Loader2Icon, PaperclipIcon, PlayIcon } from 'lucide-react'
import { toast } from 'sonner'

import { api, ApiError } from '@/api/client'
import { watchForSpawned } from '@/api/spawnWatch'
import { DropOverlay } from '@/components/DropOverlay'
import { HostDot } from '@/components/HostBadge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useAttach, useFileDrop } from '@/hooks/useAttach'
import { useFleet } from '@/hooks/useFleet'
import { useSettings } from '@/hooks/useSettings'
import type { SiblingTarget } from '@/hooks/useStackUi'
import { copyText } from '@/lib/clipboard'
import { shortCwd } from '@/lib/format'
import { pickModel } from '@/lib/models'
import { storage } from '@/lib/storage'
import { sessionHref, spawnTargets } from '@/lib/sessions'
import { isMacPlatform, isSubmitChord } from '@/lib/shortcuts'
import { stackErrorMessage, stacksMissing } from '@/lib/stacks'
import { cn } from '@/lib/utils'

const HOST_KEY = 'fleet.spawnHost'
const dirKey = (host: string) => `fleet.spawnDirLabel.${host}`
const MODEL_KEY = 'fleet.spawnModel'
// The unsent first prompt of a plain New session (not a prefilled "continue"), so closing the form,
// a reload, a crash or a failed spawn never loses it; cleared once the started session registers. Stale after a week.
const DRAFT_KEY = 'fleet.spawnDraft'
const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function loadDraft(): string {
  const d = storage.getJSON<{ prompt?: unknown; at?: unknown }>(DRAFT_KEY)
  if (!d || typeof d.prompt !== 'string' || typeof d.at !== 'number' || Date.now() - d.at > DRAFT_MAX_AGE_MS) return ''
  return d.prompt
}

function saveDraft(prompt: string) {
  if (prompt.trim()) storage.setJSON(DRAFT_KEY, { prompt, at: Date.now() })
  else storage.remove(DRAFT_KEY)
}
/** A started session registered: drop the draft it came from (not a newer one typed since). */
function clearDraftIf(sent: string) {
  if (loadDraft() === sent) storage.remove(DRAFT_KEY)
}

/**
 * A spawn that never showed up: its prompt becomes the draft (a "continue" / sibling one too,
 * unless a newer draft exists) and the toast offers to copy it.
 */
function notShownUp(name: string, id: string | number, sent: string) {
  const kept = sent.trim() !== ''
  if (kept && !loadDraft().trim()) saveDraft(sent)
  toast.error(`${name} has not shown up yet`, {
    id,
    description: kept ? 'Check the list in a moment. Your prompt is kept in New session.' : 'Check the list in a moment',
    ...(kept ? { action: { label: 'Copy prompt', onClick: () => void copyText(sent) } } : {}),
  })
}

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
  /**
   * Spawn sibling: a new session in the source session's / stack's directory (read-only), in its
   * stack (created first when it has none) — POST …/stack/spawn. Host and directory are fixed.
   */
  sibling?: SiblingTarget | null
}

const samePath = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

/**
 * `+` in the list header: host, directory (that host's spawnDirs), model and an optional first
 * prompt → POST spawn, then watch the fleet for the new session and open it. No name field:
 * the server's auto-namer names it (tmux `fw-hhmmss` when auto-naming is off).
 */
export function NewSessionDrawer({ open, onOpenChange, onOpenSession, prefill, sibling }: NewSessionDrawerProps) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="px-safe" onOpenAutoFocus={prefill?.prompt ? (e) => e.preventDefault() : undefined}>
        {open ? <NewSessionForm onDone={() => onOpenChange(false)} onOpenSession={onOpenSession} prefill={prefill} sibling={sibling} /> : null}
      </DrawerContent>
    </Drawer>
  )
}

/** Desktop: the same form in a centred dialog (`c` / `n`, the sidebar's `+`, the palette). */
export function NewSessionDialog({ open, onOpenChange, onOpenSession, prefill, sibling }: NewSessionDrawerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-4rem)] overflow-hidden p-0 sm:max-w-lg"
        onOpenAutoFocus={prefill?.prompt ? (e) => e.preventDefault() : undefined}
      >
        {open ? (
          <NewSessionForm variant="dialog" onDone={() => onOpenChange(false)} onOpenSession={onOpenSession} prefill={prefill} sibling={sibling} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function NewSessionForm({
  onDone,
  onOpenSession,
  variant = 'drawer',
  prefill = null,
  sibling = null,
}: {
  onDone: () => void
  onOpenSession: (href: string) => void
  variant?: 'drawer' | 'dialog'
  prefill?: SpawnPrefill | null
  sibling?: SiblingTarget | null
}) {
  const dialog = variant === 'dialog'
  const Header = dialog ? DialogHeader : DrawerHeader
  const Title = dialog ? DialogTitle : DrawerTitle
  const Description = dialog ? DialogDescription : DrawerDescription
  const { fleet, applyFleet } = useFleet()
  const hosts = spawnTargets(fleet)

  const [host, setHost] = useState(() => {
    if (sibling) return sibling.host
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
  const [prompt, setPrompt] = useState(() => prefill?.prompt ?? (sibling ? '' : loadDraft()))
  // Keep the draft on every change (attachments typed in included); a prefill / sibling is never a draft.
  const draftable = !prefill && !sibling
  useEffect(() => {
    if (draftable) saveDraft(prompt)
  }, [draftable, prompt])
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

  // ⌘/Ctrl+Enter submits from any field (the prompt included; plain Enter there stays a newline).
  const canStart = !busy && (!!sibling || !!dir) && progress == null

  const startSibling = async (sib: SiblingTarget) => {
    setBusy(true)
    setError(null)
    try {
      const sent = prompt
      const body = { prompt: sent.trim() ? sent : undefined, model: model || undefined }
      const res = sib.sessionId ? await api.spawnSibling(sib.host, sib.sessionId, body) : await api.spawnInStack(sib.host, sib.stackId ?? '', body)
      onDone()
      const label = res.stack?.label || sib.label || 'the stack'
      if (res.created)
        toast.success(`Stack created: ${label}`, {
          description: res.generated ? 'StackBrief written from this session.' : 'StackBrief skeleton — the model call was skipped or failed.',
        })
      const spawnHost = res.spawn?.host || res.host || sib.host
      const name = res.spawn?.name || res.spawn?.tmuxSession || 'sibling'
      const id = toast.loading(`Starting ${name} in ${label}…`, { description: 'Waiting for Claude to register' })
      watchForSpawned(
        { host: spawnHost, name, tmuxSession: res.spawn?.tmuxSession ?? name },
        {
          onFleet: applyFleet,
          onFound: (s) => {
            toast.success(`${name} is up`, { id, description: undefined })
            onOpenSession(sessionHref(s))
          },
          onTimeout: () => notShownUp(name, id, sent),
        },
      )
    } catch (err) {
      setError(stacksMissing(err) ? stackErrorMessage(err) : (err as Error)?.message || 'Failed to start')
      setBusy(false)
    }
  }

  const start = async () => {
    if (busy || progress) return
    if (sibling) return startSibling(sibling)
    if (!host) return setError('No reachable host to start a session on.')
    if (!dir) return setError('This host advertises no directories.')
    setBusy(true)
    setError(null)
    try {
      const sent = prompt
      const res = await api.spawn(host, { dir: dir.path, prompt: sent.trim() ? sent : undefined, model: model || undefined })
      // The draft stays until the session registers: a spawn that never shows up must not lose the prompt.
      onDone()
      const id = toast.loading(`Starting ${res.name} on ${host}…`, { description: 'Waiting for Claude to register' })
      watchForSpawned(
        { host, name: res.name, tmuxSession: res.tmuxSession },
        {
          onFleet: applyFleet,
          onFound: (s) => {
            clearDraftIf(sent)
            toast.success(`${res.name} is up`, { id, description: undefined })
            onOpenSession(sessionHref(s))
          },
          onTimeout: () => notShownUp(res.name, id, sent),
        },
      )
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0
      const msg = (err as Error)?.message || 'Failed to start'
      setError(status === 409 ? `${msg} — try again.` : msg)
      setBusy(false)
    }
  }

  const modelField =
    models.length > 1 ? (
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
    ) : null
  const promptField = (
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
  )
  const errorBox =
    error ? (
      <Alert variant="destructive">
        <AlertDescription className="break-words whitespace-pre-line">{error}</AlertDescription>
      </Alert>
    ) : null
  const submitButton = (
    <Button type="submit" className="h-11 w-full rounded-xl text-[0.9375rem]" disabled={!canStart}>
      {busy ? <Loader2Icon className="animate-spin" /> : sibling ? <GitForkIcon /> : <PlayIcon />}
      {busy ? (sibling?.creates ? 'Creating stack…' : 'Starting…') : sibling ? 'Spawn sibling' : `Start on ${host}`}
      {dialog && !busy ? (
        <Kbd aria-hidden className="ml-1 bg-primary-foreground/15 text-primary-foreground/80">
          {isMacPlatform() ? '⌘↵' : 'Ctrl↵'}
        </Kbd>
      ) : null}
    </Button>
  )

  return (
    <form
      className={cn(
        'relative',
        dialog
          ? 'no-scrollbar max-h-[calc(100dvh-4rem)] w-full overflow-y-auto px-5 pt-2 pb-5'
          : 'no-scrollbar mx-auto min-h-0 w-full max-w-lg overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))]',
      )}
      {...drop.bind}
      onSubmit={(e) => {
        e.preventDefault()
        void start()
      }}
      onKeyDown={(e) => {
        if (!isSubmitChord(e.nativeEvent)) return
        e.preventDefault()
        if (canStart) void start()
      }}
    >
      <Header className="px-0 pt-3 pb-2 text-left">
        <Title className="text-left text-base font-semibold">{sibling ? 'Spawn sibling' : prefill ? 'Continue in new session' : 'New session'}</Title>
        <Description className="text-left text-xs">
          {sibling
            ? sibling.creates
              ? 'This starts a new stack around this session (one Sonnet call), then a sibling session in the same directory that reads the shared StackBrief first.'
              : `A new session in the stack ${sibling.label ? `“${sibling.label}”` : ''}, in the same directory. It reads the shared StackBrief first.`
            : 'Starts Claude in a new tmux session. A first-run folder trust prompt is accepted for you.'}
        </Description>
      </Header>

      {sibling ? (
        <div className="space-y-4 pt-1">
          <Field label={sibling.creates ? 'From' : 'Stack'}>
            <div className="flex min-h-12 items-center gap-3 rounded-xl border border-border bg-card px-3 py-2">
              {sibling.creates ? <GitForkIcon className="size-4 shrink-0 text-dimmer" /> : <LayersIcon className="size-4 shrink-0 text-primary" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{sibling.label || (sibling.creates ? 'this session' : 'Session stack')}</span>
                <span className="flex min-w-0 items-center gap-1.5 text-[0.6875rem] text-dimmer">
                  <HostDot host={sibling.host} />
                  <span className="shrink-0">{sibling.host}</span>
                  {sibling.cwd ? <span className="min-w-0 truncate font-mono">· {shortCwd(sibling.cwd, 60)}</span> : null}
                </span>
              </span>
            </div>
          </Field>
          {modelField}
          {promptField}
          {errorBox}
          {submitButton}
        </div>
      ) : hosts.length === 0 ? (
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
                        <span className="block truncate font-mono text-[0.6875rem] text-dimmer">{shortCwd(d.path, 60)}</span>
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

          {modelField}

          {promptField}

          {errorBox}

          {submitButton}
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
