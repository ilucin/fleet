import { useEffect, useState, type MouseEvent } from 'react'
import {
  CheckIcon,
  ChevronDownIcon,
  CodeXmlIcon,
  ExternalLinkIcon,
  EyeOffIcon,
  FileDiffIcon,
  GitBranchIcon,
  Loader2Icon,
  MessagesSquareIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { useLocation } from 'wouter'

import { api } from '@/api/client'
import type { PullRequest, Session } from '@/api/types'
import { watchForSpawned } from '@/api/spawnWatch'
import { HostDot } from '@/components/HostBadge'
import { PrSessionLink } from '@/components/PrChip'
import { PrMention } from '@/components/PrMention'
import { PrTaskChips } from '@/components/TaskChip'
import { usePrTasks } from '@/hooks/useTasks'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useFleet } from '@/hooks/useFleet'
import { usePersistentState } from '@/hooks/usePersistentState'
import { usePrs } from '@/hooks/usePrs'
import { copyText } from '@/lib/clipboard'
import { shortCwd } from '@/lib/format'
import { CHECKS_LABEL, checksTone, prRef, prStartHref, type PrStart } from '@/lib/prs'
import { prReviewHref, reviewHref } from '@/lib/review'
import { spawnTargets } from '@/lib/sessions'
import { hashRouteUrl, wantsNewWindow } from '@/lib/newWindow'
import { isMacPlatform, isSubmitChord } from '@/lib/shortcuts'

/** Starts already run (a remount in development must not run one twice). */
const started = new WeakSet<PrStart>()

type Busy = null | 'editor' | 'review' | 'session' | 'approve' | 'dismiss'

/**
 * One PR's actions: check it out in a worktree on a host you pick (remembered) and open it in
 * VS Code or in the Code Review module, or do that with a new session on it, whose chat sits
 * beside the diff; approve it (it leaves the board at once); open it on GitHub (when Fleet has
 * the focus again, just that PR is fetched, so an approval there takes it off the board too).
 * `host`: whose `gh` and checkouts the board comes from. Key it by the PR.
 */
export function PrDialog(props: PrDialogProps) {
  if (!props.pr || !props.host) return null
  return <PrDialogBody {...props} pr={props.pr} host={props.host} />
}

interface PrDialogProps {
  pr: PullRequest | null
  host: string | null
  /** Sessions already working in its worktree. */
  sessions?: Session[]
  onClose: () => void
  onChanged: () => void
  /** Run this action at once (this window was opened by a ⌘-click on it). */
  start?: PrStart | null
  onStarted?: () => void
}

function PrDialogBody({
  pr,
  host,
  sessions = [],
  onClose,
  onChanged,
  start = null,
  onStarted,
}: PrDialogProps & { pr: PullRequest; host: string }) {
  const [, navigate] = useLocation()
  const { fleet, applyFleet } = useFleet()
  const { approve, dismiss, watch, data } = usePrs()
  const [prompt, setPrompt] = useState('')
  const [showPrompt, setShowPrompt] = useState(false)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const tasks = usePrTasks(pr)
  const targets = spawnTargets(fleet).map((t) => t.name)
  const [picked, setPicked] = usePersistentState<string>('fleet.prActionHost', '')
  // Where the worktree and the session go: the window's start, the one you picked last, else the board's host.
  const on = start?.on ?? (picked && targets.includes(picked) ? picked : targets.includes(host) ? host : (targets[0] ?? host))
  const ref = prRef(pr)
  // The board knows its own host's checkouts only.
  const local = on === host ? pr.local : undefined
  const worktree = local?.worktree ?? null
  const editorUrl = worktree ? (local?.editorUrl ?? null) : null
  const noClone = on === host && !pr.local
  const tone = checksTone(pr.checks)
  const mine = pr.author.toLowerCase() === (data?.user ?? '').toLowerCase()
  const canApprove = !mine && (pr.myReview?.state !== 'approved' || !!pr.myReview?.newCommits)
  const blocked = noClone ? `No clone of ${pr.owner}/${pr.repo} on ${on}: pick another host, or clone it there` : null

  const fail = (err: unknown, what: string) => {
    setError((err as Error)?.message || what)
    setBusy(null)
  }

  /** The worktree on `on` (made when missing). */
  const checkout = async () => {
    const { worktree: wt } = await api.prCheckout(on, ref)
    if (wt.created) toast.success(`Checked out ${ref} on ${on}`, { description: shortCwd(wt.path) })
    return wt
  }

  const openEditor = async () => {
    if (busy) return
    if (editorUrl) return void window.location.assign(editorUrl)
    setBusy('editor')
    setError(null)
    try {
      const wt = await checkout()
      onChanged()
      setBusy(null)
      if (wt.editorUrl) window.location.assign(wt.editorUrl)
      else toast(`${ref} is in ${shortCwd(wt.path)}`, { description: 'No editor link for this host', action: { label: 'Copy path', onClick: () => void copyText(wt.path) } })
    } catch (err) {
      fail(err, 'Checkout failed')
    }
  }

  const openReview = async () => {
    if (busy) return
    setBusy('review')
    setError(null)
    try {
      if (!worktree) await checkout()
      onChanged()
      onClose()
      navigate(prReviewHref(on, pr))
    } catch (err) {
      fail(err, 'Checkout failed')
    }
  }

  const spawn = async (firstPrompt = prompt) => {
    if (busy) return
    setBusy('session')
    setError(null)
    try {
      const res = await api.prSpawn(on, { pr: ref, prompt: firstPrompt.trim() || undefined })
      const name = res.spawn?.name || res.spawn?.tmuxSession || ref
      onClose()
      onChanged()
      const id = toast.loading(`Starting ${name} on ${on}…`, { description: shortCwd(res.worktree.path) })
      watchForSpawned(
        { host: res.spawn?.host || on, name, tmuxSession: res.spawn?.tmuxSession ?? name },
        {
          onFleet: applyFleet,
          onFound: (s) => {
            toast.success(`${name} is up`, { id, description: undefined })
            navigate(reviewHref(s.host, s.session_id))
          },
          onTimeout: () => toast.error(`${name} has not shown up yet`, { id, description: 'Check the list in a moment' }),
        },
      )
    } catch (err) {
      fail(err, 'Failed to start')
    }
  }

  const doApprove = async () => {
    if (busy) return
    setBusy('approve')
    setError(null)
    try {
      await approve(pr)
      toast.success(`Approved ${ref}`)
      onClose()
    } catch (err) {
      fail(err, 'Approve failed')
    }
  }

  const doDismiss = async () => {
    if (busy) return
    setBusy('dismiss')
    setError(null)
    try {
      await dismiss(pr)
      toast(`Dismissed ${ref}`, {
        description: 'Back on the board when it gets new commits',
        action: { label: 'Undo', onClick: () => void dismiss(pr, true).catch((err) => toast.error((err as Error)?.message || 'Undo failed')) },
      })
      onClose()
    } catch (err) {
      fail(err, 'Dismiss failed')
    }
  }

  /** ⌘-click: a new Fleet window runs it (opened now, while the click may still open one). */
  const inNewWindow = (kind: PrStart['kind']) => window.open(hashRouteUrl(prStartHref(pr, { kind, on, prompt: kind === 'session' ? prompt : '' })), '_blank')
  const click = (kind: PrStart['kind'], here: () => void) => (e: MouseEvent) => {
    if (wantsNewWindow(e)) {
      e.preventDefault()
      inNewWindow(kind)
    } else here()
  }
  // The start this window was opened with: run once, on mount.
  useEffect(() => {
    if (!start || started.has(start)) return
    started.add(start)
    queueMicrotask(() => {
      onStarted?.()
      if (start.kind === 'review') void openReview()
      else void spawn(start.prompt)
    })
    // Mount only: a start runs once (`started`), its window's later renders leave it alone.
  }, []) // oxlint-disable-line react-hooks/exhaustive-deps

  const spin = (b: Busy) => busy === b

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogDescription className="flex items-center gap-1.5 font-mono text-xs">
            {pr.owner}/{pr.repo}#{pr.number}
            {pr.draft ? <span className="rounded border px-1 font-sans text-[0.625rem]">draft</span> : null}
          </DialogDescription>
          <DialogTitle className="text-base leading-snug">{pr.title}</DialogTitle>
        </DialogHeader>

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Branch</dt>
          <dd className="min-w-0 truncate font-mono text-xs leading-5" title={`${pr.headBranch} → ${pr.baseBranch}`}>
            <GitBranchIcon className="mr-1 inline size-3.5 align-[-2px]" />
            {pr.headBranch} <span className="text-muted-foreground">→ {pr.baseBranch}</span>
          </dd>
          <dt className="text-muted-foreground">By</dt>
          <dd>
            @{pr.author} · +{pr.additions} −{pr.deletions} in {pr.changedFiles} files
          </dd>
          {tasks.length ? (
            <>
              <dt className="text-muted-foreground">Tasks</dt>
              <dd className="flex flex-wrap items-center gap-1.5" onClickCapture={onClose}>
                <PrTaskChips pr={pr} />
                <span className="min-w-0 truncate text-xs text-muted-foreground">{tasks.map((t) => t.title).join(' · ')}</span>
              </dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Checks</dt>
          <dd>{CHECKS_LABEL[tone]}</dd>
          <dt className="text-muted-foreground">Worktree</dt>
          <dd className="flex min-w-0 items-center gap-1.5">
            {targets.length > 1 ? (
              <span className="relative inline-flex shrink-0 items-center">
                <HostDot host={on} />
                <select
                  aria-label="Host for the worktree and the session"
                  value={on}
                  onChange={(e) => {
                    setPicked(e.target.value)
                    setError(null)
                  }}
                  className="ml-1 appearance-none bg-transparent pr-4 text-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  {targets.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <ChevronDownIcon className="pointer-events-none absolute right-0 size-3 text-muted-foreground" />
              </span>
            ) : (
              <HostDot host={on} />
            )}
            {worktree ? (
              <button
                type="button"
                className="min-w-0 truncate text-left font-mono text-xs hover:underline"
                title="Copy path"
                onClick={() => void copyText(worktree)}
              >
                {shortCwd(worktree)}
              </button>
            ) : (
              <span className="min-w-0 truncate text-muted-foreground">
                {noClone ? `no clone of ${pr.repo}` : on === host ? 'not checked out yet' : 'checked out on first use'}
              </span>
            )}
          </dd>
        </dl>

        <PrMention pr={pr} className="rounded-lg border p-2.5" />

        {sessions.length ? (
          <div className="space-y-1">
            <Label>Sessions on it</Label>
            <div className="flex flex-col gap-0.5" onClickCapture={onClose}>
              {sessions.map((sess) => (
                <PrSessionLink key={`${sess.host}/${sess.session_id}`} session={sess} className="py-0.5 text-sm" />
              ))}
            </div>
          </div>
        ) : null}

        <div className="space-y-2">
          <Label>Open it {worktree ? 'from its worktree' : `in a worktree on ${on}`}</Label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {/* A desktop editor link makes no sense on a phone: hidden on touch-first screens. */}
            <Button variant="outline" className="pointer-coarse:hidden" onClick={() => void openEditor()} disabled={!!busy || !!blocked} title={blocked ?? 'Check it out (if needed) and open the worktree in VS Code'}>
              {spin('editor') ? <Loader2Icon className="animate-spin" /> : <CodeXmlIcon />} VS Code
            </Button>
            <Button
              variant="outline"
              onClick={click('review', () => void openReview())}
              onAuxClick={(e) => e.button === 1 && click('review', () => {})(e)}
              disabled={!!busy || !!blocked}
              title={blocked ?? `Check it out (if needed) and open the diff in Code Review, no session · ${isMacPlatform() ? '⌘' : 'Ctrl'}-click: in a new window`}
            >
              {spin('review') ? <Loader2Icon className="animate-spin" /> : <FileDiffIcon />} Code Review
            </Button>
            <Button
              onClick={click('session', () => void spawn())}
              onAuxClick={(e) => e.button === 1 && click('session', () => {})(e)}
              disabled={!!busy || !!blocked}
              title={blocked ?? `Check it out, start a session there and open Code Review with its chat beside the diff · ${isMacPlatform() ? '⌘' : 'Ctrl'}-click: in a new window`}
            >
              {spin('session') ? <Loader2Icon className="animate-spin" /> : <MessagesSquareIcon />} With a session
            </Button>
          </div>
          {blocked ? <p className="text-xs text-status-waiting">{blocked}</p> : null}
          {showPrompt ? (
            <Textarea
              autoFocus
              aria-label="First prompt for the session"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (isSubmitChord(e)) {
                  e.preventDefault()
                  if (!blocked) void spawn()
                }
              }}
              rows={3}
              placeholder="What should the session do? (optional; it is told the PR and the worktree)"
            />
          ) : (
            <button type="button" className="text-xs text-muted-foreground hover:text-foreground hover:underline" onClick={() => setShowPrompt(true)}>
              + First prompt for the session
            </button>
          )}
          {showPrompt ? (
            <p className="text-xs text-dimmer">
              <Kbd className="mr-1">{isMacPlatform() ? '⌘↵' : 'Ctrl↵'}</Kbd> starts it
            </p>
          ) : null}
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <Button asChild variant="ghost" size="sm" className="text-muted-foreground">
            <a href={pr.url} target="_blank" rel="noreferrer" onClick={() => watch(pr)} title="Approved or merged there? It leaves the board when you are back">
              <ExternalLinkIcon /> GitHub
            </a>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto text-muted-foreground"
            onClick={() => void doDismiss()}
            disabled={!!busy}
            title="Off the board in Fleet only, nothing on GitHub; back when it gets new commits"
          >
            {spin('dismiss') ? <Loader2Icon className="animate-spin" /> : <EyeOffIcon />} Dismiss
          </Button>
          {canApprove ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void doApprove()}
              disabled={!!busy}
              title={`Approve on GitHub as @${data?.user ?? 'you'}; it leaves the board`}
            >
              {spin('approve') ? <Loader2Icon className="animate-spin" /> : <CheckIcon />} Approve
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
